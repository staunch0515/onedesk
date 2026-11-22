//! The app's MCP socket (`onedesk_host::mcp_socket`).

use std::path::Path;

use onedesk_host::mcp_socket::{socket_path, HELLO};
use onedesk_protocol::{ProtocolError, PROTOCOL_VERSION};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::backend::BackendError;
use crate::line_conn::LineConn;

pub struct SocketConn {
    conn: LineConn,
}

impl SocketConn {
    /// `Ok(None)`: there is no socket (the app is not open). An app that refuses the workspace answers with its error.
    pub async fn connect(data_dir: &Path, workspace: Option<&str>, client_name: &str) -> Result<Option<SocketConn>, BackendError> {
        let path = socket_path(data_dir);
        let stream = match UnixStream::connect(&path).await {
            Ok(s) => s,
            // Not there, or a stale file nobody listens on.
            Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused) => return Ok(None),
            Err(e) => return Err(BackendError::Unavailable(format!("mcp socket: {e}"))),
        };
        // A socket file someone else planted is not the app.
        if !onedesk_host::mcp_socket::peer_is_me(&stream) {
            return Err(BackendError::Unavailable("the MCP socket is not ours".into()));
        }
        let (read, mut write) = stream.into_split();
        let hello = json!({ "hello": HELLO, "protocol": PROTOCOL_VERSION, "workspace": workspace, "clientName": client_name });
        let mut line = hello.to_string();
        line.push('\n');
        write.write_all(line.as_bytes()).await.map_err(|_| BackendError::Gone)?;
        let mut reader = BufReader::new(read);
        let mut answer = String::new();
        // The app may still be waiting for a workspace lock before it serves; give it time, not forever.
        tokio::time::timeout(std::time::Duration::from_secs(90), reader.read_line(&mut answer)).await.map_err(|_| BackendError::Unavailable("the app did not answer on the MCP socket".into()))?.map_err(|_| BackendError::Gone)?;
        let answer: Value = serde_json::from_str(&answer).map_err(|_| BackendError::Gone)?;
        if answer["ok"] != json!(true) {
            return Err(match serde_json::from_value::<ProtocolError>(answer["error"].clone()) {
                Ok(e) => BackendError::Protocol(e),
                Err(_) => BackendError::Gone,
            });
        }
        // Keep what the buffered reader may already have read: nothing is sent before our first request, so it is empty.
        let read = reader.into_inner();
        Ok(Some(SocketConn { conn: LineConn::new(read, write, format!("{}{client_name}", crate::names::CLIENT_PREFIX)) }))
    }

    pub fn is_closed(&self) -> bool {
        self.conn.is_closed()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, BackendError> {
        self.conn.request(method, params).await
    }
}
