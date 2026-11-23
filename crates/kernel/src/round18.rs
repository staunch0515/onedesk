//! Round 18: result-area actions (X5), ranked search (X6), plugin interfaces (X15).
//!
//! The kernel knows no particular plugin here: interface names are strings it compares, a
//! result-area action is whatever a manifest declares.

use onedesk_protocol::*;
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::{OutputType, Plugin};
use crate::pipeline::Command;
use crate::sandbox::CallInfo;
use crate::store::{self, RunRow};
use crate::util::*;

/// Most words one ranked search looks at, and most candidates it ranks.
pub const SEARCH_MAX_WORDS: usize = 16;
pub const SEARCH_MAX_CANDIDATES: usize = 2000;
/// D442: the longest artifact name (characters) and data (bytes of JSON).
pub const ARTIFACT_NAME_MAX: usize = 200;
pub const ARTIFACT_MAX_BYTES: usize = 1024 * 1024;
/// Characters of text kept on each side of a hit in a snippet.
const SNIPPET_SIDE: usize = 40;

fn output_type_of(row: &RunRow) -> Option<OutputType> {
    match row.output.as_ref()?.get("type")?.as_str()? {
        "table" => Some(OutputType::Table),
        "text" => Some(OutputType::Text),
        "link" => Some(OutputType::Link),
        "none" => Some(OutputType::None),
        _ => None,
    }
}

/// A run whose result a result-area action may be given: finished well, with an output.
fn usable_result(row: &RunRow) -> Option<OutputType> {
    (row.status == "success").then(|| output_type_of(row)).flatten()
}

impl Inner {
    /* ---------------------------------------------------------------- X5 */

    /// `result.actions`: the buttons of a finished run's result area.
    pub fn result_actions(&self, p: ResultActionsParams) -> KResult<Vec<ResultAction>> {
        let row = self.read(|c| store::run_get(c, &p.run_id))?.ok_or_else(|| not_found("run"))?;
        let Some(ty) = usable_result(&row) else { return Ok(vec![]) };
        let env = row.env_id.as_deref();
        let off = |name: &str| self.read(|c| Ok(crate::policy::deny_layer(c, name, env)?.is_some())).unwrap_or(false);
        let reason = if off(crate::policy::READONLY) {
            Some("readonly")
        } else if off(crate::policy::NO_EXPORT) {
            Some("noExport")
        } else {
            None
        };
        let mut ids = self.registry.ids();
        ids.sort();
        let mut out = Vec::new();
        for id in ids {
            let Some(pl) = self.registry.plugin(&id) else { continue };
            if pl.manifest.contributes.result_actions.is_empty()
                || !self.plugin_enabled(&pl.id)
                || !self.version_deps_met(pl)
                || !self.version_confirmed(pl)
            {
                continue;
            }
            for r in pl.manifest.contributes.result_actions.iter().filter(|r| r.output_types.contains(&ty)) {
                out.push(ResultAction {
                    plugin: pl.id.clone(),
                    id: r.id.clone(),
                    action: pl.full(&r.action),
                    label: pl.text(&r.label, p.locale.as_deref()),
                    icon: r.icon.clone(),
                    enabled: reason.is_none(),
                    disabled_reason: reason.map(String::from),
                });
            }
        }
        Ok(out)
    }

    /// `run.start` with `resultRun`: the action must be a declared result-area action, the run a
    /// finished one of a type it accepts, and the policies must let a result go to a plugin.
    pub(crate) fn check_result_run(&self, source: &str, plugin: Option<&Plugin>, action_id: Option<&str>) -> KResult<()> {
        let not_result = || invalid("notResultAction");
        let (plugin, action_id) = plugin.zip(action_id).ok_or_else(not_result)?;
        let decls: Vec<_> = plugin.manifest.contributes.result_actions.iter().filter(|r| r.action == action_id).collect();
        if decls.is_empty() {
            return Err(not_result());
        }
        let row = self.read(|c| store::run_get(c, source))?.ok_or_else(|| not_found("run"))?;
        let ty = usable_result(&row).ok_or_else(|| invalid("badResultRun"))?;
        if !decls.iter().any(|d| d.output_types.contains(&ty)) {
            return Err(invalid("badResultRun"));
        }
        self.read(|c| Ok(crate::policy::check(c, crate::policy::NO_EXPORT, row.env_id.as_deref())))?
    }

