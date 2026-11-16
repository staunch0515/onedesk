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

/// Every value of a repeatable option such as `--builtin`.
fn args_of(name: &str) -> Vec<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().enumerate().filter(|(_, a)| *a == name).filter_map(|(i, _)| args.get(i + 1).cloned()).collect()
}

#[tokio::main]
async fn main() {
    let (workspace, plugins, socket) = (arg("--workspace"), arg("--plugins"), arg("--socket"));
    let builtin = args_of("--builtin");
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
        let (workspace, plugins, builtin) = (workspace.clone(), plugins.clone(), builtin.clone());
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
                    ok(json!({ "workspace": workspace, "plugins": plugins, "builtin": builtin }));
                }
                "client" => {
                    ok(req["client"].clone());
                }
                "slow" => {
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    ok(json!("slow done"));
                }
                "plugin.inspect" => {
                    // Reads the package like the real worker would; "bad" in the id means refused. The fingerprint
                    // follows main.js, so changing the package changes it. A marker file makes COPIES in plugins/.tmp
                    // look different (a package that changed on its way).
                    let folder = params["folder"].as_str().unwrap_or("");
                    let dir = std::path::Path::new(folder);
                    let manifest = std::fs::read_to_string(dir.join("manifest.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
                    let mut fingerprint = format!("fp:{}", std::fs::read_to_string(dir.join("main.js")).unwrap_or_default());
                    if folder.contains("/.tmp/") && std::path::Path::new(&workspace).join("copy-differs").exists() {
                        fingerprint = "tampered".into();
                    }
                    let preview = match manifest {
                        Some(m) if !m["id"].as_str().unwrap_or("").contains("bad") => json!({ "valid": true, "id": m["id"], "version": m["version"], "fingerprint": fingerprint, "name": "N", "description": "D", "icon": "i", "author": "a", "permissions": [], "installed": [], "addedPermissions": [], "provides": { "kinds": [], "actions": [], "trees": [], "resultTabs": [], "other": [] } }),
                        _ => json!({ "valid": false, "problem": { "code": "invalid", "params": { "reason": "schema" } }, "id": "", "version": "", "fingerprint": "", "name": "", "description": "", "icon": "", "author": "", "permissions": [], "installed": [], "addedPermissions": [], "provides": { "kinds": [], "actions": [], "trees": [], "resultTabs": [], "other": [] } }),
                    };
                    ok(preview);
                }
                "plugin.rescan" | "plugin.confirmPermissions" | "plugin.checkRemove" => {
                    // One ordered log of what the main process asked, and what was on disk at that moment.
                    let listing = std::fs::read_dir(std::path::Path::new(&plugins)).map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>().join(",")).unwrap_or_default();
                    let method = req["method"].as_str().unwrap_or("");
                    let note = std::path::Path::new(&workspace).join("calls.log");
                    let mut text = std::fs::read_to_string(&note).unwrap_or_default();
                    text.push_str(&format!("{method} {params} | {listing}\n"));
                    let _ = std::fs::write(&note, text);
                    if method == "plugin.rescan" && std::path::Path::new(&workspace).join("rescan-fails").exists() {
                        tx.send(json!({ "id": id, "error": { "code": "pluginError", "params": { "reason": "migrateFailed" } } }).to_string()).ok();
                        return;
                    }
                    if method == "plugin.checkRemove" && std::path::Path::new(&workspace).join("remove-refused").exists() {
                        tx.send(json!({ "id": id, "error": { "code": "conflict", "params": { "reason": "dependents", "plugins": "org.test.beta" } } }).to_string()).ok();
                        return;
                    }
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
