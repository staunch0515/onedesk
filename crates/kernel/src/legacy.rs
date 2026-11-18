//! Round 13 (D398, D399): the first-version database.
//!
//! - `is_v1` / `convert`: a first-version `onedesk.db` (moved by the main process to
//!   `workspaces/default/workspace.db`) becomes the current structure in **one** transaction:
//!   the first-version tables are renamed aside, every migration runs, the rows are copied over,
//!   the old tables are dropped. Any failure rolls everything back; the file is left as it was.
//! - Claims (`legacyKinds`): resources whose kind is still a first-version short name are taken
//!   over by the enabled plugin that lists that name, through the kind's optional `upgrade`.
//!
//! Nothing here knows any particular plugin: short kinds are copied as they are, and only
//! plugins say which of them they take.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use onedesk_protocol::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::pipeline::{Actor, Command, NewResource, Outcome, Tx};
use crate::sandbox::{CallInfo, SandboxError};
use crate::store::{self, Row, KIND_CONFIG, KIND_GROUP, KIND_PLUGIN_STATE, TREE_CONFIG, TREE_PLUGIN_STATE, TREE_RESOURCES};
use crate::util::*;
use crate::workspace::MIGRATIONS;

/// `plugin_storage.version` of first-version storage rows until their plugin claims them
/// (first-version storage had no versions). Not a valid semver, so no plugin version has it.
pub const LEGACY_STORAGE_VERSION: &str = "legacy";
/// Audit names (round 13).
pub const AUDIT_UPGRADE: &str = "workspace.legacyUpgrade";
pub const AUDIT_CLAIM: &str = "plugin.legacyClaim";
pub const AUDIT_CLAIM_FAILED: &str = "plugin.legacyClaimFailed";
pub const AUDIT_INIT_SETTINGS: &str = "workspace.initSettings";
/// Plugin state parameter holding the last failed claim (JSON of `LegacyClaimFailure`).
pub const CLAIM_FAILURE: &str = "legacyClaimFailure";
/// The first-version kind name given to first-version collections.
pub const COLLECTION_KIND: &str = "collection";

/// The conversion failed: nothing was changed. `table` is the first-version table (or `schema`
/// when the current structure could not be created).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyError {
    pub table: String,
    pub detail: String,
}

impl LegacyError {
    fn new(table: &str, detail: impl std::fmt::Display) -> LegacyError {
        LegacyError { table: table.into(), detail: detail.to_string() }
    }

    /// `{code: legacyUpgradeFailed, params: {table}}`.
    pub fn to_protocol(&self) -> ProtocolError {
        err_p(ErrorCode::LegacyUpgradeFailed, &[("table", &self.table)])
    }

    /// The line the worker prints on stderr before it exits with `EXIT_LEGACY_FAILED`:
    /// `legacyUpgradeFailed {"table":"…"}`.
    pub fn line(&self) -> String {
        format!("legacyUpgradeFailed {}", json!({ "table": self.table }))
    }
}

impl std::fmt::Display for LegacyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (table {}: {})", self.line(), self.table, self.detail)
    }
}

/// Exit code of the worker when the first-version conversion failed.
pub const EXIT_LEGACY_FAILED: u8 = 4;

fn has_table(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)", [name], |r| r.get(0))
}

/// The first-version structure: a `schema_version` table, `collections`, `resources.group_name`,
/// and none of the kernel's migration records (`meta`).
pub fn is_v1(conn: &Connection) -> rusqlite::Result<bool> {
    if !has_table(conn, "schema_version")? || !has_table(conn, "collections")? || has_table(conn, "meta")? {
        return Ok(false);
    }
    let group: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('resources') WHERE name = 'group_name')",
        [],
        |r| r.get(0),
    )?;
    Ok(group)
}

