use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use onedesk_host::{mcp_socket, Host, HostConfig};
use onedesk_mcp::backend::{Auto, AutoConfig};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn fake_worker() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake-mcp-worker"))
}

fn make_workspace(data: &Path, folder: &str, id: &str, name: &str, last_opened: i64) {
    let dir = data.join("workspaces").join(folder);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("workspace.json"), json!({ "id": id, "name": name, "lastOpenedAt": last_opened }).to_string()).unwrap();
}

fn auto(data: &Path, workspace: Option<&str>, idle_ms: u64, lock_wait_ms: u64) -> Arc<Auto> {
    Arc::new(Auto::new(AutoConfig {
        data_dir: data.to_path_buf(),
        workspace: workspace.map(String::from),
        worker_bin: fake_worker(),
        client_name: "test-client".into(),
        idle: Duration::from_millis(idle_ms),
        lock_wait: Duration::from_millis(lock_wait_ms),
        builtin_plugins: None,
    }))
}

/// Runs the MCP server over in-memory pipes; returns a function-like pair (send line, read line).
struct Client {
    to: tokio::io::DuplexStream,
    from: tokio::io::Lines<BufReader<tokio::io::DuplexStream>>,
}

fn start_server(backend: Arc<Auto>) -> Client {
    let (c_to, s_in) = tokio::io::duplex(1 << 20);
    let (s_out, c_from) = tokio::io::duplex(1 << 20);
    tokio::spawn(async move { onedesk_mcp::serve(backend, BufReader::new(s_in), s_out).await });
    Client { to: c_to, from: BufReader::new(c_from).lines() }
}

impl Client {
    async fn send(&mut self, v: Value) {
        self.to.write_all(format!("{v}\n").as_bytes()).await.unwrap();
    }
    async fn recv(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(20), self.from.next_line()).await.expect("answer in time").unwrap().expect("line");
        serde_json::from_str(&line).unwrap()
    }
    async fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await;
        self.recv().await
    }
}

