//! Measurements for questions 3 and 5. Everything lives in temp dirs.
//! Usage: bench [runtimes] [latency] [cold]   (no args = all)
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ks_kernel::kernel::{seed, Kernel};
use ks_kernel::sandbox::{HostApi, HostFuture, Sandbox, SandboxConfig};
use ks_kernel::transport::{spawn_and_connect, Client, WorkerSpec};
use serde_json::{json, Value};

struct Stats {
    p50: f64,
    p95: f64,
    p99: f64,
    max: f64,
    mean: f64,
}

fn stats(mut v: Vec<f64>) -> Stats {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q = |p: f64| v[(((v.len() - 1) as f64) * p).round() as usize];
    Stats { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: *v.last().unwrap(), mean: v.iter().sum::<f64>() / v.len() as f64 }
}

fn row(name: &str, n: usize, s: &Stats) {
    println!("{name:<44} n={n:<5} p50={:>8.3} ms  p95={:>8.3} ms  p99={:>8.3} ms  max={:>8.3} ms  mean={:>8.3} ms", s.p50, s.p95, s.p99, s.max, s.mean);
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn rss_kb() -> u64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

fn cpu_ms() -> f64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    let tv = |t: libc::timeval| t.tv_sec as f64 * 1000.0 + t.tv_usec as f64 / 1000.0;
    tv(ru.ru_utime) + tv(ru.ru_stime)
}

fn loadavg() -> String {
    let out = std::process::Command::new("sysctl").args(["-n", "vm.loadavg"]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn plugins_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins").canonicalize().unwrap()
}

struct NoHost;
impl HostApi for NoHost {
    fn call(&self, _: &str, _: &str, _: Value) -> HostFuture {
        Box::pin(async { Err("no host".to_string()) })
    }
}

async fn runtimes() {
    println!("\n== Q3: cost of a runtime (50 runtimes) ==");
    let demo: HashMap<String, String> = ["index.js", "params.js"]
        .iter()
        .map(|f| (f.to_string(), std::fs::read_to_string(plugins_dir().join("demo-sql").join(f)).unwrap()))
        .collect();
    let trivial = HashMap::from([("index.js".to_string(), "export default { activate() {} };".to_string())]);
    // Freed memory is not returned to the OS, so the second case reuses pages of
    // the first. `KS_RT_CASE=demo` runs only the demo plugin for a clean figure.
    let only = std::env::var("KS_RT_CASE").ok();
    for (label, files) in [("empty plugin", trivial), ("demo plugin (2 modules, 4 handlers)", demo)] {
        if only.as_deref().is_some_and(|o| !label.starts_with(o)) {
            continue;
        }
        // one throw-away runtime first so one-time process costs are not attributed to the 50
        drop(Sandbox::activate("warm", files.clone(), Arc::new(NoHost), SandboxConfig::default()).await.unwrap());
        let rss0 = rss_kb();
        let mut times = vec![];
        let mut all = vec![];
        for i in 0..50 {
            let t = Instant::now();
            let sb = Sandbox::activate(&format!("p{i}"), files.clone(), Arc::new(NoHost), SandboxConfig::default()).await.unwrap();
            times.push(ms(t));
            all.push(sb);
        }
        let rss1 = rss_kb();
        let mut heap = 0;
        for sb in &all {
            heap += sb.heap_bytes().await;
        }
        row(&format!("create+activate: {label}"), 50, &stats(times));
        println!("    resident memory: {} kB → {} kB = {:.0} kB per idle runtime; QuickJS heap {:.0} kB per runtime", rss0, rss1, (rss1 - rss0) as f64 / 50.0, heap as f64 / 50.0 / 1024.0);
        let cpu0 = cpu_ms();
        tokio::time::sleep(Duration::from_secs(2)).await;
        println!("    CPU used by 50 idle runtimes over 2 s: {:.1} ms", cpu_ms() - cpu0);
        drop(all);
        tokio::time::sleep(Duration::from_millis(100)).await;
        println!("    resident memory after dropping them: {} kB", rss_kb());
    }
}

fn sql_4kb() -> String {
    let mut s = String::from("SELECT o.id, o.day, o.amount, c.name FROM orders o JOIN customers c ON c.id = o.customer_id\nWHERE 1 = 1\n");
    let mut i = 0;
    while s.len() < 4096 {
        s.push_str(&format!("  AND o.col_{0} >= :param_{1} -- filter {0} ':not_a_param'\n", i, i % 20));
        i += 1;
    }
    s.truncate(4096);
    s
}

async fn measure(c: &Client, label: &str, method: &str, params: Value, warm: usize, n: usize) -> Value {
    let mut last = Value::Null;
    for _ in 0..warm {
        last = c.request(method, params.clone()).await.unwrap();
    }
    let mut v = Vec::with_capacity(n);
    for _ in 0..n {
        let p = params.clone();
        let t = Instant::now();
        last = c.request(method, p).await.unwrap();
        v.push(ms(t));
    }
    row(label, n, &stats(v));
    last
}

async fn latency_suite(c: &Client, transport: &str) {
    let kids = c.request("tree.page", json!({"parent": 1, "offset": 0, "limit": 50})).await.unwrap();
    let sql_id = kids["nodes"].as_array().unwrap().iter().find(|n| n["kind"] == "sql").unwrap()["id"].as_i64().unwrap();
    measure(c, &format!("[{transport}] hello (transport baseline)"), "hello", json!({"protocolVersion": 1}), 200, 1000).await;
    let page = measure(c, &format!("[{transport}] tree.page 200 nodes (no plugin)"), "tree.page", json!({"offset": 0, "limit": 200}), 200, 1000).await;
    assert_eq!(page["nodes"].as_array().unwrap().len(), 200);
    let open = measure(c, &format!("[{transport}] (a) page.open → render ~60 nodes"), "page.open", json!({"resourceId": sql_id}), 200, 1000).await;
    let sql = sql_4kb();
    let rec = measure(c, &format!("[{transport}] (b) page.recompute, 4 KB unsaved SQL"), "page.recompute", json!({"resourceId": sql_id, "unsaved": {"body.sql": sql}}), 200, 1000).await;
    println!("    view nodes={} response bytes={}; params found={} request bytes≈{}", open["nodeCount"], open.to_string().len(), rec["params"].as_array().unwrap().len(), sql.len());
}

fn socket_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("ks-bench-{}-{tag}.sock", std::process::id()))
}

