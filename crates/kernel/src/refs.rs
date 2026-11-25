//! References between resources (kernel-design §10, D321–D323).
//!
//! Two kinds of declared fields hold references: text fields with `"refs": true` (every
//! `[[name]]` in them) and single-reference fields (`{ "type": "ref" }`, stored `{ "ref": id }`).
//! The `refs` table is derived from them in the same transaction as the write; the text itself is
//! never rewritten (D321) — readers get the targets' current names substituted.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::pipeline::KindRule;
use crate::store::{self, Row, KIND_CONFIG, KIND_ENV, KIND_GROUP, KIND_PLUGIN_STATE, TREE_PLUGIN_STATE};

/// Longest name between `[[` and `]]`, in characters.
pub const MAX_LEN: usize = 200;

/// One `[[text]]` in a string: byte range of the whole mark and the text inside. D481: `embed` when it is written
/// `![[text]]` (the `!` is before `start`); the text may name a section, `name#section`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub embed: bool,
}

/// D481: the name and the section of a mark's text: `name#section` → (`name`, `section`). A `#` with nothing after it
/// (or at the start) is part of the name.
pub fn split(text: &str) -> (&str, Option<&str>) {
    match text.find('#') {
        Some(i) if i > 0 && i + 1 < text.len() => (&text[..i], Some(&text[i + 1..])),
        _ => (text, None),
    }
}

/// D481: the target of a mark's text: a resource with exactly that name, else (`name#section`) one with the name part.
pub fn resolve_mark(conn: &Connection, text: &str, source: &Row) -> rusqlite::Result<Option<String>> {
    if let Some(id) = resolve(conn, text, source)? {
        return Ok(Some(id));
    }
    match split(text) {
        (name, Some(_)) => resolve(conn, name, source),
        _ => Ok(None),
    }
}

/// Every reference mark, in order. `\[[` is not a mark; the text may not be empty, contain a line
/// break, or be longer than `MAX_LEN` characters.
pub fn marks(s: &str) -> Vec<Mark> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'[' && b[i + 1] == b'[' && !(i > 0 && b[i - 1] == b'\\') {
            let from = i + 2;
            let Some(off) = s[from..].find("]]") else { break };
            let inner = &s[from..from + off];
            if inner.contains("[[") {
                // A later `[[` opens the mark that this `]]` closes.
                i += 1;
                continue;
            }
            if inner.is_empty() || inner.contains(['\n', '\r']) || inner.chars().count() > MAX_LEN {
                i += 2;
                continue;
            }
            // D481: `![[…]]` embeds; `\![[…]]` is a `!` and a link.
            let embed = i > 0 && b[i - 1] == b'!' && !(i > 1 && b[i - 2] == b'\\');
            out.push(Mark { start: i, end: from + off + 2, text: inner.to_string(), embed });
            i = from + off + 2;
            continue;
        }
        i += 1;
    }
    out
}

/// Groups, environments, configuration and plugin state nodes cannot be referenced.
pub fn referenceable(r: &Row) -> bool {
    ![KIND_GROUP, KIND_ENV, KIND_CONFIG, KIND_PLUGIN_STATE].contains(&r.kind.as_str()) && r.tree.as_deref() != Some(TREE_PLUGIN_STATE)
}

/// Tree, positions from the root down, id: orders rows as the tree shows them.
type PathKey = (String, Vec<i64>, String);

/// Position of a row in its tree, root first (for "the one nearest the top").
fn path_key(conn: &Connection, r: &Row) -> rusqlite::Result<PathKey> {
    let mut pos: Vec<i64> = store::ancestors(conn, r)?.iter().map(|a| a.pos).collect();
    pos.push(r.pos);
    Ok((r.tree.clone().unwrap_or_default(), pos, r.id.clone()))
}

