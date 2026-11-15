//! The single write path (kernel-design §4):
//! `execute(actor, command)` → permission → one transaction (concurrency check, data, `revisions`
//! snapshot, `audit`) → commit → the caller publishes events from the returned `Outcome`.
//! One dedicated thread owns the writable connection and runs commands one after another.

use std::collections::{BTreeSet, HashMap};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;

use onedesk_protocol::{ErrorCode, JsonMap};
use rusqlite::{params, Connection, Transaction};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::store::{self, Row, KIND_GROUP, KIND_PLUGIN_STATE, TREE_PLUGIN_STATE};
use crate::util::{denied, err_p, internal, invalid, invalid_params, new_id, not_found, now_ms, KResult};

/// Who is writing (§4.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    User,
    Core,
    Plugin { id: String, version: String },
}

impl Actor {
    pub fn as_text(&self) -> String {
        match self {
            Actor::User => "user".into(),
            Actor::Core => "core".into(),
            Actor::Plugin { id, version } => format!("plugin:{id}@{version}"),
        }
    }
}

/// Field-level changes (§4 "提交按字段"): top-level fields and the first level of `body`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Changes {
    pub name: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub body: JsonMap,
}

impl Changes {
    /// From bind paths (`name`, `description`, `tags`, `body.<key>`), as `page.save` sends them.
    pub fn from_bind_map(map: &JsonMap) -> KResult<Changes> {
        let mut c = Changes::default();
        for (path, v) in map {
            match path.as_str() {
                "name" => c.name = Some(v.as_str().ok_or_else(|| invalid_params("name must be a string"))?.to_string()),
                "description" => {
                    c.description =
                        Some(v.as_str().ok_or_else(|| invalid_params("description must be a string"))?.to_string())
                }
                "tags" => {
                    c.tags = Some(serde_json::from_value(v.clone()).map_err(|_| invalid_params("tags must be strings"))?)
                }
                p => match p.strip_prefix("body.") {
                    Some(k) if !k.is_empty() => {
                        c.body.insert(k.to_string(), v.clone());
                    }
                    _ => return Err(invalid_params(format!("unknown bind path {p}"))),
                },
            }
        }
        Ok(c)
    }

    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.description.is_none() && self.tags.is_none() && self.body.is_empty()
    }

    /// Applies to `row`, returning the names of the fields whose value actually changed.
    fn apply(&self, row: &mut Row) -> Vec<String> {
        let mut changed = Vec::new();
        if let Some(n) = &self.name {
            if *n != row.name {
                row.name = n.clone();
                changed.push("name".into());
            }
        }
        if let Some(d) = &self.description {
            if *d != row.description {
                row.description = d.clone();
                changed.push("description".into());
            }
        }
        if let Some(t) = &self.tags {
            if *t != row.tags {
                row.tags = t.clone();
                changed.push("tags".into());
            }
        }
        for (k, v) in &self.body {
            let old = row.body.get(k);
            // `null` removes the key.
            if v.is_null() {
                if old.is_some() {
                    row.body.remove(k);
                    changed.push(format!("body.{k}"));
                }
            } else if old != Some(v) {
                row.body.insert(k.clone(), v.clone());
                changed.push(format!("body.{k}"));
            }
        }
        changed
    }

    fn fields(&self) -> Vec<String> {
        let mut f = Vec::new();
        if self.name.is_some() {
            f.push("name".into());
        }
        if self.description.is_some() {
            f.push("description".into());
        }
        if self.tags.is_some() {
            f.push("tags".into());
        }
        f.extend(self.body.keys().map(|k| format!("body.{k}")));
        f
    }
}

