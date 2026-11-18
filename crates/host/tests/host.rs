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
    Host::start(HostConfig { data_dir: tmp.join("data"), worker_bin: fake_worker(), builtin_plugins: Some(builtin), secrets: Some(onedesk_kernel::secrets::SecretStoreHandle::memory().0) }).await.unwrap()
}

async fn next_connection(rx: &mut tokio::sync::broadcast::Receiver<onedesk_host::HostEvent>) -> ConnectionState {
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("event in time").unwrap();
        if ev.topic == "connection" {
            return serde_json::from_value(ev.payload.clone().unwrap()).unwrap();
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
    let cfg = HostConfig { data_dir: tmp.path().join("data"), worker_bin: tmp.path().join("missing-worker"), builtin_plugins: None, secrets: Some(onedesk_kernel::secrets::SecretStoreHandle::memory().0) };
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

/// What the fake worker was asked, in order: `plugin.rescan {...} | <plugins folder listing>`, `plugin.confirmPermissions {...} | …`.
fn calls(tmp: &Path) -> Vec<String> {
    std::fs::read_to_string(tmp.join("data/workspaces/default/calls.log")).map(|t| t.lines().map(str::to_string).collect()).unwrap_or_default()
}

fn rescans(tmp: &Path) -> usize {
    calls(tmp).iter().filter(|l| l.starts_with("plugin.rescan")).count()
}

fn reason(e: &onedesk_protocol::ProtocolError) -> String {
    e.params.get("reason").cloned().unwrap_or_default()
}

/// What the interface sends after the user confirmed an inspected package.
async fn confirmed(host: &Host, pkg: &Path) -> Value {
    let preview = host.request(None, "app.inspectPlugin", json!({ "folder": pkg })).await.unwrap();
    json!({ "folder": pkg, "id": preview["id"], "version": preview["version"], "fingerprint": preview["fingerprint"] })
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
async fn install_checks_the_copy_then_rescans_with_the_builtin_list_then_confirms_that_fingerprint() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let pkg = tmp.path().join("pkg");
    package(&pkg, "org.test.beta", "1.0.0");
    let wanted = confirmed(&host, &pkg).await;
    let done = host.request(None, "app.installPlugin", wanted.clone()).await.unwrap();
    assert_eq!(done, json!({ "plugin": "org.test.beta", "version": "1.0.0" }));
    let dest = tmp.path().join("data/plugins/org.test.beta/1.0.0");
    assert_eq!(std::fs::read_to_string(dest.join("main.js")).unwrap(), "export default {};");
    assert!(dest.join("locales/en-US.json").is_file());
    // Temporary copies live in plugins/.tmp and are gone; no stray folder next to the version.
    let beside: Vec<_> = std::fs::read_dir(tmp.path().join("data/plugins/org.test.beta")).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(beside, vec!["1.0.0"]);
    assert_eq!(std::fs::read_dir(tmp.path().join("data/plugins/.tmp")).map(|rd| rd.count()).unwrap_or(0), 0);
    // Order and content: rescan (with the built-in list, files already in place), then confirm with the fingerprint.
    let log = calls(tmp.path());
    assert_eq!(log.len(), 2, "{log:?}");
    assert!(log[0].starts_with("plugin.rescan") && log[0].contains("org.test.alpha@0.1.0") && log[0].contains("org.test.beta"));
    assert!(log[1].starts_with("plugin.confirmPermissions") && log[1].contains(wanted["fingerprint"].as_str().unwrap()) && log[1].contains("\"version\":\"1.0.0\""));
    host.shutdown().await;
}

#[tokio::test]
async fn install_refuses_when_what_was_confirmed_is_not_what_is_there() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let pkg = tmp.path().join("pkg");
    package(&pkg, "org.test.beta", "1.0.0");
    // The package changed after the user looked at it.
    let mut wanted = confirmed(&host, &pkg).await;
    std::fs::write(pkg.join("main.js"), "export default { evil: true };").unwrap();
    let stale = host.request(None, "app.installPlugin", wanted.clone()).await.unwrap_err();
    assert_eq!(reason(&stale), "changedSinceInspect");
    // A different id or version than the one confirmed.
    wanted = confirmed(&host, &pkg).await;
    let mut other = wanted.clone();
    other["version"] = json!("9.9.9");
    assert_eq!(reason(&host.request(None, "app.installPlugin", other).await.unwrap_err()), "changedSinceInspect");
    assert!(!tmp.path().join("data/plugins/org.test.beta").exists());
    assert_eq!(rescans(tmp.path()), 0);
    host.shutdown().await;
}

#[tokio::test]
async fn a_copy_that_differs_from_what_was_inspected_is_deleted_and_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let pkg = tmp.path().join("pkg");
    package(&pkg, "org.test.beta", "1.0.0");
    let wanted = confirmed(&host, &pkg).await;
    std::fs::write(tmp.path().join("data/workspaces/default/copy-differs"), "").unwrap();
    let refused = host.request(None, "app.installPlugin", wanted).await.unwrap_err();
    assert_eq!(reason(&refused), "changedSinceInspect");
    assert!(!tmp.path().join("data/plugins/org.test.beta").exists());
    assert_eq!(std::fs::read_dir(tmp.path().join("data/plugins/.tmp")).map(|rd| rd.count()).unwrap_or(0), 0, "the refused copy is deleted");
    assert_eq!(rescans(tmp.path()), 0, "nothing is rescanned or confirmed");
    host.shutdown().await;
}

