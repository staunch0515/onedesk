//! D487 §23 (docs/redesign/book.md, K6): stamps. A plugin puts a stamp on one of its resources (a signature, a seal —
//! the kernel only keeps the name and the signer it is given); from the first stamp on, the resource's content is fixed
//! and what its embeds and calls show is kept as it was then (`within` gives it back). Taking the stamps off needs a
//! reason. The kernel knows no document and no signature.
//! - `host.resources.stamp(id, { label, signer })`, `host.resources.unstamp(id, { reason })`: a page event or a run of
//!   the plugin whose kind it is, a command or a run (the user's act; never an AI, an event handler or a pure call).

use onedesk_protocol::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::{Plugin, Registry};
use crate::pipeline::{Command, Outcome, Tx};
use crate::sandbox::CallInfo;
use crate::store;
use crate::util::*;

/// D487 §23 (K4): most fields in one `flow` node.
pub const MAX_FLOW_FIELDS: usize = 500;
/// Most stamps on one resource.
pub const MAX_STAMPS: usize = 20;
/// Longest label, signer, reason (characters).
pub const MAX_STAMP_TEXT: usize = 200;
/// Most references kept as they were (the rest show as they are).
pub const MAX_FROZEN: usize = 500;

/// The key of one reference as shown: target, section, parameters, inline.
pub fn frozen_key(target: &str, section: Option<&str>, params: Option<&str>, inline: bool) -> String {
    json!([target, section.unwrap_or(""), params.map(str::trim).unwrap_or(""), inline]).to_string()
}

fn is_stamped(c: &Connection, id: &str) -> rusqlite::Result<bool> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM stamps WHERE resource_id = ?1)", [id], |r| r.get(0))
}

/// D487 §23 (K6): nothing changes a stamped resource's content; it may be moved.
pub fn guard(conn: &Connection, cmd: &Command) -> KResult<()> {
    let id = match cmd {
        Command::Update { id, .. } | Command::Params { id, .. } | Command::Restore { id, .. } | Command::Delete { id } | Command::Purge { id } => id,
        _ => return Ok(()),
    };
    if is_stamped(conn, id).map_err(crate::pipeline::db_err)? {
        return Err(err_p(ErrorCode::Denied, &[("reason", "stamped")]));
    }
    Ok(())
}

impl Inner {
    pub(crate) fn stamped(&self, id: &str) -> KResult<bool> {
        self.read(|c| is_stamped(c, id))
    }

    pub(crate) fn stamps_of(&self, id: &str) -> KResult<Option<Vec<StampInfo>>> {
        let v: Vec<StampInfo> = self.read(|c| {
            let mut st = c.prepare_cached("SELECT label, signer, at FROM stamps WHERE resource_id = ?1 ORDER BY seq")?;
            let v = st.query_map([id], |r| Ok(StampInfo { label: r.get(0)?, signer: r.get(1)?, at: r.get(2)? }))?;
            v.collect()
        })?;
        Ok((!v.is_empty()).then_some(v))
    }

    pub(crate) fn stamp_log_of(&self, id: &str) -> KResult<Option<Vec<StampLogEntry>>> {
        let v: Vec<StampLogEntry> = self.read(|c| {
            let mut st = c.prepare_cached("SELECT action, label, signer, reason, rev, at FROM stamp_log WHERE resource_id = ?1 ORDER BY id")?;
            let v = st.query_map([id], |r| {
                Ok(StampLogEntry { action: r.get(0)?, label: r.get(1)?, signer: r.get(2)?, reason: r.get(3)?, rev: r.get(4)?, at: r.get(5)? })
            })?;
            v.collect()
        })?;
        Ok((!v.is_empty()).then_some(v))
    }

    /// What a reference in a stamped resource showed when the first stamp went on (none: show it as it is).
    pub(crate) fn frozen_embed(&self, within: &str, p: &ResourceEmbedParams) -> KResult<Option<EmbedResult>> {
        let key = frozen_key(&p.id, p.section.as_deref(), p.params.as_deref(), p.inline == Some(true));
        let found: Option<String> = self.read(|c| c.query_row("SELECT result FROM frozen WHERE resource_id = ?1 AND key = ?2", [within, &key], |r| r.get(0)).optional())?;
        Ok(found.and_then(|s| serde_json::from_str(&s).ok()))
    }

    /// What every embed and call of `id` shows now, by key.
    async fn freeze(&self, id: &str, env_id: Option<String>) -> KResult<Vec<(String, String)>> {
        let mut out = Vec::new();
        for r in self.refs_outgoing(id)? {
            if out.len() >= MAX_FROZEN {
                break;
            }
            let (embed, call) = (r.embed == Some(true), r.call == Some(true));
            let Some(target) = r.target.as_ref().map(|t| t.id.clone()) else { continue };
            if !embed && !call {
                continue;
            }
            let key = frozen_key(&target, r.section.as_deref(), r.params.as_deref(), call && !embed);
            if out.iter().any(|(k, _)| k == &key) {
                continue;
            }
            let p = ResourceEmbedParams {
                id: target,
                section: r.section.clone(),
                env_id: env_id.clone(),
                locale: None,
                args: None,
                params: r.params.clone(),
                inline: (call && !embed).then_some(true),
                within: None,
            };
            if let Ok(e) = self.resource_embed(p).await {
                out.push((key, serde_json::to_string(&e).map_err(internal)?));
            }
        }
        Ok(out)
    }

