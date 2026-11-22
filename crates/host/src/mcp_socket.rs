//! Local socket for `onedesk-mcp` (round 19, D415 §2): while the app is open, the command-line MCP program connects here
//! instead of starting a worker of its own. One connection = one `client` bound to one workspace; its requests go through
//! `Host::request` like a window's, but only `mcp.*` commands are let through (defence in depth: the kernel decides what
//! the AI operator may do, this door decides what may even be asked).
//!
//! Wire format (lines of JSON):
//!   client → `{ "hello": "onedesk-mcp", "protocol": "1", "workspace": "<id|name|folder>"?, "clientName": "…"? }`
//!   server → `{ "ok": true, "workspace": { "id", "name", "folder" } }` or `{ "ok": false, "error": ProtocolError }`
//!   then `Request` lines from the client and `Response` lines from the server.
//!
//! Who may connect: the socket file is mode 0600 inside the data dir and every connection's peer uid must be ours.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use onedesk_protocol::{ErrorCode, ProtocolError, Request, Response, PROTOCOL_VERSION};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use crate::{workspaces, Host};

/// Only commands with this prefix pass the door.
pub const ALLOWED_PREFIX: &str = "mcp.";
/// What the first line must say.
pub const HELLO: &str = "onedesk-mcp";
/// `client` ids of MCP connections start with this; the kernel's side of the AI operator keys on it.
pub const CLIENT_PREFIX: &str = "ai:";

/// Main-process request (not forwarded to a worker): where `onedesk-mcp` is and what to paste into Claude Desktop's config.
/// Returns `{ path: string, exists: boolean, config: string }`; `config` is the JSON text of the `mcpServers` entry.
pub const APP_MCP_INFO: &str = "app.mcpInfo";

/// `ONEDESK_MCP_BIN`, else `onedesk-mcp` next to the running executable (inside the `.app`: `Contents/MacOS`).
pub fn mcp_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("ONEDESK_MCP_BIN").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().unwrap_or_else(|| Path::new(".")).join("onedesk-mcp")
}

pub fn info() -> Value {
    let path = mcp_bin();
    let config = json!({ "mcpServers": { "onedesk": { "command": path.to_string_lossy() } } });
    json!({ "path": path.to_string_lossy(), "exists": path.is_file(), "config": serde_json::to_string_pretty(&config).expect("json") })
}

/// macOS limits socket paths to 103 bytes.
const MAX_PATH: usize = 100;

/// `<data dir>/mcp.sock`; when that is too long for a socket path, `/tmp/onedesk-<uid>-<hash>.sock`.
/// Both ends (the app and `onedesk-mcp`) call this with the same data dir.
pub fn socket_path(data_dir: &Path) -> PathBuf {
    let direct = data_dir.join("mcp.sock");
    if direct.as_os_str().len() < MAX_PATH {
        return direct;
    }
    // FNV-1a: stable across runs and builds, unlike `DefaultHasher`.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in data_dir.as_os_str().as_encoded_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    PathBuf::from(format!("/tmp/onedesk-{uid}-{h:016x}.sock"))
}

fn denied(reason: &str) -> ProtocolError {
    ProtocolError { code: ErrorCode::Denied, params: [("reason".to_string(), reason.to_string())].into(), detail: None }
}

/// Listens until the listener fails. The caller removes the socket file on exit (see `bind`).
pub async fn serve(host: Arc<Host>, listener: UnixListener) {
    static N: AtomicU64 = AtomicU64::new(1);
    loop {
        let Ok((stream, _)) = listener.accept().await else { return };
        let (host, n) = (host.clone(), N.fetch_add(1, Ordering::SeqCst));
        tokio::spawn(async move {
            let _ = connection(host, stream, n).await;
        });
    }
}

/// Binds the socket for `data_dir`, replacing a stale file (a crashed app). Refuses when another app instance answers on it.
pub fn bind(data_dir: &Path) -> std::io::Result<(UnixListener, PathBuf)> {
    use std::os::unix::fs::PermissionsExt;
    let path = socket_path(data_dir);
    if std::os::unix::net::UnixStream::connect(&path).is_ok() {
        return Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "another OneDesk answers on the MCP socket"));
    }
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok((listener, path))
}

