//! Stand-in for `onedesk-worker`, used only by the host tests. Same command line and wire
//! format; answers a few fixed requests and can be told to die.
//!
//! echo → params | pid → process id | args → the command-line paths | slow → answers after 1.5 s |
//! crash → exits immediately without answering | emit → sends a `tree:t` event, then answers |
//! client → the `client` field of the request | exit-on-close: leaves with 0 when the host hangs up.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::mpsc;

fn arg(name: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned().unwrap_or_default()
}

#[tokio::main]
async fn main() {
    let (workspace, plugins, socket) = (arg("--workspace"), arg("--plugins"), arg("--socket"));
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).expect("bind");
    let (stream, _) = listener.accept().await.expect("accept");
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
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let req: Value = serde_json::from_str(&line).expect("request json");
        let id = req["id"].clone();
        let params = req["params"].clone();
        let tx = tx.clone();
        let (workspace, plugins) = (workspace.clone(), plugins.clone());
        tokio::spawn(async move {
            let ok = |result: Value| tx.send(json!({ "id": id, "result": result }).to_string()).ok();
            match req["method"].as_str().unwrap_or("") {
                "hello" => {
                    ok(json!({ "protocol": "1", "workspace": { "id": "ws-fake", "name": "Fake" } }));
                }
                "echo" => {
                    ok(params);
                }
                "pid" => {
                    ok(json!(std::process::id()));
                }
                "args" => {
                    ok(json!({ "workspace": workspace, "plugins": plugins }));
                }
                "client" => {
                    ok(req["client"].clone());
                }
                "slow" => {
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    ok(json!("slow done"));
                }
                "plugin.inspect" => {
                    // Reads the package's manifest like the real worker would; "bad" in the manifest id means refused.
                    let folder = params["folder"].as_str().unwrap_or("");
                    let manifest = std::fs::read_to_string(std::path::Path::new(folder).join("manifest.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
                    let preview = match manifest {
                        Some(m) if !m["id"].as_str().unwrap_or("").contains("bad") => json!({ "valid": true, "id": m["id"], "version": m["version"], "name": "N", "description": "D", "icon": "i", "author": "a", "permissions": [], "installed": [], "addedPermissions": [], "provides": { "kinds": [], "actions": [], "trees": [], "resultTabs": [], "other": [] } }),
                        _ => json!({ "valid": false, "problem": { "code": "invalid", "params": { "reason": "schema" } }, "id": "", "version": "", "name": "", "description": "", "icon": "", "author": "", "permissions": [], "installed": [], "addedPermissions": [], "provides": { "kinds": [], "actions": [], "trees": [], "resultTabs": [], "other": [] } }),
                    };
                    ok(preview);
                }
                "plugin.rescan" => {
                    // Leaves a note in the workspace folder so tests can count rescans and see what was on disk then.
                    let listing = std::fs::read_dir(std::path::Path::new(&plugins)).map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>().join(",")).unwrap_or_default();
                    let note = std::path::Path::new(&workspace).join("rescans.log");
                    let mut text = std::fs::read_to_string(&note).unwrap_or_default();
                    text.push_str(&format!("{listing}\n"));
                    let _ = std::fs::write(&note, text);
                    ok(Value::Null);
                }
                "crash" => std::process::exit(1),
                "emit" => {
                    let client = params["client"].as_str().map(str::to_string);
                    let mut ev = json!({ "topic": "tree:t", "payload": { "n": 1 } });
                    if let Some(c) = client {
                        ev["client"] = json!(c);
                    }
                    tx.send(ev.to_string()).ok();
                    ok(Value::Null);
                }
                other => {
                    tx.send(json!({ "id": id, "error": { "code": "unknownMethod", "params": { "method": other } } }).to_string()).ok();
                }
            }
        });
    }
    drop(tx);
    let _ = writer.await;
    let _ = std::fs::remove_file(&socket);
}
