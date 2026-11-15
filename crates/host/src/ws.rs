//! WebSocket front for `onedesk-devhost` (D266): the browser interface talks to the same
//! `Host` the desktop window uses. One WebSocket connection = one `client`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use onedesk_protocol::{Request, Response};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request as HttpRequest, Response as HttpResponse};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use crate::Host;

fn query_param(uri: &str, name: &str) -> Option<String> {
    let query = uri.split_once('?')?.1;
    query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
}

/// Accepts connections until the listener fails. A connection whose address lacks the right
/// `token` is refused with 401 before the WebSocket upgrade completes.
pub async fn serve(host: Arc<Host>, listener: TcpListener, token: String) {
    static ANON: AtomicU64 = AtomicU64::new(1);
    loop {
        let Ok((stream, _)) = listener.accept().await else { return };
        let (host, token) = (host.clone(), token.clone());
        let anon = ANON.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            let _ = connection(host, stream, token, anon).await;
        });
    }
}

async fn connection(host: Arc<Host>, stream: TcpStream, token: String, anon: u64) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut client = format!("ws-{anon}");
    #[allow(clippy::result_large_err)] // the callback type is fixed by tungstenite
    let check = |req: &HttpRequest, resp: HttpResponse| -> Result<HttpResponse, ErrorResponse> {
        let uri = req.uri().to_string();
        if query_param(&uri, "token").as_deref() != Some(token.as_str()) {
            let mut r = ErrorResponse::new(Some("bad token".to_string()));
            *r.status_mut() = StatusCode::UNAUTHORIZED;
            return Err(r);
        }
        if let Some(c) = query_param(&uri, "client").filter(|c| !c.is_empty()) {
            client = c;
        }
        Ok(resp)
    };
    let ws = tokio_tungstenite::accept_hdr_async(stream, check).await?;
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
    });
    let mut events = host.events();
    let (etx, own) = (tx.clone(), client.clone());
    let pusher = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ev) => {
                    if ev.client.as_deref().is_none_or(|c| c == own) {
                        let _ = etx.send(serde_json::to_string(&ev).expect("event serializes"));
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    while let Some(Ok(msg)) = source.next().await {
        let Message::Text(text) = msg else {
            if matches!(msg, Message::Close(_)) {
                break;
            }
            continue;
        };
        let Ok(req) = serde_json::from_str::<Request>(&text) else { continue };
        let (host, tx, client) = (host.clone(), tx.clone(), client.clone());
        tokio::spawn(async move {
            let resp = match host.request(Some(&client), &req.method, req.params).await {
                Ok(result) => Response { id: req.id, result: Some(result), error: None },
                Err(error) => Response { id: req.id, result: None, error: Some(error) },
            };
            let _ = tx.send(serde_json::to_string(&resp).expect("response serializes"));
        });
    }
    pusher.abort();
    writer.abort();
    Ok(())
}