/// Opens `dir/workspace.db` when it exists and converts it if it is a first-version database.
/// The worker calls this before it listens, so a failure is an exit code, not a broken
/// connection. Returns the audit summary when a conversion happened.
pub fn upgrade_folder(dir: &Path, builtin: &[String]) -> Result<Option<Value>, LegacyError> {
    let db = dir.join(crate::workspace::DB_FILE);
    if !db.exists() {
        return Ok(None);
    }
    let mut conn = Connection::open(&db).map_err(|e| LegacyError::new("schema", e))?;
    let v1 = is_v1(&conn).map_err(|e| LegacyError::new("schema", e))?;
    if !v1 {
        return Ok(None);
    }
    // D280: a copy before anything changes (the main process keeps its own `v1-onedesk.db`).
    if let Err(e) = crate::workspace::snapshot(dir, now_ms()) {
        eprintln!("onedesk: snapshot before the first-version upgrade failed: {e}");
    }
    convert(&mut conn, builtin).map(Some)
}

/// Milliseconds since the epoch of an ISO 8601 date-time (`YYYY-MM-DD[T ]HH:MM[:SS[.fff]]` with
/// `Z`, `±HH:MM`, `±HHMM` or nothing = UTC), or a plain number of milliseconds.
pub fn parse_time(s: &str) -> Option<i64> {
    let s = s.trim();
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
        return s.parse().ok();
    }
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = s.get(from..from + len)?;
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok()).flatten()
    };
    if b.len() < 16 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't' || b[10] == b' ') || b[13] != b':' {
        return None;
    }
    let (y, m, d, hh, mm) = (num(0, 4)?, num(5, 2)?, num(8, 2)?, num(11, 2)?, num(14, 2)?);
    let mut i = 16;
    let mut ss = 0;
    let mut ms = 0;
    if b.get(i) == Some(&b':') {
        ss = num(17, 2)?;
        i = 19;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            let mut end = start;
            while end < b.len() && b[end].is_ascii_digit() {
                end += 1;
            }
            if end == start {
                return None;
            }
            let frac = &s[start..end.min(start + 3)];
            ms = format!("{frac:0<3}").parse().ok()?;
            i = end;
        }
    }
    let offset_min: i64 = match &s[i..] {
        "" | "Z" | "z" => 0,
        rest => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = rest[1..].chars().filter(|c| *c != ':').collect();
            if digits.len() != 4 || !digits.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            sign * (digits[..2].parse::<i64>().ok()? * 60 + digits[2..].parse::<i64>().ok()?)
        }
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days since 1970-01-01 (H. Hinnant's days_from_civil).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hh * 3600 + mm * 60 + ss) - offset_min * 60) * 1000 + ms)
}

/// Path segments of a first-version `group_name` (`a / b/c` → `[a, b, c]`).
fn group_path(g: &str) -> Vec<String> {
    g.split('/').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
}

struct Writer<'a> {
    tx: &'a Transaction<'a>,
    at: i64,
    /// Next `pos` per parent (`None` = top level of the resource tree).
    pos: HashMap<Option<String>, i64>,
}

