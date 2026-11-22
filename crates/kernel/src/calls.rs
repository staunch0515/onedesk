//! `ctx.host.actions.call` (round 15, D413; design §7.5 `actions`: "its own and its dependencies'
//! exported ones").
//!
//! - `call("<pluginId>:<actionId>", input, { resource? })`, only in a run.
//! - The callee must be a plugin the caller `depends` on, and list the action in its manifest's
//!   `exports.actions`; otherwise `denied/notExported` (its own actions included: a plugin calls
//!   its own code directly).
//! - It runs **as the callee**: its sandbox, programs, secrets, network grants, and the policies
//!   (`process.allow`, `network.allow`) of the caller's tab environment. It belongs to the same run
//!   (progress, cancellation, the programs it starts). `resource`, if given, must be a resource of
//!   one of the callee's own kinds; the callee gets it as `ctx.resource` (and may use the secrets it
//!   references, D318), handled by the version it is bound to (§7.6).
//! - Nested calls at most `MAX_DEPTH` deep; deeper, or back into a plugin already on the chain →
//!   `denied/callDepth`.
//! - The caller's action budget keeps running while it waits (D417); the call also has the
//!   action timeout of its own.
//! - Input and answer are JSON. An answer whose `output.file` names a data file (X2) has that file
//!   moved into the caller's own folder and `file` rewritten to the new relative path, so the
//!   caller can hand it on as its own output.
//! - Each call is audited: actor = the callee, object = the action, summary = caller and duration.

use std::time::Instant;

use onedesk_protocol::*;
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::{Plugin, Registry};
use crate::pipeline::Command;
use crate::sandbox::{CallInfo, SandboxError};
use crate::store;
use crate::util::*;

pub const MAX_DEPTH: usize = 4;

