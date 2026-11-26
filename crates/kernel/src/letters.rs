//! D487 §35 (docs/redesign/book.md, K19): sending and replying. A letter is a signed package (the format of K9, variant
//! `letter`) of one resource and the pages attached below it, addressed to identities (K18); its recipient keeps it
//! under a resource of a kind that takes letters (`letters: true`): the letter itself as an ordinary resource, its pages
//! as read-only copies with ids of their own. A reply (variant `reply`) carries no resources, only what the recipient
//! did for each page (data its role gives) and a general response, signed; it goes back only to the letter it answers,
//! only from one of its recipients. The kernel knows no homework, no memo: what can be asked of a page and what comes
//! back is the business of the role that page plays (the interface `onedesk.letter/1` of the letters plugin).
//! - `host.letters.write(root, opts)`: a letter (`{ pages, to, subject, comment, due, tasks, rootKind, path }`) or, from a
//!   received letter, its reply (`{ reply: { pages: [{ page, task, data, summary }], response }, path }`).
//! - `host.letters.info(id)`: a letter (by its resource or any resource in it) as this workspace knows it.
//! - `host.letters.contacts()`: the contacts one may write to (name, fingerprint, checked).
//! - `letter.inspect` / `letter.receive` (the user's).

use std::collections::{HashMap, HashSet};

use onedesk_protocol::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::Plugin;
use crate::packages::{package_message, read_package, zip_write, PackRow, PackageFile, ORIGIN_COPY};
use crate::pipeline::{Actor, Command, Outcome, Tx};
use crate::sandbox::CallInfo;
use crate::store::{self, Row};
use crate::util::*;

pub const METHODS: &[&str] = &[method5::LETTER_INSPECT, method5::LETTER_RECEIVE];
pub const EVENT_RECEIVED: &str = "letter.received";
pub const EVENT_REPLIED: &str = "letter.replied";
pub const EVENT_REPLY: &str = "letter.reply";
/// Most pages attached to one letter; most bytes of what one reply carries.
pub const MAX_PAGES: usize = 50;
pub const MAX_REPLY_BYTES: usize = 1024 * 1024;
const MAX_TEXT: usize = 4000;

/// What a letter or reply says beside its resources (`package.json` → `letter`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LetterMeta {
    pub id: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    /// Fingerprints of the recipients; empty: anyone may take it.
    #[serde(default)]
    pub to: Vec<String>,
    /// `[{ page, task, label }]`: what is asked of which page (ids as sent).
    #[serde(default)]
    pub tasks: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    /// A reply's content: `{ pages: [{ page, task, data, summary }], response }` (page ids as sent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<Value>,
    /// A letter's pages: the id each has in the letter → the id it has where it was sent from. Ordered: what is
    /// signed is written out again to be checked, and must come out the same.
    #[serde(default)]
    pub pages: std::collections::BTreeMap<String, String>,
}

/// One row of `letters`.
#[derive(Debug, Clone)]
pub struct LetterRow {
    pub id: String,
    pub dir: String,
    pub resource_id: String,
    pub peer_key: Option<String>,
    pub peer_name: String,
    pub subject: String,
    pub comment: String,
    pub due: Option<String>,
    pub to: Vec<String>,
    pub tasks: Vec<Value>,
    /// Local id → id as sent.
    pub pages: HashMap<String, String>,
    pub at: i64,
}

fn letter_row(r: &rusqlite::Row) -> rusqlite::Result<LetterRow> {
    let j = |s: Option<String>| s.and_then(|s| serde_json::from_str::<Value>(&s).ok());
    Ok(LetterRow {
        id: r.get(0)?,
        dir: r.get(1)?,
        resource_id: r.get(2)?,
        peer_key: r.get(3)?,
        peer_name: r.get(4)?,
        subject: r.get(5)?,
        comment: r.get(6)?,
        due: r.get(7)?,
        to: j(r.get(8)?).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default(),
        tasks: j(r.get(9)?).and_then(|v| v.as_array().cloned()).unwrap_or_default(),
        pages: j(r.get(10)?).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default(),
        at: r.get(11)?,
    })
}