#[tokio::test]
async fn install_refuses_an_existing_version_invalid_packages_and_any_link() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let pkg = tmp.path().join("pkg");
    package(&pkg, "org.test.beta", "1.0.0");
    let wanted = confirmed(&host, &pkg).await;
    host.request(None, "app.installPlugin", wanted.clone()).await.unwrap();
    let again = host.request(None, "app.installPlugin", wanted).await.unwrap_err();
    assert_eq!((again.code, reason(&again).as_str()), (ErrorCode::Invalid, "alreadyInstalled"));
    // The worker's checks decide validity: nothing is copied for a refused manifest.
    let bad = tmp.path().join("bad");
    package(&bad, "org.test.bad", "1.0.0");
    let refused = host.request(None, "app.installPlugin", json!({ "folder": bad, "id": "org.test.bad", "version": "1.0.0", "fingerprint": "x" })).await.unwrap_err();
    assert_eq!(reason(&refused), "notValid");
    assert!(!tmp.path().join("data/plugins/org.test.bad").exists());
    let ask = |folder: &Path| json!({ "folder": folder, "id": "org.test.gamma", "version": "1.0.0", "fingerprint": "x" });
    let file = tmp.path().join("file.txt");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(reason(&host.request(None, "app.installPlugin", ask(&file)).await.unwrap_err()), "notFolder");
    assert_eq!(reason(&host.request(None, "app.installPlugin", json!({ "folder": "relative", "id": "a", "version": "1", "fingerprint": "x" })).await.unwrap_err()), "notAbsolute");
    let empty = tmp.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(reason(&host.request(None, "app.installPlugin", ask(&empty)).await.unwrap_err()), "noManifest");
    // Any link at all, even one that stays inside the package.
    let linked = tmp.path().join("linked");
    package(&linked, "org.test.gamma", "1.0.0");
    std::os::unix::fs::symlink(linked.join("main.js"), linked.join("alias.js")).unwrap();
    assert_eq!(reason(&host.request(None, "app.installPlugin", ask(&linked)).await.unwrap_err()), "symlink");
    assert!(!tmp.path().join("data/plugins/org.test.gamma").exists());
    host.shutdown().await;
}

#[tokio::test]
async fn the_worker_is_started_with_the_builtin_plugins_the_host_copied() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let args = host.request(None, "args", Value::Null).await.unwrap();
    assert_eq!(args["builtin"], json!(["org.test.alpha@0.1.0"]));
    // After the worker restarts it still gets the list.
    let _ = host.request(None, "crash", Value::Null).await;
    let again = host.request(None, "args", Value::Null).await.unwrap();
    assert_eq!(again["builtin"], json!(["org.test.alpha@0.1.0"]));
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
    let moved: Vec<_> = std::fs::read_dir(tmp.path().join("data/plugins/.removed/org.test.alpha")).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(moved.len(), 1);
    assert!(moved[0].starts_with("0.1.0-"));
    // The rescan no longer lists the removed version as the host's own.
    let log = calls(tmp.path());
    // The kernel is asked first; the files move only after it agrees.
    assert_eq!(log.len(), 2);
    assert!(log[0].starts_with("plugin.checkRemove") && log[0].contains("org.test.alpha"));
    assert!(log[1].starts_with("plugin.rescan") && !log[1].contains("org.test.alpha@0.1.0"));
    let missing = host.request(None, "app.removePlugin", json!({ "plugin": "org.test.alpha", "version": "0.1.0" })).await.unwrap_err();
    assert_eq!(missing.code, ErrorCode::NotFound);
    let unsafe_name = host.request(None, "app.removePlugin", json!({ "plugin": "..", "version": "0.1.0" })).await.unwrap_err();
    assert_eq!(unsafe_name.code, ErrorCode::Invalid);
    host.shutdown().await;
    // Next start: the built-in copy of that version stays removed and is not in the built-in list.
    let host = start(tmp.path()).await;
    assert!(!builtin.exists());
    assert_eq!(host.request(None, "args", Value::Null).await.unwrap()["builtin"], json!([]));
    host.shutdown().await;
}

#[tokio::test]
async fn remove_is_refused_untouched_when_the_kernel_says_dependents() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let version = tmp.path().join("data/plugins/org.test.alpha/0.1.0");
    std::fs::write(tmp.path().join("data/workspaces/default/remove-refused"), "").unwrap();
    let refused = host.request(None, "app.removePlugin", json!({ "plugin": "org.test.alpha", "version": "0.1.0" })).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Conflict);
    assert_eq!(reason(&refused), "dependents");
    assert_eq!(refused.params.get("plugins").map(String::as_str), Some("org.test.beta"));
    assert!(version.is_dir(), "nothing was moved");
    assert_eq!(rescans(tmp.path()), 0);
    host.shutdown().await;
}

