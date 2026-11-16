//! `ctx.host` for plugins (week1-protocol §7): `resources`, `files`, `ui`.
//! Every write goes through the same pipeline as the interface's, with the plugin as actor.

use std::path::PathBuf;
use std::sync::{Arc, Weak};

use onedesk_protocol::*;
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::Plugin;
use crate::pipeline::{Changes, Command, MoveDest, NewResource};
use crate::sandbox::{CallInfo, HostApi, HostFuture};
use crate::store;
use crate::util::*;

pub const MAX_SLEEP_MS: u64 = 10_000;
pub const MAX_STORAGE_VALUE: usize = 256 * 1024;
pub const MAX_STORAGE_KEY: usize = 200;
pub const MAX_STORAGE_KEYS: usize = 1000;
pub const MAX_STORAGE_TOTAL: usize = 16 * 1024 * 1024;

pub struct PluginHost {
    pub kernel: Weak<Inner>,
    /// The version this runtime runs: host calls act as `plugin:<id>@<version>`.
    pub plugin: &'static Plugin,
}

impl HostApi for PluginHost {
    fn call(&self, info: Arc<CallInfo>, method: String, args: Value) -> HostFuture {
        let kernel = self.kernel.clone();
        let plugin = self.plugin;
        Box::pin(async move {
            let k = kernel.upgrade().ok_or_else(|| internal("kernel stopped"))?;
            k.host_call(plugin, &info, &method, args).await
        })
    }
}

fn arg(args: &Value, i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Null)
}

fn arg_str(args: &Value, i: usize, what: &str) -> KResult<String> {
    args.get(i).and_then(Value::as_str).map(String::from).ok_or_else(|| invalid_params(format!("{what} must be a string")))
}

impl Inner {
    pub async fn host_call(&self, plugin: &'static Plugin, info: &CallInfo, method: &str, args: Value) -> KResult<Value> {
        let (cap, op) = method.split_once('.').ok_or_else(|| err_p(ErrorCode::UnknownMethod, &[("method", method)]))?;
        // D301: `migrate` is pure computation — only reads; `storage.readFrom` only there.
        const PURE_OK: &[&str] = &[
            "resources.get", "resources.list", "files.roots", "files.list", "files.stat", "files.readText",
            "params.get", "storage.get", "storage.keys", "storage.readFrom", "settings.get", "process.ready",
        ];
        // Review #7: `process.*` answers `notInRun` itself (and audits `run`), in `migrate` too.
        let res = if info.pure && !PURE_OK.contains(&method) && !method.starts_with("process.") {
            Err(denied("pureCall"))
        } else if !info.pure && method == "storage.readFrom" {
            Err(denied("notInMigrate"))
        } else {
            self.host_dispatch(plugin, info, cap, op, method, &args).await
        };
        self.audit_refusal(plugin, method, &args, &res).await;
        res
    }

    async fn host_dispatch(&self, plugin: &'static Plugin, info: &CallInfo, cap: &str, op: &str, method: &str, args: &Value) -> KResult<Value> {
        let args = args.clone();
        match cap {
            "resources" => self.host_resources(plugin, info, op, &args).await,
            "files" => self.host_files(plugin, op, &args).await,
            "ui" => self.host_ui(info, op, &args),
            // D336: an event handler does what a page handler does, but no network and no programs.
            "network" if op == "request" && info.event => Err(denied("notInRun")),
            "network" if op == "request" => self.host_network(plugin, info, &args).await,
            "process" => self.host_process(plugin, info, op, &args).await,
            "secrets" if op == "get" => self.host_secret_get(plugin, info, &args).await,
            "params" => self.host_params(info, op, &args),
            "storage" => self.host_storage(plugin, op, &args).await,
            "settings" => self.host_settings(plugin, op, &args),
            "util" if op == "sleep" => {
                // D287: the engine has no timers. Cancellation ends the wait (host_call_inner).
                let ms = args.get(0).and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, MAX_SLEEP_MS as f64) as u64;
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                Ok(Value::Null)
            }
            "runs" if op == "progress" => {
                if let Some(run) = &info.run_id {
                    self.run_progress(run, args.get(0).and_then(Value::as_f64), args.get(1).and_then(Value::as_str).map(String::from)).await;
                }
                Ok(Value::Null)
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", method)])),
        }
    }