    /// `ctx.host.runs.read(runId)`: only for the plugin whose result-area action is running,
    /// and only the run that was clicked.
    pub(crate) async fn host_runs_read(&self, p: &'static Plugin, info: &CallInfo, args: &Value) -> KResult<Value> {
        let id = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("runId must be a string"))?;
        let allowed = info.run_id.as_deref().is_some_and(|r| {
            self.runs_active.lock().unwrap().get(r).is_some_and(|a| a.plugin == p.id && a.read_run.as_deref() == Some(id))
        });
        if !allowed {
            return Err(denied("notInResultAction"));
        }
        let row = self.read(|c| store::run_get(c, id))?.ok_or_else(|| not_found("run"))?;
        if usable_result(&row).is_none() {
            return Err(invalid("badResultRun"));
        }
        let mut output = row.output.clone().unwrap_or(Value::Null);
        let mut rows = None;
        if let Some(r) = output.get_mut("rows").and_then(Value::as_array_mut) {
            r.truncate(crate::runs::MAX_ROWS);
            rows = Some(r.len());
        }
        let mut meta = json!({ "plugin": row.plugin, "at": row.ended_at });
        if let Some(k) = &row.resource_kind {
            meta["kind"] = json!(k);
        }
        if let Some(r) = &row.resource_id {
            meta["resource"] = json!(r);
        }
        let summary = match rows {
            Some(n) => json!({ "rows": n }),
            None => json!({}),
        };
        let _ = self.pipeline.execute(p.actor(), Command::Audit { op: "runs.read".into(), object: id.into(), summary }).await;
        Ok(json!({ "output": output, "meta": meta }))
    }

    /* ---------------------------------------------------------------- D442 */

    /// `ctx.host.runs.saveArtifact / listArtifacts / getArtifact / deleteArtifact`: what a plugin
    /// keeps beside a run. Only its own; they go with the run.
    pub(crate) async fn host_artifacts(&self, p: &'static Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        let text = |i: usize, what: &str| -> KResult<String> {
            args.get(i).and_then(Value::as_str).map(String::from).ok_or_else(|| invalid_params(format!("{what} must be a string")))
        };
        match op {
            "saveArtifact" | "deleteArtifact" => {
                self.read(|c| Ok(crate::policy::check(c, crate::policy::READONLY, info.env_id.as_deref())))??;
            }
            _ => {}
        }
        match op {
            "saveArtifact" => {
                let run = text(0, "runId")?;
                let o = args.get(1).and_then(Value::as_object).ok_or_else(|| invalid_params("artifact must be an object"))?;
                if let Some(k) = o.keys().find(|k| !matches!(k.as_str(), "name" | "kind" | "data")) {
                    return Err(invalid_params(format!("unknown field {k}")));
                }
                let name = o.get("name").and_then(Value::as_str).filter(|n| !n.is_empty() && n.chars().count() <= ARTIFACT_NAME_MAX);
                let kind = o.get("kind").and_then(Value::as_str).filter(|k| crate::manifest::valid_program_name(k));
                let (Some(name), Some(kind)) = (name, kind) else { return Err(invalid_params("name or kind")) };
                // The clicked result's run, or (a page handler: the user saving) a run it already keeps things for.
                let clicked = info.run_id.as_deref().is_some_and(|r| {
                    self.runs_active.lock().unwrap().get(r).is_some_and(|a| a.plugin == p.id && a.read_run.as_deref() == Some(run.as_str()))
                });
                let has_own = || {
                    self.read(|c| {
                        c.query_row("SELECT EXISTS(SELECT 1 FROM run_artifacts WHERE run_id = ?1 AND plugin = ?2)", [&run, &p.id], |r| r.get::<_, bool>(0))
                    })
                    .unwrap_or(false)
                };
                if !(clicked || (info.page_event && has_own())) {
                    return Err(denied("notInResultAction"));
                }
                let mut data = o.get("data").cloned().unwrap_or(Value::Null);
                let secrets = info.run_id.as_deref().and_then(|r| self.runs_active.lock().unwrap().get(r).map(|a| a.secrets.clone())).unwrap_or_default();
                crate::secrets::scrub(&mut data, &secrets);
                let data = data.to_string();
                if data.len() > ARTIFACT_MAX_BYTES {
                    return Err(invalid("tooLarge"));
                }
                let id = new_id();
                self.pipeline
                    .execute(p.actor(), Command::ArtifactSave { id: id.clone(), run, plugin: p.id.clone(), name: name.into(), kind: kind.into(), data })
                    .await?;
                Ok(json!({ "id": id }))
            }
            "listArtifacts" => {
                let run = text(0, "runId")?;
                let rows: Vec<Value> = self.read(|c| {
                    let mut st = c.prepare("SELECT id, name, kind, created_at FROM run_artifacts WHERE run_id = ?1 AND plugin = ?2 ORDER BY rowid")?;
                    let r = st.query_map([&run, &p.id], |r| {
                        Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "kind": r.get::<_, String>(2)?, "createdAt": r.get::<_, i64>(3)? }))
                    })?;
                    r.collect()
                })?;
                Ok(Value::Array(rows))
            }
            "getArtifact" => {
                let id = text(0, "id")?;
                let row = self.read(|c| {
                    rusqlite::OptionalExtension::optional(c.query_row(
                        "SELECT run_id, name, kind, data, created_at FROM run_artifacts WHERE id = ?1 AND plugin = ?2",
                        [&id, &p.id],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?)),
                    ))
                })?;
                let (run, name, kind, data, at) = row.ok_or_else(|| not_found("artifact"))?;
                let data: Value = serde_json::from_str(&data).map_err(internal)?;
                Ok(json!({ "id": id, "runId": run, "name": name, "kind": kind, "data": data, "createdAt": at }))
            }
            "deleteArtifact" => {
                let id = text(0, "id")?;
                self.pipeline.execute(p.actor(), Command::ArtifactDelete { id, plugin: p.id.clone() }).await?;
                Ok(Value::Null)
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("runs.{op}"))])),
        }
    }

    /* ---------------------------------------------------------------- X15 */

    /// The enabled plugins implementing `interface`, by id.
    pub(crate) fn implementers(&self, interface: &str) -> Vec<&'static Plugin> {
        let mut ids = self.registry.ids();
        ids.sort();
        ids.iter()
            .filter_map(|id| self.registry.plugin(id))
            .filter(|p| p.manifest.implements.contains_key(interface) && self.plugin_enabled(&p.id))
            .collect()
    }

    pub(crate) async fn host_interfaces(&self, p: &'static Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        let interface = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("interface must be a string"))?.to_string();
        match op {
            "list" => {
                if !p.manifest.uses.contains(&interface) {
                    return Err(err_p(ErrorCode::Denied, &[("reason", "notUsed"), ("interface", &interface)]));
                }
                let list: Vec<Value> = self
                    .implementers(&interface)
                    .into_iter()
                    .map(|i| {
                        let kind = i.manifest.implements[&interface].kind.as_deref().map(|k| i.full(k));
                        json!({ "plugin": i.id, "kind": kind, "label": i.manifest.name })
                    })
                    .collect();
                Ok(Value::Array(list))
            }
            // Review #1 (D444): the connections of the implementers, without secrets; `uses` is the permission.
            "resources" => {
                if !p.manifest.uses.contains(&interface) {
                    return Err(err_p(ErrorCode::Denied, &[("reason", "notUsed"), ("interface", &interface)]));
                }
                let mut out = Vec::new();
                for i in self.implementers(&interface) {
                    let Some(k) = i.manifest.implements[&interface].kind.as_deref().map(|k| i.full(k)) else { continue };
                    for r in self.read(|c| store::of_kind(c, &k))? {
                        if r.deleted_at.is_some() {
                            continue;
                        }
                        let secret = self.secret_fields(&r.kind, r.plugin_version.as_deref());
                        let fields: serde_json::Map<String, Value> =
                            r.body.iter().filter(|(n, v)| !secret.contains(&format!("body.{n}")) && n.as_str() != crate::params::PARAMS_KEY && v.get("secret").is_none()).map(|(n, v)| (n.clone(), v.clone())).collect();
                        out.push(json!({ "id": r.id, "name": r.name, "kind": r.kind, "fields": fields }));
                    }
                }
                out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()).then(a["id"].as_str().cmp(&b["id"].as_str())));
                Ok(Value::Array(out))
            }
            "call" => self.interface_call(p, info, &interface, args).await,
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("interfaces.{op}"))])),
        }
    }

    async fn interface_call(&self, p: &'static Plugin, info: &CallInfo, interface: &str, args: &Value) -> KResult<Value> {
        if !p.manifest.uses.iter().any(|u| u == interface) {
            return Err(err_p(ErrorCode::Denied, &[("reason", "notUsed"), ("interface", interface)]));
        }
        let run = info.run_id.clone().ok_or_else(|| denied("notInRun"))?;
        let action_name = args.get(1).and_then(Value::as_str).ok_or_else(|| invalid_params("action must be a string"))?.to_string();
        let input = args.get(2).cloned().unwrap_or(Value::Null);
        let full = format!("{interface}:{action_name}");
        let impls = self.implementers(interface);
        if impls.is_empty() {
            return Err(invalid("noImplementation"));
        }
        let given = args.get(3).and_then(|o| o.get("resource"));
        // D445: an interface without a connection kind needs no resource: its implementer is called as it is.
        let anchorless = if given.is_none_or(Value::is_null) { impls.iter().copied().find(|i| i.manifest.implements[interface].kind.is_none()) } else { None };
        let (callee, resource) = match anchorless {
            Some(callee) => (callee, None),
            None => {
                let rid = given.and_then(Value::as_str).ok_or_else(|| invalid_params("resource must be a resource id"))?;
                let resource = self.read(|c| store::get(c, rid))?.filter(|r| r.deleted_at.is_none()).ok_or_else(|| not_found("resource"))?;
                // The resource is handled by the version it is bound to (§7.6), whoever implements.
                let owner = self.registry.kind_at(&resource.kind, resource.plugin_version.as_deref()).map(|(o, _)| o);
                let short = crate::manifest::Registry::split(&resource.kind).map(|(_, k)| k.to_string()).unwrap_or_default();
                let Some(callee) = owner.filter(|o| o.manifest.implements.get(interface).is_some_and(|i| i.kind.as_deref() == Some(short.as_str()))) else {
                    return Err(invalid("wrongInterface"));
                };
                (callee, Some(resource))
            }
        };
        let imp = &callee.manifest.implements[interface];
        if !self.plugin_enabled(&callee.id) || !imp.actions.contains(&action_name) {
            let mut e = invalid("noImplementation");
            e.params.insert("action".into(), action_name);
            return Err(e);
        }
        let action = callee.action(&action_name).ok_or_else(|| invalid("noImplementation"))?;
        if let (Some(kinds), Some(resource)) = (&action.kinds, &resource) {
            if !kinds.iter().any(|k| callee.kind_ref(k) == resource.kind) {
                return Err(err_p(ErrorCode::Denied, &[("reason", "wrongKind"), ("action", &full)]));
            }
        }
        let mut callers = info.callers.clone();
        callers.push(p.id.clone());
        if callers.len() > crate::calls::MAX_DEPTH || callers.iter().any(|c| c == &callee.id) {
            return Err(err_p(ErrorCode::Denied, &[("reason", "callDepth"), ("action", &full)]));
        }
        // The caller's own budget waits (like a program): the callee has one of its own.
        let _hold = info.hold.enter_wait();
        self.invoke_callee(p, info, run, callee, action, resource, callers, input, "interfaces.call", full).await
    }

    /// `ViewField.kinds` entries `@implements:<interface>`: the connection kinds of the plugins
    /// implementing it — only for a page of a plugin that `uses` the interface.
    pub(crate) fn expand_implements(&self, plugin: &Plugin, kinds: &[String]) -> Vec<String> {
        let mut out = Vec::new();
        for k in kinds {
            match k.strip_prefix("@implements:") {
                Some(i) if plugin.manifest.uses.iter().any(|u| u == i) => {
                    out.extend(self.implementers(i).into_iter().filter_map(|p| p.manifest.implements[i].kind.as_deref().map(|k| p.full(k))));
                }
                Some(_) => {}
                None => out.push(k.clone()),
            }
        }
        out
    }

    /* ---------------------------------------------------------------- X6 */

    /// Candidates of a text search on `search s JOIN resources r`: every word (`all`) or at least
    /// one (`any`) must hit; `wheres` / `args` are the other conditions (placeholders `?<n>`).
    pub(crate) fn search_candidates(&self, words: &[String], any: bool, wheres: &[String], args: &[String]) -> KResult<Vec<Candidate>> {
        let run = |words: &[String]| -> KResult<Vec<Candidate>> {
            let (mut w, mut a) = (wheres.to_vec(), args.to_vec());
            crate::round2::search_words(words, &mut a, &mut w);
            let sql = format!(
                "SELECT r.id, s.name, s.text FROM search s JOIN resources r ON r.rowid = s.rowid WHERE {} ORDER BY r.name COLLATE NOCASE, r.id LIMIT {SEARCH_MAX_CANDIDATES}",
                w.join(" AND ")
            );
            self.read(|c| {
                let mut st = c.prepare(&sql)?;
                let rows = st.query_map(rusqlite::params_from_iter(a.iter()), |r| {
                    Ok(Candidate { id: r.get(0)?, name: r.get(1)?, text: r.get(2)?, score: 0.0, snippet: String::new() })
                })?;
                rows.collect()
            })
        };
        if !any {
            return run(words);
        }
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for w in words {
            for c in run(std::slice::from_ref(w))? {
                if seen.insert(c.id.clone()) && out.len() < SEARCH_MAX_CANDIDATES {
                    out.push(c);
                }
            }
        }
        Ok(out)
    }
}