#[tokio::test]
async fn install_succeeds_with_a_warning_when_the_rescan_reports_a_failed_switch() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    std::fs::write(tmp.path().join("data/workspaces/default/rescan-fails"), "").unwrap();
    let pkg = tmp.path().join("pkg");
    package(&pkg, "org.test.beta", "1.0.0");
    let wanted = confirmed(&host, &pkg).await;
    let done = host.request(None, "app.installPlugin", wanted).await.unwrap();
    assert_eq!(done["plugin"], "org.test.beta");
    assert_eq!(done["warning"]["code"], "pluginError");
    assert_eq!(done["warning"]["params"]["reason"], "migrateFailed");
    assert!(tmp.path().join("data/plugins/org.test.beta/1.0.0/main.js").is_file());
    // The user's confirmation is still recorded.
    assert!(calls(tmp.path()).iter().any(|l| l.starts_with("plugin.confirmPermissions")));
    host.shutdown().await;
}

#[tokio::test]
async fn a_client_rescan_refreshes_the_index_first_and_carries_the_builtin_list() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let index = tmp.path().join("data/plugins/.index");
    let dirs = |p: &Path| -> Vec<String> { serde_json::from_str::<Value>(&std::fs::read_to_string(p).unwrap()).unwrap()["entries"].as_array().unwrap().iter().map(|e| e["dir"].as_str().unwrap().to_string()).collect() };
    assert_eq!(dirs(&index), ["org.test.alpha/0.1.0"]);
    // A package copied in by hand, then the client asks for a rescan (its own params say nothing about built-ins).
    let hand = tmp.path().join("data/plugins/org.test.hand/0.5.0");
    std::fs::create_dir_all(&hand).unwrap();
    std::fs::write(hand.join("manifest.json"), r#"{"id":"org.test.hand","version":"0.5.0"}"#).unwrap();
    host.request(Some("win-1"), "plugin.rescan", json!({ "builtin": ["evil@9"] })).await.unwrap();
    assert_eq!(dirs(&index), ["org.test.alpha/0.1.0", "org.test.hand/0.5.0"]);
    let log = calls(tmp.path());
    let last = log.iter().rev().find(|l| l.starts_with("plugin.rescan")).unwrap();
    assert!(last.contains("org.test.alpha@0.1.0") && !last.contains("evil"), "{last}");
    host.shutdown().await;
}

/* ---------------------------------------------------------------- workspaces (round 13) */

fn memory_store() -> (onedesk_kernel::secrets::SecretStoreHandle, Arc<onedesk_kernel::secrets::MemoryStore>) {
    onedesk_kernel::secrets::SecretStoreHandle::memory()
}

async fn start_with(tmp: &Path, secrets: onedesk_kernel::secrets::SecretStoreHandle) -> Arc<Host> {
    Host::start(HostConfig { data_dir: tmp.join("data"), worker_bin: fake_worker(), builtin_plugins: None, secrets: Some(secrets) }).await.unwrap()
}

async fn list(host: &Host, client: &str) -> Vec<Value> {
    host.request(Some(client), "app.workspaces", Value::Null).await.unwrap()["items"].as_array().unwrap().clone()
}

async fn next_topic(rx: &mut tokio::sync::broadcast::Receiver<onedesk_host::HostEvent>, topic: &str) {
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("event in time").unwrap();
        if ev.topic == topic {
            return;
        }
    }
}

#[tokio::test]
async fn a_fresh_data_dir_has_one_default_workspace_that_is_current() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let items = list(&host, "w").await;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["folder"], "default");
    assert_eq!(items[0]["name"], "Default");
    assert_eq!(items[0]["current"], true);
    assert!(items[0]["id"].as_str().unwrap().len() >= 16);
    assert!(items[0]["lastOpened"].as_i64().unwrap() > 0, "opening it was recorded");
    host.shutdown().await;
}

#[tokio::test]
async fn create_makes_a_folder_with_the_current_settings_and_does_not_switch() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let mut events = host.events();
    let made = host.request(Some("w"), "app.createWorkspace", json!({ "name": "  Team Notes " })).await.unwrap();
    assert_eq!(made["name"], "Team Notes");
    assert_eq!(made["folder"], "team-notes");
    assert_eq!(made["current"], false);
    next_topic(&mut events, "app.workspacesChanged").await;
    let dir = tmp.path().join("data/workspaces/team-notes");
    let info: Value = serde_json::from_slice(&std::fs::read(dir.join("workspace.json")).unwrap()).unwrap();
    assert_eq!((info["id"].clone(), info["name"].clone()), (made["id"].clone(), json!("Team Notes")));
    let init: Value = serde_json::from_slice(&std::fs::read(dir.join("init-settings.json")).unwrap()).unwrap();
    assert_eq!(init, json!({ "from": "default", "client": null }), "from the workspace the client uses, asked as the main process (no client)");
    assert_eq!(host.running_workspaces(), ["default"], "no worker was started for it");
    // The same name again gets another folder.
    let again = host.request(Some("w"), "app.createWorkspace", json!({ "name": "Team Notes" })).await.unwrap();
    assert_eq!(again["folder"], "team-notes-2");
    // Names are 1 to 100 characters.
    for bad in ["", "   ", &"x".repeat(101)] {
        let e = host.request(Some("w"), "app.createWorkspace", json!({ "name": bad })).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidParams);
    }
    assert_eq!(list(&host, "w").await.len(), 3);
    host.shutdown().await;
}

