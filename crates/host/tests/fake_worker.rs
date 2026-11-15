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
