//! No app open: a headless `onedesk-worker` of our own — same kernel, same workspace lock. It starts with the first
//! request and goes away after `idle` without requests, so an app opened meanwhile can take the workspace.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use onedesk_host::workspaces;
use onedesk_protocol::{ErrorCode, HelloParams, ProtocolError, PROTOCOL_VERSION};
use serde_json::Value;
use tokio::net::UnixStream;

use crate::backend::BackendError;
use crate::line_conn::{protocol_error, LineConn};

pub struct HeadlessConfig {
    pub data_dir: PathBuf,
    pub workspace: Option<String>,
    pub worker_bin: PathBuf,
    pub idle: Duration,
    pub builtin_plugins: Option<PathBuf>,
    /// Passed as `--ai-client`: every request on this worker is the AI operator `ai:<name>`.
    pub client_name: String,
}

struct Running {
    child: tokio::process::Child,
    conn: Arc<LineConn>,
    socket: PathBuf,
    last_used: Instant,
    in_flight: usize,
}

pub struct Headless {
    cfg: HeadlessConfig,
    client_name: Mutex<String>,
    state: Arc<tokio::sync::Mutex<Option<Running>>>,
    /// Serialises starting.
    starting: tokio::sync::Mutex<()>,
    watcher_started: Mutex<bool>,
}

static SOCKETS: AtomicUsize = AtomicUsize::new(0);

impl Headless {
    pub fn new(cfg: HeadlessConfig) -> Self {
        Headless { client_name: Mutex::new(cfg.client_name.clone()), cfg, state: Arc::default(), starting: tokio::sync::Mutex::new(()), watcher_started: Mutex::new(false) }
    }

    pub fn set_client_name(&self, name: &str) {
        *self.client_name.lock().unwrap() = name.to_string();
    }

    /// The folder to open: the workspace asked for (id, name or folder), else the one the app would open by default.
    fn folder(&self) -> Result<String, ProtocolError> {
        let all = workspaces::scan(&self.cfg.data_dir);
        let not_found = || ProtocolError { code: ErrorCode::NotFound, params: [("what".to_string(), "workspace".to_string())].into(), detail: None };
        match self.cfg.workspace.as_deref() {
            Some(w) => all
                .iter()
                .find(|(f, i)| f == w || (!i.id.is_empty() && i.id == w))
                .or_else(|| all.iter().find(|(_, i)| i.name == w))
                .map(|(f, _)| f.clone())
                .ok_or_else(not_found),
            None => workspaces::sorted(all).into_iter().next().map(|(f, _)| f).ok_or_else(not_found),
        }
    }