    /// A refused call is audited on its own (§4.3). Refusals inside the pipeline never happen
    /// for plugin calls (the checks come first), so nothing is recorded twice.
    async fn audit_refusal(&self, plugin: &Plugin, method: &str, args: &Value, res: &KResult<Value>) {
        if let Err(e) = res {
            // `process.run` audits its own refusals and failures.
            if e.code == ErrorCode::Denied && !method.starts_with("process.") {
                // Network calls are audited by host (never by URL, which may carry content).
                let object = if method == "network.request" {
                    args.get(0).and_then(|o| o.get("url")).and_then(Value::as_str).and_then(crate::network::host_of).unwrap_or_default()
                } else {
                    args.get(0)
                        .and_then(|a| a.as_str().map(String::from).or_else(|| a.get("kind").and_then(Value::as_str).map(String::from)))
                        .unwrap_or_default()
                };
                let _ = self
                    .pipeline
                    .execute(plugin.actor(), Command::Refused { op: method.into(), object, error: e.clone() })
                    .await;
            }
        }
    }

    /* ---------------------------------------------------------------- resources */

    fn own_kind(&self, plugin: &Plugin, kind: &str) -> KResult<String> {
        let full = plugin.kind_ref(kind);
        if full.strip_prefix(plugin.id.as_str()).is_some_and(|r| r.starts_with(':')) && self.registry.kind(&full).is_some() {
            Ok(full)
        } else {
            Err(denied("foreignKind"))
        }
    }

    fn own_row(&self, plugin: &Plugin, id: &str) -> KResult<Option<store::Row>> {
        match self.read(|c| store::get(c, id))? {
            Some(r) if self.own_kind(plugin, &r.kind).is_ok() => Ok(Some(r)),
            Some(_) => Err(denied("foreignKind")),
            None => Ok(None),
        }
    }

