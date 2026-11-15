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

pub fn from_sql(r: &SqlRow<'_>) -> rusqlite::Result<Row> {
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
    conn.query_row(&format!("SELECT {COLUMNS} FROM resources WHERE id = ?1"), [id], from_sql).optional()
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
    let rows = st.query_map(params![tree, parent, limit, offset], from_sql)?;
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
    let mut st = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM resources WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY pos, id"
    ))?;
    while let Some(p) = queue.pop() {
        for r in st.query_map([&p], from_sql)? {
            let r = r?;
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
        for r in st.query_map([k], from_sql)? {
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
        from_sql,
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
        _ => path.strip_prefix("body.").map(|k| row.body.get(k).cloned().unwrap_or(Value::Null)),
    }
}
