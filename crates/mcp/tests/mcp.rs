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
