//! The single write path (kernel-design §4):
//! `execute(actor, command)` → permission → one transaction (concurrency check, data, `revisions`
//! snapshot, `audit`) → commit → the caller publishes events from the returned `Outcome`.
//! One dedicated thread owns the writable connection and runs commands one after another.

use std::collections::{BTreeSet, HashMap};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;

use onedesk_protocol::{ErrorCode, JsonMap};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::store::{self, Row, KIND_CONFIG, KIND_ENV, KIND_GROUP, KIND_PLUGIN_STATE, TREE_PLUGIN_STATE};
use onedesk_protocol::ParamType;
use crate::util::{denied, err_p, internal, invalid, invalid_params, new_id, not_found, now_ms, KResult};

/// Who is writing (§4.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    User,
    Core,
    Plugin { id: String, version: String },
    /// Round 19 (D448): an AI client (MCP). Writes nothing: the pipeline refuses every command
    /// of it except the audit rows the kernel writes about its calls.
    Ai { client: String },
}

impl Actor {
    pub fn as_text(&self) -> String {
        match self {
            Actor::User => "user".into(),
            Actor::Core => "core".into(),
            Actor::Plugin { id, version } => format!("plugin:{id}@{version}"),
            Actor::Ai { client } => format!("ai:{client}"),
        }
    }
}

/// Field-level changes (§4 "提交按字段"): top-level fields and the first level of `body`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Changes {
    pub name: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    /// D473: `defaultEnv`; `Some("")` clears it (the place above decides again).
    pub default_env: Option<String>,
    pub body: JsonMap,
    /// `params.<name>` of parameter nodes (D275).
    pub params: std::collections::BTreeMap<String, ParamChange>,
}

