//! MCP over JSON-RPC 2.0, one message per line (the stdio transport). Implements `initialize`, `ping`, `tools/list` and
//! `tools/call`; everything else is "method not found". Tools are whatever the kernel's `mcp.tools` lists.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

use crate::backend::Backend;
use crate::names;

/// Protocol versions we can speak, newest first. A client asking for another gets the newest.
pub const SUPPORTED: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Longest line (one JSON-RPC message) read; a longer one is refused and skipped.
pub const MAX_LINE: usize = 4 * 1024 * 1024;

/// The name this session goes by in the kernel and its audit: the MCP client's own name, cleaned like the kernel does
/// (`[A-Za-z0-9._ -]`, others become `_`), cut to 40, plus a per-process suffix so two sessions of one client differ.
pub fn session_name(client: Option<&str>) -> String {
    let cleaned: String = client.unwrap_or("").chars().take(40).map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ' ' | '-') { c } else { '_' }).collect();
    let base = if cleaned.trim().is_empty() { "mcp".to_string() } else { cleaned };
    format!("{base}-{}", process_suffix())
}

/// Six hex digits from the process id and the start time; stable within the process.
pub fn process_suffix() -> String {
    static SUFFIX: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SUFFIX
        .get_or_init(|| {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
            format!("{:06x}", ((u64::from(std::process::id()) * 2_654_435_761) ^ u64::from(nanos)) & 0xff_ffff)
        })
        .clone()
}

/// One line as bytes, at most `MAX_LINE` of them. `Ok(None)`: input ended. `Err(())`: the line was longer (the rest of it
/// has been skipped).
async fn read_line<R: AsyncBufRead + Unpin>(input: &mut R, max: usize) -> std::io::Result<Option<Result<Vec<u8>, ()>>> {
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let buf = input.fill_buf().await?;
        if buf.is_empty() {
            return Ok(if line.is_empty() && !too_long { None } else { Some(if too_long { Err(()) } else { Ok(line) }) });
        }
        let (take, done) = match buf.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (buf.len(), false),
        };
        if !too_long {
            if line.len() + take > max + 1 {
                too_long = true;
                line = Vec::new();
            } else {
                line.extend_from_slice(&buf[..take]);
            }
        }
        input.consume(take);
        if done {
            if !too_long {
                line.pop();
            }
            return Ok(Some(if too_long { Err(()) } else { Ok(line) }));
        }
    }
}

/// Handles one parsed message. `None`: a notification (nothing to answer).
pub async fn handle(backend: &dyn Backend, msg: Value) -> Option<Value> {
    let Some(method) = msg.get("method").and_then(Value::as_str) else {
        // A response to something we never sent, or garbage: only garbage with an id gets an answer.
        return msg.get("id").filter(|_| msg.get("result").is_none() && msg.get("error").is_none()).map(|id| error(id.clone(), INVALID_REQUEST, "missing method"));
    };
    let id = msg.get("id").cloned();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let id = id?;
    Some(match method {
        "initialize" => {
            backend.set_client_name(&session_name(params.pointer("/clientInfo/name").and_then(Value::as_str)));
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = SUPPORTED.iter().find(|v| **v == asked).copied().unwrap_or(SUPPORTED[0]);
            ok(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "onedesk", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "Read-only access to the OneDesk resources the user has made visible to AI. Use search, then describe, then run."
                }),
            )
        }
        "ping" => ok(id, json!({})),
        "tools/list" => match backend.request(names::TOOLS, json!({})).await {
            Ok(v) => {
                let tools = if v.is_array() { v } else { v.get("tools").cloned().unwrap_or_else(|| json!([])) };
                ok(id, json!({ "tools": tools }))
            }
            // Listing is not a tool call: a failure here is the server's (policy off, workspace gone, …).
            Err(e) if e.params.get("reason").map(String::as_str) == Some("aiOff") => error(id, -32000, "AI access is turned off for this OneDesk workspace (enable it in the workspace's AI settings)."),
            Err(e) => error(id, -32000, &serde_json::to_string(&json!({ "code": e.code, "params": e.params })).unwrap_or_default()),
        },
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(error(id, INVALID_PARAMS, "tools/call needs a name"));
            };
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if !arguments.is_object() {
                return Some(error(id, INVALID_PARAMS, "arguments must be an object"));
            }
            match backend.request(names::CALL, json!({ "name": name, "arguments": arguments })).await {
                Ok(v) => ok(id, tool_result(v, false)),
                Err(e) => ok(id, tool_result(json!({ "code": e.code, "params": e.params }), true)),
            }
        }
        _ => error(id, METHOD_NOT_FOUND, "method not found"),
    })
}

/// The kernel's `{ content, truncated, rows? }` as MCP content: the content as JSON text (and as `structuredContent` when it
/// is an object), plus a note when the kernel cut it short. A failure is `isError` with `{ code, params }`.
fn tool_result(v: Value, is_error: bool) -> Value {
    if is_error {
        return json!({ "content": [{ "type": "text", "text": serde_json::to_string(&v).unwrap_or_default() }], "isError": true });
    }
    let content = v.get("content").cloned().unwrap_or(Value::Null);
    let mut blocks = vec![json!({ "type": "text", "text": serde_json::to_string(&content).unwrap_or_default() })];
    if v.get("truncated").and_then(Value::as_bool) == Some(true) {
        blocks.push(json!({ "type": "text", "text": "The result was cut short by this workspace's limits." }));
    }
    let mut out = json!({ "content": blocks, "isError": false });
    if content.is_object() {
        out["structuredContent"] = content;
    }
    out
}

/// Reads messages from `input` until it ends, answering on `output`. Calls run concurrently; answers are written whole,
/// one per line.
pub async fn serve<R, W>(backend: Arc<dyn Backend>, input: R, mut output: W)
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        while let Some(v) = rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if output.write_all(line.as_bytes()).await.is_err() || output.flush().await.is_err() {
                break;
            }
        }
    });
    let mut tasks = tokio::task::JoinSet::new();
    let mut input = input;
    while let Ok(Some(line)) = read_line(&mut input, MAX_LINE).await {
        // A line that is too long, not UTF-8 or not JSON is one bad message, not the end of the session.
        let msg: Value = match line.ok().and_then(|b| String::from_utf8(b).ok()) {
            Some(text) if text.trim().is_empty() => continue,
            Some(text) => match serde_json::from_str(&text) {
                Ok(m) => m,
                Err(_) => {
                    let _ = tx.send(error(Value::Null, PARSE_ERROR, "parse error"));
                    continue;
                }
            },
            None => {
                let _ = tx.send(error(Value::Null, PARSE_ERROR, "parse error"));
                continue;
            }
        };
        // JSON-RPC batches are not part of the MCP versions we speak.
        if msg.is_array() {
            let _ = tx.send(error(Value::Null, INVALID_REQUEST, "batches are not supported"));
            continue;
        }
        let (backend, tx) = (backend.clone(), tx.clone());
        tasks.spawn(async move {
            if let Some(answer) = handle(backend.as_ref(), msg).await {
                let _ = tx.send(answer);
            }
        });
    }
    // Input closed: let the calls in flight finish, then flush and stop.
    while tasks.join_next().await.is_some() {}
    drop(tx);
    let _ = writer.await;
}
