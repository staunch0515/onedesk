//! Resource rows and read queries (kernel-design §3.3). Writes go through `pipeline`.

use onedesk_protocol::JsonMap;
use rusqlite::{params, Connection, OptionalExtension, Row as SqlRow};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Kernel's own kinds and trees (mechanisms, not features).
pub const KIND_GROUP: &str = "core:group";
pub const KIND_PLUGIN_STATE: &str = "core:plugin-state";
pub const TREE_RESOURCES: &str = "resources";
pub const TREE_PLUGIN_STATE: &str = "core:plugin-state";
pub const KIND_ENV: &str = "core:env";
pub const KIND_CONFIG: &str = "core:config";
pub const TREE_ENV: &str = "env";
pub const TREE_CONFIG: &str = "config";
/// Lists the kernel computes (D279); not stored trees.
pub const TREE_FAVORITES: &str = "favorites";
pub const TREE_DELETED: &str = "deleted";
/// Round 3 lists (D291): packages and their state; the latest runs.
pub const TREE_PLUGINS: &str = "plugins";
pub const TREE_RUNS: &str = "runs";
/// Node kinds of those lists (not resource kinds).
pub const KIND_PLUGIN: &str = "core:plugin";
pub const KIND_RUN: &str = "core:run";

/// Round 16 (§3.3 `state`): the source of the resource is gone (an indexed file was deleted).
pub const STATE_MISSING: &str = "missing";
pub const STATE_OK: &str = "ok";
/// `stateReason` of such a resource (a code; the shell has the text).
pub const REASON_SOURCE_MISSING: &str = "sourceMissing";

/// The state a row shows: its kind's, unless that is fine and the source is gone.
pub fn shown_state(
    r: &Row,
    state: onedesk_protocol::NodeState,
    reason: &Option<onedesk_protocol::Label>,
) -> (onedesk_protocol::NodeState, Option<onedesk_protocol::Label>) {
    if state == onedesk_protocol::NodeState::Ok && r.state == STATE_MISSING {
        (onedesk_protocol::NodeState::Broken, Some(onedesk_protocol::Label::Text(REASON_SOURCE_MISSING.into())))
    } else {
        (state, reason.clone())
    }
}

/// One `resources` row; serialized as the revision snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub kind: String,
    pub plugin_version: Option<String>,
    pub tree: Option<String>,
    pub parent_id: Option<String>,
    pub pos: i64,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub body: JsonMap,
    pub origin: String,
    pub origin_ref: Option<String>,
    pub state: String,
    pub rev: i64,
    pub created_at: i64,
    pub created_by: String,
    pub updated_at: i64,
    pub updated_by: String,
    pub deleted_at: Option<i64>,
}

pub const COLUMNS: &str = "id, kind, plugin_version, tree, parent_id, pos, name, description, tags, body, origin, \
     origin_ref, state, rev, created_at, created_by, updated_at, updated_by, deleted_at";

fn parse_json<T: for<'de> Deserialize<'de> + Default>(s: String) -> T {
    serde_json::from_str(&s).unwrap_or_default()
}

pub fn from_row(r: &SqlRow<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        kind: r.get(1)?,
        plugin_version: r.get(2)?,
        tree: r.get(3)?,
        parent_id: r.get(4)?,
        pos: r.get(5)?,
        name: r.get(6)?,
        description: r.get(7)?,
        tags: parse_json(r.get(8)?),
        body: parse_json(r.get(9)?),
        origin: r.get(10)?,
        origin_ref: r.get(11)?,
        state: r.get(12)?,
        rev: r.get(13)?,
        created_at: r.get(14)?,
        created_by: r.get(15)?,
        updated_at: r.get(16)?,
        updated_by: r.get(17)?,
        deleted_at: r.get(18)?,
    })
}

/// Including deleted rows.
pub fn get_any(conn: &Connection, id: &str) -> rusqlite::Result<Option<Row>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM resources WHERE id = ?1"), [id], from_row).optional()
}

/// Live (not deleted) rows only.
pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Row>> {
    Ok(get_any(conn, id)?.filter(|r| r.deleted_at.is_none()))
}

pub fn children(
    conn: &Connection,
    tree: &str,
    parent: Option<&str>,
    offset: u32,
    limit: u32,
) -> rusqlite::Result<Vec<Row>> {
    let mut st = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM resources WHERE tree = ?1 AND parent_id IS ?2 AND deleted_at IS NULL \
         ORDER BY pos, id LIMIT ?3 OFFSET ?4"
    ))?;
    let rows = st.query_map(params![tree, parent, limit, offset], from_row)?;
    rows.collect()
}

pub fn has_children(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM resources WHERE parent_id = ?1 AND deleted_at IS NULL)",
        [id],
        |r| r.get(0),
    )
}

