//! D487 §29 (docs/redesign/book.md, K16, K17): proposals of changes, and a resource at one revision. A proposal is a
//! resource of the kernel's own kind (`core:proposal`, in the tree `proposals`): a few changes to other resources —
//! fields of a page changed, a resource made, one deleted — with a title and a note. Whoever proposes (an AI client,
//! the user, a plugin in a run) writes nothing else; the user looks at each item against what is there now and
//! accepts, rejects, or changes it and accepts; the accepted items are written as the user, in one transaction, each
//! revision marked with the proposal. The kernel knows no book: what can be changed is what the page lets the user
//! edit (D479's rule). Differences are worked out by the shell; the kernel only gives what was and what is.

use std::collections::{BTreeMap, BTreeSet};

use onedesk_protocol::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::pipeline::{Actor, Changes, Command, NewResource, ReviewStep};
use crate::store::{self, Row};
use crate::util::*;

/// Most items in one proposal; most bytes of their JSON.
pub const MAX_ITEMS: usize = 50;
pub const MAX_BYTES: usize = 1024 * 1024;
/// Longest title and comment (characters).
pub const MAX_TITLE: usize = 200;
pub const MAX_COMMENT: usize = 4000;
/// Most pending proposals `proposal.count` lists.
const MAX_IDS: usize = 50;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_PARTIAL: &str = "partial";
pub const STATUS_ACCEPTED: &str = "accepted";
pub const STATUS_REJECTED: &str = "rejected";
pub const STATUS_WITHDRAWN: &str = "withdrawn";

/// Method names this module answers.
pub const METHODS: &[&str] =
    &[method5::PROPOSAL_CREATE, method5::PROPOSAL_GET, method5::PROPOSAL_REVIEW, method5::PROPOSAL_WITHDRAW, method5::PROPOSAL_COUNT, method5::RESOURCE_AT];

fn is_proposal(c: &Connection, id: &str) -> KResult<bool> {
    Ok(store::get_any(c, id).map_err(crate::pipeline::db_err)?.is_some_and(|r| r.kind == store::KIND_PROPOSAL))
}

/// A proposal is made only as one (`Command::Propose`) and its content changed only by its review.
pub fn guard(conn: &Connection, cmd: &Command) -> KResult<()> {
    let refuse = || Err(err_p(ErrorCode::Denied, &[("reason", "proposalFixed")]));
    match cmd {
        Command::Create(n) if n.kind == store::KIND_PROPOSAL => refuse(),
        Command::Update { id, changes, .. } if (!changes.body.is_empty() || !changes.params.is_empty()) && is_proposal(conn, id)? => refuse(),
        Command::Params { id, .. } | Command::Restore { id, .. } if is_proposal(conn, id)? => refuse(),
        _ => Ok(()),
    }
}

fn item_err(reason: &str, index: usize) -> ProtocolError {
    err_p(ErrorCode::Invalid, &[("reason", reason), ("item", &(index + 1).to_string())])
}

fn field_err(index: usize, field: &str) -> ProtocolError {
    err_p(ErrorCode::Invalid, &[("reason", "proposalField"), ("item", &(index + 1).to_string()), ("field", field)])
}

/// What one stored item says.
fn get_str<'a>(it: &'a Value, k: &str) -> Option<&'a str> {
    it.get(k).and_then(Value::as_str)
}

fn status_of(items: &[Value]) -> &'static str {
    let results: Vec<Option<&str>> = items.iter().map(|i| get_str(i, "result")).collect();
    if results.iter().any(Option::is_none) {
        if results.iter().any(Option::is_some) {
            STATUS_PARTIAL
        } else {
            STATUS_PENDING
        }
    } else if results.iter().all(|r| *r == Some("accepted")) {
        STATUS_ACCEPTED
    } else if results.contains(&Some("accepted")) {
        STATUS_PARTIAL
    } else {
        STATUS_REJECTED
    }
}

/// Still to be decided: pending, or partly decided.
fn open(body: &JsonMap) -> bool {
    matches!(body.get("status").and_then(Value::as_str), Some(STATUS_PENDING) | Some(STATUS_PARTIAL))
        && body.get("items").and_then(Value::as_array).is_some_and(|a| a.iter().any(|i| i.get("result").is_none_or(Value::is_null)))
}

