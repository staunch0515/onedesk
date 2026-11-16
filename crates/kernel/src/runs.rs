//! Round 3 (docs/handoff/round3-plan.md): runs (§8), page events (§9.3), plugin state and
//! settings (§6.1, §7.1, D290), the command palette.

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

use onedesk_protocol::method3 as M;
use onedesk_protocol::*;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::kernel::{kernel_cmd, parse, Inner};
use crate::manifest::{ActionDef, OutputType, Plugin, Registry, SettingType};
use crate::pipeline::{Actor, Command};
use crate::sandbox::{CallInfo, CancelToken, SandboxError};
use crate::store::{self, Row, RunRow};
use crate::util::*;

/// Method names this module answers.
pub const METHODS: &[&str] = &[
    M::RUN_START, M::RUN_GET, M::RUN_CANCEL, M::RUN_LIST_FOR, M::RUN_TASKS, M::RUN_CLEAR_FINISHED, M::RUN_SET_KEPT,
    M::RUN_RENDER, M::PAGE_EVENT, M::PLUGIN_GET, M::PLUGIN_SET_ENABLED, M::PLUGIN_SET_SETTING, M::PLUGIN_RELOAD,
    M::COMMAND_PALETTE,
];

pub const MAX_ROWS: usize = 1000;
/// D295: the run's input snapshot and a page's draft, serialized.
pub const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;

/// Serialized size of a value (for the D295 limits).
pub fn json_size<T: serde::Serialize>(v: &T) -> usize {
    serde_json::to_string(v).map(|s| s.len()).unwrap_or(usize::MAX)
}
pub const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
/// D295: a setting value.
pub const MAX_SETTING_BYTES: usize = 4 * 1024;
pub const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// A run whose action is executing in this process.
pub struct ActiveRun {
    pub plugin: String,
    pub token: CancelToken,
    pub last_progress: Option<Instant>,
    /// Why it was stopped from outside: `cancelled` or `pluginDisabled`.
    pub stopped: Option<&'static str>,
    /// Plain secret values the action read (§7.5): scrubbed from output, summary, progress.
    pub secrets: Vec<String>,
}

pub type ActiveRuns = std::sync::Mutex<HashMap<String, ActiveRun>>;

fn to_value<T: serde::Serialize>(v: T) -> KResult<Value> {
    serde_json::to_value(v).map_err(internal)
}

fn run_error(code: &str, message: impl Into<String>, detail: Option<String>) -> Value {
    json!({ "code": code, "message": message.into(), "detail": detail })
}

/// D318: a host refusal or failure keeps its reason code (`secretNotAllowed`, `hostNotAllowed`…).
fn run_error_reason(code: &str, reason: Option<&String>, detail: Option<String>) -> Value {
    json!({ "code": code, "message": "", "detail": detail, "reason": reason })
}