impl Inner {
    pub(crate) async fn host_actions(&self, p: &'static Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        if op != "call" {
            return Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("actions.{op}"))]));
        }
        let full = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("action must be a string"))?.to_string();
        let input = args.get(1).cloned().unwrap_or(Value::Null);
        let opts = args.get(2).cloned().unwrap_or(Value::Null);
        let run = info.run_id.clone().ok_or_else(|| denied("notInRun"))?;
        let (pid, short) = Registry::split(&full).ok_or_else(|| invalid_params("action must be <pluginId>:<actionId>"))?;
        let not_exported = || err_p(ErrorCode::Denied, &[("reason", "notExported"), ("action", &full)]);
        let Some(dep) = p.manifest.deps.iter().find(|d| d.id == pid).filter(|_| pid != p.id) else { return Err(not_exported()) };
        let resource = match opts.get("resource") {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) => Some(self.read(|c| store::get(c, id))?.ok_or_else(|| not_found("resource"))?),
            Some(_) => return Err(invalid_params("resource must be a resource id")),
        };
        // §7.6: a resource is handled by the version it is bound to.
        let callee = match resource.as_ref().and_then(|r| r.plugin_version.as_deref()) {
            Some(v) => self.registry.version(pid, v),
            None => self.registry.plugin(pid),
        };
        // D417: the version that would run must satisfy the caller's `depends` range.
        let Some(callee) = callee.filter(|c| c.manifest.exported_actions.iter().any(|a| a == short) && dep.req.matches(&c.semver()))
        else {
            return Err(not_exported());
        };
        let action = callee.action(short).ok_or_else(not_exported)?;
        if let Some(r) = &resource {
            if self.registry.kind(&r.kind).is_none_or(|(owner, _)| owner.id != callee.id) {
                return Err(denied("notOwnResource"));
            }
        }
        // D417: an action bound to kinds is called with a resource of one of them.
        if let Some(kinds) = &action.kinds {
            if !resource.as_ref().is_some_and(|r| kinds.iter().any(|k| callee.kind_ref(k) == r.kind)) {
                return Err(err_p(ErrorCode::Denied, &[("reason", "wrongKind"), ("action", &full)]));
            }
        }
        let mut callers = info.callers.clone();
        callers.push(p.id.clone());
        if callers.len() > MAX_DEPTH || callers.iter().any(|c| c == &callee.id) {
            return Err(err_p(ErrorCode::Denied, &[("reason", "callDepth"), ("action", &full)]));
        }
        self.invoke_callee(p, info, run, callee, action, resource, callers, input, "actions.call", full).await
    }

    /// Runs `action` of `callee` inside the caller's run (shared by `actions.call` and, round 18,
    /// `interfaces.call`): its own sandbox and grants, the run's cancellation, the caller's budget
    /// kept (or held by the caller), audited as `audit_op` with the callee as actor.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn invoke_callee(
        &self,
        p: &'static Plugin,
        info: &CallInfo,
        run: String,
        callee: &'static Plugin,
        action: &crate::manifest::ActionDef,
        resource: Option<crate::store::Row>,
        callers: Vec<String>,
        input: Value,
        audit_op: &str,
        full: String,
    ) -> KResult<Value> {
        if crate::runs::json_size(&input) > crate::runs::MAX_INPUT_BYTES {
            return Err(invalid("tooLarge"));
        }
        // The callee gets a token of its own (a finished invocation ends its token), cancelled
        // when the run's is.
        let parent = self.runs_active.lock().unwrap().get(&run).map(|a| a.token.clone());
        let token = crate::sandbox::CancelToken::default();
        let watcher = parent.map(|parent| {
            let child = token.clone();
            tokio::spawn(async move {
                parent.cancelled().await;
                child.cancel_with(parent.reason());
            })
        });
        let ctx = json!({
            "target": "core:none",
            "resource": match &resource { Some(r) => Some(serde_json::to_value(self.resource(r)?).map_err(internal)?), None => None },
            "envId": info.env_id, "params": {}, "runId": run, "caller": p.id,
        });
        let sub = CallInfo {
            client: info.client.clone(),
            env_id: info.env_id.clone(),
            run_id: Some(run.clone()),
            resource_id: resource.as_ref().map(|r| r.id.clone()),
            callers,
            ai: info.ai,
            ..Default::default()
        };
        let started = Instant::now();
        // D417: the caller's budget keeps running while it waits (unlike programs and transfers).
        let res = {
            self.call_version(callee, "actions", &action.id, "", json!([ctx, input]), sub, Some(token), Some(self.cfg.action_timeout)).await
        };
        if let Some(w) = watcher {
            w.abort();
        }
        let ms = started.elapsed().as_millis() as u64;
        let res = match res {
            // D441: `data` goes to the caller as it is, at most 1 MB.
            Ok(v) if v.get("data").is_some_and(|d| crate::runs::json_size(d) > crate::round18::ARTIFACT_MAX_BYTES) => {
                let mut e = err_p(ErrorCode::PluginError, &[("reason", "badOutput")]);
                e.detail = Some("data is over 1 MB".into());
                Err(e)
            }
            Ok(v) => self.hand_over_file(callee, p, Some(&run), v).await,
            Err(SandboxError::Host(e)) => Err(e),
            Err(SandboxError::Cancelled) => Err(err_p(ErrorCode::Invalid, &[("reason", "cancelled")])),
            Err(SandboxError::Timeout) => Err(err_p(ErrorCode::Invalid, &[("reason", "timeout"), ("action", &full)])),
            Err(SandboxError::Js(m)) => {
                let first = m.lines().next().unwrap_or_default().trim_start_matches("Error: ").to_string();
                let mut e = err_p(ErrorCode::PluginError, &[("reason", "calleeFailed"), ("action", &full)]);
                e.detail = Some(first);
                Err(e)
            }
            Err(other) => {
                let mut e = err_p(ErrorCode::PluginError, &[("reason", "calleeFailed"), ("action", &full)]);
                e.detail = Some(other.to_string());
                Err(e)
            }
        };
        // Round 16: the callee's words reach the caller, without the secret values this run read
        // (the caller is another plugin, and may show them).
        let res = res.map_err(|mut e| {
            let secrets = self.runs_active.lock().unwrap().get(&run).map(|a| a.secrets.clone()).unwrap_or_default();
            if let Some(d) = e.detail.take() {
                let mut v = Value::String(d);
                crate::secrets::scrub(&mut v, &secrets);
                e.detail = v.as_str().map(String::from);
            }
            // Review #4: and the params a plugin filled in.
            for val in e.params.values_mut() {
                let mut v = Value::String(std::mem::take(val));
                crate::secrets::scrub(&mut v, &secrets);
                *val = v.as_str().unwrap_or_default().to_string();
            }
            e
        });
        let summary = json!({ "caller": p.id, "ms": ms, "ok": res.is_ok() });
        let cmd = Command::Audit { op: audit_op.into(), object: full.clone(), summary };
        let _ = self.pipeline.execute(callee.actor(), cmd).await;
        res
    }

    /// X2 across a call: a data file in the callee's answer moves to the caller's own folder.
    async fn hand_over_file(&self, callee: &'static Plugin, caller: &'static Plugin, run: Option<&str>, mut v: Value) -> KResult<Value> {
        let Some(file) = v.get("output").and_then(|o| o.get("file")).and_then(Value::as_str).map(String::from) else { return Ok(v) };
        let bad = |why: String| {
            let mut e = err_p(ErrorCode::PluginError, &[("reason", "badOutput")]);
            e.detail = Some(why);
            e
        };
        let (grants, abs) = self.transfer_end(callee, &file).map_err(|e| bad(format!("data file {file}: {:?}", e.params)))?;
        let real = crate::files::resolve(&grants, &abs).map_err(|e| bad(format!("data file {file}: {:?}", e.params)))?;
        // Review #12: only a regular file (never a folder such as `tmp`, nor a link).
        if !std::fs::symlink_metadata(&real).is_ok_and(|m| m.is_file()) {
            return Err(bad(format!("data file {file}: not a regular file")));
        }
        let own = self.plugin_data_dir(&callee.id)?.canonicalize().map_err(internal)?;
        let name = format!("call-{}{}", crate::util::new_id(), real.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default());
        let to = self.plugin_data_dir(&caller.id)?.join("tmp").join(&name);
        let moved = real.starts_with(&own) && std::fs::rename(&real, &to).is_ok();
        if !moved {
            std::fs::copy(&real, &to).map_err(|e| bad(format!("data file {file}: {e}")))?;
        }
        // Review #12: removed when the caller's run ends if it was not handed on.
        if let Some(r) = run {
            if let Some(a) = self.runs_active.lock().unwrap().get_mut(r) {
                a.handed.push(to.clone());
            }
        }
        v["output"]["file"] = Value::String(format!("tmp/{name}"));
        Ok(v)
    }
}