impl Writer<'_> {
    fn next_pos(&mut self, parent: &Option<String>) -> i64 {
        let p = self.pos.entry(parent.clone()).or_insert(0);
        *p += 1;
        *p - 1
    }

    /// Inserts a row with its first revision (actor `core`, op `create`).
    fn insert(&self, r: &Row) -> rusqlite::Result<()> {
        self.tx.execute(
            &format!(
                "INSERT INTO resources ({}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
                store::COLUMNS
            ),
            params![
                r.id,
                r.kind,
                r.plugin_version,
                r.tree,
                r.parent_id,
                r.pos,
                r.name,
                r.description,
                serde_json::to_string(&r.tags).expect("json"),
                serde_json::to_string(&r.body).expect("json"),
                r.origin,
                r.origin_ref,
                r.state,
                r.rev,
                r.created_at,
                r.created_by,
                r.updated_at,
                r.updated_by,
                r.deleted_at
            ],
        )?;
        self.tx.execute(
            "INSERT INTO revisions (resource_id, rev, at, actor, op, fields, snapshot) VALUES (?1, 1, ?2, 'core', 'create', '[\"*\"]', ?3)",
            params![r.id, self.at, serde_json::to_string(r).expect("json")],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn row(&mut self, id: String, kind: &str, tree: &str, parent: Option<String>, name: String, body: JsonMap, created: i64, updated: i64, by: &str) -> Row {
        let pos = self.next_pos(&parent);
        Row {
            id,
            kind: kind.into(),
            plugin_version: None,
            tree: Some(tree.into()),
            parent_id: parent,
            pos,
            name,
            description: String::new(),
            tags: vec![],
            body,
            origin: "original".into(),
            origin_ref: None,
            state: "ok".into(),
            rev: 1,
            created_at: created,
            created_by: by.into(),
            updated_at: updated,
            updated_by: by.into(),
            deleted_at: None,
        }
    }
}

fn text_param(value: &str) -> Value {
    json!({ "type": "text", "value": value })
}

/// A first-version setting value: plain text, or a JSON string.
fn setting_text(v: &str) -> String {
    match serde_json::from_str::<Value>(v) {
        Ok(Value::String(s)) => s,
        _ => v.to_string(),
    }
}

fn valid_language(v: &str) -> bool {
    let v = v.trim();
    !v.is_empty() && v.len() <= 35 && v.split('-').all(|p| !p.is_empty() && p.len() <= 8 && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// Converts a first-version database in one transaction. `builtin`: ids (or `id@version`) of the
/// built-in plugins — only their first-version "disabled" switch is carried over.
pub fn convert(conn: &mut Connection, builtin: &[String]) -> Result<Value, LegacyError> {
    let builtin: BTreeSet<&str> = builtin.iter().map(|b| b.split('@').next().unwrap_or_default()).collect();
    let tx = conn.transaction().map_err(|e| LegacyError::new("schema", e))?;
    let summary = convert_in(&tx, &builtin)?;
    tx.commit().map_err(|e| LegacyError::new("schema", e))?;
    Ok(summary)
}

fn convert_in(tx: &Transaction<'_>, builtin: &BTreeSet<&str>) -> Result<Value, LegacyError> {
    let schema = |e: rusqlite::Error| LegacyError::new("schema", e);
    // 1. Old tables whose names the current structure uses are renamed aside.
    for (old, aside) in [("resources", "v1_resources"), ("plugin_storage", "v1_plugin_storage"), ("secret_names", "v1_secret_names")] {
        if has_table(tx, old).map_err(schema)? {
            tx.execute_batch(&format!("ALTER TABLE {old} RENAME TO {aside}")).map_err(|e| LegacyError::new(old, e))?;
        }
    }
    // Their indexes keep their first-version names; drop them so nothing can clash later.
    for idx in ["idx_resources_kind", "idx_resources_group"] {
        tx.execute_batch(&format!("DROP INDEX IF EXISTS {idx}")).map_err(schema)?;
    }
    // 2. The current structure.
    for (_, sql) in MIGRATIONS {
        tx.execute_batch(sql).map_err(schema)?;
    }
    tx.execute("INSERT INTO meta (key, value) VALUES ('schema_version', ?1)", [MIGRATIONS.len().to_string()]).map_err(schema)?;

    let mut w = Writer { tx, at: now_ms(), pos: HashMap::new() };
    let mut counts: BTreeMap<&str, i64> = BTreeMap::new();

    // 3. Resources, under groups made from `group_name`.
    let res = |e: rusqlite::Error| LegacyError::new("resources", e);
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, String, String, String, String, String, String, String)> = if has_table(tx, "v1_resources").map_err(schema)? {
        let mut st = tx
            .prepare(
                "SELECT id, kind, name, group_name, tags, description, body, created_at, updated_at FROM v1_resources
                 ORDER BY group_name, name COLLATE NOCASE, id",
            )
            .map_err(res)?;
        let v = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)))
            .map_err(res)?
            .collect::<Result<_, _>>()
            .map_err(res)?;
        v
    } else {
        vec![]
    };
    // Groups first (each path once), so they come before resources in every level.
    let mut groups: BTreeMap<Vec<String>, String> = BTreeMap::new();
    for (_, _, _, g, ..) in &rows {
        let path = group_path(g);
        for n in 1..=path.len() {
            groups.entry(path[..n].to_vec()).or_default();
        }
    }
    let paths: Vec<Vec<String>> = groups.keys().cloned().collect();
    for path in paths {
        let parent = (path.len() > 1).then(|| groups[&path[..path.len() - 1]].clone());
        let id = new_id();
        let at = w.at;
        let row = w.row(id.clone(), KIND_GROUP, TREE_RESOURCES, parent, path.last().cloned().unwrap_or_default(), Default::default(), at, at, "core");
        w.insert(&row).map_err(res)?;
        groups.insert(path, id);
        *counts.entry("groups").or_default() += 1;
    }
    for (id, kind, name, g, tags, description, body, created, updated) in rows {
        let bad = |what: &str| LegacyError::new("resources", format!("{id}: {what}"));
        let tags: Vec<String> = serde_json::from_str(&tags).map_err(|_| bad("tags"))?;
        let body: JsonMap = match serde_json::from_str::<Value>(&body).map_err(|_| bad("body"))? {
            Value::Object(o) => o.into_iter().collect(),
            _ => return Err(bad("body")),
        };
        let created = parse_time(&created).ok_or_else(|| bad("created_at"))?;
        let updated = parse_time(&updated).ok_or_else(|| bad("updated_at"))?;
        let path = group_path(&g);
        let parent = (!path.is_empty()).then(|| groups[&path].clone());
        let mut row = w.row(id, &kind, TREE_RESOURCES, parent, name, body, created, updated, "user");
        row.tags = tags;
        row.description = description;
        w.insert(&row).map_err(res)?;
        *counts.entry("resources").or_default() += 1;
    }

    // 4. Collections → resources of the short kind `collection`, at the top level.
    let col = |e: rusqlite::Error| LegacyError::new("collections", e);
    let cols: Vec<(String, String, String, String, String)> = {
        let mut st = tx.prepare("SELECT id, name, rule_type, rule_value, created_at FROM collections ORDER BY name COLLATE NOCASE, id").map_err(col)?;
        let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(col)?.collect::<Result<_, _>>().map_err(col)?;
        v
    };
    for (id, name, rule_type, rule_value, created) in cols {
        let created = parse_time(&created).ok_or_else(|| LegacyError::new("collections", format!("{id}: created_at")))?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM resources WHERE id = ?1)", [&id], |r| r.get(0)).map_err(col)?;
        // A collection id equal to a resource id (two first-version tables): a new id.
        let id = if exists { new_id() } else { id };
        let body: JsonMap = [("ruleType".to_string(), json!(rule_type)), ("ruleValue".to_string(), json!(rule_value))].into_iter().collect();
        let row = w.row(id, COLLECTION_KIND, TREE_RESOURCES, None, name, body, created, created, "user");
        w.insert(&row).map_err(col)?;
        *counts.entry("collections").or_default() += 1;
    }

    // 5. Plugin storage (claimed into the plugin's version later), secret names.
    if has_table(tx, "v1_plugin_storage").map_err(schema)? {
        let n = tx
            .execute(
                "INSERT INTO plugin_storage (plugin, version, key, value) SELECT plugin_id, ?1, key, value FROM v1_plugin_storage",
                [LEGACY_STORAGE_VERSION],
            )
            .map_err(|e| LegacyError::new("plugin_storage", e))?;
        counts.insert("pluginStorage", n as i64);
    }
    if has_table(tx, "v1_secret_names").map_err(schema)? {
        let sec = |e: rusqlite::Error| LegacyError::new("secret_names", e);
        let names: Vec<(String, String)> = {
            let mut st = tx.prepare("SELECT name, created_at FROM v1_secret_names ORDER BY name").map_err(sec)?;
            let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(sec)?.collect::<Result<_, _>>().map_err(sec)?;
            v
        };
        for (name, created) in names {
            let at = parse_time(&created).ok_or_else(|| LegacyError::new("secret_names", format!("{name}: created_at")))?;
            tx.execute("INSERT INTO secret_names (name, updated_at) VALUES (?1, ?2)", params![name, at]).map_err(sec)?;
            *counts.entry("secretNames").or_default() += 1;
        }
    }

    // 6. A few settings → the workspace configuration node.
    let mut dropped: Vec<String> = Vec::new();
    let mut config = serde_json::Map::new();
    if has_table(tx, "app_settings").map_err(schema)? {
        let set = |e: rusqlite::Error| LegacyError::new("app_settings", e);
        let all: Vec<(String, String)> = {
            let mut st = tx.prepare("SELECT key, value FROM app_settings ORDER BY key").map_err(set)?;
            let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(set)?.collect::<Result<_, _>>().map_err(set)?;
            v
        };
        let mut language: Option<String> = None;
        for (key, value) in all {
            let v = setting_text(&value).trim().to_string();
            match key.as_str() {
                // `language` wins over `locale` when both are there.
                "language" | "locale" if valid_language(&v) && (key == "language" || language.is_none()) => language = Some(v),
                "theme" if ["system", "light", "dark"].contains(&v.as_str()) => {
                    config.insert("ui.theme".into(), text_param(&v));
                }
                _ => dropped.push(key),
            }
        }
        if let Some(l) = language {
            config.insert(crate::policy::UI_LANGUAGE.into(), text_param(&l));
        }
    }
    if !config.is_empty() {
        let at = w.at;
        let body: JsonMap = [(crate::params::PARAMS_KEY.to_string(), Value::Object(config.clone()))].into_iter().collect();
        let row = w.row(new_id(), KIND_CONFIG, TREE_CONFIG, None, "Workspace".into(), body, at, at, "core");
        w.insert(&row).map_err(|e| LegacyError::new("app_settings", e))?;
    }
    counts.insert("settings", config.len() as i64);

    // 7. Built-in plugins switched off in the first version stay off.
    let mut disabled: Vec<String> = Vec::new();
    if has_table(tx, "plugins").map_err(schema)? {
        let pl = |e: rusqlite::Error| LegacyError::new("plugins", e);
        let off: Vec<String> = {
            let mut st = tx.prepare("SELECT id FROM plugins WHERE enabled = 0 ORDER BY id").map_err(pl)?;
            let v = st.query_map([], |r| r.get(0)).map_err(pl)?.collect::<Result<_, _>>().map_err(pl)?;
            v
        };
        for id in off.into_iter().filter(|id| builtin.contains(id.as_str())) {
            let at = w.at;
            let body: JsonMap =
                [(crate::params::PARAMS_KEY.to_string(), json!({ "enabled": text_param("false") }))].into_iter().collect();
            let mut row = w.row(new_id(), KIND_PLUGIN_STATE, TREE_PLUGIN_STATE, None, id.clone(), body, at, at, "core");
            row.pos = 0;
            w.insert(&row).map_err(pl)?;
            disabled.push(id);
        }
    }
    counts.insert("disabledPlugins", disabled.len() as i64);

    // 8. The first-version tables go.
    for t in ["v1_resources", "collections", "plugins", "v1_plugin_storage", "app_settings", "v1_secret_names", "schema_version"] {
        tx.execute_batch(&format!("DROP TABLE IF EXISTS {t}")).map_err(|e| LegacyError::new(t, e))?;
    }
    let mut summary = json!(counts);
    summary["droppedSettings"] = json!(dropped);
    tx.execute(
        "INSERT INTO audit (at, actor, op, object, summary, result) VALUES (?1, 'core', ?2, '', ?3, 'ok')",
        params![w.at, AUDIT_UPGRADE, summary.to_string()],
    )
    .map_err(schema)?;
    Ok(summary)
}

