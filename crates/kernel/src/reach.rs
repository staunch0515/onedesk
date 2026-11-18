//! Round 12 (D389, D390; §7.2, §7.5): what a plugin may know of resources that are not its own,
//! and drops onto nodes whose kind decides.
//! - `host.resources.search`: the basic information of every resource (`ResourceInfo`: never the
//!   body or the description) for plugins that declare `requires.resources` (`resourcesAll`).
//! - A kind declaring `drop`: dropping a resource node *onto* its node calls the code instead of
//!   moving, unless the ordinary rules (`accepts`) take the resource anyway.
//!
//! The kernel knows no particular plugin here: it only answers queries and hands drops over.

use std::collections::HashMap;

use onedesk_protocol::*;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::kernel::{valid_locale, Inner, KindMeta};
use crate::manifest::{Plugin, Registry};
use crate::pipeline::Command;
use crate::sandbox::CallInfo;
use crate::store::{self, Row, TREE_RESOURCES};
use crate::util::*;

/// `limit` when none is given, and its upper bound.
pub const SEARCH_DEFAULT_LIMIT: u32 = 200;
pub const SEARCH_MAX_LIMIT: u32 = 500;
/// Most `ids`, `kinds` and `tags` one search may name.
pub const SEARCH_MAX_IDS: usize = 1000;
pub const SEARCH_MAX_KINDS: usize = 200;
pub const SEARCH_MAX_TAGS: usize = 50;
/// Longest `text`, in characters.
pub const SEARCH_MAX_TEXT: usize = 500;

/// The argument of `resources.search`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchOpts {
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

/// What a kind's `drop` answers.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DropAnswer {
    handled: bool,
    #[serde(default)]
    message: Option<Label>,
}

/// Most row actions on one table (D393), and the longest `context.row`.
pub const MAX_ROW_ACTIONS: usize = 4;
pub const MAX_ROW_KEY: usize = 1000;

impl Inner {
    /// D395: the stored trees the user sees resources in — the kernel's resource tree and the
    /// plugins' stored trees (not environments, configuration or plugin state).
    pub(crate) fn stored_tree_ids(&self) -> Vec<String> {
        let mut out = vec![TREE_RESOURCES.to_string()];
        for p in &self.registry.plugins() {
            for t in &p.manifest.contributes.trees {
                if t.source == TreeSource::Stored {
                    out.push(p.full(&t.id));
                }
            }
        }
        out
    }

    pub(crate) fn in_stored_tree(&self, r: &Row) -> bool {
        match r.tree.as_deref() {
            Some(TREE_RESOURCES) => true,
            Some(t) => self.registry.tree(t).is_some_and(|(_, d)| d.source == TreeSource::Stored),
            None => false,
        }
    }

    /// D393: checks the tables of a view a plugin drew: `rowTargets` and `rowKeys` as long as
    /// `rows`, at most `MAX_ROW_ACTIONS` row actions (else `pluginError/badOutput`); row targets
    /// the plugin may not open become `null` (same rule as its children's targets).
    pub(crate) fn check_tables(&self, plugin: &Plugin, own: Option<&str>, view: &mut [ViewNode]) -> KResult<()> {
        let bad = |what: &str| {
            let mut e = err_p(ErrorCode::PluginError, &[("reason", "badOutput"), ("plugin", &plugin.id)]);
            e.detail = Some(format!("table: {what}"));
            e
        };
        for node in view.iter_mut() {
            let ViewNode::Table { id, rows, row_targets, row_actions, row_keys, .. } = node else { continue };
            if row_targets.as_ref().is_some_and(|t| t.len() != rows.len()) {
                return Err(bad(&format!("{id}: rowTargets and rows differ in length")));
            }
            if row_keys.as_ref().is_some_and(|k| k.len() != rows.len()) {
                return Err(bad(&format!("{id}: rowKeys and rows differ in length")));
            }
            if let Some(a) = row_actions {
                if a.len() > MAX_ROW_ACTIONS {
                    return Err(bad(&format!("{id}: more than {MAX_ROW_ACTIONS} row actions")));
                }
                if a.iter().any(|x| x.id.is_empty()) {
                    return Err(bad(&format!("{id}: row action without id")));
                }
            }
            if let Some(ts) = row_targets {
                for t in ts.iter_mut() {
                    if t.as_deref().is_some_and(|x| !self.plugin_target_ok(plugin, own, x)) {
                        *t = None;
                    }
                }
            }
        }
        Ok(())
    }