#[tokio::test]
async fn switch_binds_only_this_connection_and_stops_a_worker_nobody_uses() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let team = host.request(Some("a"), "app.createWorkspace", json!({ "name": "team" })).await.unwrap();
    // Connection b is explicitly on the default workspace.
    let default_id = list(&host, "b").await[0]["id"].clone();
    host.request(Some("b"), "app.switchWorkspace", json!({ "id": default_id })).await.unwrap();
    let switched = host.request(Some("a"), "app.switchWorkspace", json!({ "id": team["id"] })).await.unwrap();
    assert_eq!(switched["folder"], "team");
    assert_eq!(switched["current"], true);
    assert!(host.request(Some("a"), "args", Value::Null).await.unwrap()["workspace"].as_str().unwrap().ends_with("data/workspaces/team"));
    assert!(host.request(Some("b"), "args", Value::Null).await.unwrap()["workspace"].as_str().unwrap().ends_with("data/workspaces/default"));
    let current = |items: &[Value]| items.iter().filter(|i| i["current"] == true).map(|i| i["folder"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(current(&list(&host, "a").await), ["team"]);
    assert_eq!(current(&list(&host, "b").await), ["default"]);
    assert_eq!(host.running_workspaces(), ["default", "team"], "b still uses default");
    // The newest `lastOpened` comes first.
    assert_eq!(list(&host, "a").await[0]["folder"], "team");
    // Now b leaves too: the default worker stops, nobody uses it.
    host.request(Some("b"), "app.switchWorkspace", json!({ "id": team["id"] })).await.unwrap();
    assert_eq!(host.running_workspaces(), ["team"]);
    // And can come back (the lock was released).
    host.request(Some("b"), "app.switchWorkspace", json!({ "id": default_id })).await.unwrap();
    assert_eq!(host.running_workspaces(), ["default", "team"]);
    let unknown = host.request(Some("b"), "app.switchWorkspace", json!({ "id": "nope" })).await.unwrap_err();
    assert_eq!(unknown.code, ErrorCode::NotFound);
    host.shutdown().await;
}

#[tokio::test]
async fn events_reach_only_the_connections_using_that_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let team = host.request(Some("a"), "app.createWorkspace", json!({ "name": "team" })).await.unwrap();
    let default_id = list(&host, "b").await[0]["id"].clone();
    host.request(Some("b"), "app.switchWorkspace", json!({ "id": default_id })).await.unwrap();
    host.request(Some("a"), "app.switchWorkspace", json!({ "id": team["id"] })).await.unwrap();
    let mut events = host.events();
    host.request(Some("a"), "emit", Value::Null).await.unwrap();
    let ev = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap().unwrap();
    assert_eq!(ev.topic, "tree:t");
    assert!(host.visible_to(&ev, "a"));
    assert!(!host.visible_to(&ev, "b"));
    // The main process's own events go to everyone.
    host.request(Some("a"), "app.renameWorkspace", json!({ "id": team["id"], "name": "Team" })).await.unwrap();
    next_topic(&mut events, "app.workspacesChanged").await;
    host.shutdown().await;
}

#[tokio::test]
async fn rename_changes_the_name_in_workspace_json_and_the_list() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let mut events = host.events();
    let id = list(&host, "w").await[0]["id"].clone();
    assert_eq!(host.request(Some("w"), "app.renameWorkspace", json!({ "id": id, "name": " Work " })).await.unwrap(), Value::Null);
    next_topic(&mut events, "app.workspacesChanged").await;
    assert_eq!(list(&host, "w").await[0]["name"], "Work");
    let file: Value = serde_json::from_slice(&std::fs::read(tmp.path().join("data/workspaces/default/workspace.json")).unwrap()).unwrap();
    assert_eq!(file["name"], "Work");
    assert_eq!(list(&host, "w").await[0]["folder"], "default", "the folder keeps its name");
    let empty = host.request(Some("w"), "app.renameWorkspace", json!({ "id": id, "name": "" })).await.unwrap_err();
    assert_eq!(empty.code, ErrorCode::InvalidParams);
    let long = host.request(Some("w"), "app.renameWorkspace", json!({ "id": id, "name": "y".repeat(101) })).await.unwrap_err();
    assert_eq!(long.code, ErrorCode::InvalidParams);
    let gone = host.request(Some("w"), "app.renameWorkspace", json!({ "id": "nope", "name": "x" })).await.unwrap_err();
    assert_eq!(gone.code, ErrorCode::NotFound);
    host.shutdown().await;
}

