//! The kernel: one workspace, its plugins, and the protocol methods of week 1
//! (`docs/handoff/week1-protocol.md` §3). Requests arrive as `(client, method, params)`;
//! everything that writes goes through the pipeline; events go out on a broadcast channel.

use std::collections::HashMap;
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

#[derive(Debug, Clone, Default)]
pub struct KernelConfig {
    pub sandbox: SandboxConfig,
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
}

impl Kernel {
    /// Opens (or creates) the workspace in `workspace_dir` and reads the plugins under `plugins_dir`.
    /// The caller holds the workspace lock.
    pub fn open(workspace_dir: &Path, plugins_dir: &Path, cfg: KernelConfig) -> Result<Kernel, String> {
        let (ws, conn) = Workspace::open(workspace_dir)?;
        let reader = ws.open_reader()?;
        let registry = Registry::scan(plugins_dir);
        for r in &registry.rejected {
            eprintln!("onedesk: plugin package {} not loaded: {} ({})", r.path.display(), r.reason, r.detail);
        }
        let pipeline = Pipeline::start(conn, Arc::new(registry.rules()));
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
        });
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
        let mut out: Vec<String> =
            slots.into_iter().filter(|(_, s)| s.try_lock().map(|g| g.is_some()).unwrap_or(true)).map(|(k, _)| k).collect();
        out.sort();
        out
    }

    /// How many times any plugin runtime was created.
    pub fn activation_count(&self) -> u64 {
        self.inner.activations.load(Ordering::SeqCst)
    }

    pub fn rejected_plugins(&self) -> Vec<crate::manifest::Rejection> {
        self.inner.registry.rejected.clone()
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
        let plugin_state = matches!(&cmd, Command::Update { .. } | Command::Create(_) | Command::Grant { .. });
        let deletion = matches!(&cmd, Command::Delete { .. } | Command::Undelete { .. } | Command::Purge { .. });
        let audited = !matches!(&cmd, Command::Meta { .. } | Command::UiSet { .. });
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
        if out.changed && audited {
            self.emit(onedesk_protocol::topic2::AUDIT, None, None);
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
            _ => match self.handle2(client, m, params).await {
                Some(r) => r,
                None => Err(err_p(ErrorCode::UnknownMethod, &[("method", m)])),
            },
        }
    }

    fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo { id: self.ws.id.clone(), name: self.ws.name.clone() }
    }

    /* ---------------------------------------------------------------- kinds and rows */

    pub fn kind_meta(&self, kind: &str) -> KindMeta {
        if crate::params::is_param_kind(kind) {
            return KindMeta {
                label: Label::Text(kind.into()),
                icon: if kind == store::KIND_ENV { "globe" } else { "settings" }.into(),
                page: None,
                draggable: true,
                accepts: vec![kind.into()],
                commands: vec![],
                state: NodeState::Ok,
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
            };
        }
        match self.registry.kind(kind) {
            Some((p, k)) => KindMeta {
                label: p.label(&k.label),
                icon: k.icon.clone(),
                page: k.page.clone().map(|pg| (p.id.clone(), pg)),
                draggable: k.draggable,
                accepts: k.accepts.iter().map(|a| p.kind_ref(a)).collect(),
                commands: k.menu.iter().map(|c| self.plugin_menu_cmd(p, c)).collect(),
                state: NodeState::Ok,
            },
            None => KindMeta {
                label: Label::Text(kind.into()),
                icon: "puzzle".into(),
                page: None,
                draggable: true,
                accepts: vec![],
                commands: vec![],
                state: NodeState::MissingPlugin,
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
        let meta = self.kind_meta(&r.kind);
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
            state_reason: None,
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
        for p in &self.registry.plugins {
            for t in &p.manifest.contributes.trees {
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
        let meta = self.kind_meta(&r.kind);
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
            state_reason: None,
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
        if p.tree == store::TREE_FAVORITES || p.tree == store::TREE_DELETED {
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
                let meta = self.kind_meta(&r.kind);
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
                    state_reason: None,
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
        for p in &self.registry.plugins {
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

    fn slot(&self, plugin: &str) -> Slot {
        self.slots.lock().unwrap().entry(plugin.to_string()).or_default().clone()
    }

    async fn sandbox(&self, plugin: &Plugin) -> KResult<Arc<Sandbox>> {
        let slot = self.slot(&plugin.id);
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
            },
            labels: plugin.all_labels(),
        };
        let host = Arc::new(crate::host::PluginHost { kernel: self.me.clone(), plugin: plugin.id.clone() });
        self.activations.fetch_add(1, Ordering::SeqCst);
        let sb = Arc::new(Sandbox::activate(pkg, host, self.cfg.sandbox.clone()).await.map_err(|e| e.to_protocol())?);
        *guard = Some(sb.clone());
        Ok(sb)
    }

    /// Calls a plugin handler; activates the plugin first if needed; discards a poisoned runtime.
    pub async fn call_plugin(
        &self,
        plugin: &str,
        kind: &str,
        name: &str,
        func: &str,
        args: Value,
        client: Option<String>,
    ) -> KResult<Value> {
        let p = self.registry.plugin(plugin).ok_or_else(|| err_p(ErrorCode::PluginError, &[("reason", "notLoaded")]))?;
        let sb = self.sandbox(p).await?;
        // Plugin code is polled on the runtime's worker threads, never on the connection reader.
        let call = {
            let sb = sb.clone();
            let (kind, name, func) = (kind.to_string(), name.to_string(), func.to_string());
            tokio::spawn(async move { sb.call(&kind, &name, &func, &args, CallInfo { client }, None).await })
        };
        let res = call.await.unwrap_or_else(|e| Err(SandboxError::Engine(e.to_string())));
        match res {
            Ok(v) => Ok(v),
            Err(e) => {
                if e.poisons() {
                    let slot = self.slot(plugin);
                    let mut g = slot.lock().await;
                    if g.as_ref().is_some_and(|cur| Arc::ptr_eq(cur, &sb)) {
                        *g = None;
                    }
                }
                Err(e.to_protocol())
            }
        }
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