    /// `host.resources.stamp` / `host.resources.unstamp`.
    pub(crate) async fn host_stamp(&self, plugin: &'static Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        if info.ai {
            return Err(err_p(ErrorCode::Denied, &[("reason", "aiReadOnly")]));
        }
        // The user's act: a page event, a command or a run — not an event handler, not a pure computation.
        if info.pure || info.event {
            return Err(denied("notInRun"));
        }
        let id = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("id must be a string"))?;
        let o = args.get(1).cloned().unwrap_or(Value::Null);
        let text = |k: &str| -> KResult<String> {
            let v = o.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
            if v.chars().count() > MAX_STAMP_TEXT {
                return Err(invalid_params(format!("{k} is too long")));
            }
            Ok(v)
        };
        let row = self.read(|c| store::get(c, id))?.ok_or_else(|| not_found("resource"))?;
        if Registry::split(&row.kind).map(|(p, _)| p) != Some(plugin.id.as_str()) {
            return Err(denied("foreignKind"));
        }
        let me = self.me.upgrade().ok_or_else(|| internal("kernel stopped"))?;
        let actor = plugin.actor();
        match op {
            "stamp" => {
                let label = text("label")?;
                if label.is_empty() {
                    return Err(invalid_params("label"));
                }
                let signer = text("signer")?;
                // The first stamp keeps what the references show now.
                let frozen = if self.stamped(id)? { vec![] } else { self.freeze(id, info.env_id.clone()).await? };
                me.execute(actor, Command::Stamp { id: id.to_string(), label, signer, frozen }).await?;
            }
            "unstamp" => {
                let reason = text("reason")?;
                if reason.is_empty() {
                    return Err(invalid("noReason"));
                }
                me.execute(actor, Command::Unstamp { id: id.to_string(), reason }).await?;
            }
            _ => return Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("resources.{op}"))])),
        }
        Ok(json!({ "stamps": self.stamps_of(id)?.unwrap_or_default() }))
    }
}

impl Tx<'_> {
    pub(crate) fn stamp(&mut self, id: &str, label: &str, signer: &str, frozen: &[(String, String)]) -> KResult<Outcome> {
        let row = store::get(self.tx, id).map_err(crate::pipeline::db_err)?.ok_or_else(|| not_found("resource"))?;
        let count: i64 = self.tx.query_row("SELECT COUNT(*) FROM stamps WHERE resource_id = ?1", [id], |r| r.get(0)).map_err(crate::pipeline::db_err)?;
        if count as usize >= MAX_STAMPS {
            return Err(invalid("tooManyStamps"));
        }
        let actor = self.actor.as_text();
        if count == 0 {
            self.tx.execute("DELETE FROM frozen WHERE resource_id = ?1", [id]).map_err(crate::pipeline::db_err)?;
            for (k, v) in frozen {
                self.tx.execute("INSERT OR REPLACE INTO frozen (resource_id, key, result) VALUES (?1, ?2, ?3)", params![id, k, v]).map_err(crate::pipeline::db_err)?;
            }
        }
        self.tx
            .execute("INSERT INTO stamps (resource_id, seq, label, signer, at, actor) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![id, count + 1, label, signer, self.at, actor])
            .map_err(crate::pipeline::db_err)?;
        self.tx
            .execute("INSERT INTO stamp_log (resource_id, action, label, signer, rev, at, actor) VALUES (?1, 'stamp', ?2, ?3, ?4, ?5, ?6)", params![id, label, signer, row.rev, self.at, actor])
            .map_err(crate::pipeline::db_err)?;
        self.audit("resource.stamp", id, &json!({ "label": label, "signer": signer, "rev": row.rev }))?;
        Ok(Outcome { id: Some(id.to_string()), changed: true, rows: vec![row], ..Default::default() })
    }

    pub(crate) fn unstamp(&mut self, id: &str, reason: &str) -> KResult<Outcome> {
        let row = store::get(self.tx, id).map_err(crate::pipeline::db_err)?.ok_or_else(|| not_found("resource"))?;
        let n = self.tx.execute("DELETE FROM stamps WHERE resource_id = ?1", [id]).map_err(crate::pipeline::db_err)?;
        if n == 0 {
            return Ok(Outcome { id: Some(id.to_string()), changed: false, ..Default::default() });
        }
        self.tx.execute("DELETE FROM frozen WHERE resource_id = ?1", [id]).map_err(crate::pipeline::db_err)?;
        let actor = self.actor.as_text();
        self.tx
            .execute("INSERT INTO stamp_log (resource_id, action, reason, rev, at, actor) VALUES (?1, 'unstamp', ?2, ?3, ?4, ?5)", params![id, reason, row.rev, self.at, actor])
            .map_err(crate::pipeline::db_err)?;
        self.audit("resource.unstamp", id, &json!({ "reason": reason, "stamps": n, "rev": row.rev }))?;
        Ok(Outcome { id: Some(id.to_string()), changed: true, rows: vec![row], ..Default::default() })
    }
}