const LETTER_COLUMNS: &str = "id, dir, resource_id, peer_key, peer_name, subject, comment, due, to_json, tasks_json, pages_json, at";

pub fn letter_by_resource(c: &Connection, id: &str) -> rusqlite::Result<Option<LetterRow>> {
    c.query_row(&format!("SELECT {LETTER_COLUMNS} FROM letters WHERE resource_id = ?1"), [id], letter_row).optional()
}

pub fn letter_by_id(c: &Connection, id: &str, dir: &str) -> rusqlite::Result<Option<LetterRow>> {
    c.query_row(&format!("SELECT {LETTER_COLUMNS} FROM letters WHERE id = ?1 AND dir = ?2"), params![id, dir], letter_row).optional()
}

/// The id a resource has in a letter: the same each time that letter is sent, never one of a workspace's own.
fn local_id(letter: &str, sent: &str) -> String {
    crate::identity::sha256_hex(format!("letter\u{1f}{letter}\u{1f}{sent}").as_bytes())[..32].to_string()
}

fn cut(s: &str) -> String {
    s.trim().chars().take(MAX_TEXT).collect()
}

/// Everything of one received letter, written in one transaction.
#[derive(Debug, Clone)]
pub struct LetterPlan {
    pub meta: LetterMeta,
    pub from_key: String,
    pub from_name: String,
    pub parent: String,
    pub rows: Vec<PackRow>,
    pub root: String,
    pub versions: HashMap<String, Option<String>>,
    pub blobs: Vec<BlobInfo>,
    pub sealed: Vec<crate::packages::SealedEntry>,
    /// Local page id → id as sent.
    pub pages: HashMap<String, String>,
}

impl Tx<'_> {
    /// D487 §35 (K19): a letter put under `parent`: its root an ordinary resource of the letters plugin, its pages
    /// read-only copies; its row in `letters`.
    pub(crate) fn receive_letter(&mut self, plan: LetterPlan) -> KResult<Outcome> {
        for b in &plan.blobs {
            self.tx
                .execute(
                    "INSERT INTO blobs (hash, type, size, width, height, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(hash) DO NOTHING",
                    params![b.blob, b.r#type, b.size as i64, b.width, b.height, self.at],
                )
                .map_err(crate::pipeline::db_err)?;
        }
        let actor = self.actor.as_text();
        let mut placed: HashSet<String> = HashSet::from([plan.parent.clone()]);
        let mut rows_out = Vec::new();
        let mut pending: Vec<&PackRow> = plan.rows.iter().collect();
        while !pending.is_empty() {
            let before = pending.len();
            let mut rest = Vec::new();
            for r in pending {
                let parent = if r.id == plan.root { Some(plan.parent.clone()) } else { r.parent.clone() };
                if parent.as_ref().is_some_and(|p| !placed.contains(p)) {
                    rest.push(r);
                    continue;
                }
                if store::get_any(self.tx, &r.id).map_err(crate::pipeline::db_err)?.is_some() {
                    return Err(invalid("alreadyReceived"));
                }
                let tree = if r.kind == store::KIND_GROUP {
                    Some(store::TREE_RESOURCES.to_string())
                } else {
                    self.rules.get(&r.kind).and_then(|k| k.tree.clone()).or(Some(store::TREE_RESOURCES.to_string()))
                };
                let root = r.id == plan.root;
                let pos = if root { self.next_pos(tree.as_deref(), Some(&plan.parent))? } else { r.pos };
                let row = Row {
                    id: r.id.clone(),
                    kind: r.kind.clone(),
                    plugin_version: plan.versions.get(&r.kind).cloned().flatten(),
                    tree,
                    parent_id: parent,
                    pos,
                    name: r.name.clone(),
                    description: r.description.clone(),
                    tags: r.tags.clone(),
                    body: r.body.clone(),
                    origin: if root { "original".into() } else { ORIGIN_COPY.into() },
                    origin_ref: if root { None } else { Some(plan.root.clone()) },
                    state: "ok".into(),
                    rev: 1,
                    created_at: self.at,
                    created_by: actor.clone(),
                    updated_at: self.at,
                    updated_by: actor.clone(),
                    deleted_at: None,
                    default_env: None,
                };
                self.insert(&row)?;
                self.revision(&row, "import", &["*".to_string()])?;
                placed.insert(row.id.clone());
                rows_out.push(row);
            }
            if rest.len() == before {
                return Err(invalid("badPackage"));
            }
            pending = rest;
        }
        for row in &rows_out {
            self.refs_after(row, None)?;
            self.connect_name(row)?;
        }
        for s in &plan.sealed {
            self.tx
                .execute(
                    "INSERT INTO sealed (resource_id, field, salt, hashes) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(resource_id, field) DO UPDATE SET salt = excluded.salt, hashes = excluded.hashes",
                    params![s.resource, s.field, s.salt, serde_json::to_string(&s.hashes).unwrap_or_default()],
                )
                .map_err(crate::pipeline::db_err)?;
        }
        let pages = json!(plan.pages);
        let m = &plan.meta;
        self.tx
            .execute(
                &format!("INSERT INTO letters ({LETTER_COLUMNS}) VALUES (?1, 'in', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"),
                params![m.id, plan.root, plan.from_key, plan.from_name, m.subject, m.comment, m.due, json!(m.to).to_string(), json!(m.tasks).to_string(), pages.to_string(), self.at],
            )
            .map_err(crate::pipeline::db_err)?;
        self.audit("letter.receive", &plan.root, &json!({ "letter": m.id, "from": crate::identity::fingerprint(&plan.from_key), "pages": rows_out.len() - 1 }))?;
        Ok(Outcome { id: Some(plan.root.clone()), changed: true, rows: rows_out, ..Default::default() })
    }
}