#[tokio::test]
async fn delete_refuses_the_workspace_in_use_and_moves_the_rest_to_trash_with_its_secrets() {
    let tmp = tempfile::tempdir().unwrap();
    let (store, memory) = memory_store();
    let host = start_with(tmp.path(), store.clone()).await;
    let mut events = host.events();
    let made = host.request(Some("a"), "app.createWorkspace", json!({ "name": "scratch" })).await.unwrap();
    let id = made["id"].as_str().unwrap().to_string();
    for name in ["token", "key"] {
        store.0.set(&format!("{id}/{name}"), "value").unwrap();
    }
    // Another workspace's entries, one whose id merely starts the same way, and a database file that is not even SQLite.
    store.0.set("other-workspace/token", "value").unwrap();
    store.0.set(&format!("{id}0/token"), "value").unwrap();
    let dir = tmp.path().join("data/workspaces/scratch");
    std::fs::write(dir.join("workspace.db"), b"the main process never opens this").unwrap();
    // In use: the current one, and one another connection is on.
    let current = list(&host, "a").await[0]["id"].clone();
    let e = host.request(Some("a"), "app.deleteWorkspace", json!({ "id": current })).await.unwrap_err();
    assert_eq!((e.code, e.params.get("reason").map(String::as_str)), (ErrorCode::Conflict, Some("inUse")));
    host.request(Some("b"), "app.switchWorkspace", json!({ "id": id })).await.unwrap();
    let e = host.request(Some("a"), "app.deleteWorkspace", json!({ "id": id })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert!(dir.exists());
    // b leaves; now it can go.
    host.request(Some("b"), "app.switchWorkspace", json!({ "id": current })).await.unwrap();
    host.request(Some("a"), "app.switchWorkspace", json!({ "id": current })).await.unwrap();
    assert_eq!(host.request(Some("a"), "app.deleteWorkspace", json!({ "id": id })).await.unwrap(), Value::Null);
    next_topic(&mut events, "app.workspacesChanged").await;
    assert!(!dir.exists());
    let trash: Vec<String> = std::fs::read_dir(tmp.path().join("data/trash/workspaces")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(trash.len(), 1);
    assert!(trash[0].starts_with("scratch-20"), "{trash:?}");
    assert!(tmp.path().join("data/trash/workspaces").join(&trash[0]).join("workspace.db").is_file(), "moved, not deleted");
    assert_eq!(memory.accounts(), [format!("{id}0/token"), "other-workspace/token".to_string()], "only this workspace's keychain entries went");
    assert_eq!(list(&host, "a").await.len(), 1);
    let gone = host.request(Some("a"), "app.deleteWorkspace", json!({ "id": id })).await.unwrap_err();
    assert_eq!(gone.code, ErrorCode::NotFound);
    host.shutdown().await;
}

#[tokio::test]
async fn a_first_version_onedesk_db_is_not_touched() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("onedesk.db"), b"first version").unwrap();
    let host = start(tmp.path()).await;
    assert_eq!(std::fs::read(data.join("onedesk.db")).unwrap(), b"first version");
    assert!(!data.join("workspaces/default/workspace.db").exists());
    assert!(!data.join("workspaces/default/backups").exists());
    host.shutdown().await;
}