    /// `ResourceInfo` of a row; `memo` keeps one kind's meta per batch.
    pub(crate) fn resource_info(&self, r: &Row, memo: &mut HashMap<(String, Option<String>), KindMeta>) -> ResourceInfo {
        let meta = memo.entry((r.kind.clone(), r.plugin_version.clone())).or_insert_with(|| self.row_meta(r));
        ResourceInfo {
            id: r.id.clone(),
            name: r.name.clone(),
            kind: r.kind.clone(),
            kind_label: Some(meta.label.clone()),
            icon: meta.icon.clone(),
            tree: r.tree.clone().unwrap_or_default(),
            parent: r.parent_id.clone(),
            tags: r.tags.clone(),
            deleted: r.deleted_at.is_some(),
        }
    }

    /// `host.resources.search(opts)` (D389).
    pub(crate) fn resources_search(&self, plugin: &Plugin, opts: Value) -> KResult<Value> {
        if !plugin.manifest.requires.resources {
            return Err(denied("notRequested"));
        }
        let opts: SearchOpts = if opts.is_null() {
            SearchOpts::default()
        } else {
            serde_json::from_value(opts).map_err(|e| invalid_params(format!("search: {e}")))?
        };
        let out = self.search_basic(&opts)?;
        serde_json::to_value(out).map_err(internal)
    }

