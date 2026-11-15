use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use onedesk_host::{ws, Host, HostConfig};
use onedesk_protocol::{ConnectionState, ErrorCode};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

fn fake_worker() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake-worker"))
}

fn write_plugin(root: &Path, id: &str, version: &str) {
    let dir = root.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), format!(r#"{{"id":"{id}","version":"{version}"}}"#)).unwrap();
    std::fs::write(dir.join("main.js"), "export default {};").unwrap();
}

async fn start(tmp: &Path) -> Arc<Host> {
    let builtin = tmp.join("builtin");
    write_plugin(&builtin, "org.test.note", "0.1.0");
    Host::start(HostConfig { data_dir: tmp.join("data"), worker_bin: fake_worker(), builtin_plugins: Some(builtin) }).await.unwrap()
}

async fn next_connection(rx: &mut tokio::sync::broadcast::Receiver<onedesk_protocol::EventMessage>) -> ConnectionState {
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("event in time").unwrap();
        if ev.topic == "connection" {
            return serde_json::from_value(ev.payload.unwrap()).unwrap();
        }
    }
}

#[tokio::test]
async fn forwards_requests_and_fills_client_and_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    assert_eq!(host.request(None, "echo", json!({ "a": 1 })).await.unwrap(), json!({ "a": 1 }));
    assert_eq!(host.request(Some("win-1"), "client", Value::Null).await.unwrap(), json!("win-1"));
    let args = host.request(None, "args", Value::Null).await.unwrap();
    assert!(args["workspace"].as_str().unwrap().ends_with("data/workspaces/default"));
    assert!(args["plugins"].as_str().unwrap().ends_with("data/plugins"));
    let unknown = host.request(None, "nope", Value::Null).await.unwrap_err();
    assert_eq!(unknown.code, ErrorCode::UnknownMethod);
    host.shutdown().await;
}

#[tokio::test]
async fn hello_is_answered_and_version_mismatch_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let ok = host.request(None, "hello", json!({ "protocol": "1" })).await.unwrap();
    assert_eq!(ok["workspace"]["id"], "ws-fake");
    let bad = host.request(None, "hello", json!({ "protocol": "99" })).await.unwrap_err();
    assert_eq!(bad.code, ErrorCode::VersionMismatch);
    host.shutdown().await;
}

#[tokio::test]
async fn builtin_plugins_are_copied_into_the_data_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let main = tmp.path().join("data/plugins/org.test.note/0.1.0/main.js");
    assert_eq!(std::fs::read_to_string(main).unwrap(), "export default {};");
    host.shutdown().await;
}

#[tokio::test]
async fn crash_gives_worker_gone_then_restarts_and_serves_the_next_request() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let mut events = host.events();
    let pid_before = host.request(None, "pid", Value::Null).await.unwrap();
    let in_flight = host.request(None, "crash", Value::Null).await.unwrap_err();
    assert_eq!(in_flight.code, ErrorCode::WorkerGone);
    assert_eq!(next_connection(&mut events).await, ConnectionState::Lost);
    // The next request waits for the new worker instead of failing.
    let pid_after = host.request(None, "pid", Value::Null).await.unwrap();
    assert_ne!(pid_before, pid_after);
    assert_eq!(next_connection(&mut events).await, ConnectionState::Restored);
    assert_eq!(host.restart_count(), 1);
    host.shutdown().await;
}

#[tokio::test]
async fn requests_in_flight_when_the_worker_dies_get_worker_gone() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let slow = {
        let host = host.clone();
        tokio::spawn(async move { host.request(None, "slow", Value::Null).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = host.request(None, "crash", Value::Null).await;
    let res = slow.await.unwrap().unwrap_err();
    assert_eq!(res.code, ErrorCode::WorkerGone);
    assert_eq!(host.request(None, "echo", json!(1)).await.unwrap(), json!(1));
    host.shutdown().await;
}

#[tokio::test]
async fn worker_events_are_broadcast() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let mut events = host.events();
    host.request(None, "emit", Value::Null).await.unwrap();
    let ev = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap().unwrap();
    assert_eq!(ev.topic, "tree:t");
    host.shutdown().await;
}

#[tokio::test]
async fn start_fails_when_the_worker_cannot_run() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = HostConfig { data_dir: tmp.path().join("data"), worker_bin: tmp.path().join("missing-worker"), builtin_plugins: None };
    assert!(Host::start(cfg).await.is_err());
}

async fn ws_server(host: Arc<Host>, token: &str) -> u16 {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(ws::serve(host, listener, token.to_string()));
    port
}

#[tokio::test]
async fn websocket_rejects_wrong_or_missing_token() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let port = ws_server(host.clone(), "secret").await;
    assert!(tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token=wrong")).await.is_err());
    assert!(tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/")).await.is_err());
    host.shutdown().await;
}

#[tokio::test]
async fn websocket_round_trip_uses_the_client_parameter_and_filters_events() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let port = ws_server(host.clone(), "secret").await;
    let (mut a, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token=secret&client=tab-a")).await.unwrap();
    let (mut b, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token=secret&client=tab-b")).await.unwrap();
    a.send(Message::text(json!({ "id": 7, "method": "client" }).to_string())).await.unwrap();
    let reply: Value = serde_json::from_str(a.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(reply, json!({ "id": 7, "result": "tab-a" }));
    // An event addressed to tab-b reaches b only.
    a.send(Message::text(json!({ "id": 8, "method": "emit", "params": { "client": "tab-b" } }).to_string())).await.unwrap();
    let got: Value = serde_json::from_str(b.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(got["topic"], "tree:t");
    let next: Value = serde_json::from_str(a.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(next["id"], 8, "a got its answer, not b's event");
    host.shutdown().await;
}
