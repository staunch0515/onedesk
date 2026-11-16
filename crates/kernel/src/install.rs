//! Round 7 (D345, D346, §7.5 “安装插件”): `ctx.host.plugins` — a plugin asks the user to install
//! a package. The kernel only records the request and tells the interface; checking, confirming
//! and copying go the same way as a manual install, and the interface reports the outcome with
//! `plugin.answerInstallRequest`, which the kernel hands back to the waiting plugin. Nothing in
//! the sandbox reaches `plugin.answerInstallRequest` or `app.*`: a plugin cannot answer for the user.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use onedesk_protocol::*;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::kernel::Inner;
use crate::manifest::Plugin;
use crate::pipeline::{Actor, Command};
use crate::sandbox::CallInfo;
use crate::util::*;

/// An unanswered request ends as `expired` after this long (D346).
pub const REQUEST_TTL: Duration = Duration::from_secs(5 * 60);
/// D349: after a request ends `declined`/`failed`/`expired`, the same plugin waits this long.
pub const REQUEST_COOLDOWN: Duration = Duration::from_secs(30);
/// `failed` reason handed to a request whose plugin was turned off meanwhile.
pub const GONE_DISABLED: &str = "requesterDisabled";

pub(crate) struct Pending {
    pub req: InstallRequest,
    answer: oneshot::Sender<Value>,
}

#[derive(Default)]
pub(crate) struct Requests {
    list: Mutex<Vec<Pending>>,
    /// Test hook: overrides `REQUEST_TTL`.
    pub ttl: Mutex<Option<Duration>>,
    /// Test hook: overrides `REQUEST_COOLDOWN`.
    pub cooldown: Mutex<Option<Duration>>,
    /// plugin → when its last request ended without an install (D349).
    ended: Mutex<std::collections::HashMap<String, Instant>>,
}

/// Time an invocation spends waiting for the user (D345, D349): it does not count against the
/// invocation's time budget, but does not reset it either — the deadline moves by exactly the
/// time spent waiting. Each waiting host call holds it.
#[derive(Debug, Default)]
pub struct Hold {
    n: AtomicUsize,
    /// (total time waited so far, since when it is being held now)
    waited: Mutex<(Duration, Option<Instant>)>,
}

pub struct HoldGuard(Arc<Hold>);

impl Hold {
    pub fn enter(self: &Arc<Self>) -> HoldGuard {
        let mut w = self.waited.lock().unwrap();
        if self.n.fetch_add(1, Ordering::SeqCst) == 0 {
            w.1 = Some(Instant::now());
        }
        HoldGuard(self.clone())
    }

    pub fn held(&self) -> bool {
        self.n.load(Ordering::SeqCst) > 0
    }

    /// When the budget of an invocation that started at `start` ends (while not held):
    /// start + budget + the time spent waiting for the user.
    pub fn deadline(&self, start: Instant, budget: Duration) -> Instant {
        start + budget + self.waited.lock().unwrap().0
    }
}

impl Drop for HoldGuard {
    fn drop(&mut self) {
        let mut w = self.0.waited.lock().unwrap();
        if self.0.n.fetch_sub(1, Ordering::SeqCst) == 1 {
            if let Some(since) = w.1.take() {
                w.0 += since.elapsed();
            }
        }
    }
}

/// Takes the request out of the list when the waiting call goes away (cancelled, timed out,
/// its runtime dropped) before it was answered.
struct Withdraw<'a> {
    inner: &'a Inner,
    id: String,
}

impl Drop for Withdraw<'_> {
    fn drop(&mut self) {
        let removed = {
            let mut l = self.inner.install_requests.list.lock().unwrap();
            let before = l.len();
            l.retain(|p| p.req.id != self.id);
            before != l.len()
        };
        if removed {
            self.inner.emit(topic7::INSTALL_REQUESTS, None, None);
        }
    }
}

pub const METHODS: &[&str] =
    &[method7::PLUGIN_INSTALL_REQUESTS, method7::PLUGIN_ANSWER_INSTALL_REQUEST, method7::PLUGIN_CHECK_REMOVE];