/// D322: exact name (case-sensitive) of a live, referenceable resource; among several, the ones
/// under the source's parent first, then the one nearest the top of the tree.
pub fn resolve(conn: &Connection, name: &str, source: &Row) -> rusqlite::Result<Option<String>> {
    let mut st = conn.prepare_cached(&format!("SELECT {} FROM resources WHERE name = ?1 AND deleted_at IS NULL", store::COLUMNS))?;
    let all: Vec<Row> = st.query_map([name], store::from_row)?.collect::<Result<Vec<_>, _>>()?;
    let mut cands: Vec<Row> = all.into_iter().filter(referenceable).collect();
    if cands.len() > 1 {
        let near: Vec<Row> =
            cands.iter().filter(|c| c.parent_id == source.parent_id && c.tree == source.tree).cloned().collect();
        if !near.is_empty() {
            cands = near;
        }
    }
    let mut best: Option<(PathKey, String)> = None;
    for c in &cands {
        let k = path_key(conn, c)?;
        if best.as_ref().is_none_or(|(b, _)| k < *b) {
            best = Some((k, c.id.clone()));
        }
    }
    Ok(best.map(|(_, id)| id))
}

/// One row of the `refs` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefRow {
    pub field: String,
    pub seq: i64,
    pub text: String,
    pub target: Option<String>,
    /// D330: the row has pointed at a resource (single references always count as having).
    pub ever: bool,
}

pub fn rows_of(conn: &Connection, source: &str) -> rusqlite::Result<Vec<RefRow>> {
    let mut st = conn.prepare_cached("SELECT field, seq, text, target_id, ever FROM refs WHERE source_id = ?1 ORDER BY field, seq")?;
    let v = st.query_map([source], |r| Ok(RefRow { field: r.get(0)?, seq: r.get(1)?, text: r.get(2)?, target: r.get(3)?, ever: r.get(4)? }))?;
    v.collect()
}

/// Sources of live rows referring to `target` (its incoming references; deleted sources too when `all`).
pub fn sources_of(conn: &Connection, target: &str, all: bool) -> rusqlite::Result<Vec<(String, RefRow)>> {
    let cond = if all { "" } else { "AND r.deleted_at IS NULL" };
    let mut st = conn.prepare_cached(&format!(
        "SELECT f.source_id, f.field, f.seq, f.text, f.target_id, f.ever FROM refs f JOIN resources r ON r.id = f.source_id
         WHERE f.target_id = ?1 {cond} ORDER BY r.name, f.source_id, f.field, f.seq"
    ))?;
    let v = st.query_map([target], |r| {
        Ok((r.get(0)?, RefRow { field: r.get(1)?, seq: r.get(2)?, text: r.get(3)?, target: r.get(4)?, ever: r.get(5)? }))
    })?;
    v.collect()
}

pub fn replace(conn: &Connection, source: &str, field: &str, rows: &[RefRow]) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM refs WHERE source_id = ?1 AND field = ?2", params![source, field])?;
    let mut st = conn.prepare_cached("INSERT INTO refs (source_id, field, seq, text, target_id, ever) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
    for r in rows {
        st.execute(params![source, field, r.seq, r.text, r.target, r.ever || r.target.is_some()])?;
    }
    Ok(())
}

/// The declared reference fields of a rule, as `body.<key>`.
pub fn fields_of(rule: &KindRule) -> Vec<String> {
    rule.text_refs.iter().chain(&rule.ref_fields).map(|k| format!("body.{k}")).collect()
}