#[tokio::test]
async fn workspace_methods_work_over_the_websocket_and_the_change_event_reaches_every_connection() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let port = ws_server(host.clone(), "t").await;
    let (mut a, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token=t&client=a")).await.unwrap();
    let (mut b, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token=t&client=b")).await.unwrap();
    a.send(Message::text(json!({ "id": 1, "method": "app.createWorkspace", "params": { "name": "Two" } }).to_string())).await.unwrap();
    let reply: Value = serde_json::from_str(a.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(reply["result"]["folder"], "two");
    for socket in [&mut a, &mut b] {
        let ev: Value = tokio::time::timeout(Duration::from_secs(5), async { serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap() }).await.unwrap();
        assert_eq!(ev["topic"], "app.workspacesChanged");
    }
    host.shutdown().await;
}

#[tokio::test]
async fn a_worker_that_fails_to_start_explains_itself_with_its_last_words() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let script = tmp.path().join("worker.sh");
    std::fs::write(&script, "#!/bin/sh\necho 'worker says why' >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let cfg = HostConfig { data_dir: tmp.path().join("data"), worker_bin: script, builtin_plugins: None, secrets: Some(memory_store().0) };
    let e = Host::start(cfg).await.err().expect("start fails");
    assert!(e.0.contains("worker says why"), "{}", e.0);
}

/* ---------------------------------------------------------------- several windows (D403) */

#[tokio::test]
async fn windows_of_different_workspaces_run_side_by_side_and_the_last_one_out_stops_the_worker() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let team = host.request(Some("main"), "app.createWorkspace", json!({ "name": "team" })).await.unwrap();
    let id = team["id"].as_str().unwrap();
    // Two windows on the same new workspace; the main window stays on the default one.
    host.bind_client("win-1", id).await.unwrap();
    host.bind_client("win-2", id).await.unwrap();
    assert_eq!(host.running_workspaces(), ["default", "team"]);
    assert!(host.request(Some("win-1"), "args", Value::Null).await.unwrap()["workspace"].as_str().unwrap().ends_with("workspaces/team"));
    assert!(host.request(Some("main"), "args", Value::Null).await.unwrap()["workspace"].as_str().unwrap().ends_with("workspaces/default"));
    // One window of two closes: the worker stays; deleting is refused while any window uses it.
    host.unbind_client("win-1").await;
    assert_eq!(host.running_workspaces(), ["default", "team"]);
    let e = host.request(Some("main"), "app.deleteWorkspace", json!({ "id": id })).await.unwrap_err();
    assert_eq!((e.code, e.params.get("reason").map(String::as_str)), (ErrorCode::Conflict, Some("inUse")));
    // The last one closes: the worker stops and the workspace can be deleted.
    host.unbind_client("win-2").await;
    assert_eq!(host.running_workspaces(), ["default"]);
    host.request(Some("main"), "app.deleteWorkspace", json!({ "id": id })).await.unwrap();
    // Binding to a workspace that does not exist is refused.
    assert_eq!(host.bind_client("win-3", "nope").await.unwrap_err().code, ErrorCode::NotFound);
    host.shutdown().await;
}

#[tokio::test]
async fn a_new_window_does_not_change_which_workspace_other_windows_get() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let team = host.request(Some("main"), "app.createWorkspace", json!({ "name": "team" })).await.unwrap();
    host.bind_client("win-1", team["id"].as_str().unwrap()).await.unwrap();
    let items = list(&host, "win-1").await;
    assert_eq!(items.iter().filter(|i| i["current"] == true).map(|i| i["folder"].as_str().unwrap()).collect::<Vec<_>>(), ["team"]);
    let items = list(&host, "main").await;
    assert_eq!(items.iter().filter(|i| i["current"] == true).map(|i| i["folder"].as_str().unwrap()).collect::<Vec<_>>(), ["default"]);
    // A window that switches inside itself leaves its old workspace's worker running only if another window uses it.
    let default_id = items.iter().find(|i| i["folder"] == "default").unwrap()["id"].clone();
    host.request(Some("win-1"), "app.switchWorkspace", json!({ "id": default_id })).await.unwrap();
    assert_eq!(host.running_workspaces(), ["default"]);
    host.shutdown().await;
}

#[tokio::test]
async fn the_window_position_is_kept_in_workspace_json_across_restarts_of_the_worker() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let b = onedesk_host::workspaces::WindowBounds { x: 10.0, y: 20.0, width: 1200.0, height: 800.0 };
    host.set_window_bounds("default", Some(b));
    assert_eq!(host.window_bounds("default"), Some(b));
    let file: Value = serde_json::from_slice(&std::fs::read(tmp.path().join("data/workspaces/default/workspace.json")).unwrap()).unwrap();
    assert_eq!(file["window"]["width"], 1200.0);
    assert_eq!(file["name"], "Default", "the rest of the file is kept");
    host.shutdown().await;
    // A second host on the same data directory still has it.
    let again = start(tmp.path()).await;
    assert_eq!(again.window_bounds("default"), Some(b));
    again.shutdown().await;
}