    async fn start(&self) -> Result<Running, BackendError> {
        let folder = self.folder().map_err(BackendError::Protocol)?;
        let workspace = workspaces::scan(&self.cfg.data_dir).into_iter().find(|(f, _)| *f == folder).map(|_| onedesk_host::workspace_path(&self.cfg.data_dir, &folder)).ok_or_else(|| BackendError::Protocol(ProtocolError { code: ErrorCode::NotFound, params: Default::default(), detail: None }))?;
        let socket = socket_path();
        // Like the app: copy the built-in packages and tell the worker which ones are built in (D313), or their
        // permissions would be asked for and the plugins would not run for the AI client either (D450).
        let plugin_root = self.cfg.data_dir.join("plugins");
        let mut builtin = Vec::new();
        if let Some(src) = &self.cfg.builtin_plugins {
            let _ = std::fs::create_dir_all(&plugin_root);
            match onedesk_host::plugins::install_builtin(src, &plugin_root) {
                Ok(b) => {
                    builtin = b.present;
                    if let Err(e) = onedesk_host::index::refresh(&plugin_root, &builtin) {
                        eprintln!("onedesk-mcp: could not refresh plugins/.index: {e}");
                        let _ = std::fs::remove_file(plugin_root.join(onedesk_host::index::FILE_NAME));
                    }
                }
                Err(e) => eprintln!("onedesk-mcp: could not copy the built-in plugins: {e}"),
            }
        }
        let mut command = tokio::process::Command::new(&self.cfg.worker_bin);
        for b in &builtin {
            command.arg("--builtin").arg(b);
        }
        let mut child = command
            .arg("--workspace")
            .arg(&workspace)
            .arg("--plugins")
            .arg(self.cfg.data_dir.join("plugins"))
            .arg("--socket")
            .arg(&socket)
            .arg("--ai-client")
            .arg(self.client_name.lock().unwrap().as_str())
            .stdin(Stdio::null())
            // stdout belongs to the MCP client; the worker's words go to our stderr.
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| BackendError::Unavailable(format!("cannot start worker {}: {e}", self.cfg.worker_bin.display())))?;
        let deadline = Instant::now() + Duration::from_secs(20);
        let stream = loop {
            match UnixStream::connect(&socket).await {
                Ok(s) => break s,
                Err(_) => {
                    if let Ok(Some(status)) = child.try_wait() {
                        return Err(match status.code() {
                            Some(3) => BackendError::Locked,
                            _ => BackendError::Unavailable(format!("worker exited during start: {status}")),
                        });
                    }
                    if Instant::now() > deadline {
                        let _ = child.start_kill();
                        return Err(BackendError::Unavailable("worker did not listen in time".into()));
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        };
        let (read, write) = stream.into_split();
        let conn = Arc::new(LineConn::new(read, write, format!("{}headless", crate::names::CLIENT_PREFIX)));
        let hello = conn.request("hello", serde_json::to_value(HelloParams { protocol: PROTOCOL_VERSION.to_string() }).expect("hello params")).await?;
        if hello.get("protocol").and_then(Value::as_str) != Some(PROTOCOL_VERSION) {
            return Err(BackendError::Protocol(protocol_error(ErrorCode::VersionMismatch, "worker speaks another protocol version")));
        }
        Ok(Running { child, conn, socket, last_used: Instant::now(), in_flight: 0 })
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, BackendError> {
        let conn = {
            let _one = self.starting.lock().await;
            let mut st = self.state.lock().await;
            if st.as_ref().is_none_or(|r| r.conn.is_closed()) {
                *st = None;
                drop(st);
                let r = self.start().await?;
                st = self.state.lock().await;
                *st = Some(r);
            }
            let r = st.as_mut().expect("just set");
            r.in_flight += 1;
            r.last_used = Instant::now();
            r.conn.clone()
        };
        self.ensure_watcher();
        let result = conn.request(method, params).await;
        if let Some(r) = self.state.lock().await.as_mut() {
            r.in_flight = r.in_flight.saturating_sub(1);
            r.last_used = Instant::now();
        }
        result
    }

    fn ensure_watcher(&self) {
        let mut started = self.watcher_started.lock().unwrap();
        if *started {
            return;
        }
        *started = true;
        let (state, idle) = (self.state.clone(), self.cfg.idle);
        tokio::spawn(async move {
            let tick = (idle / 4).clamp(Duration::from_millis(50), Duration::from_secs(1));
            loop {
                tokio::time::sleep(tick).await;
                let due = {
                    let mut st = state.lock().await;
                    match st.as_ref() {
                        Some(r) if r.in_flight == 0 && r.last_used.elapsed() >= idle => st.take(),
                        _ => None,
                    }
                };
                if let Some(r) = due {
                    stop(r).await;
                }
            }
        });
    }

    /// Lets go of the workspace now (when idle or not, the app wants it).
    pub async fn release(&self) {
        let taken = self.state.lock().await.take();
        if let Some(r) = taken {
            stop(r).await;
        }
    }
}

async fn stop(mut r: Running) {
    r.conn.close().await;
    if tokio::time::timeout(Duration::from_secs(3), r.child.wait()).await.is_err() {
        let _ = r.child.kill().await;
    }
    let _ = std::fs::remove_file(&r.socket);
}

fn socket_path() -> PathBuf {
    let n = SOCKETS.fetch_add(1, Ordering::SeqCst);
    let name = format!("od-mcp-{}-{n}.sock", std::process::id());
    let base = std::env::temp_dir();
    let p = base.join(&name);
    if p.as_os_str().len() < 100 {
        p
    } else {
        PathBuf::from("/tmp").join(name)
    }
}
