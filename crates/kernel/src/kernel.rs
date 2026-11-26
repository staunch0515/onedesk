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
/// D473: the icon of a resource tree that has not been given one.
pub const TREE_ICON: &str = "library";

/// D473: the icon a user chose for a resource tree (`body.icon`, a lucide name).
pub fn tree_icon(r: &Row) -> Option<String> {
    r.body
        .get("icon")
        .and_then(Value::as_str)
        .filter(|i| !i.is_empty() && i.len() <= 64 && i.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
        .map(String::from)
}
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
    /// D365: a plugin version's runtime that has nothing in flight for this long is released
    /// (10 minutes; the worker takes `ONEDESK_PLUGIN_IDLE_MS` for tests and acceptance).
    pub plugin_idle: std::time::Duration,
    /// Round 17 (X18): `None` (the default): `files.trash` uses the system's Trash
    /// (`NSFileManager trashItemAtURL:`). `Some(folder)`: moves things into that folder instead —
    /// tests only (the worker takes `ONEDESK_TRASH_DIR` with `ONEDESK_TEST_HOOKS=1`).
    pub trash_dir: Option<std::path::PathBuf>,
    /// Round 17 (X18): opens a path with its default program or reveals it in Finder.
    pub opener: Opener,
    /// Round 19: how long `mcp.call` waits for a run to end before answering `running`.
    pub mcp_wait: std::time::Duration,
    /// Round 19: every request of this kernel is an AI client's (`onedesk-worker --ai-client`).
    pub ai_only: Option<String>,
}

/// Round 17 (X18): what `files.open` (`reveal: false`) and `files.reveal` (`true`) call.
#[derive(Clone)]
pub struct Opener(pub Arc<OpenFn>);

/// `(path, reveal)`.
pub type OpenFn = dyn Fn(&std::path::Path, bool) -> Result<(), String> + Send + Sync;

impl std::fmt::Debug for Opener {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Opener")
    }
}

