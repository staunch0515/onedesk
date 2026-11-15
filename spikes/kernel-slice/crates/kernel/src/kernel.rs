//! The kernel for one workspace. Knows resources, manifests and sandboxes; it
//! contains no plugin id, kind or logic. Its only entry point is a protocol
//! message (`handle` / `handle_line`), so it behaves the same in-process and
//! behind a socket.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ks_protocol::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::sandbox::{CancelToken, HostApi, HostFuture, Sandbox, SandboxConfig, SandboxError};

#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    id: String,
    #[serde(default)]
    kinds: HashMap<String, KindDecl>,
    #[serde(skip)]
    dir: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
struct KindDecl {
    page: String,
}

struct KernelHost {
    db: Arc<Mutex<Connection>>,
}

impl HostApi for KernelHost {
    fn call(&self, plugin: &str, method: &str, args: Value) -> HostFuture {
        let res: Result<Value, String> = match method {
            "storage.get" => (|| {
                let db = self.db.lock().unwrap();
                let v: Option<String> = db
                    .query_row(
                        "SELECT value FROM plugin_storage WHERE plugin = ?1 AND key = ?2",
                        params![plugin, args["key"].as_str().unwrap_or("")],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                Ok(v.map(|s| serde_json::from_str(&s).unwrap_or(Value::Null)).unwrap_or(Value::Null))
            })(),
            "storage.set" => self
                .db
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO plugin_storage(plugin, key, value) VALUES (?1, ?2, ?3)
                     ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value",
                    params![plugin, args["key"].as_str().unwrap_or(""), args["value"].to_string()],
                )
                .map(|_| Value::Null)
                .map_err(|e| e.to_string()),
            "test.sleep" => {
                let ms = args["ms"].as_u64().unwrap_or(0);
                return Box::pin(async move {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    Ok(Value::Null)
                });
            }
            "test.echo" => Ok(args),
            other => Err(format!("host method not allowed: {other}")),
        };
        Box::pin(async move { res })
    }
}

pub struct Kernel {
    db: Arc<Mutex<Connection>>,
    manifests: Vec<Manifest>,
    sandboxes: tokio::sync::Mutex<HashMap<String, Arc<Sandbox>>>,
    events: broadcast::Sender<Event>,
    inflight: Mutex<HashMap<u64, CancelToken>>,
    host: Arc<KernelHost>,
    cfg: SandboxConfig,
    open_ms: f64,
    boot: Mutex<Value>,
}

fn err(code: ErrorCode, message: impl Into<String>) -> RpcError {
    RpcError { code, message: message.into() }
}

fn parse<T: DeserializeOwned>(v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(|e| err(ErrorCode::BadParams, e.to_string()))
}

fn internal(e: impl std::fmt::Display) -> RpcError {
    err(ErrorCode::Internal, e.to_string())
}