#[tokio::test]
async fn a_browser_tab_opened_with_a_workspace_parameter_is_bound_and_released_on_close() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let team = host.request(None, "app.createWorkspace", json!({ "name": "team" })).await.unwrap();
    let port = ws_server(host.clone(), "t").await;
    let id = team["id"].as_str().unwrap();
    let (mut tab, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token=t&client=tab-x&workspace={id}")).await.unwrap();
    tab.send(Message::text(json!({ "id": 1, "method": "args" }).to_string())).await.unwrap();
    let reply: Value = serde_json::from_str(tab.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert!(reply["result"]["workspace"].as_str().unwrap().ends_with("workspaces/team"), "{reply}");
    assert_eq!(host.running_workspaces(), ["default", "team"]);
    tab.close(None).await.unwrap();
    drop(tab);
    for _ in 0..50 {
        if host.running_workspaces() == ["default"] {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(host.running_workspaces(), ["default"]);
    host.shutdown().await;
}

#[tokio::test]
async fn a_folder_without_workspace_json_is_listed_switchable_and_not_deletable_until_its_worker_has_run() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let dir = tmp.path().join("data/workspaces/copied-in");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("workspace.db"), b"x").unwrap();
    let items = list(&host, "w").await;
    let pending = items.iter().find(|i| i["folder"] == "copied-in").expect("listed");
    assert_eq!((pending["name"].clone(), pending["id"].clone()), (json!("copied-in"), json!("pending:copied-in")));
    assert!(!dir.join("workspace.json").exists(), "the main process writes nothing for it");
    for method in ["app.deleteWorkspace", "app.renameWorkspace"] {
        let e = host.request(Some("w"), method, json!({ "id": "pending:copied-in", "name": "x" })).await.unwrap_err();
        assert_eq!((e.code, e.params.get("reason").map(String::as_str)), (ErrorCode::Conflict, Some("idPending")));
    }
    // It can be switched to; the (real) kernel then writes workspace.json with the id. The fake worker does not, so
    // the entry stays pending here; what matters is that the switch works.
    let switched = host.request(Some("w"), "app.switchWorkspace", json!({ "id": "pending:copied-in" })).await.unwrap();
    assert_eq!(switched["folder"], "copied-in");
    host.shutdown().await;
}

/* ---------------------------------------------------------------- after the review (round 13) */

fn calls_of(tmp: &Path, folder: &str) -> Vec<String> {
    std::fs::read_to_string(tmp.join("data/workspaces").join(folder).join("calls.log")).map(|t| t.lines().map(str::to_string).collect()).unwrap_or_default()
}

#[tokio::test]
async fn a_worker_that_refuses_a_snapshot_with_a_client_still_lets_create_succeed() {
    // The fake refuses like the kernel does; creating works only because the main process asks as itself (#1).
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let refused = host.request(Some("w"), "workspace.settingsSnapshot", Value::Null).await.unwrap_err();
    assert_eq!((refused.code, refused.params.get("reason").map(String::as_str)), (ErrorCode::Denied, Some("mainProcessOnly")));
    let made = host.request(Some("w"), "app.createWorkspace", json!({ "name": "ok" })).await.unwrap();
    assert!(std::fs::read(tmp.path().join("data/workspaces").join(made["folder"].as_str().unwrap()).join("init-settings.json")).is_ok());
    host.shutdown().await;
}

#[tokio::test]
async fn a_connection_is_bound_when_it_first_appears_and_is_not_carried_off_by_others() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let team = host.request(Some("main"), "app.createWorkspace", json!({ "name": "team" })).await.unwrap();
    // main appears (bound to default), then another tab switches: main stays where it is (#2, D406).
    assert!(host.request(Some("main"), "args", Value::Null).await.unwrap()["workspace"].as_str().unwrap().ends_with("workspaces/default"));
    host.request(Some("other"), "app.switchWorkspace", json!({ "id": team["id"] })).await.unwrap();
    assert!(host.request(Some("main"), "args", Value::Null).await.unwrap()["workspace"].as_str().unwrap().ends_with("workspaces/default"));
    // A connection that appears now starts in the default of this moment (the last switch).
    assert!(host.request(Some("newcomer"), "args", Value::Null).await.unwrap()["workspace"].as_str().unwrap().ends_with("workspaces/team"));
    assert_eq!(host.running_workspaces(), ["default", "team"]);
    host.shutdown().await;
}

#[tokio::test]
async fn the_default_for_new_connections_is_neither_kept_running_nor_protected_from_delete() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let team = host.request(Some("a"), "app.createWorkspace", json!({ "name": "team" })).await.unwrap();
    let default_id = list(&host, "a").await[0]["id"].clone();
    host.request(Some("a"), "app.switchWorkspace", json!({ "id": team["id"] })).await.unwrap();
    // `a` left default; nobody is on it any more, whatever new connections would get.
    assert_eq!(host.running_workspaces(), ["team"]);
    host.request(Some("a"), "app.switchWorkspace", json!({ "id": default_id })).await.unwrap();
    // Now the default for newcomers is `default`, yet `team` (no connection) can be deleted, and the other way round.
    host.request(Some("a"), "app.deleteWorkspace", json!({ "id": team["id"] })).await.unwrap();
    // Deleting the workspace the default pointed at moves the default to the asker's: a newcomer lands on a real one.
    let made = host.request(Some("a"), "app.createWorkspace", json!({ "name": "again" })).await.unwrap();
    host.request(Some("b"), "app.switchWorkspace", json!({ "id": made["id"] })).await.unwrap();
    host.request(Some("c"), "app.switchWorkspace", json!({ "id": default_id })).await.unwrap();
    host.request(Some("c"), "app.deleteWorkspace", json!({ "id": made["id"] })).await.unwrap_err(); // b is on it
    host.request(Some("b"), "app.switchWorkspace", json!({ "id": default_id })).await.unwrap();
    host.request(Some("c"), "app.deleteWorkspace", json!({ "id": made["id"] })).await.unwrap();
    assert!(host.request(Some("newcomer"), "args", Value::Null).await.unwrap()["workspace"].as_str().unwrap().ends_with("workspaces/default"));
    host.shutdown().await;
}

