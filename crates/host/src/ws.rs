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

/// Decodes `%XX` and `+` (the interface builds the address with `encodeURIComponent`).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if bytes.get(i + 1..i + 3).is_some_and(|h| h.iter().all(u8::is_ascii_hexdigit)) => {
                out.push(u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).expect("ascii"), 16).expect("hex"));
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(uri: &str, name: &str) -> Option<String> {
    let query = uri.split_once('?')?.1;
    query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| percent_decode(v))
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
    // `workspace=<id>`: a new tab for that workspace ("new window" in a browser, D403).
    let mut workspace: Option<String> = None;
    #[allow(clippy::result_large_err)] // the callback type is fixed by tungstenite
    let check = |req: &HttpRequest, resp: HttpResponse| -> Result<HttpResponse, ErrorResponse> {
        let uri = req.uri().to_string();
        if token.is_empty() || query_param(&uri, "token").as_deref() != Some(token.as_str()) {
            let mut r = ErrorResponse::new(Some("bad token".to_string()));
            *r.status_mut() = StatusCode::UNAUTHORIZED;
            return Err(r);
        }
        if let Some(c) = query_param(&uri, "client").filter(|c| !c.is_empty()) {
            // The AI namespace belongs to the MCP socket (D450).
            if c.starts_with(crate::mcp_socket::CLIENT_PREFIX) {
                let mut r = ErrorResponse::new(Some("reserved client id".to_string()));
                *r.status_mut() = StatusCode::FORBIDDEN;
                return Err(r);
            }
            client = c;
        }
        workspace = query_param(&uri, "workspace").filter(|w| !w.is_empty());
        Ok(resp)
    };
    let ws = tokio_tungstenite::accept_hdr_async(stream, check).await?;
    if let Some(id) = &workspace {
        // An unknown id leaves the tab on the default workspace; the interface then shows that one.
        let _ = host.bind_client(&client, id).await;
    }
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
    let (etx, own, pusher_host) = (tx.clone(), client.clone(), host.clone());
    let pusher = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ev) => {
                    if pusher_host.visible_to(&ev, &own) {
                        let _ = etx.send(serde_json::to_string(&ev.event).expect("event serializes"));
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
    // The tab is gone: its workspace's worker stops if nobody else uses it.
    host.unbind_client(&client).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_token_before_comparing() {
        assert_eq!(query_param("/?token=a%2Fb%20c&client=x", "token").as_deref(), Some("a/b c"));
        assert_eq!(query_param("/?token=100%", "token").as_deref(), Some("100%"));
        assert_eq!(query_param("/?client=x", "token"), None);
    }
}
