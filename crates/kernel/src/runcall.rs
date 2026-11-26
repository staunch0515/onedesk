//! D487 §25 (docs/redesign/book.md, K14): running a resource from inside a run, as the user would by pressing the first
//! "run" button on its page — its saved values as input, its `{{names}}` from the environment unless given. The kernel
//! knows no step and no book.
//! - `host.runs.call(resourceId, { params })` → `{ status: "ok" | "failed", output, data?, error?, ms }`; needs
//!   `requires.runs`, only in a run (not an AI's), at most `MAX_DEPTH` deep, never the resource the run is about.

use std::time::Instant;

use onedesk_protocol::*;
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::Plugin;
use crate::sandbox::{CallInfo, SandboxError};
use crate::store;
use crate::util::*;

/// The largest output handed back (bigger outputs are cut, `truncated: true`).
pub const MAX_CALL_OUTPUT: usize = 1024 * 1024;

impl Inner {
    pub(crate) async fn host_runs_call(&self, plugin: &'static Plugin, info: &CallInfo, args: &Value) -> KResult<Value> {
        if !plugin.manifest.requires.runs {
            return Err(denied("notRequested"));
        }
        if info.ai {
            return Err(err_p(ErrorCode::Denied, &[("reason", "aiRun"), ("method", "runs.call")]));
        }
        let run = info.run_id.clone().filter(|_| !info.pure && !info.event).ok_or_else(|| denied("notInRun"))?;
        let id = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("resource must be a string"))?.to_string();
        let given: std::collections::BTreeMap<String, String> = serde_json::from_value(args.get(1).and_then(|o| o.get("params")).cloned().unwrap_or(json!({})))
            .map_err(|_| invalid_params("params must be name → text"))?;
        let row = self.read(|c| store::get(c, &id))?.filter(|r| !self.hidden_tree(r)).ok_or_else(|| not_found("resource"))?;
        if info.resource_id.as_deref() == Some(row.id.as_str()) || info.callers.len() + 1 > crate::calls::MAX_DEPTH {
            return Err(err_p(ErrorCode::Denied, &[("reason", "loop")]));
        }
        // Its page as the user would see it in this environment: the run button, the saved values, the parameters.
        let target = format!("resource:{}", row.id);
        let cx = PageContext { env_id: info.env_id.clone(), ..Default::default() };
        let page = self.resolve(&target, cx, info.client.clone()).await?;
        let button = page.actions.iter().find(|a| matches!(a.role, ActionRole::Run | ActionRole::SaveRun)).ok_or_else(|| invalid("notRunnable"))?;
        let full = button.action.clone().unwrap_or_else(|| button.id.clone());
        let (pid, short) = crate::manifest::Registry::split(&full).ok_or_else(|| invalid("notRunnable"))?;
        let callee = match row.plugin_version.as_deref() {
            Some(v) => self.registry.version(pid, v),
            None => self.registry.plugin(pid),
        }
        .ok_or_else(|| invalid("notRunnable"))?;
        let action = callee.action(short).ok_or_else(|| invalid("notRunnable"))?;
        if !self.plugin_enabled(&callee.id) {
            return Err(err_p(ErrorCode::Denied, &[("reason", "pluginDisabled")]));
        }
        let mut params = std::collections::BTreeMap::new();
        for n in &page.view {
            if let ViewNode::Form { fields, .. } | ViewNode::Flow { fields, .. } = n {
                for f in fields.iter().filter(|f| f.param == Some(true)) {
                    if let Some(v) = f.env_value.as_ref().filter(|v| !v.is_empty()) {
                        params.insert(f.name.clone(), v.clone());
                    }
                }
            }
        }
        params.extend(given.clone());
        let mut input = page.values.clone();
        for f in self.secret_fields(&row.kind, row.plugin_version.as_deref()) {
            input.remove(&f);
        }
        let resource = serde_json::to_value(self.resource(&row)?).map_err(internal)?;
        let ctx = json!({ "target": target, "resource": resource, "envId": info.env_id, "params": params, "runId": run, "caller": plugin.id });
        // The callee stops with the caller's run.
        let parent = self.runs_active.lock().unwrap().get(&run).map(|a| a.token.clone());
        let token = crate::sandbox::CancelToken::default();
        let watcher = parent.map(|parent| {
            let child = token.clone();
            tokio::spawn(async move {
                parent.cancelled().await;
                child.cancel_with(parent.reason());
            })
        });
        let mut callers = info.callers.clone();
        callers.push(plugin.id.clone());
        let sub = CallInfo { client: info.client.clone(), env_id: info.env_id.clone(), run_id: Some(run.clone()), resource_id: Some(row.id.clone()), callers, ..Default::default() };
        let me = self.me.upgrade().ok_or_else(|| internal("kernel stopped"))?;
        me.execute(plugin.actor(), crate::pipeline::Command::Audit { op: "run.call".into(), object: row.id.clone(), summary: json!({ "action": callee.full(&action.id), "params": given.keys().collect::<Vec<_>>() }) })
            .await?;
        let started = Instant::now();
        let res = {
            // Waiting for it is not the caller's time (D361).
            let _hold = info.hold.enter_wait();
            self.call_version(callee, "actions", &action.id, "", json!([ctx, input]), sub, Some(token), Some(self.cfg.action_timeout)).await
        };
        if let Some(w) = watcher {
            w.abort();
        }
        let ms = started.elapsed().as_millis() as u64;
        Ok(match res {
            Ok(v) => {
                let failed = v.get("failed").filter(|f| !f.is_null());
                let mut output = v.get("output").cloned().unwrap_or(Value::Null);
                let mut truncated = false;
                if crate::runs::json_size(&output) > MAX_CALL_OUTPUT {
                    output = Value::Null;
                    truncated = true;
                }
                let data = v.get("data").cloned().filter(|d| crate::runs::json_size(d) <= crate::round18::ARTIFACT_MAX_BYTES);
                json!({
                    "status": if failed.is_some() { "failed" } else { "ok" },
                    "output": output,
                    "data": data,
                    "error": failed.and_then(|f| f.get("message")).cloned(),
                    "truncated": truncated.then_some(true),
                    "ms": ms,
                })
            }
            Err(SandboxError::Host(e)) => json!({ "status": "failed", "error": { "code": e.code, "params": e.params }, "ms": ms }),
            Err(SandboxError::Cancelled) => return Err(err_p(ErrorCode::Invalid, &[("reason", "cancelled")])),
            Err(SandboxError::Timeout) => json!({ "status": "failed", "error": "timeout", "ms": ms }),
            Err(other) => json!({ "status": "failed", "error": other.to_string().lines().next().unwrap_or_default().trim_start_matches("Error: "), "ms": ms }),
        })
    }
}