/// Ancestors root first, not including `row` itself.
pub fn ancestors(conn: &Connection, row: &Row) -> rusqlite::Result<Vec<Row>> {
    let mut out = Vec::new();
    let mut next = row.parent_id.clone();
    while let Some(id) = next {
        match get_any(conn, &id)? {
            Some(p) if out.len() < 1000 => {
                next = p.parent_id.clone();
                out.push(p);
            }
            _ => break,
        }
    }
    out.reverse();
    Ok(out)
}

/// Live descendants of `id`, breadth first.
pub fn descendants(conn: &Connection, id: &str) -> rusqlite::Result<Vec<Row>> {
    let mut out = Vec::new();
    let mut queue = vec![id.to_string()];
    // Round 2 review #14: a cycle in a damaged database must not loop forever.
    let mut seen = std::collections::HashSet::from([id.to_string()]);
    let mut st = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM resources WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY pos, id"
    ))?;
    while let Some(p) = queue.pop() {
        for r in st.query_map([&p], from_row)? {
            let r = r?;
            if !seen.insert(r.id.clone()) {
                continue;
            }
            queue.push(r.id.clone());
            out.push(r);
        }
    }
    Ok(out)
}

pub fn list(conn: &Connection, kinds: &[String], parent: Option<Option<&str>>) -> rusqlite::Result<Vec<Row>> {
    let mut out = Vec::new();
    let mut st = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM resources WHERE kind = ?1 AND deleted_at IS NULL ORDER BY tree, parent_id, pos, id"
    ))?;
    for k in kinds {
        for r in st.query_map([k], from_row)? {
            let r = r?;
            if parent.is_none_or(|p| r.parent_id.as_deref() == p) {
                out.push(r);
            }
        }
    }
    Ok(out)
}

/// The single `core:plugin-state` node of a plugin, if any.
pub fn plugin_state(conn: &Connection, plugin: &str) -> rusqlite::Result<Option<Row>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM resources WHERE kind = ?1 AND name = ?2 AND deleted_at IS NULL"),
        params![KIND_PLUGIN_STATE, plugin],
        from_row,
    )
    .optional()
}

pub fn ui_get(conn: &Connection, client: &str, key: &str) -> rusqlite::Result<Option<Value>> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM ui_state WHERE client = ?1 AND key = ?2", params![client, key], |r| r.get(0))
        .optional()?;
    Ok(v.and_then(|s| serde_json::from_str(&s).ok()))
}

/// The value at a bind path (`name`, `description`, `tags`, `body.<key>`).
pub fn value_at(row: &Row, path: &str) -> Option<Value> {
    match path {
        "name" => Some(Value::String(row.name.clone())),
        "description" => Some(Value::String(row.description.clone())),
        "tags" => Some(serde_json::to_value(&row.tags).unwrap_or(Value::Null)),
        _ => {
            if let Some(n) = path.strip_prefix("params.") {
                return Some(crate::params::get(row, n).map(|p| Value::String(p.value)).unwrap_or(Value::Null));
            }
            path.strip_prefix("body.").map(|k| row.body.get(k).cloned().unwrap_or(Value::Null))
        }
    }
}

/// Whether the user marked it as a favorite (`resource_meta`, local data).
pub fn is_favorite(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row("SELECT favorite FROM resource_meta WHERE resource_id = ?1", [id], |r| r.get::<_, i64>(0))
        .optional()?
        .unwrap_or(0)
        != 0)
}

/// Live favorites, most recently used first.
pub fn favorites(conn: &Connection) -> rusqlite::Result<Vec<Row>> {
    let cols: String = COLUMNS.split(", ").map(|c| format!("r.{}", c.trim())).collect::<Vec<_>>().join(", ");
    let mut st = conn.prepare_cached(&format!(
        "SELECT {cols} FROM resources r JOIN resource_meta m ON m.resource_id = r.id
         WHERE m.favorite = 1 AND r.deleted_at IS NULL AND r.tree IS NOT ?1
         ORDER BY r.name COLLATE NOCASE, r.id"
    ))?;
    let rows = st.query_map([TREE_PLUGIN_STATE], from_row)?;
    rows.collect()
}

/// The top row of every deletion batch, newest first (D279, §3.4).
pub fn deleted_tops(conn: &Connection) -> rusqlite::Result<Vec<Row>> {
    let cols: String = COLUMNS.split(", ").map(|c| format!("r.{}", c.trim())).collect::<Vec<_>>().join(", ");
    let mut st = conn.prepare_cached(&format!(
        "SELECT {cols} FROM resources r
         WHERE r.deleted_at IS NOT NULL AND r.tree IS NOT ?1
           AND NOT EXISTS (SELECT 1 FROM resources p WHERE p.id = r.parent_id
                           AND p.delete_batch IS r.delete_batch AND p.deleted_at IS NOT NULL)
         ORDER BY r.deleted_at DESC, r.id"
    ))?;
    let rows = st.query_map([TREE_PLUGIN_STATE], from_row)?;
    rows.collect()
}

