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

use onedesk_kernel::secrets::SecretStoreHandle;
use onedesk_protocol::{
    method13::{APP_CREATE_WORKSPACE, APP_DELETE_WORKSPACE, APP_RENAME_WORKSPACE, APP_SWITCH_WORKSPACE, APP_WORKSPACES, WORKSPACE_SETTINGS_SNAPSHOT},
    topic13::APP_WORKSPACES_CHANGED, CreateWorkspaceParams, RenameWorkspaceParams, WorkspaceIdParams, WorkspacesResult,
    ConnectionState, ErrorCode, EventMessage, HelloParams, HelloResult, AppInstallParams, PluginFolderRef, PluginVersionParams, ProtocolError, Request, Response,
    PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, oneshot, watch};

pub mod data_dir;
pub mod external;
pub mod index;
pub mod install;
pub mod mcp_socket;
pub mod plugins;
pub mod process_groups;
pub mod unpack;
pub mod workspaces;
pub mod ws;

pub use data_dir::{default_data_dir, resolve_worker_bin, workspace_dir, workspace_path};
pub use onedesk_protocol::WorkspaceEntry;

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
    /// Where deleting a workspace removes its secrets from (D401). `None`: `SecretStoreHandle::from_env()` — the keychain,
    /// or memory with `ONEDESK_SECRET_STORE=memory`. Tests pass a memory store.
    pub secrets: Option<SecretStoreHandle>,
}

/// An event of one worker (or of the main process) with the workspace it belongs to; `workspace: None` goes to everyone.
#[derive(Debug, Clone)]
pub struct HostEvent {
    pub workspace: Option<String>,
    pub event: EventMessage,
}

impl std::ops::Deref for HostEvent {
    type Target = EventMessage;
    fn deref(&self) -> &EventMessage {
        &self.event
    }
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

    async fn send(&self, id: u64, method: &str, params: Value, client: Option<String>, actor: Option<String>) -> Result<Response, SendError> {
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if self.is_closed() {
                return Err(SendError::NotSent);
            }
            pending.insert(id, tx);
        }
        let mut line = serde_json::to_string(&Request { id, method: method.to_string(), params, client, actor }).expect("request serializes");
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

async fn read_loop(read: tokio::net::unix::OwnedReadHalf, conn: Arc<Conn>, events: broadcast::Sender<HostEvent>, folder: String) {
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
            let _ = events.send(HostEvent { workspace: Some(folder.clone()), event: ev });
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

/// How long the main process waits for a workspace lock held by someone else — the headless `onedesk-mcp` worker
/// (round 19). That worker lets go after a few idle seconds, so a short wait is enough.
const LOCK_WAIT: Duration = Duration::from_secs(30);
/// The `HostError` text of a worker that exited with 3 (workspace locked).
pub const LOCKED_MESSAGE: &str = "workspace is locked by another worker (exit 3)";

/// Waits (up to `LOCK_WAIT`) until no other process holds the workspace lock. Only a courtesy to callers that would
/// otherwise wait while holding the operations lock: whoever starts the worker still retries on exit code 3.
async fn wait_unlocked(workspace: &Path) {
    use onedesk_kernel::workspace::{lock_workspace, LockError};
    let deadline = Instant::now() + LOCK_WAIT;
    while Instant::now() < deadline {
        match lock_workspace(workspace) {
            Err(LockError::Busy) => tokio::time::sleep(Duration::from_millis(200)).await,
            // Free (the probe lock is dropped at once) or not probeable: let the start decide.
            _ => return,
        }
    }
}

/// `spawn_worker_once`, trying again while the workspace is locked by another worker (an AI client using it headless).
async fn spawn_worker(cfg: &HostConfig, shared: &Shared) -> Result<Started, HostError> {
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match spawn_worker_once(cfg, shared).await {
            Err(e) if e.0 == LOCKED_MESSAGE && Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(300)).await,
            other => return other,
        }
    }
}