fn worker_bin() -> PathBuf {
    std::env::current_exe().unwrap().with_file_name("worker")
}

async fn latency(ws: &Path) {
    println!("\n== Q5 (a)(b): critical path latency, 200 warm-up + 1000 measured, sequential ==");
    let kernel = Kernel::open(ws, &plugins_dir(), SandboxConfig::default()).unwrap();
    latency_suite(&Client::in_proc(kernel.clone()), "in-process").await;
    drop(kernel);
    let spec = WorkerSpec { worker_bin: worker_bin(), workspace: ws.into(), plugins_dir: plugins_dir(), socket: socket_path("lat") };
    let (mut child, client) = spawn_and_connect(&spec).await.unwrap();
    latency_suite(&Client::socket(client), "unix socket").await;
    let _ = child.kill().await;
}

async fn cold(ws: &Path) {
    println!("\n== Q5 (c): cold start, 10,000 rows, first tree page of 200 nodes, zero plugins ==");
    let n = 30;
    let (mut total, mut to_conn, mut db, mut listen) = (vec![], vec![], vec![], vec![]);
    for i in 0..n {
        let spec = WorkerSpec { worker_bin: worker_bin(), workspace: ws.into(), plugins_dir: plugins_dir(), socket: socket_path(&format!("c{i}")) };
        let t = Instant::now();
        let (mut child, client) = spawn_and_connect(&spec).await.unwrap();
        let connected = ms(t);
        let c = Client::socket(client);
        c.request("hello", json!({"protocolVersion": 1})).await.unwrap();
        let page = c.request("tree.page", json!({"offset": 0, "limit": 200})).await.unwrap();
        total.push(ms(t));
        to_conn.push(connected);
        assert_eq!(page["nodes"].as_array().unwrap().len(), 200);
        let info = c.request("workspace.info", json!({})).await.unwrap();
        assert_eq!(info["resourceCount"], 10_000);
        assert_eq!(info["activatedPlugins"].as_array().unwrap().len(), 0);
        db.push(info["boot"]["dbOpenedMs"].as_f64().unwrap());
        listen.push(info["boot"]["listeningMs"].as_f64().unwrap());
        let _ = child.kill().await;
        let _ = child.wait().await;
        let _ = std::fs::remove_file(&spec.socket);
    }
    row("multi-process: spawn → first tree page", n, &stats(total));
    row("  of which spawn → socket connected", n, &stats(to_conn));
    row("  inside worker: main() → db opened", n, &stats(db));
    row("  inside worker: main() → listening", n, &stats(listen));
    let mut inproc = vec![];
    for _ in 0..n {
        let t = Instant::now();
        let kernel = Kernel::open(ws, &plugins_dir(), SandboxConfig::default()).unwrap();
        let c = Client::in_proc(kernel);
        c.request("hello", json!({"protocolVersion": 1})).await.unwrap();
        let page = c.request("tree.page", json!({"offset": 0, "limit": 200})).await.unwrap();
        inproc.push(ms(t));
        assert_eq!(page["nodes"].as_array().unwrap().len(), 200);
    }
    row("single-process: Kernel::open → first tree page", n, &stats(inproc));
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let want = |k: &str| args.is_empty() || args.iter().any(|a| a == k);
    println!("build: {}  cpus: {}  loadavg at start: {}", if cfg!(debug_assertions) { "debug" } else { "release" }, std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0), loadavg());
    let dir = tempfile::tempdir().unwrap();
    let t = Instant::now();
    seed(dir.path(), 10_000).unwrap();
    println!("seeded 10,000 rows in {:.1} ms at {}", ms(t), dir.path().display());
    if want("runtimes") {
        runtimes().await;
    }
    if want("latency") {
        latency(dir.path()).await;
    }
    if want("cold") {
        cold(dir.path()).await;
    }
    println!("\nloadavg at end: {}", loadavg());
}