impl Inner {
    /* ------------------------------------------------------------------ host.letters */

    pub(crate) async fn host_letters(&self, plugin: &'static Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        if !plugin.manifest.requires.resources {
            return Err(denied("notRequested"));
        }
        match op {
            "info" => {
                let id = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("id must be a string"))?;
                Ok(self.letter_info(id)?.unwrap_or(Value::Null))
            }
            "contacts" => {
                let rows = self.read(|c| store::of_kind(c, store::KIND_CONTACT))?;
                Ok(Value::Array(
                    rows.into_iter()
                        .map(|r| json!({ "id": r.id, "name": r.name, "fingerprint": r.body.get("fingerprint"), "checked": r.body.get("checked").and_then(Value::as_bool).unwrap_or(false) }))
                        .collect(),
                ))
            }
            "write" => {
                if info.event || info.pure {
                    return Err(denied("notInRun"));
                }
                if !plugin.manifest.requires.files {
                    return Err(denied("notRequested"));
                }
                if self.identity()?.is_none() {
                    return Err(invalid("noIdentity"));
                }
                let root = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("root must be a string"))?.to_string();
                let o = args.get(1).cloned().unwrap_or(Value::Null);
                let raw = o.get("path").and_then(Value::as_str).ok_or_else(|| invalid_params("path"))?.to_string();
                let row = self.read(|c| store::get(c, &root))?.ok_or_else(|| not_found("resource"))?;
                if crate::manifest::Registry::split(&row.kind).map(|(p, _)| p) != Some(plugin.id.as_str()) {
                    return Err(denied("foreignKind"));
                }
                let (pkg, blobs) = match self.read(|c| letter_by_resource(c, &root))?.filter(|l| l.dir == "in") {
                    Some(letter) => self.reply_package(&letter, &o)?,
                    None => self.letter_package(plugin, &row, &o).await?,
                };
                let entries = {
                    let mut e = vec![("package.json".to_string(), serde_json::to_vec(&pkg).map_err(internal)?)];
                    e.extend(blobs.into_iter().map(|(h, b)| (format!("blobs/{h}"), b)));
                    e
                };
                let data = zip_write(&entries);
                let (grants, rawp) = self.files_scope_pub(plugin, &raw)?;
                let path = tokio::task::spawn_blocking(move || -> KResult<String> {
                    use std::io::Write;
                    let mut part = crate::files::part_file(&grants, &rawp, false)?;
                    let shown = crate::files::resolve(&grants, &rawp)?.display().to_string();
                    let mut f = part.take_file();
                    f.write_all(&data).map_err(internal)?;
                    f.sync_all().map_err(internal)?;
                    drop(f);
                    part.commit(false)?;
                    Ok(shown)
                })
                .await
                .map_err(internal)??;
                let meta = pkg.letter.clone().unwrap_or_default();
                if pkg.variant == "letter" {
                    // Sent: kept (sending it again keeps its id and its replies).
                    // A reply names each page as it is here.
                    let pages: HashMap<String, String> = meta.pages.values().map(|o| (o.clone(), o.clone())).collect();
                    let me = self.identity()?.unwrap_or_else(|| unreachable!());
                    self.execute(
                        plugin.actor(),
                        Command::Letter {
                            row: Box::new(LetterRow { id: meta.id.clone(), dir: "out".into(), resource_id: root.clone(), peer_key: Some(me.public_key), peer_name: me.name, subject: meta.subject.clone(), comment: meta.comment.clone(), due: meta.due.clone(), to: meta.to.clone(), tasks: meta.tasks.clone(), pages, at: now_ms() }),
                            op: "letter.send".into(),
                            path: path.clone(),
                        },
                    )
                    .await?;
                } else {
                    self.execute(plugin.actor(), Command::Audit { op: "letter.reply".into(), object: path.clone(), summary: json!({ "letter": meta.in_reply_to }) }).await?;
                }
                Ok(json!({ "path": path, "letter": meta.id }))
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("letters.{op}"))])),
        }
    }

    /// A letter: its root (as the plugin's `rootKind`, if given) and each attached page with what is below it; withheld
    /// fields go as a student's edition takes them (fingerprints only).
    async fn letter_package(&self, plugin: &'static Plugin, root: &Row, o: &Value) -> KResult<(PackageFile, crate::packages::Entries)> {
        let s = |k: &str| o.get(k).and_then(Value::as_str).map(cut).unwrap_or_default();
        let pages: Vec<String> = serde_json::from_value(o.get("pages").cloned().unwrap_or(json!([]))).map_err(|_| invalid_params("pages"))?;
        if pages.is_empty() || pages.len() > MAX_PAGES {
            return Err(invalid_params("pages"));
        }
        // Recipients: contacts (by id) or fingerprints.
        let mut to = Vec::new();
        for t in o.get("to").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            let fp = match self.read(|c| store::get(c, t))?.filter(|r| r.kind == store::KIND_CONTACT) {
                Some(r) => r.body.get("fingerprint").and_then(Value::as_str).unwrap_or_default().to_string(),
                None => t.to_string(),
            };
            if fp.split(' ').count() != 8 {
                return Err(invalid_params("to"));
            }
            if !to.contains(&fp) {
                to.push(fp);
            }
        }
        let tasks: Vec<Value> = o.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().take(MAX_PAGES * 4).collect();
        let mut root_row = root.clone();
        if let Some(k) = o.get("rootKind").and_then(Value::as_str) {
            let full = plugin.full(k);
            if self.registry.kind(&full).is_none() {
                return Err(invalid_params("rootKind"));
            }
            root_row.kind = full;
        }
        let mut resources = vec![PackRow { id: root_row.id.clone(), kind: root_row.kind.clone(), parent: None, pos: 0, name: root_row.name.clone(), description: root_row.description.clone(), tags: root_row.tags.clone(), body: root_row.body.clone() }];
        let mut blobs: crate::packages::Entries = Vec::new();
        let mut seen: HashSet<String> = HashSet::from([root_row.id.clone()]);
        for (i, id) in pages.iter().enumerate() {
            let page = self.read(|c| store::get(c, id))?.ok_or_else(|| not_found("resource"))?;
            let (rows, b) = self.snapshot_pub(&page)?;
            for mut r in rows {
                if !seen.insert(r.id.clone()) {
                    continue;
                }
                if r.id == page.id {
                    r.parent = Some(root_row.id.clone());
                    r.pos = i as i64;
                }
                resources.push(r);
            }
            for (h, bytes) in b {
                if !blobs.iter().any(|(x, _)| *x == h) {
                    blobs.push((h, bytes));
                }
            }
        }
        let id = self.read(|c| letter_by_resource(c, &root.id))?.filter(|l| l.dir == "out").map(|l| l.id).unwrap_or_else(new_id);
        // Withheld fields as a student's edition has them, fingerprinted for the ids the letter gives.
        let mut held = PackageFile { format: crate::packages::FORMAT, publisher: String::new(), publisher_name: String::new(), root: root_row.id.clone(), title: String::new(), edition: 1, printing: 1, variant: "letter".into(), published_at: 0, resources, sealed: vec![], publisher_key: None, signature: None, letter: None };
        let lid = id.clone();
        self.withhold_as(&mut held, &HashMap::new(), &move |x: &str| local_id(&lid, x)).await;
        let (resources, sealed) = (held.resources, held.sealed);
        // Ids of the letter's own: a recipient keeps them; which was which here stays with the letter.
        let map: HashMap<String, String> = resources.iter().map(|r| (r.id.clone(), local_id(&id, &r.id))).collect();
        let page_map: std::collections::BTreeMap<String, String> = resources.iter().skip(1).map(|r| (map[&r.id].clone(), r.id.clone())).collect();
        let resources: Vec<PackRow> = resources
            .into_iter()
            .map(|r| PackRow { id: map[&r.id].clone(), parent: r.parent.as_ref().map(|p| map.get(p).cloned().unwrap_or_else(|| p.clone())), ..r })
            .collect();
        let me = self.identity()?.ok_or_else(|| invalid("noIdentity"))?;
        let mut pkg = PackageFile {
            format: crate::packages::FORMAT,
            publisher: self.ws.id.clone(),
            publisher_name: me.name.clone(),
            root: map[&root_row.id].clone(),
            title: s("subject"),
            edition: 1,
            printing: 1,
            variant: "letter".into(),
            published_at: now_ms(),
            resources,
            sealed,
            publisher_key: None,
            signature: None,
            letter: Some(LetterMeta { id, subject: s("subject"), comment: s("comment"), due: o.get("due").and_then(Value::as_str).map(cut).filter(|d| !d.is_empty()), to, tasks: tasks.iter().map(|t| { let mut t = t.clone(); if let Some(p) = t.get("page").and_then(Value::as_str) { if let Some(n) = map.get(p) { t["page"] = json!(n); } } t }).collect(), in_reply_to: None, reply: None, pages: page_map }),
        };
        let names: Vec<String> = blobs.iter().map(|(h, _)| h.clone()).collect();
        self.sign_package(&mut pkg, &names)?;
        Ok((pkg, blobs))
    }

    /// A reply to a received letter: what was done for each page (its role's data, page ids as sent) and the response.
    fn reply_package(&self, letter: &LetterRow, o: &Value) -> KResult<(PackageFile, crate::packages::Entries)> {
        let r = o.get("reply").cloned().unwrap_or(Value::Null);
        let mut pages = Vec::new();
        for p in r.get("pages").and_then(Value::as_array).into_iter().flatten() {
            let local = p.get("page").and_then(Value::as_str).unwrap_or_default();
            let Some(sent) = letter.pages.get(local) else { return Err(invalid_params("page")) };
            pages.push(json!({ "page": sent, "task": p.get("task"), "data": p.get("data"), "summary": p.get("summary").and_then(Value::as_str).map(cut) }));
        }
        let reply = json!({ "pages": pages, "response": r.get("response").cloned().unwrap_or(Value::Null) });
        if reply.to_string().len() > MAX_REPLY_BYTES {
            return Err(err_p(ErrorCode::Invalid, &[("reason", "tooLarge")]));
        }
        let me = self.identity()?.ok_or_else(|| invalid("noIdentity"))?;
        let mut pkg = PackageFile {
            format: crate::packages::FORMAT,
            publisher: self.ws.id.clone(),
            publisher_name: me.name,
            root: letter.id.clone(),
            title: letter.subject.clone(),
            edition: 1,
            printing: 1,
            variant: "reply".into(),
            published_at: now_ms(),
            resources: vec![],
            sealed: vec![],
            publisher_key: None,
            signature: None,
            letter: Some(LetterMeta { id: new_id(), subject: letter.subject.clone(), in_reply_to: Some(letter.id.clone()), reply: Some(reply), ..Default::default() }),
        };
        self.sign_package(&mut pkg, &[])?;
        Ok((pkg, vec![]))
    }

    fn sign_package(&self, pkg: &mut PackageFile, blobs: &[String]) -> KResult<()> {
        let who = self.identity()?.ok_or_else(|| invalid("noIdentity"))?;
        pkg.publisher_key = Some(who.public_key);
        pkg.signature = None;
        let (_, sig) = self.sign(package_message(pkg, blobs).as_bytes())?.ok_or_else(|| invalid("noIdentity"))?;
        pkg.signature = Some(sig);
        Ok(())
    }

    /// A letter as this workspace knows it, found by its resource or any resource below it.
    pub(crate) fn letter_info(&self, id: &str) -> KResult<Option<Value>> {
        let mut cur = self.read(|c| store::get(c, id))?;
        let mut letter = None;
        while let Some(r) = cur {
            if let Some(l) = self.read(|c| letter_by_resource(c, &r.id))? {
                letter = Some(l);
                break;
            }
            cur = match r.parent_id {
                Some(p) => self.read(|c| store::get(c, &p))?,
                None => None,
            };
        }
        let Some(l) = letter else { return Ok(None) };
        let who = |key: &Option<String>, name: &str| key.as_ref().map(|k| json!(self.signed_by(k, name))).unwrap_or(Value::Null);
        let to: Vec<Value> = l
            .to
            .iter()
            .map(|fp| {
                let c = self.read(|c| c.query_row("SELECT name, json_extract(body, '$.checked') FROM resources WHERE kind = ?1 AND deleted_at IS NULL AND json_extract(body, '$.fingerprint') = ?2", params![store::KIND_CONTACT, fp], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<bool>>(1)?))).optional()).ok().flatten();
                json!({ "fingerprint": fp, "name": c.as_ref().map(|x| x.0.clone()), "checked": c.and_then(|x| x.1).unwrap_or(false) })
            })
            .collect();
        let pages: Vec<Value> = l.pages.iter().map(|(local, sent)| json!({ "id": local, "sent": sent })).collect();
        let mut out = json!({ "id": l.id, "dir": l.dir, "resource": l.resource_id, "from": who(&l.peer_key, &l.peer_name), "subject": l.subject, "comment": l.comment,
                              "due": l.due, "to": to, "tasks": l.tasks, "pages": pages, "at": l.at });
        if l.dir == "out" {
            type Rep = (String, String, i64, String);
            let reps: Vec<Rep> = self.read(|c| {
                let mut st = c.prepare("SELECT from_key, from_name, at, payload FROM letter_replies WHERE letter_id = ?1 ORDER BY at")?;
                let v = st.query_map([&l.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
                v.collect()
            })?;
            out["replies"] = Value::Array(
                reps.into_iter()
                    .map(|(k, n, at, p)| {
                        let payload: Value = serde_json::from_str(&p).unwrap_or(Value::Null);
                        json!({ "from": self.signed_by(&k, &n), "at": at, "pages": payload.get("pages"), "response": payload.get("response") })
                    })
                    .collect(),
            );
        }
        Ok(Some(out))
    }

    /* ------------------------------------------------------------------ letter.inspect / letter.receive */

    pub(crate) async fn handle_letters(&self, m: &str, params: Value) -> KResult<Value> {
        let path = params.get("path").and_then(Value::as_str).ok_or_else(|| invalid_params("path"))?.to_string();
        let (pkg, blobs) = tokio::task::spawn_blocking(move || -> KResult<(PackageFile, crate::packages::Entries)> {
            let meta = std::fs::metadata(&path).map_err(|_| not_found("file"))?;
            if !meta.is_file() || meta.len() > crate::packages::MAX_PACKAGE_BYTES {
                return Err(invalid("badPackage"));
            }
            read_package(&std::fs::read(&path).map_err(|_| not_found("file"))?)
        })
        .await
        .map_err(internal)??;
        let names: Vec<String> = blobs.iter().map(|(h, _)| h.clone()).collect();
        let check = self.letter_check(&pkg, &names)?;
        if m == method5::LETTER_INSPECT {
            return Ok(check.info);
        }
        if let Some(why) = check.refused {
            return Err(err_p(ErrorCode::Invalid, &[("reason", &why)]));
        }
        let key = pkg.publisher_key.clone().unwrap_or_default();
        let meta = pkg.letter.clone().unwrap_or_default();
        if pkg.variant == "reply" {
            return self.take_reply(&pkg, &meta, &key).await;
        }
        let parent = match params.get("parent").and_then(Value::as_str) {
            Some(p) => p.to_string(),
            None => match check.places.as_slice() {
                [only] => only.clone(),
                _ => return Err(invalid("noInbox")),
            },
        };
        if !check.places.contains(&parent) {
            return Err(invalid("noInbox"));
        }
        // The letter's ids are its own (`local_id`); which page was which where it was sent from comes with it.
        let rows: Vec<PackRow> = pkg.resources.clone();
        let ids: HashSet<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        let pages: HashMap<String, String> = meta.pages.iter().filter(|(k, _)| ids.contains(k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
        let sealed = pkg.sealed.clone();
        let mut infos = Vec::new();
        for (h, b) in &blobs {
            let i = crate::blobs::prepare(&self.ws.dir, b)?;
            if &i.blob == h {
                infos.push(i);
            }
        }
        let versions = pkg.resources.iter().map(|r| (r.kind.clone(), self.registry.kind(&r.kind).map(|(p, _)| p.version.clone()))).collect();
        let root = pkg.root.clone();
        let plan = LetterPlan { meta: meta.clone(), from_key: key.clone(), from_name: pkg.publisher_name.clone(), parent: parent.clone(), rows, root: root.clone(), versions, blobs: infos, sealed: sealed.clone(), pages };
        self.execute(Actor::User, Command::ReceiveLetter(Box::new(plan))).await?;
        for s in &sealed {
            self.secret_set(&crate::packages::sealed_secret(&s.resource, &s.field), &s.value, false).await?;
        }
        self.contact_put(&key, &pkg.publisher_name, "", "letter", None).await?;
        if let Some(r) = self.read(|c| store::get(c, &parent))? {
            if let Some((pid, _)) = crate::manifest::Registry::split(&r.kind) {
                self.deliver(pid, EVENT_RECEIVED, json!({ "letter": root, "parent": parent }));
            }
        }
        Ok(json!({ "resource": root }))
    }

    async fn take_reply(&self, pkg: &PackageFile, meta: &LetterMeta, key: &str) -> KResult<Value> {
        let sent = meta.in_reply_to.clone().unwrap_or_default();
        let letter = self.read(|c| letter_by_id(c, &sent, "out"))?.ok_or_else(|| invalid("noLetter"))?;
        let payload = meta.reply.clone().unwrap_or(Value::Null);
        self.execute(Actor::User, Command::Reply { letter: letter.id.clone(), from_key: key.to_string(), from_name: pkg.publisher_name.clone(), payload: payload.clone() }).await?;
        let from = self.signed_by(key, &pkg.publisher_name);
        if let Some(r) = self.read(|c| store::get(c, &letter.resource_id))? {
            if let Some((pid, _)) = crate::manifest::Registry::split(&r.kind) {
                self.deliver(pid, EVENT_REPLIED, json!({ "letter": r.id, "from": from, "response": payload.get("response") }));
            }
        }
        // Each page's role takes what came back for it.
        for p in payload.get("pages").and_then(Value::as_array).into_iter().flatten() {
            let Some(page) = p.get("page").and_then(Value::as_str) else { continue };
            if !letter.pages.contains_key(page) {
                continue;
            }
            if let Some(r) = self.read(|c| store::get(c, page))? {
                if let Some((pid, _)) = crate::manifest::Registry::split(&r.kind) {
                    self.deliver(pid, EVENT_REPLY, json!({ "letter": letter.resource_id, "page": page, "task": p.get("task"), "data": p.get("data"), "summary": p.get("summary"), "from": from }));
                }
            }
        }
        Ok(json!({ "resource": letter.resource_id }))
    }

    /// What a letter or reply file is, whether it may be taken, and where a letter may go.
    fn letter_check(&self, pkg: &PackageFile, blobs: &[String]) -> KResult<Checked> {
        let meta = pkg.letter.clone().unwrap_or_default();
        let signed = match (&pkg.publisher_key, &pkg.signature) {
            (Some(k), Some(s)) => crate::identity::verify(k, package_message(pkg, blobs).as_bytes(), s),
            _ => false,
        };
        let mine = self.identity()?;
        let from = pkg.publisher_key.as_ref().filter(|_| signed).map(|k| self.signed_by(k, &pkg.publisher_name));
        let fp = pkg.publisher_key.as_deref().and_then(crate::identity::fingerprint).unwrap_or_default();
        let places: Vec<(String, String)> = self.letter_places()?;
        let mut sent_subject = None;
        let refused: Option<&str> = if !matches!(pkg.variant.as_str(), "letter" | "reply") || pkg.letter.is_none() {
            Some("badPackage")
        } else if !signed {
            Some("badSignature")
        } else if mine.is_none() {
            Some("noIdentity")
        } else if mine.as_ref().is_some_and(|i| Some(&i.public_key) == pkg.publisher_key.as_ref()) {
            Some("ownPackage")
        } else if pkg.variant == "letter" {
            if !meta.to.is_empty() && !mine.as_ref().is_some_and(|i| meta.to.contains(&i.fingerprint)) {
                Some("notForYou")
            } else if self.read(|c| letter_by_id(c, &meta.id, "in"))?.is_some() {
                Some("alreadyReceived")
            } else if places.is_empty() {
                Some("noInbox")
            } else {
                None
            }
        } else {
            match self.read(|c| letter_by_id(c, meta.in_reply_to.as_deref().unwrap_or(""), "out"))? {
                None => Some("noLetter"),
                Some(l) if !l.to.is_empty() && !l.to.contains(&fp) => Some("notRecipient"),
                Some(l) => {
                    sent_subject = Some(l.subject);
                    None
                }
            }
        };
        let tasks = meta.tasks.len();
        let info = json!({
            "kind": pkg.variant, "subject": meta.subject, "comment": meta.comment, "due": meta.due, "tasks": tasks,
            "pages": pkg.resources.len().saturating_sub(1), "from": from, "fromName": pkg.publisher_name, "sentAt": pkg.published_at,
            "inReplyTo": sent_subject, "refused": refused,
            "places": places.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
        });
        Ok(Checked { info, refused: refused.map(String::from), places: places.into_iter().map(|(id, _)| id).collect() })
    }

    /// The resources a letter may be put under: of a kind that takes letters.
    fn letter_places(&self) -> KResult<Vec<(String, String)>> {
        let mut out = Vec::new();
        for p in self.registry.plugins() {
            if !self.plugin_enabled(&p.id) {
                continue;
            }
            for k in p.manifest.contributes.kinds.iter().filter(|k| k.letters) {
                for r in self.read(|c| store::of_kind(c, &p.full(&k.id)))? {
                    out.push((r.id, r.name));
                }
            }
        }
        Ok(out)
    }
}

struct Checked {
    info: Value,
    refused: Option<String>,
    places: Vec<String>,
}

/// The `letters` row (`op`: what it is audited as).
pub fn write_letter(c: &Connection, l: &LetterRow) -> rusqlite::Result<()> {
    c.execute(
        &format!(
            "INSERT INTO letters ({LETTER_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id, dir) DO UPDATE SET resource_id = excluded.resource_id, subject = excluded.subject, comment = excluded.comment, due = excluded.due,
             to_json = excluded.to_json, tasks_json = excluded.tasks_json, pages_json = excluded.pages_json, at = excluded.at"
        ),
        params![l.id, l.dir, l.resource_id, l.peer_key, l.peer_name, l.subject, l.comment, l.due, json!(l.to).to_string(), json!(l.tasks).to_string(), json!(l.pages).to_string(), l.at],
    )?;
    Ok(())
}

pub fn write_reply(c: &Connection, letter: &str, from_key: &str, from_name: &str, payload: &Value, at: i64) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO letter_replies (letter_id, from_key, from_name, at, payload) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(letter_id, from_key) DO UPDATE SET from_name = excluded.from_name, at = excluded.at, payload = excluded.payload",
        params![letter, from_key, from_name, at, payload.to_string()],
    )?;
    Ok(())
}