#[derive(Debug, Clone)]
pub struct NewResource {
    pub kind: String,
    /// Only for `core:group`, which can live in any stored tree; other kinds use their manifest tree.
    pub tree: Option<String>,
    pub parent: Option<String>,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub body: JsonMap,
    pub plugin_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveDest {
    Before(String),
    After(String),
    /// `None` = top level of the tree.
    Inside(Option<String>),
}

#[derive(Debug, Clone)]
pub enum Command {
    Create(NewResource),
    Update { id: String, changes: Changes, basis: Option<i64> },
    Move { id: String, dest: MoveDest },
    /// Deletion mark; a group goes together with all its descendants as one batch (§3.4).
    Delete { id: String },
    /// Record-only audit entry for writes outside the database (e.g. a plugin writing a file).
    Audit { op: String, object: String, summary: Value },
    /// A call refused before it reached the database (e.g. a plugin's out-of-bounds host call):
    /// writes only the failure audit row (§4.3) and returns `error`.
    Refused { op: String, object: String, error: onedesk_protocol::ProtocolError },
    /// Adds or removes one granted folder of a plugin, read-modify-write in one transaction (D261).
    Grant { plugin: String, folder: String, add: bool },
    /// Interface state (§9.2): not versioned, not audited.
    UiSet { client: String, key: String, value: Value },
}

/// What the kernel needs to know about a kind to validate writes.
#[derive(Debug, Clone, Default)]
pub struct KindRule {
    pub tree: Option<String>,
    /// Full kind names, or `*` for any kind of the same tree.
    pub accepts: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Outcome {
    /// The created or changed resource.
    pub id: Option<String>,
    pub changed: bool,
    /// Every row the command touched, after the change (deleted rows included).
    pub rows: Vec<Row>,
}

impl Outcome {
    /// `tree:<id>` and `resource:<id>` topics to publish after commit.
    pub fn topics(&self) -> Vec<String> {
        let mut t = BTreeSet::new();
        for r in &self.rows {
            if let Some(tree) = &r.tree {
                t.insert(format!("{}{tree}", onedesk_protocol::topic::TREE));
            }
            t.insert(format!("{}{}", onedesk_protocol::topic::RESOURCE, r.id));
        }
        t.into_iter().collect()
    }
}

type Job = (Actor, Command, oneshot::Sender<KResult<Outcome>>);

pub struct Pipeline {
    tx: std::sync::Mutex<Option<mpsc::Sender<Job>>>,
    thread: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl Pipeline {
    pub fn start(conn: Connection, rules: Arc<HashMap<String, KindRule>>) -> Pipeline {
        let (tx, rx) = mpsc::channel::<Job>();
        let thread = std::thread::Builder::new()
            .name("onedesk-writer".into())
            .spawn(move || {
                let mut w = Writer { conn, rules };
                while let Ok((actor, cmd, reply)) = rx.recv() {
                    let _ = reply.send(w.run(&actor, cmd));
                }
            })
            .expect("spawn writer thread");
        Pipeline { tx: std::sync::Mutex::new(Some(tx)), thread: std::sync::Mutex::new(Some(thread)) }
    }

    pub async fn execute(&self, actor: Actor, cmd: Command) -> KResult<Outcome> {
        let (reply, rx) = oneshot::channel();
        let tx = self.tx.lock().unwrap().clone().ok_or_else(|| internal("pipeline stopped"))?;
        tx.send((actor, cmd, reply)).map_err(|_| internal("writer thread gone"))?;
        rx.await.map_err(|_| internal("writer thread gone"))?
    }

    /// Finishes the queued commands and stops the writer thread.
    pub fn shutdown(&self) {
        self.tx.lock().unwrap().take();
        let thread = self.thread.lock().unwrap().take();
        if let Some(t) = thread {
            let _ = t.join();
        }
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Writer {
    conn: Connection,
    rules: Arc<HashMap<String, KindRule>>,
}

fn sql(e: rusqlite::Error) -> onedesk_protocol::ProtocolError {
    internal(e)
}

fn code_text(code: ErrorCode) -> String {
    serde_json::to_value(code).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

impl Writer {
    fn run(&mut self, actor: &Actor, cmd: Command) -> KResult<Outcome> {
        if let Command::UiSet { client, key, value } = &cmd {
            return self.ui_set(client, key, value);
        }
        let (op, object) = describe(&cmd);
        let res = self.transact(actor, cmd);
        if let Err(e) = &res {
            // Failed or refused: data unchanged, the audit row is written on its own (§4.3).
            let summary = json!({ "code": e.code, "params": e.params }).to_string();
            let _ = self.conn.execute(
                "INSERT INTO audit (at, actor, op, object, summary, result) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![now_ms(), actor.as_text(), op, object, summary, format!("failed:{}", code_text(e.code))],
            );
        }
        res
    }

    fn ui_set(&mut self, client: &str, key: &str, value: &Value) -> KResult<Outcome> {
        if value.is_null() {
            self.conn.execute("DELETE FROM ui_state WHERE client = ?1 AND key = ?2", params![client, key])
        } else {
            self.conn.execute(
                "INSERT INTO ui_state (client, key, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(client, key) DO UPDATE SET value = excluded.value",
                params![client, key, value.to_string()],
            )
        }
        .map_err(sql)?;
        Ok(Outcome::default())
    }

    fn transact(&mut self, actor: &Actor, cmd: Command) -> KResult<Outcome> {
        let rules = self.rules.clone();
        let tx = self.conn.transaction().map_err(sql)?;
        let out = {
            let mut cx = Tx { tx: &tx, actor, rules: &rules, at: now_ms() };
            match cmd {
                Command::Create(n) => cx.create(n)?,
                Command::Update { id, changes, basis } => cx.update(&id, &changes, basis)?,
                Command::Move { id, dest } => cx.move_to(&id, dest)?,
                Command::Delete { id } => cx.delete(&id)?,
                Command::Audit { op, object, summary } => {
                    cx.audit(&op, &object, &summary)?;
                    Outcome { changed: true, ..Default::default() }
                }
                Command::Refused { error, .. } => return Err(error),
                Command::Grant { plugin, folder, add } => cx.grant(&plugin, &folder, add)?,
                Command::UiSet { .. } => unreachable!("handled above"),
            }
        };
        tx.commit().map_err(sql)?;
        Ok(out)
    }
}

fn describe(cmd: &Command) -> (String, String) {
    match cmd {
        Command::Create(n) => ("resource.create".into(), n.kind.clone()),
        Command::Update { id, .. } => ("resource.update".into(), id.clone()),
        Command::Move { id, .. } => ("resource.move".into(), id.clone()),
        Command::Delete { id } => ("resource.delete".into(), id.clone()),
        Command::Audit { op, object, .. } => (op.clone(), object.clone()),
        Command::Refused { op, object, .. } => (op.clone(), object.clone()),
        Command::Grant { plugin, .. } => ("plugin.grant".into(), plugin.clone()),
        Command::UiSet { key, .. } => ("ui.set".into(), key.clone()),
    }
}

struct Tx<'a> {
    tx: &'a Transaction<'a>,
    actor: &'a Actor,
    rules: &'a HashMap<String, KindRule>,
    at: i64,
}

impl Tx<'_> {
    fn rule(&self, kind: &str) -> KResult<&KindRule> {
        self.rules.get(kind).ok_or_else(|| err_p(ErrorCode::Invalid, &[("reason", "unknownKind"), ("kind", kind)]))
    }

    /// Plugins write only their own kinds (§7.5, D268); the kernel's own kinds are not theirs.
    fn permit(&self, kind: &str) -> KResult<()> {
        match self.actor {
            Actor::Plugin { id, .. } => {
                if kind.strip_prefix(id.as_str()).is_some_and(|rest| rest.starts_with(':')) {
                    Ok(())
                } else {
                    Err(denied("foreignKind"))
                }
            }
            // The protocol layer keeps users away from hidden trees (plugin state is only written
            // through `plugin.grantFolder` / `revokeFolder`).
            Actor::User | Actor::Core => Ok(()),
        }
    }

    fn live(&self, id: &str) -> KResult<Row> {
        store::get(self.tx, id).map_err(sql)?.ok_or_else(|| not_found("resource"))
    }

    /// Checks that `parent` (live, same tree) accepts `kind`.
    fn check_parent(&self, kind: &str, tree: Option<&str>, parent: Option<&str>) -> KResult<()> {
        let Some(pid) = parent else { return Ok(()) };
        let p = store::get(self.tx, pid).map_err(sql)?.ok_or_else(|| invalid("parentNotFound"))?;
        if p.tree.as_deref() != tree || tree.is_none() {
            return Err(invalid("otherTree"));
        }
        let accepts = self.rules.get(&p.kind).map(|r| r.accepts.as_slice()).unwrap_or(&[]);
        if accepts.iter().any(|a| a == "*" || a == kind) {
            Ok(())
        } else {
            Err(invalid("notAccepted"))
        }
    }

    fn next_pos(&self, tree: Option<&str>, parent: Option<&str>) -> KResult<i64> {
        self.tx
            .query_row(
                "SELECT COALESCE(MAX(pos) + 1, 0) FROM resources WHERE tree IS ?1 AND parent_id IS ?2 AND deleted_at IS NULL",
                params![tree, parent],
                |r| r.get(0),
            )
            .map_err(sql)
    }

    fn insert(&self, r: &Row) -> KResult<()> {
        self.tx
            .execute(
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
            )
            .map_err(sql)?;
        Ok(())
    }

    fn save(&self, r: &Row) -> KResult<()> {
        self.tx
            .execute(
                "UPDATE resources SET parent_id=?2, pos=?3, name=?4, description=?5, tags=?6, body=?7, rev=?8,
                 updated_at=?9, updated_by=?10, deleted_at=?11 WHERE id=?1",
                params![
                    r.id,
                    r.parent_id,
                    r.pos,
                    r.name,
                    r.description,
                    serde_json::to_string(&r.tags).expect("json"),
                    serde_json::to_string(&r.body).expect("json"),
                    r.rev,
                    r.updated_at,
                    r.updated_by,
                    r.deleted_at
                ],
            )
            .map_err(sql)?;
        Ok(())
    }

    fn revision(&self, r: &Row, op: &str, fields: &[String]) -> KResult<()> {
        self.tx
            .execute(
                "INSERT INTO revisions (resource_id, rev, at, actor, op, fields, snapshot) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    r.id,
                    r.rev,
                    self.at,
                    self.actor.as_text(),
                    op,
                    serde_json::to_string(fields).expect("json"),
                    serde_json::to_string(r).expect("json")
                ],
            )
            .map_err(sql)?;
        Ok(())
    }

    fn audit(&self, op: &str, object: &str, summary: &Value) -> KResult<()> {
        self.tx
            .execute(
                "INSERT INTO audit (at, actor, op, object, summary, result) VALUES (?1,?2,?3,?4,?5,'ok')",
                params![self.at, self.actor.as_text(), op, object, summary.to_string()],
            )
            .map_err(sql)?;
        Ok(())
    }

    fn create(&mut self, n: NewResource) -> KResult<Outcome> {
        self.permit(&n.kind)?;
        let rule_tree = self.rule(&n.kind)?.tree.clone();
        let tree = if n.kind == KIND_GROUP { n.tree.clone().or(rule_tree) } else { rule_tree };
        if n.name.trim().is_empty() {
            return Err(invalid("emptyName"));
        }
        self.check_parent(&n.kind, tree.as_deref(), n.parent.as_deref())?;
        let actor = self.actor.as_text();
        let row = Row {
            id: new_id(),
            kind: n.kind,
            plugin_version: n.plugin_version,
            pos: self.next_pos(tree.as_deref(), n.parent.as_deref())?,
            tree,
            parent_id: n.parent,
            name: n.name,
            description: n.description,
            tags: n.tags,
            body: n.body,
            origin: "original".into(),
            origin_ref: None,
            state: "ok".into(),
            rev: 1,
            created_at: self.at,
            created_by: actor.clone(),
            updated_at: self.at,
            updated_by: actor,
            deleted_at: None,
        };
        self.insert(&row)?;
        let fields: Vec<String> = vec!["*".into()];
        self.revision(&row, "create", &fields)?;
        self.audit("resource.create", &row.id, &json!({ "kind": row.kind, "name": row.name }))?;
        Ok(Outcome { id: Some(row.id.clone()), changed: true, rows: vec![row] })
    }

    fn update(&mut self, id: &str, changes: &Changes, basis: Option<i64>) -> KResult<Outcome> {
        let mut row = self.live(id)?;
        self.permit(&row.kind)?;
        if changes.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
            return Err(invalid("emptyName"));
        }
        if let Some(b) = basis {
            if b < row.rev {
                // Conflict only when one of *these* fields changed after `basis` (§4 并发规则).
                let mut st = self
                    .tx
                    .prepare_cached("SELECT fields FROM revisions WHERE resource_id = ?1 AND rev > ?2")
                    .map_err(sql)?;
                let later: BTreeSet<String> = st
                    .query_map(params![id, b], |r| r.get::<_, String>(0))
                    .map_err(sql)?
                    .filter_map(|f| f.ok())
                    .flat_map(|f| serde_json::from_str::<Vec<String>>(&f).unwrap_or_default())
                    .collect();
                if let Some(f) = changes.fields().into_iter().find(|f| later.contains(f) || later.contains("*")) {
                    return Err(err_p(ErrorCode::Conflict, &[("field", &f), ("rev", &row.rev.to_string())]));
                }
            }
        }
        let changed = changes.apply(&mut row);
        if changed.is_empty() {
            return Ok(Outcome { id: Some(row.id.clone()), changed: false, rows: vec![] });
        }
        row.rev += 1;
        row.updated_at = self.at;
        row.updated_by = self.actor.as_text();
        self.save(&row)?;
        self.revision(&row, "update", &changed)?;
        self.audit("resource.update", &row.id, &json!({ "fields": changed }))?;
        Ok(Outcome { id: Some(row.id.clone()), changed: true, rows: vec![row] })
    }