impl Opener {
    /// `/usr/bin/open <path>` or `/usr/bin/open -R <path>` (the path is absolute: never an option).
    pub fn system() -> Opener {
        Opener(Arc::new(|path, reveal| {
            let mut c = std::process::Command::new("/usr/bin/open");
            if reveal {
                c.arg("-R");
            }
            c.arg(path).env_clear().stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            let mut child = c.spawn().map_err(|e| e.to_string())?;
            // Reaped in the background; `open` returns at once.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }))
    }

    /// Does nothing (tests that do not look).
    pub fn none() -> Opener {
        Opener(Arc::new(|_, _| Ok(())))
    }

    /// Appends `open <path>` / `reveal <path>` to `log` instead (tests, e2e: `ONEDESK_OPEN_LOG`).
    pub fn log_to(log: std::path::PathBuf) -> Opener {
        Opener(Arc::new(move |path, reveal| {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&log).map_err(|e| e.to_string())?;
            writeln!(f, "{} {}", if reveal { "reveal" } else { "open" }, path.display()).map_err(|e| e.to_string())
        }))
    }
}

/// D365: the default idle time before a plugin runtime is released.
pub const DEFAULT_PLUGIN_IDLE: std::time::Duration = std::time::Duration::from_secs(600);

impl Default for KernelConfig {
    fn default() -> Self {
        KernelConfig {
            sandbox: SandboxConfig::default(),
            action_timeout: std::time::Duration::from_secs(60),
            secrets: crate::secrets::SecretStoreHandle::from_env(),
            builtin: vec![],
            plugin_idle: DEFAULT_PLUGIN_IDLE,
            trash_dir: None,
            opener: Opener::system(),
            mcp_wait: std::time::Duration::from_secs(30),
            ai_only: None,
        }
    }
}

pub struct Kernel {
    pub(crate) inner: Arc<Inner>,
}

type Slot = Arc<SlotState>;

/// One plugin version's runtime and how it is used (D365).
#[derive(Default)]
struct SlotState {
    sb: tokio::sync::Mutex<Option<Arc<Sandbox>>>,
    /// Invocations in flight (runs, renders, page and event handlers, migrate, tree handlers).
    /// Host calls and install requests live inside an invocation, so they are counted by it.
    busy: std::sync::atomic::AtomicUsize,
    /// When the last invocation started or ended.
    last: Mutex<Option<std::time::Instant>>,
}

impl SlotState {
    fn touch(&self) {
        *self.last.lock().unwrap() = Some(std::time::Instant::now());
    }
}

/// Marks a slot busy for one invocation.
struct Busy(Slot);

impl Busy {
    fn new(s: Slot) -> Busy {
        s.busy.fetch_add(1, Ordering::SeqCst);
        s.touch();
        Busy(s)
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.touch();
        self.0.busy.fetch_sub(1, Ordering::SeqCst);
    }
}

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
    /// Start-up only (many packages): every plugin's state row, read in one query, so the
    /// first-sight and active-version passes do not query once per plugin. `None` otherwise.
    pub(crate) state_snapshot: Mutex<Option<HashMap<String, store::Row>>>,
    pub(crate) state_queries: AtomicU64,
    /// Round 11: the languages last published (`languages` is sent when they change).
    pub(crate) languages_seen: Mutex<Option<Vec<onedesk_protocol::LanguageInfo>>>,
    /// Round 17 (D430): plugin warnings already written (each once).
    pub(crate) warned: Mutex<std::collections::HashSet<String>>,
    /// Round 19: rate-limit memory of the AI clients.
    pub(crate) mcp: crate::mcp::McpState,
    /// D484 §16: blobs each client has put and may read before any resource uses them.
    pub(crate) blob_pending: Mutex<HashMap<String, std::collections::HashSet<String>>>,
    /// D487 §17 (K3): results of calls (`[[=…]]`, `![[… | …]]`).
    pub(crate) embed_cache: Mutex<crate::transfer::EmbedCache>,
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

/// Per-request memo for `node_memo`: (kind, bound version) → meta, supplies children, dependents' actions.
#[derive(Default)]
pub(crate) struct NodeMemo(HashMap<(String, Option<String>), KindShared>, Option<bool>);

/// What every node of one kind shares: its meta, whether it supplies children, dependents' actions.
type KindShared = (KindMeta, bool, Vec<ActionDecl>);

/// What the kernel knows about a kind without running any plugin code.
#[derive(Clone)]
pub(crate) struct KindMeta {
    pub label: Label,
    pub icon: String,
    /// (plugin id, page short name)
    pub page: Option<(String, String)>,
    pub draggable: bool,
    pub accepts: Vec<String>,
    /// Round 12 (D390): the kind decides drops onto its nodes (`drop`), and its plugin runs.
    pub drop_any: bool,
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
            state_snapshot: Mutex::new(None),
            state_queries: AtomicU64::new(0),
            languages_seen: Mutex::new(None),
            warned: Mutex::new(Default::default()),
            mcp: Default::default(),
            blob_pending: Default::default(),
            embed_cache: Default::default(),
        });
        // Round 13 (D400): a new workspace copies the settings it was created with, once.
        let init = inner.read(|c| Ok(crate::workspace_settings::take_init_settings(&inner.ws.dir, c))).ok().flatten();
        if let Some(s) = init {
            if let Err(e) = inner.pipeline.execute_blocking(crate::pipeline::Actor::Core, Command::InitSettings(Box::new(s))) {
                eprintln!("onedesk: init-settings not applied: {e:?}");
            }
        }
        // D299 first sight, then each plugin's active version.
        inner.take_state_snapshot();
        inner.first_sight_blocking();
        inner.take_state_snapshot();
        inner.refresh_active();
        *inner.state_snapshot.lock().unwrap() = None;
        inner.check_languages();
        // D365: the idle reaper; it holds the kernel weakly and ends with it.
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let me = Arc::downgrade(&inner);
            let every = (inner.cfg.plugin_idle / 4).clamp(std::time::Duration::from_millis(50), std::time::Duration::from_secs(30));
            rt.spawn(async move {
                loop {
                    tokio::time::sleep(every).await;
                    let Some(k) = me.upgrade() else { break };
                    k.release_idle().await;
                }
            });
        }
        // A newer confirmed version that arrived while the worker was off takes over now (D303).
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let me = inner.clone();
            // Round 10 (§7): only plugins that have a version newer than the active one are
            // looked at; asking every plugin's state took the reader for seconds with ten
            // thousand packages, right when the first requests come in.
            let candidates: Vec<String> = me
                .registry
                .ids()
                .into_iter()
                .filter(|id| {
                    let newest = me.registry.versions(id).last().map(|p| p.semver());
                    let active = me.registry.plugin(id).map(|p| p.semver());
                    matches!((newest, active), (Some(n), Some(a)) if n > a)
                })
                .collect();
            rt.spawn(async move {
                for id in candidates {
                    if let Err(e) = me.auto_switch(&id).await {
                        eprintln!("onedesk: automatic switch of {id} failed: {e:?}");
                    }
                }
                // Round 16 (X13): after the switches, so the version that answers is the one in use.
                me.workspace_opened();
            });
        }
        Ok(Kernel { inner })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventMessage> {
        self.inner.events.subscribe()
    }

    /// Handles one request. `hello` gating per connection is the transport's job.
    pub async fn request(&self, client: Option<String>, method: &str, params: Value) -> KResult<Value> {
        self.request_as(None, client, method, params).await
    }

    /// `request` for the actor the envelope names (`ai:<client>`; round 19). A kernel started
    /// with `ai_only` takes every request as that AI client's, whatever the envelope says.
    pub async fn request_as(&self, actor: Option<&str>, client: Option<String>, method: &str, params: Value) -> KResult<Value> {
        let ai = match (&self.inner.cfg.ai_only, actor) {
            (Some(name), _) => Some(crate::mcp::clean_client(name)),
            (None, Some(a)) => Some(crate::mcp::ai_client(a)?),
            (None, None) => None,
        };
        match ai {
            Some(c) => self.inner.ai_request(&c, client, method, params).await,
            None => self.inner.handle(client, method, params).await,
        }
    }

    /// Runs a command for an actor, as the kernel's own code does (tests: what the writer refuses).
    #[doc(hidden)]
    pub async fn execute_for_test(&self, actor: Actor, cmd: Command) -> KResult<Outcome> {
        self.inner.execute(actor, cmd).await
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
        self.inner.info()
    }

    /// Plugins whose runtime is currently alive (tests use this to check lazy activation).
    pub fn active_plugins(&self) -> Vec<String> {
        let slots: Vec<(String, Slot)> =
            self.inner.slots.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let out: Vec<String> =
            slots.into_iter().filter(|(_, s)| s.sb.try_lock().map(|g| g.is_some()).unwrap_or(true)).map(|(k, _)| k).collect();
        // Slots are per version (`id@version`); callers ask about plugins.
        let mut out: Vec<String> = out.into_iter().map(|k| k.split('@').next().unwrap_or_default().to_string()).collect();
        out.sort();
        out.dedup();
        out
    }

    /// Commands sent to the writer since the kernel opened (tests).
    pub fn writes_sent(&self) -> u64 {
        self.inner.pipeline.sent()
    }

    /// Plugin state rows read one by one from the database (tests: start-up reads them at once).
    pub fn state_queries(&self) -> u64 {
        self.inner.state_queries.load(Ordering::Relaxed)
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
        let topic = topic.into();
        let plugins = topic == topic::PLUGINS;
        let _ = self.events.send(EventMessage { topic, payload, client });
        // Round 11: enabling, disabling, installing, removing or switching a plugin may change
        // the languages there are.
        if plugins {
            self.check_languages();
        }
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
            Command::Create(_) | Command::Import(_) | Command::Propose(_) => Some("created"),
            // D487 §29: created, updated or deleted, per row.
            Command::Review { .. } => Some("upserted"),
            Command::Update { .. }
            | Command::Params { .. }
            | Command::Move { .. }
            | Command::Restore { .. }
            | Command::Upgrade { .. }
            | Command::UndoUpgrade { .. }
            | Command::Batch(_) => Some("updated"),
            Command::Delete { .. } => Some("deleted"),
            Command::Undelete { .. } => Some("restored"),
            Command::Purge { .. } => Some("purged"),
            // Round 16: created (rev 1) or updated, per row.
            Command::Upsert { .. } => Some("upserted"),
            // D487 §21: a copy's rows made (rev 1) or brought up to date.
            Command::ImportPackage(_) => Some("upserted"),
            _ => None,
        };
        let plugin_state = matches!(&cmd, Command::Update { .. } | Command::Create(_) | Command::Grant { .. });
        let deletion = matches!(&cmd, Command::Delete { .. } | Command::Undelete { .. } | Command::Purge { .. } | Command::Upsert { .. } | Command::ImportPackage(_));
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
            Command::Review { steps, .. } => Some(
                steps
                    .iter()
                    .filter_map(|s| match &s.cmd {
                        Command::Update { id, .. } => Some(id.clone()),
                        _ => None,
                    })
                    .collect(),
            ),
            // Round 16 review #3: the resources these keys already name (live ones; created and
            // restored ones count as granting nothing before).
            Command::Upsert { kind, items, .. } => {
                let keys: Vec<&str> = items.iter().map(|i| i.key.as_str()).collect();
                let keys = serde_json::to_string(&keys).unwrap_or_default();
                Some(
                    self.read(|c| {
                        let mut st = c.prepare(
                            "SELECT id FROM resources WHERE kind = ?1 AND deleted_at IS NULL
                             AND external_key IN (SELECT value FROM json_each(?2))",
                        )?;
                        let v = st.query_map(rusqlite::params![kind, keys], |r| r.get(0))?;
                        v.collect()
                    })
                    .unwrap_or_default(),
                )
            }
            Command::Import(plan) => Some(plan.items.iter().filter(|i| i.update).map(|i| i.id.clone()).collect()),
            Command::ImportPackage(plan) => Some(plan.pkg.resources.iter().map(|r| r.id.clone()).collect()),
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
                let c = match change {
                    "created" if r.rev > 1 => "updated",
                    "upserted" if r.deleted_at.is_some() => "deleted",
                    "upserted" if r.rev == 1 => "created",
                    "upserted" => "updated",
                    c => c,
                };
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
            onedesk_protocol::method19::MCP_STATUS => to_value(self.mcp_status()?),
            onedesk_protocol::method19::RESOURCE_SET_AI_VISIBLE => to_value(self.set_ai_visible(parse(params)?).await?),
            // Round 19: the AI's tools are for the AI actor only.
            onedesk_protocol::method19::MCP_TOOLS | onedesk_protocol::method19::MCP_CALL => Err(denied("aiOnly")),
            M::TREE_LIST => to_value(self.tree_list()),
            M::TREE_CHILDREN => to_value(self.tree_children(parse(params)?, client).await?),
            M::TREE_PATH => to_value(self.tree_path(parse(params)?, client).await?),
            M::TREE_MOVE => to_value(self.tree_move(parse(params)?, client).await?),
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
                self.execute(Actor::User, Command::Update { id: row.id, changes, basis: None, overwrite: vec![] }).await?;
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
            M::PLUGIN_REPLACE_FOLDER => to_value(self.replace_folder(parse(params)?).await?),
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
            onedesk_protocol::method13::WORKSPACE_SETTINGS_SNAPSHOT => to_value(self.settings_snapshot(client.as_deref())?),
            _ => {
                if crate::i18n::METHODS.contains(&m) {
                    return self.handle11(m, params);
                }
                if crate::install::METHODS.contains(&m) {
                    return self.handle7(m, params).await;
                }
                if crate::blobs::METHODS.contains(&m) {
                    return self.handle_blobs(client, m, params).await;
                }
                if crate::packages::METHODS.contains(&m) {
                    return self.handle_packages(m, params).await;
                }
                if crate::proposals::METHODS.contains(&m) {
                    return self.handle_proposals(m, params).await;
                }
                if crate::identity::METHODS.contains(&m) {
                    return self.handle_identity(m, params).await;
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
        WorkspaceInfo { id: self.ws.id.clone(), name: self.ws.current_name(), startup_pages: Some(self.startup_pages()) }
    }

    /* ---------------------------------------------------------------- kinds and rows */

    pub fn kind_meta(&self, kind: &str) -> KindMeta {
        self.kind_meta_v(kind, None)
    }

    /// For a stored resource: its kind as the version it is bound to declares it.
    pub fn row_meta(&self, r: &Row) -> KindMeta {
        let mut meta = self.kind_meta_v(&r.kind, r.plugin_version.as_deref());
        // D473: a resource tree shows the icon its user chose.
        if r.kind == store::KIND_TREE {
            if let Some(icon) = tree_icon(r) {
                meta.icon = icon;
            }
        }
        meta
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
                drop_any: false,
                state: NodeState::Ok,
                reason: None,
                plugin: None,
            };
        }
        if kind == store::KIND_PROPOSAL || kind == store::KIND_CONTACT {
            return KindMeta {
                label: Label::Text(kind.into()),
                icon: if kind == store::KIND_CONTACT { "id-card" } else { "git-pull-request" }.into(),
                page: None,
                draggable: false,
                accepts: vec![],
                commands: vec![],
                drop_any: false,
                state: NodeState::Ok,
                reason: None,
                plugin: None,
            };
        }
        if kind == KIND_GROUP || kind == store::KIND_TREE {
            return KindMeta {
                label: Label::Text(kind.into()),
                icon: if kind == KIND_GROUP { "folder" } else { TREE_ICON }.into(),
                page: None,
                draggable: true,
                accepts: vec!["*".into()],
                commands: vec![],
                drop_any: false,
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
                    drop_any: false,
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
                drop_any: false,
                state: NodeState::Disabled,
                reason: Some(Label::Text("unconfirmedVersion".into())),
                plugin: None,
            },
            Some((p, k)) => KindMeta {
                label: p.label(&k.label),
                icon: k.icon.clone(),
                // Round 8 (D357): `(page's plugin, page)`, another plugin's when borrowed.
                page: k.page.as_deref().map(|pg| p.page_ref(pg)),
                draggable: k.draggable,
                accepts: k.accepts.iter().map(|a| p.kind_ref(a)).collect(),
                commands: k.menu.iter().map(|c| self.plugin_menu_cmd(p, c)).collect(),
                drop_any: k.drop && self.plugin_enabled(&p.id) && self.version_deps_met(p) && self.kind_unmet(p, k).is_empty(),
                // D290: a disabled plugin's resources stay, greyed out; so do those of a kind
                // whose borrowed tree or page is not exported (D356).
                state: if self.plugin_enabled(&p.id) && self.version_deps_met(p) && self.kind_unmet(p, k).is_empty() {
                    NodeState::Ok
                } else {
                    NodeState::Disabled
                },
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
                drop_any: false,
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
        let stored = if self.resource_view(tree).is_some() { TREE_RESOURCES } else { tree };
        if r.tree.as_deref() != Some(stored) {
            return Err(not_found("node"));
        }
        Ok(r)
    }

    /// D473: a view of one resource tree. `None`: `tree` is not one; `Some(None)`: the default tree
    /// (the top level of `resources`); `Some(Some(id))`: the tree whose node is `id`.
    pub fn resource_view(&self, tree: &str) -> Option<Option<String>> {
        if tree == TREE_RESOURCES {
            return Some(None);
        }
        let id = tree.strip_prefix(store::RESOURCE_VIEW_PREFIX)?;
        let row = self.read(|c| store::get(c, id)).ok().flatten()?;
        (row.kind == store::KIND_TREE && row.parent_id.is_none() && !store::is_default_tree(&row)).then_some(Some(row.id))
    }

    /// D473: the view a row of `resources` is shown in (its tree's), else its own tree.
    pub fn view_of_row(&self, r: &Row) -> Option<String> {
        if r.tree.as_deref() != Some(TREE_RESOURCES) {
            return r.tree.clone();
        }
        match self.read(|c| store::tree_of(c, r)).ok().flatten() {
            Some(t) => Some(store::view_of(&t)),
            None => r.tree.clone(),
        }
    }

    pub fn resource(&self, r: &Row) -> KResult<Resource> {
        // D321: resolved `[[old]]` marks read as the target's current name.
        let r = &self.display_row(r)?;
        let meta = self.row_meta(r);
        let (state, state_reason) = store::shown_state(r, meta.state, &meta.reason);
        let mut location: Vec<String> = self.read(|c| store::ancestors(c, r))?.into_iter().map(|a| a.name).collect();
        // D473: in a resource tree the place starts with the tree (the default one's name may be "",
        // the shell's word for it); `tree` is the view it is shown in.
        if r.tree.as_deref() == Some(TREE_RESOURCES) && r.kind != store::KIND_TREE {
            if let Some(t) = self.read(|c| store::tree_of(c, r))?.filter(store::is_default_tree) {
                location.insert(0, t.name);
            }
        }
        Ok(Resource {
            id: r.id.clone(),
            kind: r.kind.clone(),
            kind_label: meta.label,
            icon: meta.icon,
            tree: self.view_of_row(r).unwrap_or_default(),
            parent_id: r.parent_id.clone(),
            name: r.name.clone(),
            description: r.description.clone(),
            tags: r.tags.clone(),
            body: r.body.clone(),
            state,
            state_reason,
            // D487 §21 (K9): a read-only copy of a published subtree.
            origin: if r.origin == crate::packages::ORIGIN_COPY { Origin::Subscribed } else { Origin::Original },
            origin_ref: r.origin_ref.clone(),
            location,
            favorite: self.read(|c| store::is_favorite(c, &r.id))?,
            deleted: r.deleted_at.is_some(),
            read_only: r.origin == crate::packages::ORIGIN_COPY || self.stamped(&r.id)?,
            rev: r.rev,
            plugin_version: r.plugin_version.clone(),
            copy: if r.origin == crate::packages::ORIGIN_COPY { self.copy_info(r.origin_ref.as_deref())? } else { None },
            stamps: self.stamps_of(&r.id)?,
            stamp_log: self.stamp_log_of(&r.id)?,
            created_at: r.created_at,
            created_by: r.created_by.clone(),
            updated_at: r.updated_at,
            updated_by: r.updated_by.clone(),
            ai_visible: Some(self.read(|c| store::is_ai_visible(c, &r.id))?),
            default_env: r.default_env.clone(),
            inherited_env: self.env_along(r, false)?.map(|(env, from)| InheritedEnv {
                env_id: env.id,
                env_name: env.name,
                from_id: from.id,
                from_name: from.name,
                from_kind: from.kind,
            }),
        })
    }

    /// D473: the default environment along `r`'s place, nearest first: `r` itself (when `include_self`),
    /// its groups upwards, its tree (a row at the top level of `resources`: the default tree). Returns the
    /// environment and the row that sets it; an environment that no longer exists does not count.
    pub fn env_along(&self, r: &Row, include_self: bool) -> KResult<Option<(Row, Row)>> {
        if r.tree.as_deref() != Some(TREE_RESOURCES) {
            return Ok(None);
        }
        self.read(|c| {
            let mut chain: Vec<Row> = Vec::new();
            if include_self {
                chain.push(r.clone());
            }
            let ancestors = store::ancestors(c, r)?;
            let in_tree = ancestors.first().is_some_and(|a| a.kind == store::KIND_TREE) || r.kind == store::KIND_TREE;
            chain.extend(ancestors.into_iter().rev());
            if !in_tree {
                chain.extend(store::resource_trees(c)?.into_iter().filter(store::is_default_tree));
            }
            for row in chain {
                let Some(id) = row.default_env.as_deref() else { continue };
                if let Some(env) = store::get(c, id)?.filter(|e| e.kind == store::KIND_ENV) {
                    return Ok(Some((env, row)));
                }
            }
            Ok(None)
        })
    }

    /* ---------------------------------------------------------------- trees */

    /// A stored tree id the protocol may touch: `resources` or a plugin's stored tree.
    pub fn stored_tree(&self, tree: &str) -> KResult<()> {
        if tree == store::TREE_ENV || tree == store::TREE_CONFIG || tree == store::TREE_PROPOSALS || tree == store::TREE_CONTACTS || self.resource_view(tree).is_some() {
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
            // D487 §29 (K16): proposals of changes, newest last as made.
            TreeInfo {
                id: store::TREE_PROPOSALS.into(),
                title: Label::Text(store::TREE_PROPOSALS.into()),
                icon: "git-pull-request".into(),
                source: TreeSource::Stored,
                groups: false,
                toolbar: vec![],
                menu: vec![],
            },
            // D487 §33 (K18): identity cards of others.
            TreeInfo {
                id: store::TREE_CONTACTS.into(),
                title: Label::Text(store::TREE_CONTACTS.into()),
                icon: "book-user".into(),
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
        // D473: one view per resource tree, the default one first; its title is the tree's name (an
        // unnamed default tree keeps the shell's word for "resources").
        let trees = self.read(store::resource_trees).unwrap_or_default();
        let mut out: Vec<TreeInfo> = trees
            .iter()
            .map(|t| {
                let id = store::view_of(t);
                let mut toolbar = new_menu(&id);
                toolbar.push(kernel_cmd("tree.info", "info"));
                TreeInfo {
                    title: Label::Text(if t.name.trim().is_empty() { TREE_RESOURCES.into() } else { t.name.clone() }),
                    icon: tree_icon(t).unwrap_or_else(|| TREE_ICON.into()),
                    source: TreeSource::Stored,
                    groups: true,
                    menu: new_menu(&id),
                    toolbar,
                    id,
                }
            })
            .collect();
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
        self.node_memo(r, &mut NodeMemo::default())
    }

    /// `node_for` for many rows: what rows of one kind (and bound version) share is worked out
    /// once per batch (round 10: it asks the plugin's state, a few queries per node otherwise).
    pub(crate) fn node_memo(&self, r: &Row, memo: &mut NodeMemo) -> KResult<TreeNode> {
        let shared = memo
            .0
            .entry((r.kind.clone(), r.plugin_version.clone()))
            .or_insert_with(|| (self.row_meta(r), self.children_supplier(r).is_some(), self.dependent_actions(&r.kind)))
            .clone();
        let (meta, supplies, dependent) = shared;
        let (shown, shown_reason) = store::shown_state(r, meta.state, &meta.reason);
        let group = r.kind == KIND_GROUP;
        let has_children = supplies || self.read(|c| store::has_children(c, &r.id))?;
        let mut menu = Vec::new();
        // D473: a group opens too (its page holds its information).
        if meta.page.is_some() || crate::params::is_param_kind(&r.kind) || group {
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
        // D473: to another resource tree, when there is one.
        let several = match memo.1 {
            Some(v) => v,
            None => {
                let v = r.tree.as_deref() == Some(TREE_RESOURCES) && self.read(store::resource_trees)?.len() > 1;
                memo.1 = Some(v);
                v
            }
        };
        if r.tree.as_deref() == Some(TREE_RESOURCES) && several {
            menu.push(kernel_cmd("node.moveToTree", "folder-input"));
        }
        if self.read(|c| store::is_favorite(c, &r.id))? {
            menu.push(kernel_cmd("node.unfavorite", "star-off"));
        } else {
            menu.push(kernel_cmd("node.favorite", "star"));
        }
        menu.extend(meta.commands);
        // Review #6 (§7.3): actions of enabled dependents on this kind, after its own items.
        for (i, a) in dependent.into_iter().enumerate() {
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
        // D487 §21 (K9): a read-only copy takes nothing in; only its root moves; the root is marked with a lock.
        let copy = r.origin == crate::packages::ORIGIN_COPY;
        let copy_root = copy && r.origin_ref.as_deref() == Some(r.id.as_str());
        Ok(TreeNode {
            key: r.id.clone(),
            tree: r.tree.clone().unwrap_or_default(),
            parent_key: r.parent_id.clone(),
            label: r.name.clone(),
            icon: meta.icon,
            kind: r.kind.clone(),
            expandable: group || has_children,
            state: shown,
            state_reason: shown_reason,
            badge: copy_root.then(|| "🔒".to_string()),
            target: (!group).then(|| format!("resource:{}", r.id)),
            menu,
            draggable: meta.draggable && (!copy || copy_root),
            accepts: if copy { vec![] } else { meta.accepts },
            drop_any: (meta.drop_any && !copy).then_some(true),
        })
    }

    async fn tree_children(&self, p: TreeChildrenParams, client: Option<String>) -> KResult<TreePage> {
        let offset = p.offset.unwrap_or(0);
        if p.tree == store::TREE_FAVORITES || p.tree == store::TREE_DELETED {
            return self.list_tree_page(&p.tree, p.parent.as_deref(), offset);
        }
        if p.tree == store::TREE_PLUGINS || p.tree == store::TREE_RUNS {
            if p.tree == store::TREE_PLUGINS && p.parent.is_some() {
                return Ok(TreePage { nodes: vec![], next: None });
            }
            let (nodes, total) = if p.tree == store::TREE_PLUGINS {
                self.plugins_tree_page(valid_locale(p.locale.as_deref()), offset as usize, BATCH as usize)?
            } else {
                let all = self.runs_tree(p.parent.as_deref(), p.locale.as_deref())?;
                let total = all.len();
                (all.into_iter().skip(offset as usize).take(BATCH as usize).collect(), total)
            };
            let next = offset + BATCH;
            return Ok(TreePage { nodes, next: ((next as usize) < total).then_some(next) });
        }
        if let Some((pl, _)) = self.registry.tree(&p.tree) {
            if !self.plugin_enabled(&pl.id) {
                return Err(not_found("tree"));
            }
        }
        if self.stored_tree(&p.tree).is_ok() {
            // D375: under a resource whose kind supplies children, and under those nodes.
            if let Some(parent) = p.parent.as_deref() {
                let (rid, node) = match crate::kind_children::parse_child_key(parent) {
                    Some((rid, k)) => (rid, Some(k)),
                    None if parent.starts_with(crate::kind_children::FAILED_PREFIX) => {
                        return Ok(TreePage { nodes: vec![], next: None })
                    }
                    None => (parent, None),
                };
                let row = self.row_in_tree(&p.tree, rid)?;
                match self.children_supplier(&row) {
                    Some(pl) => {
                        return self.supplied_children(&p.tree, &row, pl, node, offset, p.locale.as_deref(), client).await;
                    }
                    // The plugin is off (or the kind does not supply): none of its nodes.
                    None if node.is_some() => return Ok(TreePage { nodes: vec![], next: None }),
                    None => {}
                }
            }
            // D473: a resource tree's view lists the tree's node's children (the default one: the top
            // level, without the trees' own nodes); its nodes carry the view's id.
            let view = self.resource_view(&p.tree);
            let (stored, parent) = match &view {
                Some(root) => (TREE_RESOURCES.to_string(), p.parent.clone().or(root.clone())),
                None => (p.tree.clone(), p.parent.clone()),
            };
            // (`store::children` never lists the trees' own nodes.)
            let rows = self.read(|c| store::children(c, &stored, parent.as_deref(), offset, BATCH + 1))?;
            let more = rows.len() > BATCH as usize;
            let mut memo = NodeMemo::default();
            let mut nodes = rows.iter().take(BATCH as usize).map(|r| self.node_memo(r, &mut memo)).collect::<KResult<Vec<_>>>()?;
            if let Some(root) = &view {
                for n in &mut nodes {
                    n.tree = p.tree.clone();
                    if n.parent_key.is_some() && n.parent_key == *root {
                        n.parent_key = None;
                    }
                }
            }
            return Ok(TreePage { next: more.then_some(offset + BATCH), nodes });
        }
        let (plugin, decl) = self.registry.tree(&p.tree).ok_or_else(|| not_found("tree"))?;
        let ctx = json!({ "tree": p.tree, "locale": valid_locale(p.locale.as_deref()) });
        let out = self
            .call_plugin(&plugin.id, "trees", &decl.id, "children", json!([ctx, p.parent, offset]), client)
            .await?;
        self.provided_page(plugin, &p.tree, p.parent.as_deref(), offset, decl.page.is_some(), out)
    }

    fn provided_page(&self, plugin: &Plugin, tree: &str, parent: Option<&str>, offset: u32, has_page: bool, out: Value) -> KResult<TreePage> {
        // Round 10: up to 1000 nodes are fine; they are handed out in our own batches.
        let page = crate::kind_children::parse_batch(plugin, out, offset, parent)?;
        let nodes = page
            .nodes
            .into_iter()
            .map(|n| {
                // A container without an explicit target has no page (§5: "absent for pure containers").
                let leaf = !n.expandable;
                let target = n.target.or_else(|| (has_page && leaf).then(|| node_target(tree, &n.key)));
                let mut menu = Vec::new();
                match &n.menu {
                    // Round 17 (D430): the plugin's own menu, checked; without one, "open" as before.
                    Some(ids) => {
                        for id in ids.iter().take(crate::kind_children::MAX_NODE_MENU) {
                            match self.provided_menu_cmd(plugin, id) {
                                Some(c) if !menu.iter().any(|m: &MenuCommand| m.id == c.id) => menu.push(c),
                                Some(_) => {}
                                None => self.plugin_warning(plugin, &format!("tree {tree}: menu command {id:?} is not one of its commands; dropped")),
                            }
                        }
                    }
                    None if target.is_some() => menu.push(kernel_cmd("node.open", "external-link")),
                    None => {}
                }
                let accepts: Vec<String> = n
                    .accepts
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|a| !a.is_empty() && a.len() <= 128)
                    .take(crate::kind_children::MAX_NODE_ACCEPTS)
                    .collect();
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
                    draggable: n.draggable.unwrap_or(false),
                    accepts,
                    drop_any: None,
                    key: n.key,
                }
            })
            .collect();
        Ok(TreePage { nodes, next: page.next })
    }

    /// Round 17 (D430): a provided node's menu entry: one of the plugin's own commands (short or
    /// full id), or one of the kernel's `node.*`. `None`: not allowed.
    fn provided_menu_cmd(&self, plugin: &Plugin, id: &str) -> Option<MenuCommand> {
        if crate::kind_children::NODE_COMMANDS.contains(&id) {
            return Some(kernel_cmd(id, "external-link"));
        }
        let short = match Registry::split(id) {
            Some((p, n)) if p == plugin.id => n,
            Some(_) => return None,
            None => id,
        };
        plugin.command(short).map(|_| self.plugin_menu_cmd(plugin, short))
    }

    /// Round 17 (D430): a warning about what a plugin returned (once per plugin and text).
    pub(crate) fn plugin_warning(&self, plugin: &Plugin, text: &str) {
        let key = format!("{}\n{text}", plugin.id);
        if self.warned.lock().unwrap().insert(key) {
            eprintln!("onedesk: plugin {}@{}: {text}", plugin.id, plugin.version);
        }
    }

    async fn tree_path(&self, p: TreeNodeParams, client: Option<String>) -> KResult<Vec<String>> {
        if p.tree == store::TREE_RUNS {
            let run = self.read(|conn| store::run_get(conn, &p.key))?;
            if let Some(run) = run {
                return Ok(vec![if run.kept { "@runs:saved" } else { "@runs:recent" }.into(), p.key]);
            }
            return Ok(vec![p.key]);
        }
        if [store::TREE_FAVORITES, store::TREE_DELETED, store::TREE_PLUGINS].contains(&p.tree.as_str()) {
            return Ok(vec![p.key]);
        }
        if self.stored_tree(&p.tree).is_ok() {
            // A plugin-supplied node: the path of its resource, then the node itself.
            let rid = crate::kind_children::parse_child_key(&p.key).map(|(rid, _)| rid).unwrap_or(&p.key);
            let r = self.row_in_tree(&p.tree, rid)?;
            if rid != p.key {
                let mut ids: Vec<String> = self.read(|c| store::ancestors(c, &r))?.into_iter().map(|a| a.id).collect();
                ids.push(r.id);
                ids.push(p.key);
                return Ok(ids);
            }
            // D473: a resource tree's own node is not part of the path in its view.
            let mut ids: Vec<String> = self.read(|c| store::ancestors(c, &r))?.into_iter().filter(|a| a.kind != store::KIND_TREE).map(|a| a.id).collect();
            ids.push(r.id);
            return Ok(ids);
        }
        let (plugin, decl) = self.registry.tree(&p.tree).ok_or_else(|| not_found("tree"))?;
        let ctx = json!({ "tree": p.tree, "locale": Value::Null });
        let out = self.call_plugin(&plugin.id, "trees", &decl.id, "path", json!([ctx, p.key]), client).await?;
        serde_json::from_value(out).map_err(|e| err_d(ErrorCode::PluginError, format!("bad path: {e}")))
    }

    async fn tree_move(&self, p: TreeMoveParams, client: Option<String>) -> KResult<TreeMoveResult> {
        self.stored_tree(&p.tree)?;
        let row = self.row_in_tree(&p.tree, &p.key)?;
        // Round 12 (D390): onto a node whose kind decides drops.
        if let (DropPosition::Inside, Some(t)) = (p.position, p.target.as_deref()) {
            if let Some(done) = self.plugin_drop(&p.tree, &row, t, p.locale.as_deref(), client).await? {
                return Ok(done);
            }
        }
        // D473: "inside the view" of a resource tree is inside its node (the default one: the top level).
        let root = self.resource_view(&p.tree).flatten();
        let dest = match (p.position, p.target) {
            (DropPosition::Inside, t) => MoveDest::Inside(t.or(root)),
            (DropPosition::Before, Some(t)) => MoveDest::Before(t),
            (DropPosition::After, Some(t)) => MoveDest::After(t),
            (_, None) => return Err(invalid_params("before/after need a target")),
        };
        // D487 §13 (K-c): a parent whose kind places what comes into it.
        let dest = match self.placed(&row.id, &row.kind, &row.name, dest).await? {
            Ok(d) => d,
            Err(message) => return Ok(TreeMoveResult { handled: Some(true), message: Some(message) }),
        };
        self.execute(Actor::User, Command::Move { id: row.id, dest }).await?;
        Ok(TreeMoveResult::default())
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
                let (shown, shown_reason) = store::shown_state(r, meta.state, &meta.reason);
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
                    state: shown,
                    state_reason: shown_reason,
                    badge: None,
                    target: (favorites && r.kind != KIND_GROUP).then(|| format!("resource:{}", r.id)),
                    menu,
                    draggable: false,
                    accepts: vec![],
                    drop_any: None,
                }
            })
            .collect();
        let next = offset + BATCH;
        Ok(TreePage { nodes, next: ((next as usize) < total).then_some(next) })
    }

    /// Creates a `core:group`; an empty name gets a default that does not clash with its siblings.
    pub async fn create_group(&self, tree: &str, parent: Option<String>, name: &str) -> KResult<String> {
        self.stored_tree(tree)?;
        // D473: in a resource tree's view, the top is the tree's node.
        let (tree, parent) = match self.resource_view(tree) {
            Some(root) => (TREE_RESOURCES, parent.or(root)),
            None => (tree, parent),
        };
        if tree == store::TREE_ENV || tree == store::TREE_CONFIG || tree == store::TREE_PROPOSALS || tree == store::TREE_CONTACTS {
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
        // D473: every resource tree offers what the `resources` tree does.
        let tree = tree.map(|t| if self.resource_view(t).is_some() { TREE_RESOURCES } else { t });
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
                // D356: not while a tree or page it borrows is not exported.
                if !self.kind_unmet(p, decl).is_empty() {
                    continue;
                }
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
        let mut guard = slot.sb.lock().await;
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
                kind_children: plugin.manifest.contributes.kinds.iter().filter(|k| k.children).map(|k| k.id.clone()).collect(),
                kind_drop: plugin.manifest.contributes.kinds.iter().filter(|k| k.drop).map(|k| k.id.clone()).collect(),
                kind_embed: plugin.manifest.contributes.kinds.iter().filter(|k| k.embed).map(|k| k.id.clone()).collect(),
                kind_place: plugin.manifest.contributes.kinds.iter().filter(|k| k.place).map(|k| k.id.clone()).collect(),
                events: plugin.manifest.contributes.events.iter().chain(&plugin.manifest.activation).cloned().collect(),
            },
            labels: plugin.all_labels(),
        };
        let host = Arc::new(crate::host::PluginHost { kernel: self.me.clone(), plugin });
        self.activations.fetch_add(1, Ordering::SeqCst);
        let sb = Arc::new(Sandbox::activate(pkg, host, self.cfg.sandbox.clone()).await.map_err(|e| e.to_protocol())?);
        *guard = Some(sb.clone());
        slot.touch();
        drop(guard);
        // D365: `PluginDetail.runtime` changed.
        self.emit(topic::PLUGINS, None, None);
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
        // D365: in flight from before activation until the call is over (never released meanwhile).
        let _busy = Busy::new(self.slot(p));
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
                let mut g = slot.sb.lock().await;
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
            *s.sb.lock().await = None;
        }
    }

    /// D365: whether the active version of `plugin` has a runtime now.
    pub fn runtime_live(&self, plugin: &str) -> bool {
        let Some(p) = self.registry.plugin(plugin) else { return false };
        let key = format!("{}@{}", p.id, p.version);
        let slot = self.slots.lock().unwrap().get(&key).cloned();
        slot.is_some_and(|s| s.sb.try_lock().map(|g| g.is_some()).unwrap_or(true))
    }

    /// D365: releases every runtime with nothing in flight for at least `plugin_idle`. Not a
    /// deactivation: no state change, no audit; only the `plugins` topic says `runtime` changed.
    pub async fn release_idle(&self) -> usize {
        let idle = self.cfg.plugin_idle;
        let slots: Vec<Slot> = self.slots.lock().unwrap().values().cloned().collect();
        let mut released = 0;
        for s in slots {
            let quiet = |s: &SlotState| {
                s.busy.load(Ordering::SeqCst) == 0 && s.last.lock().unwrap().is_none_or(|t| t.elapsed() >= idle)
            };
            if !quiet(&s) {
                continue;
            }
            // A slot being activated or used holds its lock: not idle.
            let Ok(mut g) = s.sb.try_lock() else { continue };
            if g.is_some() && quiet(&s) {
                *g = None;
                released += 1;
            }
        }
        if released > 0 {
            self.emit(topic::PLUGINS, None, None);
        }
        released
    }

    /// D290 / D299 / D343: enabled unless its state says `enabled = false`, it has a usable
    /// (installed, confirmed) active version, and its `depends` are met.
    pub fn plugin_enabled(&self, plugin: &str) -> bool {
        self.plugin_state(plugin).is_ok()
    }

    /// A parameter of the plugin's state node (`enabled`, `settings.<name>`).
    pub fn plugin_param(&self, plugin: &str, name: &str) -> Option<String> {
        self.plugin_state_row(plugin).and_then(|r| crate::params::get(&r, name)).map(|p| p.value)
    }

    /// The plugin's state row (from the start-up snapshot while there is one).
    pub fn plugin_state_row(&self, plugin: &str) -> Option<store::Row> {
        if let Some(m) = self.state_snapshot.lock().unwrap().as_ref() {
            return m.get(plugin).cloned();
        }
        self.state_queries.fetch_add(1, Ordering::Relaxed);
        self.read(|c| store::plugin_state(c, plugin)).ok().flatten()
    }

    /// Reads every plugin state row in one query into the start-up snapshot.
    pub(crate) fn take_state_snapshot(&self) {
        let rows = self.read(|c| store::of_kind(c, store::KIND_PLUGIN_STATE)).unwrap_or_default();
        let mut m = HashMap::new();
        for r in rows {
            m.entry(r.name.clone()).or_insert(r);
        }
        *self.state_snapshot.lock().unwrap() = Some(m);
    }
}

