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

pub struct PluginHost {
    pub kernel: Weak<Inner>,
    pub plugin: String,
}

impl HostApi for PluginHost {
    fn call(&self, info: Arc<CallInfo>, method: String, args: Value) -> HostFuture {
        let kernel = self.kernel.clone();
        let plugin = self.plugin.clone();
        Box::pin(async move {
            let k = kernel.upgrade().ok_or_else(|| internal("kernel stopped"))?;
            k.host_call(&plugin, &info, &method, args).await
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
    pub async fn host_call(&self, plugin_id: &str, info: &CallInfo, method: &str, args: Value) -> KResult<Value> {
        let plugin = self.registry.plugin(plugin_id).ok_or_else(|| internal("plugin gone"))?;
        let (cap, op) = method.split_once('.').ok_or_else(|| err_p(ErrorCode::UnknownMethod, &[("method", method)]))?;
        match cap {
            "resources" => self.host_resources(plugin, op, &args).await,
            "files" => self.host_files(plugin, op, &args).await,
            "ui" => self.host_ui(info, op, &args),
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", method)])),
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

    async fn host_resources(&self, plugin: &Plugin, op: &str, args: &Value) -> KResult<Value> {
        let actor = plugin.actor();
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
                    .execute(
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
                self.execute(actor, Command::Update { id: id.clone(), changes, basis }).await?;
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
                self.execute(actor, Command::Move { id, dest }).await?;
                Ok(Value::Null)
            }
            "remove" => {
                let id = arg_str(args, 0, "id")?;
                self.own_row(plugin, &id)?.ok_or_else(|| not_found("resource"))?;
                self.execute(actor, Command::Delete { id }).await?;
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
                let res = blocking(Box::new(move || {
                    let (path, basis) = crate::files::write_text(&grants, &p, &text, basis.as_deref())?;
                    Ok(json!({ "path": path.display().to_string(), "basis": basis }))
                }))
                .await?;
                let path = res["path"].as_str().unwrap_or_default().to_string();
                self.execute(
                    plugin.actor(),
                    Command::Audit { op: "files.write".into(), object: path, summary: json!({ "bytes": len }) },
                )
                .await?;
                for t in plugin.manifest.contributes.trees.iter().filter(|t| t.source == TreeSource::Provided) {
                    self.emit(format!("{}{}", topic::TREE, plugin.full(&t.id)), None, None);
                }
                Ok(json!({ "basis": res["basis"] }))
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("files.{op}"))])),
        }
    }

    /* ---------------------------------------------------------------- ui */

    fn host_ui(&self, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        let effect = match op {
            "open" => {
                let target = arg_str(args, 0, "target")?;
                if !crate::pages::is_target(&target) {
                    return Err(invalid("badTarget"));
                }
                CommandEffect::Open { target }
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