    fn move_to(&mut self, id: &str, dest: MoveDest) -> KResult<Outcome> {
        let mut row = self.live(id)?;
        self.permit(&row.kind)?;
        if row.tree.is_none() {
            return Err(invalid("notInTree"));
        }
        // Resolve the destination parent and the sibling to insert before.
        let anchor = |aid: &str| -> KResult<Row> {
            if aid == id {
                return Err(invalid("self"));
            }
            store::get(self.tx, aid).map_err(sql)?.ok_or_else(|| invalid("targetNotFound"))
        };
        let (parent, before): (Option<String>, Option<String>) = match &dest {
            MoveDest::Inside(None) => (None, None),
            MoveDest::Inside(Some(p)) => (Some(anchor(p)?.id), None),
            MoveDest::Before(t) => {
                let t = anchor(t)?;
                (t.parent_id.clone(), Some(t.id))
            }
            MoveDest::After(t) => {
                let t = anchor(t)?;
                let sibs = self.siblings(row.tree.as_deref(), t.parent_id.as_deref(), id)?;
                let i = sibs.iter().position(|s| s.id == t.id).unwrap_or(sibs.len());
                (t.parent_id.clone(), sibs.get(i + 1).map(|s| s.id.clone()))
            }
        };
        if let Some(p) = &parent {
            if p == id {
                return Err(invalid("self"));
            }
            let pr = self.live(p).map_err(|_| invalid("targetNotFound"))?;
            if store::ancestors(self.tx, &pr).map_err(sql)?.iter().any(|a| a.id == id) {
                return Err(invalid("descendant"));
            }
        }
        if let Some(t) = &dest_tree(self, &dest)? {
            if Some(t.as_str()) != row.tree.as_deref() {
                return Err(invalid("otherTree"));
            }
        }
        self.check_parent(&row.kind, row.tree.as_deref(), parent.as_deref())?;

        // Renumber the destination siblings; only the moved node gets a revision.
        let mut sibs = self.siblings(row.tree.as_deref(), parent.as_deref(), id)?;
        let at = before.as_ref().and_then(|b| sibs.iter().position(|s| &s.id == b)).unwrap_or(sibs.len());
        let old = (row.parent_id.clone(), row.pos);
        row.parent_id = parent;
        sibs.insert(at, row.clone());
        for (i, s) in sibs.iter().enumerate() {
            if s.id == row.id {
                row.pos = i as i64;
            } else if s.pos != i as i64 {
                self.tx
                    .execute("UPDATE resources SET pos = ?2 WHERE id = ?1", params![s.id, i as i64])
                    .map_err(sql)?;
            }
        }
        let mut changed = Vec::new();
        if old.0 != row.parent_id {
            changed.push("parent".to_string());
        }
        if old.1 != row.pos {
            changed.push("pos".to_string());
        }
        if changed.is_empty() {
            return Ok(Outcome { id: Some(row.id.clone()), changed: false, rows: vec![] });
        }
        row.rev += 1;
        row.updated_at = self.at;
        row.updated_by = self.actor.as_text();
        self.save(&row)?;
        self.revision(&row, "move", &changed)?;
        self.audit("resource.move", &row.id, &json!({ "parent": row.parent_id, "pos": row.pos }))?;
        Ok(Outcome { id: Some(row.id.clone()), changed: true, rows: vec![row] })
    }

