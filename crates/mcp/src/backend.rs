//! Where requests go. `Auto` picks the app (socket) when it is open and a headless worker otherwise.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use onedesk_protocol::{ErrorCode, ProtocolError};
use serde_json::Value;

use crate::headless::{Headless, HeadlessConfig};
use crate::line_conn::protocol_error;
use crate::names;
use crate::socket::SocketConn;

#[derive(Debug)]
pub enum BackendError {
    /// The kernel answered with an error.
    Protocol(ProtocolError),
    /// The connection is gone and nothing was sent; a retry may use another route.
    Gone,
    /// The request was sent and the connection ended before the answer: it may have run, so it is not sent again
    /// unless it only reads.
    Lost,
    /// The workspace is locked by another worker (the app is starting, or another headless one runs).
    Locked,
    /// Could not start or reach a kernel at all.
    Unavailable(String),
}

impl BackendError {
    pub fn into_protocol(self) -> ProtocolError {
        match self {
            BackendError::Protocol(e) => e,
            BackendError::Gone | BackendError::Lost => protocol_error(ErrorCode::WorkerGone, "connection closed"),
            BackendError::Locked => protocol_error(ErrorCode::Conflict, "workspace is locked by another process"),
            BackendError::Unavailable(m) => protocol_error(ErrorCode::WorkerGone, m),
        }
    }
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait Backend: Send + Sync {
    /// Called once with the MCP client's name (from `initialize`); used for the AI operator's name and the audit.
    fn set_client_name(&self, _name: &str) {}
    fn request<'a>(&'a self, method: &'a str, params: Value) -> BoxFuture<'a, Result<Value, ProtocolError>>;
}

pub struct AutoConfig {
    pub data_dir: PathBuf,
    /// Id, name or folder; `None` = the default workspace.
    pub workspace: Option<String>,
    pub worker_bin: PathBuf,
    pub client_name: String,
    /// Where the app's built-in plugin packages are (see `onedesk_host::plugins::bundled_dir`).
    pub builtin_plugins: Option<PathBuf>,
    pub idle: Duration,
    /// How long a request keeps trying while the workspace is locked.
    pub lock_wait: Duration,
}

pub struct Auto {
    cfg: AutoConfig,
    client_name: std::sync::Mutex<String>,
    named: std::sync::atomic::AtomicBool,
    socket: tokio::sync::Mutex<Option<Arc<SocketConn>>>,
    headless: Headless,
}

impl Auto {
    pub fn new(cfg: AutoConfig) -> Self {
        let headless = Headless::new(HeadlessConfig {
            data_dir: cfg.data_dir.clone(),
            workspace: cfg.workspace.clone(),
            worker_bin: cfg.worker_bin.clone(),
            idle: cfg.idle,
            client_name: cfg.client_name.clone(),
            builtin_plugins: cfg.builtin_plugins.clone(),
        });
        Auto { client_name: std::sync::Mutex::new(cfg.client_name.clone()), named: Default::default(), cfg, socket: tokio::sync::Mutex::new(None), headless }
    }

    /// The app's connection if it is open (connecting now when needed). `Ok(None)`: the app is not open.
    async fn app(&self) -> Result<Option<Arc<SocketConn>>, ProtocolError> {
        let mut slot = self.socket.lock().await;
        if let Some(c) = slot.as_ref().filter(|c| !c.is_closed()) {
            return Ok(Some(c.clone()));
        }
        *slot = None;
        let name = self.client_name.lock().unwrap().clone();
        match SocketConn::connect(&self.cfg.data_dir, self.cfg.workspace.as_deref(), &name).await {
            Ok(Some(c)) => {
                let c = Arc::new(c);
                *slot = Some(c.clone());
                Ok(Some(c))
            }
            Ok(None) => Ok(None),
            Err(BackendError::Protocol(e)) => Err(e),
            // The socket file exists but nobody answers well (the app is starting or quitting): use the headless route.
            Err(_) => Ok(None),
        }
    }

    async fn once(&self, method: &str, params: &Value) -> Result<Value, BackendError> {
        if let Some(app) = self.app().await.map_err(BackendError::Protocol)? {
            // The app is open: any headless worker of ours has to let go of the lock (the app only starts after it).
            self.headless.release().await;
            return app.request(method, params.clone()).await;
        }
        self.headless.request(method, params.clone()).await
    }

    fn name(&self, name: &str) {
        // Only the first `initialize` names the session.
        if !self.named.swap(true, std::sync::atomic::Ordering::SeqCst) {
            *self.client_name.lock().unwrap() = name.to_string();
            self.headless.set_client_name(name);
        }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, ProtocolError> {
        let deadline = Instant::now() + self.cfg.lock_wait;
        let mut gone_retries = 0;
        loop {
            match self.once(method, &params).await {
                Ok(v) => return Ok(v),
                Err(BackendError::Protocol(e)) => return Err(e),
                Err(BackendError::Locked) if Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(300)).await,
                Err(BackendError::Gone) if gone_retries < 1 => gone_retries += 1,
                // Sent and lost: only what reads may be asked again; a tool call may have run already (D450).
                Err(BackendError::Lost) if method != names::CALL && gone_retries < 1 => gone_retries += 1,
                Err(e) => return Err(e.into_protocol()),
            }
        }
    }
}

impl Backend for Auto {
    fn set_client_name(&self, name: &str) {
        self.name(name);
    }

    fn request<'a>(&'a self, method: &'a str, params: Value) -> BoxFuture<'a, Result<Value, ProtocolError>> {
        Box::pin(self.call(method, params))
    }
}
