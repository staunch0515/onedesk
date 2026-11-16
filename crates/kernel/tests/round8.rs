//! Round 8 (docs/handoff/round8-plan.md §7): page parameters in the page context, `RunError.params`,
//! SHA-256 fingerprints, `ctx.host.transfer`, and the export points `exports.trees` / `exports.pages`.
//! Every plugin here is generated into a temporary folder; HTTP goes to a local temporary server.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::*;
use onedesk_protocol::{ErrorCode, ProtocolError};
use rusqlite::Connection;
use serde_json::{json, Value};

const PROBE: &str = r#"
async function probe(ctx, context) {
  const a = (context && context.args) || {};
  const [cap, op] = String(a.method).split(".");
  try {
    const r = await ctx.host[cap][op](...(a.args || []));
    return [{ type: "copy", text: JSON.stringify({ ok: r === undefined ? null : r }) }];
  } catch (e) {
    return [{ type: "copy", text: JSON.stringify({ error: e.code || String(e), params: e.params || {} }) }];
  }
}
const tryIt = async (f) => { try { return { ok: await f() }; } catch (e) { return { error: e.code || String(e), params: e.params || {} }; } };
const text = (v) => ({ output: { type: "text", text: JSON.stringify(v) } });
"#;

/// Writes `<root>/<id>/<version>/` with a manifest made of the basics plus `extra`.
fn pkg(root: &Path, id: &str, version: &str, extra: Value, main: &str) -> PathBuf {
    let dir = root.join(id).join(version);
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({ "id": id, "version": version, "apiVersion": "2", "name": format!("{id} name"), "icon": "box", "main": "main.js" });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(dir.join("main.js"), format!("{PROBE}\n{main}")).unwrap();
    dir
}

struct W {
    env: Env,
    c: Client,
    #[allow(dead_code)]
    root: PathBuf,
}

async fn world_cfg(build: impl FnOnce(&Path), cfg: impl FnOnce(&mut onedesk_kernel::KernelConfig)) -> W {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    build(&root);
    let mut c = config_for(&root);
    cfg(&mut c);
    let env = open_exact(tmp, &root, c);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    W { env, c, root }
}

async fn world(build: impl FnOnce(&Path)) -> W {
    world_cfg(build, |_| {}).await
}

fn db(env: &Env) -> Connection {
    Connection::open(env.kernel.db_path()).unwrap()
}

fn reason(e: &ProtocolError) -> (ErrorCode, Option<&str>) {
    (e.code, e.params.get("reason").map(String::as_str))
}

async fn detail(c: &Client, id: &str) -> Value {
    c.ok("plugin.get", json!({ "plugin": id })).await
}

async fn wait_run(c: &Client, id: &Value) -> Value {
    for _ in 0..1500 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {id} did not end");
}

async fn start(c: &Client, action: &str, input: Value) -> Value {
    c.ok("run.start", json!({ "action": action, "target": "core:none", "tabId": "t", "input": input })).await
}

async fn run(c: &Client, action: &str, input: Value) -> Value {
    let id = start(c, action, input).await;
    wait_run(c, &id).await
}

fn out(run: &Value) -> Value {
    serde_json::from_str(run["output"]["text"].as_str().unwrap_or_else(|| panic!("no text output: {run}"))).unwrap()
}

fn audit(env: &Env, op: &str) -> Vec<(String, String, String, String)> {
    let conn = db(env);
    let mut st = conn.prepare("SELECT actor, object, summary, result FROM audit WHERE op = ?1 ORDER BY seq").unwrap();
    st.query_map([op], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(|r| r.unwrap()).collect()
}

fn is_sha256(v: &Value) -> bool {
    v.as_str().is_some_and(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
}

/* ------------------------------------------------------------------ §5 page parameters (D358) */

const PARAMS_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.pages.handle("p", {
    async render(ctx) { return { view: [{ type: "text", id: "t", text: JSON.stringify(ctx.params) }] }; },
    async onEvent(ctx, e) {
      if (e === "clear") return { params: { pick: "" }, message: JSON.stringify(ctx.params) };
      if (e === "many") { const p = {}; for (let i = 0; i < 65; i++) p["k" + i] = "v"; return { params: p }; }
      if (e === "long") return { params: { pick: "x".repeat(4097) } };
      if (e === "edge") { const p = {}; for (let i = 0; i < 64; i++) p["k" + i] = "x".repeat(4096); return { params: p }; }
      if (e === "num") return { params: { pick: 1 } };
      return { message: JSON.stringify(ctx.params) };
    },
  });
  host.actions.handle("ls", async (ctx) => { await ctx.host.process.run({ program: "ls" }); return text("ran"); });
} };
"#;

fn params_manifest() -> Value {
    json!({
        "contributes": {
            "kinds": [{ "id": "k", "label": "K", "icon": "box", "tree": "resources", "page": "p", "newName": "k" }],
            "pages": [{ "id": "p" }],
            "actions": [{ "id": "ls", "label": "Ls", "output": "text" }],
            "commands": [{ "id": "probe", "label": "probe" }]
        }
    })
}