#[tokio::test]
async fn a_delete_racing_a_switch_never_leaves_a_connection_on_a_deleted_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    for round in 0..6 {
        let made = host.request(Some("owner"), "app.createWorkspace", json!({ "name": format!("race {round}") })).await.unwrap();
        let (switch, delete) = tokio::join!(
            host.request(Some("tab"), "app.switchWorkspace", json!({ "id": made["id"] })),
            host.request(Some("owner"), "app.deleteWorkspace", json!({ "id": made["id"] })),
        );
        match (switch, delete) {
            (Ok(_), Err(e)) => assert_eq!(e.code, ErrorCode::Conflict, "switched first, so the delete is refused"),
            (Err(e), Ok(_)) => assert_eq!(e.code, ErrorCode::NotFound, "deleted first, so the switch finds nothing"),
            (s, d) => panic!("round {round}: switch {s:?} / delete {d:?}"),
        }
        // Whatever won, `tab` is on an existing workspace.
        let folder = host.request(Some("tab"), "args", Value::Null).await.unwrap()["workspace"].as_str().unwrap().to_string();
        assert!(Path::new(&folder).exists(), "{folder}");
    }
    host.shutdown().await;
}

#[tokio::test]
async fn creating_the_same_name_at_the_same_time_gives_different_folders() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let results = futures_util::future::join_all((0..6).map(|i| {
        let host = host.clone();
        async move { host.request(Some(&format!("c{i}")), "app.createWorkspace", json!({ "name": "Same" })).await.unwrap() }
    }))
    .await;
    let mut folders: Vec<String> = results.iter().map(|r| r["folder"].as_str().unwrap().to_string()).collect();
    folders.sort();
    folders.dedup();
    assert_eq!(folders.len(), 6);
    host.shutdown().await;
}

#[tokio::test]
async fn a_folder_copied_by_hand_with_the_same_id_is_pending_and_cannot_touch_its_twins_secrets() {
    let tmp = tempfile::tempdir().unwrap();
    let (store, memory) = memory_store();
    let host = start_with(tmp.path(), store.clone()).await;
    let made = host.request(Some("a"), "app.createWorkspace", json!({ "name": "Work" })).await.unwrap();
    let id = made["id"].as_str().unwrap();
    store.0.set(&format!("{id}/token"), "v").unwrap();
    let from = tmp.path().join("data/workspaces/work");
    let copy = tmp.path().join("data/workspaces/work-copy");
    std::fs::create_dir_all(&copy).unwrap();
    std::fs::copy(from.join("workspace.json"), copy.join("workspace.json")).unwrap();
    let items = list(&host, "a").await;
    let twin = items.iter().find(|i| i["folder"] == "work-copy").unwrap();
    assert_eq!(twin["id"], "pending:work-copy");
    assert_eq!(items.iter().find(|i| i["folder"] == "work").unwrap()["id"], id);
    let e = host.request(Some("a"), "app.deleteWorkspace", json!({ "id": "pending:work-copy" })).await.unwrap_err();
    assert_eq!(e.params.get("reason").map(String::as_str), Some("idPending"));
    assert_eq!(memory.accounts(), [format!("{id}/token")]);
    host.shutdown().await;
}

#[tokio::test]
async fn installing_and_removing_a_plugin_involves_every_running_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let team = host.request(Some("a"), "app.createWorkspace", json!({ "name": "team" })).await.unwrap();
    host.bind_client("b", team["id"].as_str().unwrap()).await.unwrap();
    // `a` is on default, `b` on team. A rescan asked by a reaches both (#6).
    host.request(Some("a"), "app.removePlugin", json!({ "plugin": "org.test.alpha", "version": "0.1.0" })).await.unwrap();
    for folder in ["default", "team"] {
        let log = calls_of(tmp.path(), folder);
        assert!(log.iter().any(|l| l.starts_with("plugin.checkRemove")), "{folder}: {log:?}");
        assert!(log.iter().any(|l| l.starts_with("plugin.rescan")), "{folder}: {log:?}");
    }
    host.shutdown().await;
}

#[tokio::test]
async fn another_workspace_that_still_needs_the_plugin_stops_its_removal() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let team = host.request(Some("a"), "app.createWorkspace", json!({ "name": "team" })).await.unwrap();
    host.bind_client("b", team["id"].as_str().unwrap()).await.unwrap();
    std::fs::write(tmp.path().join("data/workspaces/team/remove-refused"), "").unwrap();
    let e = host.request(Some("a"), "app.removePlugin", json!({ "plugin": "org.test.alpha", "version": "0.1.0" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert!(tmp.path().join("data/plugins/org.test.alpha/0.1.0/main.js").exists(), "nothing moved");
    host.shutdown().await;
}

#[tokio::test]
async fn the_window_position_survives_a_worker_crash_and_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let host = start(tmp.path()).await;
    let b = onedesk_host::workspaces::WindowBounds { x: 1.0, y: 2.0, width: 1300.0, height: 700.0 };
    host.set_window_bounds("default", Some(b));
    let mut events = host.events();
    let _ = host.request(None, "crash", Value::Null).await;
    assert_eq!(next_connection(&mut events).await, ConnectionState::Lost);
    assert_eq!(next_connection(&mut events).await, ConnectionState::Restored);
    // The restarted fake worker rewrote workspace.json without the field; the main process put it back.
    assert_eq!(host.window_bounds("default"), Some(b));
    host.shutdown().await;
}