/// One field-level change of a parameter table.
#[derive(Debug, Clone, PartialEq)]
pub enum ParamChange {
    /// Keeps the existing type unless one is given (`text` for a new parameter).
    Set { value: String, ty: Option<ParamType> },
    Unset,
    /// Records the current inherited value as the basis of this override (§4.2).
    Acknowledge,
    /// Exact entry, as a snapshot had it (restore); `None` removes it.
    Exact(Option<crate::params::Param>),
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
                "defaultEnv" => {
                    c.default_env = Some(match v {
                        Value::Null => String::new(),
                        Value::String(s) => s.clone(),
                        _ => return Err(invalid_params("defaultEnv must be an environment id")),
                    })
                }
                p => match (p.strip_prefix("body."), p.strip_prefix("params.")) {
                    (Some(k), _) if !k.is_empty() => {
                        c.body.insert(k.to_string(), v.clone());
                    }
                    (_, Some(n)) if !n.is_empty() => {
                        let value = match v {
                            Value::String(s) => s.clone(),
                            Value::Null => String::new(),
                            other => other.to_string(),
                        };
                        c.params.insert(n.to_string(), ParamChange::Set { value, ty: None });
                    }
                    _ => return Err(invalid_params(format!("unknown bind path {p}"))),
                },
            }
        }
        Ok(c)
    }

    /// Only parameter changes (a configuration or environment page's own form).
    pub fn params_only(&self) -> bool {
        !self.params.is_empty() && Changes { params: Default::default(), ..self.clone() }.is_empty()
    }

    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.description.is_none()
            && self.tags.is_none()
            && self.default_env.is_none()
            && self.body.is_empty()
            && self.params.is_empty()
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
        if let Some(e) = &self.default_env {
            let e = (!e.is_empty()).then(|| e.clone());
            if e != row.default_env {
                row.default_env = e;
                changed.push("defaultEnv".into());
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
        if self.default_env.is_some() {
            f.push("defaultEnv".into());
        }
        f.extend(self.body.keys().map(|k| format!("body.{k}")));
        f.extend(self.params.keys().map(|k| format!("params.{k}")));
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

/// Round 16: one item of `resources.upsertByKey`.
#[derive(Debug, Clone)]
pub struct UpsertItem {
    pub key: String,
    /// Field-wise changes of an existing resource (`name`, `description`, given `body` keys only).
    pub changes: Changes,
    /// What a new resource is created with (name, description, the kind's defaults with `body` on top).
    pub create: NewResource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveDest {
    Before(String),
    After(String),
    /// `None` = top level of the tree.
    Inside(Option<String>),
}

/// Round 18 (D442): most artifacts one plugin keeps beside one run.
pub const MAX_ARTIFACTS_PER_RUN: i64 = 100;

#[derive(Debug, Clone)]
pub enum Command {
    Create(NewResource),
    /// `overwrite`: fields the user chose to keep their own value for although they changed after
    /// `basis` (D374); they never count as a conflict.
    Update { id: String, changes: Changes, basis: Option<i64>, overwrite: Vec<String> },
    /// A parameter command (`params.set` / `unset` / `acknowledge`): an update audited under its own name.
    Params { id: String, changes: Changes, basis: Option<i64>, op: String },
    Move { id: String, dest: MoveDest },
    /// Deletion mark; a group goes together with all its descendants as one batch (§3.4).
    Delete { id: String },
    /// Record-only audit entry for writes outside the database (e.g. a plugin writing a file).
    Audit { op: String, object: String, summary: Value },
    /// Round 19: sets `ai_visible` on these resources (one audit row).
    AiVisible { ids: Vec<String>, visible: bool },
    /// D368: an audit row whose result is not `ok`: a host call that was cancelled or timed out
    /// (`result` = `cancelled` / `timeout`).
    Stopped { op: String, object: String, summary: Value, result: String },
    /// A call refused before it reached the database (e.g. a plugin's out-of-bounds host call):
    /// writes only the failure audit row (§4.3) and returns `error`.
    Refused { op: String, object: String, error: onedesk_protocol::ProtocolError },
    /// Adds or removes one granted folder of a plugin, read-modify-write in one transaction (D261).
    /// `replace`: the granted folder `folder` takes the place of (round 17).
    Grant { plugin: String, folder: String, add: bool, replace: Option<String> },
    /// Writes fields back from history as a `restore` revision (D278); `parent` restores the location.
    Restore { id: String, changes: Changes, parent: Option<Option<String>>, entry: String, version: Option<String> },
    /// Brings a whole deletion batch back (§3.4).
    Undelete { id: String },
    /// Erases a deleted resource (and its batch descendants) with all its history (§3.4).
    Purge { id: String },
    /// Local data in `resource_meta` (favorite, last use): no history, no audit (D279).
    Meta { id: String, favorite: Option<bool>, touch: bool },
    /// Interface state (§9.2): not versioned, not audited.
    UiSet { client: String, key: String, value: Value },
    /// Runs once when the writer starts.
    Startup,
    /// A run begins (§8); the writer gives it the next `seq`. Audited as `run.start`.
    RunInsert(Box<store::RunRow>),
    /// Throttled progress of a running run; not audited.
    RunProgress { id: String, progress: Value },
    /// A run ends (only a `running` one); audited as `run.end`; applies the retention rule (D288).
    RunFinish { id: String, status: String, summary: Option<Value>, error: Option<Value>, output: Option<Value> },
    RunKeep { id: String, kept: bool, name: Option<String> },
    /// Permanently removes a kept result after the user confirms (D420).
    RunDelete { id: String },
    /// Drops finished runs from the task panel.
    RunClearFinished,
    /// D484 §16: a stored file's row (the file is already written); blobs nobody used before `cutoff` go
    /// (`report.gone` lists them, for their files to be removed).
    BlobPut { info: onedesk_protocol::BlobInfo, cutoff: i64 },
    /// Round 18 (D442): a plugin keeps `data` (JSON text) beside a run; audited as `runs.saveArtifact`.
    ArtifactSave { id: String, run: String, plugin: String, name: String, kind: String, data: String },
    /// Round 18 (D442): removes one of the plugin's own; audited as `runs.deleteArtifact`.
    ArtifactDelete { id: String, plugin: String },
    /// Parameters of a plugin's state node (`enabled`, `settings.<name>`); `None` removes (D290).
    PluginState { plugin: String, set: Vec<(String, Option<String>)> },
    /// Many `PluginState`s in one transaction (start-up with many packages); audited per plugin.
    PluginStates(Vec<(String, StateSet)>),
    /// §7.6 takeover: every item (expected rev, new body) is written and rebound, or none is.
    Upgrade { plugin: String, to: String, items: Vec<UpgradeItem>, set_active: bool, prev_active: Option<String> },
    /// Rolls a batch back: items whose rev is still the upgraded one, plus `also` (D304).
    UndoUpgrade { batch: String, also: Vec<String> },
    /// A secret name exists (`true`) or not; the value is the keychain's (rule 7).
    SecretName { name: String, present: bool, audit: bool },
    /// One network call: one audit row per run and host, the rest counted (D309).
    /// `failed`: counted in `audit_counts.failures` (review #9); `error`: the row is written as failed.
    CountedAudit { run: Option<String>, op: String, object: String, summary: Value, failed: bool, error: Option<onedesk_protocol::ProtocolError> },
    /// A plugin's key-value storage, per plugin and version (D286); not audited.
    Storage { plugin: String, version: String, key: String, value: Option<String> },
    /// Round 5 (§3.5): everything of one import, in one transaction.
    Import(Box<crate::transfer::ImportPlan>),
    /// D487 §21 (K9): a read-only copy made or updated, in one transaction.
    ImportPackage(Box<crate::packages::PackagePlan>),
    /// Recomputes the whole `refs` table (§10: it can be rebuilt at any time).
    RebuildRefs,
    /// Review #7: follows changed reference-field declarations after the plugins were read again.
    SyncRefDecls,
    /// Round 12 (D394): one drop's writes — `Update`s and `Audit` rows only — in one transaction.
    Batch(Vec<Command>),
    /// Round 16: resources of one kind by external key, in one transaction; `others_missing`
    /// marks the kind's keyed resources not in `items` as missing (§3.3 `state`).
    Upsert { kind: String, items: Vec<UpsertItem>, others_missing: bool },
    /// Round 13 (D400): a new workspace's `init-settings.json`.
    InitSettings(Box<onedesk_protocol::WorkspaceSettingsSnapshot>),
}

/// What the kernel needs to know about a kind to validate writes.
#[derive(Debug, Clone, Default)]
pub struct KindRule {
    pub tree: Option<String>,
    /// Full kind names, or `*` for any kind of the same tree.
    pub accepts: Vec<String>,
    /// D311: body keys only a user may write (network-granting addresses, secret references).
    pub protected: Vec<String>,
    /// Round 5 (§10): body keys of text fields holding `[[name]]` references.
    pub text_refs: Vec<String>,
    /// Body keys of single-reference fields (`{ "ref": id }`).
    pub ref_fields: Vec<String>,
    /// D484 §16: body keys of attachment fields (`{ "blob": … }`).
    pub attachment_fields: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Outcome {
    /// The created or changed resource.
    pub id: Option<String>,
    pub changed: bool,
    /// Every row the command touched, after the change (deleted rows included).
    pub rows: Vec<Row>,
    /// Other resources whose references changed (§10: both ends get `resource:<id>`).
    pub touched: Vec<String>,
    /// What a command reports besides (round 16: `Upsert`'s counts and ids).
    pub report: Value,
}

impl Outcome {
    /// `tree:<id>` and `resource:<id>` topics to publish after commit.
    pub fn topics(&self) -> Vec<String> {
        let mut t = BTreeSet::new();
        for id in &self.touched {
            t.insert(format!("{}{id}", onedesk_protocol::topic::RESOURCE));
        }
        for r in &self.rows {
            if let Some(tree) = &r.tree {
                t.insert(format!("{}{tree}", onedesk_protocol::topic::TREE));
            }
            t.insert(format!("{}{}", onedesk_protocol::topic::RESOURCE, r.id));
        }
        t.into_iter().collect()
    }
}

enum Reply {
    Async(oneshot::Sender<KResult<Outcome>>),
    Blocking(mpsc::Sender<KResult<Outcome>>),
}

type Job = (Actor, Command, Reply);

/// Plugin state parameters to set (`None` removes one).
pub type StateSet = Vec<(String, Option<String>)>;

pub struct Pipeline {
    tx: std::sync::Mutex<Option<mpsc::Sender<Job>>>,
    /// Commands sent to the writer so far (tests: start-up writes in one batch).
    sent: std::sync::atomic::AtomicU64,
    thread: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl Pipeline {
    pub fn start(conn: Connection, rules: SharedRules) -> Pipeline {
        let (tx, rx) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("onedesk-writer".into())
            .spawn(move || {
                let mut w = Writer { conn, rules };
                // D273 default nodes and the search index, before any request (actor `core`).
                if let Err(e) = w.run(&Actor::Core, Command::Startup) {
                    eprintln!("onedesk: startup command failed: {e:?}");
                }
                let _ = ready_tx.send(());
                while let Ok((actor, cmd, reply)) = rx.recv() {
                    let out = w.run(&actor, cmd);
                    match reply {
                        Reply::Async(r) => {
                            let _ = r.send(out);
                        }
                        Reply::Blocking(r) => {
                            let _ = r.send(out);
                        }
                    }
                }
            })
            .expect("spawn writer thread");
        // Readers use their own connection: they must not run before the startup command committed.
        let _ = ready_rx.recv();
        Pipeline { tx: std::sync::Mutex::new(Some(tx)), sent: Default::default(), thread: std::sync::Mutex::new(Some(thread)) }
    }

    pub async fn execute(&self, actor: Actor, cmd: Command) -> KResult<Outcome> {
        self.sent.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (reply, rx) = oneshot::channel();
        let tx = self.tx.lock().unwrap().clone().ok_or_else(|| internal("pipeline stopped"))?;
        tx.send((actor, cmd, Reply::Async(reply))).map_err(|_| internal("writer thread gone"))?;
        rx.await.map_err(|_| internal("writer thread gone"))?
    }

    /// How many commands were sent to the writer.
    pub fn sent(&self) -> u64 {
        self.sent.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Queues a command without waiting for it (from code that cannot wait: a `Drop`).
    pub fn submit(&self, actor: Actor, cmd: Command) {
        self.sent.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (reply, _rx) = oneshot::channel();
        if let Some(tx) = self.tx.lock().unwrap().clone() {
            let _ = tx.send((actor, cmd, Reply::Async(reply)));
        }
    }

    /// The same, waiting on the calling thread (start-up code that is not async).
    pub fn execute_blocking(&self, actor: Actor, cmd: Command) -> KResult<Outcome> {
        self.sent.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (reply, rx) = mpsc::channel();
        let tx = self.tx.lock().unwrap().clone().ok_or_else(|| internal("pipeline stopped"))?;
        tx.send((actor, cmd, Reply::Blocking(reply))).map_err(|_| internal("writer thread gone"))?;
        rx.recv().map_err(|_| internal("writer thread gone"))?
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
    rules: SharedRules,
}

/// Kind rules of every installed plugin version; replaced when the plugins folder is read again.
pub type SharedRules = Arc<std::sync::RwLock<HashMap<String, KindRule>>>;

pub(crate) fn db_err(e: rusqlite::Error) -> onedesk_protocol::ProtocolError {
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
        let quiet = matches!(
            cmd,
            Command::Meta { .. } | Command::Startup | Command::RunProgress { .. } | Command::RunClearFinished | Command::Storage { .. }
        );
        let purge = matches!(cmd, Command::Purge { .. });
        let res = self.transact(actor, cmd);
        if purge && res.is_ok() {
            // D283: the WAL still holds the old pages; fold them in and cut the file to zero.
            let _ = self.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        }
        if let Some(e) = res.as_ref().err().filter(|_| !quiet) {
            // Failed or refused: data unchanged, the audit row is written on its own (§4.3).
            // Codes only: error params can carry user content (parameter names, fields).
            let summary = json!({ "code": e.code, "reason": e.params.get("reason") }).to_string();
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
        .map_err(db_err)?;
        Ok(Outcome::default())
    }

    fn transact(&mut self, actor: &Actor, cmd: Command) -> KResult<Outcome> {
        let rules = self.rules.read().unwrap().clone();
        // Round 19 (D448): an AI client writes nothing. Not a method list: whatever reaches the
        // writer for it is refused here; only the audit rows about its own calls pass.
        if matches!(actor, Actor::Ai { .. }) && !matches!(cmd, Command::Stopped { .. } | Command::Refused { .. }) {
            return Err(err_p(ErrorCode::Denied, &[("reason", "aiReadOnly")]));
        }
        let tx = self.conn.transaction().map_err(db_err)?;
        let mut out = {
            let mut cx = Tx { tx: &tx, actor, rules: &rules, at: now_ms(), touched: Default::default(), indexed: Default::default() };
            // D327: `protection.readonly` of the workspace configuration refuses every content write.
            if blocked_by_readonly(&cmd) {
                crate::policy::check(&tx, crate::policy::READONLY, None)?;
            }
            // D487 §21 (K9): a read-only copy is written only by its import.
            crate::packages::guard_copy(&tx, &cmd)?;
            let out = match cmd {
                Command::Create(n) => cx.create(n)?,
                Command::Update { id, changes, basis, overwrite } => cx.update(&id, &changes, basis, &overwrite)?,
                Command::Params { id, changes, basis, op } => cx.update_as(&id, &changes, basis, &[], "update", None, &op)?,
                Command::Move { id, dest } => cx.move_to(&id, dest)?,
                Command::Delete { id } => cx.delete(&id)?,
                Command::Audit { op, object, summary } => {
                    cx.audit(&op, &object, &summary)?;
                    Outcome { changed: true, ..Default::default() }
                }
                Command::Stopped { op, object, summary, result } => {
                    cx.tx
                        .execute(
                            "INSERT INTO audit (at, actor, op, object, summary, result) VALUES (?1,?2,?3,?4,?5,?6)",
                            params![cx.at, cx.actor.as_text(), op, object, summary.to_string(), result],
                        )
                        .map_err(db_err)?;
                    Outcome { changed: true, ..Default::default() }
                }
                Command::Refused { error, .. } => return Err(error),
                Command::Grant { plugin, folder, add, replace } => cx.grant(&plugin, &folder, add, replace.as_deref())?,
                Command::Restore { id, changes, parent, entry, version } => cx.restore(&id, &changes, parent, &entry, version.as_deref())?,
                Command::Undelete { id } => cx.undelete(&id)?,
                Command::Purge { id } => cx.purge(&id)?,
                Command::Meta { id, favorite, touch } => cx.meta(&id, favorite, touch)?,
                Command::AiVisible { ids, visible } => cx.ai_visible(&ids, visible)?,
                Command::Startup => cx.startup()?,
                Command::InitSettings(s) => cx.init_settings(&s)?,
                Command::RunInsert(r) => cx.run_insert(*r)?,
                Command::RunProgress { id, progress } => {
                    let n = cx
                        .tx
                        .execute("UPDATE runs SET progress = ?2 WHERE id = ?1 AND status = 'running'", params![id, progress.to_string()])
                        .map_err(db_err)?;
                    Outcome { changed: n > 0, ..Default::default() }
                }
                Command::RunFinish { id, status, summary, error, output } => cx.run_finish(&id, &status, summary, error, output)?,
                Command::RunKeep { id, kept, name } => {
                    let n = cx
                        .tx
                        .execute("UPDATE runs SET kept = ?2, kept_name = ?3 WHERE id = ?1", params![id, i64::from(kept), name])
                        .map_err(db_err)?;
                    if n == 0 {
                        return Err(not_found("run"));
                    }
                    cx.audit(if kept { "run.keep" } else { "run.unkeep" }, &id, &json!({}))?;
                    Outcome { id: Some(id), changed: true, rows: vec![], ..Default::default() }
                }
                Command::RunDelete { id } => {
                    let n = cx.tx.execute("DELETE FROM runs WHERE id = ?1 AND kept = 1", params![id]).map_err(db_err)?;
                    if n == 0 {
                        return Err(not_found("run"));
                    }
                    cx.audit("run.delete", &id, &json!({}))?;
                    Outcome { id: Some(id), changed: true, rows: vec![], ..Default::default() }
                }
                Command::ArtifactSave { id, run, plugin, name, kind, data } => {
                    let exists: bool = cx.tx.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE id = ?1)", [&run], |r| r.get(0)).map_err(db_err)?;
                    if !exists {
                        return Err(not_found("run"));
                    }
                    let n: i64 = cx
                        .tx
                        .query_row("SELECT count(*) FROM run_artifacts WHERE run_id = ?1 AND plugin = ?2", params![run, plugin], |r| r.get(0))
                        .map_err(db_err)?;
                    if n >= MAX_ARTIFACTS_PER_RUN {
                        return Err(err_p(ErrorCode::Conflict, &[("reason", "tooMany")]));
                    }
                    let bytes = data.len();
                    cx.tx
                        .execute(
                            "INSERT INTO run_artifacts (id, run_id, plugin, name, kind, data, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                            params![id, run, plugin, name, kind, data, cx.at],
                        )
                        .map_err(db_err)?;
                    cx.audit("runs.saveArtifact", &run, &json!({ "kind": kind, "bytes": bytes }))?;
                    Outcome { id: Some(id), changed: true, rows: vec![], ..Default::default() }
                }
                Command::ArtifactDelete { id, plugin } => {
                    let n = cx.tx.execute("DELETE FROM run_artifacts WHERE id = ?1 AND plugin = ?2", params![id, plugin]).map_err(db_err)?;
                    if n == 0 {
                        return Err(not_found("artifact"));
                    }
                    cx.audit("runs.deleteArtifact", &id, &json!({}))?;
                    Outcome { id: Some(id), changed: true, rows: vec![], ..Default::default() }
                }
                Command::BlobPut { info, cutoff } => {
                    cx.tx
                        .execute(
                            "INSERT INTO blobs (hash, type, size, width, height, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                             ON CONFLICT(hash) DO UPDATE SET created_at = excluded.created_at",
                            params![info.blob, info.r#type, info.size as i64, info.width, info.height, cx.at],
                        )
                        .map_err(db_err)?;
                    let gone = crate::blobs::unused_before(cx.tx, cutoff).map_err(db_err)?;
                    cx.audit("blob.put", &info.blob, &json!({ "type": info.r#type, "size": info.size }))?;
                    Outcome { changed: true, report: json!({ "gone": gone }), ..Default::default() }
                }
                Command::RunClearFinished => {
                    let n = cx.tx.execute("UPDATE runs SET in_task_panel = 0 WHERE status <> 'running' AND in_task_panel = 1", []).map_err(db_err)?;
                    Outcome { changed: n > 0, ..Default::default() }
                }
                Command::PluginState { plugin, set } => cx.plugin_state(&plugin, &set)?,
                Command::PluginStates(all) => {
                    for (plugin, set) in &all {
                        cx.plugin_state(plugin, set)?;
                    }
                    Outcome { changed: true, ..Default::default() }
                }
                Command::Upgrade { plugin, to, items, set_active, prev_active } => {
                    cx.upgrade(&plugin, &to, items, set_active, prev_active.as_deref())?
                }
                Command::UndoUpgrade { batch, also } => cx.undo_upgrade(&batch, &also)?,
                Command::SecretName { name, present, audit } => {
                    if present {
                        cx.tx
                            .execute(
                                "INSERT INTO secret_names (name, updated_at) VALUES (?1, ?2)
                                 ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at",
                                params![name, cx.at],
                            )
                            .map_err(db_err)?;
                    } else {
                        cx.tx.execute("DELETE FROM secret_names WHERE name = ?1", [&name]).map_err(db_err)?;
                    }
                    if audit {
                        cx.audit(if present { "secrets.set" } else { "secrets.delete" }, &name, &json!({}))?;
                    }
                    Outcome { changed: true, ..Default::default() }
                }
                Command::CountedAudit { run, op, object, summary, failed, error } => {
                    cx.counted_audit(run.as_deref(), &op, &object, &summary, failed, error.as_ref())?
                }
                Command::Storage { plugin, version, key, value } => {
                    match value {
                        Some(v) => cx.tx.execute(
                            "INSERT INTO plugin_storage (plugin, version, key, value) VALUES (?1, ?2, ?3, ?4)
                             ON CONFLICT(plugin, version, key) DO UPDATE SET value = excluded.value",
                            params![plugin, version, key, v],
                        ),
                        None => cx.tx.execute(
                            "DELETE FROM plugin_storage WHERE plugin = ?1 AND version = ?2 AND key = ?3",
                            params![plugin, version, key],
                        ),
                    }
                    .map_err(db_err)?;
                    Outcome { changed: true, ..Default::default() }
                }
                Command::Import(plan) => cx.import(*plan)?,
                Command::ImportPackage(plan) => cx.import_package(*plan)?,
                Command::RebuildRefs => {
                    crate::refs::rebuild(cx.tx, cx.rules).map_err(db_err)?;
                    crate::refs::store_decls(cx.tx, &crate::refs::decls(cx.rules)).map_err(db_err)?;
                    Outcome { changed: true, ..Default::default() }
                }
                Command::SyncRefDecls => {
                    let t = crate::refs::sync_decls(cx.tx, cx.rules).map_err(db_err)?;
                    let changed = !t.is_empty();
                    cx.touched.borrow_mut().extend(t);
                    Outcome { changed, ..Default::default() }
                }
                Command::Batch(cmds) => {
                    let mut all = Outcome::default();
                    for c in cmds {
                        let o = match c {
                            Command::Update { id, changes, basis, overwrite } => cx.update(&id, &changes, basis, &overwrite)?,
                            Command::Audit { op, object, summary } => {
                                cx.audit(&op, &object, &summary)?;
                                Outcome { changed: true, ..Default::default() }
                            }
                            _ => return Err(internal("batch: only updates and audit rows")),
                        };
                        all.changed |= o.changed;
                        if all.id.is_none() {
                            all.id = o.id;
                        }
                        all.rows.extend(o.rows);
                        all.touched.extend(o.touched);
                    }
                    all
                }
                Command::Upsert { kind, items, others_missing } => cx.upsert(&kind, items, others_missing)?,
                Command::UiSet { .. } => unreachable!("handled above"),
            };
            let touched = std::mem::take(&mut *cx.touched.borrow_mut());
            let bulk = cx.indexed.get() >= BULK_INDEX;
            (out, touched, bulk)
        };
        if out.2 {
            // See `Tx::index`: one merge drops the entries deleted without scrubbing, then
            // scrubbing is back on for the next transaction.
            tx.execute("INSERT INTO search (search) VALUES ('optimize')", []).map_err(db_err)?;
            tx.execute("INSERT INTO search (search, rank) VALUES ('secure-delete', 1)", []).map_err(db_err)?;
        }
        let ids: BTreeSet<&String> = out.0.rows.iter().map(|r| &r.id).collect();
        out.0.touched = out.1.into_iter().filter(|t| !ids.contains(t)).collect();
        let out = out.0;
        tx.commit().map_err(db_err)?;
        Ok(out)
    }
}

fn describe(cmd: &Command) -> (String, String) {
    match cmd {
        Command::Create(n) => ("resource.create".into(), n.kind.clone()),
        Command::Upsert { kind, .. } => ("resources.upsert".into(), kind.clone()),
        Command::Update { id, .. } => ("resource.update".into(), id.clone()),
        Command::Params { id, op, .. } => (op.clone(), id.clone()),
        Command::Move { id, .. } => ("resource.move".into(), id.clone()),
        Command::Delete { id } => ("resource.delete".into(), id.clone()),
        Command::Audit { op, object, .. } => (op.clone(), object.clone()),
        Command::Refused { op, object, .. } => (op.clone(), object.clone()),
        Command::Stopped { op, object, .. } => (op.clone(), object.clone()),
        Command::Grant { plugin, .. } => ("plugin.grant".into(), plugin.clone()),
        Command::UiSet { key, .. } => ("ui.set".into(), key.clone()),
        Command::Restore { id, .. } => ("resource.restore".into(), id.clone()),
        Command::Undelete { id } => ("resource.undelete".into(), id.clone()),
        Command::Purge { id } => ("resource.purge".into(), id.clone()),
        Command::Meta { id, .. } => ("resource.meta".into(), id.clone()),
        Command::AiVisible { ids, .. } => ("resource.aiVisible".into(), ids.first().cloned().unwrap_or_default()),
        Command::Startup => ("workspace.startup".into(), String::new()),
        Command::InitSettings(_) => (crate::workspace_settings::AUDIT_INIT_SETTINGS.into(), String::new()),
        Command::RunInsert(r) => ("run.start".into(), r.id.clone()),
        Command::RunProgress { id, .. } => ("run.progress".into(), id.clone()),
        Command::RunFinish { id, .. } => ("run.end".into(), id.clone()),
        Command::RunKeep { id, .. } => ("run.keep".into(), id.clone()),
        Command::RunDelete { id } => ("run.delete".into(), id.clone()),
        Command::RunClearFinished => ("run.clearFinished".into(), String::new()),
        Command::BlobPut { info, .. } => ("blob.put".into(), info.blob.clone()),
        Command::ArtifactSave { run, .. } => ("runs.saveArtifact".into(), run.clone()),
        Command::ArtifactDelete { id, .. } => ("runs.deleteArtifact".into(), id.clone()),
        Command::PluginState { plugin, .. } => ("plugin.state".into(), plugin.clone()),
        Command::PluginStates(_) => ("plugin.state".into(), String::new()),
        Command::Storage { plugin, .. } => ("plugin.storage".into(), plugin.clone()),
        Command::Upgrade { plugin, .. } => ("plugin.upgrade".into(), plugin.clone()),
        Command::UndoUpgrade { batch, .. } => ("plugin.undoUpgrade".into(), batch.clone()),
        Command::SecretName { name, present, .. } => ((if *present { "secrets.set" } else { "secrets.delete" }).into(), name.clone()),
        Command::CountedAudit { op, object, .. } => (op.clone(), object.clone()),
        Command::Import(plan) => ("workspace.import".into(), plan.source.clone()),
        Command::ImportPackage(plan) => ("package.import".into(), plan.pkg.root.clone()),
        Command::RebuildRefs => ("refs.rebuild".into(), String::new()),
        Command::SyncRefDecls => ("refs.sync".into(), String::new()),
        Command::Batch(cmds) => cmds
            .iter()
            .rev()
            .find(|c| matches!(c, Command::Audit { .. }))
            .map(describe)
            .unwrap_or_else(|| ("batch".into(), String::new())),
    }
}

/// D327: what `protection.readonly` refuses. Not: parameters themselves (else it could not be
/// turned off), secrets, interface state, favourites, audit, plugin state (enable, settings,
/// folders), runs already going, and a version switch that rewrites nothing.
fn blocked_by_readonly(cmd: &Command) -> bool {
    match cmd {
        Command::Create(_)
        | Command::Move { .. }
        | Command::Delete { .. }
        | Command::Restore { .. }
        | Command::Undelete { .. }
        | Command::Purge { .. }
        | Command::RunInsert(_)
        | Command::Storage { .. }
        | Command::Upsert { .. }
        | Command::Import(_)
        | Command::ImportPackage(_) => true,
        Command::Upgrade { items, .. } => !items.is_empty(),
        // Review #9: an empty save writes nothing; an undo that restores nothing is checked in place.
        Command::Update { changes, .. } => !changes.is_empty() && !changes.params_only(),
        Command::Batch(cmds) => cmds.iter().any(blocked_by_readonly),
        _ => false,
    }
}

pub(crate) struct Tx<'a> {
    pub tx: &'a Transaction<'a>,
    pub actor: &'a Actor,
    pub rules: &'a HashMap<String, KindRule>,
    pub at: i64,
    /// Resources whose references changed besides the rows of the outcome.
    pub touched: std::cell::RefCell<BTreeSet<String>>,
    /// Search rows rewritten in this transaction (see `index`).
    pub indexed: std::cell::Cell<usize>,
}

/// Search rows rewritten in one transaction after which old entries are no longer scrubbed one by
/// one (see `Tx::index`).
const BULK_INDEX: usize = 256;

impl Tx<'_> {
    /// Recomputes the references of `row` in the fields that changed (`None` = all), §10.
    pub fn refs_after(&self, row: &Row, changed: Option<&[String]>) -> KResult<()> {
        if let Some(rule) = self.rules.get(&row.kind) {
            let t = crate::refs::update(self.tx, rule, row, changed).map_err(db_err)?;
            self.touched.borrow_mut().extend(t);
            // D484 §16: the files it refers to now (kept for its history too).
            crate::blobs::record(self.tx, rule, row)?;
        }
        Ok(())
    }

    /// D330: references waiting for the name `row` now has.
    pub fn connect_name(&self, row: &Row) -> KResult<()> {
        let t = crate::refs::connect_name(self.tx, row).map_err(db_err)?;
        self.touched.borrow_mut().extend(t);
        Ok(())
    }

    /// Both ends of `id`'s references change how they look (rename, delete, restore, purge).
    pub fn touch_ends(&self, id: &str) -> KResult<()> {
        let mut t = self.touched.borrow_mut();
        for (src, _) in crate::refs::sources_of(self.tx, id, true).map_err(db_err)? {
            t.insert(src);
        }
        for r in crate::refs::rows_of(self.tx, id).map_err(db_err)? {
            t.extend(r.target);
        }
        Ok(())
    }

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
            Actor::Ai { .. } => Err(err_p(ErrorCode::Denied, &[("reason", "aiReadOnly")])),
        }
    }

    pub(crate) fn live(&self, id: &str) -> KResult<Row> {
        store::get(self.tx, id).map_err(db_err)?.ok_or_else(|| not_found("resource"))
    }

    /// Checks that `parent` (live, same tree) accepts `kind`.
    pub(crate) fn check_parent(&self, kind: &str, tree: Option<&str>, parent: Option<&str>) -> KResult<()> {
        // D473: a resource tree is always at the top.
        if kind == store::KIND_TREE && parent.is_some() {
            return Err(invalid("treeAtTop"));
        }
        let Some(pid) = parent else { return Ok(()) };
        let p = store::get(self.tx, pid).map_err(db_err)?.ok_or_else(|| invalid("parentNotFound"))?;
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

    pub(crate) fn next_pos(&self, tree: Option<&str>, parent: Option<&str>) -> KResult<i64> {
        self.tx
            .query_row(
                "SELECT COALESCE(MAX(pos) + 1, 0) FROM resources WHERE tree IS ?1 AND parent_id IS ?2 AND deleted_at IS NULL AND kind <> 'core:tree'",
                params![tree, parent],
                |r| r.get(0),
            )
            .map_err(db_err)
    }

    pub(crate) fn insert(&self, r: &Row) -> KResult<()> {
        self.tx.prepare_cached(&format!(
                    "INSERT INTO resources ({}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
                    store::COLUMNS
                )).map_err(db_err)?.execute(params![
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
                    r.deleted_at,
                    r.default_env
                ],
            )
            .map_err(db_err)?;
        self.index(r)
    }

    /// Keeps the search text of `r` in step with the row, in the same transaction (D277).
    fn index(&self, r: &Row) -> KResult<()> {
        // A scrubbing delete (D283, migration 0004) walks the whole entry list of every trigram of
        // the old text, and rows of one kind share most of theirs: rewriting n of them one by one
        // took n² (round 16, a batch of 1500 renames). From the BULK_INDEX-th row on, old entries are
        // only marked deleted; `transact` merges the index once before commit (as purge does), which
        // drops them, and turns scrubbing back on.
        let n = self.indexed.get() + 1;
        self.indexed.set(n);
        if n == BULK_INDEX {
            self.tx.execute("INSERT INTO search (search, rank) VALUES ('secure-delete', 0)", []).map_err(db_err)?;
        }
        // The search row shares the resource's rowid (migration 0003): no table scans.
        let rowid: i64 = self.tx.prepare_cached("SELECT rowid FROM resources WHERE id = ?1").map_err(db_err)?.query_row([&r.id], |x| x.get(0)).map_err(db_err)?;
        self.tx.prepare_cached("DELETE FROM search WHERE rowid = ?1").map_err(db_err)?.execute([rowid]).map_err(db_err)?;
        if r.deleted_at.is_none() && r.tree.as_deref() != Some(TREE_PLUGIN_STATE) {
            self.tx.prepare_cached("INSERT INTO search (rowid, name, text) VALUES (?1, ?2, ?3)").map_err(db_err)?.execute(params![rowid, r.name, search_text(r)])
                .map_err(db_err)?;
        }
        Ok(())
    }

    pub(crate) fn save(&self, r: &Row) -> KResult<()> {
        self.tx.prepare_cached("UPDATE resources SET parent_id=?2, pos=?3, name=?4, description=?5, tags=?6, body=?7, rev=?8,
                 updated_at=?9, updated_by=?10, deleted_at=?11, plugin_version=?12, default_env=?13 WHERE id=?1").map_err(db_err)?.execute(params![
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
                    r.deleted_at,
                    r.plugin_version,
                    r.default_env
                ],
            )
            .map_err(db_err)?;
        self.index(r)
    }

    pub(crate) fn revision(&self, r: &Row, op: &str, fields: &[String]) -> KResult<()> {
        self.revision_from(r, op, fields, None)
    }

    pub(crate) fn revision_from(&self, r: &Row, op: &str, fields: &[String], restored_from: Option<&str>) -> KResult<()> {
        self.tx.prepare_cached("INSERT INTO revisions (resource_id, rev, at, actor, op, fields, snapshot, restored_from)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)").map_err(db_err)?.execute(params![
                    r.id,
                    r.rev,
                    self.at,
                    self.actor.as_text(),
                    op,
                    serde_json::to_string(fields).expect("json"),
                    serde_json::to_string(r).expect("json"),
                    restored_from
                ],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub(crate) fn audit(&self, op: &str, object: &str, summary: &Value) -> KResult<()> {
        self.tx.prepare_cached("INSERT INTO audit (at, actor, op, object, summary, result) VALUES (?1,?2,?3,?4,?5,'ok')").map_err(db_err)?.execute(params![self.at, self.actor.as_text(), op, object, summary.to_string()],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// D311: a plugin may not set or change protected fields (grants are the user's to give).
    fn guard_protected(&self, kind: &str, old: Option<&JsonMap>, new: &JsonMap) -> KResult<()> {
        if !matches!(self.actor, Actor::Plugin { .. }) {
            return Ok(());
        }
        let protected = self.rules.get(kind).map(|r| r.protected.as_slice()).unwrap_or(&[]);
        for key in protected {
            let set = |v: &&Value| !v.is_null() && v.as_str() != Some("");
            let before = old.and_then(|b| b.get(key)).filter(set);
            let after = new.get(key).filter(set);
            if before != after {
                return Err(err_p(ErrorCode::Denied, &[("reason", "grantField"), ("field", key)]));
            }
        }
        Ok(())
    }

    pub(crate) fn create(&mut self, n: NewResource) -> KResult<Outcome> {
        self.permit(&n.kind)?;
        self.guard_protected(&n.kind, None, &n.body)?;
        let rule_tree = self.rule(&n.kind)?.tree.clone();
        let tree = if n.kind == KIND_GROUP { n.tree.clone().or(rule_tree) } else { rule_tree };
        // D473: the default resource tree starts without a name: the shell shows its own word for it.
        if n.name.trim().is_empty() && !(n.kind == store::KIND_TREE && n.body.get("default") == Some(&json!(true))) {
            return Err(invalid("emptyName"));
        }
        self.check_parent(&n.kind, tree.as_deref(), n.parent.as_deref())?;
        let actor = self.actor.as_text();
        // D473: trees are numbered among themselves, the other rows without them.
        let pos = if n.kind == store::KIND_TREE {
            self.tx
                .query_row("SELECT COALESCE(MAX(pos) + 1, 0) FROM resources WHERE kind = ?1 AND deleted_at IS NULL", [store::KIND_TREE], |r| r.get(0))
                .map_err(db_err)?
        } else {
            self.next_pos(tree.as_deref(), n.parent.as_deref())?
        };
        let row = Row {
            id: new_id(),
            kind: n.kind,
            plugin_version: n.plugin_version,
            pos,
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
            default_env: None,
        };
        self.insert(&row)?;
        self.refs_after(&row, None)?;
        self.connect_name(&row)?;
        let fields: Vec<String> = vec!["*".into()];
        self.revision(&row, "create", &fields)?;
        // No names or content in audit rows: they outlive a permanent deletion (§3.4).
        self.audit("resource.create", &row.id, &json!({ "kind": row.kind }))?;
        Ok(Outcome { id: Some(row.id.clone()), changed: true, rows: vec![row], ..Default::default() })
    }

    /// Round 16 (`resources.upsertByKey`): by external key — create, restore (deleted or missing),
    /// or commit the given fields only; tags, favourites and the location are never touched.
    fn upsert(&mut self, kind: &str, items: Vec<UpsertItem>, others_missing: bool) -> KResult<Outcome> {
        self.permit(kind)?;
        let (mut created, mut updated, mut unchanged, mut restored, mut missing) = (0u32, 0u32, 0u32, 0u32, 0u32);
        let mut ids = serde_json::Map::new();
        let mut rows = Vec::new();
        let mut seen = BTreeSet::new();
        for it in items {
            let found: Option<(String, Option<i64>, String)> = self
                .tx
                .prepare_cached("SELECT id, deleted_at, state FROM resources WHERE kind = ?1 AND external_key = ?2")
                .map_err(db_err)?
                .query_row(params![kind, it.key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()
                .map_err(db_err)?;
            let id = match found {
                None => {
                    let o = self.create(it.create)?;
                    let id = o.id.clone().unwrap_or_default();
                    self.tx.execute("UPDATE resources SET external_key = ?2 WHERE id = ?1", params![id, it.key]).map_err(db_err)?;
                    rows.extend(o.rows);
                    created += 1;
                    id
                }
                Some((id, deleted, state)) => {
                    let mut back = false;
                    if deleted.is_some() {
                        rows.extend(self.undelete(&id)?.rows);
                        back = true;
                    }
                    if state == store::STATE_MISSING {
                        self.set_state(&id, store::STATE_OK)?;
                        back = true;
                    }
                    let o = self.update(&id, &it.changes, None, &[])?;
                    let changed = o.changed;
                    rows.extend(o.rows);
                    if back {
                        rows.push(self.live(&id)?);
                        restored += 1;
                    } else if changed {
                        updated += 1;
                    } else {
                        unchanged += 1;
                    }
                    id
                }
            };
            seen.insert(id.clone());
            ids.insert(it.key, Value::String(id));
        }
        if others_missing {
            let stale: Vec<String> = {
                let mut st = self
                    .tx
                    .prepare("SELECT id FROM resources WHERE kind = ?1 AND external_key IS NOT NULL AND deleted_at IS NULL AND state <> ?2")
                    .map_err(db_err)?;
                let all = st.query_map(params![kind, store::STATE_MISSING], |r| r.get::<_, String>(0)).map_err(db_err)?;
                all.collect::<Result<Vec<_>, _>>().map_err(db_err)?
            };
            for id in stale.into_iter().filter(|i| !seen.contains(i)) {
                self.set_state(&id, store::STATE_MISSING)?;
                rows.push(self.live(&id)?);
                missing += 1;
            }
        }
        // One row per resource (the last state), for topics and events.
        let mut once = BTreeSet::new();
        rows.reverse();
        rows.retain(|r| once.insert(r.id.clone()));
        rows.reverse();
        let counts = json!({ "created": created, "updated": updated, "unchanged": unchanged, "restored": restored, "missing": missing });
        self.audit("resources.upsert", kind, &counts)?;
        let mut report = counts;
        report["ids"] = Value::Object(ids);
        Ok(Outcome { id: None, changed: !rows.is_empty(), rows, report, ..Default::default() })
    }

    /// §3.3 `state` (`ok` / `missing`): not a content change — no revision, no audit row of its own.
    fn set_state(&mut self, id: &str, state: &str) -> KResult<()> {
        self.tx.execute("UPDATE resources SET state = ?2 WHERE id = ?1", params![id, state]).map_err(db_err)?;
        Ok(())
    }

    fn update(&mut self, id: &str, changes: &Changes, basis: Option<i64>, overwrite: &[String]) -> KResult<Outcome> {
        self.update_as(id, changes, basis, overwrite, "update", None, "resource.update")
    }

    #[allow(clippy::too_many_arguments)]
    fn update_as(
        &mut self,
        id: &str,
        changes: &Changes,
        basis: Option<i64>,
        overwrite: &[String],
        op: &str,
        restored_from: Option<&str>,
        audit_op: &str,
    ) -> KResult<Outcome> {
        let mut row = self.live(id)?;
        // #2: a parameter table is changed parameter by parameter, never replaced whole.
        if crate::params::is_param_kind(&row.kind) && changes.body.contains_key(crate::params::PARAMS_KEY) {
            return Err(invalid("reservedField"));
        }
        self.permit(&row.kind)?;
        if changes.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
            return Err(invalid("emptyName"));
        }
        // D473: a default environment is an environment that exists.
        if let Some(e) = changes.default_env.as_deref().filter(|e| !e.is_empty()) {
            if store::get(self.tx, e).map_err(db_err)?.is_none_or(|r| r.kind != KIND_ENV) {
                return Err(invalid("notEnv"));
            }
        }
        if let Some(b) = basis {
            if b < row.rev {
                // D374: refuse only when one of *these* fields changed after `basis` (§4 并发规则, §9.3).
                let later = self.changed_since(&row, b)?;
                let clash: Vec<String> = changes
                    .fields()
                    .into_iter()
                    .filter(|f| !overwrite.contains(f))
                    .filter(|f| later.as_ref().is_none_or(|l| l.contains(f) || (f.starts_with("params.") && l.contains("*"))))
                    .collect();
                if let Some(first) = clash.first() {
                    let rev = row.rev.to_string();
                    return Err(err_p(
                        ErrorCode::Conflict,
                        &[("reason", "stale"), ("fields", &clash.join(",")), ("field", first), ("rev", &rev)],
                    ));
                }
            }
        }
        let before_body = row.body.clone();
        let mut changed = changes.apply(&mut row);
        self.guard_protected(&row.kind, Some(&before_body), &row.body)?;
        changed.extend(self.apply_params(&mut row, &changes.params)?);
        if changed.is_empty() {
            return Ok(Outcome { id: Some(row.id.clone()), changed: false, rows: vec![], ..Default::default() });
        }
        row.rev += 1;
        row.updated_at = self.at;
        row.updated_by = self.actor.as_text();
        self.save(&row)?;
        self.refs_after(&row, Some(&changed))?;
        if changed.iter().any(|f| f == "name") {
            self.touch_ends(&row.id)?;
            self.connect_name(&row)?;
        }
        self.revision_from(&row, op, &changed, restored_from)?;
        self.audit(audit_op, &row.id, &audit_fields(&changed))?;
        Ok(Outcome { id: Some(row.id.clone()), changed: true, rows: vec![row], ..Default::default() })
    }

    /// The bind paths whose value differs between revision `basis` and `row` (name, description,
    /// tags, top-level `body.*`, by comparing the stored snapshot), plus the `params.*` recorded
    /// after it. `None` when that revision is no longer in the history: every field counts as changed.
    fn changed_since(&self, row: &Row, basis: i64) -> KResult<Option<BTreeSet<String>>> {
        let snap: Option<String> = self
            .tx
            .prepare_cached("SELECT snapshot FROM revisions WHERE resource_id = ?1 AND rev = ?2")
            .map_err(db_err)?
            .query_row(params![row.id, basis], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        let Some(old) = snap.and_then(|s| serde_json::from_str::<Row>(&s).ok()) else {
            return Ok(None);
        };
        let mut out = BTreeSet::new();
        if old.name != row.name {
            out.insert("name".to_string());
        }
        if old.description != row.description {
            out.insert("description".to_string());
        }
        if old.tags != row.tags {
            out.insert("tags".to_string());
        }
        if old.default_env != row.default_env {
            out.insert("defaultEnv".to_string());
        }
        for k in old.body.keys().chain(row.body.keys()) {
            if old.body.get(k) != row.body.get(k) {
                out.insert(format!("body.{k}"));
            }
        }
        let mut st = self
            .tx
            .prepare_cached("SELECT fields FROM revisions WHERE resource_id = ?1 AND rev > ?2")
            .map_err(db_err)?;
        let later = st
            .query_map(params![row.id, basis], |r| r.get::<_, String>(0))
            .map_err(db_err)?
            .filter_map(|f| f.ok())
            .flat_map(|f| serde_json::from_str::<Vec<String>>(&f).unwrap_or_default())
            .filter(|f| f.starts_with("params.") || f == "*");
        out.extend(later);
        Ok(Some(out))
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
            store::get(self.tx, aid).map_err(db_err)?.ok_or_else(|| invalid("targetNotFound"))
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
            if store::ancestors(self.tx, &pr).map_err(db_err)?.iter().any(|a| a.id == id) {
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
                    .map_err(db_err)?;
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
            return Ok(Outcome { id: Some(row.id.clone()), changed: false, rows: vec![], ..Default::default() });
        }
        row.rev += 1;
        row.updated_at = self.at;
        row.updated_by = self.actor.as_text();
        self.save(&row)?;
        if row.kind == KIND_CONFIG && changed.iter().any(|f| f == "parent") {
            self.check_config_subtree(&row)?;
        }
        self.revision(&row, "move", &changed)?;
        self.audit("resource.move", &row.id, &json!({ "parent": row.parent_id, "pos": row.pos }))?;
        Ok(Outcome { id: Some(row.id.clone()), changed: true, rows: vec![row], ..Default::default() })
    }

    /// Round 17 (X18): every change of the granted folders gets its own audit row
    /// (`plugin.grantFolder`, `plugin.revokeFolder`, `plugin.replaceFolder`).
    fn grant(&mut self, plugin: &str, folder: &str, add: bool, replace: Option<&str>) -> KResult<Outcome> {
        let out = self.grant_list(plugin, folder, add, replace)?;
        if out.changed {
            let (op, summary) = match (add, replace) {
                (_, Some(from)) => ("plugin.replaceFolder", json!({ "folder": folder, "from": from })),
                (true, None) => ("plugin.grantFolder", json!({ "folder": folder })),
                (false, None) => ("plugin.revokeFolder", json!({ "folder": folder })),
            };
            self.audit(op, plugin, &summary)?;
        }
        Ok(out)
    }

    fn grant_list(&mut self, plugin: &str, folder: &str, add: bool, replace: Option<&str>) -> KResult<Outcome> {
        let key = GRANTS_KEY;
        let row = store::plugin_state(self.tx, plugin).map_err(db_err)?;
        let mut folders: Vec<String> = row
            .as_ref()
            .and_then(|r| r.body.get(key).cloned())
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        let before = folders.clone();
        if let Some(from) = replace {
            let Some(i) = folders.iter().position(|f| f == from) else { return Err(not_found("grant")) };
            if folders.iter().any(|f| f == folder) {
                folders.remove(i);
            } else {
                folders[i] = folder.to_string();
            }
        } else if add {
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
                self.update(&r.id, &changes, None, &[])
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

    fn apply_params(&self, row: &mut Row, changes: &std::collections::BTreeMap<String, ParamChange>) -> KResult<Vec<String>> {
        if changes.is_empty() {
            return Ok(vec![]);
        }
        if !crate::params::is_param_kind(&row.kind) {
            return Err(invalid("notParamNode"));
        }
        let ancestors = store::ancestors(self.tx, row).map_err(db_err)?;
        let mut changed = Vec::new();
        for (name, ch) in changes {
            if name.trim().is_empty() {
                return Err(invalid("emptyName"));
            }
            let old = crate::params::get(row, name);
            let inherited = crate::params::inherited(&ancestors, name)
                .map(|(p, src)| crate::params::BasedOn { value: p.value, source: src.id.clone() });
            let new = match ch {
                ParamChange::Set { value, ty } => {
                    Some(crate::params::Param {
                        ty: ty.or(old.as_ref().map(|o| o.ty)).unwrap_or(ParamType::Text),
                        value: value.clone(),
                        // Keep the recorded basis; a fresh override records what it overrides.
                        based_on: old.as_ref().and_then(|o| o.based_on.clone()).or(inherited),
                    })
                }
                ParamChange::Unset => None,
                ParamChange::Acknowledge => old.clone().map(|o| crate::params::Param { based_on: inherited, ..o }),
                ParamChange::Exact(p) => p.clone(),
            };
            if let Some(n) = &new {
                // D306: a secret parameter holds the *name* of an existing secret, never a value.
                if n.ty == ParamType::Secret && old.as_ref() != Some(n) {
                    let known: bool = self
                        .tx
                        .query_row("SELECT EXISTS(SELECT 1 FROM secret_names WHERE name = ?1)", [&n.value], |r| r.get(0))
                        .map_err(db_err)?;
                    if !known {
                        return Err(invalid("unknownSecret"));
                    }
                }
                if old.is_none() && row.kind == KIND_CONFIG {
                    self.check_config_name(row, name)?;
                }
            }
            if new != old {
                crate::params::put(row, name, new.as_ref());
                changed.push(format!("params.{name}"));
            }
        }
        Ok(changed)
    }

    /// §6.2: in the configuration tree a name may only repeat along one ancestor line.
    fn check_config_name(&self, row: &Row, name: &str) -> KResult<()> {
        let mine: BTreeSet<String> = store::ancestors(self.tx, row).map_err(db_err)?.into_iter().map(|a| a.id).collect();
        for other in store::of_kind(self.tx, KIND_CONFIG).map_err(db_err)? {
            if other.id == row.id || crate::params::get(&other, name).is_none() || mine.contains(&other.id) {
                continue;
            }
            let theirs = store::ancestors(self.tx, &other).map_err(db_err)?;
            if !theirs.iter().any(|a| a.id == row.id) {
                return Err(err_p(ErrorCode::Invalid, &[("reason", "duplicateName"), ("name", name)]));
            }
        }
        Ok(())
    }

    /// Every parameter name of `row` against the same-name rule (§6.2).
    fn check_config_node(&self, row: &Row) -> KResult<()> {
        for name in crate::params::params_of(row).keys() {
            self.check_config_name(row, name)?;
        }
        Ok(())
    }

    /// A configuration node that moved: itself and everything below it.
    fn check_config_subtree(&self, row: &Row) -> KResult<()> {
        self.check_config_node(row)?;
        for d in store::descendants(self.tx, &row.id).map_err(db_err)? {
            if d.kind == KIND_CONFIG {
                self.check_config_node(&d)?;
            }
        }
        Ok(())
    }

    fn restore(&mut self, id: &str, changes: &Changes, parent: Option<Option<String>>, entry: &str, version: Option<&str>) -> KResult<Outcome> {
        if let Some(p) = parent {
            let mut out = self.move_to(id, MoveDest::Inside(p))?;
            if out.changed {
                // Mark the move revision as a restore of `entry`.
                self.tx
                    .execute(
                        "UPDATE revisions SET op = 'restore', restored_from = ?3 WHERE resource_id = ?1 AND rev = ?2",
                        params![id, out.rows[0].rev, entry],
                    )
                    .map_err(db_err)?;
            }
            out.id = Some(id.to_string());
            return Ok(out);
        }
        let mut out = self.update_as(id, changes, None, &[], "restore", Some(entry), "resource.restore")?;
        // §7.6 / review #10: the restored content comes with the version that handles it.
        if let Some(v) = version {
            let mut row = self.live(id)?;
            if row.plugin_version.as_deref() != Some(v) {
                row.plugin_version = Some(v.to_string());
                row.rev += 1;
                row.updated_at = self.at;
                row.updated_by = self.actor.as_text();
                self.save(&row)?;
                self.revision_from(&row, "restore", &["pluginVersion".to_string()], Some(entry))?;
                out.rows = vec![row];
                out.changed = true;
            }
        }
        Ok(out)
    }

    fn undelete(&mut self, id: &str) -> KResult<Outcome> {
        let row = store::get_any(self.tx, id).map_err(db_err)?.ok_or_else(|| not_found("resource"))?;
        if row.deleted_at.is_none() {
            return Err(invalid("notDeleted"));
        }
        self.permit(&row.kind)?;
        let batch_id = store::delete_batch(self.tx, id).map_err(db_err)?.ok_or_else(|| invalid("notDeleted"))?;
        let mut batch = store::batch_rows(self.tx, &batch_id).map_err(db_err)?;
        let ids: BTreeSet<String> = batch.iter().map(|r| r.id.clone()).collect();
        // Tops first so their new positions are known before the inner rows come back.
        batch.sort_by_key(|r| r.parent_id.as_ref().is_some_and(|p| ids.contains(p)));
        for r in &mut batch {
            let mut fields = vec!["deleted".to_string()];
            let top = !r.parent_id.as_ref().is_some_and(|p| ids.contains(p));
            if top {
                let parent_live = match &r.parent_id {
                    Some(p) => store::get(self.tx, p).map_err(db_err)?.is_some(),
                    None => true,
                };
                if !parent_live {
                    // The old parent is gone: back to the top level of the tree (§3.4).
                    r.parent_id = None;
                    fields.push("parent".into());
                }
                r.pos = self.next_pos(r.tree.as_deref(), r.parent_id.as_deref())?;
            }
            r.deleted_at = None;
            r.rev += 1;
            r.updated_at = self.at;
            r.updated_by = self.actor.as_text();
            self.save(r)?;
            self.tx.execute("UPDATE resources SET delete_batch = NULL WHERE id = ?1", [&r.id]).map_err(db_err)?;
            self.revision(r, "undelete", &fields)?;
            self.touch_ends(&r.id)?;
        }
        for r in &batch {
            self.connect_name(r)?;
        }
        for r in batch.iter().filter(|r| r.kind == KIND_CONFIG) {
            self.check_config_node(r)?;
        }
        self.audit("resource.undelete", id, &json!({ "batch": batch_id, "count": batch.len() }))?;
        Ok(Outcome { id: Some(id.to_string()), changed: true, rows: batch, ..Default::default() })
    }

    fn purge(&mut self, id: &str) -> KResult<Outcome> {
        let row = store::get_any(self.tx, id).map_err(db_err)?.ok_or_else(|| not_found("resource"))?;
        if row.deleted_at.is_none() {
            return Err(invalid("notDeleted"));
        }
        self.permit(&row.kind)?;
        // The row and its descendants of the same deletion batch (#4: another batch is left alone).
        let batch = store::delete_batch(self.tx, id).map_err(db_err)?;
        let mut doomed = vec![row.clone()];
        let mut queue = vec![row.id.clone()];
        let mut seen = std::collections::HashSet::from([row.id.clone()]);
        let mut st = self
            .tx
            .prepare_cached(&format!(
                "SELECT {} FROM resources WHERE parent_id = ?1 AND deleted_at IS NOT NULL AND delete_batch IS ?2",
                store::COLUMNS
            ))
            .map_err(db_err)?;
        while let Some(p) = queue.pop() {
            for r in st.query_map(params![&p, &batch], store::from_row).map_err(db_err)? {
                let r = r.map_err(db_err)?;
                if !seen.insert(r.id.clone()) {
                    continue;
                }
                queue.push(r.id.clone());
                doomed.push(r);
            }
        }
        drop(st);
        for r in &doomed {
            // §10: its own references go; references to it stay, without a target ("missing").
            self.touch_ends(&r.id)?;
            self.tx.execute("DELETE FROM refs WHERE source_id = ?1", [&r.id]).map_err(db_err)?;
            self.tx.execute("UPDATE refs SET target_id = NULL WHERE target_id = ?1", [&r.id]).map_err(db_err)?;
            // D484 §16: its files are no longer kept for it (unused ones go a day after they came).
            self.tx.execute("DELETE FROM blob_uses WHERE resource_id = ?1", [&r.id]).map_err(db_err)?;
            self.tx
                .execute("DELETE FROM search WHERE rowid = (SELECT rowid FROM resources WHERE id = ?1)", [&r.id])
                .map_err(db_err)?;
            for table in ["DELETE FROM resources WHERE id = ?1", "DELETE FROM revisions WHERE resource_id = ?1",
                          "DELETE FROM resource_meta WHERE resource_id = ?1", "DELETE FROM runs WHERE resource_id = ?1"] {
                self.tx.execute(table, [&r.id]).map_err(db_err)?;
            }
        }
        // Drop deleted entries from the full-text segments too.
        self.tx.execute("INSERT INTO search (search) VALUES ('optimize')", []).map_err(db_err)?;
        self.audit("resource.purge", id, &json!({ "kind": row.kind, "count": doomed.len() }))?;
        Ok(Outcome { id: Some(id.to_string()), changed: true, rows: doomed, ..Default::default() })
    }

    /// Round 19 (D448): `ai_visible` of live resources the user sees in a tree.
    fn ai_visible(&mut self, ids: &[String], visible: bool) -> KResult<Outcome> {
        let mut rows = Vec::new();
        for id in ids {
            let row = self.live(id)?;
            if row.tree.is_none() || row.tree.as_deref() == Some(TREE_PLUGIN_STATE) {
                return Err(not_found("resource"));
            }
            let n = self
                .tx
                .execute("UPDATE resources SET ai_visible = ?2 WHERE id = ?1 AND ai_visible <> ?2", params![id, i64::from(visible)])
                .map_err(db_err)?;
            if n > 0 {
                rows.push(row);
            }
        }
        self.audit("resource.aiVisible", ids.first().map(String::as_str).unwrap_or(""), &json!({ "visible": visible, "count": rows.len() }))?;
        Ok(Outcome { id: ids.first().cloned(), changed: !rows.is_empty(), rows, ..Default::default() })
    }

    fn meta(&mut self, id: &str, favorite: Option<bool>, touch: bool) -> KResult<Outcome> {
        let row = self.live(id)?;
        if row.tree.as_deref() == Some(TREE_PLUGIN_STATE) {
            return Err(not_found("resource"));
        }
        self.tx
            .execute("INSERT INTO resource_meta (resource_id) VALUES (?1) ON CONFLICT(resource_id) DO NOTHING", [id])
            .map_err(db_err)?;
        if let Some(f) = favorite {
            self.tx
                .execute("UPDATE resource_meta SET favorite = ?2 WHERE resource_id = ?1", params![id, i64::from(f)])
                .map_err(db_err)?;
        }
        if touch {
            self.tx
                .execute(
                    "UPDATE resource_meta SET last_used_at = ?2, use_count = use_count + 1 WHERE resource_id = ?1",
                    params![id, self.at],
                )
                .map_err(db_err)?;
        }
        Ok(Outcome { id: Some(id.to_string()), changed: true, rows: vec![], ..Default::default() })
    }

    /// D273: a root `Default` environment and a root `Workspace` configuration node;
    /// D277: (re)builds the search index when it was never built.
    fn startup(&mut self) -> KResult<Outcome> {
        // §8: a run that was going when the worker stopped will never finish.
        let error = json!({ "code": "interrupted", "message": "" }).to_string();
        let leftovers: Vec<String> = {
            let mut st = self.tx.prepare("SELECT id FROM runs WHERE status = 'running'").map_err(db_err)?;
            let ids = st.query_map([], |r| r.get(0)).map_err(db_err)?.collect::<Result<_, _>>().map_err(db_err)?;
            ids
        };
        self.tx
            .execute(
                "UPDATE runs SET status = 'error', error = ?1, ended_at = ?2, progress = NULL WHERE status = 'running'",
                params![error, self.at],
            )
            .map_err(db_err)?;
        for id in &leftovers {
            self.audit("run.end", id, &json!({ "status": "error", "code": "interrupted" }))?;
        }
        let mut rows = Vec::new();
        for (kind, name) in [(KIND_ENV, "Default"), (KIND_CONFIG, "Workspace")] {
            let has_root: bool = self
                .tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM resources WHERE kind = ?1 AND parent_id IS NULL AND deleted_at IS NULL)",
                    [kind],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if !has_root {
                let out = self.create(NewResource {
                    kind: kind.into(),
                    tree: None,
                    parent: None,
                    name: name.into(),
                    description: String::new(),
                    tags: vec![],
                    body: JsonMap::new(),
                    plugin_version: None,
                })?;
                rows.extend(out.rows);
            }
        }
        // D473: the default resource tree (the top level of `resources`) has a node of its own.
        if !store::resource_trees(self.tx).map_err(db_err)?.iter().any(store::is_default_tree) {
            let mut body = JsonMap::new();
            body.insert("default".into(), json!(true));
            let out = self.create(NewResource {
                kind: store::KIND_TREE.into(),
                tree: None,
                parent: None,
                name: String::new(),
                description: String::new(),
                tags: vec![],
                body,
                plugin_version: None,
            })?;
            rows.extend(out.rows);
        }
        let built: bool = self
            .tx
            .query_row("SELECT EXISTS(SELECT 1 FROM meta WHERE key = 'search_built')", [], |r| r.get(0))
            .map_err(db_err)?;
        if !built {
            self.tx.execute("DELETE FROM search", []).map_err(db_err)?;
            let mut st = self
                .tx
                .prepare(&format!("SELECT {} FROM resources WHERE deleted_at IS NULL", store::COLUMNS))
                .map_err(db_err)?;
            let all: Vec<Row> = st.query_map([], store::from_row).map_err(db_err)?.collect::<Result<_, _>>().map_err(db_err)?;
            drop(st);
            for r in &all {
                self.index(r)?;
            }
            self.tx.execute("INSERT INTO meta (key, value) VALUES ('search_built', '1')", []).map_err(db_err)?;
        }
        // §10 / migration 0008: references of the resources that existed before the table did.
        let refs_built: bool = self
            .tx
            .query_row("SELECT EXISTS(SELECT 1 FROM meta WHERE key = 'refs_built')", [], |r| r.get(0))
            .map_err(db_err)?;
        if !refs_built {
            crate::refs::rebuild(self.tx, self.rules).map_err(db_err)?;
            crate::refs::store_decls(self.tx, &crate::refs::decls(self.rules)).map_err(db_err)?;
            self.tx.execute("INSERT INTO meta (key, value) VALUES ('refs_built', '1')", []).map_err(db_err)?;
        } else {
            // Review #7: plugins that changed while the worker was off.
            crate::refs::sync_decls(self.tx, self.rules).map_err(db_err)?;
        }
        Ok(Outcome { changed: !rows.is_empty(), rows, ..Default::default() })
    }

    fn run_insert(&mut self, mut r: store::RunRow) -> KResult<Outcome> {
        r.seq = self.tx.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM runs", [], |x| x.get(0)).map_err(db_err)?;
        r.started_at = self.at;
        if r.actor.is_empty() {
            r.actor = self.actor.as_text();
        }
        let j = |v: &Value| v.to_string();
        let o = |v: &Option<Value>| v.as_ref().map(|v| v.to_string());
        self.tx
            .execute(
                &format!(
                    "INSERT INTO runs ({}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)",
                    store::RUN_COLUMNS
                ),
                params![
                    r.id, r.seq, r.title, r.icon, r.resource_id, r.resource_kind, r.plugin, r.action, j(&r.action_label),
                    r.tab_id, r.env_id, r.env_name, r.actor, r.source, r.started_at, r.ended_at, r.status, j(&r.params),
                    j(&r.input), o(&r.progress), o(&r.summary), o(&r.error), o(&r.output), i64::from(r.kept), r.kept_name,
                    i64::from(r.in_task_panel)
                ],
            )
            .map_err(db_err)?;
        self.audit("run.start", &r.id, &json!({ "action": r.action, "resource": r.resource_id }))?;
        Ok(Outcome { id: Some(r.id), changed: true, rows: vec![], ..Default::default() })
    }

    fn run_finish(
        &mut self,
        id: &str,
        status: &str,
        summary: Option<Value>,
        error: Option<Value>,
        output: Option<Value>,
    ) -> KResult<Outcome> {
        let o = |v: &Option<Value>| v.as_ref().map(|v| v.to_string());
        let n = self
            .tx
            .execute(
                "UPDATE runs SET status = ?2, ended_at = ?3, summary = ?4, error = ?5, output = ?6, progress = NULL
                 WHERE id = ?1 AND status = 'running'",
                params![id, status, self.at, o(&summary), o(&error), o(&output)],
            )
            .map_err(db_err)?;
        if n == 0 {
            return Ok(Outcome::default());
        }
        let code = error.as_ref().and_then(|e| e.get("code")).cloned();
        self.audit("run.end", id, &json!({ "status": status, "code": code }))?;
        // D288 retention: newest 200 per resource (or per action without a resource); kept ones stay.
        let (resource, action): (Option<String>, String) =
            self.tx.query_row("SELECT resource_id, action FROM runs WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db_err)?;
        let (cond, arg) = match &resource {
            Some(rid) => ("resource_id = ?1", rid.clone()),
            None => ("resource_id IS NULL AND action = ?1", action),
        };
        self.tx
            .execute(
                &format!(
                    "DELETE FROM runs WHERE {cond} AND kept = 0 AND status <> 'running'
                     AND id NOT IN (SELECT id FROM runs WHERE {cond} ORDER BY seq DESC LIMIT {RUNS_KEPT})"
                ),
                [arg],
            )
            .map_err(db_err)?;
        Ok(Outcome { id: Some(id.to_string()), changed: true, rows: vec![], ..Default::default() })
    }

    /// Edits parameters of a plugin's state node, creating the node when needed.
    pub(crate) fn plugin_state(&mut self, plugin: &str, set: &[(String, Option<String>)]) -> KResult<Outcome> {
        let existing = store::plugin_state(self.tx, plugin).map_err(db_err)?;
        let mut row = match existing.clone() {
            Some(r) => r,
            None => {
                let out = self.create(NewResource {
                    kind: KIND_PLUGIN_STATE.into(),
                    tree: None,
                    parent: None,
                    name: plugin.into(),
                    description: String::new(),
                    tags: vec![],
                    body: JsonMap::new(),
                    plugin_version: None,
                })?;
                out.rows.into_iter().next().ok_or_else(|| internal("no row"))?
            }
        };
        let mut changed = Vec::new();
        for (name, value) in set {
            let old = crate::params::get(&row, name);
            let new = value.as_ref().map(|v| crate::params::Param { ty: ParamType::Text, value: v.clone(), based_on: None });
            if old.as_ref().map(|p| &p.value) != new.as_ref().map(|p| &p.value) {
                crate::params::put(&mut row, name, new.as_ref());
                changed.push(format!("params.{name}"));
            }
        }
        if changed.is_empty() {
            return Ok(Outcome { id: Some(row.id.clone()), changed: existing.is_none(), rows: vec![row], ..Default::default() });
        }
        row.rev += 1;
        row.updated_at = self.at;
        row.updated_by = self.actor.as_text();
        self.save(&row)?;
        self.revision(&row, "update", &changed)?;
        self.audit("plugin.state", plugin, &json!({ "fields": changed }))?;
        Ok(Outcome { id: Some(row.id.clone()), changed: true, rows: vec![row], ..Default::default() })
    }

    fn upgrade(&mut self, plugin: &str, to: &str, items: Vec<UpgradeItem>, set_active: bool, prev_active: Option<&str>) -> KResult<Outcome> {
        let batch = new_id();
        let mut rows = Vec::new();
        let mut from: BTreeSet<String> = BTreeSet::new();
        for it in items {
            let mut row = self.live(&it.id)?;
            if row.rev != it.rev {
                // Changed while the new bodies were computed: nothing is written (D301).
                return Err(err_p(ErrorCode::Conflict, &[("reason", "changedDuringUpgrade")]));
            }
            let old_version = row.plugin_version.clone().unwrap_or_default();
            from.insert(old_version.clone());
            let mut changed: Vec<String> = Vec::new();
            let keys: BTreeSet<&String> = row.body.keys().chain(it.body.keys()).collect();
            for k in keys {
                if row.body.get(k) != it.body.get(k) {
                    changed.push(format!("body.{k}"));
                }
            }
            changed.push("pluginVersion".into());
            row.body = it.body;
            row.plugin_version = Some(to.to_string());
            row.rev += 1;
            row.updated_at = self.at;
            row.updated_by = self.actor.as_text();
            self.save(&row)?;
            self.refs_after(&row, Some(&changed))?;
            self.revision(&row, "upgrade", &changed)?;
            self.tx
                .execute(
                    "INSERT INTO upgrade_items (batch, resource_id, old_version, old_rev, new_rev) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![batch, row.id, old_version, it.rev, row.rev],
                )
                .map_err(db_err)?;
            rows.push(row);
        }
        if !rows.is_empty() {
            let from_text = from.into_iter().collect::<Vec<_>>().join(",");
            self.tx
                .execute(
                    "INSERT INTO upgrade_batches (id, plugin, from_version, to_version, at, prev_active) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![batch, plugin, from_text, to, self.at, prev_active],
                )
                .map_err(db_err)?;
        }
        if set_active {
            self.plugin_state(plugin, &[("active".into(), Some(to.to_string()))])?;
        }
        self.audit("plugin.upgrade", plugin, &json!({ "to": to, "count": rows.len(), "batch": (!rows.is_empty()).then_some(&batch) }))?;
        Ok(Outcome { id: (!rows.is_empty()).then_some(batch), changed: true, rows, ..Default::default() })
    }

    fn undo_upgrade(&mut self, batch: &str, also: &[String]) -> KResult<Outcome> {
        let (plugin, from, undone, prev_active): (String, String, Option<i64>, Option<String>) = self
            .tx
            .query_row("SELECT plugin, from_version, undone_at, prev_active FROM upgrade_batches WHERE id = ?1", [batch], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(|_| not_found("batch"))?;
        if undone.is_some() {
            return Err(invalid("alreadyUndone"));
        }
        let items: Vec<(String, String, i64, i64)> = {
            let mut st = self
                .tx
                .prepare("SELECT resource_id, old_version, old_rev, new_rev FROM upgrade_items WHERE batch = ?1")
                .map_err(db_err)?;
            let v = st.query_map([batch], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(db_err)?;
            v.collect::<Result<_, _>>().map_err(db_err)?
        };
        let mut rows = Vec::new();
        let mut modified = Vec::new();
        for (id, old_version, old_rev, new_rev) in items {
            let Some(mut row) = store::get(self.tx, &id).map_err(db_err)? else { continue };
            if row.rev != new_rev && !also.contains(&id) {
                modified.push(json!({ "id": row.id, "name": row.name }));
                continue;
            }
            let snap: String = self
                .tx
                .query_row("SELECT snapshot FROM revisions WHERE resource_id = ?1 AND rev = ?2", params![id, old_rev], |r| r.get(0))
                .map_err(db_err)?;
            if rows.is_empty() {
                // D327 / review #9: refused only when the undo really rewrites resources.
                crate::policy::check(self.tx, crate::policy::READONLY, None)?;
            }
            let before: Row = serde_json::from_str(&snap).map_err(internal)?;
            row.body = before.body;
            row.plugin_version = Some(old_version);
            row.rev += 1;
            row.updated_at = self.at;
            row.updated_by = self.actor.as_text();
            self.save(&row)?;
            self.refs_after(&row, None)?;
            self.revision(&row, "undoUpgrade", &["body".to_string(), "pluginVersion".to_string()])?;
            rows.push(row);
        }
        self.tx.execute("UPDATE upgrade_batches SET undone_at = ?2 WHERE id = ?1", params![batch, self.at]).map_err(db_err)?;
        // D304/D314: the active version goes back to what it was before the takeover (or the
        // lowest version the batch came from, by semver), and is pinned so it is not upgraded again.
        let lowest = from
            .split(',')
            .filter(|v| !v.is_empty())
            .min_by_key(|v| semver::Version::parse(v).unwrap_or(semver::Version::new(0, 0, 0)))
            .map(String::from);
        if let Some(v) = prev_active.or(lowest) {
            self.plugin_state(&plugin, &[("active".into(), Some(v.clone())), ("pinned".into(), Some(v))])?;
        }
        self.audit("plugin.undoUpgrade", &plugin, &json!({ "batch": batch, "restored": rows.len(), "modified": modified.len() }))?;
        Ok(Outcome { id: Some(json!(modified).to_string()), changed: true, rows, ..Default::default() })
    }

    fn counted_audit(
        &mut self,
        run: Option<&str>,
        op: &str,
        object: &str,
        summary: &Value,
        failed: bool,
        error: Option<&onedesk_protocol::ProtocolError>,
    ) -> KResult<Outcome> {
        if let Some(run) = run {
            let n = self
                .tx
                .execute(
                    "UPDATE audit_counts SET count = count + 1, last_at = ?4, last_summary = ?5, failures = failures + ?6
                     WHERE run_id = ?1 AND op = ?2 AND object = ?3",
                    params![run, op, object, self.at, summary.to_string(), failed as i64],
                )
                .map_err(db_err)?;
            if n > 0 {
                return Ok(Outcome { changed: false, ..Default::default() });
            }
        }
        match error {
            None => self.audit(op, object, summary)?,
            Some(e) => {
                self.tx
                    .execute(
                        "INSERT INTO audit (at, actor, op, object, summary, result) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![self.at, self.actor.as_text(), op, object, summary.to_string(), format!("failed:{}", code_text(e.code))],
                    )
                    .map_err(db_err)?;
            }
        }
        if let Some(run) = run {
            let seq = self.tx.last_insert_rowid();
            self.tx
                .execute(
                    "INSERT INTO audit_counts (run_id, op, object, audit_seq, count, first_at, last_at, failures) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, ?6)",
                    params![run, op, object, seq, self.at, failed as i64],
                )
                .map_err(db_err)?;
        }
        Ok(Outcome { changed: true, ..Default::default() })
    }

    fn siblings(&self, tree: Option<&str>, parent: Option<&str>, except: &str) -> KResult<Vec<Row>> {
        let all = store::children(self.tx, tree.unwrap_or_default(), parent, 0, u32::MAX).map_err(db_err)?;
        Ok(all.into_iter().filter(|r| r.id != except).collect())
    }

    fn delete(&mut self, id: &str) -> KResult<Outcome> {
        let root = self.live(id)?;
        self.permit(&root.kind)?;
        // D473: the default resource tree holds the top level; it stays.
        if store::is_default_tree(&root) {
            return Err(invalid("defaultTree"));
        }
        let mut batch = vec![root];
        batch.extend(store::descendants(self.tx, id).map_err(db_err)?);
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
                .map_err(db_err)?;
            self.revision(r, "delete", &["deleted".to_string()])?;
            self.touch_ends(&r.id)?;
        }
        let ids: Vec<&str> = batch.iter().map(|r| r.id.as_str()).collect();
        self.audit("resource.delete", id, &json!({ "batch": batch_id, "count": ids.len(), "ids": ids }))?;
        Ok(Outcome { id: Some(id.to_string()), changed: true, rows: batch, ..Default::default() })
    }
}

fn dest_tree(cx: &Tx<'_>, dest: &MoveDest) -> KResult<Option<String>> {
    let id = match dest {
        MoveDest::Inside(None) => return Ok(None),
        MoveDest::Inside(Some(i)) | MoveDest::Before(i) | MoveDest::After(i) => i,
    };
    Ok(store::get(cx.tx, id).map_err(db_err)?.and_then(|r| r.tree))
}

/// One resource of a takeover: the rev its new body was computed from.
#[derive(Debug, Clone)]
pub struct UpgradeItem {
    pub id: String,
    pub rev: i64,
    pub body: JsonMap,
}

/// Runs kept per resource (or per action without a resource), besides the kept ones (D288).
pub const RUNS_KEPT: u32 = 200;

/// Body key of `core:plugin-state` holding the granted folders.
pub const GRANTS_KEY: &str = "files.folders";

/// Rules of the kernel's own kinds; plugin kinds are added by the registry.
pub fn core_rules() -> HashMap<String, KindRule> {
    let mut m = HashMap::new();
    m.insert(KIND_GROUP.to_string(), KindRule { tree: Some(store::TREE_RESOURCES.into()), accepts: vec!["*".into()], protected: vec![], ..Default::default() });
    m.insert(store::KIND_TREE.to_string(), KindRule { tree: Some(store::TREE_RESOURCES.into()), accepts: vec!["*".into()], protected: vec![], ..Default::default() });
    m.insert(KIND_PLUGIN_STATE.to_string(), KindRule { tree: Some(TREE_PLUGIN_STATE.into()), accepts: vec![], protected: vec![], ..Default::default() });
    // D274: environments only under environments, configuration only under configuration.
    m.insert(KIND_ENV.to_string(), KindRule { tree: Some(store::TREE_ENV.into()), accepts: vec![KIND_ENV.into()], protected: vec![], ..Default::default() });
    m.insert(KIND_CONFIG.to_string(), KindRule { tree: Some(store::TREE_CONFIG.into()), accepts: vec![KIND_CONFIG.into()], protected: vec![], ..Default::default() });
    m
}

/// What search indexes besides the name: description, tags, string values of the body, parameters.
fn search_text(r: &Row) -> String {
    fn strings(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
            Value::Object(o) => o.values().for_each(|x| strings(x, out)),
            _ => {}
        }
    }
    let mut out = vec![r.description.clone()];
    out.extend(r.tags.iter().cloned());
    for (k, v) in &r.body {
        if k != crate::params::PARAMS_KEY {
            strings(v, &mut out);
        }
    }
    out.push(crate::params::search_text(r));
    out.retain(|s| !s.is_empty());
    out.join("\n")
}

/// Audit summary of changed fields: parameter names are user content, so only their count (#5).
fn audit_fields(changed: &[String]) -> Value {
    let params = changed.iter().filter(|f| f.starts_with("params.")).count();
    let fields: Vec<&String> = changed.iter().filter(|f| !f.starts_with("params.")).collect();
    if params == 0 {
        json!({ "fields": fields })
    } else {
        json!({ "fields": fields, "params": params })
    }
}