#[tokio::test]
async fn page_context_params_reach_render_and_events() {
    let w = world(|r| {
        pkg(r, "t.par", "0.1.0", params_manifest(), PARAMS_MAIN);
    })
    .await;
    let c = &w.c;
    let id = c.ok("page.save", json!({ "target": "new:t.par:k", "changes": { "name": "x" } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    let target = format!("resource:{id}");
    // Absent: an empty object.
    let p = c.ok("page.resolve", json!({ "target": target, "context": {} })).await;
    assert_eq!(p["view"][0]["text"], "{}", "{p}");
    let p = c.ok("page.resolve", json!({ "target": target, "context": { "params": { "pick": "a" } } })).await;
    assert_eq!(p["view"][0]["text"], r#"{"pick":"a"}"#);
    // New-resource pages too.
    let p = c.ok("page.resolve", json!({ "target": "new:t.par:k", "context": { "params": { "pick": "b" } } })).await;
    assert_eq!(p["view"][0]["text"], r#"{"pick":"b"}"#);
    // onEvent sees them, and may answer new ones.
    let e = c.ok("page.event", json!({ "target": target, "event": "look", "context": { "params": { "pick": "a" } } })).await;
    assert_eq!(e["message"], r#"{"pick":"a"}"#);
    assert!(e.get("params").is_none(), "{e}");
    let e = c.ok("page.event", json!({ "target": target, "event": "clear", "context": { "params": { "pick": "a" } } })).await;
    assert_eq!(e["params"], json!({ "pick": "" }), "{e}");
    // Page parameters are not content: nothing goes to the draft, nothing is saved.
    assert!(e.get("changes").is_none(), "{e}");
    let r = c.ok("resource.get", json!({ "id": id })).await;
    assert!(r["body"].get("pick").is_none() && r["rev"] == 1, "{r}");
    // Review #5: text values only, at most 64 keys of at most 4 KB.
    let e = c.ok("page.event", json!({ "target": target, "event": "edge" })).await;
    assert_eq!(e["params"].as_object().unwrap().len(), 64);
    for bad in ["many", "long", "num"] {
        let e = c.call("page.event", json!({ "target": target, "event": bad })).await.unwrap_err();
        assert_eq!(reason(&e), (ErrorCode::Invalid, Some("badParams")), "{bad}: {e:?}");
    }
}

/* ------------------------------------------------------------------ §5 RunError.params (D360) */

#[tokio::test]
async fn run_errors_carry_the_refusals_params() {
    let w = world(|r| {
        pkg(r, "t.par", "0.1.0", params_manifest(), PARAMS_MAIN);
    })
    .await;
    let r = run(&w.c, "t.par:ls", json!({})).await;
    assert_eq!(r["status"], "error", "{r}");
    assert_eq!((r["error"]["code"].as_str(), r["error"]["reason"].as_str()), (Some("denied"), Some("undeclaredProgram")), "{r}");
    assert_eq!(r["error"]["params"], json!({ "program": "ls" }), "{r}");
}

/* ------------------------------------------------------------------ §5 SHA-256 fingerprints (D359) */

/// The fingerprint rounds 4–7 showed (FNV-1a 64 of the atom list, then `-<length>`).
fn old_fingerprint(atoms: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in atoms.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:016x}-{}", h, atoms.len())
}

#[tokio::test]
async fn install_fingerprints_are_sha256_and_confirmations_survive_reopening() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    pkg(&root, "t.fs", "0.1.0", json!({ "requires": { "files": true } }), "export default { activate() {} };");
    let ws = tmp.path().join("ws");
    // Not built in: its permissions wait for the user.
    let kernel = std::sync::Arc::new(onedesk_kernel::Kernel::open(&ws, &root, test_config()).unwrap());
    let c = Client::in_proc(kernel.clone());
    c.hello().await;
    let d = detail(&c, "t.fs").await;
    assert_eq!(d["unconfirmed"], json!(["0.1.0"]));
    let fp = d["versions"][0]["fingerprint"].clone();
    assert!(is_sha256(&fp), "{fp}");
    // The previous algorithm's fingerprint no longer confirms anything.
    let e = c.call("plugin.confirmPermissions", json!({ "plugin": "t.fs", "version": "0.1.0", "fingerprint": old_fingerprint("files") })).await.unwrap_err();
    assert_eq!(reason(&e), (ErrorCode::Invalid, Some("fingerprintMismatch")));
    c.ok("plugin.confirmPermissions", json!({ "plugin": "t.fs", "version": "0.1.0", "fingerprint": fp })).await;
    assert_eq!(detail(&c, "t.fs").await["unconfirmed"], json!([]));
    // What is stored is the confirmed permission list itself (as in rounds 4–7), not a hash: a
    // workspace confirmed before round 8 needs no conversion (D359's "equivalent" upgrade).
    let body: String = Connection::open(kernel.db_path()).unwrap()
        .query_row("SELECT body FROM resources WHERE kind = 'core:plugin-state' AND name = 't.fs'", [], |r| r.get(0))
        .unwrap();
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["params"]["confirmed.0.1.0"]["value"], "files", "{body}");
    drop(c);
    drop(kernel);
    // Reopened: still confirmed (what is stored is the confirmed permission list, not a hash).
    let kernel = std::sync::Arc::new(onedesk_kernel::Kernel::open(&ws, &root, test_config()).unwrap());
    let c = Client::in_proc(kernel.clone());
    c.hello().await;
    assert_eq!(detail(&c, "t.fs").await["unconfirmed"], json!([]));
    assert_eq!(detail(&c, "t.fs").await["load"]["state"], "loaded");
}

#[tokio::test]
async fn import_fingerprints_are_sha256() {
    let w = world(|r| {
        pkg(r, "t.par", "0.1.0", params_manifest(), PARAMS_MAIN);
    })
    .await;
    let c = &w.c;
    c.ok("page.save", json!({ "target": "new:t.par:k", "changes": { "name": "x" } })).await;
    let folder = w.env.path().join("out");
    c.ok("workspace.export", json!({ "folder": folder })).await;
    let p = c.ok("workspace.importPreview", json!({ "folder": folder })).await;
    assert!(is_sha256(&p["fingerprint"]), "{p}");
    let r = c.ok("workspace.import", json!({ "folder": folder, "fingerprint": p["fingerprint"] })).await;
    assert!(r["created"].as_u64().unwrap() >= 1, "{r}");
}

/* ------------------------------------------------------------------ §3 transfer (D353–D355) */

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Bigger than the sandbox's memory limit in tests (16 MB): content that went through the plugin
/// would not fit.
const BIG: usize = 24 * 1024 * 1024 + 123;

fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| ((i * 7 + 3) % 251) as u8).collect()
}

fn checksum(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |a, x| a.wrapping_mul(31).wrapping_add(u64::from(*x)))
}

/// `GET /big` → `BIG` bytes of `pattern`; `/missing` → 404; `/slow` → headers, then 1 KB every
/// 200 ms for a long time; `/late` → waits 2.5 s, then "late"; `/echo` → the Authorization header
/// in the body and in `X-Echo`; `/redirect?to=` → 302; `PUT|POST /up` → reads the body (slowly)
/// and answers `<method> len=<n> sum=<checksum>`.
async fn server() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { break };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                let mut got = Vec::new();
                let end = loop {
                    if let Some(i) = got.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    got.extend_from_slice(&buf[..n]);
                };
                let head = String::from_utf8_lossy(&got[..end]).to_string();
                let method = head.split_whitespace().next().unwrap_or("").to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let header = |name: &str| {
                    head.lines()
                        .find(|l| l.to_ascii_lowercase().starts_with(&format!("{name}:")))
                        .map(|l| l[name.len() + 1..].trim().to_string())
                        .unwrap_or_default()
                };
                let reply = |status: &str, extra: String, body: Vec<u8>| {
                    let mut r = format!("HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
                    r.extend_from_slice(&body);
                    r
                };
                // Any body is read first (a 307 must not cut the client off while it sends).
                let len: usize = header("content-length").parse().unwrap_or(0);
                let mut body = got[end..].to_vec();
                while body.len() < len {
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    body.extend_from_slice(&buf[..n]);
                    if path == "/up" {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                }
                let resp = if path == "/big" {
                    reply("200 OK", String::new(), pattern(BIG))
                } else if path == "/missing" {
                    reply("404 Not Found", String::new(), b"nope".to_vec())
                } else if path == "/late" {
                    tokio::time::sleep(Duration::from_millis(2500)).await;
                    reply("200 OK", String::new(), b"late".to_vec())
                } else if path == "/slow" {
                    let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000000\r\nConnection: close\r\n\r\n").await;
                    for _ in 0..500 {
                        if s.write_all(&[b'z'; 1024]).await.is_err() {
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                    return;
                } else if path == "/echo" {
                    let auth = header("authorization");
                    reply("200 OK", format!("X-Echo: {auth}\r\n"), format!("auth={auth}").into_bytes())
                } else if path.starts_with("/redirect") {
                    let to = path.split_once("to=").map(|(_, t)| t.to_string()).unwrap_or_default();
                    reply("307 Temporary Redirect", format!("Location: {to}\r\n"), vec![])
                } else if path == "/up" {
                    let auth = header("authorization");
                    reply("201 Created", String::new(), format!("{method} len={} sum={} auth={auth}", body.len(), checksum(&body)).into_bytes())
                } else {
                    reply("200 OK", String::new(), b"hello".to_vec())
                };
                let _ = s.write_all(&resp).await;
            });
        }
    });
    port
}