async fn spawn_worker_once(cfg: &HostConfig, shared: &Shared) -> Result<Started, HostError> {
    let workspace = workspace_path(&cfg.data_dir, &shared.folder);
    // The kernel rewrites `workspace.json` when it opens the workspace; the window position is ours to keep, on a
    // restart after a crash as much as at the first start.
    let window = workspaces::read_info(&workspace).and_then(|i| i.window);
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
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| HostError(format!("cannot start worker {}: {e}", cfg.worker_bin.display())))?;
    // The worker's own words go on to our stderr; the last of them explain a start that failed (for example why the database could not be opened).
    let tail = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("{line}");
                let mut t = tail.lock().unwrap();
                if !t.is_empty() {
                    t.push('\n');
                }
                t.push_str(&line);
                // Keep the last ~2000 bytes, cut on a character boundary.
                if t.len() > 2000 {
                    let mut cut = t.len() - 2000;
                    while !t.is_char_boundary(cut) {
                        cut += 1;
                    }
                    t.drain(..cut);
                }
            }
        });
    }
    let deadline = Instant::now() + START_TIMEOUT;
    let stream = loop {
        match UnixStream::connect(&socket).await {
            Ok(s) => break s,
            Err(_) => {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(HostError(match status.code() {
                        Some(3) => LOCKED_MESSAGE.to_string(),
                        _ => {
                            // Give the reader task a moment to deliver the last line.
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            format!("worker exited during start: {status}: {}", tail.lock().unwrap().trim())
                        }
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
    tokio::spawn(read_loop(read, conn.clone(), shared.events.clone(), shared.folder.clone()));
    let params = serde_json::to_value(HelloParams { protocol: PROTOCOL_VERSION.to_string() }).expect("hello params");
    let resp = match conn.send(shared.next_id(), "hello", params, None, None).await {
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
    workspaces::keep_window(&workspace, window);
    Ok(Started { child, conn, hello, socket })
}

/* ---------------------------------------------------------------- host */

/// What one worker process needs: its workspace folder, the shared event channel and its own connection state.
struct Shared {
    folder: String,
    next_id: AtomicU64,
    events: broadcast::Sender<HostEvent>,
    hello: Mutex<Value>,
    /// `<id>@<version>` of the built-in plugins this process copied (D313); the worker may auto-confirm only these.
    builtin: Arc<Mutex<Vec<String>>>,
    current: watch::Sender<Option<Arc<Conn>>>,
    shutdown: watch::Sender<bool>,
}

impl Shared {
    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    fn connection_event(&self, state: ConnectionState) {
        let payload = serde_json::to_value(state).expect("state serializes");
        let event = EventMessage { topic: onedesk_protocol::topic::CONNECTION.into(), payload: Some(payload), client: None };
        let _ = self.events.send(HostEvent { workspace: Some(self.folder.clone()), event });
    }
}

/// Brings `plugins/.index` up to date (D364). A failure only costs the cache: the kernel scans directly without it.
/// A package file unpacked for one request (D456); the folder is removed on drop.
struct Unpacked {
    dir: PathBuf,
    root: PathBuf,
}

impl Drop for Unpacked {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn refresh_index(plugin_root: &Path, builtin: &[String]) {
    if let Err(e) = index::refresh(plugin_root, builtin) {
        eprintln!("onedesk-host: could not refresh plugins/.index: {e}");
        // A stale index would hide changes from the kernel; without one it scans the folders itself.
        let _ = std::fs::remove_file(plugin_root.join(index::FILE_NAME));
    }
}

/// One running worker: its connection state, restart count and the task that watches it.
struct Slot {
    shared: Arc<Shared>,
    monitor: Mutex<Option<tokio::task::JoinHandle<()>>>,
    restarts: Arc<std::sync::atomic::AtomicU32>,
}

impl Slot {
    /// Closes the worker connection so it can finish its transaction and exit; kills it after a grace period.
    async fn stop(&self) {
        self.shared.shutdown.send_replace(true);
        let handle = self.monitor.lock().unwrap().take();
        if let Some(h) = handle {
            let _ = h.await;
        }
    }

    /// Sends one request to the worker (waiting for a restarting one).
    async fn forward(&self, client: Option<&str>, method: &str, params: Value) -> Result<Value, ProtocolError> {
        self.forward_as(client, None, method, params).await
    }

    /// `actor`: the operator the main process vouches for (an AI connection, round 19); the worker trusts it.
    async fn forward_as(&self, client: Option<&str>, actor: Option<String>, method: &str, params: Value) -> Result<Value, ProtocolError> {
        let id = self.shared.next_id();
        let mut rx = self.shared.current.subscribe();
        let deadline = tokio::time::Instant::now() + WAIT_FOR_WORKER;
        loop {
            let live = |c: &Option<Arc<Conn>>| c.as_ref().is_some_and(|c| !c.is_closed());
            let conn = match tokio::time::timeout_at(deadline, rx.wait_for(live)).await {
                Ok(Ok(c)) => c.clone().expect("checked by wait_for"),
                _ => return Err(err(ErrorCode::WorkerGone, "worker is not running")),
            };
            match conn.send(id, method, params.clone(), client.map(str::to_string), actor.clone()).await {
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
}

/// The main process: one worker per workspace that a connection is using (D400). Each connection (`client`) is bound
/// to one workspace; its requests go to that workspace's worker and it only sees that worker's events.
pub struct Host {
    cfg: HostConfig,
    data_dir: PathBuf,
    install_lock: tokio::sync::Mutex<()>,
    builtin: Arc<Mutex<Vec<String>>>,
    events: broadcast::Sender<HostEvent>,
    /// Running workers by workspace folder.
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    /// Serialises starting a worker so two requests do not start the same workspace twice.
    start_lock: tokio::sync::Mutex<()>,
    /// `client` -> folder, set by `app.switchWorkspace`.
    bindings: Mutex<HashMap<String, String>>,
    /// The workspace a connection that appears now starts in: the one opened at start, then the last one switched to.
    /// It routes nothing and does not count as "in use" (D406).
    active: Mutex<String>,
    /// Workspace operations (create, switch, bind, rename, delete) one at a time, so a delete cannot slip between
    /// a switch's worker start and its binding.
    ops: tokio::sync::Mutex<()>,
    secrets: SecretStoreHandle,
}

impl Host {
    /// Prepares the data directory, copies built-in plugins,
    /// starts the worker of the most recently opened workspace and says hello.
    pub async fn start(cfg: HostConfig) -> Result<Arc<Host>, HostError> {
        std::fs::create_dir_all(&cfg.data_dir).map_err(|e| HostError(format!("data dir: {e}")))?;
        let first = match workspaces::sorted(workspaces::scan(&cfg.data_dir)).into_iter().next() {
            Some((folder, _)) => folder,
            None => {
                let dir = workspace_dir(&cfg.data_dir);
                std::fs::create_dir_all(&dir).map_err(|e| HostError(format!("data dir: {e}")))?;
                let info = workspaces::InfoFile { id: workspaces::new_id(), name: "Default".into(), last_opened_at: 0, window: None };
                workspaces::write_info(&dir, &info).map_err(|e| HostError(format!("workspace.json: {e}")))?;
                "default".to_string()
            }
        };
        let plugin_root = cfg.data_dir.join("plugins");
        std::fs::create_dir_all(&plugin_root).map_err(|e| HostError(format!("plugins dir: {e}")))?;
        let mut builtin = Vec::new();
        if let Some(src) = &cfg.builtin_plugins {
            builtin = plugins::install_builtin(src, &plugin_root).map_err(|e| HostError(format!("copy built-in plugins: {e}")))?.present;
        }
        refresh_index(&plugin_root, &builtin);
        let (events, _) = broadcast::channel(1024);
        let secrets = cfg.secrets.clone().unwrap_or_else(SecretStoreHandle::from_env);
        let host = Arc::new(Host {
            data_dir: cfg.data_dir.clone(),
            cfg,
            install_lock: tokio::sync::Mutex::new(()),
            builtin: Arc::new(Mutex::new(builtin)),
            events,
            slots: Mutex::new(HashMap::new()),
            start_lock: tokio::sync::Mutex::new(()),
            bindings: Mutex::new(HashMap::new()),
            active: Mutex::new(first.clone()),
            ops: tokio::sync::Mutex::new(()),
            secrets,
        });
        host.slot_for(&first).await.map_err(|e| HostError(e.detail.unwrap_or_else(|| format!("{:?}", e.code))))?;
        host.touch_last_opened(&first);
        Ok(host)
    }

    /// Every event of every worker plus the main process's own events; `visible_to` says who gets which.
    pub fn events(&self) -> broadcast::Receiver<HostEvent> {
        self.events.subscribe()
    }

    /// Whether `client` should receive `ev`: addressed to it (or to nobody in particular) and from the workspace it uses.
    pub fn visible_to(&self, ev: &HostEvent, client: &str) -> bool {
        if ev.event.client.as_deref().is_some_and(|c| c != client) {
            return false;
        }
        ev.workspace.as_ref().is_none_or(|w| *w == self.bound(Some(client)))
    }

    /// The folders whose workers are running.
    pub fn running_workspaces(&self) -> Vec<String> {
        let mut v: Vec<String> = self.slots.lock().unwrap().keys().cloned().collect();
        v.sort();
        v
    }

    /// How many times workers were restarted so far.
    pub fn restart_count(&self) -> u32 {
        self.slots.lock().unwrap().values().map(|s| s.restarts.load(Ordering::SeqCst)).sum()
    }

    /// The folder `client` uses. A connection is bound the first time it appears, to the default of that moment (D406);
    /// after that only its own `app.switchWorkspace` (or a new window's binding) changes it.
    fn bound(&self, client: Option<&str>) -> String {
        let key = client.unwrap_or_default();
        let mut bindings = self.bindings.lock().unwrap();
        if let Some(f) = bindings.get(key) {
            return f.clone();
        }
        let folder = self.active.lock().unwrap().clone();
        bindings.insert(key.to_string(), folder.clone());
        folder
    }

    /// The running worker of a folder, starting it if needed.
    async fn slot_for(&self, folder: &str) -> Result<Arc<Slot>, ProtocolError> {
        if let Some(s) = self.slots.lock().unwrap().get(folder) {
            return Ok(s.clone());
        }
        let _one_start = self.start_lock.lock().await;
        if let Some(s) = self.slots.lock().unwrap().get(folder) {
            return Ok(s.clone());
        }
        let shared = Arc::new(Shared {
            folder: folder.to_string(),
            next_id: AtomicU64::new(1),
            events: self.events.clone(),
            hello: Mutex::new(Value::Null),
            builtin: self.builtin.clone(),
            current: watch::channel(None).0,
            shutdown: watch::channel(false).0,
        });
        let first = spawn_worker(&self.cfg, &shared).await.map_err(|e| err(ErrorCode::WorkerGone, e.0))?;
        *shared.hello.lock().unwrap() = first.hello.clone();
        shared.current.send_replace(Some(first.conn.clone()));
        let restarts = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let monitor = tokio::spawn(monitor(self.cfg.clone(), shared.clone(), first, restarts.clone()));
        let slot = Arc::new(Slot { shared, monitor: Mutex::new(Some(monitor)), restarts });
        self.slots.lock().unwrap().insert(folder.to_string(), slot.clone());
        Ok(slot)
    }

    /// Forwards one request. `client` identifies the window or browser (§9.2).
    pub async fn request(&self, client: Option<&str>, method: &str, params: Value) -> Result<Value, ProtocolError> {
        self.request_as(client, None, method, params).await
    }

    /// `request` on behalf of an operator the main process vouches for (`actor`, e.g. `ai:<name>` from the MCP socket,
    /// round 19, D450): passed straight to the worker, never kept in a table, and it reaches nothing but the worker
    /// (the main process's own `app.*` handling is not for it). A `client` id in the AI namespace without an actor is
    /// refused: only the MCP socket may name one.
    pub async fn request_as(&self, client: Option<&str>, actor: Option<String>, method: &str, params: Value) -> Result<Value, ProtocolError> {
        if actor.is_some() {
            return self.forward_as(client, actor, method, params).await;
        }
        if client.is_some_and(|c| c.starts_with(mcp_socket::CLIENT_PREFIX)) {
            return Err(ProtocolError { code: ErrorCode::Denied, params: [("reason".to_string(), "reservedClient".to_string())].into(), detail: None });
        }
        if method == onedesk_protocol::method::HELLO {
            let ok = params.get("protocol").and_then(Value::as_str) == Some(PROTOCOL_VERSION);
            if !ok {
                return Err(ProtocolError {
                    code: ErrorCode::VersionMismatch,
                    params: [("expected".to_string(), PROTOCOL_VERSION.to_string())].into(),
                    detail: None,
                });
            }
            let slot = self.slot_for(&self.bound(client)).await?;
            let hello = slot.shared.hello.lock().unwrap().clone();
            return Ok(hello);
        }
        match method {
            "app.inspectPlugin" => return self.inspect_plugin(client, params).await,
            "app.installPlugin" => return self.install_plugin(client, params).await,
            "app.removePlugin" => return self.remove_plugin(client, params).await,
            APP_WORKSPACES => return self.list_workspaces(client),
            APP_CREATE_WORKSPACE => return self.create_workspace(client, params).await,
            APP_SWITCH_WORKSPACE => return self.switch_workspace(client, params).await,
            APP_RENAME_WORKSPACE => return self.rename_workspace(params).await,
            APP_DELETE_WORKSPACE => return self.delete_workspace(client, params).await,
            // A client's rescan (a package copied in by hand) takes the same road as ours: refresh the index, add the
            // built-in list. Its own parameters are ignored; only the main process knows what is built in.
            "plugin.rescan" => return self.rescan(client).await,
            mcp_socket::APP_MCP_INFO => return Ok(mcp_socket::info()),
            _ => {}
        }
        self.forward(client, method, params).await
    }

    /// `app.inspectPlugin`: the worker reads and validates the folder; nothing is copied.
    async fn inspect_plugin(&self, client: Option<&str>, params: Value) -> Result<Value, ProtocolError> {
        let folder = parse::<PluginFolderRef>(params)?;
        // D456: a package file is unpacked first; the worker looks at the unpacked folder, which is then deleted.
        let unpacked = self.unpack_if_file(&folder.folder)?;
        let path = unpacked.as_ref().map(|u| u.root.to_string_lossy().into_owned()).unwrap_or(folder.folder);
        self.forward(client, "plugin.inspect", json!({ "folder": path })).await
    }

    /// D456: when `path` is a package file (`.odplugin`/`.zip`), unpacks it into `plugins/.tmp/unpacked-…` and
    /// returns the package folder inside; the folder is removed when the returned value is dropped. A folder
    /// path gives `None` (the usual folder checks follow).
    fn unpack_if_file(&self, path: &str) -> Result<Option<Unpacked>, ProtocolError> {
        let file = PathBuf::from(path);
        if !file.is_absolute() || !unpack::is_package_file(&file) {
            return Ok(None);
        }
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = install::tmp_dir(&self.data_dir.join("plugins"));
        std::fs::create_dir_all(&tmp).map_err(|e| err(ErrorCode::Internal, format!("unpack plugin: {e}")))?;
        let dir = tmp.join(format!("unpacked-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = unpack::unpack(&file, &dir, install::MAX_PACKAGE_BYTES).map_err(|p| invalid(p.reason()))?;
        Ok(Some(Unpacked { dir, root }))
    }

    /// `plugin.rescan` with the built-in list (D313).
    async fn rescan(&self, client: Option<&str>) -> Result<Value, ProtocolError> {
        let builtin = self.builtin.lock().unwrap().clone();
        refresh_index(&self.data_dir.join("plugins"), &builtin);
        // The plugin folder is shared by every workspace: each running worker looks again, not only the asking one.
        // The asking worker's answer is the answer; a failure in another workspace is theirs to show, not this request's.
        let own = self.bound(client);
        for (folder, slot) in self.running_slots() {
            if folder != own {
                if let Err(e) = slot.forward(None, "plugin.rescan", json!({ "builtin": builtin })).await {
                    eprintln!("onedesk-host: workspace {folder} could not rescan plugins: {}", e.detail.unwrap_or_default());
                }
            }
        }
        self.forward(client, "plugin.rescan", json!({ "builtin": builtin })).await
    }

    /// The running workers with their folders.
    fn running_slots(&self) -> Vec<(String, Arc<Slot>)> {
        self.slots.lock().unwrap().iter().map(|(f, s)| (f.clone(), s.clone())).collect()
    }

    /// `app.installPlugin` (D312): the interface brings back the `id`, `version` and `fingerprint` the
    /// user saw in the confirmation. The folder must be plain files; the worker looks at it again, the
    /// package is copied without following links into `plugins/.tmp/`, and the worker looks at the
    /// COPY once more. Only if all three still agree does it move into `plugins/<id>/<version>`, get
    /// rescanned and recorded as confirmed with that fingerprint. Any difference deletes the copy and refuses.
    async fn install_plugin(&self, client: Option<&str>, params: Value) -> Result<Value, ProtocolError> {
        let mut wanted = parse::<AppInstallParams>(params)?;
        if !install::safe_segment(&wanted.id) || !install::safe_segment(&wanted.version) {
            return Err(invalid("badTarget"));
        }
        // D456: a package file is unpacked again (not reused from the inspection), and the unpacked folder goes
        // through every check below exactly like a folder the user named; it is deleted when this returns.
        let _unpacked = self.unpack_if_file(&wanted.folder)?;
        if let Some(u) = &_unpacked {
            wanted.folder = u.root.to_string_lossy().into_owned();
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
        // Every running workspace is asked: one whose enabled plugins still need this version stops the removal.
        let own = self.bound(client);
        for (folder, slot) in self.running_slots() {
            if folder != own {
                slot.forward(None, "plugin.checkRemove", json!({ "plugin": p.plugin, "version": p.version })).await?;
            }
        }
        self.forward(client, "plugin.checkRemove", json!({ "plugin": p.plugin, "version": p.version })).await?;
        match install::remove_version(&self.data_dir.join("plugins"), &p.plugin, &p.version) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ProtocolError { code: ErrorCode::NotFound, params: [("what".to_string(), "plugin".to_string())].into(), detail: None }),
            Err(e) => return Err(err(ErrorCode::Internal, format!("remove plugin: {e}"))),
        }
        // A removed built-in version is no longer the main process's own copy.
        let key = format!("{}@{}", p.plugin, p.version);
        self.builtin.lock().unwrap().retain(|b| *b != key);
        self.rescan(client).await?;
        Ok(Value::Null)
    }

    /// Sends one request to the worker of the workspace `client` uses.
    async fn forward(&self, client: Option<&str>, method: &str, params: Value) -> Result<Value, ProtocolError> {
        self.forward_as(client, None, method, params).await
    }

    async fn forward_as(&self, client: Option<&str>, actor: Option<String>, method: &str, params: Value) -> Result<Value, ProtocolError> {
        let slot = self.slot_for(&self.bound(client)).await?;
        slot.forward_as(client, actor, method, params).await
    }

    /// Closes every worker connection so they can finish their transactions and exit; kills them after a grace period.
    pub async fn shutdown(&self) {
        let slots: Vec<Arc<Slot>> = self.slots.lock().unwrap().drain().map(|(_, s)| s).collect();
        for s in slots {
            s.stop().await;
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // The monitors own the children with kill_on_drop; make them stop restarting.
        for s in self.slots.lock().unwrap().values() {
            s.shared.shutdown.send_replace(true);
        }
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
                process_groups::cleanup_recorded(&workspace_path(&cfg.data_dir, &shared.folder));
                return;
            }
        }
        let _ = std::fs::remove_file(&started.socket);
        process_groups::cleanup_recorded(&workspace_path(&cfg.data_dir, &shared.folder));
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


/* ---------------------------------------------------------------- workspaces (D400, D401) */

fn in_use() -> ProtocolError {
    ProtocolError { code: ErrorCode::Conflict, params: [("reason".to_string(), "inUse".to_string())].into(), detail: None }
}

fn not_found(what: &str) -> ProtocolError {
    ProtocolError { code: ErrorCode::NotFound, params: [("what".to_string(), what.to_string())].into(), detail: None }
}

impl Host {
    /// The workspace folders as the main process sees them right now.
    fn scanned(&self) -> Vec<(String, workspaces::InfoFile)> {
        workspaces::sorted(workspaces::scan(&self.data_dir))
    }

    fn find(&self, id: &str) -> Result<(String, workspaces::InfoFile), ProtocolError> {
        self.scanned().into_iter().find(|(f, i)| workspaces::entry(f, i, false).id == id).ok_or_else(|| not_found("workspace"))
    }

    /// Like `find`, but refuses a workspace whose id is still pending (no `workspace.json` yet): renaming or deleting it
    /// would need the id (D404). Opening it once lets the kernel write the file.
    fn find_with_id(&self, id: &str) -> Result<(String, workspaces::InfoFile), ProtocolError> {
        let found = self.find(id)?;
        if found.1.id.is_empty() {
            return Err(ProtocolError { code: ErrorCode::Conflict, params: [("reason".to_string(), "idPending".to_string())].into(), detail: None });
        }
        Ok(found)
    }

    fn changed(&self) {
        let event = EventMessage { topic: APP_WORKSPACES_CHANGED.into(), payload: None, client: None };
        let _ = self.events.send(HostEvent { workspace: None, event });
    }

    /// The window position and size remembered for a workspace folder (D403).
    pub fn window_bounds(&self, folder: &str) -> Option<workspaces::WindowBounds> {
        workspaces::read_info(&workspace_path(&self.data_dir, folder)).and_then(|i| i.window)
    }

    /// Remembers (or, with `None`, keeps) the window position and size in the workspace's `workspace.json`.
    pub fn set_window_bounds(&self, folder: &str, bounds: Option<workspaces::WindowBounds>) {
        let dir = workspace_path(&self.data_dir, folder);
        if let (Some(b), Some(mut info)) = (bounds, workspaces::read_info(&dir)) {
            info.window = Some(b);
            let _ = workspaces::write_info(&dir, &info);
        }
    }

    /// The workspace folder a window or tab (`client`) uses now.
    pub fn client_folder(&self, client: &str) -> String {
        self.bound(Some(client))
    }

    /// Binds a new window or tab to a workspace without changing the default for others (D403). Starts the
    /// workspace's worker if needed.
    pub async fn bind_client(&self, client: &str, workspace_id: &str) -> Result<WorkspaceEntry, ProtocolError> {
        self.bind_client_with(client, workspace_id, true).await
    }

    /// `bind_client` for an AI connection: using a workspace through it does not make it "the one opened last" (D450).
    pub async fn bind_ai_client(&self, client: &str, workspace_id: &str) -> Result<WorkspaceEntry, ProtocolError> {
        self.bind_client_with(client, workspace_id, false).await
    }

    async fn bind_client_with(&self, client: &str, workspace_id: &str, touch: bool) -> Result<WorkspaceEntry, ProtocolError> {
        // Waiting for a workspace another process holds (an AI client's headless worker) happens before the operations
        // lock is taken, so switching or deleting other workspaces is not held up meanwhile (D450).
        if let Ok((folder, _)) = self.find(workspace_id) {
            if !self.running_workspaces().contains(&folder) {
                wait_unlocked(&workspace_path(&self.data_dir, &folder)).await;
            }
        }
        let _one_at_a_time = self.ops.lock().await;
        let (folder, info) = self.find(workspace_id)?;
        self.attach(client, &folder, touch).await?;
        let info = workspaces::read_info(&workspace_path(&self.data_dir, &folder)).unwrap_or(info);
        Ok(workspaces::entry(&folder, &info, true))
    }

    /// Binds `client` to `folder` before the worker starts (so a delete cannot get in between) and starts it; on a
    /// failure the old binding stays. Called with the operations lock held.
    async fn attach(&self, client: &str, folder: &str, touch: bool) -> Result<(), ProtocolError> {
        let old = self.bound(Some(client));
        self.bindings.lock().unwrap().insert(client.to_string(), folder.to_string());
        if let Err(e) = self.slot_for(folder).await {
            self.bindings.lock().unwrap().insert(client.to_string(), old);
            return Err(e);
        }
        if touch {
            self.touch_last_opened(folder);
        }
        if old != folder {
            self.release(&old).await;
        }
        Ok(())
    }

    /// A window or tab went away: its worker stops when nobody else uses it.
    pub async fn unbind_client(&self, client: &str) {
        let _one_at_a_time = self.ops.lock().await;
        let old = self.bindings.lock().unwrap().remove(client);
        if let Some(folder) = old {
            // A connection that merely ends (a short rpc connection, a page reload) does not stop the worker of the
            // workspace new connections start in: the next one would pay a restart and could cut a run short. A
            // worker stops when its connections moved elsewhere or when its workspace is not the default.
            if *self.active.lock().unwrap() != folder {
                self.release(&folder).await;
            }
        }
    }

    fn touch_last_opened(&self, folder: &str) {
        let dir = workspace_path(&self.data_dir, folder);
        if let Some(mut info) = workspaces::read_info(&dir) {
            info.last_opened_at = workspaces::now_ms();
            let _ = workspaces::write_info(&dir, &info);
        }
    }

    /// `app.workspaces` → `{ items: WorkspaceEntry[] }`, newest `lastOpened` first.
    fn list_workspaces(&self, client: Option<&str>) -> Result<Value, ProtocolError> {
        let mine = self.bound(client);
        let items: Vec<WorkspaceEntry> = self.scanned().iter().map(|(f, i)| workspaces::entry(f, i, *f == mine)).collect();
        Ok(serde_json::to_value(WorkspacesResult { items }).expect("serializes"))
    }

    /// `app.createWorkspace { name }`: a new folder with the current workspace's settings to apply at its first open.
    /// Nothing is switched.
    async fn create_workspace(&self, client: Option<&str>, params: Value) -> Result<Value, ProtocolError> {
        let _one_at_a_time = self.ops.lock().await;
        let name = workspaces::valid_name(&parse::<CreateWorkspaceParams>(params)?.name).ok_or_else(|| err(ErrorCode::InvalidParams, "name must be 1 to 100 characters"))?;
        // The kernel gives the configuration tree values and plugin enablement (no data). A kernel without the method
        // yields an empty workspace. It answers only the main process itself, so the request carries no `client`.
        let slot = self.slot_for(&self.bound(client)).await?;
        let snapshot = match slot.forward(None, WORKSPACE_SETTINGS_SNAPSHOT, Value::Null).await {
            Ok(v) => Some(v),
            Err(e) if e.code == ErrorCode::UnknownMethod => None,
            Err(e) => return Err(e),
        };
        let (folder, info) = workspaces::create(&self.data_dir, &name, snapshot.as_ref()).map_err(|e| err(ErrorCode::Internal, e))?;
        self.changed();
        Ok(serde_json::to_value(workspaces::entry(&folder, &info, false)).expect("entry serializes"))
    }

    /// `app.switchWorkspace { id }`: binds this connection to the workspace (starting its worker if needed). The
    /// worker left behind stops when no connection uses it any more.
    async fn switch_workspace(&self, client: Option<&str>, params: Value) -> Result<Value, ProtocolError> {
        let id = parse::<WorkspaceIdParams>(params)?.id;
        if let Ok((folder, _)) = self.find(&id) {
            if !self.running_workspaces().contains(&folder) {
                wait_unlocked(&workspace_path(&self.data_dir, &folder)).await;
            }
        }
        let _one_at_a_time = self.ops.lock().await;
        let (folder, info) = self.find(&id)?;
        self.attach(client.unwrap_or_default(), &folder, true).await?;
        *self.active.lock().unwrap() = folder.clone();
        let info = workspaces::read_info(&workspace_path(&self.data_dir, &folder)).unwrap_or(info);
        Ok(serde_json::to_value(workspaces::entry(&folder, &info, true)).expect("entry serializes"))
    }

    /// Stops the worker of `folder` unless a connection still uses it.
    async fn release(&self, folder: &str) {
        let used = self.bindings.lock().unwrap().values().any(|f| f == folder);
        if used {
            return;
        }
        self.stop_slot(folder).await;
    }

    /// Stops the worker of `folder` and waits until it has exited (and released the workspace lock). Nobody starts a
    /// worker for any workspace meanwhile, so a connection that arrives now waits instead of starting a second worker
    /// for the same folder.
    async fn stop_slot(&self, folder: &str) {
        let _no_start_meanwhile = self.start_lock.lock().await;
        let slot = self.slots.lock().unwrap().remove(folder);
        if let Some(slot) = slot {
            slot.stop().await;
        }
    }

    /// `app.renameWorkspace { id, name }`: changes the name in `workspace.json`.
    async fn rename_workspace(&self, params: Value) -> Result<Value, ProtocolError> {
        let _one_at_a_time = self.ops.lock().await;
        let p = parse::<RenameWorkspaceParams>(params)?;
        let name = workspaces::valid_name(&p.name).ok_or_else(|| err(ErrorCode::InvalidParams, "name must be 1 to 100 characters"))?;
        let (folder, mut info) = self.find_with_id(&p.id)?;
        info.name = name;
        workspaces::write_info(&workspace_path(&self.data_dir, &folder), &info).map_err(|e| err(ErrorCode::Internal, format!("workspace.json: {e}")))?;
        self.changed();
        Ok(Value::Null)
    }

    /// `app.deleteWorkspace { id }`: not the one in use; the folder moves to `trash/workspaces/` and its keychain
    /// entries are deleted.
    async fn delete_workspace(&self, client: Option<&str>, params: Value) -> Result<Value, ProtocolError> {
        let _one_at_a_time = self.ops.lock().await;
        let (folder, info) = self.find_with_id(&parse::<WorkspaceIdParams>(params)?.id)?;
        let mine = self.bound(client);
        if mine == folder || self.bindings.lock().unwrap().values().any(|f| *f == folder) {
            return Err(in_use());
        }
        // New connections must not start in a workspace that is going away.
        {
            let mut active = self.active.lock().unwrap();
            if *active == folder {
                *active = mine;
            }
        }
        // An idle worker (nobody is bound to it) goes first, so the folder is not moved under a running process.
        self.stop_slot(&folder).await;
        let trashed = workspaces::move_to_trash(&self.data_dir, &folder).map_err(|e| err(ErrorCode::Internal, e))?;
        // The keychain accounts are `<workspace id>/<name>`: all of them go, without opening the database (D404).
        if let Err(e) = self.secrets.0.delete_prefix(&format!("{}/", info.id)) {
            eprintln!("onedesk-host: could not delete the keychain entries of workspace {}: {e}", info.id);
        }
        let _ = trashed;
        self.changed();
        Ok(Value::Null)
    }
}
