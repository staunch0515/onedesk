//! The message interface in both shapes:
//! - `serve_connection`: worker side, newline-delimited JSON over a Unix socket;
//! - `Client::InProc`: the same kernel reached in-process, still as JSON lines;
//! - `Client::Socket`: client end of the socket;
//! - `Client::Supervised`: main-process side that spawns, watches and restarts a worker.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ks_protocol::*;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::kernel::Kernel;

/// Serves one connection until the peer closes it.
pub async fn serve_connection(kernel: Arc<Kernel>, stream: UnixStream) {
    let (read, mut write) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(mut line) = rx.recv().await {
            line.push('\n');
            if write.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let mut events = kernel.subscribe();
    let etx = tx.clone();
    let pusher = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ev) => {
                    if etx.send(serde_json::to_string(&ev).expect("event serializes")).is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let (kernel, tx) = (kernel.clone(), tx.clone());
        // One task per request so a slow handler does not block `request.cancel`.
        tokio::spawn(async move {
            let _ = tx.send(kernel.handle_line(&line).await);
        });
    }
    pusher.abort();
    drop(tx);
    let _ = writer.await;
}

fn gone(msg: &str) -> RpcError {
    RpcError { code: ErrorCode::WorkerGone, message: msg.to_string() }
}

fn into_result(resp: Response) -> Result<Value, RpcError> {
    match resp.error {
        Some(e) => Err(e),
        None => Ok(resp.result.unwrap_or(Value::Null)),
    }
}

pub struct InProc {
    kernel: Arc<Kernel>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>;

pub struct SocketClient {
    write: tokio::sync::Mutex<OwnedWriteHalf>,
    pending: Pending,
    events: broadcast::Sender<Event>,
    closed: Arc<AtomicBool>,
}

impl SocketClient {
    pub async fn connect(path: &Path) -> std::io::Result<Arc<Self>> {
        let stream = UnixStream::connect(path).await?;
        let (read, write) = stream.into_split();
        let pending: Pending = Default::default();
        let (events, _) = broadcast::channel(256);
        let closed = Arc::new(AtomicBool::new(false));
        let (p2, e2, c2) = (pending.clone(), events.clone(), closed.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<ServerMessage>(&line) {
                    Ok(ServerMessage::Response(r)) => {
                        if let Some(tx) = p2.lock().unwrap().remove(&r.id) {
                            let _ = tx.send(r);
                        }
                    }
                    Ok(ServerMessage::Event(ev)) => {
                        let _ = e2.send(ev);
                    }
                    Err(_) => {}
                }
            }
            // Peer gone: fail everything still waiting.
            c2.store(true, Ordering::SeqCst);
            p2.lock().unwrap().clear();
        });
        Ok(Arc::new(SocketClient { write: tokio::sync::Mutex::new(write), pending, events, closed }))
    }

    async fn send(&self, id: u64, method: &str, params: Value) -> Result<Value, RpcError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(gone("worker connection closed"));
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut line = serde_json::to_string(&Request { id, method: method.to_string(), params }).expect("request serializes");
        line.push('\n');
        if self.write.lock().await.write_all(line.as_bytes()).await.is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(gone("worker connection closed"));
        }
        match rx.await {
            Ok(resp) => into_result(resp),
            Err(_) => Err(gone("worker went away before answering")),
        }
    }
}

/// Main-process side of multi-process mode.
pub struct Supervisor {
    current: watch::Receiver<Option<Arc<SocketClient>>>,
    events: broadcast::Sender<Event>,
    shutdown: Arc<AtomicBool>,
    pub restarts: Arc<AtomicU32>,
    monitor: tokio::task::JoinHandle<()>,
}

pub struct WorkerSpec {
    pub worker_bin: PathBuf,
    pub workspace: PathBuf,
    pub plugins_dir: PathBuf,
    /// Keep it short: macOS limits Unix socket paths to 103 bytes.
    pub socket: PathBuf,
}

