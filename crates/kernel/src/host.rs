//! `ctx.host` for plugins (week1-protocol §7): `resources`, `files`, `ui`.
//! Every write goes through the same pipeline as the interface's, with the plugin as actor.

use std::path::PathBuf;
use std::sync::{Arc, Weak};

use onedesk_protocol::*;
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::{Plugin, Registry};
use crate::pipeline::{Changes, Command, MoveDest, NewResource};
use crate::sandbox::{CallInfo, HostApi, HostFuture};
use crate::store;
use crate::util::*;

pub const MAX_SLEEP_MS: u64 = 10_000;
pub const MAX_STORAGE_VALUE: usize = 256 * 1024;
pub const MAX_STORAGE_KEY: usize = 200;
pub const MAX_STORAGE_KEYS: usize = 1000;
pub const MAX_STORAGE_TOTAL: usize = 16 * 1024 * 1024;

/// Round 12 (D394): writes a kind's `drop` may not make (only `resources.update`, kept and
/// written together with the drop).
pub const DROP_REFUSED: &[&str] = &[
    "resources.create", "resources.upsertByKey", "resources.move", "resources.remove", "files.writeText", "storage.set",
    "storage.remove",
];

/// Round 16: limits of `resources.upsertByKey`.
pub const MAX_UPSERT: usize = 5000;
pub const MAX_EXTERNAL_KEY: usize = 1024;

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

/// Round 11 (D380): what `host.ui.openExternal` may open.
pub const EXTERNAL_SCHEMES: &[&str] = &["http", "https", "mailto"];
pub const MAX_EXTERNAL_URL: usize = 2048;
/// D386: `openExternal` calls one invocation (one run or one page event) may make.
pub const MAX_EXTERNAL_OPENS: usize = 5;

/// A checked address for `openExternal`, or `invalid/badUrl`.
pub fn external_url(raw: &str) -> KResult<String> {
    let bad = || invalid("badUrl");
    // A cheap bound before parsing; the limit itself applies to the normalized address (what
    // is sent and opened: non-ASCII is percent-encoded and gets longer).
    if raw.is_empty() || raw.len() > 4 * MAX_EXTERNAL_URL {
        return Err(bad());
    }
    let u = reqwest::Url::parse(raw).map_err(|_| bad())?;
    if u.as_str().len() > MAX_EXTERNAL_URL {
        return Err(bad());
    }
    if !EXTERNAL_SCHEMES.contains(&u.scheme()) {
        return Err(bad());
    }
    let ok = match u.scheme() {
        "mailto" => !u.path().is_empty(),
        _ => u.host_str().is_some_and(|h| !h.is_empty()),
    };
    if !ok {
        return Err(bad());
    }
    Ok(u.to_string())
}

/// The audit object of an external address: the host name (for `mailto:` the mail domain), never
/// the path, query or the part before `@`.
pub fn external_object(raw: &str) -> Option<String> {
    let u = reqwest::Url::parse(raw.trim()).ok()?;
    if u.scheme() == "mailto" {
        let first = u.path().split(',').next().unwrap_or_default();
        let domain = first.rsplit_once('@').map(|(_, d)| d).unwrap_or_default();
        let domain = domain.split(['?', '#']).next().unwrap_or_default().to_ascii_lowercase();
        return Some(domain);
    }
    u.host_str().map(|h| h.trim_matches(['[', ']']).to_ascii_lowercase())
}

/// Round 17 (X18): the `files.*` operations added this round (`host_files17`).
const ROUND17_FILES: &[&str] =
    &["mkdir", "copy", "move", "trash", "remove", "open", "reveal", "find", "addRoot", "replaceRoot", "removeRoot"];

