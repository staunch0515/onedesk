//! Line-delimited JSON (one object per line) in both shapes:
//! - `serve_connection`: a Unix socket (the worker's only peer, the main process);
//! - `InProc`: the same lines handed over in memory (tests, single-process use).
//! The first request of a connection must be `hello`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use onedesk_protocol::*;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc};

use crate::kernel::Kernel;
use crate::util::{err_p, invalid_params};

/// Per-connection state.
pub struct Session {
    kernel: Arc<Kernel>,
    greeted: AtomicBool,
}

fn response(id: u64, r: Result<Value, ProtocolError>) -> String {
    let resp = match r {
        Ok(v) => Response { id, result: Some(v), error: None },
        Err(e) => Response { id, result: None, error: Some(e) },
    };
    serde_json::to_string(&resp).expect("response serializes")
}

impl Session {
    pub fn new(kernel: Arc<Kernel>) -> Self {
        Session { kernel, greeted: AtomicBool::new(false) }
    }

    /// Parses a request line; `Err` is the response line for a request that cannot run.
    fn parse(&self, line: &str) -> Result<Request, String> {
        match serde_json::from_str::<Request>(line) {
            Ok(r) => {
                if r.method != method::HELLO && !self.greeted.load(Ordering::SeqCst) {
                    return Err(response(r.id, Err(err_p(ErrorCode::Invalid, &[("reason", "helloFirst")]))));
                }
                Ok(r)
            }
            Err(e) => {
                let id = serde_json::from_str::<Value>(line).ok().and_then(|v| v.get("id")?.as_u64()).unwrap_or(0);
                Err(response(id, Err(invalid_params(format!("bad request: {e}")))))
            }
        }
    }

    async fn run(&self, r: Request) -> String {
        let hello = r.method == method::HELLO;
        let res = self.kernel.request(r.client, &r.method, r.params).await;
        if hello && res.is_ok() {
            self.greeted.store(true, Ordering::SeqCst);
        }
        response(r.id, res)
    }

    /// One JSON line in, one JSON line out.
    pub async fn handle_line(&self, line: &str) -> String {
        match self.parse(line) {
            Ok(r) => self.run(r).await,
            Err(resp) => resp,
        }
    }
}

fn event_line(e: &EventMessage) -> String {
    serde_json::to_string(e).expect("event serializes")
}

/// Serves one connection until the peer closes it. Requests run concurrently (a slow plugin
/// does not block the others); `hello` runs inline so nothing overtakes it.
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
                    if etx.send(event_line(&ev)).is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    let session = Arc::new(Session::new(kernel));
    let mut lines = BufReader::new(read).lines();
    let mut tasks = tokio::task::JoinSet::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        match session.parse(&line) {
            Err(resp) => {
                let _ = tx.send(resp);
            }
            Ok(r) if r.method == method::HELLO => {
                let _ = tx.send(session.run(r).await);
            }
            Ok(r) => {
                let (s, tx) = (session.clone(), tx.clone());
                tasks.spawn(async move {
                    let _ = tx.send(s.run(r).await);
                });
            }
        }
        while tasks.try_join_next().is_some() {}
    }
    // Peer gone: let requests already running finish their transaction, then stop.
    while tasks.join_next().await.is_some() {}
    pusher.abort();
    drop(tx);
    let _ = writer.await;
}

/// In-process connection: the same JSON lines without a socket.
pub struct InProc {
    session: Session,
    kernel: Arc<Kernel>,
}

impl InProc {
    pub fn new(kernel: Arc<Kernel>) -> Self {
        InProc { session: Session::new(kernel.clone()), kernel }
    }

    pub async fn line(&self, line: &str) -> String {
        self.session.handle_line(line).await
    }

    /// Event lines, serialized exactly as on the socket.
    pub fn events(&self) -> mpsc::UnboundedReceiver<String> {
        let mut rx = self.kernel.subscribe();
        let (tx, out) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(e) => {
                        if tx.send(event_line(&e)).is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
        out
    }
}