pub fn delete_batch(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT delete_batch FROM resources WHERE id = ?1", [id], |r| r.get(0)).optional().map(Option::flatten)
}

/// Every row of a deletion batch.
pub fn batch_rows(conn: &Connection, batch: &str) -> rusqlite::Result<Vec<Row>> {
    let mut st = conn.prepare_cached(&format!("SELECT {COLUMNS} FROM resources WHERE delete_batch = ?1 ORDER BY id"))?;
    let rows = st.query_map([batch], from_row)?;
    rows.collect()
}

/// Live rows of a kind.
pub fn of_kind(conn: &Connection, kind: &str) -> rusqlite::Result<Vec<Row>> {
    list(conn, &[kind.to_string()], None)
}

/* ------------------------------------------------------------------ runs (§8) */

/// One `runs` row; JSON columns are kept as values.
#[derive(Debug, Clone, Default)]
pub struct RunRow {
    pub id: String,
    pub seq: i64,
    pub title: String,
    pub icon: String,
    pub resource_id: Option<String>,
    pub resource_kind: Option<String>,
    pub plugin: String,
    pub action: String,
    pub action_label: Value,
    pub tab_id: Option<String>,
    pub env_id: Option<String>,
    pub env_name: Option<String>,
    pub actor: String,
    pub source: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: String,
    pub params: Value,
    pub input: Value,
    pub progress: Option<Value>,
    pub summary: Option<Value>,
    pub error: Option<Value>,
    pub output: Option<Value>,
    pub kept: bool,
    pub kept_name: Option<String>,
    pub in_task_panel: bool,
}

pub const RUN_COLUMNS: &str = "id, seq, title, icon, resource_id, resource_kind, plugin, action, action_label, tab_id, \
     env_id, env_name, actor, source, started_at, ended_at, status, params, input, progress, summary, error, output, \
     kept, kept_name, in_task_panel";

fn json_col(s: Option<String>) -> Option<Value> {
    s.and_then(|s| serde_json::from_str(&s).ok())
}

pub fn run_from_row(r: &SqlRow<'_>) -> rusqlite::Result<RunRow> {
    Ok(RunRow {
        id: r.get(0)?,
        seq: r.get(1)?,
        title: r.get(2)?,
        icon: r.get(3)?,
        resource_id: r.get(4)?,
        resource_kind: r.get(5)?,
        plugin: r.get(6)?,
        action: r.get(7)?,
        action_label: json_col(r.get(8)?).unwrap_or(Value::Null),
        tab_id: r.get(9)?,
        env_id: r.get(10)?,
        env_name: r.get(11)?,
        actor: r.get(12)?,
        source: r.get(13)?,
        started_at: r.get(14)?,
        ended_at: r.get(15)?,
        status: r.get(16)?,
        params: json_col(r.get(17)?).unwrap_or_else(|| Value::Object(Default::default())),
        input: json_col(r.get(18)?).unwrap_or_else(|| Value::Object(Default::default())),
        progress: json_col(r.get(19)?),
        summary: json_col(r.get(20)?),
        error: json_col(r.get(21)?),
        output: json_col(r.get(22)?),
        kept: r.get::<_, i64>(23)? != 0,
        kept_name: r.get(24)?,
        in_task_panel: r.get::<_, i64>(25)? != 0,
    })
}

pub fn run_get(conn: &Connection, id: &str) -> rusqlite::Result<Option<RunRow>> {
    conn.query_row(&format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"), [id], run_from_row).optional()
}

/// Runs matching `where_` (a fixed query condition with `?1`), newest first.
pub fn runs_where(conn: &Connection, where_: &str, arg: &str, limit: u32) -> rusqlite::Result<Vec<RunRow>> {
    let mut st = conn.prepare_cached(&format!(
        "SELECT {RUN_COLUMNS} FROM runs WHERE {where_} ORDER BY seq DESC LIMIT {limit}"
    ))?;
    let rows = st.query_map([arg], run_from_row)?;
    rows.collect()
}

pub fn storage_get(conn: &Connection, plugin: &str, version: &str, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM plugin_storage WHERE plugin = ?1 AND version = ?2 AND key = ?3",
        params![plugin, version, key],
        |r| r.get(0),
    )
    .optional()
}

pub fn storage_keys(conn: &Connection, plugin: &str, version: &str) -> rusqlite::Result<Vec<String>> {
    let mut st = conn.prepare_cached("SELECT key FROM plugin_storage WHERE plugin = ?1 AND version = ?2 ORDER BY key")?;
    let rows = st.query_map(params![plugin, version], |r| r.get(0))?;
    rows.collect()
}

/// The rows of the deletion batch `row` belongs to (live rows: none).
pub(crate) fn delete_batch_rows(k: &crate::kernel::Inner, row: &Row) -> crate::util::KResult<Vec<Row>> {
    match k.read(|c| delete_batch(c, &row.id))? {
        Some(b) => k.read(|c| batch_rows(c, &b)),
        None => Ok(vec![]),
    }
}