fn plugin_err(e: SandboxError) -> RpcError {
    let code = match e {
        SandboxError::Timeout => ErrorCode::PluginTimeout,
        SandboxError::OutOfMemory => ErrorCode::PluginOutOfMemory,
        SandboxError::Cancelled => ErrorCode::Cancelled,
        _ => ErrorCode::PluginError,
    };
    err(code, e.to_string())
}

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS resources(
  id INTEGER PRIMARY KEY, parent_id INTEGER, kind TEXT NOT NULL, name TEXT NOT NULL,
  sort INTEGER NOT NULL, body TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS resources_parent ON resources(parent_id, sort);
CREATE TABLE IF NOT EXISTS plugin_storage(
  plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(plugin, key));
";

/// Creates `<dir>/workspace.db` with `rows` resources: 250 root folders, the
/// rest spread under them. Leaves alternate between kind `sql` and `note`
/// (a kind no plugin handles).
pub fn seed(dir: &Path, rows: usize) -> rusqlite::Result<()> {
    let mut db = Connection::open(dir.join("workspace.db"))?;
    db.pragma_update(None, "journal_mode", "WAL")?;
    db.execute_batch(SCHEMA)?;
    let tx = db.transaction()?;
    {
        let mut ins = tx.prepare("INSERT INTO resources(id, parent_id, kind, name, sort, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
        let folders = 250.min(rows);
        for i in 0..rows {
            let id = i as i64 + 1;
            if i < folders {
                ins.execute(params![id, Option::<i64>::None, "folder", format!("Folder {id:03}"), i as i64, "{}"])?;
            } else {
                let parent = (i % folders) as i64 + 1;
                let (kind, body) = if (i / folders) % 2 == 1 {
                    ("sql", json!({ "sql": "SELECT * FROM orders WHERE id = :id AND day >= :from_day AND note <> ':x' -- :y\n  AND amount::int > :min_amount" }).to_string())
                } else {
                    ("note", "{}".to_string())
                };
                ins.execute(params![id, parent, kind, format!("Item {id:05}"), i as i64, body])?;
            }
        }
    }
    tx.commit()
}

impl Kernel {
    /// Opens the workspace database and reads plugin manifests. Runs no JS.
    pub fn open(workspace: &Path, plugins_dir: &Path, cfg: SandboxConfig) -> Result<Arc<Self>, String> {
        let t = Instant::now();
        let db = Connection::open(workspace.join("workspace.db")).map_err(|e| e.to_string())?;
        db.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
        db.pragma_update(None, "synchronous", "NORMAL").map_err(|e| e.to_string())?;
        db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        let mut manifests = Vec::new();
        if let Ok(rd) = std::fs::read_dir(plugins_dir) {
            for entry in rd.flatten() {
                let path = entry.path().join("manifest.json");
                if let Ok(text) = std::fs::read_to_string(&path) {
                    let mut m: Manifest = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
                    m.dir = entry.path();
                    manifests.push(m);
                }
            }
        }
        let db = Arc::new(Mutex::new(db));
        let (events, _) = broadcast::channel(256);
        Ok(Arc::new(Kernel {
            host: Arc::new(KernelHost { db: db.clone() }),
            db,
            manifests,
            sandboxes: Default::default(),
            events,
            inflight: Default::default(),
            cfg,
            open_ms: t.elapsed().as_secs_f64() * 1000.0,
            boot: Mutex::new(Value::Null),
        }))
    }

    pub fn set_boot_info(&self, v: Value) {
        *self.boot.lock().unwrap() = v;
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Same entry point for both transports: one JSON line in, one out.
    pub async fn handle_line(&self, line: &str) -> String {
        let resp = match serde_json::from_str::<Request>(line) {
            Ok(req) => self.handle(req).await,
            Err(e) => Response { id: 0, result: None, error: Some(err(ErrorCode::BadParams, e.to_string())) },
        };
        serde_json::to_string(&resp).expect("response serializes")
    }

    pub async fn handle(&self, req: Request) -> Response {
        let id = req.id;
        let token = CancelToken::new();
        self.inflight.lock().unwrap().insert(id, token.clone());
        let res = self.dispatch(&req.method, req.params, token).await;
        self.inflight.lock().unwrap().remove(&id);
        match res {
            Ok(v) => Response { id, result: Some(v), error: None },
            Err(e) => Response { id, result: None, error: Some(e) },
        }
    }

    async fn dispatch(&self, method: &str, params: Value, token: CancelToken) -> Result<Value, RpcError> {
        match method {
            "hello" => {
                let p: HelloParams = parse(params)?;
                if p.protocol_version != PROTOCOL_VERSION {
                    return Err(err(ErrorCode::VersionMismatch, format!("kernel speaks {PROTOCOL_VERSION}, client {}", p.protocol_version)));
                }
                Ok(json!({ "protocolVersion": PROTOCOL_VERSION }))
            }
            "workspace.info" => {
                let count = self.db.lock().unwrap().query_row("SELECT count(*) FROM resources", [], |r| r.get::<_, i64>(0)).map_err(internal)? as u64;
                let mut activated: Vec<String> = self.sandboxes.lock().await.keys().cloned().collect();
                activated.sort();
                out(&WorkspaceInfo {
                    protocol_version: PROTOCOL_VERSION,
                    pid: std::process::id(),
                    resource_count: count,
                    activated_plugins: activated,
                    open_ms: self.open_ms,
                    boot: self.boot.lock().unwrap().clone(),
                })
            }
            "tree.page" => out(&self.tree_page(parse(params)?)?),
            "page.open" => {
                let p: PageOpenParams = parse(params)?;
                let (name, kind, body) = self.resource(p.resource_id)?;
                let (plugin, page) = self.page_for(&kind)?;
                let sb = self.sandbox(&plugin).await?;
                let ctx = format!(
                    r#"[{{"id":{},"name":{},"body":{},"env":"dev","lang":"zh-CN"}}]"#,
                    p.resource_id,
                    serde_json::to_string(&name).map_err(internal)?,
                    body
                );
                let json = sb.call("pages", &page, "render", ctx, Some(token)).await.map_err(plugin_err)?;
                let view: ViewNode = serde_json::from_str(&json).map_err(|e| err(ErrorCode::InvalidView, e.to_string()))?;
                let node_count = view.validate().map_err(|e| err(ErrorCode::InvalidView, e))?;
                out(&PageOpenResult { view, node_count })
            }
            "page.recompute" => {
                let p: RecomputeParams = parse(params)?;
                let (_, kind, _) = self.resource(p.resource_id)?;
                let (plugin, _) = self.page_for(&kind)?;
                let sb = self.sandbox(&plugin).await?;
                let sql = p.unsaved.get("body.sql").cloned().unwrap_or_default();
                let args = json!([{ "id": p.resource_id }, { "sql": sql }]).to_string();
                let json = sb.call("kinds", &kind, "parameters", args, Some(token)).await.map_err(plugin_err)?;
                let params: Vec<ParamDef> = serde_json::from_str(&json).map_err(|e| err(ErrorCode::InvalidView, e.to_string()))?;
                out(&RecomputeResult { params })
            }
            "page.event" => {
                let p: PageEventParams = parse(params)?;
                let (_, kind, _) = self.resource(p.resource_id)?;
                let (plugin, page) = self.page_for(&kind)?;
                let sb = self.sandbox(&plugin).await?;
                let args = json!([{ "id": p.resource_id }, { "event": p.event, "payload": p.payload }]).to_string();
                let json = sb.call("pages", &page, "onEvent", args, Some(token)).await.map_err(plugin_err)?;
                serde_json::from_str(&json).map_err(internal)
            }
            "request.cancel" => {
                let p: CancelParams = parse(params)?;
                let found = self.inflight.lock().unwrap().get(&p.request_id).cloned();
                if let Some(t) = &found {
                    t.cancel();
                }
                Ok(json!({ "cancelled": found.is_some() }))
            }
            "resource.rename" => {
                let p: RenameParams = parse(params)?;
                let n = self.db.lock().unwrap().execute("UPDATE resources SET name = ?2 WHERE id = ?1", params![p.resource_id, p.name]).map_err(internal)?;
                if n == 0 {
                    return Err(err(ErrorCode::NotFound, "resource not found"));
                }
                let _ = self.events.send(Event { event: "resource.changed".into(), payload: json!({ "id": p.resource_id, "name": p.name }) });
                Ok(Value::Null)
            }
            // Test hook: die the way a real crash would (no unwinding, no cleanup).
            "debug.crash" => std::process::abort(),
            _ => Err(err(ErrorCode::UnknownMethod, format!("unknown method: {method}"))),
        }
    }

    fn tree_page(&self, p: TreePageParams) -> Result<TreePage, RpcError> {
        let db = self.db.lock().unwrap();
        let mut stmt = db
            .prepare_cached(
                "SELECT r.id, r.kind, r.name, EXISTS(SELECT 1 FROM resources c WHERE c.parent_id = r.id)
                 FROM resources r WHERE r.parent_id IS ?1 ORDER BY r.sort LIMIT ?2 OFFSET ?3",
            )
            .map_err(internal)?;
        let nodes = stmt
            .query_map(params![p.parent, p.limit, p.offset], |r| {
                Ok(TreeNode { id: r.get(0)?, kind: r.get(1)?, name: r.get(2)?, has_children: r.get(3)? })
            })
            .map_err(internal)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal)?;
        let total = db
            .query_row("SELECT count(*) FROM resources WHERE parent_id IS ?1", params![p.parent], |r| r.get::<_, i64>(0))
            .map_err(internal)? as u64;
        Ok(TreePage { nodes, total })
    }

    fn resource(&self, id: i64) -> Result<(String, String, String), RpcError> {
        self.db
            .lock()
            .unwrap()
            .query_row("SELECT name, kind, body FROM resources WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .map_err(internal)?
            .ok_or_else(|| err(ErrorCode::NotFound, "resource not found"))
    }

    fn page_for(&self, kind: &str) -> Result<(String, String), RpcError> {
        self.manifests
            .iter()
            .find_map(|m| m.kinds.get(kind).map(|k| (m.id.clone(), k.page.clone())))
            .ok_or_else(|| err(ErrorCode::NotFound, format!("no plugin provides a page for kind `{kind}`")))
    }

    /// Lazy activation: the first use of a plugin's code creates its runtime.
    async fn sandbox(&self, plugin: &str) -> Result<Arc<Sandbox>, RpcError> {
        let mut map = self.sandboxes.lock().await;
        if let Some(sb) = map.get(plugin) {
            return Ok(sb.clone());
        }
        let m = self.manifests.iter().find(|m| m.id == plugin).ok_or_else(|| err(ErrorCode::NotFound, "plugin not installed"))?;
        let mut files = HashMap::new();
        for entry in std::fs::read_dir(&m.dir).map_err(internal)?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".js") {
                files.insert(name, std::fs::read_to_string(entry.path()).map_err(internal)?);
            }
        }
        let sb = Arc::new(Sandbox::activate(plugin, files, self.host.clone(), self.cfg.clone()).await.map_err(plugin_err)?);
        map.insert(plugin.to_string(), sb.clone());
        Ok(sb)
    }
}

fn out<T: serde::Serialize>(v: &T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(internal)
}