const MOVE_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.pages.handle("p", {
    async render(ctx) {
      const r = await tryIt(() => ctx.host.transfer.download({ url: "http://127.0.0.1:9/", to: "/x" }));
      return { view: [{ type: "text", id: "t", text: JSON.stringify(r) }] };
    },
    async onEvent(ctx) {
      const r = await tryIt(() => ctx.host.transfer.capture({ program: "cat", to: "/x" }));
      return { message: JSON.stringify(r) };
    },
  });
  host.actions.handle("go", async (ctx, input) => {
    const opts = Object.assign({}, input.opts);
    const seen = [];
    if (input.progress) opts.onProgress = (p) => {
      seen.push(p);
      ctx.progress(0.5);
      if (input.throwAt !== undefined && seen.length >= input.throwAt) throw new Error("stop here");
    };
    const r = await tryIt(() => ctx.host.transfer[input.op](opts));
    if (r.error && !r.error.startsWith("Error")) {} else if (r.error) r.error = "threw";
    r.seen = seen.length;
    r.last = seen.length ? seen[seen.length - 1] : null;
    return text(r);
  });
  host.actions.handle("chain", async (ctx, input) => {
    const ps = [];
    for (let i = 0; i < input.n; i++) {
      ps.push(ctx.host.process.run({ program: "sleep", args: ["1.5"], timeoutMs: 10000 }));
      await ctx.host.util.sleep(1000);
    }
    await Promise.all(ps);
    return text("ok");
  });
  host.events.on("resource.changed", async (ctx) => {
    const r = await tryIt(() => ctx.host.transfer.download({ url: "http://127.0.0.1:9/", to: "/x" }));
    await ctx.host.storage.set("ev", r);
  });
  host.actions.handle("budget", async (ctx, input) => {
    await ctx.host.util.sleep(input.before);
    const r = await tryIt(() => input.op === "process" ? ctx.host.process.run(input.opts) : ctx.host.transfer[input.op](input.opts));
    await ctx.host.util.sleep(input.after);
    return text(r.error ? r : "ok");
  });
} };
"#;

fn move_manifest(port: u16, requires: Value) -> Value {
    let _ = port;
    json!({
        "requires": requires,
        "contributes": {
            "kinds": [{ "id": "k", "label": "K", "icon": "box", "tree": "resources", "page": "p", "newName": "k" }],
            "pages": [{ "id": "p" }],
            "actions": [{ "id": "go", "label": "Go", "output": "text" }, { "id": "budget", "label": "B", "output": "text" },
                        { "id": "chain", "label": "C", "output": "text" }],
            "commands": [{ "id": "probe", "label": "probe" }],
            "events": ["resource.changed"]
        }
    })
}

fn full_requires(port: u16) -> Value {
    json!({
        "files": true,
        "network": { "hosts": [format!("127.0.0.1:{port}"), format!("*.localhost:{port}")] },
        "secrets": { "names": ["tok"] },
        "programs": [{ "name": "cat", "source": "system" }, { "name": "sh", "source": "system" }, { "name": "sleep", "source": "system" }]
    })
}

struct T {
    w: W,
    port: u16,
    grant: PathBuf,
    outside: PathBuf,
}