impl Inner {
    pub(crate) async fn handle_proposals(&self, m: &str, params: Value) -> KResult<Value> {
        match m {
            method5::PROPOSAL_CREATE => {
                let p: ProposalCreateParams = crate::kernel::parse(params)?;
                let id = self.proposal_create(Actor::User, p).await?;
                serde_json::to_value(ProposalCreateResult { id }).map_err(internal)
            }
            method5::PROPOSAL_GET => {
                let p: ProposalIdParams = crate::kernel::parse(params)?;
                serde_json::to_value(self.proposal_get(&p.id).await?).map_err(internal)
            }
            method5::PROPOSAL_REVIEW => {
                let p: ProposalReviewParams = crate::kernel::parse(params)?;
                serde_json::to_value(self.proposal_review(p).await?).map_err(internal)
            }
            method5::PROPOSAL_WITHDRAW => {
                let p: ProposalIdParams = crate::kernel::parse(params)?;
                serde_json::to_value(self.proposal_withdraw(&p.id).await?).map_err(internal)
            }
            method5::PROPOSAL_COUNT => {
                let p: ProposalCountParams = crate::kernel::parse(params)?;
                serde_json::to_value(self.proposal_count(p.resource_id.as_deref())?).map_err(internal)
            }
            method5::RESOURCE_AT => {
                let p: ResourceAtParams = crate::kernel::parse(params)?;
                serde_json::to_value(self.resource_at(&p.id, p.rev)?).map_err(internal)
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", m)])),
        }
    }

    /// A resource a proposal may be about: live, in a stored tree of resources, seen by an AI if one proposes.
    fn proposal_target(&self, actor: &Actor, id: &str) -> Option<Row> {
        let row = self.read(|c| store::get(c, id)).ok().flatten()?;
        if row.state == store::STATE_MISSING || self.hidden_tree(&row) || !self.in_stored_tree(&row) {
            return None;
        }
        if matches!(actor, Actor::Ai { .. }) && !self.read(|c| store::is_ai_visible(c, id)).unwrap_or(false) {
            return None;
        }
        Some(row)
    }

    /// The fields of a kind that are kept out of proposals besides what the page does not edit: secret, withheld.
    fn untouchable(&self, kind: &str, version: Option<&str>) -> BTreeSet<String> {
        let mut out: BTreeSet<String> = self.secret_fields(kind, version).into_iter().collect();
        if let Some((_, k)) = self.registry.kind_at(kind, version) {
            out.extend(k.fields.iter().filter(|(_, f)| f.withheld).map(|(n, _)| format!("body.{n}")));
        }
        out
    }

    /// The fields one may propose for a page (`resource:<id>` or `new:<kind>?parent=…`): its name, description, tags,
    /// and the text fields its page lets the user edit; with their labels and kinds.
    pub(crate) async fn proposable_fields(&self, target: &str, kind: &str, version: Option<&str>) -> BTreeMap<String, (Option<Label>, Option<FieldKind>)> {
        let mut out = BTreeMap::new();
        for p in ["name", "description", "tags"] {
            out.insert(p.to_string(), (None, None));
        }
        let skip = self.untouchable(kind, version);
        for f in self.editable_fields(target, None, None).await.unwrap_or_default() {
            if let Some(b) = f.bind.clone().filter(|b| b.starts_with("body.") && !skip.contains(b)) {
                out.insert(b, (Some(f.label.clone()), Some(f.kind)));
            }
        }
        out
    }

    /// One value as a field takes it: a name not empty, texts as texts, tags as a list of texts.
    fn proposal_value(index: usize, path: &str, v: &Value) -> KResult<()> {
        let ok = match path {
            "name" => v.as_str().is_some_and(|s| !s.trim().is_empty()),
            "tags" => v.as_array().is_some_and(|a| a.iter().all(Value::is_string)),
            _ => v.is_string(),
        };
        if ok {
            Ok(())
        } else {
            Err(field_err(index, path))
        }
    }

    /// `proposal.create`, `host.proposals.create`, the tool `propose`: checked whole (one bad item refuses all), then
    /// written as a proposal — nothing else is written.
    pub(crate) async fn proposal_create(&self, actor: Actor, p: ProposalCreateParams) -> KResult<String> {
        let title = p.title.trim().to_string();
        if title.is_empty() || p.items.is_empty() {
            return Err(invalid("proposalEmpty"));
        }
        let comment = p.comment.unwrap_or_default();
        if title.chars().count() > MAX_TITLE || comment.chars().count() > MAX_COMMENT || p.items.len() > MAX_ITEMS {
            return Err(err_p(ErrorCode::Invalid, &[("reason", "proposalTooLarge"), ("max", &MAX_ITEMS.to_string())]));
        }
        if serde_json::to_vec(&p.items).map(|v| v.len()).unwrap_or(usize::MAX) > MAX_BYTES {
            return Err(err_p(ErrorCode::Invalid, &[("reason", "proposalTooLarge"), ("max", &MAX_ITEMS.to_string())]));
        }
        let ai = matches!(actor, Actor::Ai { .. });
        let mut targets = BTreeSet::new();
        let mut stored = Vec::new();
        for (i, item) in p.items.iter().enumerate() {
            let mut v = serde_json::to_value(item).map_err(internal)?;
            match item {
                ProposalChange::Update { id, rev, changes } => {
                    let row = self.proposal_target(&actor, id).ok_or_else(|| item_err("proposalTarget", i))?;
                    self.proposal_fixed(&row, i)?;
                    if rev.is_some_and(|r| r != row.rev) {
                        return Err(item_err("proposalChanged", i));
                    }
                    if !targets.insert(row.id.clone()) {
                        return Err(item_err("proposalSameTarget", i));
                    }
                    if changes.is_empty() {
                        return Err(item_err("proposalEmpty", i));
                    }
                    let allowed = self.proposable_fields(&format!("resource:{}", row.id), &row.kind, row.plugin_version.as_deref()).await;
                    let mut was = JsonMap::new();
                    for (path, value) in changes {
                        if !allowed.contains_key(path) {
                            return Err(field_err(i, path));
                        }
                        Self::proposal_value(i, path, value)?;
                        was.insert(path.clone(), store::value_at(&row, path).unwrap_or(Value::Null));
                    }
                    v["rev"] = json!(row.rev);
                    v["was"] = Value::Object(was.into_iter().collect());
                }
                ProposalChange::Create { kind, parent, before, name, values } => {
                    let usable = kind == store::KIND_GROUP || (self.registry.kind(kind).is_some() && self.kind_usable(kind).is_ok());
                    if !usable || kind.starts_with("core:") && kind != store::KIND_GROUP {
                        return Err(item_err("proposalKind", i));
                    }
                    let parent_row = match parent {
                        Some(pid) => Some(self.proposal_target(&actor, pid).ok_or_else(|| item_err("proposalTarget", i))?),
                        // An AI adds only inside what it was shown.
                        None if ai => return Err(item_err("proposalTarget", i)),
                        None => None,
                    };
                    if let Some(pr) = &parent_row {
                        if pr.origin == crate::packages::ORIGIN_COPY {
                            return Err(item_err("proposalCopy", i));
                        }
                    }
                    if let Some(b) = before {
                        let sib = self.read(|c| store::get(c, b))?;
                        if !sib.is_some_and(|s| s.parent_id.as_deref() == parent.as_deref()) {
                            return Err(item_err("proposalTarget", i));
                        }
                    }
                    if name.trim().is_empty() {
                        return Err(field_err(i, "name"));
                    }
                    if kind != store::KIND_GROUP {
                        let target = match parent {
                            Some(pid) => format!("new:{kind}?parent={pid}"),
                            None => format!("new:{kind}"),
                        };
                        let version = self.registry.kind(kind).map(|(pl, _)| pl.version.clone());
                        let allowed = self.proposable_fields(&target, kind, version.as_deref()).await;
                        for (path, value) in values.iter().flatten() {
                            if path == "name" || !allowed.contains_key(path) {
                                return Err(field_err(i, path));
                            }
                            Self::proposal_value(i, path, value)?;
                        }
                    } else if values.as_ref().is_some_and(|v| v.keys().any(|k| k != "description" && k != "tags")) {
                        return Err(field_err(i, values.as_ref().and_then(|v| v.keys().find(|k| *k != "description" && *k != "tags")).map(String::as_str).unwrap_or("")));
                    }
                }
                ProposalChange::Delete { id, rev } => {
                    let row = self.proposal_target(&actor, id).ok_or_else(|| item_err("proposalTarget", i))?;
                    self.proposal_fixed(&row, i)?;
                    if store::is_default_tree(&row) {
                        return Err(item_err("proposalTarget", i));
                    }
                    if rev.is_some_and(|r| r != row.rev) {
                        return Err(item_err("proposalChanged", i));
                    }
                    if !targets.insert(row.id.clone()) {
                        return Err(item_err("proposalSameTarget", i));
                    }
                    v["rev"] = json!(row.rev);
                    v["was"] = json!({ "name": row.name });
                }
            }
            v["result"] = Value::Null;
            stored.push(v);
        }
        let mut body = JsonMap::new();
        body.insert("proposer".into(), json!(actor.as_text()));
        body.insert("status".into(), json!(STATUS_PENDING));
        body.insert("items".into(), Value::Array(stored));
        let n = NewResource {
            kind: store::KIND_PROPOSAL.into(),
            tree: None,
            parent: None,
            name: title,
            description: comment,
            tags: vec![],
            body,
            plugin_version: None,
        };
        let out = self.execute(actor, Command::Propose(n)).await?;
        out.id.ok_or_else(|| internal("no id"))
    }

    /// Stamped (K6) or in a read-only copy (K9): no proposal changes it.
    fn proposal_fixed(&self, row: &Row, i: usize) -> KResult<()> {
        if row.origin == crate::packages::ORIGIN_COPY {
            return Err(item_err("proposalCopy", i));
        }
        if self.stamped(&row.id)? {
            return Err(item_err("proposalStamped", i));
        }
        Ok(())
    }

    fn proposal_row(&self, id: &str) -> KResult<Row> {
        self.read(|c| store::get(c, id))?.filter(|r| r.kind == store::KIND_PROPOSAL).ok_or_else(|| not_found("proposal"))
    }

    /// `proposal.get`: each item against what is there now.
    pub(crate) async fn proposal_get(&self, id: &str) -> KResult<ProposalView> {
        let row = self.proposal_row(id)?;
        let items = row.body.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut out = Vec::new();
        for (i, it) in items.iter().enumerate() {
            out.push(self.item_view(i, it).await?);
        }
        let s = |k: &str| row.body.get(k).and_then(Value::as_str).map(String::from);
        Ok(ProposalView {
            id: row.id.clone(),
            title: row.name.clone(),
            comment: row.description.clone(),
            proposer: s("proposer").unwrap_or_default(),
            status: s("status").unwrap_or_else(|| STATUS_PENDING.into()),
            at: row.created_at,
            items: out,
            reviewed_by: s("reviewedBy"),
            review_comment: s("reviewComment"),
        })
    }

    async fn item_view(&self, i: usize, it: &Value) -> KResult<ProposalItemView> {
        let op = get_str(it, "op").unwrap_or_default().to_string();
        let result = get_str(it, "result").map(String::from);
        let obj = |k: &str| it.get(k).and_then(Value::as_object).cloned().unwrap_or_default();
        let mut v = ProposalItemView {
            index: i as u32,
            op: op.clone(),
            result: result.clone(),
            resource_id: None,
            name: String::new(),
            kind: String::new(),
            kind_label: None,
            icon: None,
            location: vec![],
            rev: it.get("rev").and_then(Value::as_i64),
            current_rev: None,
            stale: false,
            gone: false,
            fields: vec![],
            created: get_str(it, "created").map(String::from),
        };
        match op.as_str() {
            "update" | "delete" => {
                let id = get_str(it, "id").unwrap_or_default();
                v.resource_id = Some(id.to_string());
                let row = self.read(|c| store::get(c, id))?;
                let was = obj("was");
                v.name = was.get("name").and_then(Value::as_str).map(String::from).unwrap_or_default();
                let Some(row) = row else {
                    v.gone = true;
                    if op == "update" {
                        for (path, proposed) in obj("changes") {
                            v.fields.push(ProposalFieldView { before: was.get(&path).cloned().unwrap_or(Value::Null), current: Value::Null, proposed, changed: false, label: None, kind: None, path });
                        }
                    }
                    return Ok(v);
                };
                let meta = self.row_meta(&row);
                v.name = row.name.clone();
                v.kind = row.kind.clone();
                v.kind_label = Some(meta.label);
                v.icon = Some(meta.icon);
                v.location = self.resource(&row).map(|r| r.location).unwrap_or_default();
                v.current_rev = Some(row.rev);
                let labels = self.proposable_fields(&format!("resource:{}", row.id), &row.kind, row.plugin_version.as_deref()).await;
                if op == "update" {
                    for (path, proposed) in obj("changes") {
                        let before = was.get(&path).cloned().unwrap_or(Value::Null);
                        let current = store::value_at(&row, &path).unwrap_or(Value::Null);
                        let changed = current != before;
                        v.stale |= changed && result.is_none();
                        let (label, kind) = labels.get(&path).cloned().unwrap_or((None, None));
                        v.fields.push(ProposalFieldView { path, label, kind, before, current, proposed, changed });
                    }
                } else {
                    // What is deleted: the fields one would have been able to change.
                    for (path, (label, kind)) in labels {
                        let current = store::value_at(&row, &path).unwrap_or(Value::Null);
                        if path == "tags" && current.as_array().is_some_and(Vec::is_empty) || current == json!("") {
                            continue;
                        }
                        v.fields.push(ProposalFieldView { path, label, kind, before: current.clone(), current, proposed: Value::Null, changed: false });
                    }
                }
            }
            "create" => {
                let kind = get_str(it, "kind").unwrap_or_default().to_string();
                v.name = get_str(it, "name").unwrap_or_default().to_string();
                let meta = self.kind_meta(&kind);
                v.kind_label = Some(meta.label);
                v.icon = Some(meta.icon);
                let parent = get_str(it, "parent").map(String::from);
                if let Some(pid) = &parent {
                    match self.read(|c| store::get(c, pid))? {
                        Some(p) => {
                            let mut loc = self.resource(&p).map(|r| r.location).unwrap_or_default();
                            loc.push(p.name.clone());
                            v.location = loc;
                            v.resource_id = Some(p.id);
                        }
                        None => v.gone = true,
                    }
                }
                let target = match &parent {
                    Some(pid) => format!("new:{kind}?parent={pid}"),
                    None => format!("new:{kind}"),
                };
                let version = self.registry.kind(&kind).map(|(pl, _)| pl.version.clone());
                let labels = self.proposable_fields(&target, &kind, version.as_deref()).await;
                v.fields.push(ProposalFieldView { path: "name".into(), label: None, kind: None, before: Value::Null, current: Value::Null, proposed: json!(v.name), changed: false });
                for (path, proposed) in obj("values") {
                    let (label, k) = labels.get(&path).cloned().unwrap_or((None, None));
                    v.fields.push(ProposalFieldView { path, label, kind: k, before: Value::Null, current: Value::Null, proposed, changed: false });
                }
                v.kind = kind;
            }
            _ => {}
        }
        Ok(v)
    }

    /// `proposal.review` (the user's): the decided items; the accepted ones written in one transaction as the user.
    pub(crate) async fn proposal_review(&self, p: ProposalReviewParams) -> KResult<ProposalView> {
        let row = self.proposal_row(&p.id)?;
        if !open(&row.body) {
            return Err(invalid("proposalClosed"));
        }
        let mut items = row.body.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let proposer = row.body.get("proposer").and_then(Value::as_str).unwrap_or_default().to_string();
        let mut steps = Vec::new();
        let mut seen = BTreeSet::new();
        let (mut accepted, mut rejected, mut void) = (0u32, 0u32, 0u32);
        let now = now_ms();
        for d in &p.items {
            let i = d.index as usize;
            let it = items.get(i).cloned().ok_or_else(|| item_err("proposalItem", i))?;
            if !it.get("result").is_none_or(Value::is_null) || !seen.insert(i) {
                return Err(item_err("proposalItem", i));
            }
            let result = match d.decision {
                ProposalDecisionKind::Reject => "rejected",
                ProposalDecisionKind::Accept => match self.accept_step(i, &it, d)? {
                    Some(step) => {
                        steps.push(step);
                        "accepted"
                    }
                    None => "void",
                },
            };
            match result {
                "accepted" => accepted += 1,
                "rejected" => rejected += 1,
                _ => void += 1,
            }
            items[i]["result"] = json!(result);
            items[i]["decidedAt"] = json!(now);
            if let Some(values) = d.values.as_ref().filter(|_| result == "accepted") {
                items[i]["accepted"] = Value::Object(values.clone().into_iter().collect());
            }
        }
        let mut body = row.body.clone();
        body.insert("status".into(), json!(status_of(&items)));
        body.insert("items".into(), Value::Array(items));
        body.insert("reviewedBy".into(), json!(Actor::User.as_text()));
        if let Some(n) = p.comment.as_ref().map(|n| n.trim()).filter(|n| !n.is_empty()) {
            let (n, _) = crate::mcp::cut_chars(n, MAX_COMMENT);
            body.insert("reviewComment".into(), json!(n));
        }
        let summary = json!({ "proposer": proposer, "accepted": accepted, "rejected": rejected, "void": void });
        self.execute(Actor::User, Command::Review { proposal: row.id.clone(), steps, body, summary }).await?;
        self.proposal_get(&row.id).await
    }

    /// The write of one accepted item; `None`: its target (or the place of a new one) is gone.
    fn accept_step(&self, i: usize, it: &Value, d: &ProposalDecision) -> KResult<Option<ReviewStep>> {
        let obj = |k: &str| it.get(k).and_then(Value::as_object).cloned().unwrap_or_default();
        let given = d.values.clone().unwrap_or_default();
        match get_str(it, "op") {
            Some("update") => {
                let id = get_str(it, "id").unwrap_or_default();
                let Some(row) = self.read(|c| store::get(c, id))? else { return Ok(None) };
                let was = obj("was");
                let mut changes: JsonMap = obj("changes").into_iter().collect();
                for (k, v) in given {
                    if !changes.contains_key(&k) {
                        return Err(field_err(i, &k));
                    }
                    Self::proposal_value(i, &k, &v)?;
                    changes.insert(k, v);
                }
                // A field changed since it was proposed: accepted only against what is there now (looked at again).
                let stale = changes.keys().any(|k| store::value_at(&row, k).unwrap_or(Value::Null) != was.get(k).cloned().unwrap_or(Value::Null));
                if stale && d.basis != Some(row.rev) {
                    return Err(err_p(ErrorCode::Conflict, &[("reason", "proposalStale"), ("item", &(i + 1).to_string())]));
                }
                let changes = Changes::from_bind_map(&changes)?;
                Ok(Some(ReviewStep { index: i, cmd: Command::Update { id: id.to_string(), changes, basis: None, overwrite: vec![] }, before: None }))
            }
            Some("delete") => {
                let id = get_str(it, "id").unwrap_or_default();
                if self.read(|c| store::get(c, id))?.is_none() {
                    return Ok(None);
                }
                Ok(Some(ReviewStep { index: i, cmd: Command::Delete { id: id.to_string() }, before: None }))
            }
            Some("create") => {
                let kind = get_str(it, "kind").unwrap_or_default().to_string();
                let parent = get_str(it, "parent").map(String::from);
                if let Some(pid) = &parent {
                    if self.read(|c| store::get(c, pid))?.is_none() {
                        return Ok(None);
                    }
                }
                let mut values: JsonMap = obj("values").into_iter().collect();
                let mut name = get_str(it, "name").unwrap_or_default().to_string();
                for (k, v) in given {
                    if k == "name" {
                        Self::proposal_value(i, &k, &v)?;
                        name = v.as_str().unwrap_or_default().to_string();
                    } else if let Some(slot) = values.get_mut(&k) {
                        Self::proposal_value(i, &k, &v)?;
                        *slot = v;
                    } else {
                        return Err(field_err(i, &k));
                    }
                }
                let decl = self.registry.kind(&kind);
                let mut body = decl.map(|(_, k)| k.defaults.clone()).unwrap_or_default();
                let mut description = String::new();
                let mut tags = vec![];
                for (k, v) in values {
                    match k.as_str() {
                        "description" => description = v.as_str().unwrap_or_default().to_string(),
                        "tags" => tags = serde_json::from_value(v).unwrap_or_default(),
                        p => {
                            if let Some(key) = p.strip_prefix("body.") {
                                body.insert(key.to_string(), v);
                            }
                        }
                    }
                }
                let n = NewResource {
                    kind: kind.clone(),
                    tree: None,
                    parent,
                    name,
                    description,
                    tags,
                    body,
                    plugin_version: decl.map(|(pl, _)| pl.version.clone()),
                };
                Ok(Some(ReviewStep { index: i, cmd: Command::Create(n), before: get_str(it, "before").map(String::from) }))
            }
            _ => Err(item_err("proposalItem", i)),
        }
    }

    /// `proposal.withdraw`: a proposal nobody has decided anything of yet.
    pub(crate) async fn proposal_withdraw(&self, id: &str) -> KResult<ProposalView> {
        let row = self.proposal_row(id)?;
        if row.body.get("status").and_then(Value::as_str) != Some(STATUS_PENDING) {
            return Err(invalid("proposalClosed"));
        }
        let mut body = row.body.clone();
        body.insert("status".into(), json!(STATUS_WITHDRAWN));
        let summary = json!({ "withdrawn": true });
        self.execute(Actor::User, Command::Review { proposal: row.id.clone(), steps: vec![], body, summary }).await?;
        self.proposal_get(id).await
    }

    /// `proposal.count`: the proposals still to be decided (about `resource`: changing or deleting it, or adding in it).
    pub(crate) fn proposal_count(&self, resource: Option<&str>) -> KResult<ProposalCount> {
        let rows: Vec<Row> = self.read(|c| store::children(c, store::TREE_PROPOSALS, None, 0, u32::MAX))?;
        let mut hits: Vec<&Row> = rows
            .iter()
            .filter(|r| r.kind == store::KIND_PROPOSAL && open(&r.body))
            .filter(|r| {
                resource.is_none_or(|id| {
                    r.body.get("items").and_then(Value::as_array).is_some_and(|a| {
                        a.iter().any(|i| i.get("result").is_none_or(Value::is_null) && (get_str(i, "id") == Some(id) || get_str(i, "parent") == Some(id)))
                    })
                })
            })
            .collect();
        hits.sort_by_key(|r| std::cmp::Reverse(r.created_at));
        Ok(ProposalCount { pending: hits.len() as u32, ids: hits.iter().take(MAX_IDS).map(|r| r.id.clone()).collect() })
    }

    /// K17 `resource.at`: a resource as its revision `rev` holds it.
    pub(crate) fn resource_at(&self, id: &str, rev: i64) -> KResult<ResourceAt> {
        let row = self.read(|c| store::get_any(c, id))?.ok_or_else(|| not_found("resource"))?;
        if self.hidden_tree(&row) {
            return Err(not_found("resource"));
        }
        let found: Option<(i64, String, String)> = self.read(|c| {
            c.query_row("SELECT at, actor, snapshot FROM revisions WHERE resource_id = ?1 AND rev = ?2", params![id, rev], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()
        })?;
        let (at, actor, snap) = found.ok_or_else(|| not_found("revision"))?;
        let old: Row = serde_json::from_str(&snap).map_err(internal)?;
        Ok(ResourceAt { id: id.to_string(), rev, at, actor, name: old.name, description: old.description, tags: old.tags, body: old.body })
    }

    /// The proposal a revision came from (`revisions.commit_ref` = `proposal:<id>`).
    pub(crate) fn history_proposal(&self, commit_ref: Option<&str>) -> Option<HistoryProposal> {
        let id = commit_ref?.strip_prefix("proposal:")?;
        let row = self.read(|c| store::get_any(c, id)).ok().flatten()?;
        Some(HistoryProposal { id: row.id.clone(), title: row.name.clone(), proposer: row.body.get("proposer").and_then(Value::as_str).unwrap_or_default().to_string() })
    }
}
