//! Stand-in for `onedesk-worker` in the `onedesk-mcp` tests: same command line and wire format. Exits 3 while a file
//! `locked` is in the workspace folder (the workspace lock); answers `hello`, `mcp.tools`, `mcp.call` and `echo`.

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

fn arg(name: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned().unwrap_or_default()
}

#[tokio::main]
async fn main() {
    let (workspace, socket, ai_client) = (arg("--workspace"), arg("--socket"), arg("--ai-client"));
    let args: Vec<String> = std::env::args().collect();
    let builtin: Vec<String> = args.iter().enumerate().filter(|(_, a)| *a == "--builtin").filter_map(|(i, _)| args.get(i + 1).cloned()).collect();
    if std::path::Path::new(&workspace).join("locked").exists() {
        std::process::exit(3);
    }
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).expect("bind");
    let (stream, _) = listener.accept().await.expect("accept");
    let (read, mut write) = stream.into_split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(mut line) = rx.recv().await {
            line.push('\n');
            if write.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let req: Value = serde_json::from_str(&line).expect("request json");
        let id = req["id"].clone();
        let params = req["params"].clone();
        let answer = match req["method"].as_str().unwrap_or("") {
            "hello" => json!({ "id": id, "result": { "protocol": "1", "workspace": { "id": "ws-fake", "name": "Fake" } } }),
            "mcp.tools" => json!({ "id": id, "result": [{ "name": "search", "description": "d", "inputSchema": { "type": "object" } }] }),
            "mcp.call" if params["name"] == "boom" => json!({ "id": id, "error": { "code": "denied", "params": { "reason": "aiRateLimit" } } }),
            "mcp.call" if params["name"] == "die" => {
                // Counts the call, then goes away without answering.
                let log = std::path::Path::new(&workspace).join("die.log");
                let mut t = std::fs::read_to_string(&log).unwrap_or_default();
                t.push_str("die\n");
                let _ = std::fs::write(&log, t);
                std::process::exit(1);
            }
            "mcp.call" => json!({ "id": id, "result": { "content": { "builtin": builtin, "pid": std::process::id(), "aiClient": ai_client, "actor": req["actor"], "client": req["client"], "workspace": workspace, "echo": params }, "truncated": params["name"] == "cut" } }),
            "echo" => json!({ "id": id, "result": params }),
            other => json!({ "id": id, "error": { "code": "unknownMethod", "params": { "method": other } } }),
        };
        tx.send(answer.to_string()).ok();
    }
    drop(tx);
    let _ = writer.await;
    let _ = std::fs::remove_file(&socket);
}