/* ------------------------------------------------------------------ claims (D399) */

/// One resource a plugin takes over: expected kind and rev, the new body.
#[derive(Debug, Clone)]
pub struct ClaimItem {
    pub id: String,
    pub legacy_kind: String,
    pub rev: i64,
    pub body: JsonMap,
}

impl Tx<'_> {
    /// Rewrites every item to `<plugin>:<short>` bound to `version`, moves the plugin's
    /// first-version storage into `version`, clears the last claim failure. All or nothing.
    pub(crate) fn legacy_claim(&mut self, plugin: &str, version: &str, items: Vec<ClaimItem>) -> KResult<Outcome> {
        let sql = |e: rusqlite::Error| internal(e);
        let mut rows = Vec::new();
        let mut per_kind: BTreeMap<String, i64> = BTreeMap::new();
        for it in items {
            let mut row = store::get_any(self.tx, &it.id).map_err(sql)?.ok_or_else(|| not_found("resource"))?;
            if row.kind != it.legacy_kind || row.rev != it.rev {
                return Err(err_p(ErrorCode::Conflict, &[("reason", "changedDuringClaim"), ("resource", &it.id)]));
            }
            let mut changed: Vec<String> = vec!["kind".into(), "pluginVersion".into()];
            let keys: BTreeSet<&String> = row.body.keys().chain(it.body.keys()).collect();
            changed.extend(keys.into_iter().filter(|k| row.body.get(*k) != it.body.get(*k)).map(|k| format!("body.{k}")));
            row.kind = format!("{plugin}:{}", it.legacy_kind);
            row.plugin_version = Some(version.to_string());
            row.body = it.body;
            row.rev += 1;
            row.updated_at = self.at;
            row.updated_by = self.actor.as_text();
            self.tx.execute("UPDATE resources SET kind = ?2 WHERE id = ?1", params![row.id, row.kind]).map_err(sql)?;
            self.save(&row)?;
            self.refs_after(&row, None)?;
            self.revision(&row, "legacyClaim", &changed)?;
            *per_kind.entry(it.legacy_kind).or_default() += 1;
            rows.push(row);
        }
        // First-version storage: keys the version already has win.
        self.tx
            .execute(
                "UPDATE OR IGNORE plugin_storage SET version = ?2 WHERE plugin = ?1 AND version = ?3",
                params![plugin, version, LEGACY_STORAGE_VERSION],
            )
            .map_err(sql)?;
        let storage = self.tx.changes() as i64;
        self.tx
            .execute("DELETE FROM plugin_storage WHERE plugin = ?1 AND version = ?2", params![plugin, LEGACY_STORAGE_VERSION])
            .map_err(sql)?;
        let cleared = self.plugin_state_if_set(plugin, CLAIM_FAILURE)?;
        self.audit(AUDIT_CLAIM, plugin, &json!({ "count": rows.len(), "kinds": per_kind, "storageKeys": storage, "version": version }))?;
        let mut out = Outcome { id: None, changed: true, rows, ..Default::default() };
        out.rows.extend(cleared);
        Ok(out)
    }

    /// Removes one plugin state parameter when it is set (no new state row otherwise).
    fn plugin_state_if_set(&mut self, plugin: &str, name: &str) -> KResult<Option<Row>> {
        let set = store::plugin_state(self.tx, plugin).map_err(internal)?.is_some_and(|r| crate::params::get(&r, name).is_some());
        if !set {
            return Ok(None);
        }
        let out = self.plugin_state(plugin, &[(name.to_string(), None)])?;
        Ok(out.rows.into_iter().next())
    }

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
            if p.name.is_empty() || p.param_type == ParamType::Ref {
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

/// Short kinds still unclaimed in the workspace (`kind` without `:`), live or deleted.
fn unclaimed_kinds(conn: &Connection) -> rusqlite::Result<BTreeSet<String>> {
    let mut st = conn.prepare_cached("SELECT DISTINCT kind FROM resources WHERE instr(kind, ':') = 0")?;
    let v = st.query_map([], |r| r.get(0))?;
    v.collect()
}

fn has_legacy_storage(conn: &Connection, plugin: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM plugin_storage WHERE plugin = ?1 AND version = ?2)",
        params![plugin, LEGACY_STORAGE_VERSION],
        |r| r.get(0),
    )
}