/// The kernel's rule for AI client names: `[A-Za-z0-9._ -]`, at most 64, others become `_`, empty is `unknown`.
pub fn client_name(raw: Option<&str>) -> String {
    let cleaned: String = raw.unwrap_or("").chars().take(64).map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ' ' | '-') { c } else { '_' }).collect();
    if cleaned.is_empty() { "unknown".into() } else { cleaned }
}

/// Finds a workspace by id, name or folder.
fn resolve(host: &Host, wanted: &str) -> Result<String, ProtocolError> {
    let all = host.scanned();
    let by = |f: &dyn Fn(&str, &workspaces::InfoFile) -> bool| all.iter().find(|(folder, info)| f(folder, info)).map(|(folder, info)| workspaces::entry(folder, info, false).id);
    by(&|_, i| !i.id.is_empty() && i.id == wanted)
        .or_else(|| by(&|f, _| f == wanted))
        .or_else(|| by(&|_, i| i.name == wanted))
        .ok_or(ProtocolError { code: ErrorCode::NotFound, params: [("what".to_string(), "workspace".to_string())].into(), detail: None })
}

async fn reply(write: &mut tokio::net::unix::OwnedWriteHalf, value: Value) -> std::io::Result<()> {
    let mut line = value.to_string();
    line.push('\n');
    write.write_all(line.as_bytes()).await
}

async fn connection(host: Arc<Host>, stream: UnixStream, n: u64) -> std::io::Result<()> {
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    if stream.peer_cred()?.uid() != me {
        return Ok(());
    }
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let Some(first) = lines.next_line().await? else { return Ok(()) };
    let hello: Value = serde_json::from_str(&first).unwrap_or(Value::Null);
    let refuse = |e: ProtocolError| json!({ "ok": false, "error": e });
    if hello.get("hello").and_then(Value::as_str) != Some(HELLO) {
        return reply(&mut write, refuse(denied("notMcp"))).await;
    }
    if hello.get("protocol").and_then(Value::as_str) != Some(PROTOCOL_VERSION) {
        let e = ProtocolError { code: ErrorCode::VersionMismatch, params: [("expected".to_string(), PROTOCOL_VERSION.to_string())].into(), detail: None };
        return reply(&mut write, refuse(e)).await;
    }
    let client = format!("{CLIENT_PREFIX}mcp-{n}");
    // The door stamps the operator; nothing the peer writes can change it.
    host.mark_ai_client(&client, &client_name(hello.get("clientName").and_then(Value::as_str)));
    let entry = match hello.get("workspace").and_then(Value::as_str).filter(|w| !w.is_empty()) {
        Some(wanted) => match resolve(&host, wanted) {
            Ok(id) => host.bind_client(&client, &id).await,
            Err(e) => Err(e),
        },
        // Not named: the workspace the app opens by default (D406), starting its worker if it is not running.
        None => {
            let folder = host.client_folder(&client);
            let id = host.scanned().into_iter().find(|(f, _)| *f == folder).map(|(f, i)| workspaces::entry(&f, &i, false).id);
            match id {
                Some(id) => host.bind_client(&client, &id).await,
                None => Err(ProtocolError { code: ErrorCode::NotFound, params: [("what".to_string(), "workspace".to_string())].into(), detail: None }),
            }
        }
    };
    let entry = match entry {
        Ok(e) => e,
        Err(e) => return reply(&mut write, refuse(e)).await,
    };
    reply(&mut write, json!({ "ok": true, "workspace": entry })).await?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(mut line) = rx.recv().await {
            line.push('\n');
            if write.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(req) = serde_json::from_str::<Request>(&line) else { continue };
        let (host, tx, client) = (host.clone(), tx.clone(), client.clone());
        tokio::spawn(async move {
            let result = if req.method.starts_with(ALLOWED_PREFIX) {
                host.request(Some(&client), &req.method, req.params).await
            } else {
                Err(denied("mcpOnly"))
            };
            let resp = match result {
                Ok(result) => Response { id: req.id, result: Some(result), error: None },
                Err(error) => Response { id: req.id, result: None, error: Some(error) },
            };
            let _ = tx.send(serde_json::to_string(&resp).expect("response serializes"));
        });
    }
    writer.abort();
    host.unbind_client(&client).await;
    Ok(())
}