    async fn host_resources(&self, plugin: &Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        let actor = plugin.actor();
        // D336: what an event handler writes raises no event for the same plugin.
        let quiet = info.event.then_some(plugin.id.as_str());
        match op {
            "get" => {
                let id = arg_str(args, 0, "id")?;
                match self.own_row(plugin, &id)? {
                    Some(r) => serde_json::to_value(self.resource(&r)?).map_err(internal),
                    None => Ok(Value::Null),
                }
            }
            "list" => {
                let opts = arg(args, 0);
                let kinds: Vec<String> = match opts.get("kind").and_then(Value::as_str) {
                    Some(k) => vec![self.own_kind(plugin, k)?],
                    None => plugin.manifest.contributes.kinds.iter().map(|k| plugin.full(&k.id)).collect(),
                };
                let parent = opts.get("parent").map(|v| v.as_str().map(String::from));
                let rows = self.read(|c| store::list(c, &kinds, parent.as_ref().map(|p| p.as_deref())))?;
                let list = rows.iter().map(|r| self.resource(r)).collect::<KResult<Vec<_>>>()?;
                serde_json::to_value(list).map_err(internal)
            }
            "create" => {
                let spec = arg(args, 0);
                let kind = spec.get("kind").and_then(Value::as_str).ok_or_else(|| invalid_params("kind"))?;
                let kind = self.own_kind(plugin, kind)?;
                let decl = self.registry.kind(&kind).map(|(_, d)| d.clone()).ok_or_else(|| not_found("kind"))?;
                let name = spec
                    .get("name")
                    .and_then(Value::as_str)
                    .map(String::from)
                    .or_else(|| decl.new_name.as_deref().map(|k| plugin.text(k, None)))
                    .unwrap_or_default();
                let body: JsonMap = match spec.get("body") {
                    Some(b) => serde_json::from_value(b.clone()).map_err(|_| invalid_params("body must be an object"))?,
                    None => decl.defaults.clone(),
                };
                let tags: Vec<String> = match spec.get("tags") {
                    Some(t) => serde_json::from_value(t.clone()).map_err(|_| invalid_params("tags"))?,
                    None => vec![],
                };
                let out = self
                    .execute_quiet(
                        actor,
                        Command::Create(NewResource {
                            kind,
                            tree: None,
                            parent: spec.get("parent").and_then(Value::as_str).map(String::from),
                            name,
                            description: spec.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
                            tags,
                            body,
                            plugin_version: Some(plugin.version.clone()),
                        }),
                        quiet,
                    )
                    .await?;
                let row = self.live_row(&out.id.unwrap_or_default())?;
                serde_json::to_value(self.resource(&row)?).map_err(internal)
            }
            "update" => {
                let id = arg_str(args, 0, "id")?;
                self.own_row(plugin, &id)?.ok_or_else(|| not_found("resource"))?;
                let changes: JsonMap =
                    serde_json::from_value(arg(args, 1)).map_err(|_| invalid_params("changes must be an object"))?;
                let changes = Changes::from_bind_map(&changes)?;
                let basis = args.get(2).and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
                self.execute_quiet(actor, Command::Update { id: id.clone(), changes, basis }, quiet).await?;
                Ok(json!({ "rev": self.live_row(&id)?.rev }))
            }
            "move" => {
                let id = arg_str(args, 0, "id")?;
                self.own_row(plugin, &id)?.ok_or_else(|| not_found("resource"))?;
                let to = arg(args, 1);
                let dest = match to.get("before").and_then(Value::as_str) {
                    Some(b) => MoveDest::Before(b.to_string()),
                    None => MoveDest::Inside(to.get("parent").and_then(Value::as_str).map(String::from)),
                };
                self.execute_quiet(actor, Command::Move { id, dest }, quiet).await?;
                Ok(Value::Null)
            }
            "remove" => {
                let id = arg_str(args, 0, "id")?;
                self.own_row(plugin, &id)?.ok_or_else(|| not_found("resource"))?;
                self.execute_quiet(actor, Command::Delete { id }, quiet).await?;
                Ok(Value::Null)
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("resources.{op}"))])),
        }
    }

    /* ---------------------------------------------------------------- files */

    pub fn folder_grants(&self, plugin: &str) -> KResult<Vec<String>> {
        let row = self.read(|c| store::plugin_state(c, plugin))?;
        Ok(row
            .and_then(|r| r.body.get(crate::kernel::GRANTS_KEY).cloned())
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default())
    }

    async fn host_files(&self, plugin: &Plugin, op: &str, args: &Value) -> KResult<Value> {
        if !plugin.manifest.requires.files {
            return Err(denied("notRequested"));
        }
        let grants: Vec<PathBuf> = self.folder_grants(&plugin.id)?.into_iter().map(PathBuf::from).collect();
        // Review #5: a folder granted earlier may contain the data folder; nothing in it is reachable.
        if let Some(raw) = args.get(0).and_then(Value::as_str).filter(|_| op != "roots") {
            if let Ok(real) = crate::files::resolve(&grants, raw) {
                if self.data_roots().iter().any(|d| real.starts_with(d)) {
                    return Err(denied("insideDataDir"));
                }
            }
        }
        // Disk access runs off the async workers.
        let blocking = |f: Box<dyn FnOnce() -> KResult<Value> + Send>| async move {
            tokio::task::spawn_blocking(f).await.map_err(internal)?
        };
        match op {
            "roots" => Ok(crate::files::roots(&grants)),
            "list" => {
                let (p, o) = (arg_str(args, 0, "path")?, arg(args, 1));
                blocking(Box::new(move || crate::files::list(&grants, &p, &o))).await
            }
            "stat" => {
                let p = arg_str(args, 0, "path")?;
                blocking(Box::new(move || crate::files::stat(&grants, &p))).await
            }
            "readText" => {
                let p = arg_str(args, 0, "path")?;
                blocking(Box::new(move || crate::files::read_text(&grants, &p))).await
            }
            "writeText" => {
                let p = arg_str(args, 0, "path")?;
                let text = arg_str(args, 1, "text")?;
                let basis = arg(args, 2).get("basis").and_then(Value::as_str).map(String::from);
                let len = text.len();
                let me = self.me.upgrade().ok_or_else(|| internal("kernel stopped"))?;
                let actor = plugin.actor();
                // Writing and auditing run in their own task: if the plugin call times out or is
                // cancelled meanwhile, a file that was written is still audited (review #2).
                let task = tokio::spawn(async move {
                    let (path, basis) = tokio::task::spawn_blocking(move || {
                        crate::files::write_text(&grants, &p, &text, basis.as_deref())
                    })
                    .await
                    .map_err(internal)??;
                    let path = path.display().to_string();
                    me.execute(
                        actor,
                        Command::Audit { op: "files.write".into(), object: path.clone(), summary: json!({ "bytes": len }) },
                    )
                    .await?;
                    Ok::<_, ProtocolError>(basis)
                });
                let basis = task.await.map_err(internal)??;
                for t in plugin.manifest.contributes.trees.iter().filter(|t| t.source == TreeSource::Provided) {
                    self.emit(format!("{}{}", topic::TREE, plugin.full(&t.id)), None, None);
                }
                Ok(json!({ "basis": basis }))
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("files.{op}"))])),
        }
    }

    /* ---------------------------------------------------------------- params, storage, settings (D286) */

    fn host_params(&self, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        if op != "get" {
            return Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("params.{op}"))]));
        }
        let name = arg_str(args, 0, "name")?;
        let r = self.resolve_param(ParamsResolveParams { env_id: info.env_id.clone(), name })?;
        Ok(json!({ "found": r.found, "value": r.value, "sourceName": r.source_name }))
    }

    async fn host_storage(&self, plugin: &Plugin, op: &str, args: &Value) -> KResult<Value> {
        let (id, ver) = (plugin.id.as_str(), plugin.version.as_str());
        let key = || -> KResult<String> {
            let k = arg_str(args, 0, "key")?;
            if k.is_empty() || k.chars().count() > MAX_STORAGE_KEY {
                return Err(invalid("badKey"));
            }
            Ok(k)
        };
        match op {
            "get" => {
                let k = key()?;
                let v = self.read(|c| store::storage_get(c, id, ver, &k))?;
                Ok(v.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
            }
            "set" => {
                let k = key()?;
                let v = arg(args, 1);
                let text = v.to_string();
                if text.len() > MAX_STORAGE_VALUE {
                    return Err(invalid("tooLarge"));
                }
                // D295: per plugin version at most 1000 keys and 16 MB in all.
                if !v.is_null() {
                    let (keys, total): (i64, i64) = self.read(|c| {
                        c.query_row(
                            "SELECT count(*), COALESCE(SUM(length(value)), 0) FROM plugin_storage
                             WHERE plugin = ?1 AND version = ?2 AND key <> ?3",
                            rusqlite::params![id, ver, k],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                    })?;
                    if keys as usize >= MAX_STORAGE_KEYS {
                        return Err(invalid("tooManyKeys"));
                    }
                    if total as usize + text.len() > MAX_STORAGE_TOTAL {
                        return Err(invalid("tooLarge"));
                    }
                }
                let value = if v.is_null() { None } else { Some(text) };
                self.pipeline
                    .execute(plugin.actor(), Command::Storage { plugin: id.into(), version: ver.into(), key: k, value })
                    .await?;
                Ok(Value::Null)
            }
            "remove" => {
                let k = key()?;
                self.pipeline
                    .execute(plugin.actor(), Command::Storage { plugin: id.into(), version: ver.into(), key: k, value: None })
                    .await?;
                Ok(Value::Null)
            }
            "keys" => Ok(json!(self.read(|c| store::storage_keys(c, id, ver))?)),
            // D302: in `migrate`, the new version reads what an older version stored.
            "readFrom" => {
                let from = arg_str(args, 0, "version")?;
                let k = arg_str(args, 1, "key")?;
                let v = self.read(|c| store::storage_get(c, id, &from, &k))?;
                Ok(v.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("storage.{op}"))])),
        }
    }

    fn host_settings(&self, plugin: &Plugin, op: &str, args: &Value) -> KResult<Value> {
        if op != "get" {
            return Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("settings.{op}"))]));
        }
        let name = arg_str(args, 0, "name")?;
        // Only what its own manifest declares.
        if plugin.setting(&name).is_none() {
            return Err(denied("undeclaredSetting"));
        }
        Ok(json!(self.setting_value(plugin, &name)))
    }

    /* ---------------------------------------------------------------- ui */

    fn host_ui(&self, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        let effect = match op {
            "open" => {
                let target = arg_str(args, 0, "target")?;
                if !crate::pages::is_target(&target) {
                    return Err(invalid("badTarget"));
                }
                CommandEffect::Open { target, params: None, env_id: None }
            }
            "notify" => {
                let message: Label = serde_json::from_value(arg(args, 0)).map_err(|_| invalid_params("message"))?;
                let tone: Option<ToastTone> = match args.get(1) {
                    None | Some(Value::Null) => None,
                    Some(t) => Some(serde_json::from_value(t.clone()).map_err(|_| invalid_params("tone"))?),
                };
                CommandEffect::Toast { message, tone }
            }
            "copy" => CommandEffect::Copy { text: arg_str(args, 0, "text")? },
            _ => return Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("ui.{op}"))])),
        };
        self.emit(topic::UI, Some(serde_json::to_value(effect).map_err(internal)?), info.client.clone());
        Ok(Value::Null)
    }
}