/// The id a single-reference value points at.
pub fn ref_id(v: &Value) -> Option<&str> {
    v.get("ref").and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Recomputes the references of `row` in the fields that `changed` lists (`None` = all declared).
/// A `[[text]]` that was there before with a target that still exists keeps that target (references
/// are by id, D323); others are resolved by name. Returns every target id before and after.
pub fn update(conn: &Connection, rule: &KindRule, row: &Row, changed: Option<&[String]>) -> rusqlite::Result<BTreeSet<String>> {
    let mut touched = BTreeSet::new();
    let wanted = |f: &str| changed.is_none_or(|c| c.iter().any(|x| x == f || x == "body"));
    for key in &rule.text_refs {
        let field = format!("body.{key}");
        if !wanted(&field) {
            continue;
        }
        let old: Vec<RefRow> = rows_of(conn, &row.id)?.into_iter().filter(|r| r.field == field).collect();
        let mut keep: HashMap<String, String> = HashMap::new();
        // D330: a mark whose earlier row had pointed somewhere stays "has pointed" (a purged target
        // is not replaced by a later namesake, D323).
        let pointed: BTreeSet<String> = old.iter().filter(|o| o.ever).map(|o| o.text.clone()).collect();
        for o in &old {
            if let Some(t) = &o.target {
                touched.insert(t.clone());
                if let Some(tr) = store::get_any(conn, t)? {
                    // Review #3: what was written, and the target's current name (what readers saw
                    // and saved back after a rename), both keep the target.
                    keep.entry(o.text.clone()).or_insert_with(|| t.clone());
                    keep.entry(tr.name).or_insert_with(|| t.clone());
                }
            }
        }
        let text = row.body.get(key).and_then(Value::as_str).unwrap_or_default();
        let mut rows = Vec::new();
        for (i, m) in marks(text).into_iter().enumerate() {
            let target = match keep.get(&m.text).or_else(|| keep.get(split(&m.text).0)) {
                Some(t) => Some(t.clone()),
                None => resolve_mark(conn, &m.text, row)?,
            };
            if let Some(t) = &target {
                touched.insert(t.clone());
            }
            let ever = pointed.contains(&m.text);
            rows.push(RefRow { field: field.clone(), seq: i as i64, text: m.text, target, ever });
        }
        replace(conn, &row.id, &field, &rows)?;
    }
    for key in &rule.ref_fields {
        let field = format!("body.{key}");
        if !wanted(&field) {
            continue;
        }
        for o in rows_of(conn, &row.id)?.into_iter().filter(|r| r.field == field) {
            touched.extend(o.target);
        }
        let mut rows = Vec::new();
        if let Some(id) = row.body.get(key).and_then(ref_id) {
            let target = store::get_any(conn, id)?.filter(referenceable);
            let text = target.as_ref().map(|t| t.name.clone()).unwrap_or_else(|| id.to_string());
            touched.extend(target.as_ref().map(|t| t.id.clone()));
            rows.push(RefRow { field: field.clone(), seq: 0, text, target: target.map(|t| t.id), ever: true });
        }
        replace(conn, &row.id, &field, &rows)?;
    }
    Ok(touched)
}

/// D330: `row` has just got its name (created, renamed, restored, imported). Rows that never pointed
/// anywhere and wait for exactly that name are resolved now, each from its source's side (D322:
/// same parent first, then nearest the top). Returns the sources and targets that changed.
pub fn connect_name(conn: &Connection, row: &Row) -> rusqlite::Result<BTreeSet<String>> {
    let mut touched = BTreeSet::new();
    if !referenceable(row) || row.deleted_at.is_some() {
        return Ok(touched);
    }
    // D481: `name#section` waits for `name` too.
    let mut st = conn.prepare_cached(
        "SELECT source_id, field, seq FROM refs WHERE target_id IS NULL AND ever = 0 AND (text = ?1 OR substr(text, 1, length(?1) + 1) = ?1 || '#')",
    )?;
    let waiting: Vec<(String, String, i64)> = st.query_map([&row.name], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
    drop(st);
    for (source, field, seq) in waiting {
        let Some(src) = store::get_any(conn, &source)? else { continue };
        let Some(target) = resolve(conn, &row.name, &src)? else { continue };
        conn.execute(
            "UPDATE refs SET target_id = ?4, ever = 1 WHERE source_id = ?1 AND field = ?2 AND seq = ?3",
            params![source, field, seq, target],
        )?;
        touched.insert(source);
        touched.insert(target);
    }
    Ok(touched)
}

/// `<kind>` → `text:body.<key>` / `ref:body.<key>` of every kind with reference fields.
pub type Decls = std::collections::BTreeMap<String, BTreeSet<String>>;

pub fn decls(rules: &HashMap<String, KindRule>) -> Decls {
    rules
        .iter()
        .map(|(k, r)| {
            let mut s: BTreeSet<String> = r.text_refs.iter().map(|f| format!("text:body.{f}")).collect();
            s.extend(r.ref_fields.iter().map(|f| format!("ref:body.{f}")));
            (k.clone(), s)
        })
        .filter(|(_, s)| !s.is_empty())
        .collect()
}

pub fn store_decls(conn: &Connection, d: &Decls) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('refs_decl', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [serde_json::to_string(d).expect("json")],
    )?;
    Ok(())
}

/// Review #7: the reference fields declared now against those the table was built for. Fields that
/// went lose their rows; fields that came are computed for every resource of the kind (deleted ones
/// too). Unchanged fields keep their rows (and their targets). Returns the resources touched.
pub fn sync_decls(conn: &Connection, rules: &HashMap<String, KindRule>) -> rusqlite::Result<BTreeSet<String>> {
    let cur = decls(rules);
    let old: Decls = conn
        .query_row("SELECT value FROM meta WHERE key = 'refs_decl'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut touched = BTreeSet::new();
    if cur == old {
        return Ok(touched);
    }
    let none = BTreeSet::new();
    let kinds: BTreeSet<&String> = cur.keys().chain(old.keys()).collect();
    for kind in kinds {
        let (now, before) = (cur.get(kind).unwrap_or(&none), old.get(kind).unwrap_or(&none));
        if now == before {
            continue;
        }
        let field = |d: &String| d.split_once(':').map(|(_, f)| f.to_string()).unwrap_or_default();
        for gone in before.difference(now) {
            conn.execute(
                "DELETE FROM refs WHERE field = ?1 AND source_id IN (SELECT id FROM resources WHERE kind = ?2)",
                params![field(gone), kind],
            )?;
        }
        let added: Vec<String> = now.difference(before).map(field).collect();
        if added.is_empty() {
            continue;
        }
        let Some(rule) = rules.get(kind) else { continue };
        let mut st = conn.prepare(&format!("SELECT {} FROM resources WHERE kind = ?1", store::COLUMNS))?;
        let rows: Vec<Row> = st.query_map([kind], store::from_row)?.collect::<Result<_, _>>()?;
        drop(st);
        for r in &rows {
            touched.extend(update(conn, rule, r, Some(&added))?);
            touched.insert(r.id.clone());
        }
    }
    store_decls(conn, &cur)?;
    Ok(touched)
}

/// Review #4/#8: the references of an imported row, computed from its content. A mark the export
/// listed at the same field, position and text takes that row's target (already a new id here, or
/// none when the target was not imported); other marks are resolved by name. `lost`: single
/// references whose target was not imported (`field`, text) — kept as "missing".
pub fn import_rows(conn: &Connection, rule: &KindRule, row: &Row, hints: &[RefRow], lost: &[(String, String)]) -> rusqlite::Result<BTreeSet<String>> {
    let mut touched = BTreeSet::new();
    for key in &rule.text_refs {
        let field = format!("body.{key}");
        let text = row.body.get(key).and_then(Value::as_str).unwrap_or_default();
        let mut rows = Vec::new();
        for (i, m) in marks(text).into_iter().enumerate() {
            let hint = hints.iter().find(|h| h.field == field && h.seq == i as i64 && h.text == m.text);
            let target = match hint {
                Some(h) => h.target.clone().filter(|t| store::get_any(conn, t).ok().flatten().is_some_and(|r| referenceable(&r))),
                None => resolve_mark(conn, &m.text, row)?,
            };
            touched.extend(target.clone());
            rows.push(RefRow { field: field.clone(), seq: i as i64, text: m.text, target, ever: false });
        }
        replace(conn, &row.id, &field, &rows)?;
    }
    for key in &rule.ref_fields {
        let field = format!("body.{key}");
        let mut rows = Vec::new();
        if let Some(id) = row.body.get(key).and_then(ref_id) {
            let target = store::get_any(conn, id)?.filter(referenceable);
            let text = target.as_ref().map(|t| t.name.clone()).unwrap_or_else(|| id.to_string());
            touched.extend(target.as_ref().map(|t| t.id.clone()));
            rows.push(RefRow { field: field.clone(), seq: 0, text, target: target.map(|t| t.id), ever: true });
        } else if let Some((_, text)) = lost.iter().find(|(f, _)| *f == field) {
            rows.push(RefRow { field: field.clone(), seq: 0, text: text.clone(), target: None, ever: true });
        }
        replace(conn, &row.id, &field, &rows)?;
    }
    Ok(touched)
}

/// Rebuilds the whole table from every stored resource (after migration 0008, or on demand).
pub fn rebuild(conn: &Connection, rules: &HashMap<String, KindRule>) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM refs", [])?;
    let mut st = conn.prepare(&format!("SELECT {} FROM resources ORDER BY tree, parent_id, pos, id", store::COLUMNS))?;
    let all: Vec<Row> = st.query_map([], store::from_row)?.collect::<Result<_, _>>()?;
    drop(st);
    for r in &all {
        if let Some(rule) = rules.get(&r.kind) {
            update(conn, rule, r, None)?;
        }
    }
    conn.query_row("SELECT count(*) FROM refs", [], |r| r.get::<_, i64>(0)).map(|n| n as usize)
}

/// Whether `[[name]]` parses back as exactly this name.
pub fn shows_as_mark(name: &str) -> bool {
    !name.is_empty() && !name.contains("]]") && !name.contains("[[") && !name.contains(['\n', '\r']) && name.chars().count() <= MAX_LEN && !name.ends_with(']')
}

/// What readers see (D321): in each text field with references, every resolved `[[old]]` shows the
/// target's current name. The stored row is not changed.
pub fn display(conn: &Connection, rule: Option<&KindRule>, row: &Row) -> rusqlite::Result<Row> {
    let Some(rule) = rule.filter(|r| !r.text_refs.is_empty()) else { return Ok(row.clone()) };
    let rows = rows_of(conn, &row.id)?;
    let mut out = row.clone();
    for key in &rule.text_refs {
        let field = format!("body.{key}");
        let Some(text) = row.body.get(key).and_then(Value::as_str) else { continue };
        let mine: Vec<&RefRow> = rows.iter().filter(|r| r.field == field).collect();
        let mut s = String::with_capacity(text.len());
        let mut at = 0;
        for (i, m) in marks(text).into_iter().enumerate() {
            let Some(r) = mine.get(i).filter(|r| r.text == m.text) else { continue };
            let Some(t) = r.target.as_deref().map(|t| store::get_any(conn, t)).transpose()?.flatten() else { continue };
            // Review #11: a name that could not be read back as one mark is left as written.
            if !shows_as_mark(&t.name) {
                continue;
            }
            s.push_str(&text[at..m.start]);
            s.push_str("[[");
            s.push_str(&t.name);
            // D481: the section stays as written.
            if r.text != t.name {
                if let (_, Some(section)) = split(&r.text) {
                    s.push('#');
                    s.push_str(section);
                }
            }
            s.push_str("]]");
            at = m.end;
        }
        s.push_str(&text[at..]);
        if s != text {
            out.body.insert(key.clone(), Value::String(s));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(s: &str) -> Vec<String> {
        marks(s).into_iter().map(|m| m.text).collect()
    }

    #[test]
    fn marks_are_found_in_order_with_escapes_lines_and_limits() {
        assert_eq!(texts("a [[One]] b [[Two]] [[One]]"), ["One", "Two", "One"]);
        assert_eq!(texts(r"\[[Not]] but [[Yes]]"), ["Yes"]);
        assert_eq!(texts("[[across\nlines]] [[ok]]"), ["ok"]);
        assert_eq!(texts("[[]] [[x]]"), ["x"]);
        let long = "x".repeat(MAX_LEN + 1);
        assert_eq!(texts(&format!("[[{long}]] [[fine]]")), ["fine"]);
        let edge = "é".repeat(MAX_LEN);
        assert_eq!(texts(&format!("[[{edge}]]")), vec![edge]);
        assert_eq!(texts("[[a [[b]] c]]"), ["b"]);
        assert_eq!(texts("[[unclosed"), Vec::<String>::new());
        let m = &marks("ab[[c]]d")[0];
        assert_eq!((m.start, m.end), (2, 7));
    }

    #[test]
    fn embeds_and_sections_d481() {
        let all = marks("x ![[Law#Art 36]] [[Law]] \\![[Not embed]]");
        assert_eq!(all.iter().map(|m| (m.text.as_str(), m.embed)).collect::<Vec<_>>(), [("Law#Art 36", true), ("Law", false), ("Not embed", false)]);
        assert_eq!(split("Law#Art 36"), ("Law", Some("Art 36")));
        assert_eq!(split("C#"), ("C#", None));
        assert_eq!(split("#tag"), ("#tag", None));
        assert_eq!(split("Plain"), ("Plain", None));
    }
}

#[cfg(test)]
mod rebuild_tests {
    use super::*;
    use crate::pipeline::KindRule;
    use rusqlite::Connection;

    fn insert(conn: &Connection, id: &str, kind: &str, parent: Option<&str>, pos: i64, name: &str, body: Value) {
        conn.execute(
            "INSERT INTO resources (id, kind, tree, parent_id, pos, name, body, rev, created_at, created_by, updated_at, updated_by)
             VALUES (?1, ?2, 'resources', ?3, ?4, ?5, ?6, 1, 0, 'user', 0, 'user')",
            params![id, kind, parent, pos, name, body.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn rebuild_fills_the_table_from_every_resource() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::workspace::migrate(&mut conn).unwrap();
        let mut rules = crate::pipeline::core_rules();
        rules.insert("p:doc".into(), KindRule { text_refs: vec!["text".into()], ref_fields: vec!["to".into()], ..Default::default() });
        insert(&conn, "g", KIND_GROUP, None, 0, "Target", serde_json::json!({}));
        insert(&conn, "t", "p:doc", None, 1, "Target", serde_json::json!({}));
        insert(&conn, "s", "p:doc", None, 2, "Source", serde_json::json!({ "text": "[[Target]] [[None]]", "to": { "ref": "t" } }));
        conn.execute("INSERT INTO refs (source_id, field, seq, text, target_id) VALUES ('stale', 'body.text', 0, 'x', NULL)", []).unwrap();
        assert_eq!(rebuild(&conn, &rules).unwrap(), 3);
        let rows = rows_of(&conn, "s").unwrap();
        let got: Vec<(&str, i64, &str, Option<&str>)> =
            rows.iter().map(|r| (r.field.as_str(), r.seq, r.text.as_str(), r.target.as_deref())).collect();
        assert_eq!(got, [("body.text", 0, "Target", Some("t")), ("body.text", 1, "None", None), ("body.to", 0, "Target", Some("t"))]);
        assert!(rows_of(&conn, "stale").unwrap().is_empty());
        // What readers see after the target is renamed.
        conn.execute("UPDATE resources SET name = 'Renamed' WHERE id = 't'", []).unwrap();
        let s = store::get(&conn, "s").unwrap().unwrap();
        let shown = display(&conn, rules.get("p:doc"), &s).unwrap();
        assert_eq!(shown.body["text"], "[[Renamed]] [[None]]");
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;

    #[test]
    fn names_that_would_not_read_back_are_not_substituted() {
        for n in ["a]]b", "a\nb", "x]", "[[x", ""] {
            assert!(!shows_as_mark(n), "{n:?}");
        }
        assert!(shows_as_mark("Plain name [x]y"));
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::workspace::migrate(&mut conn).unwrap();
        let rule = KindRule { text_refs: vec!["text".into()], ..Default::default() };
        for (id, name, body) in [("t", "Old", "{}"), ("s", "S", r#"{"text":"[[Old]]"}"#)] {
            conn.execute(
                "INSERT INTO resources (id, kind, tree, name, body, rev, created_at, created_by, updated_at, updated_by)
                 VALUES (?1, 'p:doc', 'resources', ?2, ?3, 1, 0, 'u', 0, 'u')",
                params![id, name, body],
            )
            .unwrap();
        }
        let s = store::get(&conn, "s").unwrap().unwrap();
        update(&conn, &rule, &s, None).unwrap();
        conn.execute("UPDATE resources SET name = 'a]]b' WHERE id = 't'", []).unwrap();
        assert_eq!(display(&conn, Some(&rule), &s).unwrap().body["text"], "[[Old]]");
    }
}

#[cfg(test)]
mod migration_tests {
    use rusqlite::Connection;

    #[test]
    fn migration_0010_marks_rows_that_had_a_target() {
        let mut conn = Connection::open_in_memory().unwrap();
        let tx = conn.transaction().unwrap();
        for (_, stmt_text) in &crate::workspace::MIGRATIONS[..9] {
            tx.execute_batch(stmt_text).unwrap();
        }
        tx.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '9')", []).unwrap();
        tx.execute_batch(
            "INSERT INTO refs (source_id, field, seq, text, target_id) VALUES ('s', 'body.text', 0, 'A', 't');
             INSERT INTO refs (source_id, field, seq, text, target_id) VALUES ('s', 'body.text', 1, 'B', NULL);",
        )
        .unwrap();
        tx.commit().unwrap();
        crate::workspace::migrate(&mut conn).unwrap();
        let rows: Vec<(String, Option<String>, bool)> = conn
            .prepare("SELECT text, target_id, ever FROM refs ORDER BY seq")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows, vec![("A".into(), Some("t".into()), true), ("B".into(), None, false)]);
    }
}