impl Inner {
    /// Round 7 methods (from the interface or the main process; never reachable from a plugin).
    pub async fn handle7(&self, m: &str, params: Value) -> KResult<Value> {
        match m {
            method7::PLUGIN_INSTALL_REQUESTS => serde_json::to_value(self.install_requests()).map_err(internal),
            method7::PLUGIN_ANSWER_INSTALL_REQUEST => {
                self.answer_install_request(crate::kernel::parse(params)?).await?;
                Ok(Value::Null)
            }
            method7::PLUGIN_CHECK_REMOVE => {
                let p: PluginVersionParams = crate::kernel::parse(params)?;
                self.check_remove(&p.plugin, &p.version).await?;
                Ok(Value::Null)
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", m)])),
        }
    }

    pub(crate) async fn host_plugins(&self, plugin: &'static Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        if !plugin.manifest.requires.plugins_install() {
            return Err(denied("notRequested"));
        }
        match op {
            "list" => Ok(json!(self
                .registry
                .ids()
                .into_iter()
                .filter_map(|id| {
                    let p = self.registry.plugin(&id)?;
                    Some(json!({
                        "id": id,
                        "name": p.label(&p.manifest.name),
                        "versions": self.registry.versions(&id).iter().map(|v| v.version.clone()).collect::<Vec<_>>(),
                        "active": self.registry.active_version(&id),
                    }))
                })
                .collect::<Vec<_>>())),
            "requestInstall" => self.request_install(plugin, info, args).await,
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("plugins.{op}"))])),
        }
    }

    /// The folder must be one the plugin can read: granted to it, its package, its `plugin-data`.
    fn request_folder(&self, plugin: &Plugin, raw: &str) -> KResult<PathBuf> {
        let path = Path::new(raw);
        if !path.is_absolute() {
            return Err(invalid("notAbsolute"));
        }
        let real = path.canonicalize().map_err(|_| denied("outsideGrant"))?;
        let mut roots: Vec<PathBuf> = vec![plugin.dir.clone(), self.plugin_data_dir(&plugin.id)?];
        if plugin.manifest.requires.files {
            roots.extend(self.folder_grants(&plugin.id)?.into_iter().map(PathBuf::from));
        }
        let inside = roots.iter().filter_map(|r| r.canonicalize().ok()).any(|r| real.starts_with(&r));
        if !inside {
            return Err(denied("outsideGrant"));
        }
        if !real.is_dir() {
            return Err(invalid("notFolder"));
        }
        Ok(real)
    }

    async fn request_install(&self, plugin: &'static Plugin, info: &CallInfo, args: &Value) -> KResult<Value> {
        // Only where the user is acting: a page event or a run (not render, migrate, events, commands).
        if info.pure || info.event || !(info.page_event || info.run_id.is_some()) {
            return Err(denied("notInteractive"));
        }
        let raw = args.get(0).and_then(|o| o.get("folder")).and_then(Value::as_str).ok_or_else(|| invalid_params("folder"))?;
        let folder = self.request_folder(plugin, raw)?.display().to_string();
        // D349: not again right after a refusal, failure or expiry (no loop of dialogs).
        let cooldown = self.install_requests.cooldown.lock().unwrap().unwrap_or(REQUEST_COOLDOWN);
        if let Some(at) = self.install_requests.ended.lock().unwrap().get(&plugin.id) {
            let left = cooldown.saturating_sub(at.elapsed());
            if !left.is_zero() {
                let secs = left.as_secs() + u64::from(left.subsec_nanos() > 0);
                return Err(err_p(ErrorCode::Conflict, &[("reason", "cooldown"), ("seconds", &secs.to_string())]));
            }
        }
        let (tx, rx) = oneshot::channel();
        let req = InstallRequest {
            id: new_id(),
            plugin: plugin.id.clone(),
            plugin_name: plugin.label(&plugin.manifest.name),
            folder: folder.clone(),
            at: now_ms(),
        };
        {
            let mut l = self.install_requests.list.lock().unwrap();
            if l.iter().any(|p| p.req.plugin == plugin.id) {
                return Err(err_p(ErrorCode::Conflict, &[("reason", "pendingRequest")]));
            }
            l.push(Pending { req: req.clone(), answer: tx });
        }
        let withdraw = Withdraw { inner: self, id: req.id.clone() };
        self.execute(plugin.actor(), Command::Audit { op: "plugin.installRequest".into(), object: folder, summary: json!({ "request": req.id }) })
            .await?;
        self.emit(topic7::INSTALL_REQUESTS, None, None);
        let _held = info.hold.enter();
        let ttl = self.install_requests.ttl.lock().unwrap().unwrap_or(REQUEST_TTL);
        let out = match tokio::time::timeout(ttl, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => json!({ "outcome": "failed", "reason": GONE_DISABLED }),
            Err(_) => json!({ "outcome": "expired" }),
        };
        drop(withdraw);
        if out["outcome"] != "installed" {
            self.install_requests.ended.lock().unwrap().insert(plugin.id.clone(), Instant::now());
        }
        Ok(out)
    }

    /// `plugin.installRequests`: the unanswered ones, oldest first.
    pub fn install_requests(&self) -> Vec<InstallRequest> {
        self.install_requests.list.lock().unwrap().iter().map(|p| p.req.clone()).collect()
    }

    /// `plugin.answerInstallRequest` (the interface; the user is the actor).
    pub async fn answer_install_request(&self, a: InstallAnswerParams) -> KResult<()> {
        let pending = {
            let mut l = self.install_requests.list.lock().unwrap();
            let i = l.iter().position(|p| p.req.id == a.id).ok_or_else(|| not_found("installRequest"))?;
            l.remove(i)
        };
        let outcome = match a.outcome {
            InstallAnswerOutcome::Installed => "installed",
            InstallAnswerOutcome::Declined => "declined",
            InstallAnswerOutcome::Failed => "failed",
        };
        let mut out = json!({ "outcome": outcome });
        match a.outcome {
            InstallAnswerOutcome::Installed => {
                // Review #12: only what the registry really has; otherwise the plugin hears `failed`.
                let found = match (&a.plugin, &a.version) {
                    (Some(p), Some(v)) => self.registry.version(p, v).is_some(),
                    _ => false,
                };
                if found {
                    out["id"] = json!(a.plugin);
                    out["version"] = json!(a.version);
                } else {
                    out = json!({ "outcome": "failed", "reason": "notInstalled" });
                }
            }
            InstallAnswerOutcome::Failed => out["reason"] = json!(a.reason),
            InstallAnswerOutcome::Declined => {}
        }
        if out["outcome"] != "installed" {
            self.install_requests.ended.lock().unwrap().insert(pending.req.plugin.clone(), Instant::now());
        }
        let mut summary = out.clone();
        summary["requester"] = json!(pending.req.plugin);
        summary["request"] = json!(pending.req.id);
        let _ = self
            .execute(Actor::User, Command::Audit { op: "plugin.installAnswer".into(), object: pending.req.folder.clone(), summary })
            .await;
        let _ = pending.answer.send(out);
        self.emit(topic7::INSTALL_REQUESTS, None, None);
        Ok(())
    }

    /// A plugin turned off: its unanswered request is void (the plugin gets `failed` + `reason`).
    pub fn drop_install_request(&self, plugin: &str, reason: &str) {
        let gone: Vec<Pending> = {
            let mut l = self.install_requests.list.lock().unwrap();
            let (gone, keep) = std::mem::take(&mut *l).into_iter().partition(|p| p.req.plugin == plugin);
            *l = keep;
            gone
        };
        if gone.is_empty() {
            return;
        }
        for p in gone {
            let _ = p.answer.send(json!({ "outcome": "failed", "reason": reason }));
        }
        self.emit(topic7::INSTALL_REQUESTS, None, None);
    }
}
