//! One connection of newline-delimited JSON requests and responses (the worker's wire format), shared by the app socket
//! and the headless worker.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use onedesk_protocol::{ProtocolError, Request, Response};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::oneshot;

use crate::backend::BackendError;

pub struct LineConn {
    write: tokio::sync::Mutex<OwnedWriteHalf>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>,
    closed: Arc<AtomicBool>,
    next: AtomicU64,
    client: String,
}

impl LineConn {
    /// `read` is consumed by a reader task; `client` goes into every request.
    pub fn new(read: OwnedReadHalf, write: OwnedWriteHalf, client: String) -> Self {
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>> = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));
        let (p, c) = (pending.clone(), closed.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                // Events (no `id`) are not for us.
                if let Ok(resp) = serde_json::from_str::<Response>(&line) {
                    if let Some(tx) = p.lock().unwrap().remove(&resp.id) {
                        let _ = tx.send(resp);
                    }
                }
            }
            let mut pending = p.lock().unwrap();
            c.store(true, Ordering::SeqCst);
            pending.clear();
        });
        LineConn { write: tokio::sync::Mutex::new(write), pending, closed, next: AtomicU64::new(1), client }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// `Err(Gone)`: the other side went away (nothing more can be sent on this connection).
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, BackendError> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if self.is_closed() {
                return Err(BackendError::Gone);
            }
            pending.insert(id, tx);
        }
        let mut line = serde_json::to_string(&Request { id, method: method.to_string(), params, client: Some(self.client.clone()), actor: None }).expect("request serializes");
        line.push('\n');
        if self.write.lock().await.write_all(line.as_bytes()).await.is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(BackendError::Gone);
        }
        // Written, then the connection ended: the other side may have run it.
        let resp = rx.await.map_err(|_| BackendError::Lost)?;
        match resp.error {
            Some(e) => Err(BackendError::Protocol(e)),
            None => Ok(resp.result.unwrap_or(Value::Null)),
        }
    }

    /// Hangs up politely (the worker finishes running requests, then exits).
    pub async fn close(&self) {
        let _ = self.write.lock().await.shutdown().await;
    }
}

pub fn protocol_error(code: onedesk_protocol::ErrorCode, detail: impl Into<String>) -> ProtocolError {
    ProtocolError { code, params: Default::default(), detail: Some(detail.into()) }
}
