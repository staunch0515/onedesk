//! Round 13 (D400): what a new workspace copies from the current one — the configuration tree and
//! the plugin switches, no data. `workspace.settingsSnapshot` gives it to the main process, which
//! writes it as `init-settings.json` into the new folder; the kernel applies that file once.

use std::path::Path;

use onedesk_protocol::*;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::pipeline::{NewResource, Outcome, Tx};
use crate::store::{self, Row, KIND_CONFIG, KIND_PLUGIN_STATE, TREE_CONFIG};
use crate::util::*;

/// Review #8: references point at another workspace's resources and secret parameters name
/// secrets of another workspace's keychain entries; neither exists in the new one, so neither is
/// copied (left out of the snapshot, dropped when a file holds them).
fn copied(t: ParamType) -> bool {
    !matches!(t, ParamType::Ref | ParamType::Secret)
}

/// Audit name of applying `init-settings.json`.
pub const AUDIT_INIT_SETTINGS: &str = "workspace.initSettings";

impl Tx<'_> {
    /// Applies a `WorkspaceSettingsSnapshot` to a new workspace (D400): the first root takes the
    /// place of the default `Workspace` node, the rest are created; plugin switches are set.
    pub(crate) fn init_settings(&mut self, s: &WorkspaceSettingsSnapshot) -> KResult<Outcome> {
        let mut rows = Vec::new();
        let roots = store::children(self.tx, TREE_CONFIG, None, 0, u32::MAX).map_err(internal)?;
        let mut nodes = 0usize;
        for (i, node) in s.config.iter().enumerate() {
            let reuse = if i == 0 { roots.first().cloned() } else { None };
            nodes += self.init_node(node, None, reuse, &mut rows)?;
        }
        for p in &s.plugins {
            let value = (!p.enabled).then(|| "false".to_string());
            let out = self.plugin_state(&p.plugin, &[("enabled".to_string(), value)])?;
            rows.extend(out.rows);
        }
        self.audit(AUDIT_INIT_SETTINGS, "", &json!({ "configNodes": nodes, "plugins": s.plugins.len() }))?;
        Ok(Outcome { changed: true, rows, ..Default::default() })
    }

    fn init_node(&mut self, n: &SettingsSnapshotNode, parent: Option<String>, reuse: Option<Row>, rows: &mut Vec<Row>) -> KResult<usize> {
        let mut table = serde_json::Map::new();
        for p in &n.params {
            if p.name.is_empty() || !copied(p.param_type) {
                continue;
            }
            table.insert(p.name.clone(), json!({ "type": p.param_type, "value": p.value }));
        }
        let name = if n.name.trim().is_empty() { "Workspace".to_string() } else { n.name.clone() };
        let row = match reuse {
            Some(mut r) => {
                r.name = name;
                r.description = n.description.clone();
                r.body.insert(crate::params::PARAMS_KEY.into(), Value::Object(table));
                r.rev += 1;
                r.updated_at = self.at;
                r.updated_by = self.actor.as_text();
                self.save(&r)?;
                self.revision(&r, "update", &["*".to_string()])?;
                r
            }
            None => {
                let body: JsonMap = [(crate::params::PARAMS_KEY.to_string(), Value::Object(table))].into_iter().collect();
                let out = self.create(NewResource {
                    kind: KIND_CONFIG.into(),
                    tree: None,
                    parent,
                    name,
                    description: n.description.clone(),
                    tags: vec![],
                    body,
                    plugin_version: None,
                })?;
                out.rows.into_iter().next().ok_or_else(|| internal("no row"))?
            }
        };
        let id = row.id.clone();
        rows.push(row);
        let mut count = 1;
        for c in &n.children {
            count += self.init_node(c, Some(id.clone()), None, rows)?;
        }
        Ok(count)
    }
}

impl Inner {
    /// `workspace.settingsSnapshot`: only the main process asks (a request without `client`).
    pub fn settings_snapshot(&self, client: Option<&str>) -> KResult<WorkspaceSettingsSnapshot> {
        if client.is_some() {
            return Err(err_p(ErrorCode::Denied, &[("reason", "mainProcessOnly")]));
        }
        fn node(k: &Inner, r: &Row) -> KResult<SettingsSnapshotNode> {
            let params = crate::params::params_of(r)
                .into_iter()
                .filter(|(_, p)| copied(p.ty))
                .map(|(name, p)| SnapshotParam { name, param_type: p.ty, value: p.value })
                .collect();
            let kids = k.read(|c| store::children(c, TREE_CONFIG, Some(&r.id), 0, u32::MAX))?;
            Ok(SettingsSnapshotNode {
                name: r.name.clone(),
                description: r.description.clone(),
                params,
                children: kids.iter().map(|c| node(k, c)).collect::<KResult<_>>()?,
            })
        }
        let roots = self.read(|c| store::children(c, TREE_CONFIG, None, 0, u32::MAX))?;
        let config = roots.iter().map(|r| node(self, r)).collect::<KResult<_>>()?;
        let mut plugins: Vec<PluginEnabledState> = self
            .read(|c| store::of_kind(c, KIND_PLUGIN_STATE))?
            .into_iter()
            .map(|r| PluginEnabledState { enabled: crate::params::get(&r, "enabled").is_none_or(|p| p.value != "false"), plugin: r.name })
            .collect();
        plugins.sort_by(|a, b| a.plugin.cmp(&b.plugin));
        plugins.dedup_by(|a, b| a.plugin == b.plugin);
        Ok(WorkspaceSettingsSnapshot { config, plugins })
    }
}

/// Reads `init-settings.json` of a workspace folder whose database holds nothing a user made,
/// and deletes the file (applied or not: it is used at most once).
pub(crate) fn take_init_settings(dir: &Path, conn: &Connection) -> Option<WorkspaceSettingsSnapshot> {
    let file = dir.join(INIT_SETTINGS_FILE);
    let bytes = std::fs::read(&file).ok()?;
    let _ = std::fs::remove_file(&file);
    let made: Option<i64> = conn
        .query_row("SELECT count(*) FROM resources WHERE created_by <> 'core'", [], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    if made != Some(0) {
        eprintln!("onedesk: {} ignored: the workspace is not new", file.display());
        return None;
    }
    match serde_json::from_slice(&bytes) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("onedesk: {} ignored: {e}", file.display());
            None
        }
    }
}

