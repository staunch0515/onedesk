//! Line-delimited JSON (one object per line) in both shapes:
//! - `serve_connection`: a Unix socket (the worker's only peer, the main process);
//! - `InProc`: the same lines handed over in memory (tests, single-process use).
//!
//! The first request of a connection must be `hello`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use onedesk_protocol::*;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
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
        let res = self.kernel.request_as(r.actor.as_deref(), r.client, &r.method, r.params).await;
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

/// D295: the longest request line accepted.
pub const MAX_LINE: usize = 32 * 1024 * 1024;

fn too_long() -> String {
    response(0, Err(crate::util::err_p(ErrorCode::InvalidParams, &[("reason", "tooLarge")])))
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
    let mut reader = BufReader::new(read);
    let mut tasks = tokio::task::JoinSet::new();
    let mut buf = Vec::new();
    loop {
        // D295: one line is at most 32 MB; a longer one is answered and skipped, not buffered.
        buf.clear();
        match (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if buf.len() > MAX_LINE && buf.last() != Some(&b'\n') {
            let _ = tx.send(too_long());
            let mut rest = Vec::new();
            loop {
                rest.clear();
                match (&mut reader).take(1 << 20).read_until(b'\n', &mut rest).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) if rest.last() == Some(&b'\n') => break,
                    Ok(_) => {}
                }
            }
            continue;
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            let _ = tx.send(response(0, Err(invalid_params("not UTF-8"))));
            continue;
        };
        let line = line.trim_end_matches(['\n', '\r']).to_string();
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
        if line.len() > MAX_LINE {
            return too_long();
        }
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
