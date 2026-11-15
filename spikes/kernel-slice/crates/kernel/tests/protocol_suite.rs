//! Question 4: one suite, run against the in-process kernel and against a
//! worker process over a Unix socket. Plus process-model tests.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ks_kernel::kernel::{seed, Kernel};
use ks_kernel::transport::{Client, Supervisor, WorkerSpec};
use ks_protocol::*;
use serde_json::{json, Value};

const WORKER: &str = env!("CARGO_BIN_EXE_worker");
const MAINHOST: &str = env!("CARGO_BIN_EXE_mainhost");

fn plugins_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins").canonicalize().unwrap()
}

fn workspace() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path(), 10_000).unwrap();
    dir
}

/// Short path under the system temp dir (socket paths are limited to 103 bytes on macOS).
fn socket_path() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let p = std::env::temp_dir().join(format!("ks-{}-{}.sock", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    assert!(p.as_os_str().len() < 100, "socket path too long: {}", p.display());
    p
}

fn spec(ws: &Path) -> WorkerSpec {
    WorkerSpec { worker_bin: WORKER.into(), workspace: ws.into(), plugins_dir: plugins_dir(), socket: socket_path() }
}

fn short_limits() {
    // Read by the in-process kernel here and inherited by spawned workers.
    std::env::set_var("KS_SYNC_SLICE_MS", "200");
    std::env::set_var("KS_CALL_TIMEOUT_MS", "3000");
}

fn code(r: Result<Value, RpcError>) -> ErrorCode {
    r.unwrap_err().code
}

async fn suite(c: Arc<Client>) {
    // version handshake
    assert_eq!(c.request("hello", json!({"protocolVersion": PROTOCOL_VERSION})).await.unwrap()["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(code(c.request("hello", json!({"protocolVersion": 999})).await), ErrorCode::VersionMismatch);
    assert_eq!(code(c.request("nope.nope", json!({})).await), ErrorCode::UnknownMethod);
    assert_eq!(code(c.request("tree.page", json!({"offset": "x"})).await), ErrorCode::BadParams);

    // tree needs no plugin
    let page: TreePage = serde_json::from_value(c.request("tree.page", json!({"offset": 0, "limit": 200})).await.unwrap()).unwrap();
    assert_eq!((page.nodes.len(), page.total), (200, 250));
    assert!(page.nodes[0].has_children);
    let info: WorkspaceInfo = serde_json::from_value(c.request("workspace.info", json!({})).await.unwrap()).unwrap();
    assert_eq!(info.resource_count, 10_000);
    assert!(info.activated_plugins.is_empty(), "nothing activated by browsing the tree");
    let kids: TreePage = serde_json::from_value(c.request("tree.page", json!({"parent": 1, "offset": 0, "limit": 50})).await.unwrap()).unwrap();
    let sql = kids.nodes.iter().find(|n| n.kind == "sql").unwrap().id;
    let note = kids.nodes.iter().find(|n| n.kind == "note").unwrap().id;

    // (a) open a page: lazy activation, render in the sandbox, validated view tree
    let open: PageOpenResult = serde_json::from_value(c.request("page.open", json!({"resourceId": sql})).await.unwrap()).unwrap();
    assert!((55..=70).contains(&open.node_count), "node count {}", open.node_count);
    assert!(matches!(open.view, ViewNode::Stack { .. }));
    let info: WorkspaceInfo = serde_json::from_value(c.request("workspace.info", json!({})).await.unwrap()).unwrap();
    assert_eq!(info.activated_plugins.len(), 1);
    assert_eq!(code(c.request("page.open", json!({"resourceId": note})).await), ErrorCode::NotFound);
    assert_eq!(code(c.request("page.open", json!({"resourceId": 999_999})).await), ErrorCode::NotFound);

    // (b) recompute parameters from unsaved text
    let unsaved = "SELECT ':no', \"a:b\" FROM t -- :no\n WHERE a = :alpha AND b::int = :beta /* :no */ OR c = :alpha";
    let r: RecomputeResult = serde_json::from_value(c.request("page.recompute", json!({"resourceId": sql, "unsaved": {"body.sql": unsaved}})).await.unwrap()).unwrap();
    assert_eq!(r.params.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["alpha", "beta"]);

    // host calls from a handler reach kernel storage
    let a = c.request("page.event", json!({"resourceId": sql, "event": "count"})).await.unwrap();
    let b = c.request("page.event", json!({"resourceId": sql, "event": "count"})).await.unwrap();
    assert_eq!(b["count"].as_u64().unwrap(), a["count"].as_u64().unwrap() + 1);

    // a view tree the kernel does not accept is refused
    // (onEvent returns arbitrary JSON here; render path is validated in kernel unit below)

    // server-pushed event
    let mut events = c.events();
    c.request("resource.rename", json!({"resourceId": sql, "name": "renamed"})).await.unwrap();
    let ev = tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
    assert_eq!(ev, Event { event: "resource.changed".into(), payload: json!({"id": sql, "name": "renamed"}) });

    // cancel an in-flight handler by request id
    let id = c.next_id();
    let c2 = c.clone();
    let t = Instant::now();
    let slow = tokio::spawn(async move { c2.request_with_id(id, "page.event", json!({"resourceId": sql, "event": "slow"})).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(c.request("request.cancel", json!({"requestId": id})).await.unwrap()["cancelled"], true);
    assert_eq!(code(slow.await.unwrap()), ErrorCode::Cancelled);
    assert!(t.elapsed() < Duration::from_secs(1));

    // a plugin dead loop: the request fails, the kernel keeps answering meanwhile and afterwards
    let c2 = c.clone();
    let spin = tokio::spawn(async move { c2.request("page.event", json!({"resourceId": sql, "event": "spin"})).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let t = Instant::now();
    c.request("tree.page", json!({"offset": 0, "limit": 10})).await.unwrap();
    assert!(t.elapsed() < Duration::from_millis(150), "kernel blocked by a spinning plugin: {:?}", t.elapsed());
    assert_eq!(code(spin.await.unwrap()), ErrorCode::PluginTimeout);
    c.request("page.open", json!({"resourceId": sql})).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn suite_in_process() {
    short_limits();
    let ws = workspace();
    let kernel = Kernel::open(ws.path(), &plugins_dir(), ks_kernel::config_from_env()).unwrap();
    suite(Arc::new(Client::in_proc(kernel))).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn suite_over_socket() {
    short_limits();
    let ws = workspace();
    let sup = Supervisor::start(spec(ws.path())).await.unwrap();
    suite(Arc::new(Client::supervised(sup))).await;
}

fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

async fn wait_dead(pid: u32, within: Duration) -> Option<Duration> {
    let t = Instant::now();
    while t.elapsed() < within {
        if !alive(pid) {
            return Some(t.elapsed());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    None
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn worker_crash_is_detected_and_restarted() {
    let ws = workspace();
    let sup = Supervisor::start(spec(ws.path())).await.unwrap();
    let restarts = sup.restarts.clone();
    let c = Client::supervised(sup);
    let mut events = c.events();
    let pid1 = c.request("workspace.info", json!({})).await.unwrap()["pid"].as_u64().unwrap();
    c.request("resource.rename", json!({"resourceId": 300, "name": "before crash"})).await.unwrap();
    let _ = events.recv().await;
    // the request that kills the worker fails with WorkerGone, not a hang
    let t = Instant::now();
    assert_eq!(code(c.request("debug.crash", json!({})).await), ErrorCode::WorkerGone);
    // the next request waits for the restart and succeeds
    let info = c.request("workspace.info", json!({})).await.unwrap();
    println!("crash → next successful answer: {:?}", t.elapsed());
    assert_ne!(info["pid"].as_u64().unwrap(), pid1);
    assert_eq!(restarts.load(Ordering::SeqCst), 1);
    let mut seen = vec![];
    while let Ok(Ok(ev)) = tokio::time::timeout(Duration::from_millis(300), events.recv()).await {
        seen.push(ev.event);
    }
    assert_eq!(seen, ["worker.crashed", "worker.restarted"]);
    // committed data survived the crash (WAL)
    let kids = c.request("tree.page", json!({"parent": 50, "offset": 0, "limit": 5})).await.unwrap();
    assert!(kids["nodes"].as_array().unwrap().iter().any(|n| n["name"] == "before crash"), "{kids}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn second_worker_on_same_workspace_is_refused_and_lock_dies_with_the_process() {
    let ws = workspace();
    // first worker, started without a supervisor so nothing restarts it behind our back
    let (mut child, conn) = ks_kernel::transport::spawn_and_connect(&spec(ws.path())).await.unwrap();
    let c = Client::socket(conn);
    let pid = c.request("workspace.info", json!({})).await.unwrap()["pid"].as_u64().unwrap() as u32;
    let second = |sock: PathBuf| {
        std::process::Command::new(WORKER)
            .arg("--workspace").arg(ws.path()).arg("--plugins").arg(plugins_dir()).arg("--socket").arg(sock)
            .stderr(std::process::Stdio::piped())
            .spawn().unwrap()
    };
    let out = second(socket_path()).wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(3), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(ks_kernel::lock_workspace(ws.path()).unwrap().is_none(), "lock is held while the worker lives");
    // kill -9 the first worker: nothing gets a chance to clean up
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let status = tokio::time::timeout(Duration::from_secs(3), child.wait()).await.unwrap().unwrap();
    assert!(!status.success());
    let lock = ks_kernel::lock_workspace(ws.path()).unwrap();
    assert!(lock.is_some(), "lock released by the OS after a crash");
    drop(lock);
    // and a new worker can open the workspace again
    let sup = Supervisor::start(spec(ws.path())).await.unwrap();
    let c = Client::supervised(sup);
    assert_eq!(c.request("workspace.info", json!({})).await.unwrap()["resourceCount"], 10_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn worker_exits_when_main_disappears() {
    use tokio::io::AsyncBufReadExt;
    let ws = workspace();
    let mut main = tokio::process::Command::new(MAINHOST)
        .arg(WORKER).arg(ws.path()).arg(plugins_dir()).arg(socket_path())
        .stdout(std::process::Stdio::piped())
        .spawn().unwrap();
    let mut lines = tokio::io::BufReader::new(main.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(20), lines.next_line()).await.unwrap().unwrap().unwrap();
    let worker_pid: u32 = line.strip_prefix("worker_pid=").unwrap().parse().unwrap();
    assert!(alive(worker_pid));
    // SIGKILL the main side: no destructor, no kill_on_drop, nothing.
    let killed = Instant::now();
    unsafe { libc::kill(main.id().unwrap() as i32, libc::SIGKILL) };
    main.wait().await.unwrap();
    let took = wait_dead(worker_pid, Duration::from_secs(3)).await.expect("worker must exit by itself");
    println!("worker gone {:?} after main was killed (poll wait {:?})", killed.elapsed(), took);
    assert!(ks_kernel::lock_workspace(ws.path()).unwrap().is_some());
}