impl T {
    fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    fn at(&self, name: &str) -> String {
        self.grant.join(name).display().to_string()
    }
    async fn go(&self, plugin: &str, op: &str, opts: Value) -> Value {
        self.go_with(plugin, json!({ "op": op, "opts": opts })).await
    }
    async fn go_with(&self, plugin: &str, input: Value) -> Value {
        let r = run(&self.w.c, &format!("{plugin}:go"), input).await;
        assert_eq!(r["status"], "success", "{r}");
        out(&r)
    }
    /// Names in the granted folder (partial files included).
    fn listing(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(&self.grant).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
    fn no_partials(&self) {
        assert!(!self.listing().iter().any(|n| n.contains(".part-")), "{:?}", self.listing());
    }
    async fn no_programs_left(&self) {
        for _ in 0..200 {
            if self.w.env.kernel.live_programs() == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("programs still running");
    }
}

async fn transfer_world_cfg(cfg: impl FnOnce(&mut onedesk_kernel::KernelConfig)) -> T {
    let port = server().await;
    let w = world_cfg(
        |r| {
            pkg(r, "t.move", "0.1.0", move_manifest(port, full_requires(port)), MOVE_MAIN);
            pkg(r, "t.nofiles", "0.1.0", move_manifest(port, json!({ "network": { "hosts": [format!("127.0.0.1:{port}")] },
                "programs": [{ "name": "cat", "source": "system" }] })), MOVE_MAIN);
            pkg(r, "t.nonet", "0.1.0", move_manifest(port, json!({ "files": true })), MOVE_MAIN);
        },
        cfg,
    )
    .await;
    let base = w.env.path();
    let grant = base.join("grant");
    let outside = base.join("outside");
    std::fs::create_dir_all(&grant).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    for p in ["t.move", "t.nonet"] {
        w.c.ok("plugin.grantFolder", json!({ "plugin": p, "path": grant.display().to_string() })).await;
    }
    T { w, port, grant, outside }
}

async fn transfer_world() -> T {
    transfer_world_cfg(|c| c.action_timeout = Duration::from_secs(20)).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn download_moves_more_than_the_sandbox_holds_byte_for_byte() {
    let t = transfer_world().await;
    let r = t.go_with("t.move", json!({ "op": "download", "progress": true, "opts": { "url": format!("{}/big", t.base()), "to": t.at("big.bin") } })).await;
    assert_eq!((r["ok"]["status"].as_u64(), r["ok"]["bytes"].as_u64()), (Some(200), Some(BIG as u64)), "{r}");
    assert_eq!(r["ok"]["path"], t.at("big.bin"));
    assert_eq!(std::fs::read(t.grant.join("big.bin")).unwrap(), pattern(BIG));
    // Progress came, with the total from Content-Length.
    assert!(r["seen"].as_u64().unwrap() >= 1, "{r}");
    assert_eq!(r["last"]["total"].as_u64(), Some(BIG as u64));
    t.no_partials();
    // Audited once, by host; the summary has bytes, status, time and the file, not the address path.
    let a = audit(&t.w.env, "transfer.download");
    assert_eq!(a.len(), 1);
    assert_eq!((a[0].0.as_str(), a[0].1.as_str(), a[0].3.as_str()), ("plugin:t.move@0.1.0", "127.0.0.1", "ok"), "{a:?}");
    let s: Value = serde_json::from_str(&a[0].2).unwrap();
    assert_eq!((s["bytes"].as_u64(), s["status"].as_u64(), s["path"].as_str()), (Some(BIG as u64), Some(200), Some(t.at("big.bin").as_str())));
    assert!(s["ms"].is_u64() && !a[0].2.contains("http:") && s.get("url").is_none(), "{s}");
    assert!(audit(&t.w.env, "network.request").is_empty(), "not recorded twice");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_sends_a_file_bigger_than_the_sandbox() {
    let t = transfer_world().await;
    let data = pattern(BIG);
    std::fs::write(t.grant.join("src.bin"), &data).unwrap();
    let r = t.go_with("t.move", json!({ "op": "upload", "progress": true, "opts": { "from": t.at("src.bin"), "url": format!("{}/up", t.base()) } })).await;
    assert_eq!(r["ok"]["status"].as_u64(), Some(201), "{r}");
    assert_eq!(r["ok"]["body"], format!("PUT len={BIG} sum={} auth=", checksum(&data)));
    assert_eq!(r["ok"]["truncated"], false);
    assert!(r["seen"].as_u64().unwrap() >= 1, "{r}");
    assert_eq!(r["last"]["total"].as_u64(), Some(BIG as u64));
    // POST too; a method without a body is refused.
    let r = t.go("t.move", "upload", json!({ "from": t.at("src.bin"), "url": format!("{}/up", t.base()), "method": "POST" })).await;
    assert!(r["ok"]["body"].as_str().unwrap().starts_with("POST len="), "{r}");
    let r = t.go("t.move", "upload", json!({ "from": t.at("src.bin"), "url": format!("{}/up", t.base()), "method": "GET" })).await;
    assert_eq!((r["error"].as_str(), r["params"]["reason"].as_str()), (Some("invalid"), Some("badMethod")));
    // A 307 sends the file again.
    let r = t.go("t.move", "upload", json!({ "from": t.at("src.bin"), "url": format!("{}/redirect?to=/up", t.base()) })).await;
    assert_eq!(r["ok"]["body"], format!("PUT len={BIG} sum={} auth=", checksum(&data)), "{r}");
    let a = audit(&t.w.env, "transfer.upload");
    assert_eq!(a.iter().map(|x| x.3.as_str()).collect::<Vec<_>>(), ["ok", "ok", "failed:invalid", "ok"], "{a:?}");
    assert_eq!(a[0].1, "127.0.0.1");
    let s: Value = serde_json::from_str(&a[0].2).unwrap();
    assert_eq!((s["bytes"].as_u64(), s["status"].as_u64(), s["method"].as_str()), (Some(BIG as u64), Some(201), Some("PUT")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_writes_a_programs_output_to_a_file() {
    let t = transfer_world().await;
    let data = pattern(BIG);
    std::fs::write(t.grant.join("src.bin"), &data).unwrap();
    let r = t.go_with("t.move", json!({ "op": "capture", "progress": true, "opts": { "program": "cat", "args": [t.at("src.bin")], "to": t.at("copy.bin") } })).await;
    assert_eq!((r["ok"]["code"].as_i64(), r["ok"]["bytes"].as_u64()), (Some(0), Some(BIG as u64)), "{r}");
    assert_eq!(r["ok"]["path"], t.at("copy.bin"));
    assert!(r["ok"].get("stdout").is_none());
    assert_eq!(std::fs::read(t.grant.join("copy.bin")).unwrap(), data);
    assert!(r["seen"].as_u64().unwrap() >= 1, "{r}");
    // Any exit code: the file is put in place, stderr comes back.
    let r = t.go("t.move", "capture", json!({ "program": "sh", "args": ["-c", "echo out; echo err >&2; exit 3"], "to": t.at("x.txt") })).await;
    assert_eq!((r["ok"]["code"].as_i64(), r["ok"]["stderr"].as_str(), r["ok"]["bytes"].as_u64()), (Some(3), Some("err\n"), Some(4)), "{r}");
    assert_eq!(std::fs::read_to_string(t.grant.join("x.txt")).unwrap(), "out\n");
    t.no_partials();
    let a = audit(&t.w.env, "transfer.capture");
    assert_eq!(a.iter().map(|x| x.1.as_str()).collect::<Vec<_>>(), ["cat", "sh"]);
    let s: Value = serde_json::from_str(&a[1].2).unwrap();
    assert_eq!((s["code"].as_i64(), s["bytes"].as_u64(), s["args"].as_u64()), (Some(3), Some(4), Some(2)), "{s}");
    assert!(!a[1].2.contains("echo"), "no argument content");
    assert!(audit(&t.w.env, "process.run").is_empty(), "not recorded twice");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_end_refuses_by_its_own_rules() {
    let t = transfer_world().await;
    let c = &t.w.c;
    let why = |v: &Value| (v["error"].as_str().unwrap_or("ok").to_string(), v["params"]["reason"].as_str().unwrap_or("").to_string());
    let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
    // Network end: not listed; a redirect to an unlisted host; network.allow.
    let r = t.go("t.move", "download", json!({ "url": "http://example.invalid/x", "to": t.at("a") })).await;
    assert_eq!(why(&r), pair("denied", "hostNotAllowed"));
    let r = t.go("t.move", "download", json!({ "url": format!("{}/redirect?to=http://localhost:{}/big", t.base(), t.port), "to": t.at("a") })).await;
    assert_eq!(why(&r), pair("denied", "hostNotAllowed"));
    // A wildcard host that resolves to a loopback address: refused unless written out (D308).
    let r = t.go("t.move", "download", json!({ "url": format!("http://a.localhost:{}/big", t.port), "to": t.at("a") })).await;
    assert_eq!(why(&r), pair("denied", "localAddress"));
    let ws_cfg = c.ok("tree.children", json!({ "tree": "config" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    c.ok("params.set", json!({ "node": ws_cfg, "name": "network.allow", "value": "api.example.com", "type": "list" })).await;
    let r = t.go("t.move", "download", json!({ "url": format!("{}/big", t.base()), "to": t.at("a") })).await;
    assert_eq!(why(&r), pair("denied", "blockedByPolicy"));
    let r = t.go("t.move", "upload", json!({ "url": format!("{}/up", t.base()), "from": t.at("none") })).await;
    assert_eq!(r["error"], "notFound", "{r}");
    std::fs::write(t.grant.join("src.txt"), "abc").unwrap();
    let r = t.go("t.move", "upload", json!({ "url": format!("{}/up", t.base()), "from": t.at("src.txt") })).await;
    assert_eq!(why(&r), pair("denied", "blockedByPolicy"));
    c.ok("params.set", json!({ "node": ws_cfg, "name": "network.allow", "value": format!("127.0.0.1:{}", t.port) })).await;
    // File end: outside the grant, a symlink out of it (folder and file), relative.
    let r = t.go("t.move", "download", json!({ "url": format!("{}/big", t.base()), "to": t.outside.join("a").display().to_string() })).await;
    assert_eq!(why(&r), pair("denied", "outsideGrant"));
    std::os::unix::fs::symlink(&t.outside, t.grant.join("linkdir")).unwrap();
    std::fs::write(t.outside.join("secret.txt"), "outside").unwrap();
    std::os::unix::fs::symlink(t.outside.join("secret.txt"), t.grant.join("link.txt")).unwrap();
    let r = t.go("t.move", "download", json!({ "url": format!("{}/big", t.base()), "to": t.at("linkdir/a") })).await;
    assert_eq!(why(&r), pair("denied", "outsideGrant"));
    let r = t.go("t.move", "upload", json!({ "url": format!("{}/up", t.base()), "from": t.at("link.txt") })).await;
    assert_eq!(why(&r), pair("denied", "outsideGrant"));
    let r = t.go("t.move", "capture", json!({ "program": "cat", "args": [], "to": t.at("linkdir/c") })).await;
    assert_eq!(why(&r), pair("denied", "outsideGrant"));
    let r = t.go("t.move", "download", json!({ "url": format!("{}/big", t.base()), "to": "rel/a" })).await;
    assert_eq!(why(&r), pair("denied", "notAbsolute"));
    assert!(!t.outside.join("a").exists() && !t.outside.join("c").exists());
    // Program end: undeclared; process.allow.
    let r = t.go("t.move", "capture", json!({ "program": "ls", "to": t.at("c") })).await;
    assert_eq!((why(&r), r["params"]["program"].as_str()), (pair("denied", "undeclaredProgram"), Some("ls")));
    c.ok("params.set", json!({ "node": ws_cfg, "name": "process.allow", "value": "cat", "type": "list" })).await;
    let r = t.go("t.move", "capture", json!({ "program": "sh", "args": ["-c", "echo"], "to": t.at("c") })).await;
    assert_eq!((why(&r), r["params"]["program"].as_str()), (pair("denied", "blockedByPolicy"), Some("sh")));
    // The program end's environment rules: no dynamic-loader variables.
    for var in ["DYLD_INSERT_LIBRARIES", "LD_PRELOAD"] {
        let r = t.go("t.move", "capture", json!({ "program": "cat", "env": { var: "/tmp/x.dylib" }, "to": t.at("c") })).await;
        assert_eq!(why(&r), pair("invalid", "badEnv"), "{var}");
    }
    // The manifest does not ask for the capability.
    let r = t.go("t.nofiles", "download", json!({ "url": format!("{}/big", t.base()), "to": t.at("a") })).await;
    assert_eq!(why(&r), pair("denied", "notRequested"));
    let r = t.go("t.nofiles", "capture", json!({ "program": "cat", "to": t.at("a") })).await;
    assert_eq!(why(&r), pair("denied", "notRequested"));
    let r = t.go("t.nonet", "download", json!({ "url": format!("{}/big", t.base()), "to": t.at("a") })).await;
    assert_eq!(why(&r), pair("denied", "notRequested"));
    let r = t.go("t.nonet", "upload", json!({ "url": format!("{}/up", t.base()), "from": t.at("src.txt") })).await;
    assert_eq!(why(&r), pair("denied", "notRequested"));
    let r = t.go("t.nonet", "capture", json!({ "program": "cat", "to": t.at("a") })).await;
    assert_eq!(why(&r), pair("denied", "undeclaredProgram"));
    // Not in a run: a command, a page render.
    let r = c.probe("t.move", "transfer.download", json!([{ "url": format!("{}/big", t.base()), "to": t.at("a") }])).await;
    assert_eq!(why(&r), pair("denied", "notInRun"));
    let r = c.probe("t.move", "transfer.capture", json!([{ "program": "cat", "to": t.at("a") }])).await;
    assert_eq!(why(&r), pair("denied", "notInRun"));
    let id = c.ok("page.save", json!({ "target": "new:t.move:k", "changes": { "name": "x" } })).await["page"]["resourceId"].as_str().unwrap().to_string();
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{id}") })).await;
    let v: Value = serde_json::from_str(p["view"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!((v["error"].as_str(), v["params"]["reason"].as_str()), (Some("denied"), Some("notInRun")));
    // A page event, an event subscription.
    let e = c.ok("page.event", json!({ "target": format!("resource:{id}"), "event": "x" })).await;
    let v: Value = serde_json::from_str(e["message"].as_str().unwrap()).unwrap();
    assert_eq!((v["error"].as_str(), v["params"]["reason"].as_str()), (Some("denied"), Some("notInRun")));
    let mut ev = Value::Null;
    for _ in 0..200 {
        ev = c.probe("t.move", "storage.get", json!(["ev"])).await["ok"].clone();
        if !ev.is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!((ev["error"].as_str(), ev["params"]["reason"].as_str()), (Some("denied"), Some("notInRun")), "{ev}");
    // Nothing was written anywhere; every refusal is audited under its host or program.
    assert_eq!(t.listing(), ["link.txt", "linkdir", "src.txt"]);
    let refused: Vec<(String, String)> = audit(&t.w.env, "transfer.download").into_iter().filter(|a| a.3 != "ok").map(|a| (a.1, a.3)).collect();
    assert!(refused.len() >= 8, "{refused:?}");
    assert!(refused.iter().any(|(o, _)| o == "example.invalid"), "{refused:?}");
    let caps: Vec<String> = audit(&t.w.env, "transfer.capture").into_iter().map(|a| a.1).collect();
    assert!(caps.contains(&"ls".to_string()) && caps.contains(&"sh".to_string()), "{caps:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn secrets_are_substituted_and_scrubbed() {
    let t = transfer_world().await;
    let c = &t.w.c;
    c.ok("secrets.set", json!({ "name": "tok", "value": "Transfer-Secret-9" })).await;
    let r = t.go("t.move", "download", json!({ "url": format!("{}/echo", t.base()), "to": t.at("e.txt"), "headers": { "Authorization": "Bearer {{secret:tok}}" } })).await;
    // The server got the value; what comes back to the plugin does not carry it.
    assert_eq!(std::fs::read_to_string(t.grant.join("e.txt")).unwrap(), "auth=Bearer Transfer-Secret-9");
    assert!(!r.to_string().contains("Transfer-Secret-9"), "{r}");
    assert_eq!(r["ok"]["headers"]["x-echo"].as_str().map(|s| s.contains("Transfer-Secret-9")), Some(false));
    std::fs::write(t.grant.join("s.txt"), "x").unwrap();
    let r = t.go("t.move", "upload", json!({ "url": format!("{}/up", t.base()), "from": t.at("s.txt"), "headers": { "Authorization": "{{secret:tok}}" } })).await;
    assert_eq!(r["ok"]["status"].as_u64(), Some(201), "{r}");
    assert!(!r.to_string().contains("Transfer-Secret-9"), "{r}");
    // A name the plugin may not use.
    let r = t.go("t.move", "download", json!({ "url": format!("{}/echo", t.base()), "to": t.at("f.txt"), "headers": { "Authorization": "{{secret:other}}" } })).await;
    assert_eq!(r["params"]["reason"], "secretNotAllowed", "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn non_2xx_existing_targets_and_overwrite() {
    let t = transfer_world().await;
    let r = t.go("t.move", "download", json!({ "url": format!("{}/missing", t.base()), "to": t.at("m.txt") })).await;
    assert_eq!((r["ok"]["status"].as_u64(), r["ok"]["bytes"].as_u64()), (Some(404), Some(0)), "{r}");
    assert!(r["ok"].get("path").is_none());
    assert!(t.listing().is_empty(), "{:?}", t.listing());
    std::fs::write(t.grant.join("have.txt"), "old").unwrap();
    let r = t.go("t.move", "download", json!({ "url": format!("{}/echo", t.base()), "to": t.at("have.txt") })).await;
    assert_eq!((r["error"].as_str(), r["params"]["reason"].as_str()), (Some("conflict"), Some("exists")), "{r}");
    let r = t.go("t.move", "capture", json!({ "program": "sh", "args": ["-c", "echo new"], "to": t.at("have.txt") })).await;
    assert_eq!(r["params"]["reason"], "exists", "{r}");
    assert_eq!(std::fs::read_to_string(t.grant.join("have.txt")).unwrap(), "old");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(t.grant.join("have.txt"), std::fs::Permissions::from_mode(0o600)).unwrap();
    let r = t.go("t.move", "download", json!({ "url": format!("{}/echo", t.base()), "to": t.at("have.txt"), "overwrite": true })).await;
    assert_eq!(r["ok"]["bytes"].as_u64(), Some(5), "{r}");
    // Review #6: overwriting keeps the file's permissions.
    assert_eq!(std::fs::metadata(t.grant.join("have.txt")).unwrap().permissions().mode() & 0o7777, 0o600);
    assert_eq!(std::fs::read_to_string(t.grant.join("have.txt")).unwrap(), "auth=");
    let r = t.go("t.move", "capture", json!({ "program": "sh", "args": ["-c", "echo new"], "to": t.at("have.txt"), "overwrite": true })).await;
    assert_eq!(r["ok"]["code"].as_i64(), Some(0), "{r}");
    assert_eq!(std::fs::read_to_string(t.grant.join("have.txt")).unwrap(), "new\n");
    // The parent must exist; a folder is no target.
    let r = t.go("t.move", "download", json!({ "url": format!("{}/echo", t.base()), "to": t.at("no/such/x") })).await;
    assert_eq!(r["error"], "notFound", "{r}");
    std::fs::create_dir(t.grant.join("dir")).unwrap();
    let r = t.go("t.move", "download", json!({ "url": format!("{}/echo", t.base()), "to": t.at("dir"), "overwrite": true })).await;
    assert_eq!(r["params"]["reason"], "notFile", "{r}");
    t.no_partials();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn timeouts_cancellation_and_a_failing_callback_leave_no_partial_file() {
    let t = transfer_world().await;
    let c = &t.w.c;
    // Timeout (download, capture): nothing left, the program's group ended.
    let r = t.go("t.move", "download", json!({ "url": format!("{}/slow", t.base()), "to": t.at("s.bin"), "timeoutMs": 700 })).await;
    assert_eq!((r["error"].as_str(), r["params"]["reason"].as_str()), (Some("invalid"), Some("timeout")), "{r}");
    t.no_partials();
    let r = t.go("t.move", "capture", json!({ "program": "sh", "args": ["-c", "echo part; sleep 30"], "to": t.at("c.txt"), "timeoutMs": 500 })).await;
    assert_eq!((r["error"].as_str(), r["params"]["reason"].as_str()), (Some("invalid"), Some("timeout")), "{r}");
    t.no_partials();
    t.no_programs_left().await;
    assert!(t.listing().is_empty(), "{:?}", t.listing());
    // Cancelling the run while it is writing.
    for (op, opts) in [
        ("download", json!({ "url": format!("{}/slow", t.base()), "to": t.at("s.bin") })),
        ("capture", json!({ "program": "sh", "args": ["-c", "while true; do echo part; sleep 0.1; done"], "to": t.at("c.txt") })),
    ] {
        let id = start(c, "t.move:go", json!({ "op": op, "opts": opts })).await;
        for _ in 0..200 {
            if t.listing().iter().any(|n| n.contains(".part-")) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(t.listing().iter().any(|n| n.contains(".part-")), "{op}: a partial file while it runs");
        tokio::time::sleep(Duration::from_millis(300)).await;
        c.ok("run.cancel", json!({ "id": id })).await;
        let r = wait_run(c, &id).await;
        assert_eq!(r["status"], "cancelled", "{r}");
        for _ in 0..100 {
            if !t.listing().iter().any(|n| n.contains(".part-")) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        t.no_partials();
        assert!(t.listing().is_empty(), "{op}: {:?}", t.listing());
    }
    t.no_programs_left().await;
    // A callback that throws stops the transfer; the error is the callback's.
    let r = t.go_with("t.move", json!({ "op": "download", "progress": true, "throwAt": 1, "opts": { "url": format!("{}/slow", t.base()), "to": t.at("s.bin") } })).await;
    assert_eq!(r["error"], "threw", "{r}");
    t.no_partials();
    assert!(t.listing().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn waiting_for_transfers_and_programs_does_not_use_the_budget() {
    // A 2 s action budget.
    let t = transfer_world_cfg(|c| c.action_timeout = Duration::from_secs(2)).await;
    let c = &t.w.c;
    let late = json!({ "url": format!("{}/late", t.base()), "to": t.at("late.txt") });
    let sleep3 = json!({ "program": "sleep", "args": ["2.5"], "timeoutMs": 10000 });
    for (op, opts) in [("download", late.clone()), ("process", sleep3.clone())] {
        // 1.2 s counted + 2.5 s waiting: fine.
        let r = run(c, "t.move:budget", json!({ "op": op, "opts": opts, "before": 1200, "after": 0 })).await;
        assert_eq!((r["status"].as_str(), out(&r)), (Some("success"), json!("ok")), "{op}: {r}");
        let _ = std::fs::remove_file(t.grant.join("late.txt"));
        // The budget is not reset by the wait: 1.2 s + 1.2 s counted is over 2 s.
        let r = run(c, "t.move:budget", json!({ "op": op, "opts": opts, "before": 1200, "after": 1200 })).await;
        assert_eq!((r["status"].as_str(), r["error"]["code"].as_str()), (Some("error"), Some("timeout")), "{op}: {r}");
        let _ = std::fs::remove_file(t.grant.join("late.txt"));
    }
}

/* ------------------------------------------------------------------ §4 exports.trees / exports.pages (D356–D357) */

const BOARD_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.pages.handle("card", {
    async render(ctx) {
      const r = ctx.resource || {};
      let get = null, upd = null;
      if (r.id) {
        const g = await tryIt(() => ctx.host.resources.get(r.id));
        get = g.ok ? Object.keys(g.ok.body).sort() : g;
        upd = await tryIt(() => ctx.host.resources.update(r.id, { name: "by owner" }));
      }
      return { view: [
        { type: "form", id: "f", layout: "stack", fields: [{ name: "text", label: "Text", kind: "text", bind: "body.text" }] },
        { type: "text", id: "info", text: JSON.stringify({ kind: r.kind, readOnly: r.readOnly || false, keys: Object.keys(r.body || {}).sort(), get, upd,
            draft: Object.keys(ctx.draft || {}).sort(),
            run: ctx.run ? Object.keys(ctx.run).filter((k) => ["input", "summary", "error", "output"].includes(k)).sort() : null }) },
      ] };
    },
    async onEvent(ctx, e) {
      const r = ctx.resource || {};
      const upd = await tryIt(() => ctx.host.resources.update(r.id, { name: "by owner" }));
      const del = await tryIt(() => ctx.host.resources.remove(r.id));
      return { changes: { "body.text": "from event" }, message: JSON.stringify({ upd, del, kind: r.kind, keys: Object.keys(r.body || {}).sort() }) };
    },
    async renderResultTab(ctx) { return [{ type: "text", id: "v", text: "owner view" }]; },
  });
  host.actions.handle("go", async () => text("board go"));
  host.actions.handle("peek", async (ctx) => text(await tryIt(() => ctx.host.resources.list({ kind: "t.extra:memo" }))));
} };
"#;

fn board_manifest(exports: bool) -> Value {
    let mut m = json!({
        "contributes": {
            "trees": [{ "id": "board", "label": "Board", "icon": "layout", "source": "stored" }],
            "kinds": [{ "id": "card", "label": "Card", "icon": "square", "tree": "board", "page": "card", "newName": "card",
                        "accepts": ["t.extra:memo"] }],
            "pages": [{ "id": "card",
                        "actions": [{ "id": "save", "role": "save", "label": "Save" }, { "id": "ev", "role": "event", "label": "Ev" },
                                    { "id": "go", "role": "run", "label": "Go", "action": "go" }],
                        "resultTabs": [{ "id": "out", "type": "output", "label": "Out" }, { "id": "v", "type": "view", "label": "V" }] }],
            "actions": [{ "id": "go", "label": "Go", "output": "text", "kinds": ["card"] }, { "id": "peek", "label": "Peek", "output": "text" }],
            "menus": { "new": ["card"] },
            "commands": [{ "id": "probe", "label": "probe" }]
        }
    });
    if exports {
        m["exports"] = json!({ "trees": [{ "id": "board" }], "pages": [{ "id": "card" }] });
    }
    m
}

const EXTRA_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("tidy", async (ctx) => text({ text: ctx.resource.body.text, token: ctx.resource.body.token || null }));
} };
"#;

fn extra_manifest() -> Value {
    json!({
        "depends": [{ "id": "t.board", "version": "*" }],
        "contributes": {
            "kinds": [{ "id": "memo", "label": "Memo", "icon": "sticky-note", "tree": "t.board:board", "page": "t.board:card",
                        "newName": "memo", "fields": { "token": { "type": "secret" } } }],
            "actions": [{ "id": "tidy", "label": "Tidy", "output": "text", "kinds": ["memo"] }],
            "menus": { "new": ["memo"] },
            "commands": [{ "id": "probe", "label": "probe" }]
        }
    })
}

async fn board_menu(c: &Client) -> Vec<String> {
    let trees = c.ok("tree.list", json!({})).await;
    let t = trees.as_array().unwrap().iter().find(|t| t["id"] == "t.board:board").unwrap_or_else(|| panic!("{trees}")).clone();
    t["menu"].as_array().unwrap().iter().filter_map(|m| m["id"].as_str().map(String::from)).collect()
}

async fn save_new(c: &Client, target: &str, changes: Value) -> Result<String, ProtocolError> {
    c.call("page.save", json!({ "target": target, "changes": changes }))
        .await
        .map(|v| v["page"]["resourceId"].as_str().unwrap_or_else(|| panic!("{v}")).to_string())
}

fn info(page: &Value) -> Value {
    let t = page["view"].as_array().unwrap().iter().find(|n| n["id"] == "info").unwrap_or_else(|| panic!("{page}"));
    serde_json::from_str(t["text"].as_str().unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_dependents_kind_lives_in_the_owners_tree_and_uses_its_page() {
    let w = world(|r| {
        pkg(r, "t.board", "0.1.0", board_manifest(true), BOARD_MAIN);
        pkg(r, "t.extra", "0.1.0", extra_manifest(), EXTRA_MAIN);
    })
    .await;
    let c = &w.c;
    // "New" of the owner's tree offers the dependent's kind.
    let menu = board_menu(c).await;
    assert!(menu.contains(&"new:t.board:card".to_string()) && menu.contains(&"new:t.extra:memo".to_string()), "{menu:?}");
    let d = detail(c, "t.extra").await;
    assert_eq!(d["unmetExports"], json!([]));
    // Using another plugin's page is a permission; its tree is not.
    let perms = d["permissions"].as_array().unwrap();
    assert!(perms.iter().any(|p| p["id"] == "pages" && p["detail"] == "t.board:card"), "{perms:?}");
    assert!(!perms.iter().any(|p| p["detail"].as_str().unwrap_or("").contains("t.board:board")), "{perms:?}");

    // Created at the root and in a group of that tree; saved by the frame with the memo's fields.
    let memo = save_new(c, "new:t.extra:memo", json!({ "body.text": "hi", "body.token": "Memo-Secret-1" })).await.unwrap();
    let r = c.ok("resource.get", json!({ "id": memo })).await;
    assert_eq!((r["tree"].as_str(), r["kind"].as_str()), (Some("t.board:board"), Some("t.extra:memo")), "{r}");
    assert!(r["body"]["token"].get("secret").is_some(), "the secret field went to the key store: {r}");
    let g = c.ok("tree.createGroup", json!({ "tree": "t.board:board", "name": "G" })).await["key"].as_str().unwrap().to_string();
    let eff = c.ok("command.execute", json!({ "id": "new:t.extra:memo", "context": { "tree": "t.board:board", "nodeKey": g } })).await;
    assert_eq!(eff[0]["target"], format!("new:t.extra:memo?parent={g}"));
    let in_group = save_new(c, &format!("new:t.extra:memo?parent={g}"), json!({ "body.text": "g" })).await.unwrap();
    assert_eq!(c.ok("resource.get", json!({ "id": in_group })).await["parentId"], g);
    // Moving: under the owner's card (it accepts memos), not under a memo (it accepts nothing).
    let card = save_new(c, "new:t.board:card", json!({ "body.text": "card" })).await.unwrap();
    c.ok("tree.move", json!({ "tree": "t.board:board", "key": in_group, "target": card, "position": "inside" })).await;
    assert_eq!(c.ok("resource.get", json!({ "id": in_group })).await["parentId"], card);
    let e = c.call("tree.move", json!({ "tree": "t.board:board", "key": card, "target": memo, "position": "inside" })).await.unwrap_err();
    assert_eq!(reason(&e), (ErrorCode::Invalid, Some("notAccepted")));
    // Between trees: never (a memo's tree is the board; a group of another tree is no parent).
    let e = c.call("tree.move", json!({ "tree": "resources", "key": memo, "position": "inside" })).await.unwrap_err();
    assert_eq!((e.code, e.params.get("what").map(String::as_str)), (ErrorCode::NotFound, Some("node")), "{e:?}");
    let rg = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "R" })).await["key"].as_str().unwrap().to_string();
    let e = c.call("tree.move", json!({ "tree": "t.board:board", "key": memo, "target": rg, "position": "inside" })).await.unwrap_err();
    assert_eq!(reason(&e), (ErrorCode::Invalid, Some("otherTree")), "{e:?}");
    let e = c.call("tree.move", json!({ "tree": "t.board:board", "key": rg, "target": g, "position": "inside" })).await.unwrap_err();
    assert_eq!((e.code, e.params.get("what").map(String::as_str)), (ErrorCode::NotFound, Some("node")), "{e:?}");
    assert_eq!(c.ok("resource.get", json!({ "id": memo })).await["tree"], "t.board:board");

    // The owner's page draws it: read only, no secret fields; the owner may get it, not write it.
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{memo}") })).await;
    let i = info(&p);
    assert_eq!((i["kind"].as_str(), i["readOnly"].as_bool(), i["keys"].clone()), (Some("t.extra:memo"), Some(true), json!(["text"])), "{i}");
    assert_eq!(i["get"], json!(["text"]), "{i}");
    assert_eq!((i["upd"]["error"].as_str(), i["upd"]["params"]["reason"].as_str()), (Some("denied"), Some("foreignKind")), "{i}");
    assert_eq!(p["values"]["body.text"], "hi");
    // Frame: the page's save / event items, then the memo plugin's own actions; no run items,
    // no `view` result tab.
    let ids: Vec<&str> = p["actions"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["save", "ev", "t.extra:tidy"], "{p}");
    let tabs: Vec<&str> = p["resultTabs"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(tabs, ["out"]);
    // The owner's own card keeps its whole frame.
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{card}") })).await;
    let ids: Vec<&str> = p["actions"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["save", "ev", "go"]);
    // The new page too.
    let p = c.ok("page.resolve", json!({ "target": "new:t.extra:memo" })).await;
    assert_eq!(info(&p)["kind"], "t.extra:memo");
    let ids: Vec<&str> = p["actions"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["save", "ev", "t.extra:tidy"]);

    // Page events run as the owner: it cannot write or remove the memo; changes come back unsaved.
    let e = c.ok("page.event", json!({ "target": format!("resource:{memo}"), "event": "ev", "context": { "draft": {} } })).await;
    let m: Value = serde_json::from_str(e["message"].as_str().unwrap()).unwrap();
    assert_eq!((m["upd"]["params"]["reason"].as_str(), m["del"]["params"]["reason"].as_str()), (Some("foreignKind"), Some("foreignKind")), "{m}");
    assert_eq!(m["keys"], json!(["text"]));
    assert_eq!(e["changes"], json!({ "body.text": "from event" }));
    // The user saves through the frame.
    c.ok("page.save", json!({ "target": format!("resource:{memo}"), "changes": { "body.text": "edited" } })).await;
    assert_eq!(c.ok("resource.get", json!({ "id": memo })).await["body"]["text"], "edited");
    let memo_updates: Vec<String> = audit(&w.env, "resource.update").into_iter().filter(|a| a.1 == memo).map(|a| a.0).collect();
    assert!(!memo_updates.is_empty() && memo_updates.iter().all(|a| a == "user"), "only the user wrote the memo: {memo_updates:?}");

    // Outside its page the owner reads nothing of it.
    let r = c.probe("t.board", "resources.get", json!([memo])).await;
    assert_eq!(r["params"]["reason"], "foreignKind", "{r}");
    let r = out(&run(c, "t.board:peek", json!({})).await);
    assert_eq!(r["params"]["reason"], "foreignKind", "{r}");

    // The memo plugin's action runs as itself on its resource; its run has no owner `view` tab.
    let id = c
        .ok("run.start", json!({ "action": "t.extra:tidy", "resourceId": memo, "target": format!("resource:{memo}"), "tabId": "t", "input": {} }))
        .await;
    let r = wait_run(c, &id).await;
    assert_eq!(out(&r)["text"], "edited", "{r}");
    assert_eq!(r["action"], "t.extra:tidy");
    let p = c.ok("page.resolve", json!({ "target": format!("run:{}", id.as_str().unwrap()) })).await;
    let tabs: Vec<&str> = p["resultTabs"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(tabs, ["out"], "{p}");
    // Review #1: the history page is drawn like the live one — read only, no secret fields
    // (resource or snapshot), and nothing of the memo plugin's run (input, summary, error, output).
    let i = info(&p);
    assert_eq!((i["kind"].as_str(), i["readOnly"].as_bool(), i["keys"].clone()), (Some("t.extra:memo"), Some(true), json!(["text"])), "{i}");
    assert!(!i["draft"].as_array().unwrap().iter().any(|k| k == "body.token"), "{i}");
    assert_eq!(i["run"], json!([]), "{i}");
    let ids: Vec<&str> = p["actions"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect();
    assert!(!ids.contains(&"go"), "{ids:?}");
    let e = c.call("run.render", json!({ "id": id, "tabId": "v" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unexported_tree_or_page_makes_the_kind_unusable_until_it_is_exported() {
    let w = world(|r| {
        // The newest version (active) exports nothing; 0.1.0 exports both.
        pkg(r, "t.board", "0.1.0", board_manifest(true), BOARD_MAIN);
        pkg(r, "t.board", "0.2.0", board_manifest(false), BOARD_MAIN);
        pkg(r, "t.extra", "0.1.0", extra_manifest(), EXTRA_MAIN);
    })
    .await;
    let c = &w.c;
    let d = detail(c, "t.extra").await;
    assert_eq!(d["versions"].as_array().unwrap().len(), 1);
    assert_eq!(detail(c, "t.board").await["versions"].as_array().unwrap().iter().find(|v| v["active"] == true).unwrap()["version"], "0.2.0");
    // The plugin works; only the kind is unusable.
    assert_eq!(d["load"]["state"], "loaded", "{d}");
    assert_eq!(d["unmetExports"], json!(["t.board:board", "t.board:card"]));
    assert!(!board_menu(c).await.contains(&"new:t.extra:memo".to_string()));
    let e = save_new(c, "new:t.extra:memo", json!({ "body.text": "x" })).await.unwrap_err();
    assert_eq!((reason(&e), e.params.get("export").map(String::as_str)), ((ErrorCode::Denied, Some("notExported")), Some("t.board:board")), "{e:?}");
    let e = c.call("command.execute", json!({ "id": "new:t.extra:memo", "context": { "tree": "t.board:board" } })).await.unwrap_err();
    assert_eq!(reason(&e), (ErrorCode::Denied, Some("notExported")));
    let r = c.probe("t.extra", "resources.create", json!([{ "kind": "memo", "name": "x" }])).await;
    assert_eq!((r["params"]["reason"].as_str(), r["params"]["export"].as_str()), (Some("notExported"), Some("t.board:board")), "{r}");
    let p = c.ok("page.resolve", json!({ "target": "new:t.extra:memo" })).await;
    assert_eq!((p["state"].as_str(), p["readOnly"].as_bool()), (Some("disabled"), Some(true)), "{p}");

    // The owner switches to the version that exports them: usable again by itself.
    c.ok("plugin.activateVersion", json!({ "plugin": "t.board", "version": "0.1.0" })).await;
    assert_eq!(detail(c, "t.extra").await["unmetExports"], json!([]));
    assert!(board_menu(c).await.contains(&"new:t.extra:memo".to_string()));
    let memo = save_new(c, "new:t.extra:memo", json!({ "body.text": "kept" })).await.unwrap();
    let run_id = c
        .ok("run.start", json!({ "action": "t.extra:tidy", "resourceId": memo, "target": format!("resource:{memo}"), "tabId": "t", "input": {} }))
        .await;
    wait_run(c, &run_id).await;
    // And back: the existing memo is shown like a disabled plugin's resource, its data kept.
    c.ok("plugin.activateVersion", json!({ "plugin": "t.board", "version": "0.2.0" })).await;
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{memo}") })).await;
    assert_eq!((p["state"].as_str(), p["readOnly"].as_bool()), (Some("disabled"), Some(true)), "{p}");
    let nodes = c.ok("tree.children", json!({ "tree": "t.board:board" })).await;
    let node = nodes["nodes"].as_array().unwrap().iter().find(|n| n["key"] == memo.as_str()).unwrap().clone();
    assert_eq!(node["state"], "disabled", "{node}");
    let e = c.call("page.save", json!({ "target": format!("resource:{memo}"), "changes": { "body.text": "no" } })).await.unwrap_err();
    assert_eq!(reason(&e), (ErrorCode::Denied, Some("notExported")));
    let e = c.call("page.event", json!({ "target": format!("resource:{memo}"), "event": "ev" })).await.unwrap_err();
    assert_eq!(reason(&e), (ErrorCode::Denied, Some("notExported")), "{e:?}");
    assert_eq!(c.ok("resource.get", json!({ "id": memo })).await["body"]["text"], "kept");
    // Review #1: its history page is not drawn by the owner either.
    let p = c.ok("page.resolve", json!({ "target": format!("run:{}", run_id.as_str().unwrap()) })).await;
    assert_eq!((p["state"].as_str(), p["view"].as_array().map(Vec::len)), (Some("disabled"), Some(0)), "{p}");
    c.ok("plugin.activateVersion", json!({ "plugin": "t.board", "version": "0.1.0" })).await;
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{memo}") })).await;
    assert_eq!(p["state"], "ok", "{p}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_name_without_depends_does_not_load() {
    let w = world(|r| {
        pkg(r, "t.board", "0.1.0", board_manifest(true), BOARD_MAIN);
        let mut m = extra_manifest();
        m.as_object_mut().unwrap().remove("depends");
        pkg(r, "t.extra", "0.1.0", m, EXTRA_MAIN);
    })
    .await;
    let d = detail(&w.c, "t.extra").await;
    assert_eq!((d["load"]["state"].as_str(), d["load"]["message"].as_str()), (Some("error"), Some("undeclaredDepend")), "{d}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn overlapping_waits_pause_the_budget_at_most_the_cap() {
    // D361 / review #2: a chain of overlapping `process.run` calls (each 1.5 s, one started every
    // second, five in all: about 5.5 s of waiting) with a 2 s budget.
    let capped = transfer_world_cfg(|c| {
        c.action_timeout = Duration::from_secs(2);
        c.sandbox.max_wait_pause = Duration::from_secs(1);
    })
    .await;
    let r = run(&capped.w.c, "t.move:chain", json!({ "n": 5 })).await;
    assert_eq!((r["status"].as_str(), r["error"]["code"].as_str()), (Some("error"), Some("timeout")), "{r}");
    capped.no_programs_left().await;
    // Under the cap (default: 1 hour) the same chain finishes.
    let free = transfer_world_cfg(|c| c.action_timeout = Duration::from_secs(2)).await;
    let r = run(&free.w.c, "t.move:chain", json!({ "n": 5 })).await;
    assert_eq!((r["status"].as_str(), out(&r)), (Some("success"), json!("ok")), "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn transfer_in_migrate_is_not_in_a_run() {
    let t = transfer_world().await;
    let c = &t.w.c;
    let id = c.ok("page.save", json!({ "target": "new:t.move:k", "changes": { "name": "x" } })).await["page"]["resourceId"].as_str().unwrap().to_string();
    let mut m = move_manifest(t.port, full_requires(t.port));
    m["upgradesFrom"] = json!(">=0.1.0");
    let main = MOVE_MAIN.replace(
        "host.commands.handle(\"probe\", probe);",
        "host.commands.handle(\"probe\", probe);\n  host.kinds.handle(\"k\", { async migrate(body, from, ctx) { let err = 'ran'; try { await ctx.host.transfer.capture({ program: 'cat', to: '/x' }); } catch (e) { err = e.code + '/' + e.params.reason; } return Object.assign({}, body, { err }); } });",
    );
    assert_ne!(main, MOVE_MAIN);
    pkg(&t.w.root, "t.move", "0.2.0", m, &main);
    c.ok("plugin.rescan", Value::Null).await;
    let r = c.ok("resource.get", json!({ "id": id })).await;
    assert_eq!((r["pluginVersion"].as_str(), r["body"]["err"].as_str()), (Some("0.2.0"), Some("denied/notInRun")), "{r}");
    let a = audit(&t.w.env, "transfer.capture");
    assert!(a.iter().any(|x| x.3 == "failed:denied"), "{a:?}");
}
