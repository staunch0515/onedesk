//! Round 10 (D375, §7.2/§7.5): a kind that supplies its own children. The manifest declares
//! `"children": true` on the kind; the code answers `kinds.handle(kind, { children(ctx, node, offset) })`.
//! Under such a resource `tree.children` gives the stored children first, then the plugin's
//! nodes. Plugin node keys carry a kernel prefix (`@<resource id>/<plugin key>`), so they never
//! collide with resource ids (32 hex digits); a failed call shows one `load-failed` node
//! (`!<resource id>/<plugin key>`) instead of failing the whole answer.

use onedesk_protocol::*;
use serde_json::{json, Value};

use crate::kernel::{kernel_cmd, valid_locale, Inner, BATCH};
use crate::manifest::{Plugin, Registry};
use crate::sandbox::CallInfo;
use crate::store::{self, Row};
use crate::util::*;

/// Prefix of a plugin-supplied node key.
pub const CHILD_PREFIX: char = '@';
/// Prefix of the "failed to load" node's key.
pub const FAILED_PREFIX: char = '!';

/// `@<rid>/<plugin key>` → (rid, plugin key).
pub fn parse_child_key(key: &str) -> Option<(&str, &str)> {
    key.strip_prefix(CHILD_PREFIX)?.split_once('/').filter(|(rid, _)| !rid.is_empty())
}