pub async fn spawn_and_connect(spec: &WorkerSpec) -> Result<(tokio::process::Child, Arc<SocketClient>), String> {
    let _ = std::fs::remove_file(&spec.socket);
    let mut child = tokio::process::Command::new(&spec.worker_bin)
        .arg("--workspace")
        .arg(&spec.workspace)
        .arg("--plugins")
        .arg(&spec.plugins_dir)
        .arg("--socket")
        .arg(&spec.socket)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn worker: {e}"))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(c) = SocketClient::connect(&spec.socket).await {
            return Ok((child, c));
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("worker exited during start: {status}"));
        }
        if tokio::time::Instant::now() > deadline {
            let _ = child.start_kill();
            return Err("worker did not start listening in time".into());
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

impl Supervisor {
    pub async fn start(spec: WorkerSpec) -> Result<Self, String> {
        let (mut child, client) = spawn_and_connect(&spec).await?;
        let (tx, current) = watch::channel(Some(client.clone()));
        let (events, _) = broadcast::channel(256);
        let shutdown = Arc::new(AtomicBool::new(false));
        let restarts = Arc::new(AtomicU32::new(0));
        let (ev, sd, rs) = (events.clone(), shutdown.clone(), restarts.clone());
        let monitor = tokio::spawn(async move {
            let mut client = client;
            let mut failures: u32 = 0;
            loop {
                let mut worker_events = client.events.subscribe();
                let status = loop {
                    tokio::select! {
                        s = child.wait() => break s,
                        e = worker_events.recv() => match e {
                            Ok(e) => { let _ = ev.send(e); }
                            Err(broadcast::error::RecvError::Lagged(_)) => {}
                            Err(broadcast::error::RecvError::Closed) => { break child.wait().await; }
                        },
                    }
                };
                if sd.load(Ordering::SeqCst) {
                    break;
                }
                let _ = tx.send(None);
                let _ = ev.send(Event { event: "worker.crashed".into(), payload: json!({ "status": format!("{status:?}") }) });
                // Restart, waiting longer after each consecutive failure.
                loop {
                    tokio::time::sleep(Duration::from_millis(50 * (1u64 << failures.min(6)))).await;
                    if sd.load(Ordering::SeqCst) {
                        return;
                    }
                    match spawn_and_connect(&spec).await {
                        Ok((c, cl)) => {
                            child = c;
                            client = cl;
                            failures = 0;
                            break;
                        }
                        Err(_) => failures += 1,
                    }
                }
                rs.fetch_add(1, Ordering::SeqCst);
                let _ = tx.send(Some(client.clone()));
                let _ = ev.send(Event { event: "worker.restarted".into(), payload: Value::Null });
            }
        });
        Ok(Supervisor { current, events, shutdown, restarts, monitor })
    }

    async fn client(&self) -> Result<Arc<SocketClient>, RpcError> {
        let mut rx = self.current.clone();
        // A client whose connection already closed is a dead worker the monitor
        // has not reaped yet: wait for its replacement instead of failing.
        let live = |c: &Option<Arc<SocketClient>>| c.as_ref().is_some_and(|c| !c.closed.load(Ordering::SeqCst));
        let found = match tokio::time::timeout(Duration::from_secs(10), rx.wait_for(live)).await {
            Ok(Ok(c)) => c.clone(),
            _ => None,
        };
        found.ok_or_else(|| gone("worker is not running"))
    }

}

impl Drop for Supervisor {
    /// Stops watching; the worker is killed with the monitor task (kill_on_drop).
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.monitor.abort();
    }
}

pub enum Client {
    InProc(InProc, AtomicU64),
    Socket(Arc<SocketClient>, AtomicU64),
    Supervised(Supervisor, AtomicU64),
}

impl Client {
    pub fn in_proc(kernel: Arc<Kernel>) -> Self {
        Client::InProc(InProc { kernel }, AtomicU64::new(1))
    }
    pub fn socket(c: Arc<SocketClient>) -> Self {
        Client::Socket(c, AtomicU64::new(1))
    }
    pub fn supervised(s: Supervisor) -> Self {
        Client::Supervised(s, AtomicU64::new(1))
    }

    pub fn next_id(&self) -> u64 {
        match self {
            Client::InProc(_, n) | Client::Socket(_, n) | Client::Supervised(_, n) => n.fetch_add(1, Ordering::SeqCst),
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.request_with_id(self.next_id(), method, params).await
    }

    pub async fn request_with_id(&self, id: u64, method: &str, params: Value) -> Result<Value, RpcError> {
        match self {
            Client::InProc(c, _) => {
                // Same messages as on the wire: serialize, hand over, parse.
                let line = serde_json::to_string(&Request { id, method: method.to_string(), params }).expect("request serializes");
                let out = c.kernel.handle_line(&line).await;
                let resp: Response = serde_json::from_str(&out).map_err(|e| RpcError { code: ErrorCode::Internal, message: e.to_string() })?;
                into_result(resp)
            }
            Client::Socket(c, _) => c.send(id, method, params).await,
            Client::Supervised(s, _) => s.client().await?.send(id, method, params).await,
        }
    }

    pub fn events(&self) -> broadcast::Receiver<Event> {
        match self {
            Client::InProc(c, _) => {
                let mut rx = c.kernel.subscribe();
                let (tx, out) = broadcast::channel(256);
                tokio::spawn(async move {
                    while let Ok(ev) = rx.recv().await {
                        let line = serde_json::to_string(&ev).expect("event serializes");
                        if let Ok(ev) = serde_json::from_str::<Event>(&line) {
                            if tx.send(ev).is_err() {
                                break;
                            }
                        }
                    }
                });
                out
            }
            Client::Socket(c, _) => c.events.subscribe(),
            Client::Supervised(s, _) => s.events.subscribe(),
        }
    }
}