    fn grant(&mut self, plugin: &str, folder: &str, add: bool) -> KResult<Outcome> {
        let key = GRANTS_KEY;
        let row = store::plugin_state(self.tx, plugin).map_err(sql)?;
        let mut folders: Vec<String> = row
            .as_ref()
            .and_then(|r| r.body.get(key).cloned())
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        let before = folders.clone();
        if add {
            if !folders.iter().any(|f| f == folder) {
                folders.push(folder.to_string());
            }
        } else {
            folders.retain(|f| f != folder);
        }
        if folders == before {
            return Ok(Outcome { changed: false, ..Default::default() });
        }
        match row {
            Some(r) => {
                let mut changes = Changes::default();
                changes.body.insert(key.into(), json!(folders));
                self.update(&r.id, &changes, None)
            }
            None => {
                let mut body = JsonMap::new();
                body.insert(key.into(), json!(folders));
                self.create(NewResource {
                    kind: KIND_PLUGIN_STATE.into(),
                    tree: None,
                    parent: None,
                    name: plugin.into(),
                    description: String::new(),
                    tags: vec![],
                    body,
                    plugin_version: None,
                })
            }
        }
    }

    fn siblings(&self, tree: Option<&str>, parent: Option<&str>, except: &str) -> KResult<Vec<Row>> {
        let all = store::children(self.tx, tree.unwrap_or_default(), parent, 0, u32::MAX).map_err(sql)?;
        Ok(all.into_iter().filter(|r| r.id != except).collect())
    }