impl Inner {
    /// The plugin version that supplies children for this resource: its kind declares
    /// `children`, the bound version runs normally, and the plugin is enabled.
    pub(crate) fn children_supplier(&self, r: &Row) -> Option<&'static Plugin> {
        let meta = self.row_meta(r);
        if meta.state != NodeState::Ok {
            return None;
        }
        let (p, k) = self.registry.kind_at(&r.kind, r.plugin_version.as_deref())?;
        (k.children && self.plugin_enabled(&p.id)).then_some(p)
    }

    /// One batch of children of a resource whose kind supplies them, or of one of the plugin's
    /// own nodes (`node` = its plugin key). `offset` counts the stored children first.
    pub(crate) async fn supplied_children(
        &self,
        tree: &str,
        row: &Row,
        plugin: &'static Plugin,
        node: Option<&str>,
        offset: u32,
        locale: Option<&str>,
        client: Option<String>,
    ) -> KResult<TreePage> {
        let stored = if node.is_none() { self.stored_child_count(tree, &row.id)? } else { 0 };
        if offset < stored {
            let rows = self.read(|c| store::children(c, tree, Some(&row.id), offset, BATCH))?;
            let nodes = rows.iter().map(|r| self.node_for(r)).collect::<KResult<Vec<_>>>()?;
            let end = offset + nodes.len() as u32;
            // The plugin's batches follow the stored ones.
            return Ok(TreePage { nodes, next: Some(end.max(offset + 1).min(stored)) });
        }
        let own = offset - stored;
        let short = Registry::split(&row.kind).map(|(_, k)| k.to_string()).unwrap_or_default();
        let resource = serde_json::to_value(self.resource(row)?).map_err(internal)?;
        let resource = crate::deps::without_secrets(resource, &self.secret_fields(&row.kind, row.plugin_version.as_deref()));
        let ctx = json!({ "tree": tree, "locale": valid_locale(locale), "resource": resource });
        let info = CallInfo { client, resource_id: Some(row.id.clone()), ..Default::default() };
        let parent_key = match node {
            Some(k) => format!("{CHILD_PREFIX}{}/{k}", row.id),
            None => row.id.clone(),
        };
        let out = self
            .call_version(plugin, "kinds", &short, "children", json!([ctx, node, own]), info, None, None)
            .await
            .map_err(|e| e.to_protocol())
            .and_then(|out| self.child_page(plugin, tree, row, &parent_key, own, out));
        match out {
            Ok(mut page) => {
                page.next = page.next.map(|n| n.saturating_add(stored));
                Ok(page)
            }
            Err(e) => {
                let mut n = blank_node(tree, &parent_key, format!("{FAILED_PREFIX}{}/{}", row.id, node.unwrap_or("")));
                n.state = NodeState::LoadFailed;
                n.icon = "triangle-alert".into();
                n.kind = row.kind.clone();
                // The error code; the shell puts its own words on the state.
                let code = serde_json::to_value(e.code).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
                n.state_reason = Some(Label::Text(code));
                Ok(TreePage { nodes: vec![n], next: None })
            }
        }
    }

    fn stored_child_count(&self, tree: &str, id: &str) -> KResult<u32> {
        self.read(|c| {
            c.query_row(
                "SELECT count(*) FROM resources WHERE tree = ?1 AND parent_id = ?2 AND deleted_at IS NULL",
                rusqlite::params![tree, id],
                |r| r.get::<_, u32>(0),
            )
        })
    }

    fn child_page(&self, plugin: &Plugin, tree: &str, row: &Row, parent_key: &str, offset: u32, out: Value) -> KResult<TreePage> {
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
        let out = if out.is_null() { json!({ "nodes": [] }) } else { out };
        let mut page: PPage = serde_json::from_value(out)
            .map_err(|e| err_d(ErrorCode::PluginError, format!("{}: bad children page: {e}", plugin.id)))?;
        // A larger batch is cut to ours; the rest is asked for again from where it was cut
        // (offsets are positions, as for provided trees).
        if page.nodes.len() > BATCH as usize {
            page.nodes.truncate(BATCH as usize);
            page.next = Some(offset + BATCH);
        }
        let nodes = page
            .nodes
            .into_iter()
            .map(|n| {
                let target = n.target.filter(|t| self.child_target_ok(plugin, row, t));
                let mut node = blank_node(tree, parent_key, format!("{CHILD_PREFIX}{}/{}", row.id, n.key));
                if target.is_some() {
                    node.menu.push(kernel_cmd("node.open", "external-link"));
                }
                node.kind = row.kind.clone();
                node.label = n.label;
                node.icon = n.icon;
                node.expandable = n.expandable;
                node.badge = n.badge;
                node.target = target;
                node
            })
            .collect();
        Ok(TreePage { nodes, next: page.next })
    }

    /// What a plugin node may open: what the plugin could open or read itself (§9.1 targets) —
    /// this resource, a resource it may read, one of its own runs, its own trees or plugin page.
    /// Anything else is dropped (the node is then not openable).
    fn child_target_ok(&self, plugin: &Plugin, row: &Row, target: &str) -> bool {
        use crate::pages::{parse_target, Target};
        if !crate::pages::is_target(target) {
            return false;
        }
        match parse_target(target) {
            Target::Resource(id) if id == row.id => true,
            Target::Resource(id) => match self.read(|c| store::get(c, &id)) {
                Ok(Some(r)) => {
                    Registry::split(&r.kind).is_some_and(|(p, _)| p == plugin.id) || self.export_allows(plugin, &r.kind, true)
                }
                _ => false,
            },
            Target::Run(id) => self
                .read(|c| {
                    use rusqlite::OptionalExtension;
                    c.query_row("SELECT plugin FROM runs WHERE id = ?1", [&id], |r| r.get::<_, String>(0)).optional()
                })
                .ok()
                .flatten()
                .is_some_and(|p| p == plugin.id),
            Target::Node { tree, .. } => self.registry.tree(&tree).is_some_and(|(p, _)| p.id == plugin.id),
            Target::Plugin(id) => id == plugin.id,
            _ => false,
        }
    }
}

fn blank_node(tree: &str, parent: &str, key: String) -> TreeNode {
    TreeNode {
        key,
        tree: tree.into(),
        parent_key: Some(parent.into()),
        label: String::new(),
        icon: String::new(),
        kind: String::new(),
        expandable: false,
        state: NodeState::Ok,
        state_reason: None,
        badge: None,
        target: None,
        menu: vec![],
        draggable: false,
        accepts: vec![],
    }
}
