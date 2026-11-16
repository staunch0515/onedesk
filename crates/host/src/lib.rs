//! `onedesk-host`: main-process logic (week1-protocol §2). No Tauri, no plugin names.
//!
//! It starts one worker process for the workspace, forwards requests to it (filling `client`),
//! broadcasts its events, restarts it when it dies and tells the interface with `connection`
//! events. The interface reaches it through the Tauri window shell or `onedesk-devhost`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use onedesk_protocol::{
    ConnectionState, ErrorCode, EventMessage, HelloParams, HelloResult, AppInstallParams, PluginFolderRef, PluginVersionParams, ProtocolError, Request, Response,
    PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, oneshot, watch};

pub mod data_dir;
pub mod index;
pub mod install;
pub mod plugins;
pub mod process_groups;
pub mod ws;

pub use data_dir::{default_data_dir, resolve_worker_bin, workspace_dir};

/// How long a request waits for a restarting worker before it gives up with `workerGone`.
const WAIT_FOR_WORKER: Duration = Duration::from_secs(20);
/// How long the worker gets to finish after the connection is closed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
const START_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct HostConfig {
    /// Holds `workspaces/default/` and `plugins/`.
    pub data_dir: PathBuf,
    /// The `onedesk-worker` executable.
    pub worker_bin: PathBuf,
    /// Folder with one sub-folder per built-in plugin package; copied into the data dir.
    pub builtin_plugins: Option<PathBuf>,
}

#[derive(Debug)]
pub struct HostError(pub String);

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for HostError {}

/// `invalid` with a `reason` the shell words.
fn invalid(reason: &str) -> ProtocolError {
    ProtocolError { code: ErrorCode::Invalid, params: [("reason".to_string(), reason.to_string())].into(), detail: None }
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, ProtocolError> {
    serde_json::from_value(params).map_err(|e| err(ErrorCode::InvalidParams, e.to_string()))
}

fn err(code: ErrorCode, detail: impl Into<String>) -> ProtocolError {
    ProtocolError { code, params: Default::default(), detail: Some(detail.into()) }
}

/* ---------------------------------------------------------------- connection to the worker */

type Pending = Mutex<HashMap<u64, oneshot::Sender<Response>>>;

struct Conn {
    write: tokio::sync::Mutex<OwnedWriteHalf>,
    pending: Pending,
    closed: AtomicBool,
}

enum SendError {
    /// Nothing was written; the caller may try the next worker.
    NotSent,
    /// The request was (maybe) sent and the worker went away before answering.
    Gone,
}

impl Conn {
    fn new(write: OwnedWriteHalf) -> Arc<Self> {
        Arc::new(Conn { write: tokio::sync::Mutex::new(write), pending: Mutex::new(HashMap::new()), closed: AtomicBool::new(false) })
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    async fn send(&self, id: u64, method: &str, params: Value, client: Option<String>) -> Result<Response, SendError> {
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if self.is_closed() {
                return Err(SendError::NotSent);
            }
            pending.insert(id, tx);
        }
        let mut line = serde_json::to_string(&Request { id, method: method.to_string(), params, client }).expect("request serializes");
        line.push('\n');
        if self.write.lock().await.write_all(line.as_bytes()).await.is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(SendError::NotSent);
        }
        rx.await.map_err(|_| SendError::Gone)
    }

    async fn close_write(&self) {
        let _ = self.write.lock().await.shutdown().await;
    }
}

async fn read_loop(read: tokio::net::unix::OwnedReadHalf, conn: Arc<Conn>, events: broadcast::Sender<EventMessage>) {
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        if value.get("id").is_some() {
            if let Ok(resp) = serde_json::from_value::<Response>(value) {
                if let Some(tx) = conn.pending.lock().unwrap().remove(&resp.id) {
                    let _ = tx.send(resp);
                }
            }
        } else if let Ok(ev) = serde_json::from_value::<EventMessage>(value) {
            let _ = events.send(ev);
        }
    }
    // Worker gone: every request still waiting gets `workerGone` (their senders are dropped).
    let mut pending = conn.pending.lock().unwrap();
    conn.closed.store(true, Ordering::SeqCst);
    pending.clear();
}