/// Round 19 (D450): what a host call may do inside an AI client's run: reads, the plugin's own
/// storage and programs, GET requests, calls into other plugins (which are limited the same way).
/// Resource writes, file writes, settings writes, `plugins.*`, `ui.*`, secrets in plain text,
/// transfers and artifacts are refused.
fn ai_allows(method: &str, args: &Value) -> bool {
    match method {
        "resources.get" | "resources.list" | "resources.search" | "resources.kinds" => true,
        "files.roots" | "files.list" | "files.stat" | "files.readText" | "files.find" => true,
        "settings.get" | "runs.partial" | "runs.progress" => true,
        "network.output" | "network.stop" => true,
        // D451: capturing the output of a program the plugin may run (what its `process.run` wrapper
        // does for a query) into a file of its own data folder: a relative path, never a granted
        // folder or an address. Everything else of `transfer.*` writes somewhere or sends something.
        "transfer.progress" | "transfer.stop" => true,
        "transfer.capture" => args.get(0).is_some_and(|o| {
            o.get("to").and_then(Value::as_str).is_some_and(|t| !t.is_empty() && !t.starts_with('/') && !t.starts_with('~') && !t.split('/').any(|c| c == ".."))
                && o.get("url").is_none()
        }),
        "network.request" => {
            let o = args.get(0);
            let method = o.and_then(|o| o.get("method")).and_then(Value::as_str).unwrap_or("GET");
            method.eq_ignore_ascii_case("GET") && o.is_none_or(|o| o.get("body").is_none_or(Value::is_null) && o.get("file").is_none_or(Value::is_null))
        }
        m => ["storage.", "process.", "interfaces.", "actions.", "params.", "util."].iter().any(|p| m.starts_with(p)),
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
            "params.get", "params.config", "storage.get", "storage.keys", "storage.readFrom", "settings.get", "process.ready",
        ];
        // Review #7: `process.*` answers `notInRun` itself (and audits `run`), in `migrate` too;
        // so does `transfer.*` (round 8).
        let res = if info.ai && !ai_allows(method, &args) {
            // Round 19 (D450): an AI's run reads; nothing else, whatever the plugin declared.
            Err(err_p(ErrorCode::Denied, &[("reason", "aiRun"), ("method", method)]))
        } else if info.pure && !PURE_OK.contains(&method) && !method.starts_with("process.") && !method.starts_with("transfer.") {
            Err(denied("pureCall"))
        } else if !info.pure && method == "storage.readFrom" {
            Err(denied("notInMigrate"))
        } else if info.drop_writes.is_some() && DROP_REFUSED.contains(&method) {
            // D394: a drop writes nothing but updates of its resources, all kept until it answers.
            Err(denied("inDrop"))
        } else {
            self.host_dispatch(plugin, info, cap, op, method, &args).await
        };
        self.audit_refusal(plugin, method, &args, &res).await;
        res
    }

    async fn host_dispatch(&self, plugin: &'static Plugin, info: &CallInfo, cap: &str, op: &str, method: &str, args: &Value) -> KResult<Value> {
        let args = args.clone();
        match cap {
            "resources" if info.ai => {
                // Round 19 (D450): an AI's run sees the resources made visible to AI, no more.
                let v = self.host_resources(plugin, info, op, &args).await?;
                let visible = |v: &Value| v.get("id").and_then(Value::as_str).is_none_or(|id| self.read(|c| store::is_ai_visible(c, id)).unwrap_or(false));
                Ok(match (op, v) {
                    ("get", v) if !visible(&v) => Value::Null,
                    ("list", Value::Array(a)) => Value::Array(a.into_iter().filter(|x| visible(x)).collect()),
                    (_, v) => v,
                })
            }
            "resources" => self.host_resources(plugin, info, op, &args).await,
            "files" if ROUND17_FILES.contains(&op) => self.host_files17(plugin, info, op, &args).await,
            "files" => self.host_files(plugin, op, &args).await,
            "ui" if op == "openExternal" => self.host_open_external(plugin, info, &args).await,
            "ui" => self.host_ui(info, op, &args),
            // D336: an event handler does what a page handler does, but no network and no programs.
            "network" if op == "request" && info.event => Err(denied("notInRun")),
            "network" if op == "request" => self.host_network(plugin, info, &args).await,
            // Round 18 (X16): the pump of `onChunk` (a run only; an event handler has no run).
            "network" if op == "output" => self.stream_poll(plugin, info, &args).await,
            "network" if op == "stop" => self.stream_stop(plugin, info, &args),
            "interfaces" => self.host_interfaces(plugin, info, op, &args).await,
            "process" => self.host_process(plugin, info, op, &args).await,
            "transfer" => self.host_transfer(plugin, info, op, &args).await,
            "secrets" if op == "get" => self.host_secret_get(plugin, info, &args).await,
            "params" => self.host_params(info, op, &args),
            "actions" => self.host_actions(plugin, info, op, &args).await,
            "storage" => self.host_storage(plugin, op, &args).await,
            "settings" => self.host_settings(plugin, op, &args),
            "plugins" => self.host_plugins(plugin, info, op, &args).await,
            "util" if op == "sleep" => {
                // D287: the engine has no timers. Cancellation ends the wait (host_call_inner).
                let ms = args.get(0).and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, MAX_SLEEP_MS as f64) as u64;
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                Ok(Value::Null)
            }
            "runs" if op == "partial" => {
                let run = info.run_id.as_deref().ok_or_else(|| denied("notInRun"))?;
                self.run_partial(run, arg(&args, 0))?;
                Ok(Value::Null)
            }
            "runs" if matches!(op, "saveArtifact" | "listArtifacts" | "getArtifact" | "deleteArtifact") => self.host_artifacts(plugin, info, op, &args).await,
            "runs" if op == "read" => self.host_runs_read(plugin, info, &args).await,
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
            // `process.run` and `transfer.*` audit their own refusals and failures.
            if e.code == ErrorCode::Denied && !method.starts_with("process.") && !method.starts_with("transfer.") {
                // Network calls are audited by host (never by URL, which may carry content).
                let object = if method == "ui.openExternal" {
                    // Never the path or query of the address (D380).
                    args.get(0).and_then(Value::as_str).and_then(external_object).unwrap_or_default()
                } else if method == "network.request" {
                    args.get(0).and_then(|o| o.get("url")).and_then(Value::as_str).and_then(crate::network::host_of).unwrap_or_default()
                } else {
                    args.get(0)
                        .and_then(|a| {
                            a.as_str()
                                .map(String::from)
                                .or_else(|| a.get("kind").or_else(|| a.get("folder")).and_then(Value::as_str).map(String::from))
                        })
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
                match self.read(|c| store::get(c, &id))? {
                    Some(r) if self.own_kind(plugin, &r.kind).is_ok() => self.plugin_resource(&r),
                    // Round 7 (§7.3): another plugin's kind it depends on and that is exported for reading.
                    Some(r) if self.export_allows(plugin, &r.kind, true) => self.foreign_resource(&r),
                    // Round 8 (D357): the resource its page is drawing or handling an event for,
                    // when that resource's kind borrows its page.
                    Some(r) if info.resource_id.as_deref() == Some(id.as_str()) && self.draws_page_of(plugin, &r) => self.foreign_resource(&r),
                    Some(_) => Err(denied("foreignKind")),
                    None => Ok(Value::Null),
                }
            }
            "list" => {
                let opts = arg(args, 0);
                let mut foreign = false;
                let kinds: Vec<String> = match opts.get("kind").and_then(Value::as_str) {
                    Some(k) => match self.own_kind(plugin, k) {
                        Ok(full) => vec![full],
                        Err(_) if self.export_allows(plugin, k, true) => {
                            foreign = true;
                            vec![k.to_string()]
                        }
                        Err(e) => return Err(e),
                    },
                    None => plugin.manifest.contributes.kinds.iter().map(|k| plugin.full(&k.id)).collect(),
                };
                let parent = opts.get("parent").map(|v| v.as_str().map(String::from));
                let rows = self.read(|c| store::list(c, &kinds, parent.as_ref().map(|p| p.as_deref())))?;
                let list = if foreign {
                    rows.iter().map(|r| self.foreign_resource(r)).collect::<KResult<Vec<_>>>()?
                } else {
                    self.plugin_resources(&rows)?
                };
                Ok(Value::Array(list))
            }
            "create" => {
                let spec = arg(args, 0);
                let kind = spec.get("kind").and_then(Value::as_str).ok_or_else(|| invalid_params("kind"))?;
                let kind = self.own_kind(plugin, kind)?;
                // D356: not while a tree or page the kind borrows is not exported.
                self.kind_usable(&kind)?;
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
                self.plugin_resource(&row)
            }
            "upsertByKey" => self.resources_upsert(plugin, args, quiet).await,
            "update" => {
                let id = arg_str(args, 0, "id")?;
                self.own_row(plugin, &id)?.ok_or_else(|| not_found("resource"))?;
                let changes: JsonMap =
                    serde_json::from_value(arg(args, 1)).map_err(|_| invalid_params("changes must be an object"))?;
                let changes = Changes::from_bind_map(&changes)?;
                let basis = args.get(2).and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
                if let Some(buf) = &info.drop_writes {
                    // D394: written with the drop, or not at all; the new rev is not known yet.
                    buf.lock().unwrap().push(Command::Update { id, changes, basis, overwrite: vec![] });
                    return Ok(json!({ "rev": null }));
                }
                self.execute_quiet(actor, Command::Update { id: id.clone(), changes, basis, overwrite: vec![] }, quiet).await?;
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
            // Round 12 (D389): basic information of every resource, with `requires.resources`.
            "search" => self.resources_search(plugin, arg(args, 0), info.ai),
            // D477: the kinds the user can make in a resource tree, with their names and icons.
            "kinds" => self.resources_kinds(plugin),
            "remove" => {
                let id = arg_str(args, 0, "id")?;
                self.own_row(plugin, &id)?.ok_or_else(|| not_found("resource"))?;
                self.execute_quiet(actor, Command::Delete { id }, quiet).await?;
                Ok(Value::Null)
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("resources.{op}"))])),
        }
    }

    /// Whether `plugin`'s page draws resources like `r` (another plugin's kind borrowing it, D357).
    fn draws_page_of(&self, plugin: &Plugin, r: &store::Row) -> bool {
        self.registry
            .kind_at(&r.kind, r.plugin_version.as_deref())
            .and_then(|(p, k)| Some(p.page_ref(k.page.as_deref()?)))
            .is_some_and(|(owner, _)| owner == plugin.id && Registry::split(&r.kind).is_some_and(|(kp, _)| kp != plugin.id))
    }

    /// A resource as a plugin gets it: the protocol's `Resource` plus (round 16) `externalKey`
    /// and `missing` (its source is gone).
    fn plugin_resource(&self, r: &store::Row) -> KResult<Value> {
        Ok(self.plugin_resources(std::slice::from_ref(r))?.pop().unwrap_or(Value::Null))
    }

    /// `plugin_resource` for many rows: their external keys in one query (review #15).
    fn plugin_resources(&self, rows: &[store::Row]) -> KResult<Vec<Value>> {
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        let ids = serde_json::to_string(&ids).map_err(internal)?;
        let keys: std::collections::HashMap<String, Option<String>> = self.read(|c| {
            let mut st = c.prepare("SELECT id, external_key FROM resources WHERE id IN (SELECT value FROM json_each(?1))")?;
            let v = st.query_map([ids], |x| Ok((x.get(0)?, x.get(1)?)))?;
            v.collect()
        })?;
        rows.iter()
            .map(|r| {
                let mut v = serde_json::to_value(self.resource(r)?).map_err(internal)?;
                v["externalKey"] = json!(keys.get(&r.id).cloned().flatten());
                v["missing"] = json!(r.state == store::STATE_MISSING);
                Ok(v)
            })
            .collect()
    }

    /// Round 16 (parity A1, A3, A4): `resources.upsertByKey(kind, items, { othersMissing })`.
    async fn resources_upsert(&self, plugin: &Plugin, args: &Value, quiet: Option<&str>) -> KResult<Value> {
        let kind = self.own_kind(plugin, &arg_str(args, 0, "kind")?)?;
        self.kind_usable(&kind)?;
        let decl = self.registry.kind(&kind).map(|(_, d)| d.clone()).ok_or_else(|| not_found("kind"))?;
        let list = args.get(1).and_then(Value::as_array).ok_or_else(|| invalid_params("items must be an array"))?;
        if list.len() > MAX_UPSERT {
            return Err(invalid("tooMany"));
        }
        let opts = arg(args, 2);
        let others_missing = match opts.get("othersMissing") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(invalid_params("othersMissing must be a boolean")),
        };
        let mut keys = std::collections::HashSet::new();
        let mut items = Vec::with_capacity(list.len());
        for it in list {
            let o = it.as_object().ok_or_else(|| invalid_params("item must be an object"))?;
            if let Some(k) = o.keys().find(|k| !["key", "name", "description", "body", "parent"].contains(&k.as_str())) {
                return Err(invalid_params(format!("unknown item field {k}")));
            }
            let key = o.get("key").and_then(Value::as_str).ok_or_else(|| invalid("badKey"))?.to_string();
            if key.is_empty() || key.chars().count() > MAX_EXTERNAL_KEY {
                return Err(invalid("badKey"));
            }
            if !keys.insert(key.clone()) {
                return Err(invalid("duplicateKey"));
            }
            let text = |f: &str| -> KResult<Option<String>> {
                match o.get(f) {
                    None | Some(Value::Null) => Ok(None),
                    Some(Value::String(s)) => Ok(Some(s.clone())),
                    Some(_) => Err(invalid_params(format!("{f} must be a string"))),
                }
            };
            let (name, description, parent) = (text("name")?, text("description")?, text("parent")?);
            let body: JsonMap = match o.get("body") {
                None | Some(Value::Null) => JsonMap::new(),
                Some(b) => serde_json::from_value(b.clone()).map_err(|_| invalid_params("body must be an object"))?,
            };
            let mut changes = Changes { name: name.clone(), description: description.clone(), ..Default::default() };
            for (k, v) in &body {
                changes.body.insert(k.clone(), v.clone());
            }
            let mut create_body = decl.defaults.clone();
            for (k, v) in body {
                create_body.insert(k, v);
            }
            let fallback = key.rsplit('/').find(|s| !s.is_empty()).unwrap_or(&key).to_string();
            items.push(crate::pipeline::UpsertItem {
                key,
                changes,
                create: NewResource {
                    kind: kind.clone(),
                    tree: None,
                    parent,
                    name: name.filter(|n| !n.trim().is_empty()).unwrap_or(fallback),
                    description: description.unwrap_or_default(),
                    tags: vec![],
                    body: create_body,
                    plugin_version: Some(plugin.version.clone()),
                },
            });
        }
        let out = self.execute_quiet(plugin.actor(), Command::Upsert { kind, items, others_missing }, quiet).await?;
        Ok(out.report)
    }

    /// Another plugin's resource as a dependent reads it: without the kind's secret fields.
    fn foreign_resource(&self, r: &store::Row) -> KResult<Value> {
        let v = serde_json::to_value(self.resource(r)?).map_err(internal)?;
        Ok(crate::deps::without_secrets(v, &self.secret_fields(&r.kind, r.plugin_version.as_deref())))
    }

    /* ---------------------------------------------------------------- files */

    pub fn folder_grants(&self, plugin: &str) -> KResult<Vec<String>> {
        let row = self.read(|c| store::plugin_state(c, plugin))?;
        Ok(row
            .and_then(|r| r.body.get(crate::kernel::GRANTS_KEY).cloned())
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default())
    }

    /// Round 16: a relative path — or an absolute one inside it — is the plugin's own folder
    /// `plugin-data/<id>/` (no `files` grant needed, as for `transfer`); never its `bin/`.
    /// `None`: an absolute path outside it (the granted folders decide).
    fn own_files(&self, plugin: &Plugin, raw: &str) -> KResult<Option<(Vec<PathBuf>, String)>> {
        let own = self.plugin_data_dir(&plugin.id)?.canonicalize().map_err(internal)?;
        let relative = !std::path::Path::new(raw).is_absolute();
        let abs = if relative { own.join(raw).display().to_string() } else { raw.to_string() };
        match crate::files::resolve(std::slice::from_ref(&own), &abs) {
            Ok(real) if crate::carry::in_own_bin(&own, &real) => Err(denied("ownPrograms")),
            Ok(_) => Ok(Some((vec![own], abs))),
            Err(e) if relative => Err(e),
            Err(_) => Ok(None),
        }
    }

    async fn host_files(&self, plugin: &Plugin, op: &str, args: &Value) -> KResult<Value> {
        let raw0 = args.get(0).and_then(Value::as_str).filter(|_| op != "roots");
        let own = match raw0 {
            Some(raw) => self.own_files(plugin, raw)?,
            None => None,
        };
        let (grants, args) = match own {
            Some((mine, abs)) => {
                let mut a = args.clone();
                a[0] = Value::String(abs);
                (mine, a)
            }
            None => {
                if !plugin.manifest.requires.files {
                    return Err(denied("notRequested"));
                }
                let grants: Vec<PathBuf> = self.folder_grants(&plugin.id)?.into_iter().map(PathBuf::from).collect();
                // Review #5: a folder granted earlier may contain the data folder; nothing in it is reachable.
                if let Some(raw) = raw0 {
                    if let Ok(real) = crate::files::resolve(&grants, raw) {
                        if self.data_roots().iter().any(|d| real.starts_with(d)) {
                            return Err(denied("insideDataDir"));
                        }
                    }
                }
                (grants, args.clone())
            }
        };
        let args = &args;
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
                let o = arg(args, 2);
                let basis = o.get("basis").and_then(Value::as_str).map(String::from);
                // Round 17: `executable`, `conflict` (absent: replace, as before).
                let wo = crate::files::WriteOpts {
                    executable: o.get("executable").and_then(Value::as_bool).unwrap_or(false),
                    conflict: if o.get("conflict").is_some_and(|v| !v.is_null()) {
                        Some(crate::files::Conflict::parse(&o)?)
                    } else {
                        None
                    },
                };
                let len = text.len();
                let me = self.me.upgrade().ok_or_else(|| internal("kernel stopped"))?;
                let actor = plugin.actor();
                // Writing and auditing run in their own task: if the plugin call times out or is
                // cancelled meanwhile, a file that was written is still audited (review #2).
                let task = tokio::spawn(async move {
                    let (path, basis) = tokio::task::spawn_blocking(move || {
                        crate::files::write_text_opts(&grants, &p, &text, basis.as_deref(), wo)
                    })
                    .await
                    .map_err(internal)??;
                    let Some(path) = path else { return Ok::<_, ProtocolError>(None) };
                    let path = path.display().to_string();
                    me.execute(
                        actor,
                        Command::Audit { op: "files.write".into(), object: path.clone(), summary: json!({ "bytes": len }) },
                    )
                    .await?;
                    Ok::<_, ProtocolError>(Some((path, basis)))
                });
                let Some((path, basis)) = task.await.map_err(internal)?? else {
                    return Ok(json!({ "skipped": true }));
                };
                for t in plugin.manifest.contributes.trees.iter().filter(|t| t.source == TreeSource::Provided) {
                    self.emit(format!("{}{}", topic::TREE, plugin.full(&t.id)), None, None);
                }
                Ok(json!({ "basis": basis, "path": path, "skipped": false }))
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("files.{op}"))])),
        }
    }

    /// The folders one path of a `files.*` call may be in: the plugin's own folder (relative path,
    /// or absolute inside it) or the granted folders (never anything inside the data folder).
    /// Returns them and the path made absolute.
    fn files_scope(&self, plugin: &Plugin, raw: &str) -> KResult<(Vec<PathBuf>, String)> {
        if let Some(own) = self.own_files(plugin, raw)? {
            return Ok(own);
        }
        if !plugin.manifest.requires.files {
            return Err(denied("notRequested"));
        }
        let grants: Vec<PathBuf> = self.folder_grants(&plugin.id)?.into_iter().map(PathBuf::from).collect();
        // Review #5: nothing inside the data folder, though a granted folder may contain it.
        let inside = |p: &std::path::Path| self.data_roots().iter().any(|d| p.starts_with(d));
        if let Ok(real) = crate::files::resolve(&grants, raw) {
            if inside(&real) {
                return Err(denied("insideDataDir"));
            }
        }
        if let Ok((real, _)) = crate::files::resolve_entry(&grants, raw) {
            if inside(&real) {
                return Err(denied("insideDataDir"));
            }
        }
        Ok((grants, raw.to_string()))
    }

    /// Round 17 (X18): `files.mkdir/copy/move/trash/remove/open/reveal/find` and the granted
    /// folder list (`addRoot/replaceRoot/removeRoot`).
    async fn host_files17(&self, plugin: &Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        // D336: an event handler reads, it does not change files or open anything.
        if info.event && op != "find" {
            return Err(denied("notInRun"));
        }
        let blocking = |f: Box<dyn FnOnce() -> KResult<Value> + Send>| async move {
            tokio::task::spawn_blocking(f).await.map_err(internal)?
        };
        let actor = plugin.actor();
        match op {
            "addRoot" | "replaceRoot" => {
                if !plugin.manifest.requires.files {
                    return Err(denied("notRequested"));
                }
                let replace = if op == "replaceRoot" {
                    let path = arg_str(args, 0, "path")?;
                    if !self.folder_grants(&plugin.id)?.contains(&path) {
                        return Err(not_found("grant"));
                    }
                    Some(path)
                } else {
                    None
                };
                let effect = CommandEffect::PickFolder { plugin: plugin.id.clone(), replace };
                self.emit(topic::UI, Some(serde_json::to_value(effect).map_err(internal)?), info.client.clone());
                // The user answers in the shell's dialog later; the grant arrives as a `plugins`
                // event and a refresh of the plugin's provided trees.
                return Ok(Value::Null);
            }
            "removeRoot" => {
                if !plugin.manifest.requires.files {
                    return Err(denied("notRequested"));
                }
                let path = arg_str(args, 0, "path")?;
                if !self.folder_grants(&plugin.id)?.contains(&path) {
                    return Err(not_found("grant"));
                }
                let g = self.revoke_folder(PluginFolderParams { plugin: plugin.id.clone(), path }).await?;
                return Ok(json!({ "folders": g.folders }));
            }
            _ => {}
        }
        let raw = arg_str(args, 0, "path")?;
        // D432 (review #1): open and reveal only in granted folders, never in the plugin's own.
        if matches!(op, "open" | "reveal") && self.own_files(plugin, &raw)?.is_some() {
            return Err(outside_grant(&raw));
        }
        let (mut grants, raw) = self.files_scope(plugin, &raw)?;
        let changed = match op {
            "find" => {
                let q = arg_str(args, 1, "query")?;
                let o = arg(args, 2);
                return blocking(Box::new(move || crate::files::find(&grants, &raw, &q, &o))).await;
            }
            "open" | "reveal" => {
                let reveal = op == "reveal";
                let p = blocking(Box::new(move || {
                    if reveal { crate::files::existing(&grants, &raw) } else { crate::files::openable(&grants, &raw) }.map(|p| json!(p.display().to_string()))
                }))
                .await?;
                let path = PathBuf::from(p.as_str().unwrap_or_default());
                (self.cfg.opener.0)(&path, op == "reveal").map_err(internal)?;
                return Ok(Value::Null);
            }
            "mkdir" => {
                let recursive = arg(args, 1).get("recursive").and_then(Value::as_bool).unwrap_or(false);
                let e = blocking(Box::new(move || crate::files::mkdir(&grants, &raw, recursive).map(|e| json!(e)))).await?;
                let path = e["path"].as_str().unwrap_or_default().to_string();
                (e, "files.mkdir", path, json!({}))
            }
            "copy" | "move" => {
                let to = arg_str(args, 1, "to")?;
                let (more, to) = self.files_scope(plugin, &to)?;
                grants.extend(more);
                let conflict = crate::files::Conflict::parse(&arg(args, 2))?;
                let is_move = op == "move";
                let (src, put, asked) = tokio::task::spawn_blocking(move || {
                    if is_move {
                        crate::files::move_to(&grants, &raw, &to, conflict)
                    } else {
                        crate::files::copy(&grants, &raw, &to, conflict)
                    }
                })
                .await
                .map_err(internal)??;
                let res = crate::files::placed(put.clone(), &asked);
                let Some(put) = put else { return Ok(res) };
                let summary = json!({ "from": src.display().to_string(), "conflict": conflict.as_str() });
                (res, if is_move { "files.move" } else { "files.copy" }, put.display().to_string(), summary)
            }
            "trash" => {
                let trash = self.cfg.trash_dir.clone();
                let (src, dst) = tokio::task::spawn_blocking(move || crate::files::trash(&grants, &raw, trash.as_deref())).await.map_err(internal)??;
                (json!({ "path": dst.display().to_string() }), "files.trash", src.display().to_string(), json!({}))
            }
            "remove" => {
                let p = tokio::task::spawn_blocking(move || crate::files::remove(&grants, &raw)).await.map_err(internal)??;
                (Value::Null, "files.remove", p.display().to_string(), json!({}))
            }
            _ => return Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("files.{op}"))])),
        };
        let (res, audit_op, object, summary) = changed;
        // Done on disk: audited even if the call is given up meanwhile (as `writeText`).
        let me = self.me.upgrade().ok_or_else(|| internal("kernel stopped"))?;
        let cmd = Command::Audit { op: audit_op.into(), object, summary };
        tokio::spawn(async move { me.execute(actor, cmd).await }).await.map_err(internal)??;
        for t in plugin.manifest.contributes.trees.iter().filter(|t| t.source == TreeSource::Provided) {
            self.emit(format!("{}{}", topic::TREE, plugin.full(&t.id)), None, None);
        }
        Ok(res)
    }

    /* ---------------------------------------------------------------- params, storage, settings (D286) */

    fn host_params(&self, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        if op == "config" {
            // Round 15 (X4, parity F5): a workspace configuration value by name (§6.2: the
            // deepest node defining it); a secret parameter gives only its name.
            let name = arg_str(args, 0, "name")?;
            return Ok(match self.config_param(&name)? {
                Some((node, v)) => json!({ "found": true, "value": v, "sourceName": node }),
                None => json!({ "found": false, "value": "", "sourceName": "" }),
            });
        }
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

    /// Round 11 (D380): only where the user just acted — a run or a page event (like
    /// `plugins.requestInstall`); render, event handlers, `migrate`, tree handlers and commands
    /// are `denied/notInteractive`. The kernel only publishes the effect.
    async fn host_open_external(&self, plugin: &'static Plugin, info: &CallInfo, args: &Value) -> KResult<Value> {
        if info.pure || info.event || !(info.page_event || info.run_id.is_some()) {
            return Err(denied("notInteractive"));
        }
        let raw = arg_str(args, 0, "url")?;
        let url = external_url(&raw)?;
        // D386: only valid addresses count; the sixth and later are refused.
        if info.external_opens.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= MAX_EXTERNAL_OPENS {
            return Err(denied("tooMany"));
        }
        let object = external_object(&url).unwrap_or_default();
        let scheme = url.split(':').next().unwrap_or_default().to_string();
        self.execute(plugin.actor(), Command::Audit { op: "ui.openExternal".into(), object, summary: json!({ "scheme": scheme }) })
            .await?;
        let effect = CommandEffect::OpenExternal { url };
        self.emit(topic::UI, Some(serde_json::to_value(effect).map_err(internal)?), info.client.clone());
        Ok(Value::Null)
    }

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
            // "openExternal" is `host_open_external`.
            _ => return Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("ui.{op}"))])),
        };
        self.emit(topic::UI, Some(serde_json::to_value(effect).map_err(internal)?), info.client.clone());
        Ok(Value::Null)
    }
}
