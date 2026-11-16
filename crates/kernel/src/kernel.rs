//! The kernel: one workspace, its plugins, and the protocol methods of week 1
//! (`docs/handoff/week1-protocol.md` §3). Requests arrive as `(client, method, params)`;
//! everything that writes goes through the pipeline; events go out on a broadcast channel.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use onedesk_protocol::*;
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::manifest::{Plugin, Registry};
use crate::pipeline::{Actor, Changes, Command, MoveDest, NewResource, Outcome, Pipeline};
use crate::sandbox::{CallInfo, Declarations, Package, Sandbox, SandboxConfig, SandboxError};
use crate::store::{self, Row, KIND_GROUP, TREE_PLUGIN_STATE, TREE_RESOURCES};
use crate::util::*;
use crate::workspace::Workspace;

pub const BATCH: u32 = 200;
pub const DEFAULT_CLIENT: &str = "default";
pub const DEFAULT_GROUP_NAME: &str = "New group";
pub use crate::pipeline::GRANTS_KEY;

#[derive(Debug, Clone)]
pub struct KernelConfig {
    pub sandbox: SandboxConfig,
    /// Total time of one action invocation (D288: 60 s).
    pub action_timeout: std::time::Duration,
    /// Where secret values live (D305): the keychain, or memory in tests.
    pub secrets: crate::secrets::SecretStoreHandle,
    /// D313: `<id>@<version>` of the built-in packages (given by the main process); only these
    /// are confirmed without asking.
    pub builtin: Vec<String>,
}

impl Default for KernelConfig {
    fn default() -> Self {
        KernelConfig {
            sandbox: SandboxConfig::default(),
            action_timeout: std::time::Duration::from_secs(60),
            secrets: crate::secrets::SecretStoreHandle::from_env(),
            builtin: vec![],
        }
    }
}

pub struct Kernel {
    pub(crate) inner: Arc<Inner>,
}

type Slot = Arc<tokio::sync::Mutex<Option<Arc<Sandbox>>>>;

pub(crate) struct Inner {
    pub ws: Workspace,
    reader: Mutex<Connection>,
    pub pipeline: Pipeline,
    pub registry: Registry,
    pub events: broadcast::Sender<EventMessage>,
    pub cfg: KernelConfig,
    slots: Mutex<HashMap<String, Slot>>,
    pub activations: AtomicU64,
    pub me: Weak<Inner>,
    pub runs_active: crate::runs::ActiveRuns,
    pub secret_cache: Mutex<HashMap<String, String>>,
    pub rules: crate::pipeline::SharedRules,
    /// Round 6: external programs running for this kernel.
    pub procs: Arc<crate::process::Procs>,
    /// Round 6: one ordered delivery queue per plugin (D335).
    pub event_queues: Mutex<HashMap<String, Arc<crate::events::Queue>>>,
    /// Round 7: unanswered install requests of plugins (D345).
    pub(crate) install_requests: crate::install::Requests,
}

pub(crate) fn parse<T: DeserializeOwned>(v: Value) -> KResult<T> {
    let v = if v.is_null() { json!({}) } else { v };
    serde_json::from_value(v).map_err(|e| invalid_params(e.to_string()))
}

fn to_value<T: serde::Serialize>(v: T) -> KResult<Value> {
    serde_json::to_value(v).map_err(internal)
}

pub(crate) fn kernel_cmd(id: &str, icon: &str) -> MenuCommand {
    MenuCommand {
        id: id.into(),
        label: Label::Text(id.into()),
        icon: Some(icon.into()),
        danger: None,
        disabled: None,
        shortcut: None,
        separator_before: None,
    }
}

/// What the kernel knows about a kind without running any plugin code.
pub(crate) struct KindMeta {
    pub label: Label,
    pub icon: String,
    /// (plugin id, page short name)
    pub page: Option<(String, String)>,
    pub draggable: bool,
    pub accepts: Vec<String>,
    pub commands: Vec<MenuCommand>,
    pub state: NodeState,
    /// Why the state is not `ok` (e.g. `<plugin>@<version>` of a missing version).
    pub reason: Option<Label>,
    /// The plugin version that handles resources of this kind (bound version, §7.6).
    pub plugin: Option<&'static Plugin>,
}

impl Kernel {
    /// Opens (or creates) the workspace in `workspace_dir` and reads the plugins under `plugins_dir`.
    /// The caller holds the workspace lock.
    pub fn open(workspace_dir: &Path, plugins_dir: &Path, cfg: KernelConfig) -> Result<Kernel, String> {
        let (ws, conn) = Workspace::open(workspace_dir)?;
        // D340: programs a previous worker left running (it was killed) end now.
        let ended = crate::process::cleanup_recorded(&ws.dir);
        if ended > 0 {
            eprintln!("onedesk: ended {ended} program group(s) left by a previous worker");
        }
        let ws_dir = ws.dir.clone();
        let reader = ws.open_reader()?;
        let registry = Registry::scan(plugins_dir);
        for r in &registry.rejected() {
            eprintln!("onedesk: plugin package {} not loaded: {} ({})", r.path.display(), r.reason, r.detail);
        }
        let rules: crate::pipeline::SharedRules = Arc::new(std::sync::RwLock::new(registry.rules()));
        let pipeline = Pipeline::start(conn, rules.clone());
        let (events, _) = broadcast::channel(1024);
        let inner = Arc::new_cyclic(|me| Inner {
            ws,
            reader: Mutex::new(reader),
            pipeline,
            registry,
            events,
            cfg,
            slots: Mutex::new(HashMap::new()),
            activations: AtomicU64::new(0),
            me: me.clone(),
            runs_active: Default::default(),
            secret_cache: Default::default(),
            rules,
            procs: Arc::new(crate::process::Procs::new(&ws_dir)),
            event_queues: Default::default(),
            install_requests: Default::default(),
        });
        // D299 first sight, then each plugin's active version.
        inner.first_sight_blocking();
        inner.refresh_active();
        // A newer confirmed version that arrived while the worker was off takes over now (D303).
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let me = inner.clone();
            rt.spawn(async move {
                for id in me.registry.ids() {
                    if let Err(e) = me.auto_switch(&id).await {
                        eprintln!("onedesk: automatic switch of {id} failed: {e:?}");
                    }
                }
            });
        }
        Ok(Kernel { inner })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventMessage> {
        self.inner.events.subscribe()
    }