fn socket_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = format!("od-{}-{}.sock", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst));
    // macOS limits Unix socket paths to 103 bytes.
    let base = std::env::temp_dir();
    let path = base.join(&name);
    if path.as_os_str().len() < 100 {
        path
    } else {
        PathBuf::from("/tmp").join(name)
    }
}

struct Started {
    child: tokio::process::Child,
    conn: Arc<Conn>,
    hello: Value,
    socket: PathBuf,
}

async fn spawn_worker(cfg: &HostConfig, shared: &Shared) -> Result<Started, HostError> {
    let workspace = workspace_dir(&cfg.data_dir);
    let plugins = cfg.data_dir.join("plugins");
    let socket = socket_path();
    let mut command = tokio::process::Command::new(&cfg.worker_bin);
    command
        .arg("--workspace")
        .arg(&workspace)
        .arg("--plugins")
        .arg(&plugins)
        .arg("--socket")
        .arg(&socket);
    for b in shared.builtin.lock().unwrap().iter() {
        command.arg("--builtin").arg(b);
    }
    let mut child = command
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| HostError(format!("cannot start worker {}: {e}", cfg.worker_bin.display())))?;
    let deadline = Instant::now() + START_TIMEOUT;
    let stream = loop {
        match UnixStream::connect(&socket).await {
            Ok(s) => break s,
            Err(_) => {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(HostError(match status.code() {
                        Some(3) => "workspace is locked by another worker (exit 3)".to_string(),
                        _ => format!("worker exited during start: {status}"),
                    }));
                }
                if Instant::now() > deadline {
                    let _ = child.start_kill();
                    return Err(HostError("worker did not listen in time".into()));
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    };
    let (read, write) = stream.into_split();
    let conn = Conn::new(write);
    tokio::spawn(read_loop(read, conn.clone(), shared.events.clone()));
    let params = serde_json::to_value(HelloParams { protocol: PROTOCOL_VERSION.to_string() }).expect("hello params");
    let resp = match conn.send(shared.next_id(), "hello", params, None).await {
        Ok(r) => r,
        Err(_) => return Err(HostError("worker closed the connection during hello".into())),
    };
    if let Some(e) = resp.error {
        return Err(HostError(format!("worker refused hello: {:?} {}", e.code, e.detail.unwrap_or_default())));
    }
    let hello = resp.result.unwrap_or(Value::Null);
    match serde_json::from_value::<HelloResult>(hello.clone()) {
        Ok(h) if h.protocol == PROTOCOL_VERSION => {}
        _ => return Err(HostError("worker speaks another protocol version".into())),
    }
    Ok(Started { child, conn, hello, socket })
}

/* ---------------------------------------------------------------- host */

struct Shared {
    next_id: AtomicU64,
    events: broadcast::Sender<EventMessage>,
    hello: Mutex<Value>,
    /// `<id>@<version>` of the built-in plugins this process copied (D313); the worker may auto-confirm only these.
    builtin: Mutex<Vec<String>>,
    current: watch::Sender<Option<Arc<Conn>>>,
    shutdown: watch::Sender<bool>,
}

impl Shared {
    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    fn connection_event(&self, state: ConnectionState) {
        let payload = serde_json::to_value(state).expect("state serializes");
        let _ = self.events.send(EventMessage { topic: onedesk_protocol::topic::CONNECTION.into(), payload: Some(payload), client: None });
    }
}

/// Brings `plugins/.index` up to date (D364). A failure only costs the cache: the kernel scans directly without it.
fn refresh_index(plugin_root: &Path, builtin: &[String]) {
    if let Err(e) = index::refresh(plugin_root, builtin) {
        eprintln!("onedesk-host: could not refresh plugins/.index: {e}");
        // A stale index would hide changes from the kernel; without one it scans the folders itself.
        let _ = std::fs::remove_file(plugin_root.join(index::FILE_NAME));
    }
}

pub struct Host {
    data_dir: PathBuf,
    install_lock: tokio::sync::Mutex<()>,
    shared: Arc<Shared>,
    monitor: Mutex<Option<tokio::task::JoinHandle<()>>>,
    restarts: Arc<std::sync::atomic::AtomicU32>,
}

impl Host {
    /// Prepares the data directory, copies built-in plugins, starts the worker and says hello.
    pub async fn start(cfg: HostConfig) -> Result<Arc<Host>, HostError> {
        std::fs::create_dir_all(workspace_dir(&cfg.data_dir)).map_err(|e| HostError(format!("data dir: {e}")))?;
        let plugin_root = cfg.data_dir.join("plugins");
        std::fs::create_dir_all(&plugin_root).map_err(|e| HostError(format!("plugins dir: {e}")))?;
        let mut builtin = Vec::new();
        if let Some(src) = &cfg.builtin_plugins {
            builtin = plugins::install_builtin(src, &plugin_root).map_err(|e| HostError(format!("copy built-in plugins: {e}")))?.present;
        }
        refresh_index(&plugin_root, &builtin);
        let (events, _) = broadcast::channel(1024);
        let (current, _) = watch::channel(None);
        let (shutdown, _) = watch::channel(false);
        let shared = Arc::new(Shared { next_id: AtomicU64::new(1), events, hello: Mutex::new(Value::Null), builtin: Mutex::new(builtin), current, shutdown });
        let first = spawn_worker(&cfg, &shared).await?;
        *shared.hello.lock().unwrap() = first.hello.clone();
        shared.current.send_replace(Some(first.conn.clone()));
        let restarts = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let data_dir = cfg.data_dir.clone();
        let monitor = tokio::spawn(monitor(cfg, shared.clone(), first, restarts.clone()));
        Ok(Arc::new(Host { data_dir, install_lock: tokio::sync::Mutex::new(()), shared, monitor: Mutex::new(Some(monitor)), restarts }))
    }

    /// Every event of the worker plus the main process's own `connection` events.
    pub fn events(&self) -> broadcast::Receiver<EventMessage> {
        self.shared.events.subscribe()
    }

    /// How many times the worker was restarted so far.
    pub fn restart_count(&self) -> u32 {
        self.restarts.load(Ordering::SeqCst)
    }

    /// Forwards one request. `client` identifies the window or browser (§9.2).
    pub async fn request(&self, client: Option<&str>, method: &str, params: Value) -> Result<Value, ProtocolError> {
        if method == onedesk_protocol::method::HELLO {
            let ok = params.get("protocol").and_then(Value::as_str) == Some(PROTOCOL_VERSION);
            if !ok {
                return Err(ProtocolError {
                    code: ErrorCode::VersionMismatch,
                    params: [("expected".to_string(), PROTOCOL_VERSION.to_string())].into(),
                    detail: None,
                });
            }
            return Ok(self.shared.hello.lock().unwrap().clone());
        }
        match method {
            "app.inspectPlugin" => return self.inspect_plugin(client, params).await,
            "app.installPlugin" => return self.install_plugin(client, params).await,
            "app.removePlugin" => return self.remove_plugin(client, params).await,
            // A client's rescan (a package copied in by hand) takes the same road as ours: refresh the index, add the
            // built-in list. Its own parameters are ignored; only the main process knows what is built in.
            "plugin.rescan" => return self.rescan(client).await,
            _ => {}
        }
        self.forward(client, method, params).await
    }

    /// `app.inspectPlugin`: the worker reads and validates the folder; nothing is copied.
    async fn inspect_plugin(&self, client: Option<&str>, params: Value) -> Result<Value, ProtocolError> {
        let folder = parse::<PluginFolderRef>(params)?;
        self.forward(client, "plugin.inspect", json!({ "folder": folder.folder })).await
    }

    /// `plugin.rescan` with the built-in list (D313).
    async fn rescan(&self, client: Option<&str>) -> Result<Value, ProtocolError> {
        let builtin = self.shared.builtin.lock().unwrap().clone();
        refresh_index(&self.data_dir.join("plugins"), &builtin);
        self.forward(client, "plugin.rescan", json!({ "builtin": builtin })).await
    }

    /// `app.installPlugin` (D312): the interface brings back the `id`, `version` and `fingerprint` the
    /// user saw in the confirmation. The folder must be plain files; the worker looks at it again, the
    /// package is copied without following links into `plugins/.tmp/`, and the worker looks at the
    /// COPY once more. Only if all three still agree does it move into `plugins/<id>/<version>`, get
    /// rescanned and recorded as confirmed with that fingerprint. Any difference deletes the copy and refuses.
    async fn install_plugin(&self, client: Option<&str>, params: Value) -> Result<Value, ProtocolError> {
        let wanted = parse::<AppInstallParams>(params)?;
        if !install::safe_segment(&wanted.id) || !install::safe_segment(&wanted.version) {
            return Err(invalid("badTarget"));
        }
        let src = PathBuf::from(&wanted.folder);
        install::check_package(&src, install::MAX_PACKAGE_BYTES).map_err(|p| invalid(p.reason()))?;
        let same = |preview: &Value| {
            preview.get("valid").and_then(Value::as_bool) == Some(true)
                && preview["id"].as_str() == Some(wanted.id.as_str())
                && preview["version"].as_str() == Some(wanted.version.as_str())
                && preview["fingerprint"].as_str() == Some(wanted.fingerprint.as_str())
        };
        let seen = self.forward(client, "plugin.inspect", json!({ "folder": wanted.folder })).await?;
        if !same(&seen) {
            return Err(invalid(if seen.get("valid").and_then(Value::as_bool) == Some(true) { "changedSinceInspect" } else { "notValid" }));
        }
        let _one_at_a_time = self.install_lock.lock().await;
        let plugin_root = self.data_dir.join("plugins");
        let dest = plugin_root.join(&wanted.id).join(&wanted.version);
        if dest.exists() {
            return Err(invalid("alreadyInstalled"));
        }
        let tmp = install::tmp_dir(&plugin_root).join(format!("{}-{}-{}", wanted.id, wanted.version, std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        if let Err(e) = install::copy_package(&src, &tmp) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(if e.kind() == std::io::ErrorKind::InvalidInput { invalid("symlink") } else { err(ErrorCode::Internal, format!("copy plugin: {e}")) });
        }
        // What is about to be installed is the copy, so that is what gets looked at.
        let copy = match self.forward(client, "plugin.inspect", json!({ "folder": tmp })).await {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err(e);
            }
        };
        if !same(&copy) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(invalid("changedSinceInspect"));
        }
        let placed = std::fs::create_dir_all(dest.parent().expect("has parent")).and_then(|_| std::fs::rename(&tmp, &dest));
        if let Err(e) = placed {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(err(ErrorCode::Internal, format!("install plugin: {e}")));
        }
        // The files are installed whatever comes next. A rescan or confirmation that fails (for example the
        // automatic switch to this version could not take over a resource) is reported next to the result,
        // not as a failure of the install: the version is there and can be switched by hand.
        let mut warning = self.rescan(client).await.err();
        let confirm = json!({ "plugin": wanted.id, "version": wanted.version, "fingerprint": wanted.fingerprint });
        if let Err(e) = self.forward(client, "plugin.confirmPermissions", confirm).await {
            warning = warning.or(Some(e));
        }
        Ok(match warning {
            None => json!({ "plugin": wanted.id, "version": wanted.version }),
            Some(w) => json!({ "plugin": wanted.id, "version": wanted.version, "warning": w }),
        })
    }

    /// `app.removePlugin`: move the version to `plugins/.removed/<id>/<version>-<time>`, rescan.
    async fn remove_plugin(&self, client: Option<&str>, params: Value) -> Result<Value, ProtocolError> {
        let p = parse::<PluginVersionParams>(params)?;
        if !install::safe_segment(&p.plugin) || !install::safe_segment(&p.version) {
            return Err(invalid("badTarget"));
        }
        let _one_at_a_time = self.install_lock.lock().await;
        // The kernel refuses (`conflict/dependents`) while an enabled plugin needs this version; files move only after it agrees.
        self.forward(client, "plugin.checkRemove", json!({ "plugin": p.plugin, "version": p.version })).await?;
        match install::remove_version(&self.data_dir.join("plugins"), &p.plugin, &p.version) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ProtocolError { code: ErrorCode::NotFound, params: [("what".to_string(), "plugin".to_string())].into(), detail: None }),
            Err(e) => return Err(err(ErrorCode::Internal, format!("remove plugin: {e}"))),
        }
        // A removed built-in version is no longer the main process's own copy.
        let key = format!("{}@{}", p.plugin, p.version);
        self.shared.builtin.lock().unwrap().retain(|b| *b != key);
        self.rescan(client).await?;
        Ok(Value::Null)
    }

    /// Sends one request to the worker (waiting for a restarting one).
    async fn forward(&self, client: Option<&str>, method: &str, params: Value) -> Result<Value, ProtocolError> {
        let id = self.shared.next_id();
        let mut rx = self.shared.current.subscribe();
        let deadline = tokio::time::Instant::now() + WAIT_FOR_WORKER;
        loop {
            let live = |c: &Option<Arc<Conn>>| c.as_ref().is_some_and(|c| !c.is_closed());
            let conn = match tokio::time::timeout_at(deadline, rx.wait_for(live)).await {
                Ok(Ok(c)) => c.clone().expect("checked by wait_for"),
                _ => return Err(err(ErrorCode::WorkerGone, "worker is not running")),
            };
            match conn.send(id, method, params.clone(), client.map(str::to_string)).await {
                Ok(resp) => {
                    return match resp.error {
                        Some(e) => Err(e),
                        None => Ok(resp.result.unwrap_or(Value::Null)),
                    }
                }
                Err(SendError::Gone) => return Err(err(ErrorCode::WorkerGone, "worker went away before answering")),
                Err(SendError::NotSent) => {
                    // The worker had died already: wait for its successor.
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        }
    }

    /// Closes the worker connection so it can finish its transaction and exit; kills it after a grace period.
    pub async fn shutdown(&self) {
        self.shared.shutdown.send_replace(true);
        let handle = self.monitor.lock().unwrap().take();
        if let Some(h) = handle {
            let _ = h.await;
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // The monitor owns the child with kill_on_drop; make it stop restarting.
        self.shared.shutdown.send_replace(true);
    }
}

async fn monitor(cfg: HostConfig, shared: Arc<Shared>, first: Started, restarts: Arc<std::sync::atomic::AtomicU32>) {
    let mut started = first;
    let mut shutdown_rx = shared.shutdown.subscribe();
    let mut quick_failures: u32 = 0;
    loop {
        let began = Instant::now();
        tokio::select! {
            _ = started.child.wait() => {}
            _ = async { let _ = shutdown_rx.wait_for(|s| *s).await; } => {
                shared.current.send_replace(None);
                started.conn.close_write().await;
                if tokio::time::timeout(SHUTDOWN_GRACE, started.child.wait()).await.is_err() {
                    let _ = started.child.kill().await;
                }
                let _ = std::fs::remove_file(&started.socket);
                // A worker that was killed (by us or from outside) cannot end its programs itself (D340).
                process_groups::cleanup_recorded(&workspace_dir(&cfg.data_dir));
                return;
            }
        }
        let _ = std::fs::remove_file(&started.socket);
        process_groups::cleanup_recorded(&workspace_dir(&cfg.data_dir));
        shared.current.send_replace(None);
        shared.connection_event(ConnectionState::Lost);
        quick_failures = if began.elapsed() < Duration::from_secs(10) { quick_failures + 1 } else { 0 };
        // Restart; the interval grows with every consecutive failure.
        let mut attempt = quick_failures.saturating_sub(1);
        started = loop {
            let wait = Duration::from_millis(100u64 << attempt.min(6));
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = async { let _ = shutdown_rx.wait_for(|s| *s).await; } => return,
            }
            match spawn_worker(&cfg, &shared).await {
                Ok(s) => break s,
                Err(_) => attempt += 1,
            }
        };
        *shared.hello.lock().unwrap() = started.hello.clone();
        restarts.fetch_add(1, Ordering::SeqCst);
        shared.current.send_replace(Some(started.conn.clone()));
        shared.connection_event(ConnectionState::Restored);
    }
}