/// Review #7: a locale is at most 35 letters, digits and `-` (BCP 47 shape); anything else is
/// treated as not given.
pub fn valid_locale(l: Option<&str>) -> Option<&str> {
    l.filter(|l| !l.is_empty() && l.len() <= 35 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
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
            if crate::util::is_junk_name(&e.file_name()) {
                continue;
            }
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
    fn locales_are_checked() {
        assert_eq!(valid_locale(Some("zh-CN")), Some("zh-CN"));
        for bad in ["", "zh_CN", "a b", "../x", &"a".repeat(36)] {
            assert_eq!(valid_locale(Some(bad)), None, "{bad}");
        }
        assert_eq!(valid_locale(None), None);
    }

    #[test]
    fn package_reading_skips_appledouble_and_ds_store() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::create_dir_all(d.join("lib")).unwrap();
        std::fs::write(d.join("main.js"), "export default {};").unwrap();
        std::fs::write(d.join("lib/a.js"), "1").unwrap();
        // AppleDouble files are binary, `._x.js` has a `.js` extension.
        std::fs::write(d.join("._main.js"), [0u8, 5, 0x16, 7, 0xff, 0xfe]).unwrap();
        std::fs::write(d.join("lib/._a.js"), [0xffu8, 0xfe]).unwrap();
        std::fs::write(d.join(".DS_Store"), [0xffu8]).unwrap();
        std::fs::create_dir_all(d.join("._locales")).unwrap();
        std::fs::write(d.join("._locales/x.js"), [0xffu8]).unwrap();
        let files = read_js_files(d).unwrap();
        let mut names: Vec<_> = files.keys().cloned().collect();
        names.sort();
        assert_eq!(names, vec!["lib/a.js", "main.js"]);
    }

    #[test]
    fn url_encoding_round_trips() {
        for s in ["/a b/ç.txt", "x%y", "plain"] {
            assert_eq!(url_decode(&url_encode(s)).unwrap(), s);
        }
        assert!(!url_encode("/a/b").contains('/'));
    }
}
