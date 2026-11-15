//! Shared test helpers: temporary workspaces, the fixture plugins, and one client type that talks
//! to the kernel either in-process or over a Unix socket (same JSON lines both ways).
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use onedesk_kernel::transport::{serve_connection, InProc};
use onedesk_kernel::{Kernel, KernelConfig, SandboxConfig};
use onedesk_protocol::{EventMessage, ProtocolError, Request, Response, PROTOCOL_VERSION};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};

pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/plugins")
}

pub fn test_config() -> KernelConfig {
    KernelConfig {
        sandbox: SandboxConfig {
            memory_limit: 16 * 1024 * 1024,
            sync_slice: Duration::from_millis(300),
            activate_timeout: Duration::from_secs(5),
            call_timeout: Duration::from_secs(5),
            ..SandboxConfig::default()
        },
        action_timeout: Duration::from_secs(5),
    }
}

pub struct Env {
    pub tmp: tempfile::TempDir,
    pub kernel: Arc<Kernel>,
}

impl Env {
    pub fn path(&self) -> PathBuf {
        std::fs::canonicalize(self.tmp.path()).unwrap()
    }
}

/// A kernel on a fresh temporary workspace with the given plugins folder.
pub fn open(plugins: &Path) -> Env {
    open_in(tempfile::tempdir().unwrap(), plugins)
}

/// Like `open`, in a temporary folder the caller already filled (e.g. with a plugins folder).
pub fn open_in(tmp: tempfile::TempDir, plugins: &Path) -> Env {
    open_with(tmp, plugins, test_config())
}

pub fn open_with(tmp: tempfile::TempDir, plugins: &Path, cfg: KernelConfig) -> Env {
    let kernel = Arc::new(Kernel::open(&tmp.path().join("ws"), plugins, cfg).unwrap());
    Env { tmp, kernel }
}

/// Copies the fixture plugins plus extra generated packages into a temporary plugins folder.
/// `extra`: (id, manifest contributes JSON, main.js source).
pub fn plugins_with(dir: &Path, extra: &[(&str, Value, &str)]) -> PathBuf {
    let root = dir.join("plugins");
    copy_dir(&fixtures(), &root);
    for (id, contributes, main) in extra {
        let pkg = root.join(id).join("0.1.0");
        std::fs::create_dir_all(&pkg).unwrap();
        let m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box",
                        "main": "main.js", "contributes": contributes });
        std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
        std::fs::write(pkg.join("main.js"), main).unwrap();
    }
    root
}

pub fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let t = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &t);
        } else {
            std::fs::copy(e.path(), &t).unwrap();
        }
    }
}

/* ------------------------------------------------------------------ clients */

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>;

pub enum Client {
    InProc { conn: InProc, events: tokio::sync::Mutex<mpsc::UnboundedReceiver<String>> },
    Socket { write: tokio::sync::Mutex<OwnedWriteHalf>, pending: Pending, events: tokio::sync::Mutex<mpsc::UnboundedReceiver<String>> },
}

static NEXT: AtomicU64 = AtomicU64::new(1);

impl Client {
    pub fn in_proc(kernel: Arc<Kernel>) -> Client {
        let conn = InProc::new(kernel);
        let events = tokio::sync::Mutex::new(conn.events());
        Client::InProc { conn, events }
    }

    /// Serves `kernel` on a socket in a temporary folder and connects to it.
    pub async fn socket(kernel: Arc<Kernel>, dir: &Path) -> Client {
        let path = dir.join("k.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            serve_connection(kernel, s).await;
        });
        Client::connect(&path).await
    }

    pub async fn connect(path: &Path) -> Client {
        let stream = UnixStream::connect(path).await.unwrap();
        let (read, write) = stream.into_split();
        let pending: Pending = Default::default();
        let (etx, erx) = mpsc::unbounded_channel();
        let p2 = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let v: Value = serde_json::from_str(&line).unwrap();
                if v.get("id").is_some() {
                    let r: Response = serde_json::from_value(v).unwrap();
                    if let Some(tx) = p2.lock().unwrap().remove(&r.id) {
                        let _ = tx.send(r);
                    }
                } else {
                    let _ = etx.send(line);
                }
            }
            p2.lock().unwrap().clear();
        });
        Client::Socket { write: tokio::sync::Mutex::new(write), pending, events: tokio::sync::Mutex::new(erx) }
    }

    pub async fn raw(&self, line: String, id: u64) -> Response {
        match self {
            Client::InProc { conn, .. } => serde_json::from_str(&conn.line(&line).await).unwrap(),
            Client::Socket { write, pending, .. } => {
                let (tx, rx) = oneshot::channel();
                pending.lock().unwrap().insert(id, tx);
                write.lock().await.write_all(format!("{line}\n").as_bytes()).await.unwrap();
                tokio::time::timeout(Duration::from_secs(20), rx).await.expect("answer in time").expect("connection open")
            }
        }
    }

    pub async fn call_as(&self, client: Option<&str>, method: &str, params: Value) -> Result<Value, ProtocolError> {
        let id = NEXT.fetch_add(1, Ordering::SeqCst);
        let req = Request { id, method: method.into(), params, client: client.map(String::from) };
        let r = self.raw(serde_json::to_string(&req).unwrap(), id).await;
        assert_eq!(r.id, id);
        match r.error {
            Some(e) => Err(e),
            None => Ok(r.result.unwrap_or(Value::Null)),
        }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, ProtocolError> {
        self.call_as(None, method, params).await
    }

    pub async fn ok(&self, method: &str, params: Value) -> Value {
        match self.call(method, params.clone()).await {
            Ok(v) => v,
            Err(e) => panic!("{method} {params} failed: {e:?}"),
        }
    }

    pub async fn hello(&self) {
        self.ok("hello", json!({ "protocol": PROTOCOL_VERSION })).await;
    }

    /// Waits for an event whose topic satisfies `pred`, skipping others.
    pub async fn event(&self, pred: impl Fn(&EventMessage) -> bool) -> EventMessage {
        let rx = match self {
            Client::InProc { events, .. } | Client::Socket { events, .. } => events,
        };
        let mut rx = rx.lock().await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let line = tokio::time::timeout_at(deadline, rx.recv()).await.expect("event in time").expect("events open");
            let e: EventMessage = serde_json::from_str(&line).unwrap();
            if pred(&e) {
                return e;
            }
        }
    }

    /// Runs a plugin's `probe` command: `ctx.host.<method>(...args)`; returns `{ok}` or `{error}`.
    pub async fn probe(&self, plugin: &str, method: &str, args: Value) -> Value {
        let effects = self
            .ok("command.execute", json!({ "id": format!("{plugin}:probe"), "context": { "args": { "method": method, "args": args } } }))
            .await;
        serde_json::from_str(effects[0]["text"].as_str().expect("copy effect")).unwrap()
    }
}
