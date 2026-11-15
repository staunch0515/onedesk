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
    write_plugin(&builtin, "org.test.alpha", "0.1.0");
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
    let main = tmp.path().join("data/plugins/org.test.alpha/0.1.0/main.js");
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

#[tokio::test]
async fn websocket_accepts_a_url_encoded_token_and_refuses_an_empty_one() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let port = ws_server(host.clone(), "a/b c").await;
    assert!(tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token=a%2Fb%20c")).await.is_ok());
    let open = ws_server(host.clone(), "").await;
    assert!(tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{open}/?token=")).await.is_err());
    assert!(tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{open}/")).await.is_err());
    host.shutdown().await;
}

#[test]
fn devhost_refuses_to_start_without_a_token() {
    let tmp = tempfile::tempdir().unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_onedesk-devhost"))
        .args(["--data-dir", tmp.path().to_str().unwrap(), "--port", "0", "--token", ""])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("token"));
}

fn package(dir: &Path, id: &str, version: &str) {
    std::fs::create_dir_all(dir.join("locales")).unwrap();
    std::fs::write(dir.join("manifest.json"), format!(r#"{{"id":"{id}","version":"{version}"}}"#)).unwrap();
    std::fs::write(dir.join("main.js"), "export default {};").unwrap();
    std::fs::write(dir.join("locales/en-US.json"), "{}").unwrap();
}

fn rescans(tmp: &Path) -> usize {
    std::fs::read_to_string(tmp.join("data/workspaces/default/rescans.log")).map(|t| t.lines().count()).unwrap_or(0)
}

fn reason(e: &onedesk_protocol::ProtocolError) -> String {
    e.params.get("reason").cloned().unwrap_or_default()
}

#[tokio::test]
async fn inspect_is_passed_to_the_worker_and_copies_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let pkg = tmp.path().join("pkg");
    package(&pkg, "org.test.beta", "1.0.0");
    let preview = host.request(None, "app.inspectPlugin", json!({ "folder": pkg })).await.unwrap();
    assert_eq!(preview["valid"], true);
    assert_eq!(preview["version"], "1.0.0");
    assert!(!tmp.path().join("data/plugins/org.test.beta").exists());
    assert_eq!(rescans(tmp.path()), 0);
    host.shutdown().await;
}

#[tokio::test]
async fn install_copies_into_plugins_then_asks_the_worker_to_rescan() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let pkg = tmp.path().join("pkg");
    package(&pkg, "org.test.beta", "1.0.0");
    let done = host.request(None, "app.installPlugin", json!({ "folder": pkg })).await.unwrap();
    assert_eq!(done, json!({ "plugin": "org.test.beta", "version": "1.0.0" }));
    let dest = tmp.path().join("data/plugins/org.test.beta/1.0.0");
    assert_eq!(std::fs::read_to_string(dest.join("main.js")).unwrap(), "export default {};");
    assert!(dest.join("locales/en-US.json").is_file());
    // No temporary folder is left, and the rescan came after the files were in place.
    let leftovers: Vec<_> = std::fs::read_dir(tmp.path().join("data/plugins/org.test.beta")).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(leftovers, vec!["1.0.0"]);
    assert_eq!(rescans(tmp.path()), 1);
    assert!(std::fs::read_to_string(tmp.path().join("data/workspaces/default/rescans.log")).unwrap().contains("org.test.beta"));
    host.shutdown().await;
}

#[tokio::test]
async fn install_refuses_an_existing_version_and_invalid_or_unsafe_packages() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let pkg = tmp.path().join("pkg");
    package(&pkg, "org.test.beta", "1.0.0");
    host.request(None, "app.installPlugin", json!({ "folder": pkg })).await.unwrap();
    // Same id and version again.
    let again = host.request(None, "app.installPlugin", json!({ "folder": pkg })).await.unwrap_err();
    assert_eq!((again.code, reason(&again).as_str()), (ErrorCode::Invalid, "alreadyInstalled"));
    // The worker's checks decide validity: nothing is copied for a refused manifest.
    let bad = tmp.path().join("bad");
    package(&bad, "org.test.bad", "1.0.0");
    let refused = host.request(None, "app.installPlugin", json!({ "folder": bad })).await.unwrap_err();
    assert_eq!(reason(&refused), "notValid");
    assert!(!tmp.path().join("data/plugins/org.test.bad").exists());
    // Not a folder / relative / missing manifest / link out of the package.
    let file = tmp.path().join("file.txt");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(reason(&host.request(None, "app.installPlugin", json!({ "folder": file })).await.unwrap_err()), "notFolder");
    assert_eq!(reason(&host.request(None, "app.installPlugin", json!({ "folder": "relative" })).await.unwrap_err()), "notAbsolute");
    let empty = tmp.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(reason(&host.request(None, "app.installPlugin", json!({ "folder": empty })).await.unwrap_err()), "noManifest");
    let linked = tmp.path().join("linked");
    package(&linked, "org.test.gamma", "1.0.0");
    let secret = tmp.path().join("secret.txt");
    std::fs::write(&secret, "s").unwrap();
    std::os::unix::fs::symlink(&secret, linked.join("leak.txt")).unwrap();
    assert_eq!(reason(&host.request(None, "app.installPlugin", json!({ "folder": linked })).await.unwrap_err()), "symlinkOutside");
    assert!(!tmp.path().join("data/plugins/org.test.gamma").exists());
    host.shutdown().await;
}

#[tokio::test]
async fn remove_moves_the_version_aside_rescans_and_is_not_put_back_at_the_next_start() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let builtin = tmp.path().join("data/plugins/org.test.alpha/0.1.0");
    assert!(builtin.is_dir());
    host.request(None, "app.removePlugin", json!({ "plugin": "org.test.alpha", "version": "0.1.0" })).await.unwrap();
    assert!(!builtin.exists());
    let moved: Vec<_> = std::fs::read_dir(tmp.path().join("data/plugins/.removed")).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(moved.len(), 1);
    assert!(moved[0].starts_with("org.test.alpha-0.1.0-"));
    assert_eq!(rescans(tmp.path()), 1);
    let missing = host.request(None, "app.removePlugin", json!({ "plugin": "org.test.alpha", "version": "0.1.0" })).await.unwrap_err();
    assert_eq!(missing.code, ErrorCode::NotFound);
    let unsafe_name = host.request(None, "app.removePlugin", json!({ "plugin": "..", "version": "0.1.0" })).await.unwrap_err();
    assert_eq!(unsafe_name.code, ErrorCode::Invalid);
    host.shutdown().await;
    // Next start: the built-in copy of that version stays removed.
    let host = start(tmp.path()).await;
    assert!(!builtin.exists());
    host.shutdown().await;
}

#[tokio::test]
async fn install_succeeds_with_a_warning_when_the_rescan_reports_a_failed_switch() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    std::fs::write(tmp.path().join("data/workspaces/default/rescan-fails"), "").unwrap();
    let pkg = tmp.path().join("pkg");
    package(&pkg, "org.test.beta", "1.0.0");
    let done = host.request(None, "app.installPlugin", json!({ "folder": pkg })).await.unwrap();
    assert_eq!(done["plugin"], "org.test.beta");
    assert_eq!(done["warning"]["code"], "pluginError");
    assert_eq!(done["warning"]["params"]["reason"], "migrateFailed");
    assert!(tmp.path().join("data/plugins/org.test.beta/1.0.0/main.js").is_file());
    host.shutdown().await;
}