    /// Handles one request. `hello` gating per connection is the transport's job.
    pub async fn request(&self, client: Option<String>, method: &str, params: Value) -> KResult<Value> {
        self.inner.handle(client, method, params).await
    }

    /// Finishes queued writes and stops the writer thread; drops every plugin runtime.
    pub fn shutdown(&self) {
        // No orphans (D333): programs still running end with the worker.
        self.inner.procs.kill_all();
        for (_, q) in self.inner.event_queues.lock().unwrap().drain() {
            q.close();
        }
        self.inner.slots.lock().unwrap().clear();
        self.inner.pipeline.shutdown();
    }

    pub fn workspace_info(&self) -> WorkspaceInfo {
        WorkspaceInfo { id: self.inner.ws.id.clone(), name: self.inner.ws.name.clone() }
    }

    /// Plugins whose runtime is currently alive (tests use this to check lazy activation).
    pub fn active_plugins(&self) -> Vec<String> {
        let slots: Vec<(String, Slot)> =
            self.inner.slots.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let out: Vec<String> =
            slots.into_iter().filter(|(_, s)| s.try_lock().map(|g| g.is_some()).unwrap_or(true)).map(|(k, _)| k).collect();
        // Slots are per version (`id@version`); callers ask about plugins.
        let mut out: Vec<String> = out.into_iter().map(|k| k.split('@').next().unwrap_or_default().to_string()).collect();
        out.sort();
        out.dedup();
        out
    }

    /// How many times any plugin runtime was created.
    pub fn activation_count(&self) -> u64 {
        self.inner.activations.load(Ordering::SeqCst)
    }

    pub fn rejected_plugins(&self) -> Vec<crate::manifest::Rejection> {
        self.inner.registry.rejected().clone()
    }

    /// External programs still running (tests).
    pub fn live_programs(&self) -> usize {
        self.inner.procs.live_count()
    }

    /// Test hook: how long an install request waits for an answer (default 5 minutes).
    pub fn set_install_request_ttl(&self, ttl: std::time::Duration) {
        *self.inner.install_requests.ttl.lock().unwrap() = Some(ttl);
    }

    /// Test hook: how long a plugin waits after an unsuccessful install request (default 30 s).
    pub fn set_install_request_cooldown(&self, d: std::time::Duration) {
        *self.inner.install_requests.cooldown.lock().unwrap() = Some(d);
    }

    pub fn db_path(&self) -> PathBuf {
        self.inner.ws.dir.join(crate::workspace::DB_FILE)
    }
}

impl Inner {
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> KResult<T> {
        let conn = self.reader.lock().unwrap();
        f(&conn).map_err(internal)
    }

    pub fn emit(&self, topic: impl Into<String>, payload: Option<Value>, client: Option<String>) {
        let _ = self.events.send(EventMessage { topic: topic.into(), payload, client });
    }

    /// Runs a command through the pipeline and publishes its events after commit.
    pub async fn execute(&self, actor: Actor, cmd: Command) -> KResult<Outcome> {
        self.execute_quiet(actor, cmd, None).await
    }