impl Inner {
    /// Every enabled plugin takes the first-version resources its `legacyKinds` name (D399), in
    /// plugin id order; one batch per plugin. Cheap when nothing is left to claim.
    pub async fn claim_legacy_all(&self) {
        let _one = self.claim_lock.lock().await;
        let Ok(kinds) = self.read(unclaimed_kinds) else { return };
        let any_storage: bool = self
            .read(|c| c.query_row("SELECT EXISTS(SELECT 1 FROM plugin_storage WHERE version = ?1)", [LEGACY_STORAGE_VERSION], |r| r.get(0)))
            .unwrap_or(false);
        if kinds.is_empty() && !any_storage {
            return;
        }
        for id in self.registry.ids() {
            if !self.plugin_enabled(&id) {
                continue;
            }
            let Some(p) = self.registry.plugin(&id) else { continue };
            let mine: Vec<String> = p.manifest.legacy_kinds.iter().filter(|k| p.kind(k).is_some()).cloned().collect();
            let storage = self.read(|c| has_legacy_storage(c, &id)).unwrap_or(false);
            let wanted = mine.iter().any(|k| kinds.contains(k));
            if !wanted && !(storage && !mine.is_empty()) {
                continue;
            }
            self.claim_legacy(p, &mine).await;
        }
    }