    fn delete(&mut self, id: &str) -> KResult<Outcome> {
        let root = self.live(id)?;
        self.permit(&root.kind)?;
        let mut batch = vec![root];
        batch.extend(store::descendants(self.tx, id).map_err(sql)?);
        // All or nothing: one refused row refuses the batch.
        for r in &batch {
            self.permit(&r.kind)?;
        }
        let batch_id = new_id();
        for r in &mut batch {
            r.deleted_at = Some(self.at);
            r.rev += 1;
            r.updated_at = self.at;
            r.updated_by = self.actor.as_text();
            self.save(r)?;
            self.tx
                .execute("UPDATE resources SET delete_batch = ?2 WHERE id = ?1", params![r.id, batch_id])
                .map_err(sql)?;
            self.revision(r, "delete", &["deleted".to_string()])?;
        }
        let ids: Vec<&str> = batch.iter().map(|r| r.id.as_str()).collect();
        self.audit("resource.delete", id, &json!({ "batch": batch_id, "count": ids.len(), "ids": ids }))?;
        Ok(Outcome { id: Some(id.to_string()), changed: true, rows: batch })
    }
}

fn dest_tree(cx: &Tx<'_>, dest: &MoveDest) -> KResult<Option<String>> {
    let id = match dest {
        MoveDest::Inside(None) => return Ok(None),
        MoveDest::Inside(Some(i)) | MoveDest::Before(i) | MoveDest::After(i) => i,
    };
    Ok(store::get(cx.tx, id).map_err(sql)?.and_then(|r| r.tree))
}

/// Body key of `core:plugin-state` holding the granted folders.
pub const GRANTS_KEY: &str = "files.folders";

/// Rules of the kernel's own kinds; plugin kinds are added by the registry.
pub fn core_rules() -> HashMap<String, KindRule> {
    let mut m = HashMap::new();
    m.insert(KIND_GROUP.to_string(), KindRule { tree: Some(store::TREE_RESOURCES.into()), accepts: vec!["*".into()] });
    m.insert(KIND_PLUGIN_STATE.to_string(), KindRule { tree: Some(TREE_PLUGIN_STATE.into()), accepts: vec![] });
    m
}