fn alive(pid: u64) -> bool {
    // SAFETY: signal 0 only checks existence.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[tokio::test]
async fn mcp_handshake_and_errors() {
    let tmp = tempfile::tempdir().unwrap();
    make_workspace(tmp.path(), "default", "ws-1", "Default", 1);
    let mut c = start_server(auto(tmp.path(), None, 5000, 1000));
    let init = c.call(1, "initialize", json!({ "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } })).await;
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    assert_eq!(init["result"]["serverInfo"]["name"], "onedesk");
    // An unknown version gets ours.
    let init = c.call(2, "initialize", json!({ "protocolVersion": "1999-01-01" })).await;
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    // Notifications get no answer: the next answer is the ping's.
    c.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    assert_eq!(c.call(3, "ping", Value::Null).await["result"], json!({}));
    assert_eq!(c.call(4, "resources/list", Value::Null).await["error"]["code"], -32601);
    c.to.write_all(b"not json\n").await.unwrap();
    assert_eq!(c.recv().await["error"]["code"], -32700);
    assert_eq!(c.call(5, "tools/call", json!({ "arguments": {} })).await["error"]["code"], -32602);
}

#[tokio::test]
async fn headless_serves_tools_and_calls_then_lets_go_when_idle() {
    let tmp = tempfile::tempdir().unwrap();
    make_workspace(tmp.path(), "older", "ws-old", "Old", 1);
    make_workspace(tmp.path(), "newer", "ws-new", "New", 9);
    let mut c = start_server(auto(tmp.path(), None, 300, 1000));
    let tools = c.call(1, "tools/list", Value::Null).await;
    assert_eq!(tools["result"]["tools"][0]["name"], "search");
    let call = c.call(2, "tools/call", json!({ "name": "search", "arguments": { "query": "x" } })).await;
    assert_eq!(call["result"]["isError"], false);
    let content = &call["result"]["structuredContent"];
    // Default workspace = the most recently opened; the worker was told it is an AI client.
    assert!(content["workspace"].as_str().unwrap().ends_with("workspaces/newer"));
    assert_eq!(content["aiClient"], "test-client");
    assert_eq!(content["echo"], json!({ "name": "search", "arguments": { "query": "x" } }));
    let text: Value = serde_json::from_str(call["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text["aiClient"], "test-client");
    let pid = content["pid"].as_u64().unwrap();
    assert!(alive(pid));
    // Idle: the worker goes away by itself (the workspace lock is free for the app) …
    tokio::time::timeout(Duration::from_secs(10), async { while alive(pid) { tokio::time::sleep(Duration::from_millis(50)).await } }).await.expect("worker exits when idle");
    // … and the next call starts a new one.
    let again = c.call(3, "tools/call", json!({ "name": "search", "arguments": {} })).await;
    assert_ne!(again["result"]["structuredContent"]["pid"].as_u64().unwrap(), pid);
}

#[tokio::test]
async fn kernel_errors_become_tool_errors_and_truncation_is_said() {
    let tmp = tempfile::tempdir().unwrap();
    make_workspace(tmp.path(), "default", "ws-1", "Default", 1);
    let mut c = start_server(auto(tmp.path(), Some("Default"), 5000, 1000));
    let r = c.call(1, "tools/call", json!({ "name": "boom", "arguments": {} })).await;
    assert_eq!(r["result"]["isError"], true);
    let e: Value = serde_json::from_str(r["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(e, json!({ "code": "denied", "params": { "reason": "aiRateLimit" } }));
    let r = c.call(2, "tools/call", json!({ "name": "cut", "arguments": {} })).await;
    assert_eq!(r["result"]["isError"], false);
    assert_eq!(r["result"]["content"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn unknown_workspace_is_a_tool_error() {
    let tmp = tempfile::tempdir().unwrap();
    make_workspace(tmp.path(), "default", "ws-1", "Default", 1);
    let mut c = start_server(auto(tmp.path(), Some("nope"), 5000, 1000));
    let r = c.call(1, "tools/call", json!({ "name": "search", "arguments": {} })).await;
    assert_eq!(r["result"]["isError"], true);
    assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("notFound"));
}

#[tokio::test]
async fn locked_workspace_is_waited_for() {
    let tmp = tempfile::tempdir().unwrap();
    make_workspace(tmp.path(), "default", "ws-1", "Default", 1);
    let lock = tmp.path().join("workspaces/default/locked");
    std::fs::write(&lock, "").unwrap();
    let mut c = start_server(auto(tmp.path(), None, 5000, 10_000));
    let freed = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(800)).await;
        std::fs::remove_file(lock).unwrap();
    });
    let r = c.call(1, "tools/list", Value::Null).await;
    assert_eq!(r["result"]["tools"][0]["name"], "search");
    freed.await.unwrap();
    // Waiting has a limit.
    let tmp2 = tempfile::tempdir().unwrap();
    make_workspace(tmp2.path(), "default", "ws-1", "Default", 1);
    std::fs::write(tmp2.path().join("workspaces/default/locked"), "").unwrap();
    let mut c = start_server(auto(tmp2.path(), None, 5000, 700));
    let r = c.call(1, "tools/call", json!({ "name": "search", "arguments": {} })).await;
    assert_eq!(r["result"]["isError"], true);
}

async fn start_app(tmp: &Path) -> (Arc<Host>, PathBuf) {
    let data = tmp.join("data");
    make_workspace(&data, "default", "ws-1", "Default", 1);
    let host = Host::start(HostConfig { data_dir: data.clone(), worker_bin: fake_worker(), builtin_plugins: None, secrets: Some(onedesk_kernel::secrets::SecretStoreHandle::memory().0) }).await.unwrap();
    let (listener, path) = mcp_socket::bind(&data).unwrap();
    tokio::spawn(mcp_socket::serve(host.clone(), listener));
    (host, path)
}

#[tokio::test]
async fn app_open_uses_the_socket_and_only_mcp_commands_pass() {
    let tmp = tempfile::tempdir().unwrap();
    let (host, sock) = start_app(tmp.path()).await;
    let data = tmp.path().join("data");
    // Through the socket the worker is the app's one (it has no --ai-client), not a headless one.
    let mut c = start_server(auto(&data, None, 5000, 1000));
    let r = c.call(1, "tools/call", json!({ "name": "search", "arguments": { "query": "x" } })).await;
    assert_eq!(r["result"]["isError"], false);
    let content = &r["result"]["structuredContent"];
    assert_eq!(content["aiClient"], "");
    assert!(content["client"].as_str().unwrap().starts_with("ai:mcp-"), "{content}");
    assert_eq!(c.call(2, "tools/list", Value::Null).await["result"]["tools"][0]["name"], "search");

    // The door itself: a raw connection that asks for anything but mcp.* is refused, and a wrong hello too.
    let mut raw = tokio::net::UnixStream::connect(&sock).await.unwrap();
    raw.write_all(format!("{}\n", json!({ "hello": "onedesk-mcp", "protocol": "1", "clientName": "raw" })).as_bytes()).await.unwrap();
    let (r, mut w) = raw.into_split();
    let mut lines = BufReader::new(r).lines();
    let hello: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(hello["ok"], true);
    assert_eq!(hello["workspace"]["id"], "ws-1");
    for (id, method) in [(1, "resource.delete"), (2, "echo"), (3, "config.set"), (4, "hello")] {
        w.write_all(format!("{}\n", json!({ "id": id, "method": method, "params": {}, "client": "someone-else" })).as_bytes()).await.unwrap();
        let resp: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(resp["error"]["code"], "denied", "{method}");
        assert_eq!(resp["error"]["params"]["reason"], "mcpOnly");
    }
    w.write_all(format!("{}\n", json!({ "id": 9, "method": "mcp.call", "params": { "name": "search" }, "client": "someone-else" })).as_bytes()).await.unwrap();
    let resp: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    // The client name the worker sees is ours, never the peer's.
    assert!(resp["result"]["content"]["client"].as_str().unwrap().starts_with("ai:mcp-"));
    // The operator is stamped by the main process from the connection; what the peer writes is dropped.
    w.write_all(format!("{}\n", json!({ "id": 10, "method": "mcp.call", "params": { "name": "search" }, "actor": "user" })).as_bytes()).await.unwrap();
    let resp: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(resp["result"]["content"]["actor"], "ai:raw", "{resp}");

    // Bad hello / unknown workspace.
    for hello in [json!({ "hello": "x", "protocol": "1" }), json!({ "hello": "onedesk-mcp", "protocol": "99" }), json!({ "hello": "onedesk-mcp", "protocol": "1", "workspace": "nope" })] {
        let mut s = tokio::net::UnixStream::connect(&sock).await.unwrap();
        s.write_all(format!("{hello}\n").as_bytes()).await.unwrap();
        let mut l = BufReader::new(s).lines();
        let a: Value = serde_json::from_str(&l.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(a["ok"], false, "{hello}");
    }
    host.shutdown().await;
}

#[tokio::test]
async fn app_waits_for_a_headless_worker_to_let_go() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    make_workspace(&data, "default", "ws-1", "Default", 1);
    let lock = data.join("workspaces/default/locked");
    std::fs::write(&lock, "").unwrap();
    let freed = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        std::fs::remove_file(lock).unwrap();
    });
    let host = tokio::time::timeout(Duration::from_secs(20), Host::start(HostConfig { data_dir: data, worker_bin: fake_worker(), builtin_plugins: None, secrets: Some(onedesk_kernel::secrets::SecretStoreHandle::memory().0) })).await.expect("in time").expect("the app starts once the lock is free");
    freed.await.unwrap();
    host.shutdown().await;
}

#[tokio::test]
async fn socket_path_is_stable_and_short() {
    let long = PathBuf::from(format!("/Users/someone/{}/onedesk", "x".repeat(120)));
    let a = mcp_socket::socket_path(&long);
    assert_eq!(a, mcp_socket::socket_path(&long));
    assert!(a.as_os_str().len() < 104);
    assert_eq!(mcp_socket::socket_path(Path::new("/d")), PathBuf::from("/d/mcp.sock"));
    assert_eq!(mcp_socket::client_name(Some("a/b\u{e9}")), "a_b_");
    assert_eq!(mcp_socket::client_name(Some("")), "unknown");
}

/// The real worker (built by `cargo build --workspace`, next to the test binaries' `deps` folder).
fn real_worker() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dirs: Vec<PathBuf> = exe.ancestors().map(Path::to_path_buf).collect();
    if let Some(t) = std::env::var_os("CARGO_TARGET_DIR") {
        dirs.push(PathBuf::from(t).join("debug"));
    }
    dirs.iter().map(|d| d.join("onedesk-worker")).find(|p| p.is_file())
}

fn auto_real(data: &Path, worker: PathBuf) -> Arc<Auto> {
    Arc::new(Auto::new(AutoConfig { data_dir: data.to_path_buf(), workspace: None, worker_bin: worker, client_name: "e2e".into(), idle: Duration::from_millis(500), lock_wait: Duration::from_secs(5), builtin_plugins: None }))
}

// With the real kernel the switch is off by default: `aiOff` proves the request was the AI operator's
// (anyone else gets `aiOnly`), on both routes.
#[tokio::test]
async fn real_kernel_headless_is_the_ai_operator() {
    let Some(worker) = real_worker() else { panic!("onedesk-worker is not built; run cargo build --workspace first") };
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    std::fs::create_dir_all(data.join("plugins")).unwrap();
    make_workspace(&data, "default", "ws-1", "Default", 1);
    let mut c = start_server(auto_real(&data, worker));
    let r = c.call(1, "tools/list", Value::Null).await;
    assert_eq!(r["error"]["code"], -32000, "{r}");
    assert!(r["error"]["message"].as_str().unwrap().contains("turned off"));
    let r = c.call(2, "tools/call", json!({ "name": "search", "arguments": { "query": "x" } })).await;
    assert_eq!(r["result"]["isError"], true);
    let e: Value = serde_json::from_str(r["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(e["params"]["reason"], "aiOff");
}

#[tokio::test]
async fn real_kernel_through_the_app_socket_is_the_ai_operator() {
    let Some(worker) = real_worker() else { panic!("onedesk-worker is not built; run cargo build --workspace first") };
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    make_workspace(&data, "default", "ws-1", "Default", 1);
    let host = Host::start(HostConfig { data_dir: data.clone(), worker_bin: worker.clone(), builtin_plugins: None, secrets: Some(onedesk_kernel::secrets::SecretStoreHandle::memory().0) }).await.unwrap();
    let (listener, _) = mcp_socket::bind(&data).unwrap();
    tokio::spawn(mcp_socket::serve(host.clone(), listener));
    let mut c = start_server(auto_real(&data, worker));
    let r = c.call(1, "tools/call", json!({ "name": "search", "arguments": { "query": "x" } })).await;
    let e: Value = serde_json::from_str(r["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(e["params"]["reason"], "aiOff", "{r}");
    // A window's own request for the same command is not the AI operator.
    let own = host.request(Some("win"), "mcp.tools", json!({})).await.unwrap_err();
    assert_eq!(own.params.get("reason").map(String::as_str), Some("aiOnly"));
    host.shutdown().await;
}

#[tokio::test]
async fn session_is_named_after_the_mcp_client_with_a_suffix() {
    use onedesk_mcp::server::{process_suffix, session_name};
    assert_eq!(session_name(Some("claude-desktop")), format!("claude-desktop-{}", process_suffix()));
    assert_eq!(session_name(Some("a/b:c")), format!("a_b_c-{}", process_suffix()));
    assert_eq!(session_name(Some("  ")), format!("mcp-{}", process_suffix()));
    assert!(session_name(Some(&"x".repeat(200))).len() <= 40 + 1 + 6);
    let tmp = tempfile::tempdir().unwrap();
    make_workspace(tmp.path(), "default", "ws-1", "Default", 1);
    let mut c = start_server(auto(tmp.path(), None, 5000, 1000));
    c.call(1, "initialize", json!({ "protocolVersion": "2025-06-18", "clientInfo": { "name": "Fancy Client", "version": "1" } })).await;
    let r = c.call(2, "tools/call", json!({ "name": "search", "arguments": {} })).await;
    assert_eq!(r["result"]["structuredContent"]["aiClient"], format!("Fancy Client-{}", process_suffix()));
}

#[tokio::test]
async fn a_bad_line_does_not_end_the_session() {
    let tmp = tempfile::tempdir().unwrap();
    make_workspace(tmp.path(), "default", "ws-1", "Default", 1);
    let mut c = start_server(auto(tmp.path(), None, 5000, 1000));
    // Not UTF-8.
    c.to.write_all(&[0xff, 0xfe, b'\n']).await.unwrap();
    assert_eq!(c.recv().await["error"]["code"], -32700);
    assert_eq!(c.call(1, "ping", Value::Null).await["result"], json!({}));
    // Longer than the limit: refused, skipped to its end, the next message is read.
    let big = vec![b'a'; onedesk_mcp::server::MAX_LINE + 10];
    c.to.write_all(&big).await.unwrap();
    c.to.write_all(b"\n").await.unwrap();
    assert_eq!(c.recv().await["error"]["code"], -32700);
    assert_eq!(c.call(2, "ping", Value::Null).await["result"], json!({}));
}

#[tokio::test]
async fn a_tool_call_lost_in_flight_is_not_sent_again() {
    let tmp = tempfile::tempdir().unwrap();
    make_workspace(tmp.path(), "default", "ws-1", "Default", 1);
    let mut c = start_server(auto(tmp.path(), None, 5000, 1000));
    let r = c.call(1, "tools/call", json!({ "name": "die", "arguments": {} })).await;
    assert_eq!(r["result"]["isError"], true);
    let log = std::fs::read_to_string(tmp.path().join("workspaces/default/die.log")).unwrap();
    assert_eq!(log.lines().count(), 1, "the call must not be repeated");
    // The session lives on.
    assert_eq!(c.call(2, "tools/call", json!({ "name": "search", "arguments": {} })).await["result"]["isError"], false);
}

#[tokio::test]
async fn headless_worker_is_told_the_built_in_packages() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    make_workspace(&data, "default", "ws-1", "Default", 1);
    let builtin = tmp.path().join("builtin/org.test.alpha");
    std::fs::create_dir_all(&builtin).unwrap();
    std::fs::write(builtin.join("manifest.json"), r#"{"id":"org.test.alpha","version":"0.1.0"}"#).unwrap();
    std::fs::write(builtin.join("main.js"), "export default {};").unwrap();
    let a = Arc::new(Auto::new(AutoConfig { data_dir: data.clone(), workspace: None, worker_bin: fake_worker(), client_name: "t".into(), idle: Duration::from_secs(5), lock_wait: Duration::from_secs(1), builtin_plugins: Some(tmp.path().join("builtin")) }));
    let mut c = start_server(a);
    let r = c.call(1, "tools/call", json!({ "name": "search", "arguments": {} })).await;
    assert_eq!(r["result"]["structuredContent"]["builtin"], json!(["org.test.alpha@0.1.0"]));
    assert!(data.join("plugins/org.test.alpha/0.1.0/manifest.json").is_file());
}

#[tokio::test]
async fn a_client_arriving_while_the_app_is_still_starting_queues_on_the_socket() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    make_workspace(&data, "default", "ws-1", "Default", 1);
    // The app has bound the socket but is still waiting for the workspace lock: no host yet.
    let (listener, _) = mcp_socket::bind(&data).unwrap();
    let mut c = start_server(auto(&data, None, 5000, 1000));
    c.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "search", "arguments": {} } })).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let host = Host::start(HostConfig { data_dir: data.clone(), worker_bin: fake_worker(), builtin_plugins: None, secrets: Some(onedesk_kernel::secrets::SecretStoreHandle::memory().0) }).await.unwrap();
    tokio::spawn(mcp_socket::serve(host.clone(), listener));
    let r = c.recv().await;
    assert_eq!(r["result"]["isError"], false, "{r}");
    // It went through the app (no headless worker was started).
    assert_eq!(r["result"]["structuredContent"]["aiClient"], "");
    host.shutdown().await;
}

#[tokio::test]
async fn binding_twice_keeps_the_first_socket_and_paths_are_per_user() {
    let tmp = tempfile::tempdir().unwrap();
    let (_first, path) = mcp_socket::bind(tmp.path()).unwrap();
    assert!(mcp_socket::bind(tmp.path()).is_err());
    assert!(path.exists(), "a failed second bind must leave the first one's socket alone");
    assert!(tokio::net::UnixStream::connect(&path).await.is_ok());
    let long = PathBuf::from(format!("/Users/someone/{}/onedesk", "x".repeat(120)));
    let p = mcp_socket::socket_path_in(&long, Path::new("/var/folders/ab/T"));
    assert!(p.starts_with("/var/folders/ab/T"), "{p:?}");
    let (a, _b) = tokio::net::UnixStream::pair().unwrap();
    assert!(mcp_socket::peer_is_me(&a));
}