    async fn claim_legacy(&self, p: &'static crate::manifest::Plugin, kinds: &[String]) {
        let mut rows: Vec<Row> = Vec::new();
        for k in kinds {
            let found = self.read(|c| {
                let mut st = c.prepare(&format!("SELECT {} FROM resources WHERE kind = ?1 ORDER BY id", store::COLUMNS))?;
                let v = st.query_map([k], store::from_sql)?;
                v.collect::<Result<Vec<_>, _>>()
            });
            match found {
                Ok(v) => rows.extend(v),
                Err(e) => {
                    eprintln!("onedesk: reading first-version resources of {} failed: {e:?}", p.id);
                    return;
                }
            }
        }
        // Another plugin may have taken them since the kinds were listed: nothing to write then.
        if rows.is_empty() && !self.read(|c| has_legacy_storage(c, &p.id)).unwrap_or(false) {
            return;
        }
        let items = match self.upgrade_rows(p, &rows).await {
            Ok(items) => items,
            Err((kind, resource, e)) => return self.claim_failed(p, kind, resource, e).await,
        };
        let cmd = Command::LegacyClaim { plugin: p.id.clone(), version: p.version.clone(), items };
        match self.execute(Actor::Core, cmd).await {
            Ok(_) => {
                self.emit(topic::PLUGINS, None, None);
                self.emit(format!("{}{}", topic::TREE, TREE_RESOURCES), None, None);
            }
            Err(e) => {
                let kind = rows.first().map(|r| r.kind.clone()).unwrap_or_default();
                let resource = e.params.get("resource").cloned();
                self.claim_failed(p, kind, resource, e).await
            }
        }
    }