    /// `execute`; `quiet`: a plugin whose event handler made this write gets no
    /// `resource.changed` for it (D336).
    pub async fn execute_quiet(&self, actor: Actor, cmd: Command, quiet: Option<&str>) -> KResult<Outcome> {
        // Round 6 (D335): what the command does to the resources it touches.
        let change: Option<&'static str> = match &cmd {
            Command::Create(_) | Command::Import(_) => Some("created"),
            Command::Update { .. }
            | Command::Params { .. }
            | Command::Move { .. }
            | Command::Restore { .. }
            | Command::Upgrade { .. }
            | Command::UndoUpgrade { .. } => Some("updated"),
            Command::Delete { .. } => Some("deleted"),
            Command::Undelete { .. } => Some("restored"),
            Command::Purge { .. } => Some("purged"),
            _ => None,
        };
        let plugin_state = matches!(&cmd, Command::Update { .. } | Command::Create(_) | Command::Grant { .. });
        let deletion = matches!(&cmd, Command::Delete { .. } | Command::Undelete { .. } | Command::Purge { .. });
        let audited = !matches!(&cmd, Command::Meta { .. } | Command::UiSet { .. });
        // D307: hosts a resource grants before the change, to audit newly granted ones after it.
        // Review #10: every path that can bring an address back (restore, undelete, upgrade, undo)
        // is audited like a save. Rows not listed here count as granting nothing before.
        let ids: Option<Vec<String>> = match &cmd {
            Command::Update { id, .. } | Command::Params { id, .. } | Command::Restore { id, .. } => Some(vec![id.clone()]),
            Command::Upgrade { items, .. } => Some(items.iter().map(|i| i.id.clone()).collect()),
            Command::UndoUpgrade { batch, .. } => Some(
                self.read(|c| {
                    let mut st = c.prepare("SELECT resource_id FROM upgrade_items WHERE batch = ?1")?;
                    let v = st.query_map([batch], |r| r.get(0))?;
                    v.collect()
                })
                .unwrap_or_default(),
            ),
            Command::Create(_) | Command::Undelete { .. } => Some(vec![]),
            Command::Import(plan) => Some(plan.items.iter().filter(|i| i.update).map(|i| i.id.clone()).collect()),
            _ => None,
        };
        let granted_before: Option<HashMap<String, BTreeSet<String>>> = ids.map(|ids| {
            ids.into_iter()
                .filter_map(|id| self.read(|c| store::get(c, &id)).ok().flatten())
                .map(|r| (r.id.clone(), self.grant_hosts_of(&r.kind, r.plugin_version.as_deref(), &r.body)))
                .collect()
        });
        let grant_actor = actor.clone();
        let out = self.pipeline.execute(actor, cmd).await?;
        for t in out.topics() {
            if t == format!("{}{TREE_PLUGIN_STATE}", topic::TREE) {
                continue;
            }
            self.emit(t, None, None);
        }
        if plugin_state && out.rows.iter().any(|r| r.kind == store::KIND_PLUGIN_STATE) {
            self.emit(topic::PLUGINS, None, None);
        }
        if out.rows.iter().any(|r| r.kind == store::KIND_CONFIG) {
            self.emit(onedesk_protocol::topic2::CONFIG, None, None);
        }
        if deletion {
            self.emit(format!("{}{}", topic::TREE, store::TREE_DELETED), None, None);
            self.emit(format!("{}{}", topic::TREE, store::TREE_FAVORITES), None, None);
        }
        if let Some(before) = granted_before {
            let none = BTreeSet::new();
            for r in out.rows.iter().filter(|r| r.deleted_at.is_none()) {
                let had = before.get(&r.id).unwrap_or(&none);
                for host in self.grant_hosts_of(&r.kind, r.plugin_version.as_deref(), &r.body).difference(had) {
                    // A permission change (I.10h): the host is now reachable for the plugin.
                    let summary = json!({ "resource": r.id, "kind": r.kind });
                    let _ = self
                        .pipeline
                        .execute(grant_actor.clone(), Command::Audit { op: "network.grant".into(), object: host.clone(), summary })
                        .await;
                }
            }
        }
        if out.changed && audited {
            self.emit(onedesk_protocol::topic2::AUDIT, None, None);
        }
        if let (Some(change), true) = (change, out.changed) {
            for r in &out.rows {
                let Some((pid, _)) = Registry::split(&r.kind) else { continue };
                if quiet == Some(pid) || self.registry.kind(&r.kind).is_none() {
                    continue;
                }
                // A created row is new (rev 1); other rows a creation touched were updated.
                let c = if change == "created" && r.rev > 1 { "updated" } else { change };
                self.deliver(pid, crate::events::RESOURCE_CHANGED, json!({ "id": r.id, "kind": r.kind, "change": c }));
            }
        }
        Ok(out)
    }

    pub async fn handle(&self, client: Option<String>, m: &str, params: Value) -> KResult<Value> {
        use onedesk_protocol::method as M;
        match m {
            M::HELLO => {
                let p: HelloParams = parse(params)?;
                if p.protocol != PROTOCOL_VERSION {
                    return Err(err_p(ErrorCode::VersionMismatch, &[("expected", PROTOCOL_VERSION), ("got", &p.protocol)]));
                }
                to_value(HelloResult { protocol: PROTOCOL_VERSION.into(), workspace: self.info() })
            }
            M::WORKSPACE_INFO => to_value(self.info()),
            M::TREE_LIST => to_value(self.tree_list()),
            M::TREE_CHILDREN => to_value(self.tree_children(parse(params)?, client).await?),
            M::TREE_PATH => to_value(self.tree_path(parse(params)?, client).await?),
            M::TREE_MOVE => {
                self.tree_move(parse(params)?).await?;
                Ok(Value::Null)
            }
            M::TREE_CREATE_GROUP => {
                let p: TreeCreateGroupParams = parse(params)?;
                let id = self.create_group(&p.tree, p.parent, &p.name).await?;
                let row = self.live_row(&id)?;
                to_value(self.node_for(&row)?)
            }
            M::TREE_RENAME => {
                let p: TreeRenameParams = parse(params)?;
                self.stored_tree(&p.tree)?;
                let row = self.row_in_tree(&p.tree, &p.key)?;
                self.kind_writable(&row.kind)?;
                if p.name.trim().is_empty() {
                    return Err(invalid("emptyName"));
                }
                let changes = Changes { name: Some(p.name), ..Default::default() };
                self.execute(Actor::User, Command::Update { id: row.id, changes, basis: None }).await?;
                Ok(Value::Null)
            }
            M::RESOURCE_GET => {
                let p: ResourceIdParams = parse(params)?;
                match self.read(|c| store::get(c, &p.id))? {
                    Some(r) if !self.hidden_tree(&r) => to_value(self.resource(&r)?),
                    _ => Ok(Value::Null),
                }
            }
            M::RESOURCE_DELETE => {
                let p: ResourceIdParams = parse(params)?;
                let row = self.live_row(&p.id)?;
                if self.hidden_tree(&row) {
                    return Err(not_found("resource"));
                }
                self.execute(Actor::User, Command::Delete { id: row.id }).await?;
                Ok(Value::Null)
            }
            M::PAGE_RESOLVE => {
                let p: PageResolveParams = parse(params)?;
                to_value(self.resolve(&p.target, p.context.unwrap_or_default(), client).await?)
            }
            M::PAGE_SAVE => to_value(self.save(parse(params)?, client).await?),
            M::COMMAND_NEW_ITEMS => to_value(self.new_items(None)),
            M::COMMAND_EXECUTE => to_value(self.command(parse(params)?, client).await?),
            M::PLUGIN_GRANTS => {
                let p: PluginParams = parse(params)?;
                to_value(self.grants_of(&p.plugin)?)
            }
            M::PLUGIN_GRANT_FOLDER => to_value(self.grant_folder(parse(params)?).await?),
            M::PLUGIN_REVOKE_FOLDER => to_value(self.revoke_folder(parse(params)?).await?),
            M::UI_GET => {
                let p: UiGetParams = parse(params)?;
                let c = client.unwrap_or_else(|| DEFAULT_CLIENT.into());
                Ok(self.read(|conn| store::ui_get(conn, &c, &p.key))?.unwrap_or(Value::Null))
            }
            M::UI_SET => {
                let p: UiSetParams = parse(params)?;
                let c = client.unwrap_or_else(|| DEFAULT_CLIENT.into());
                self.pipeline.execute(Actor::User, Command::UiSet { client: c, key: p.key, value: p.value }).await?;
                Ok(Value::Null)
            }
            _ => {
                if crate::install::METHODS.contains(&m) {
                    return self.handle7(m, params).await;
                }
                if crate::transfer::METHODS.contains(&m) {
                    return self.handle5(m, params).await.unwrap_or_else(|| Err(err_p(ErrorCode::UnknownMethod, &[("method", m)])));
                }
                if crate::versions::METHODS.contains(&m) {
                    return self.handle4(m, params).await.unwrap_or_else(|| Err(err_p(ErrorCode::UnknownMethod, &[("method", m)])));
                }
                if crate::runs::METHODS.contains(&m) {
                    return self.handle3(client, m, params).await.unwrap_or_else(|| Err(err_p(ErrorCode::UnknownMethod, &[("method", m)])));
                }
                match self.handle2(client, m, params).await {
                    Some(r) => r,
                    None => Err(err_p(ErrorCode::UnknownMethod, &[("method", m)])),
                }
            }
        }
    }

    fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo { id: self.ws.id.clone(), name: self.ws.name.clone() }
    }

    /* ---------------------------------------------------------------- kinds and rows */

    pub fn kind_meta(&self, kind: &str) -> KindMeta {
        self.kind_meta_v(kind, None)
    }

    /// For a stored resource: its kind as the version it is bound to declares it.
    pub fn row_meta(&self, r: &Row) -> KindMeta {
        self.kind_meta_v(&r.kind, r.plugin_version.as_deref())
    }

    pub fn kind_meta_v(&self, kind: &str, version: Option<&str>) -> KindMeta {
        if crate::params::is_param_kind(kind) {
            return KindMeta {
                label: Label::Text(kind.into()),
                icon: if kind == store::KIND_ENV { "globe" } else { "settings" }.into(),
                page: None,
                draggable: true,
                accepts: vec![kind.into()],
                commands: vec![],
                state: NodeState::Ok,
                reason: None,
                plugin: None,
            };
        }
        if kind == KIND_GROUP {
            return KindMeta {
                label: Label::Text(KIND_GROUP.into()),
                icon: "folder".into(),
                page: None,
                draggable: true,
                accepts: vec!["*".into()],
                commands: vec![],
                state: NodeState::Ok,
                reason: None,
                plugin: None,
            };
        }
        // A resource bound to a version that is not installed (any more): §7.6 "缺少插件".
        let bound = match version {
            Some(v) if Registry::split(kind).is_some_and(|(pid, _)| self.registry.version(pid, v).is_none()) => {
                let pid = Registry::split(kind).map(|(p, _)| p).unwrap_or_default();
                return KindMeta {
                    label: self.registry.kind(kind).map(|(p, k)| p.label(&k.label)).unwrap_or(Label::Text(kind.into())),
                    icon: self.registry.kind(kind).map(|(_, k)| k.icon.clone()).unwrap_or_else(|| "puzzle".into()),
                    page: None,
                    draggable: true,
                    accepts: vec![],
                    commands: vec![],
                    state: NodeState::MissingPlugin,
                    reason: Some(Label::Text(format!("{pid}@{v}"))),
                    plugin: None,
                };
            }
            v => self.registry.kind_at(kind, v),
        };
        match bound {
            // D315: bound to a version whose permissions are not confirmed — shown off, never run.
            Some((p, k)) if !self.version_confirmed(p) => KindMeta {
                label: p.label(&k.label),
                icon: k.icon.clone(),
                page: None,
                draggable: k.draggable,
                accepts: vec![],
                commands: vec![],
                state: NodeState::Disabled,
                reason: Some(Label::Text("unconfirmedVersion".into())),
                plugin: None,
            },
            Some((p, k)) => KindMeta {
                label: p.label(&k.label),
                icon: k.icon.clone(),
                page: k.page.clone().map(|pg| (p.id.clone(), pg)),
                draggable: k.draggable,
                accepts: k.accepts.iter().map(|a| p.kind_ref(a)).collect(),
                commands: k.menu.iter().map(|c| self.plugin_menu_cmd(p, c)).collect(),
                // D290: a disabled plugin's resources stay, greyed out.
                state: if self.plugin_enabled(&p.id) && self.version_deps_met(p) { NodeState::Ok } else { NodeState::Disabled },
                reason: None,
                plugin: Some(p),
            },
            None => KindMeta {
                label: Label::Text(kind.into()),
                icon: "puzzle".into(),
                page: None,
                draggable: true,
                accepts: vec![],
                commands: vec![],
                state: NodeState::MissingPlugin,
                reason: Some(Label::Text(kind.into())),
                plugin: None,
            },
        }
    }

    pub fn plugin_menu_cmd(&self, p: &Plugin, short: &str) -> MenuCommand {
        let full = p.command_ref(short);
        match p.command(short) {
            Some(c) => MenuCommand {
                id: full,
                label: p.label(&c.label),
                icon: c.icon.clone(),
                danger: None,
                disabled: None,
                shortcut: None,
                separator_before: None,
            },
            None => kernel_cmd(&full, if full == "plugin.grantFolder" { "folder-input" } else { "folder-plus" }),
        }
    }

    pub fn hidden_tree(&self, r: &Row) -> bool {
        r.tree.as_deref() == Some(TREE_PLUGIN_STATE)
    }

    pub fn live_row(&self, id: &str) -> KResult<Row> {
        self.read(|c| store::get(c, id))?.ok_or_else(|| not_found("resource"))
    }

    pub fn row_in_tree(&self, tree: &str, key: &str) -> KResult<Row> {
        let r = self.live_row(key)?;
        if r.tree.as_deref() != Some(tree) {
            return Err(not_found("node"));
        }
        Ok(r)
    }

    pub fn resource(&self, r: &Row) -> KResult<Resource> {
        // D321: resolved `[[old]]` marks read as the target's current name.
        let r = &self.display_row(r)?;
        let meta = self.row_meta(r);
        let location = self.read(|c| store::ancestors(c, r))?.into_iter().map(|a| a.name).collect();
        Ok(Resource {
            id: r.id.clone(),
            kind: r.kind.clone(),
            kind_label: meta.label,
            icon: meta.icon,
            tree: r.tree.clone().unwrap_or_default(),
            parent_id: r.parent_id.clone(),
            name: r.name.clone(),
            description: r.description.clone(),
            tags: r.tags.clone(),
            body: r.body.clone(),
            state: meta.state,
            state_reason: meta.reason.clone(),
            origin: Origin::Original,
            origin_ref: r.origin_ref.clone(),
            location,
            favorite: self.read(|c| store::is_favorite(c, &r.id))?,
            deleted: r.deleted_at.is_some(),
            read_only: false,
            rev: r.rev,
            plugin_version: r.plugin_version.clone(),
            created_at: r.created_at,
            created_by: r.created_by.clone(),
            updated_at: r.updated_at,
            updated_by: r.updated_by.clone(),
        })
    }

    /* ---------------------------------------------------------------- trees */

    /// A stored tree id the protocol may touch: `resources` or a plugin's stored tree.
    pub fn stored_tree(&self, tree: &str) -> KResult<()> {
        if tree == TREE_RESOURCES || tree == store::TREE_ENV || tree == store::TREE_CONFIG {
            return Ok(());
        }
        match self.registry.tree(tree) {
            Some((_, t)) if t.source == TreeSource::Stored => Ok(()),
            Some(_) => Err(err_p(ErrorCode::Unsupported, &[("reason", "providedTree")])),
            None => Err(not_found("tree")),
        }
    }

    fn tree_list(&self) -> Vec<TreeInfo> {
        let new_menu = |tree: &str| -> Vec<MenuCommand> {
            self.new_items(Some(tree))
                .into_iter()
                .map(|n| MenuCommand {
                    id: n.id,
                    label: n.label,
                    icon: Some(n.icon),
                    danger: None,
                    disabled: n.disabled,
                    shortcut: None,
                    separator_before: n.separator_before,
                })
                .collect()
        };
        let list_tree = |id: &str, icon: &str, toolbar: Vec<MenuCommand>| TreeInfo {
            id: id.into(),
            title: Label::Text(id.into()),
            icon: icon.into(),
            source: TreeSource::Provided,
            groups: false,
            menu: toolbar.clone(),
            toolbar,
        };
        let env_tools = vec![kernel_cmd("env.newChild", "plus")];
        let mut kernel_trees = vec![
            TreeInfo {
                id: store::TREE_ENV.into(),
                title: Label::Text(store::TREE_ENV.into()),
                icon: "globe".into(),
                source: TreeSource::Stored,
                groups: false,
                toolbar: env_tools.clone(),
                menu: env_tools,
            },
            TreeInfo {
                id: store::TREE_CONFIG.into(),
                title: Label::Text(store::TREE_CONFIG.into()),
                icon: "settings".into(),
                source: TreeSource::Stored,
                groups: false,
                toolbar: vec![],
                menu: vec![],
            },
            list_tree(store::TREE_FAVORITES, "star", vec![]),
            list_tree(store::TREE_DELETED, "trash-2", vec![kernel_cmd("open.deleted", "external-link")]),
            list_tree(store::TREE_PLUGINS, "puzzle", vec![]),
            list_tree(store::TREE_RUNS, "history", vec![]),
        ];
        let mut out = vec![TreeInfo {
            id: TREE_RESOURCES.into(),
            title: Label::Text(TREE_RESOURCES.into()),
            icon: "library".into(),
            source: TreeSource::Stored,
            groups: true,
            toolbar: new_menu(TREE_RESOURCES),
            menu: new_menu(TREE_RESOURCES),
        }];
        for p in &self.registry.plugins() {
            let enabled = self.plugin_enabled(&p.id);
            for t in &p.manifest.contributes.trees {
                // D290: a disabled plugin's provided trees are not shown.
                if !enabled && t.source == TreeSource::Provided {
                    continue;
                }
                let full = p.full(&t.id);
                let declared: Vec<MenuCommand> = t.toolbar.iter().map(|c| self.plugin_menu_cmd(p, c)).collect();
                let (toolbar, menu) = if t.source == TreeSource::Stored {
                    let m = new_menu(&full);
                    let mut tb = declared;
                    tb.extend(m.clone());
                    (tb, m)
                } else {
                    (declared.clone(), declared)
                };
                out.push(TreeInfo {
                    id: full,
                    title: p.label(&t.label),
                    icon: t.icon.clone(),
                    source: t.source,
                    groups: t.source == TreeSource::Stored,
                    toolbar,
                    menu,
                });
            }
        }
        out.append(&mut kernel_trees);
        out
    }

    pub fn node_for(&self, r: &Row) -> KResult<TreeNode> {
        let meta = self.row_meta(r);
        let group = r.kind == KIND_GROUP;
        let has_children = self.read(|c| store::has_children(c, &r.id))?;
        let mut menu = Vec::new();
        if meta.page.is_some() || crate::params::is_param_kind(&r.kind) {
            menu.push(kernel_cmd("node.open", "external-link"));
        }
        if r.kind == store::KIND_ENV {
            menu.push(kernel_cmd("env.newChild", "plus"));
        }
        if r.kind == store::KIND_CONFIG {
            menu.push(kernel_cmd("config.newChild", "plus"));
        }
        menu.push(kernel_cmd("node.rename", "pencil"));
        if group {
            menu.push(kernel_cmd("node.newGroup", "folder-plus"));
        }
        if self.read(|c| store::is_favorite(c, &r.id))? {
            menu.push(kernel_cmd("node.unfavorite", "star-off"));
        } else {
            menu.push(kernel_cmd("node.favorite", "star"));
        }
        menu.extend(meta.commands);
        // Review #6 (§7.3): actions of enabled dependents on this kind, after its own items.
        for (i, a) in self.dependent_actions(&r.kind).into_iter().enumerate() {
            menu.push(MenuCommand {
                id: a.id,
                label: a.label,
                icon: a.icon,
                danger: None,
                disabled: None,
                shortcut: None,
                separator_before: (i == 0).then_some(true),
            });
        }
        let mut del = kernel_cmd("node.delete", "trash-2");
        del.danger = Some(true);
        del.separator_before = Some(true);
        menu.push(del);
        Ok(TreeNode {
            key: r.id.clone(),
            tree: r.tree.clone().unwrap_or_default(),
            parent_key: r.parent_id.clone(),
            label: r.name.clone(),
            icon: meta.icon,
            kind: r.kind.clone(),
            expandable: group || has_children,
            state: meta.state,
            state_reason: meta.reason.clone(),
            badge: None,
            target: (!group).then(|| format!("resource:{}", r.id)),
            menu,
            draggable: meta.draggable,
            accepts: meta.accepts,
        })
    }

    async fn tree_children(&self, p: TreeChildrenParams, client: Option<String>) -> KResult<TreePage> {
        let offset = p.offset.unwrap_or(0);
        if p.tree == store::TREE_FAVORITES || p.tree == store::TREE_DELETED {
            return self.list_tree_page(&p.tree, p.parent.as_deref(), offset);
        }
        if p.tree == store::TREE_PLUGINS || p.tree == store::TREE_RUNS {
            if p.parent.is_some() {
                return Ok(TreePage { nodes: vec![], next: None });
            }
            let all = if p.tree == store::TREE_PLUGINS { self.plugins_tree()? } else { self.runs_tree()? };
            let total = all.len();
            let nodes: Vec<TreeNode> = all.into_iter().skip(offset as usize).take(BATCH as usize).collect();
            let next = offset + BATCH;
            return Ok(TreePage { nodes, next: ((next as usize) < total).then_some(next) });
        }
        if let Some((pl, _)) = self.registry.tree(&p.tree) {
            if !self.plugin_enabled(&pl.id) {
                return Err(not_found("tree"));
            }
        }
        if self.stored_tree(&p.tree).is_ok() {
            let rows = self.read(|c| store::children(c, &p.tree, p.parent.as_deref(), offset, BATCH + 1))?;
            let more = rows.len() > BATCH as usize;
            let nodes = rows.iter().take(BATCH as usize).map(|r| self.node_for(r)).collect::<KResult<Vec<_>>>()?;
            return Ok(TreePage { next: more.then_some(offset + BATCH), nodes });
        }
        let (plugin, decl) = self.registry.tree(&p.tree).ok_or_else(|| not_found("tree"))?;
        let ctx = json!({ "tree": p.tree, "locale": Value::Null });
        let out = self
            .call_plugin(&plugin.id, "trees", &decl.id, "children", json!([ctx, p.parent, offset]), client)
            .await?;
        self.provided_page(plugin, &p.tree, p.parent.as_deref(), decl.page.is_some(), out)
    }

    fn provided_page(&self, plugin: &Plugin, tree: &str, parent: Option<&str>, has_page: bool, out: Value) -> KResult<TreePage> {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PNode {
            key: String,
            label: String,
            icon: String,
            #[serde(default)]
            expandable: bool,
            #[serde(default)]
            target: Option<String>,
            #[serde(default)]
            badge: Option<String>,
        }
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PPage {
            nodes: Vec<PNode>,
            #[serde(default)]
            next: Option<u32>,
        }
        let page: PPage = serde_json::from_value(out)
            .map_err(|e| err_d(ErrorCode::PluginError, format!("{}: bad tree page: {e}", plugin.id)))?;
        if page.nodes.len() > BATCH as usize {
            return Err(err_d(ErrorCode::PluginError, "more than 200 nodes in one batch"));
        }
        let nodes = page
            .nodes
            .into_iter()
            .map(|n| {
                // A container without an explicit target has no page (§5: "absent for pure containers").
                let leaf = !n.expandable;
                let target = n.target.or_else(|| (has_page && leaf).then(|| node_target(tree, &n.key)));
                let mut menu = Vec::new();
                if target.is_some() {
                    menu.push(kernel_cmd("node.open", "external-link"));
                }
                TreeNode {
                    tree: tree.into(),
                    parent_key: parent.map(String::from),
                    label: n.label,
                    icon: n.icon,
                    kind: tree.into(),
                    expandable: n.expandable,
                    state: NodeState::Ok,
                    state_reason: None,
                    badge: n.badge,
                    target,
                    menu,
                    draggable: false,
                    accepts: vec![],
                    key: n.key,
                }
            })
            .collect();
        Ok(TreePage { nodes, next: page.next })
    }

    async fn tree_path(&self, p: TreeNodeParams, client: Option<String>) -> KResult<Vec<String>> {
        if [store::TREE_FAVORITES, store::TREE_DELETED, store::TREE_PLUGINS, store::TREE_RUNS].contains(&p.tree.as_str()) {
            return Ok(vec![p.key]);
        }
        if self.stored_tree(&p.tree).is_ok() {
            let r = self.row_in_tree(&p.tree, &p.key)?;
            let mut ids: Vec<String> = self.read(|c| store::ancestors(c, &r))?.into_iter().map(|a| a.id).collect();
            ids.push(r.id);
            return Ok(ids);
        }
        let (plugin, decl) = self.registry.tree(&p.tree).ok_or_else(|| not_found("tree"))?;
        let ctx = json!({ "tree": p.tree, "locale": Value::Null });
        let out = self.call_plugin(&plugin.id, "trees", &decl.id, "path", json!([ctx, p.key]), client).await?;
        serde_json::from_value(out).map_err(|e| err_d(ErrorCode::PluginError, format!("bad path: {e}")))
    }

    async fn tree_move(&self, p: TreeMoveParams) -> KResult<()> {
        self.stored_tree(&p.tree)?;
        let row = self.row_in_tree(&p.tree, &p.key)?;
        let dest = match (p.position, p.target) {
            (DropPosition::Inside, t) => MoveDest::Inside(t),
            (DropPosition::Before, Some(t)) => MoveDest::Before(t),
            (DropPosition::After, Some(t)) => MoveDest::After(t),
            (_, None) => return Err(invalid_params("before/after need a target")),
        };
        self.execute(Actor::User, Command::Move { id: row.id, dest }).await?;
        Ok(())
    }

    /// `favorites` / `deleted`: flat lists the kernel computes (D279); not draggable.
    fn list_tree_page(&self, tree: &str, parent: Option<&str>, offset: u32) -> KResult<TreePage> {
        if parent.is_some() {
            return Ok(TreePage { nodes: vec![], next: None });
        }
        let favorites = tree == store::TREE_FAVORITES;
        let rows = if favorites { self.read(store::favorites)? } else { self.read(store::deleted_tops)? };
        let total = rows.len();
        let nodes = rows
            .iter()
            .skip(offset as usize)
            .take(BATCH as usize)
            .map(|r| {
                let meta = self.row_meta(r);
                let menu = if favorites {
                    vec![kernel_cmd("node.open", "external-link"), kernel_cmd("node.unfavorite", "star-off")]
                } else {
                    let mut purge = kernel_cmd("deleted.purge", "trash-2");
                    purge.danger = Some(true);
                    purge.separator_before = Some(true);
                    vec![kernel_cmd("deleted.restore", "undo-2"), purge]
                };
                TreeNode {
                    key: r.id.clone(),
                    tree: tree.into(),
                    parent_key: None,
                    label: r.name.clone(),
                    icon: meta.icon,
                    kind: r.kind.clone(),
                    expandable: false,
                    state: meta.state,
                    state_reason: meta.reason.clone(),
                    badge: None,
                    target: (favorites && r.kind != KIND_GROUP).then(|| format!("resource:{}", r.id)),
                    menu,
                    draggable: false,
                    accepts: vec![],
                }
            })
            .collect();
        let next = offset + BATCH;
        Ok(TreePage { nodes, next: ((next as usize) < total).then_some(next) })
    }

    /// Creates a `core:group`; an empty name gets a default that does not clash with its siblings.
    pub async fn create_group(&self, tree: &str, parent: Option<String>, name: &str) -> KResult<String> {
        self.stored_tree(tree)?;
        if tree == store::TREE_ENV || tree == store::TREE_CONFIG {
            return Err(invalid("noGroups"));
        }
        let name = if name.trim().is_empty() {
            let sibs = self.read(|c| store::children(c, tree, parent.as_deref(), 0, u32::MAX))?;
            let taken = |n: &str| sibs.iter().any(|s| s.name == n);
            let mut candidate = DEFAULT_GROUP_NAME.to_string();
            let mut i = 2;
            while taken(&candidate) {
                candidate = format!("{DEFAULT_GROUP_NAME} {i}");
                i += 1;
            }
            candidate
        } else {
            name.to_string()
        };
        let out = self
            .execute(
                Actor::User,
                Command::Create(NewResource {
                    kind: KIND_GROUP.into(),
                    tree: Some(tree.into()),
                    parent,
                    name,
                    description: String::new(),
                    tags: vec![],
                    body: JsonMap::new(),
                    plugin_version: None,
                }),
            )
            .await?;
        out.id.ok_or_else(|| internal("no id"))
    }

    /// The "new" items: `node.newGroup` and every manifest's `menus.new` (optionally for one tree).
    pub fn new_items(&self, tree: Option<&str>) -> Vec<NewItem> {
        let mut out = vec![NewItem {
            id: "node.newGroup".into(),
            label: Label::Text("node.newGroup".into()),
            icon: "folder-plus".into(),
            separator_before: None,
            disabled: None,
        }];
        let mut first = true;
        for p in self.registry.plugins().iter().filter(|p| self.plugin_enabled(&p.id)) {
            for k in &p.manifest.contributes.menus.new {
                let Some(decl) = p.kind(k) else { continue };
                let kt = decl.tree.as_deref().map(|t| p.tree_ref(t));
                if tree.is_some_and(|t| kt.as_deref() != Some(t)) {
                    continue;
                }
                out.push(NewItem {
                    id: format!("new:{}", p.full(k)),
                    label: p.label(&decl.label),
                    icon: decl.icon.clone(),
                    separator_before: first.then_some(true),
                    disabled: None,
                });
                first = false;
            }
        }
        out
    }

    /* ---------------------------------------------------------------- plugins: runtimes */

    /// One runtime per plugin *version* (§7.6): `id@version`.
    fn slot(&self, p: &Plugin) -> Slot {
        self.slots.lock().unwrap().entry(format!("{}@{}", p.id, p.version)).or_default().clone()
    }

    async fn sandbox(&self, plugin: &'static Plugin) -> KResult<Arc<Sandbox>> {
        let slot = self.slot(plugin);
        let mut guard = slot.lock().await;
        if let Some(sb) = guard.as_ref() {
            return Ok(sb.clone());
        }
        let pkg = Package {
            id: plugin.id.clone(),
            main: plugin.manifest.main.clone(),
            files: read_js_files(&plugin.dir).map_err(|e| err_d(ErrorCode::PluginError, e))?,
            declared: Declarations {
                pages: plugin.manifest.contributes.pages.iter().map(|p| p.id.clone()).collect(),
                trees: plugin.manifest.contributes.trees.iter().map(|t| t.id.clone()).collect(),
                commands: plugin.manifest.contributes.commands.iter().map(|c| c.id.clone()).collect(),
                actions: plugin.manifest.contributes.actions.iter().map(|a| a.id.clone()).collect(),
                kinds: plugin.manifest.contributes.kinds.iter().map(|k| k.id.clone()).collect(),
                events: plugin.manifest.contributes.events.clone(),
            },
            labels: plugin.all_labels(),
        };
        let host = Arc::new(crate::host::PluginHost { kernel: self.me.clone(), plugin });
        self.activations.fetch_add(1, Ordering::SeqCst);
        let sb = Arc::new(Sandbox::activate(pkg, host, self.cfg.sandbox.clone()).await.map_err(|e| e.to_protocol())?);
        *guard = Some(sb.clone());
        Ok(sb)
    }

    /// Calls a handler of the plugin's active version; activates it first if needed.
    pub async fn call_plugin(
        &self,
        plugin: &str,
        kind: &str,
        name: &str,
        func: &str,
        args: Value,
        client: Option<String>,
    ) -> KResult<Value> {
        let info = CallInfo { client, ..Default::default() };
        self.call_plugin_with(plugin, kind, name, func, args, info, None, None).await.map_err(|e| e.to_protocol())
    }

    /// The general form on the active version: the call's context, cancel token and time budget.
    #[allow(clippy::too_many_arguments)]
    pub async fn call_plugin_with(
        &self,
        plugin: &str,
        kind: &str,
        name: &str,
        func: &str,
        args: Value,
        info: CallInfo,
        cancel: Option<crate::sandbox::CancelToken>,
        timeout: Option<std::time::Duration>,
    ) -> Result<Value, SandboxError> {
        let host = |e: ProtocolError| SandboxError::Host(e);
        let p = self.registry.plugin(plugin).ok_or_else(|| host(err_p(ErrorCode::PluginError, &[("reason", "notLoaded")])))?;
        self.call_version(p, kind, name, func, args, info, cancel, timeout).await
    }

    /// Calls a handler of one given version (a resource is handled by the version it is bound to).
    #[allow(clippy::too_many_arguments)]
    pub async fn call_version(
        &self,
        p: &'static Plugin,
        kind: &str,
        name: &str,
        func: &str,
        args: Value,
        info: CallInfo,
        cancel: Option<crate::sandbox::CancelToken>,
        timeout: Option<std::time::Duration>,
    ) -> Result<Value, SandboxError> {
        let host = |e: ProtocolError| SandboxError::Host(e);
        // Review #8: an older version (bound resources) must have its own `depends` met too.
        if !self.plugin_enabled(&p.id) || !self.version_deps_met(p) {
            return Err(host(err_p(ErrorCode::PluginError, &[("reason", "pluginDisabled")])));
        }
        // D315: the code of a version whose permissions are not confirmed never runs.
        if !self.version_confirmed(p) {
            return Err(host(err_p(ErrorCode::PluginError, &[("reason", "unconfirmedVersion")])));
        }
        let sb = self.sandbox(p).await.map_err(host)?;
        let timeout = timeout.unwrap_or(self.cfg.sandbox.call_timeout);
        // Plugin code is polled on the runtime's worker threads, never on the connection reader.
        let call = {
            let sb = sb.clone();
            let (kind, name, func) = (kind.to_string(), name.to_string(), func.to_string());
            tokio::spawn(async move { sb.call_with(&kind, &name, &func, &args, info, cancel, timeout).await })
        };
        let res = call.await.unwrap_or_else(|e| Err(SandboxError::Engine(e.to_string())));
        if let Err(e) = &res {
            if e.poisons() {
                let slot = self.slot(p);
                let mut g = slot.lock().await;
                if g.as_ref().is_some_and(|cur| Arc::ptr_eq(cur, &sb)) {
                    *g = None;
                }
            }
        }
        res
    }

    /// Drops every runtime of a plugin (disabled, reloaded, version removed).
    pub async fn drop_runtime(&self, plugin: &str) {
        let prefix = format!("{plugin}@");
        let slots: Vec<Slot> =
            self.slots.lock().unwrap().iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(_, v)| v.clone()).collect();
        for s in slots {
            *s.lock().await = None;
        }
    }

    /// D290 / D299 / D343: enabled unless its state says `enabled = false`, it has a usable
    /// (installed, confirmed) active version, and its `depends` are met.
    pub fn plugin_enabled(&self, plugin: &str) -> bool {
        self.plugin_state(plugin).is_ok()
    }

    /// A parameter of the plugin's state node (`enabled`, `settings.<name>`).
    pub fn plugin_param(&self, plugin: &str, name: &str) -> Option<String> {
        self.read(|c| store::plugin_state(c, plugin)).ok().flatten().and_then(|r| crate::params::get(&r, name)).map(|p| p.value)
    }
}

/// `node:<tree>/<url-encoded key>`
pub fn node_target(tree: &str, key: &str) -> String {
    format!("node:{tree}/{}", url_encode(key))
}

pub fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn url_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let h = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Every `.js` file of a package, by relative path (`a/b.js`). Links are not followed.
fn read_js_files(dir: &Path) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        for e in std::fs::read_dir(dir.join(&rel)).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            let ft = e.file_type().map_err(|e| e.to_string())?;
            let r = rel.join(e.file_name());
            if ft.is_dir() {
                stack.push(r);
            } else if ft.is_file() && r.extension().is_some_and(|x| x == "js") {
                let src = std::fs::read_to_string(e.path()).map_err(|e| e.to_string())?;
                out.insert(r.to_string_lossy().replace('\\', "/"), src);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encoding_round_trips() {
        for s in ["/a b/ç.txt", "x%y", "plain"] {
            assert_eq!(url_decode(&url_encode(s)).unwrap(), s);
        }
        assert!(!url_encode("/a/b").contains('/'));
    }
}