    pub(crate) fn search_basic(&self, o: &SearchOpts) -> KResult<ResourceSearchResult> {
        let kinds = o.kinds.as_ref().filter(|k| !k.is_empty());
        let tags = o.tags.as_ref().filter(|t| !t.is_empty());
        let text = o.text.as_deref().map(str::trim).filter(|t| !t.is_empty());
        if kinds.is_some_and(|k| k.len() > SEARCH_MAX_KINDS)
            || tags.is_some_and(|t| t.len() > SEARCH_MAX_TAGS)
            || o.ids.as_ref().is_some_and(|i| i.len() > SEARCH_MAX_IDS)
            || text.is_some_and(|t| t.chars().count() > SEARCH_MAX_TEXT)
        {
            return Err(invalid_params("search: too many conditions"));
        }
        let limit = o.limit.unwrap_or(SEARCH_DEFAULT_LIMIT).clamp(1, SEARCH_MAX_LIMIT);
        let offset = o.offset.unwrap_or(0);

        // D395: only what the user sees in a stored tree (not environments, configuration,
        // plugin state, or resources without a tree).
        let mut args: Vec<String> = vec![serde_json::to_string(&self.stored_tree_ids()).map_err(internal)?];
        let mut wheres = vec!["r.tree IN (SELECT value FROM json_each(?1))".to_string()];
        let push = |args: &mut Vec<String>, v: String| {
            args.push(v);
            args.len()
        };
        let mut order = "r.tree, r.name COLLATE NOCASE, r.id".to_string();
        match &o.ids {
            // By id: in the given order; deleted ones too (marked), never-existing ones not at all.
            Some(ids) => {
                let i = push(&mut args, serde_json::to_string(ids).map_err(internal)?);
                wheres.push(format!("r.id IN (SELECT value FROM json_each(?{i}))"));
                order = format!("(SELECT min(key) FROM json_each(?{i}) WHERE value = r.id)");
            }
            None => wheres.push("r.deleted_at IS NULL".into()),
        }
        if let Some(k) = kinds {
            let i = push(&mut args, serde_json::to_string(k).map_err(internal)?);
            wheres.push(format!("r.kind IN (SELECT value FROM json_each(?{i}))"));
        }
        if let Some(t) = tags {
            for tag in t {
                let i = push(&mut args, tag.clone());
                wheres.push(format!("EXISTS (SELECT 1 FROM json_each(r.tags) WHERE value = ?{i})"));
            }
        }
        let mut join = "";
        if let Some(text) = text {
            // The kernel's full-text search (name, description, tags, body): long words through the
            // index, short ones (two-character Chinese words) by substring — as `search.query`.
            join = "JOIN search s ON s.rowid = r.rowid";
            let mut long = Vec::new();
            for t in text.split_whitespace().map(str::to_lowercase) {
                if t.chars().count() >= 3 {
                    long.push(format!("\"{}\"", t.replace('"', "\"\"")));
                } else {
                    let like = format!("%{}%", t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
                    let i = push(&mut args, like);
                    wheres.push(format!("(lower(s.name) LIKE ?{i} ESCAPE '\\' OR lower(s.text) LIKE ?{i} ESCAPE '\\')"));
                }
            }
            if !long.is_empty() {
                let i = push(&mut args, long.join(" AND "));
                wheres.push(format!("search MATCH ?{i}"));
            }
        }
        let from = format!("FROM resources r {join} WHERE {}", wheres.join(" AND "));
        let total: u32 = self.read(|c| {
            c.query_row(&format!("SELECT count(*) {from}"), rusqlite::params_from_iter(args.iter()), |r| r.get(0))
        })?;
        let cols = store::COLUMNS.split(", ").map(|c| format!("r.{c}")).collect::<Vec<_>>().join(", ");
        let stmt_text = format!("SELECT {cols} {from} ORDER BY {order} LIMIT {limit} OFFSET {offset}");
        let rows: Vec<Row> = self.read(|c| {
            let mut st = c.prepare(&stmt_text)?;
            let rows = st.query_map(rusqlite::params_from_iter(args.iter()), store::from_row)?;
            rows.collect()
        })?;
        let mut memo = HashMap::new();
        let items: Vec<ResourceInfo> = rows.iter().map(|r| self.resource_info(r, &mut memo)).collect();
        let end = offset.saturating_add(items.len() as u32);
        let next = (!items.is_empty() && end < total).then_some(end);
        Ok(ResourceSearchResult { items, total, next })
    }

    /// A drop of `row` onto `target` (both in `tree`): when the target's kind decides drops and the
    /// ordinary rules would not take the resource, its plugin's `drop` is called. `None`: go on with
    /// the ordinary move. Errors and timeouts of the handler fail the whole operation
    /// (`pluginError`); nothing is moved then.
    pub(crate) async fn plugin_drop(
        &self,
        tree: &str,
        row: &Row,
        target: &str,
        locale: Option<&str>,
        client: Option<String>,
    ) -> KResult<Option<TreeMoveResult>> {
        let Some(t) = self.read(|c| store::get(c, target))? else { return Ok(None) };
        if t.id == row.id || t.tree.as_deref() != Some(tree) {
            return Ok(None);
        }
        let meta = self.row_meta(&t);
        let Some(plugin) = meta.plugin.filter(|_| meta.drop_any && meta.state == NodeState::Ok) else { return Ok(None) };
        // The ordinary rules first: what the kind accepts anyway is moved, the plugin is not asked.
        let accepted = self
            .rules
            .read()
            .unwrap()
            .get(&t.kind)
            .is_some_and(|r| r.accepts.iter().any(|a| a == "*" || *a == row.kind));
        if accepted {
            return Ok(None);
        }
        let short = Registry::split(&t.kind).map(|(_, k)| k.to_string()).unwrap_or_default();
        let resource = serde_json::to_value(self.resource(&t)?).map_err(internal)?;
        let resource = crate::deps::without_secrets(resource, &self.secret_fields(&t.kind, t.plugin_version.as_deref()));
        let ctx = json!({ "tree": tree, "locale": valid_locale(locale), "resource": resource });
        let sources = vec![self.resource_info(row, &mut HashMap::new())];
        let ev = json!({ "sources": sources });
        let writes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let info = CallInfo { client, resource_id: Some(t.id.clone()), drop_writes: Some(writes.clone()), ..Default::default() };
        let as_plugin_error = |e: ProtocolError| ProtocolError { code: ErrorCode::PluginError, params: e.params, detail: e.detail };
        let out = self
            .call_version(plugin, "kinds", &short, "drop", json!([ctx, ev]), info, None, None)
            .await
            .map_err(|e| as_plugin_error(e.to_protocol()))?;
        let answer: DropAnswer = if out.is_null() {
            DropAnswer { handled: false, message: None }
        } else {
            serde_json::from_value(out).map_err(|e| {
                let mut pe = err_p(ErrorCode::PluginError, &[("reason", "badDropAnswer")]);
                pe.detail = Some(format!("{}: {e}", plugin.id));
                pe
            })?
        };
        if !answer.handled {
            return Ok(None);
        }
        // D394: the plugin's updates and the audit row in one transaction; on any failure above
        // (error, timeout, bad answer, not handled) the kept updates are simply dropped.
        let mut cmds = std::mem::take(&mut *writes.lock().unwrap());
        cmds.push(Command::Audit { op: "tree.drop".into(), object: t.id.clone(), summary: json!({ "sources": sources.len() }) });
        self.execute(plugin.actor(), Command::Batch(cmds)).await?;
        Ok(Some(TreeMoveResult { handled: Some(true), message: answer.message }))
    }
}