    /// Runs each row's `upgrade` (pure, outside any transaction); any failure stops all.
    async fn upgrade_rows(&self, p: &'static crate::manifest::Plugin, rows: &[Row]) -> Result<Vec<ClaimItem>, (String, Option<String>, ProtocolError)> {
        let locale = self.configured_locale();
        let mut items = Vec::new();
        for r in rows {
            let fail = |e: ProtocolError| (r.kind.clone(), Some(r.id.clone()), e);
            let resource = self.resource(r).map_err(fail)?;
            let ctx = json!({ "resource": resource, "locale": locale });
            let arg = json!({ "body": r.body, "legacyKind": r.kind });
            let info = CallInfo { pure: true, ..Default::default() };
            let out = self.call_version(p, "kinds", &r.kind, "upgrade", json!([ctx, arg]), info, None, None).await.map_err(|e| {
                let mut pe = match e {
                    SandboxError::Host(pe) => pe,
                    other => other.to_protocol(),
                };
                pe.params.insert("reason".into(), "upgradeFailed".into());
                pe.params.insert("resource".into(), r.id.clone());
                pe.code = ErrorCode::PluginError;
                fail(pe)
            })?;
            let body = match out {
                Value::Null => r.body.clone(),
                Value::Object(mut o) => match o.remove("body") {
                    Some(Value::Object(b)) => b.into_iter().collect(),
                    _ => return Err(fail(err_p(ErrorCode::PluginError, &[("reason", "badUpgrade"), ("resource", &r.id)]))),
                },
                _ => return Err(fail(err_p(ErrorCode::PluginError, &[("reason", "badUpgrade"), ("resource", &r.id)]))),
            };
            items.push(ClaimItem { id: r.id.clone(), legacy_kind: r.kind.clone(), rev: r.rev, body });
        }
        Ok(items)
    }