/// What an action handler returns (D285).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActionOut {
    output: Value,
    #[serde(default)]
    summary: Option<SummaryIn>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SummaryIn {
    #[serde(default)]
    rows: Option<u64>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TableIn {
    #[serde(rename = "type")]
    _t: String,
    columns: Vec<OutputColumn>,
    rows: Vec<Vec<Value>>,
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    truncated: Option<bool>,
}

/// Checks the plugin's output against the declared type, truncates tables, limits the size.
fn check_output(declared: OutputType, out: Value) -> Result<RunOutput, String> {
    let ty = out.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
    let want = match declared {
        OutputType::Table => "table",
        OutputType::Text => "text",
        OutputType::Link => "link",
        OutputType::None => "none",
    };
    if ty != want {
        return Err(format!("declared {want}, got {ty:?}"));
    }
    let o = match declared {
        OutputType::Table => {
            let t: TableIn = serde_json::from_value(out).map_err(|e| e.to_string())?;
            let produced = t.rows.len() as u64;
            let total = t.total.unwrap_or(produced).max(produced);
            let mut rows = t.rows;
            rows.truncate(MAX_ROWS);
            let truncated = t.truncated.unwrap_or(false) || total > rows.len() as u64;
            RunOutput::Table { columns: t.columns, rows, total, truncated }
        }
        _ => serde_json::from_value::<RunOutput>(out).map_err(|e| e.to_string())?,
    };
    if let RunOutput::Link { target, .. } = &o {
        if !crate::pages::is_target(target) {
            return Err(format!("bad link target {target}"));
        }
    }
    let size = serde_json::to_string(&o).map(|s| s.len()).unwrap_or(usize::MAX);
    if size > MAX_OUTPUT_BYTES {
        return Err(format!("output is {size} bytes"));
    }
    Ok(o)
}

impl Inner {
    pub async fn handle3(&self, client: Option<String>, m: &str, params: Value) -> Option<KResult<Value>> {
        Some(match m {
            M::RUN_START => match parse::<RunStartParams>(params) {
                Ok(p) => self.run_start(p, client).await.and_then(to_value),
                Err(e) => Err(e),
            },
            M::RUN_GET => parse::<RunIdParams>(params).and_then(|p| self.run_get(&p.id, true)).and_then(to_value),
            M::RUN_CANCEL => match parse::<RunIdParams>(params) {
                Ok(p) => self.run_cancel(&p.id).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::RUN_LIST_FOR => parse::<ResourceIdParams>(params)
                .and_then(|p| self.runs_list("resource_id = ?1", &p.id))
                .and_then(to_value),
            M::RUN_TASKS => self.runs_list("in_task_panel = 1 AND ?1 = ?1", "").and_then(to_value),
            M::RUN_CLEAR_FINISHED => match self.pipeline.execute(Actor::User, Command::RunClearFinished).await {
                Ok(_) => {
                    self.emit(topic3::RUNS, None, None);
                    Ok(Value::Null)
                }
                Err(e) => Err(e),
            },
            M::RUN_SET_KEPT => match parse::<RunSetKeptParams>(params) {
                Ok(p) => self.run_keep(&p.id, p.kept, p.name).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::RUN_RENDER => match parse::<RunRenderParams>(params) {
                Ok(p) => self.run_render(&p.id, &p.tab_id, p.locale, client).await.and_then(to_value),
                Err(e) => Err(e),
            },
            M::PAGE_EVENT => match parse::<PageEventParams>(params) {
                Ok(p) => self.page_event(p, client).await.and_then(to_value),
                Err(e) => Err(e),
            },
            M::PLUGIN_GET => parse::<PluginParams>(params).and_then(|p| self.plugin_detail(&p.plugin)).and_then(to_value),
            M::PLUGIN_SET_ENABLED => match parse::<PluginSetEnabledParams>(params) {
                Ok(p) => self.set_enabled(&p.plugin, p.enabled).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::PLUGIN_SET_SETTING => match parse::<PluginSetSettingParams>(params) {
                Ok(p) => self.set_setting(p).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::PLUGIN_RELOAD => match parse::<PluginParams>(params) {
                Ok(p) => {
                    if self.registry.plugin(&p.plugin).is_none() {
                        Err(not_found("plugin"))
                    } else {
                        // The code is read again on next use; the manifest is read at start (see handoff).
                        self.drop_runtime(&p.plugin).await;
                        self.emit(topic::PLUGINS, None, None);
                        Ok(Value::Null)
                    }
                }
                Err(e) => Err(e),
            },
            M::COMMAND_PALETTE => to_value(self.palette()),
            _ => return None,
        })
    }

    /* ---------------------------------------------------------------- runs */

    fn run_events(&self, id: &str) {
        self.emit(topic3::RUNS, None, None);
        self.emit(format!("{}{id}", topic3::RUN), None, None);
    }

    /// Finds the action a `run.start` names: a page item id (via the resource's page), a short
    /// action id of the resource's plugin, or a full `<plugin>:<action>`.
    fn resolve_action(&self, p: &RunStartParams, res: Option<&Row>) -> Option<(&'static Plugin, &'static ActionDef)> {
        // A resource is handled by the version it is bound to (§7.6).
        let bound = |pid: &str| -> Option<&'static Plugin> {
            res.and_then(|r| {
                let v = r.plugin_version.as_deref()?;
                (Registry::split(&r.kind)?.0 == pid).then(|| self.registry.version(pid, v)).flatten()
            })
        };
        if let Some((pid, a)) = Registry::split(&p.action) {
            let plugin = bound(pid).or_else(|| self.registry.plugin(pid))?;
            return Some((plugin, plugin.action(a)?));
        }
        let kind = res.map(|r| r.kind.clone()).or_else(|| match crate::pages::parse_target(&p.target) {
            crate::pages::Target::New { kind, .. } => Some(kind),
            _ => None,
        });
        let version = res.and_then(|r| r.plugin_version.clone());
        let (plugin, page) = match kind.as_deref().and_then(|k| self.registry.kind_at(k, version.as_deref())) {
            Some((pl, k)) => (pl, k.page.clone()),
            None => match crate::pages::parse_target(&p.target) {
                crate::pages::Target::Node { tree, .. } => {
                    let (pl, t) = self.registry.tree(&tree)?;
                    (pl, t.page.clone())
                }
                _ => return None,
            },
        };
        let via_page = page
            .and_then(|pg| plugin.page(&pg))
            .and_then(|pg| pg.actions.iter().find(|i| i.id == p.action))
            .and_then(|i| i.action.clone());
        let short = via_page.unwrap_or_else(|| p.action.clone());
        Some((plugin, plugin.action(&short)?))
    }

    pub async fn run_start(&self, p: RunStartParams, client: Option<String>) -> KResult<String> {
        // D327: a run writes its record, so read-only refuses the whole run (with the tab's environment).
        if let Err(e) = self.read(|c| Ok(crate::policy::check(c, crate::policy::READONLY, p.env_id.as_deref())))? {
            let _ = self
                .pipeline
                .execute(Actor::User, Command::Refused { op: "run.start".into(), object: p.action.clone(), error: e.clone() })
                .await;
            return Err(e);
        }
        let id = new_id();
        let res = match &p.resource_id {
            Some(r) => self.read(|c| store::get(c, r))?.filter(|r| !self.hidden_tree(r)),
            None => None,
        };
        let resolved = self.resolve_action(&p, res.as_ref());
        let env_name = match &p.env_id {
            Some(e) => self.read(|c| store::get(c, e))?.filter(|r| r.kind == store::KIND_ENV).map(|r| r.name),
            None => None,
        };
        let (plugin_id, action_full, label, icon) = match resolved {
            Some((pl, a)) => (pl.id.clone(), pl.full(&a.id), pl.label(&a.label), a.icon.clone()),
            None => (String::new(), p.action.clone(), Label::Text(p.action.clone()), None),
        };
        let row = RunRow {
            id: id.clone(),
            title: res.as_ref().map(|r| r.name.clone()).unwrap_or_else(|| action_full.clone()),
            icon: res.as_ref().map(|r| self.row_meta(r).icon).or(icon).unwrap_or_else(|| "play".into()),
            resource_id: res.as_ref().map(|r| r.id.clone()).or(p.resource_id.clone()),
            resource_kind: res.as_ref().map(|r| r.kind.clone()),
            plugin: plugin_id.clone(),
            action: action_full,
            action_label: serde_json::to_value(&label).map_err(internal)?,
            tab_id: Some(p.tab_id.clone()),
            env_id: p.env_id.clone(),
            env_name,
            source: "manual".into(),
            status: "running".into(),
            params: serde_json::to_value(&p.params).map_err(internal)?,
            input: {
                // D306 / review #3: secret fields never enter the snapshot — for a saved resource
                // and for an unsaved `new:` page alike.
                let fields = match &res {
                    Some(r) => self.secret_fields(&r.kind, r.plugin_version.as_deref()),
                    None => match crate::pages::parse_target(&p.target) {
                        crate::pages::Target::New { kind, .. } => self.secret_fields(&kind, None),
                        _ => vec![],
                    },
                };
                Value::Object(p.input.clone().into_iter().filter(|(k, _)| !fields.contains(k)).collect())
            },
            in_task_panel: true,
            ..Default::default()
        };
        self.pipeline.execute(Actor::User, Command::RunInsert(Box::new(row))).await?;
        self.run_events(&id);

        // Every failure from here on is an `error` run, not a protocol error (D288); a kernel
        // fault after the row exists also ends the run instead of leaving it `running` (#8).
        if let Err(e) = self.run_launch(&id, &p, res.as_ref(), resolved, client).await {
            self.run_end(&id, None, "error", None, Some(run_error("pluginError", "", e.detail.or(Some(format!("{:?}", e.code))))), None).await;
        }
        Ok(id)
    }

    async fn run_launch(
        &self,
        id: &str,
        p: &RunStartParams,
        res: Option<&Row>,
        resolved: Option<(&'static Plugin, &'static ActionDef)>,
        client: Option<String>,
    ) -> KResult<()> {
        let id = id.to_string();
        let Some((plugin, action)) = resolved else {
            self.run_end(&id, None, "error", None, Some(run_error("unknownAction", "", None)), None).await;
            return Ok(());
        };
        let refuse = |detail: &str| Some(run_error("invalidInput", "", Some(detail.to_string())));
        // The kind the run is about: the resource's, or the one an unsaved `new:` page will create (#1).
        let kind = res.map(|r| r.kind.clone()).or_else(|| match crate::pages::parse_target(&p.target) {
            crate::pages::Target::New { kind, .. } => Some(kind),
            _ => None,
        });
        if let Some(kinds) = &action.kinds {
            if !kind.as_ref().is_some_and(|k| kinds.iter().any(|x| &plugin.full(x) == k)) {
                self.run_end(&id, Some(plugin), "error", None, refuse("action does not apply to this resource"), None).await;
                return Ok(());
            }
        }
        // #2: a resource of another plugin (or of the kernel) is never handed to this action.
        if let Some(r) = res {
            if self.registry.kind(&r.kind).is_none_or(|(owner, _)| owner.id != plugin.id) {
                self.run_end(&id, Some(plugin), "error", None, refuse("resource of another plugin"), None).await;
                return Ok(());
            }
        }
        // D295: input snapshot and parameters at most 8 MB.
        if json_size(&p.input) > MAX_INPUT_BYTES || json_size(&p.params) > MAX_INPUT_BYTES {
            self.run_end(&id, Some(plugin), "error", None, refuse("input too large"), None).await;
            return Ok(());
        }
        if !self.plugin_enabled(&plugin.id) {
            self.run_end(&id, Some(plugin), "error", None, Some(run_error("pluginDisabled", "", None)), None).await;
            return Ok(());
        }
        let token = CancelToken::default();
        self.runs_active.lock().unwrap().insert(
            id.clone(),
            ActiveRun { plugin: plugin.id.clone(), token: token.clone(), last_progress: None, stopped: None, secrets: vec![] },
        );
        let resource = match res {
            Some(r) => Some(self.resource(r)?),
            None => None,
        };
        let ctx = json!({ "target": p.target, "resource": resource, "envId": p.env_id, "params": p.params, "runId": id,
                          "locale": p.locale });
        // D306: secret field values never reach the plugin, nor the run's input snapshot.
        let mut input = p.input.clone();
        if let Some(k) = kind.as_deref() {
            for f in self.secret_fields(k, res.and_then(|r| r.plugin_version.as_deref())) {
                input.remove(&f);
            }
        }
        let args = json!([ctx, input]);
        let me = self.me.upgrade().ok_or_else(|| internal("kernel stopped"))?;
        let (run_id, pid, aid, declared) = (id.clone(), plugin.id.clone(), action.id.clone(), action.output);
        let runner: &'static Plugin = plugin;
        let info = CallInfo {
            client,
            env_id: p.env_id.clone(),
            run_id: Some(id.clone()),
            pure: false,
            resource_id: res.map(|r| r.id.clone()),
            event: false,
        };
        let started = Instant::now();
        // Executes in the background; `run.start` answers now.
        tokio::spawn(async move {
            let timeout = me.cfg.action_timeout;
            let res = me.call_version(runner, "actions", &aid, "", args, info, Some(token), Some(timeout)).await;
            let (stopped, secrets) = match me.runs_active.lock().unwrap().remove(&run_id) {
                Some(a) => (a.stopped, a.secrets),
                None => (None, vec![]),
            };
            let plugin = me.registry.plugin(&pid);
            let ms = started.elapsed().as_millis() as i64;
            let (status, summary, error, output) = match (stopped, res) {
                (Some("pluginDisabled"), _) => ("error", None, Some(run_error("pluginDisabled", "", None)), None),
                (Some(_), _) | (None, Err(SandboxError::Cancelled)) => ("cancelled", None, None, None),
                (None, Ok(v)) => match serde_json::from_value::<ActionOut>(v).map_err(|e| e.to_string()).and_then(|o| {
                    let out = check_output(declared, o.output)?;
                    Ok((out, o.summary))
                }) {
                    Ok((out, s)) => {
                        let rows = match &out {
                            RunOutput::Table { total, .. } => Some(*total),
                            _ => None,
                        };
                        let summary = RunSummary {
                            rows: s.as_ref().and_then(|s| s.rows).or(rows),
                            message: s.and_then(|s| s.message),
                            duration_ms: Some(ms),
                        };
                        ("success", Some(json!(summary)), None, Some(json!(out)))
                    }
                    Err(e) => ("error", None, Some(run_error("badOutput", "", Some(e))), None),
                },
                (None, Err(e)) => {
                    let err = match e {
                        SandboxError::Timeout => run_error("timeout", "", None),
                        SandboxError::Js(m) => {
                            let first = m.lines().next().unwrap_or_default().trim_start_matches("Error: ").to_string();
                            run_error("pluginError", first, Some(m))
                        }
                        SandboxError::Host(pe) => {
                            let code = serde_json::to_value(pe.code).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
                            let code = pe.params.get("reason").filter(|r| r.as_str() == "pluginDisabled").cloned().unwrap_or(code);
                            run_error_reason(&code, pe.params.get("reason"), pe.detail)
                        }
                        other => run_error("pluginError", "", Some(other.to_string())),
                    };
                    ("error", None, Some(err), None)
                }
            };
            let mut summary = summary.or_else(|| Some(json!(RunSummary { rows: None, message: None, duration_ms: Some(ms) })));
            let (mut output, mut error) = (output, error);
            for v in [&mut summary, &mut output, &mut error].into_iter().flatten() {
                crate::secrets::scrub(v, &secrets);
            }
            me.run_end(&run_id, plugin, status, summary, error, output).await;
        });
        Ok(())
    }

    async fn run_end(
        &self,
        id: &str,
        plugin: Option<&Plugin>,
        status: &str,
        summary: Option<Value>,
        error: Option<Value>,
        output: Option<Value>,
    ) {
        self.runs_active.lock().unwrap().remove(id);
        // The action's part is the plugin's doing; kernel refusals are the kernel's.
        let actor = plugin.map(|p| p.actor()).unwrap_or(Actor::Core);
        let cmd = Command::RunFinish { id: id.into(), status: status.into(), summary, error, output };
        if let Err(e) = self.pipeline.execute(actor, cmd).await {
            eprintln!("onedesk: could not record the end of run {id}: {e:?}");
        }
        self.procs.forget_run(id);
        self.run_events(id);
        // Round 6 (D335): the plugin whose action it was hears that it ended.
        if let Ok(Some(r)) = self.read(|c| store::run_get(c, id)) {
            if !r.plugin.is_empty() && r.status != "running" {
                let action = r.action.strip_prefix(&format!("{}:", r.plugin)).unwrap_or(&r.action).to_string();
                let mut payload = json!({ "run": id, "action": action, "status": r.status });
                if let Some(res) = &r.resource_id {
                    payload["resource"] = json!(res);
                }
                self.deliver(&r.plugin, crate::events::RUN_ENDED, payload);
            }
        }
    }

    /// Throttled: at most one progress write and event per run every 100 ms.
    pub async fn run_progress(&self, id: &str, fraction: Option<f64>, message: Option<String>) {
        {
            let mut active = self.runs_active.lock().unwrap();
            let Some(a) = active.get_mut(id) else { return };
            if a.token.is_cancelled() || a.last_progress.is_some_and(|t| t.elapsed() < PROGRESS_EVERY) {
                return;
            }
            a.last_progress = Some(Instant::now());
        }
        let secrets = self.runs_active.lock().unwrap().get(id).map(|a| a.secrets.clone()).unwrap_or_default();
        let mut progress = json!(RunProgress { fraction: fraction.map(|f| f.clamp(0.0, 1.0)), message });
        crate::secrets::scrub(&mut progress, &secrets);
        if self.pipeline.execute(Actor::Core, Command::RunProgress { id: id.into(), progress }).await.is_ok() {
            self.run_events(id);
        }
    }

    pub async fn run_cancel(&self, id: &str) -> KResult<()> {
        let row = self.read(|c| store::run_get(c, id))?.ok_or_else(|| not_found("run"))?;
        let active = {
            let mut map = self.runs_active.lock().unwrap();
            map.get_mut(id).map(|a| {
                a.stopped.get_or_insert("cancelled");
                a.token.clone()
            })
        };
        match active {
            Some(t) => t.cancel(),
            // Not executing here (e.g. finished meanwhile): only a leftover `running` row is closed.
            None if row.status == "running" => self.run_end(id, None, "cancelled", None, None, None).await,
            None => {}
        }
        Ok(())
    }

    /// Stops every run of a plugin (it was disabled).
    pub fn stop_runs_of(&self, plugin: &str) {
        for a in self.runs_active.lock().unwrap().values_mut().filter(|a| a.plugin == plugin) {
            a.stopped.get_or_insert("pluginDisabled");
            a.token.cancel();
        }
    }

    async fn run_keep(&self, id: &str, kept: bool, name: Option<String>) -> KResult<()> {
        self.pipeline.execute(Actor::User, Command::RunKeep { id: id.into(), kept, name }).await?;
        self.run_events(id);
        Ok(())
    }

    pub fn run_to_protocol(&self, r: RunRow, with_output: bool) -> Run {
        let cancellable = r.status == "running" && self.runs_active.lock().unwrap().contains_key(&r.id);
        Run {
            status: match r.status.as_str() {
                "running" => RunStatus::Running,
                "success" => RunStatus::Success,
                "cancelled" => RunStatus::Cancelled,
                _ => RunStatus::Error,
            },
            id: r.id,
            seq: r.seq,
            title: r.title,
            icon: r.icon,
            resource_id: r.resource_id,
            action: r.action.clone(),
            action_label: serde_json::from_value(r.action_label).unwrap_or(Label::Text(r.action)),
            tab_id: r.tab_id,
            env_id: r.env_id,
            env_name: r.env_name,
            actor: r.actor,
            source: r.source,
            started_at: r.started_at,
            ended_at: r.ended_at,
            params: serde_json::from_value(r.params).unwrap_or_default(),
            input: serde_json::from_value(r.input).unwrap_or_default(),
            progress: r.progress.and_then(|v| serde_json::from_value(v).ok()),
            summary: r.summary.and_then(|v| serde_json::from_value(v).ok()),
            error: r.error.and_then(|v| serde_json::from_value(v).ok()),
            output: if with_output { r.output.and_then(|v| serde_json::from_value(v).ok()) } else { None },
            kept: r.kept,
            kept_name: r.kept_name,
            in_task_panel: r.in_task_panel,
            cancellable,
        }
    }

    pub fn run_get(&self, id: &str, with_output: bool) -> KResult<Option<Run>> {
        Ok(self.read(|c| store::run_get(c, id))?.map(|r| self.run_to_protocol(r, with_output)))
    }

    pub fn runs_list(&self, where_: &str, arg: &str) -> KResult<Vec<Run>> {
        Ok(self
            .read(|c| store::runs_where(c, where_, arg, crate::pipeline::RUNS_KEPT))?
            .into_iter()
            .map(|r| self.run_to_protocol(r, false))
            .collect())
    }

    /// The plugin and page that draw a run (its resource kind's page).
    fn run_page(&self, r: &RunRow) -> Option<(&Plugin, String)> {
        let (p, k) = self.registry.kind(r.resource_kind.as_deref()?)?;
        Some((p, k.page.clone()?))
    }

    async fn run_render(&self, id: &str, tab: &str, locale: Option<String>, client: Option<String>) -> KResult<Vec<ViewNode>> {
        let r = self.read(|c| store::run_get(c, id))?.ok_or_else(|| not_found("run"))?;
        let (plugin, page) = self.run_page(&r).ok_or_else(|| not_found("page"))?;
        let declared = plugin
            .page(&page)
            .and_then(|p| p.result_tabs.iter().find(|t| t.id == tab))
            .is_some_and(|t| t.tab_type == ResultTabType::View);
        if !declared {
            return Err(not_found("tab"));
        }
        let resource = match r.resource_id.as_deref().and_then(|i| self.read(|c| store::get(c, i)).ok().flatten()) {
            Some(row) => Some(self.resource(&row)?),
            None => None,
        };
        let run = self.run_to_protocol(r, true);
        let ctx = json!({ "target": format!("run:{id}"), "run": run, "resource": resource, "envId": run.env_id, "locale": locale });
        let out = self.call_plugin(&plugin.id, "pages", &page, "renderResultTab", json!([ctx, tab]), client).await?;
        serde_json::from_value(out).map_err(|e| err_p_detail(ErrorCode::PluginError, "badOutput", e.to_string()))
    }

    /* ---------------------------------------------------------------- page events (§9.3) */

    async fn page_event(&self, p: PageEventParams, client: Option<String>) -> KResult<PageEventResult> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct EventOut {
            #[serde(default)]
            changes: Option<JsonMap>,
            #[serde(default)]
            message: Option<Label>,
        }
        let cx = p.context.unwrap_or_default();
        if json_size(&cx.draft) > MAX_INPUT_BYTES {
            return Err(err_p(ErrorCode::InvalidParams, &[("reason", "tooLarge")]));
        }
        let (plugin, page, mut ctx) = self.page_owner(&p.target)?;
        if !self.plugin_enabled(&plugin.id) {
            return Err(err_p(ErrorCode::PluginError, &[("reason", "pluginDisabled")]));
        }
        let fields = match &ctx["resource"] {
            Value::Object(r) => self.secret_fields(
                r.get("kind").and_then(Value::as_str).unwrap_or_default(),
                r.get("pluginVersion").and_then(Value::as_str),
            ),
            _ => vec![],
        };
        ctx["draft"] = json!(crate::pages::strip(cx.draft.clone(), &fields));
        ctx["locale"] = json!(cx.locale);
        ctx["envId"] = json!(cx.env_id);
        let resource_id = ctx["resource"]["id"].as_str().map(String::from);
        let info = CallInfo { client, env_id: cx.env_id.clone(), resource_id, ..Default::default() };
        let out = self
            .call_version(plugin, "pages", &page, "onEvent", json!([ctx, p.event]), info, None, None)
            .await
            .map_err(|e| e.to_protocol())?;
        let out = if out.is_null() { json!({}) } else { out };
        let e: EventOut = serde_json::from_value(out).map_err(|e| err_p_detail(ErrorCode::PluginError, "badOutput", e.to_string()))?;
        // D294: only fields the page shows (bind paths of this render) may change.
        let changes = match e.changes {
            Some(ch) if !ch.is_empty() => {
                let shown = self.resolve(&p.target, PageContext { draft: cx.draft.clone(), ..cx.clone() }, None).await?;
                let binds = crate::pages::bind_paths(&shown.view);
                // D311: never the fields only the user may set (granting addresses, secret references).
                let protected: Vec<String> = self.page_protected(&p.target);
                Some(ch.into_iter().filter(|(k, _)| binds.contains(k) && !protected.contains(k)).collect())
            }
            other => other,
        };
        Ok(PageEventResult { changes, message: e.message })
    }

    /// `body.<key>` paths of the target's kind that only a user may change (D311).
    fn page_protected(&self, target: &str) -> Vec<String> {
        let kind = match crate::pages::parse_target(target) {
            crate::pages::Target::Resource(id) => self.read(|c| store::get(c, &id)).ok().flatten().map(|r| r.kind),
            crate::pages::Target::New { kind, .. } => Some(kind),
            _ => None,
        };
        kind.and_then(|k| self.rules.read().unwrap().get(&k).map(|r| r.protected.iter().map(|f| format!("body.{f}")).collect()))
            .unwrap_or_default()
    }

    /// The plugin page behind a target, with the base `ctx` for it.
    fn page_owner(&self, target: &str) -> KResult<(&'static Plugin, String, Value)> {
        use crate::pages::Target;
        match crate::pages::parse_target(target) {
            Target::Resource(id) => {
                let r = self.live_row(&id)?;
                let (p, k) = self.registry.kind_at(&r.kind, r.plugin_version.as_deref()).ok_or_else(|| not_found("page"))?;
                let page = k.page.clone().ok_or_else(|| not_found("page"))?;
                Ok((p, page, json!({ "target": target, "resource": self.resource(&r)? })))
            }
            Target::New { kind, .. } => {
                let (p, k) = self.registry.kind(&kind).ok_or_else(|| not_found("page"))?;
                let page = k.page.clone().ok_or_else(|| not_found("page"))?;
                Ok((p, page, json!({ "target": target })))
            }
            Target::Node { tree, key } => {
                let (p, t) = self.registry.tree(&tree).ok_or_else(|| not_found("page"))?;
                let page = t.page.clone().ok_or_else(|| not_found("page"))?;
                Ok((p, page, json!({ "target": target, "node": { "tree": tree, "key": key } })))
            }
            _ => Err(not_found("page")),
        }
    }

    /* ---------------------------------------------------------------- plugin state, settings */

    pub fn setting_value(&self, plugin: &Plugin, name: &str) -> Option<String> {
        let decl = plugin.setting(name)?;
        Some(self.plugin_param(&plugin.id, &format!("settings.{name}")).unwrap_or_else(|| decl.default.clone()))
    }

    /// Trees a plugin's state shows in: its kinds' trees, its provided trees, the plugins tree.
    fn plugin_trees(&self, p: &Plugin) -> Vec<String> {
        let mut trees: Vec<String> = p.manifest.contributes.kinds.iter().filter_map(|k| k.tree.as_deref().map(|t| p.tree_ref(t))).collect();
        trees.extend(p.manifest.contributes.trees.iter().map(|t| p.full(&t.id)));
        trees.push(store::TREE_PLUGINS.into());
        trees.sort();
        trees.dedup();
        trees
    }

    pub async fn set_enabled(&self, plugin: &str, enabled: bool) -> KResult<()> {
        let p = self.registry.plugin(plugin).ok_or_else(|| not_found("plugin"))?;
        let value = (!enabled).then(|| "false".to_string());
        self.execute(Actor::User, Command::PluginState { plugin: plugin.into(), set: vec![("enabled".into(), value)] }).await?;
        if !enabled {
            self.stop_runs_of(plugin);
            self.drop_runtime(plugin).await;
        }
        self.emit(topic::PLUGINS, None, None);
        for t in self.plugin_trees(p) {
            self.emit(format!("{}{t}", topic::TREE), None, None);
        }
        Ok(())
    }

    async fn set_setting(&self, p: PluginSetSettingParams) -> KResult<()> {
        let plugin = self.registry.plugin(&p.plugin).ok_or_else(|| not_found("plugin"))?;
        let decl = plugin.setting(&p.name).ok_or_else(|| err_p(ErrorCode::Invalid, &[("reason", "unknownSetting")]))?;
        let value = if decl.ty == SettingType::Number { p.value.trim().to_string() } else { p.value.clone() };
        if value.len() > MAX_SETTING_BYTES {
            return Err(err_p(ErrorCode::Invalid, &[("reason", "tooLarge")]));
        }
        if !decl.accepts(&value) {
            return Err(err_p(ErrorCode::Invalid, &[("reason", "badValue")]));
        }
        let set = vec![(format!("settings.{}", p.name), Some(value))];
        self.execute(Actor::User, Command::PluginState { plugin: p.plugin.clone(), set }).await?;
        self.emit(topic::PLUGINS, None, None);
        Ok(())
    }

    pub fn plugin_detail(&self, id: &str) -> KResult<Option<PluginDetail>> {
        let Some(p) = self.registry.plugin(id) else {
            // A package whose manifest was refused still has a page that says why.
            let Some(rej) = self.rejected_for(id) else { return Ok(None) };
            return Ok(Some(PluginDetail {
                id: id.into(),
                name: Label::Text(id.into()),
                icon: "puzzle".into(),
                description: Label::Text(String::new()),
                author: String::new(),
                license: String::new(),
                homepage: String::new(),
                enabled: false,
                builtin: false,
                versions: vec![],
                settings: vec![],
                permissions: vec![],
                provides: PluginProvides::default(),
                load: PluginLoad { state: PluginLoadState::Error, message: Some(rej.reason.clone()), at: None, ms: None },
                resource_count: 0,
                folders: vec![],
                last_upgrade: None,
                unconfirmed: vec![],
                switch_failure: None,
            }));
        };
        let m = &p.manifest;
        let enabled = self.plugin_enabled(id);
        let settings = m
            .contributes
            .settings
            .iter()
            .map(|s| PluginSetting {
                name: s.name.clone(),
                label: p.label(&s.label),
                kind: match s.ty {
                    SettingType::Text => FieldKind::Text,
                    SettingType::Number => FieldKind::Number,
                    SettingType::Boolean => FieldKind::Boolean,
                    SettingType::Enum => FieldKind::Enum,
                },
                value: self.setting_value(p, &s.name).unwrap_or_default(),
                options: s.options.as_ref().map(|o| o.iter().map(|x| FieldOption { value: x.value.clone(), label: p.label(&x.label) }).collect()),
                hint: s.hint.as_ref().map(|h| p.label(h)),
            })
            .collect();
        let folders = self.folder_grants(id)?;
        let confirmed = self.version_confirmed(p);
        let permissions = p.permission_list(|pid| if pid == "files" { !folders.is_empty() } else { confirmed });
        let kinds: Vec<String> = m.contributes.kinds.iter().map(|k| p.full(&k.id)).collect();
        let resource_count: u64 = self.read(|c| {
            kinds.iter().try_fold(0u64, |n, k| {
                c.query_row("SELECT count(*) FROM resources WHERE kind = ?1 AND deleted_at IS NULL", [k], |r| r.get::<_, i64>(0))
                    .map(|x| n + x as u64)
            })
        })?;
        Ok(Some(PluginDetail {
            id: id.into(),
            name: p.label(&m.name),
            icon: m.icon.clone(),
            description: m.description.as_deref().map(|d| p.label(d)).unwrap_or(Label::Text(String::new())),
            author: m.author.clone(),
            license: m.license.clone(),
            homepage: m.homepage.clone(),
            enabled,
            builtin: false,
            versions: self.version_rows(id)?,
            settings,
            permissions,
            provides: PluginProvides {
                kinds: m.contributes.kinds.iter().map(|k| p.label(&k.label)).collect(),
                actions: m.contributes.actions.iter().map(|a| p.label(&a.label)).collect(),
                trees: m.contributes.trees.iter().map(|t| p.label(&t.label)).collect(),
                result_tabs: m.contributes.pages.iter().flat_map(|pg| pg.result_tabs.iter().map(|t| p.label(&t.label))).collect(),
                other: m.contributes.commands.iter().map(|c| p.label(&c.label)).collect(),
            },
            load: PluginLoad {
                state: if enabled { PluginLoadState::Loaded } else { PluginLoadState::Disabled },
                message: None,
                at: None,
                ms: None,
            },
            resource_count,
            folders,
            last_upgrade: self.last_upgrade(id)?,
            unconfirmed: self.registry.versions(id).into_iter().filter(|v| !self.version_confirmed(v)).map(|v| v.version.clone()).collect(),
            switch_failure: self.switch_failure(id),
        }))
    }

    pub fn rejected_for(&self, id: &str) -> Option<crate::manifest::Rejection> {
        self.registry
            .rejected()
            .into_iter()
            .find(|r| r.path.parent().and_then(|p| p.file_name()).is_some_and(|n| n.to_string_lossy() == id))
    }

    /* ---------------------------------------------------------------- palette */

    pub fn palette(&self) -> Vec<PaletteCommand> {
        let core = Label::Text("core".into());
        let k = |id: &str, icon: &str| PaletteCommand {
            id: id.into(),
            label: Label::Text(id.into()),
            icon: Some(icon.into()),
            group: core.clone(),
            shortcut: None,
            keywords: None,
        };
        let mut out = vec![
            k("node.newGroup", "folder-plus"),
            k("env.newChild", "plus"),
            k("open.audit", "scroll-text"),
            k("open.deleted", "trash-2"),
        ];
        for p in self.registry.plugins().iter().filter(|p| self.plugin_enabled(&p.id)) {
            let group = p.label(&p.manifest.name);
            // D296: only commands that ask for it; node commands stay in their context menus.
            for c in p.manifest.contributes.commands.iter().filter(|c| c.palette) {
                out.push(PaletteCommand {
                    id: p.full(&c.id),
                    label: p.label(&c.label),
                    icon: c.icon.clone(),
                    group: group.clone(),
                    shortcut: None,
                    keywords: None,
                });
            }
            for n in &p.manifest.contributes.menus.new {
                if let Some(d) = p.kind(n) {
                    out.push(PaletteCommand {
                        id: format!("new:{}", p.full(n)),
                        label: p.label(&d.label),
                        icon: Some(d.icon.clone()),
                        group: group.clone(),
                        shortcut: None,
                        keywords: None,
                    });
                }
            }
        }
        out
    }

    /* ---------------------------------------------------------------- kernel trees */

    /// `plugins`: one node per package (refused ones as `broken`); `runs`: the latest 200 runs.
    pub fn plugins_tree(&self) -> KResult<Vec<TreeNode>> {
        let mut out = Vec::new();
        for p in &self.registry.plugins() {
            let enabled = self.plugin_enabled(&p.id);
            let toggle = if enabled { kernel_cmd("plugin.disable", "power-off") } else { kernel_cmd("plugin.enable", "power") };
            out.push(TreeNode {
                key: p.id.clone(),
                tree: store::TREE_PLUGINS.into(),
                parent_key: None,
                label: p.text(&p.manifest.name, None),
                icon: p.manifest.icon.clone(),
                kind: store::KIND_PLUGIN.into(),
                expandable: false,
                state: if enabled { NodeState::Ok } else { NodeState::Disabled },
                // D337: a failed automatic switch first; then a newer version waiting for the user
                // to confirm its permissions (D299).
                state_reason: if self.switch_failure(&p.id).is_some() {
                    Some(Label::Text("switchFailed".into()))
                } else {
                    self.registry.versions(&p.id).iter().any(|v| !self.version_confirmed(v)).then(|| Label::Text("unconfirmedVersion".into()))
                },
                badge: Some(p.version.clone()),
                target: Some(format!("plugin:{}", p.id)),
                menu: vec![kernel_cmd("node.open", "external-link"), toggle],
                draggable: false,
                accepts: vec![],
            });
        }
        let mut seen: Vec<String> = out.iter().map(|n| n.key.clone()).collect();
        for r in &self.registry.rejected() {
            let Some(id) = r.path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()) else { continue };
            if seen.contains(&id) {
                continue;
            }
            seen.push(id.clone());
            out.push(TreeNode {
                key: id.clone(),
                tree: store::TREE_PLUGINS.into(),
                parent_key: None,
                label: id.clone(),
                icon: "puzzle".into(),
                kind: store::KIND_PLUGIN.into(),
                expandable: false,
                state: NodeState::Broken,
                state_reason: Some(Label::Text(r.reason.clone())),
                badge: None,
                target: Some(format!("plugin:{id}")),
                menu: vec![kernel_cmd("node.open", "external-link")],
                draggable: false,
                accepts: vec![],
            });
        }
        Ok(out)
    }

    pub fn runs_tree(&self) -> KResult<Vec<TreeNode>> {
        Ok(self
            .read(|c| store::runs_where(c, "?1 = ?1", "", crate::pipeline::RUNS_KEPT))?
            .into_iter()
            .map(|r| {
                let mut menu = vec![kernel_cmd("node.open", "external-link")];
                if r.status == "running" {
                    menu.push(kernel_cmd("run.cancel", "square"));
                }
                menu.push(if r.kept { kernel_cmd("run.unkeep", "bookmark-minus") } else { kernel_cmd("run.keep", "bookmark") });
                if r.resource_id.is_some() {
                    menu.push(kernel_cmd("run.openResource", "external-link"));
                    menu.push(kernel_cmd("run.reuse", "rotate-ccw"));
                }
                TreeNode {
                    key: r.id.clone(),
                    tree: store::TREE_RUNS.into(),
                    parent_key: None,
                    label: format!("#{} {}", r.seq, r.kept_name.clone().unwrap_or(r.title.clone())),
                    icon: r.icon.clone(),
                    kind: store::KIND_RUN.into(),
                    expandable: false,
                    state: if r.status == "error" { NodeState::Broken } else { NodeState::Ok },
                    state_reason: None,
                    badge: Some(r.status.clone()),
                    target: Some(format!("run:{}", r.id)),
                    menu,
                    draggable: false,
                    accepts: vec![],
                }
            })
            .collect())
    }

    /// Commands of round 3 (`command.execute`); `None` = not one of them.
    pub async fn command3(&self, id: &str, c: &CommandContext) -> Option<KResult<Vec<CommandEffect>>> {
        let arg = |k: &str| c.args.as_ref().and_then(|a| a.get(k)).and_then(Value::as_str).map(String::from);
        let run_id = || -> KResult<String> {
            arg("run")
                .or_else(|| c.target.as_deref().and_then(|t| t.strip_prefix("run:")).map(String::from))
                .or_else(|| c.node_key.clone().filter(|_| c.tree.as_deref() == Some(store::TREE_RUNS)))
                .ok_or_else(|| invalid_params("run"))
        };
        Some(match id {
            "plugin.enable" | "plugin.disable" => {
                let plugin = arg("plugin")
                    .or_else(|| c.target.as_deref().and_then(|t| t.strip_prefix("plugin:")).map(String::from))
                    .or_else(|| c.node_key.clone().filter(|_| c.tree.as_deref() == Some(store::TREE_PLUGINS)));
                match plugin {
                    Some(p) => self.set_enabled(&p, id == "plugin.enable").await.map(|_| vec![]),
                    None => Err(invalid_params("plugin")),
                }
            }
            "run.cancel" => match run_id() {
                Ok(r) => self.run_cancel(&r).await.map(|_| vec![]),
                Err(e) => Err(e),
            },
            "run.keep" | "run.unkeep" => match run_id() {
                Ok(r) => self.run_keep(&r, id == "run.keep", arg("name")).await.map(|_| vec![]),
                Err(e) => Err(e),
            },
            "run.openResource" | "run.reuse" => {
                let r = match run_id().and_then(|r| self.read(|conn| store::run_get(conn, &r))?.ok_or_else(|| not_found("run"))) {
                    Ok(r) => r,
                    Err(e) => return Some(Err(e)),
                };
                match r.resource_id.filter(|rid| self.read(|conn| store::get(conn, rid)).ok().flatten().is_some()) {
                    None => Err(not_found("resource")),
                    Some(rid) => {
                        let reuse = id == "run.reuse";
                        let params: Option<BTreeMap<String, String>> =
                            if reuse { serde_json::from_value(r.params).ok() } else { None };
                        Ok(vec![CommandEffect::Open {
                            target: format!("resource:{rid}"),
                            params,
                            env_id: if reuse { r.env_id } else { None },
                        }])
                    }
                }
            }
            _ => return None,
        })
    }
}

fn err_p_detail(code: ErrorCode, reason: &str, detail: String) -> ProtocolError {
    ProtocolError { code, params: [("reason".to_string(), reason.to_string())].into(), detail: Some(detail) }
}