/// One resource a ranked search found, with what it needs to be ranked and shown.
pub(crate) struct Candidate {
    pub id: String,
    pub name: String,
    pub text: String,
    pub score: f64,
    pub snippet: String,
}

/// The words of a query: lower case, split on white space, at most `SEARCH_MAX_WORDS`.
pub(crate) fn query_words(text: &str) -> KResult<Vec<String>> {
    let words: Vec<String> = text.split_whitespace().map(str::to_lowercase).collect();
    if words.len() > SEARCH_MAX_WORDS {
        return Err(invalid_params("search: too many words"));
    }
    Ok(words)
}

/// Scores candidates (each word that hits adds `1 + min(count in text, 10) × 0.1`, plus `3` when
/// the name has it), fills the snippets, and orders them best first (ties: name, id). Without
/// `relevance` the score stays `0` and the order is by name.
pub(crate) fn rank(cands: &mut [Candidate], words: &[String], relevance: bool) {
    for c in cands.iter_mut() {
        let (name, text) = (c.name.to_lowercase(), c.text.to_lowercase());
        let mut score = 0.0;
        for w in words {
            let in_name = name.contains(w.as_str());
            let count = if w.is_empty() { 0 } else { text.matches(w.as_str()).count() };
            // A short word also hits a name that holds its characters in order.
            let fuzzy = w.chars().count() < 3 && {
                let mut it = name.chars();
                w.chars().all(|ch| it.any(|n| n == ch))
            };
            if !(in_name || count > 0 || fuzzy) {
                continue;
            }
            score += 1.0 + count.min(10) as f64 * 0.1 + if in_name { 3.0 } else { 0.0 };
            if c.snippet.is_empty() && count > 0 {
                c.snippet = snippet_of(&c.text, &text, w);
            }
        }
        c.score = if relevance { (score * 1000.0).round() / 1000.0 } else { 0.0 };
    }
    cands.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// About `SNIPPET_SIDE` characters either side of the first occurrence of `word`.
fn snippet_of(text: &str, lower: &str, word: &str) -> String {
    // `to_lowercase` may change byte lengths; count in characters of the lower-case text.
    let Some(at) = lower.find(word) else { return String::new() };
    let start_char = lower[..at].chars().count();
    let len = word.chars().count();
    let from = start_char.saturating_sub(SNIPPET_SIDE);
    let s: String = text.chars().skip(from).take(len + 2 * SNIPPET_SIDE).collect();
    s.replace(['\n', '\r'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: &str, name: &str, text: &str) -> Candidate {
        Candidate { id: id.into(), name: name.into(), text: text.into(), score: 0.0, snippet: String::new() }
    }

    #[test]
    fn name_hits_and_frequency_rank_first() {
        let words = vec!["orders".to_string(), "refund".to_string()];
        let mut c = vec![
            cand("a", "Notes", "orders orders orders"),
            cand("b", "Refund policy", "how a refund works"),
            cand("c", "Misc", "orders and a refund"),
        ];
        rank(&mut c, &words, true);
        let ids: Vec<&str> = c.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["b", "c", "a"], "name hit first, then more words, then frequency");
        assert!(c[0].score > c[1].score && c[1].score > c[2].score);
        assert!(c[1].snippet.contains("orders"));
    }

    #[test]
    fn without_relevance_the_order_is_by_name() {
        let mut c = vec![cand("2", "b", "x"), cand("1", "A", "x")];
        rank(&mut c, &["x".to_string()], false);
        assert_eq!((c[0].id.as_str(), c[0].score), ("1", 0.0));
    }

    #[test]
    fn interface_names() {
        use crate::manifest::valid_interface as v;
        assert!(v("onedesk.ai.chat/1") && v("a/12"));
        for bad in ["", "x", "x/", "/1", "X/1", "a/b", "a b/1", "a/1/2"] {
            assert!(!v(bad), "{bad}");
        }
    }
}