    async fn claim_failed(&self, p: &'static crate::manifest::Plugin, kind: String, resource: Option<String>, e: ProtocolError) {
        let reason = e.params.get("reason").cloned().unwrap_or_else(|| serde_json::to_value(e.code).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default());
        eprintln!("onedesk: {} did not take its first-version resources: {e:?}", p.id);
        let _ = self
            .pipeline
            .execute(Actor::Core, Command::Refused { op: AUDIT_CLAIM_FAILED.into(), object: p.id.clone(), error: e })
            .await;
        let f = LegacyClaimFailure { legacy_kind: kind, resource, reason, at: now_ms() };
        let set = vec![(CLAIM_FAILURE.to_string(), Some(serde_json::to_string(&f).expect("json")))];
        let _ = self.execute(Actor::Core, Command::PluginState { plugin: p.id.clone(), set }).await;
        self.emit(topic::PLUGINS, None, None);
    }

    /// `PluginDetail.legacyClaimFailure`.
    pub fn legacy_claim_failure(&self, plugin: &str) -> Option<LegacyClaimFailure> {
        self.plugin_param(plugin, CLAIM_FAILURE).and_then(|v| serde_json::from_str(&v).ok())
    }

    /// The configured interface language (the workspace configuration), if any.
    fn configured_locale(&self) -> Option<String> {
        let rows = self.read(|c| store::of_kind(c, KIND_CONFIG)).unwrap_or_default();
        let mut best: Option<(usize, String)> = None;
        for r in rows {
            if let Some(p) = crate::params::get(&r, crate::policy::UI_LANGUAGE) {
                let depth = self.read(|c| store::ancestors(c, &r)).map(|a| a.len()).unwrap_or(0);
                if best.as_ref().is_none_or(|(d, _)| depth > *d) {
                    best = Some((depth, p.value));
                }
            }
        }
        best.map(|(_, v)| v).filter(|v| crate::manifest::valid_locale(v))
    }

    /* ---------------------------------------------------------------- settings snapshot (D400) */

    /// `workspace.settingsSnapshot`: only the main process asks (a request without `client`).
    pub fn settings_snapshot(&self, client: Option<&str>) -> KResult<WorkspaceSettingsSnapshot> {
        if client.is_some() {
            return Err(err_p(ErrorCode::Denied, &[("reason", "mainProcessOnly")]));
        }
        fn node(k: &Inner, r: &Row) -> KResult<SettingsSnapshotNode> {
            let params = crate::params::params_of(r)
                .into_iter()
                .filter(|(_, p)| p.ty != ParamType::Ref)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_first_version_times() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_time("1970-01-01T00:00:00.123Z"), Some(123));
        assert_eq!(parse_time("2025-11-15T09:46:40.000Z"), Some(1_763_200_000_000));
        assert_eq!(parse_time("2025-11-15 09:46:40"), Some(1_763_200_000_000));
        assert_eq!(parse_time("2025-11-15T18:46:40+09:00"), Some(1_763_200_000_000));
        assert_eq!(parse_time("2000-02-29T00:00:00.5Z"), Some(951_782_400_500));
        assert_eq!(parse_time("1763200000000"), Some(1_763_200_000_000));
        for bad in ["", "yesterday", "2025-13-01T00:00:00Z", "2025-11-15T09:46:40+9", "2025-11-15"] {
            assert_eq!(parse_time(bad), None, "{bad}");
        }
    }

    #[test]
    fn group_paths_split_on_slashes() {
        assert_eq!(group_path(" a / b//c "), vec!["a", "b", "c"]);
        assert!(group_path("").is_empty() && group_path(" / ").is_empty());
    }
}
