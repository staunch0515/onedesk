//! Round 18: long and streamed requests (X16), result-area actions (X5), plugin interfaces
//! (X15), ranked search (X6). Plugins are generated into a temporary folder; the server is a
//! local socket; nothing here knows any real service.

mod common;

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HELPERS: &str = r#"
const tryIt = async (f) => { try { return { ok: await f() }; } catch (e) { return { error: e.code || String(e), params: e.params || {}, message: e.message }; } };
const text = (v) => ({ output: { type: "text", text: JSON.stringify(v) } });
async function probe(ctx, context) {
  const a = context.args;
  const [cap, op] = a.method.split(".");
  try { return [{ type: "copy", text: JSON.stringify({ ok: await ctx.host[cap][op](...a.args) }) }]; }
  catch (e) { return [{ type: "copy", text: JSON.stringify({ error: e.code || String(e), params: e.params || {} }) }]; }
}
"#;

fn pkg(root: &Path, id: &str, extra: Value, main: &str) {
    let dir = root.join(id).join("0.1.0");
    std::fs::create_dir_all(dir.join("locales")).unwrap();
    let mut m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": id, "icon": "box", "main": "main.js" });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(dir.join("main.js"), format!("{HELPERS}\n{main}")).unwrap();
    std::fs::write(dir.join("locales/en-US.json"), r#"{ "ra.analyze": "Analyze", "ra.other": "Other" }"#).unwrap();
    std::fs::write(dir.join("locales/ja-JP.json"), r#"{ "ra.analyze": "分析" }"#).unwrap();
}

/* ------------------------------------------------------------------ the server */

#[derive(Clone, Default)]
struct Server {
    closed: Arc<AtomicUsize>,
    opened: Arc<AtomicUsize>,
}

/// `/stream`: three blocks, the second cutting a character in two; `/err`: a 500 with a body;
/// `/stall`: one block, then nothing for 5 s; `/hang`: one block, then waits for the client to go
/// (counted in `closed`); `/key`: the `x-key` header echoed in two blocks cut in the middle of it;
/// `/slow`: nothing for 2.5 s, then a short body; `/long`: 60 KB of text in 3 KB blocks.
async fn put(s: &mut tokio::net::TcpStream, bytes: Vec<u8>) {
    let _ = s.write_all(&bytes).await;
    let _ = s.flush().await;
}

async fn server() -> (u16, Server) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let st = Server::default();
    let st2 = st.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { break };
            let st = st2.clone();
            tokio::spawn(async move {
                st.opened.fetch_add(1, Ordering::SeqCst);
                let mut req = Vec::new();
                let mut buf = vec![0u8; 4096];
                while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    req.extend_from_slice(&buf[..n]);
                }
                let head = String::from_utf8_lossy(&req).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let key = head.lines().find_map(|l| l.strip_prefix("x-key: ")).unwrap_or("").to_string();
                let hdr = |code: &str| format!("HTTP/1.1 {code}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n");
                match path.as_str() {
                    "/stream" => {
                        put(&mut s, hdr("200 OK").into_bytes()).await;
                        let all = "héllo wörld, ünï".as_bytes().to_vec();
                        // "héllo" = h c3 a9 …: cut between c3 and a9.
                        put(&mut s, all[..2].to_vec()).await;
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        put(&mut s, all[2..9].to_vec()).await;
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        put(&mut s, all[9..].to_vec()).await;
                    }
                    "/err" => {
                        put(&mut s, format!("{}{}", hdr("500 Internal Server Error"), "x".repeat(20_000)).into_bytes()).await;
                    }
                    "/cut" => {
                        // Chunked, one block, then the socket closes before the final chunk.
                        let h = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n";
                        put(&mut s, format!("{h}2\r\na\n\r\n").into_bytes()).await;
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    "/nothing" => {
                        // The request is read, the answer never starts: the socket just closes.
                    }
                    "/stall" => {
                        put(&mut s, format!("{}a\n", hdr("200 OK")).into_bytes()).await;
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                    "/hang" => {
                        put(&mut s, format!("{}a\n", hdr("200 OK")).into_bytes()).await;
                        let mut b = [0u8; 16];
                        loop {
                            match s.read(&mut b).await {
                                Ok(0) | Err(_) => break,
                                Ok(_) => {}
                            }
                        }
                        st.closed.fetch_add(1, Ordering::SeqCst);
                    }
                    "/key" => {
                        put(&mut s, hdr("200 OK").into_bytes()).await;
                        let k = format!("key={key};");
                        let cut = 4 + key.len() / 2;
                        put(&mut s, k.as_bytes()[..cut].to_vec()).await;
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        put(&mut s, k.as_bytes()[cut..].to_vec()).await;
                    }
                    "/errkey" => {
                        // The key as sent, percent-encoded and in base64, behind enough text to cut in the middle.
                        let k = key.clone();
                        let body = format!("{}{k}|{}|{}|{}", "y".repeat(8185), onedesk_kernel::secrets::percent(&k), onedesk_kernel::secrets::base64(k.as_bytes()), "tail".repeat(10));
                        let code = if head.contains("x-plain") { "200 OK" } else { "500 Internal Server Error" };
                        put(&mut s, format!("{}{body}", hdr(code)).into_bytes()).await;
                    }
                    "/slow" => {
                        tokio::time::sleep(Duration::from_millis(2500)).await;
                        put(&mut s, format!("{}done", hdr("200 OK")).into_bytes()).await;
                    }
                    "/long" => {
                        put(&mut s, hdr("200 OK").into_bytes()).await;
                        for _ in 0..20 {
                            put(&mut s, "y".repeat(3000).into_bytes()).await;
                        }
                    }
                    _ => put(&mut s, format!("{}hello", hdr("200 OK")).into_bytes()).await,
                }
            });
        }
    });
    (port, st)
}

const NET_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("stream", async (ctx, input) => {
    const chunks = [];
    const url = "http://127.0.0.1:" + input.port + input.path;
    const r = await tryIt(() => ctx.host.network.request(Object.assign({ url, stream: true, headers: input.headers,
      onChunk: async (t) => {
        chunks.push(t);
        if (input.throwAt && chunks.length === input.throwAt) throw new Error("boom");
        await ctx.host.runs.partial({ type: "text", text: chunks.join("") });
      } }, input.opts || {})));
    return text({ chunks, r });
  });
  host.actions.handle("plain", async (ctx, input) => {
    const r = await tryIt(() => ctx.host.network.request(Object.assign({ url: "http://127.0.0.1:" + input.port + input.path }, input.opts || {})));
    return text(r);
  });
} };
"#;

async fn net_world(timeout: Duration) -> (Env, Client, u16, Server) {
    let (port, st) = server().await;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    pkg(&root, "t.net", json!({
        "requires": { "network": { "hosts": [format!("127.0.0.1:{port}")] }, "secrets": { "names": ["k"] } },
        "contributes": { "actions": [{ "id": "stream", "label": "s", "output": "text" }, { "id": "plain", "label": "p", "output": "text" }],
                         "commands": [{ "id": "probe", "label": "p" }] }
    }), NET_MAIN);
    let mut cfg = config_for(&root);
    cfg.action_timeout = timeout;
    let env = open_exact(tmp, &root, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c, port, st)
}

async fn start(c: &Client, action: &str, input: Value) -> String {
    c.ok("run.start", json!({ "action": action, "target": "core:none", "tabId": "t", "input": input })).await.as_str().unwrap().to_string()
}

async fn finish(c: &Client, id: &str) -> Value {
    for _ in 0..1500 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {id} did not end");
}

async fn run(c: &Client, action: &str, input: Value) -> Value {
    let id = start(c, action, input).await;
    finish(c, &id).await
}

fn out(r: &Value) -> Value {
    serde_json::from_str(r["output"]["text"].as_str().unwrap_or_else(|| panic!("no text: {r}"))).unwrap()
}

fn audit(env: &Env, op: &str) -> Vec<(String, String, String, String)> {
    let conn = rusqlite::Connection::open(env.kernel.db_path()).unwrap();
    let mut st = conn.prepare("SELECT actor, object, summary, result FROM audit WHERE op = ?1 ORDER BY seq").unwrap();
    st.query_map([op], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(|r| r.unwrap()).collect()
}

/* ------------------------------------------------------------------ X16 */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_streamed_answer_comes_block_by_block_and_never_cuts_a_character() {
    let (env, c, port, _) = net_world(Duration::from_secs(20)).await;
    let r = run(&c, "t.net:stream", json!({ "port": port, "path": "/stream" })).await;
    assert_eq!(r["status"], "success", "{r}");
    let o = out(&r);
    let chunks: Vec<&str> = o["chunks"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(chunks.concat(), "héllo wörld, ünï", "{o}");
    assert!(chunks.len() >= 2, "more than one block: {chunks:?}");
    for ch in &chunks {
        assert!(!ch.contains('\u{FFFD}'), "no half characters: {chunks:?}");
    }
    let res = &o["r"]["ok"];
    assert_eq!((res["status"].as_u64(), res["streamed"].as_bool(), res["body"].as_str(), res["text"].as_str()), (Some(200), Some(true), Some(""), Some("")), "{o}");
    assert_eq!(res["bytes"].as_u64(), Some("héllo wörld, ünï".len() as u64));
    // The blocks were also the run's partial output while it ran (the last one stayed in memory).
    let a = audit(&env, "network.request");
    assert_eq!(a.len(), 1, "{a:?}");
    let s: Value = serde_json::from_str(&a[0].2).unwrap();
    assert_eq!((s["stream"].as_bool(), s["status"].as_u64()), (Some(true), Some(200)));
    assert!(!a[0].2.contains("llo"), "no content in the audit: {a:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn partial_output_shows_while_it_streams() {
    let (_env, c, port, _) = net_world(Duration::from_secs(20)).await;
    let id = start(&c, "t.net:stream", json!({ "port": port, "path": "/stream" })).await;
    let mut seen = Vec::new();
    for _ in 0..200 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if let Some(t) = r["partial"]["text"].as_str() {
            if seen.last().map(String::as_str) != Some(t) {
                seen.push(t.to_string());
            }
        }
        if r["status"] != "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(seen.len() >= 2 && seen.first().unwrap().len() < seen.last().unwrap().len(), "growing text: {seen:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_error_status_keeps_its_first_8k_and_still_goes_to_the_callback() {
    let (_env, c, port, _) = net_world(Duration::from_secs(20)).await;
    let o = out(&run(&c, "t.net:stream", json!({ "port": port, "path": "/err" })).await);
    let res = &o["r"]["ok"];
    assert_eq!(res["status"], 500, "{o}");
    assert_eq!(res["body"].as_str().unwrap().len(), 8192);
    assert_eq!(res["text"], res["body"]);
    assert_eq!(res["bytes"], 20_000);
    let got: usize = o["chunks"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().len()).sum();
    assert_eq!(got, 20_000, "the whole error body went through onChunk");
}

/// D446: a server that closes in the middle of a chunked body ends the request at once, as a
/// network error (not as a timeout after the idle limit).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cut_stream_ends_at_once_as_a_network_error() {
    let (_env, c, port, _) = net_world(Duration::from_secs(20)).await;
    let t = Instant::now();
    let o = out(&run(&c, "t.net:stream", json!({ "port": port, "path": "/cut" })).await);
    assert_eq!(o["r"]["error"], "invalid", "{o}");
    assert_ne!(o["r"]["params"]["reason"], "timeout", "{o}");
    assert_eq!(o["chunks"], json!(["a\n"]), "{o}");
    assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
}

/// D446: the same when the connection closes before any answer (so before a status line).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_connection_closed_before_the_answer_ends_a_stream_at_once() {
    let (_env, c, port, _) = net_world(Duration::from_secs(20)).await;
    let t = Instant::now();
    let o = out(&run(&c, "t.net:stream", json!({ "port": port, "path": "/nothing" })).await);
    assert_eq!(o["r"]["error"], "invalid", "{o}");
    assert_ne!(o["r"]["params"]["reason"], "timeout", "{o}");
    assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn silence_between_two_blocks_times_out() {
    let (_env, c, port, _) = net_world(Duration::from_secs(20)).await;
    let t = Instant::now();
    let o = out(&run(&c, "t.net:stream", json!({ "port": port, "path": "/stall", "opts": { "idleTimeoutMs": 300 } })).await);
    assert_eq!((o["r"]["error"].as_str(), o["r"]["params"]["reason"].as_str()), (Some("invalid"), Some("timeout")), "{o}");
    assert_eq!(o["chunks"], json!(["a\n"]), "what came before is kept");
    assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
    // The whole-call limit applies too.
    let o = out(&run(&c, "t.net:stream", json!({ "port": port, "path": "/stall", "opts": { "timeoutMs": 400 } })).await);
    assert_eq!(o["r"]["params"]["reason"], "timeout", "{o}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_the_run_drops_the_connection_at_once() {
    let (_env, c, port, st) = net_world(Duration::from_secs(20)).await;
    let id = start(&c, "t.net:stream", json!({ "port": port, "path": "/hang", "opts": { "timeoutMs": 600_000, "idleTimeoutMs": 600_000 } })).await;
    for _ in 0..200 {
        if c.ok("run.get", json!({ "id": id })).await["partial"]["text"] == "a\n" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(st.closed.load(Ordering::SeqCst), 0);
    let t = Instant::now();
    c.ok("run.cancel", json!({ "id": id })).await;
    while st.closed.load(Ordering::SeqCst) == 0 && t.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(st.closed.load(Ordering::SeqCst), 1, "the server saw the connection close");
    assert!(t.elapsed() < Duration::from_secs(1), "at once, not at the next block: {:?}", t.elapsed());
    assert_eq!(finish(&c, &id).await["status"], "cancelled");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_callback_that_throws_ends_the_request_with_its_error() {
    let (_env, c, port, st) = net_world(Duration::from_secs(20)).await;
    let o = out(&run(&c, "t.net:stream", json!({ "port": port, "path": "/hang", "throwAt": 1, "opts": { "timeoutMs": 600_000 } })).await);
    assert_eq!((o["r"]["message"].as_str(), o["chunks"].as_array().map(Vec::len)), (Some("boom"), Some(1)), "{o}");
    for _ in 0..200 {
        if st.closed.load(Ordering::SeqCst) == 1 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the connection stayed open");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_secret_cut_between_two_blocks_is_still_scrubbed() {
    let (_env, c, port, _) = net_world(Duration::from_secs(20)).await;
    c.ok("secrets.set", json!({ "name": "k", "value": "topsecret-value-42" })).await;
    let o = out(&run(&c, "t.net:stream", json!({ "port": port, "path": "/key", "headers": { "x-key": "{{secret:k}}" } })).await);
    let all: String = o["chunks"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(all, "key=***;", "{o}");
    assert!(!o.to_string().contains("topsecret"), "{o}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn max_bytes_stops_a_stream() {
    let (_env, c, port, st) = net_world(Duration::from_secs(20)).await;
    let o = out(&run(&c, "t.net:stream", json!({ "port": port, "path": "/long", "opts": { "maxBytes": 10_000 } })).await);
    let res = &o["r"]["ok"];
    assert_eq!((res["truncated"].as_bool(), res["bytes"].as_u64()), (Some(true), Some(10_000)), "{o}");
    let _ = st;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn streaming_is_for_actions_and_a_long_wait_does_not_spend_the_actions_budget() {
    // Action budget 1 s; a request that waits 2.5 s with a limit over 60 s does not use it up.
    let (_env, c, port, _) = net_world(Duration::from_secs(1)).await;
    let o = out(&run(&c, "t.net:plain", json!({ "port": port, "path": "/slow", "opts": { "timeoutMs": 120_000 } })).await);
    assert_eq!(o["ok"]["body"], "done", "{o}");
    // Outside a run (a command) `stream` is refused, and a long `timeoutMs` is held to 60 s (unit test).
    let r = c.probe("t.net", "network.request", json!([{ "url": format!("http://127.0.0.1:{port}/"), "stream": true }])).await;
    assert_eq!((r["error"].as_str(), r["params"]["reason"].as_str()), (Some("denied"), Some("notInRun")), "{r}");
    let r = c.probe("t.net", "network.request", json!([{ "url": format!("http://127.0.0.1:{port}/"), "timeoutMs": 900_000 }])).await;
    assert_eq!(r["ok"]["body"], "hello", "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn on_chunk_needs_a_stream() {
    let (_env, c, port, _) = net_world(Duration::from_secs(20)).await;
    let o = out(&run(&c, "t.net:stream", json!({ "port": port, "path": "/", "opts": { "stream": false } })).await);
    assert_eq!(o["r"]["error"], "invalidParams", "{o}");
}

/* ------------------------------------------------------------------ X5, X15, X6 */

const PROV_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("chat", async (ctx, input) => {
    if (input.sleep) { await ctx.host.runs.partial({ type: "text", text: "thinking" }); await ctx.host.util.sleep(input.sleep); }
    if (input.partial) await ctx.host.runs.partial({ type: "text", text: input.partial });
    const read = input.try ? await tryIt(() => ctx.host.runs.read(input.try)) : undefined;
    return { echo: input.msg, resource: ctx.resource && ctx.resource.id, caller: ctx.caller, run: !!ctx.runId, read };
  });
  host.actions.handle("models", async (ctx, input) => ({ output: { type: "text", text: "m" }, data: { s: input.big ? "x".repeat(1100000) : "ok", n: [1, 2] } }));
  host.actions.handle("test", async () => ({ ok: true }));
  host.actions.handle("secret", async () => ({}));
  host.actions.handle("readit", async (ctx, input) => ({ read: await tryIt(() => ctx.host.runs.read(input.id)) }));
} };
"#;

const USER_MAIN: &str = r#"
// `ops`: [{ m, a }] on ctx.host.runs, "$runId" and "$last" standing for the input's runId and the last answer's id.
async function doOps(ctx, input) {
  const out = []; let last = null;
  for (const op of input.ops || []) {
    const a = JSON.parse(JSON.stringify(op.a).replace(/"\$runId"/g, JSON.stringify(input.runId)).replace(/"\$last"/g, JSON.stringify(last)));
    const r = await tryIt(() => ctx.host.runs[op.m](...a));
    if (r.ok && r.ok.id) last = r.ok.id;
    out.push(r);
  }
  return out;
}
export default { activate(host) {
  host.actions.handle("ops", async (ctx, input) => text(await doOps(ctx, input)));
  host.actions.handle("viacall", async (ctx, input) => text(await tryIt(() => ctx.host.actions.call("t.prov:models", input.input || {}))));
  host.commands.handle("probe", probe);
  host.actions.handle("ask", async (ctx, input) => {
    const r = await tryIt(() => ctx.host.interfaces.call(input.iface || "t.chat/1", input.action || "chat", input.input || {}, input.opts));
    return text(r);
  });
  host.actions.handle("list", async (ctx, input) => text(await tryIt(() => ctx.host.interfaces.list(input.iface || "t.chat/1"))));
  host.actions.handle("emit", async (ctx, input) => ({ output: { type: "table", columns: [{ key: "a", label: "A" }], rows: [["1"], ["2"]], total: 2, truncated: false } }));
  host.actions.handle("emit-text", async () => ({ output: { type: "text", text: "hello" } }));
  host.actions.handle("emit-link", async () => ({ output: { type: "link", label: "x", target: "core:none" } }));
  host.actions.handle("fail", async () => { throw new Error("nope"); });
  host.actions.handle("analyze", async (ctx, input) => {
    const own = await tryIt(() => ctx.host.runs.read(input.runId));
    const other = await tryIt(() => ctx.host.runs.read(input.otherRun || "nonexistent"));
    const viaCall = input.callee ? await tryIt(() => ctx.host.actions.call("t.prov:readit", { id: input.runId })) : undefined;
    const viaIface = input.callee ? await tryIt(() => ctx.host.interfaces.call("t.chat/1", "chat", { try: input.runId }, { resource: input.callee })) : undefined;
    return text({ input, own, other, viaCall, viaIface, ops: await doOps(ctx, input) });
  });
  host.actions.handle("plain", async (ctx, input) => text({ input, read: await tryIt(() => ctx.host.runs.read(input.id)) }));
  host.actions.handle("search", async (ctx, input) => text(await tryIt(() => ctx.host.resources.search(input.opts))));
  host.pages.handle("p", {
    async render(ctx) { return { view: [{ type: "form", id: "f", layout: "stack", fields: [
      { name: "conn", label: "Connection", kind: "ref", kinds: input_kinds }
    ] }] }; },
    async onEvent(ctx, e) { return { message: JSON.stringify(await doOps(ctx, JSON.parse(e))) }; },
  });
} };
const input_kinds = ["@implements:t.chat/1"];
"#;

const OTHER_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("ask", async (ctx, input) => text(await tryIt(() => ctx.host.interfaces.call("t.chat/1", "chat", {}, input.opts))));
  host.pages.handle("p", { async render(ctx) { return { view: [{ type: "form", id: "f", layout: "stack", fields: [
    { name: "conn", label: "Connection", kind: "ref", kinds: ["@implements:t.chat/1"] }
  ] }] }; } });
} };
"#;

fn iface(extra_actions: Value) -> Value {
    json!({ "t.chat/1": { "actions": extra_actions, "kind": "conn" } })
}

fn user_manifest(result_actions: Value) -> Value {
    let a = |id: &str, out: &str| json!({ "id": id, "label": id, "output": out });
    json!({
        "depends": [{ "id": "t.prov", "version": ">=0.1.0" }],
        "uses": ["t.chat/1", "t.gen/1"],
        "requires": { "resources": true },
        "contributes": {
            "kinds": [{ "id": "note", "label": "Note", "icon": "box", "tree": "resources", "newName": "n" }],
            "pages": [{ "id": "p" }],
            "actions": [a("ask", "text"), a("list", "text"), a("emit", "table"), a("emit-text", "text"), a("emit-link", "link"), a("fail", "text"),
                        a("analyze", "text"), a("plain", "text"), a("search", "text"), a("ops", "text"), a("viacall", "text")],
            "commands": [{ "id": "probe", "label": "p" }],
            "locales": { "en-US": "locales/en-US.json", "ja-JP": "locales/ja-JP.json" },
            "resultActions": result_actions,
            "settings": [{ "name": "conn", "label": "ra.analyze", "type": "resource", "default": "", "kinds": ["@implements:t.chat/1"] }]
        }
    })
}

async fn world18(result_actions: Value) -> (Env, Client) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    let a = |id: &str, out: &str| json!({ "id": id, "label": id, "output": out });
    pkg(&root, "t.prov", json!({
        "implements": iface(json!(["chat", "models", "test"])),
        "contributes": {
            "kinds": [{ "id": "conn", "label": "Conn", "icon": "box", "tree": "resources", "newName": "c",
                       "fields": { "key": { "type": "secret" }, "model": { "type": "text" } } },
                      { "id": "plain", "label": "Plain", "icon": "box", "tree": "resources", "newName": "p" }],
            "actions": [a("chat", "text"), a("models", "text"), a("test", "text"), a("secret", "text"), a("readit", "text")],
            "commands": [{ "id": "probe", "label": "p" }]
        },
        "exports": { "actions": ["chat", "models", "test", "readit"] }
    }), PROV_MAIN);
    // A second implementer nobody depends on (so it can be disabled).
    pkg(&root, "t.prov2", json!({
        "implements": iface(json!(["chat"])),
        "contributes": { "kinds": [{ "id": "conn", "label": "Conn2", "icon": "box", "tree": "resources", "newName": "c" }],
                         "actions": [a("chat", "text")] },
        "exports": { "actions": ["chat"] }
    }), r#"export default { activate(host) { host.actions.handle("chat", async (ctx, input) => ({ echo: input.msg, resource: ctx.resource && ctx.resource.id })); } };"#);
    pkg(&root, "t.user", user_manifest(result_actions), USER_MAIN);
    // Uses an interface and nothing else: no `depends`, no `requires.resources`.
    pkg(&root, "t.thin", json!({
        "uses": ["t.chat/1"],
        "contributes": { "actions": [a("ask", "text")], "commands": [{ "id": "probe", "label": "p" }] }
    }), r#"export default { activate(host) {
      host.commands.handle("probe", probe);
      host.actions.handle("ask", async (ctx, input) => text(await tryIt(() => ctx.host.interfaces.call("t.chat/1", "chat", { msg: "thin" }, input.opts))));
    } };"#);
    // An interface without a connection kind (D445).
    pkg(&root, "t.gen", json!({
        "implements": { "t.gen/1": { "actions": ["gen"] } },
        "contributes": { "actions": [a("gen", "text")] },
        "exports": { "actions": ["gen"] }
    }), r#"export default { activate(host) { host.actions.handle("gen", async (ctx, input) => ({ output: { type: "text", text: "g" }, data: { got: input.x, resource: ctx.resource || null, caller: ctx.caller } })); } };"#);
    pkg(&root, "t.other", json!({
        "contributes": { "pages": [{ "id": "p" }], "actions": [a("ask", "text")], "commands": [{ "id": "probe", "label": "p" }] }
    }), OTHER_MAIN);
    let mut cfg = config_for(&root);
    cfg.action_timeout = Duration::from_secs(20);
    let env = open_exact(tmp, &root, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

fn analyze_decl() -> Value {
    json!([{ "id": "analyze", "label": "ra.analyze", "icon": "sparkles", "outputTypes": ["table", "text"], "action": "analyze" }])
}

async fn make(c: &Client, kind: &str, name: &str, description: Option<&str>) -> String {
    let mut ch = json!({ "name": name });
    if let Some(d) = description {
        ch["description"] = json!(d);
    }
    let r = c.ok("page.save", json!({ "target": format!("new:{kind}"), "changes": ch })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

fn code(e: &onedesk_protocol::ProtocolError) -> String {
    let c = serde_json::to_value(e.code).unwrap();
    format!("{}/{}", c.as_str().unwrap(), e.params.get("reason").map(String::as_str).unwrap_or(""))
}

async fn click(c: &Client, action: &str, source: &str, extra: Value) -> Value {
    let mut input = json!({});
    for (k, v) in extra.as_object().unwrap() {
        input[k] = v.clone();
    }
    let id = c
        .ok("run.start", json!({ "action": action, "target": "core:none", "tabId": "t", "resultRun": source, "input": input }))
        .await;
    finish(c, id.as_str().unwrap()).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manifests_with_bad_result_actions_or_interfaces_are_rejected() {
    let reason = |extra: Value, impl_: Value| {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugins");
        std::fs::create_dir_all(&root).unwrap();
        let a = |id: &str| json!({ "id": id, "label": id, "output": "text" });
        let mut e = json!({
            "contributes": { "kinds": [{ "id": "conn", "label": "C", "icon": "box", "tree": "resources", "newName": "c" }],
                             "actions": [a("chat"), a("hid"), json!({ "id": "bound", "label": "b", "output": "text", "kinds": ["conn"] })] },
            "exports": { "actions": ["chat"] }
        });
        for (k, v) in extra.as_object().unwrap().iter().chain(impl_.as_object().unwrap()) {
            if k == "resultActions" || k == "settings" {
                e["contributes"][k] = v.clone();
            } else {
                e[k] = v.clone();
            }
        }
        pkg(&root, "t.x", e, "export default { activate() {} };");
        let k = onedesk_kernel::manifest::Registry::scan(&root);
        let _ = &k;
        let rej = onedesk_kernel::manifest::load_package(&root.join("t.x").join("0.1.0"));
        match rej {
            Ok(_) => "ok".to_string(),
            Err(r) => r.reason,
        }
    };
    let ra = |v: Value| reason(json!({ "resultActions": v }), json!({}));
    let ok = json!({ "id": "go", "label": "ra.analyze", "outputTypes": ["table"], "action": "chat" });
    assert_eq!(ra(json!([ok.clone()])), "ok");
    for bad in [
        json!([{ "id": "go", "label": "x", "outputTypes": [], "action": "chat" }]),
        json!([{ "id": "go", "label": "x", "outputTypes": ["table", "table"], "action": "chat" }]),
        json!([{ "id": "go", "label": "x", "outputTypes": ["pie"], "action": "chat" }]),
        json!([{ "id": "go", "label": "x", "outputTypes": ["table"], "action": "nope" }]),
        json!([{ "id": "go", "label": "x", "outputTypes": ["table"], "action": "bound" }]),
        json!([ok.clone(), ok.clone()]),
        json!([{ "id": "go", "label": "x", "outputTypes": ["table"], "action": "chat", "style": "x" }]),
        json!([{ "id": "Bad Id", "label": "x", "outputTypes": ["table"], "action": "chat" }]),
    ] {
        let r = ra(bad.clone());
        assert!(r == "badResultActions" || r == "schema", "{bad} → {r}");
    }
    let im = |v: Value| reason(json!({}), json!({ "implements": v }));
    assert_eq!(im(json!({ "t.chat/1": { "actions": ["chat"], "kind": "conn" } })), "ok");
    assert_eq!(im(json!({ "t.chat/1": { "actions": ["chat"] } })), "ok", "D445: no kind, no anchor resource");
    assert_eq!(im(json!({ "t.chat/1": { "actions": ["chat"], "kind": 1 } })), "badImplements");
    for bad in [
        json!([]),
        json!({ "t.chat": { "actions": ["chat"], "kind": "conn" } }),
        json!({ "t.chat/1": { "actions": [], "kind": "conn" } }),
        json!({ "t.chat/1": { "actions": ["hid"], "kind": "conn" } }),
        json!({ "t.chat/1": { "actions": ["chat", "chat"], "kind": "conn" } }),
        json!({ "t.chat/1": { "actions": ["chat"], "kind": "nope" } }),
        json!({ "t.chat/1": { "actions": ["chat"], "kind": "conn", "x": 1 } }),
    ] {
        assert_eq!(im(bad.clone()), "badImplements", "{bad}");
    }
    // `resource` settings: kinds required, none otherwise; `@implements:` only of an interface it uses.
    let st = |v: Value, uses: Value| reason(json!({ "settings": [v] }), json!({ "uses": uses }));
    let mk = |extra: Value| {
        let mut o = json!({ "name": "c", "label": "x", "type": "resource", "default": "" });
        for (k, v) in extra.as_object().unwrap() {
            o[k] = v.clone();
        }
        o
    };
    assert_eq!(st(mk(json!({ "kinds": ["@implements:t.chat/1", "conn", "t.p:k"] })), json!(["t.chat/1"])), "ok");
    for bad in [
        json!({}),
        json!({ "kinds": [] }),
        json!({ "kinds": ["@implements:t.chat/1"] }),
        json!({ "kinds": ["nope"] }),
        json!({ "kinds": ["conn"], "default": "x" }),
        json!({ "kinds": ["conn"], "options": [{ "value": "a", "label": "a" }] }),
    ] {
        assert_eq!(st(mk(bad.clone()), json!([])), "badSetting", "{bad}");
    }
    assert_eq!(st(json!({ "name": "c", "label": "x", "type": "text", "default": "", "kinds": ["conn"] }), json!([])), "badSetting");
    let us = |v: Value| reason(json!({}), json!({ "uses": v }));
    assert_eq!(us(json!(["t.chat/1", "t.other/2"])), "ok");
    for bad in [json!("t.chat/1"), json!(["t.chat"]), json!(["t.chat/1", "t.chat/1"]), json!([1])] {
        assert_eq!(us(bad.clone()), "badImplements", "{bad}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn result_actions_follow_the_output_type_the_language_and_the_policies() {
    let (_env, c) = world18(analyze_decl()).await;
    let table = run(&c, "t.user:emit", json!({})).await;
    let link = run(&c, "t.user:emit-link", json!({})).await;
    let failed = run(&c, "t.user:fail", json!({})).await;
    assert_eq!((table["status"].as_str(), failed["status"].as_str()), (Some("success"), Some("error")));
    let list = |id: &Value, locale: Option<&str>| {
        let mut p = json!({ "runId": id });
        if let Some(l) = locale {
            p["locale"] = json!(l);
        }
        c.ok("result.actions", p)
    };
    let l = list(&table["id"], None).await;
    assert_eq!(l, json!([{ "plugin": "t.user", "id": "analyze", "action": "t.user:analyze", "label": "Analyze", "icon": "sparkles", "enabled": true }]));
    assert_eq!(list(&table["id"], Some("ja-JP")).await[0]["label"], "分析");
    assert_eq!(list(&link["id"], None).await, json!([]), "a link result has none");
    assert_eq!(list(&failed["id"], None).await, json!([]), "a failed run has none");
    let e = c.call("result.actions", json!({ "runId": "nope" })).await.unwrap_err();
    assert_eq!(code(&e), "notFound/");
    // Policies: greyed out, with the reason.
    let ws = c.ok("tree.children", json!({ "tree": "config" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    c.ok("params.set", json!({ "node": ws, "name": "protection.no_export", "value": "true", "type": "boolean" })).await;
    let l = list(&table["id"], None).await;
    assert_eq!((l[0]["enabled"].as_bool(), l[0]["disabledReason"].as_str()), (Some(false), Some("noExport")), "{l}");
    let e = c.call("run.start", json!({ "action": "t.user:analyze", "target": "core:none", "tabId": "t", "resultRun": table["id"] })).await.unwrap_err();
    assert_eq!(code(&e), "denied/noExport");
    c.ok("params.set", json!({ "node": ws, "name": "protection.no_export", "value": "false" })).await;
    c.ok("params.set", json!({ "node": ws, "name": "protection.readonly", "value": "true", "type": "boolean" })).await;
    let l = list(&table["id"], None).await;
    assert_eq!(l[0]["disabledReason"], "readonly", "{l}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn runs_read_works_only_for_the_clicked_action_and_the_clicked_run() {
    let (env, c) = world18(analyze_decl()).await;
    let source = run(&c, "t.user:emit", json!({})).await;
    let other = run(&c, "t.user:emit-text", json!({})).await;
    let sid = source["id"].as_str().unwrap();
    let conn = make(&c, "t.prov:conn", "c1", None).await;
    let r = click(&c, "t.user:analyze", sid, json!({ "otherRun": other["id"], "callee": conn })).await;
    assert_eq!(r["status"], "success", "{r}");
    let o = out(&r);
    assert_eq!(o["input"]["runId"], sid, "input.runId is the clicked run: {o}");
    let own = &o["own"]["ok"];
    assert_eq!((own["output"]["type"].as_str(), own["output"]["rows"].clone()), (Some("table"), json!([["1"], ["2"]])), "{o}");
    assert_eq!((own["meta"]["plugin"].as_str(), own["meta"]["at"].is_number()), (Some("t.user"), true), "{own}");
    // Another run: no.
    assert_eq!((o["other"]["error"].as_str(), o["other"]["params"]["reason"].as_str()), (Some("denied"), Some("notInResultAction")), "{o}");
    // The plugins it calls cannot read it, by `actions.call` or through the interface.
    assert_eq!(o["viaCall"]["ok"]["read"]["params"]["reason"], "notInResultAction", "{o}");
    assert_eq!(o["viaIface"]["ok"]["read"]["params"]["reason"], "notInResultAction", "{o}");
    // A run of the same action that was not a click: no.
    let p = run(&c, "t.user:plain", json!({ "id": sid })).await;
    assert_eq!(out(&p)["read"]["params"]["reason"], "notInResultAction", "{p}");
    let p = run(&c, "t.user:analyze", json!({ "runId": sid })).await;
    assert_eq!(out(&p)["own"]["params"]["reason"], "notInResultAction", "a typed runId opens nothing: {p}");
    // Outside a run.
    let r = c.probe("t.user", "runs.read", json!([sid])).await;
    assert_eq!(r["params"]["reason"], "notInResultAction", "{r}");
    // The read is audited without content; the refusals too.
    let a = audit(&env, "runs.read");
    assert!(a.iter().any(|x| x.3 == "ok" && x.1 == sid && !x.2.contains("\"1\"")), "{a:?}");
    assert!(a.iter().any(|x| x.3 == "failed:denied"), "{a:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_a_declared_action_on_a_finished_run_of_its_type_can_be_clicked() {
    let (_env, c) = world18(analyze_decl()).await;
    let table = run(&c, "t.user:emit", json!({})).await;
    let link = run(&c, "t.user:emit-link", json!({})).await;
    let failed = run(&c, "t.user:fail", json!({})).await;
    let start = |action: &str, src: &Value| c.call("run.start", json!({ "action": action, "target": "core:none", "tabId": "t", "resultRun": src }));
    assert_eq!(code(&start("t.user:plain", &table["id"]).await.unwrap_err()), "invalid/notResultAction");
    assert_eq!(code(&start("t.user:analyze", &link["id"]).await.unwrap_err()), "invalid/badResultRun");
    assert_eq!(code(&start("t.user:analyze", &failed["id"]).await.unwrap_err()), "invalid/badResultRun");
    assert_eq!(code(&start("t.user:analyze", &json!("nope")).await.unwrap_err()), "notFound/");
    assert_eq!(code(&start("t.nowhere:x", &table["id"]).await.unwrap_err()), "invalid/notResultAction");
    // No run was made for any of these.
    let runs = c.ok("run.tasks", json!({})).await;
    assert!(runs.as_array().unwrap().iter().all(|r| r["action"] != "t.user:analyze"), "{runs}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_interface_call_runs_the_implementers_action_in_the_same_run() {
    let (env, c) = world18(analyze_decl()).await;
    let conn = make(&c, "t.prov:conn", "c1", None).await;
    // The list.
    let l = out(&run(&c, "t.user:list", json!({})).await);
    assert_eq!(
        l["ok"],
        json!([{ "plugin": "t.prov", "kind": "t.prov:conn", "label": "t.prov" }, { "plugin": "t.prov2", "kind": "t.prov2:conn", "label": "t.prov2" }]),
        "{l}"
    );
    // The call: as the provider, with the resource, inside the caller's run; its partial output is the run's.
    let id = start(&c, "t.user:ask", json!({ "input": { "msg": "hi", "partial": "typing", "sleep": 300 }, "opts": { "resource": conn } })).await;
    let mut partial = None;
    for _ in 0..100 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["partial"]["text"] == "thinking" {
            partial = Some(r["partial"].clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(partial, Some(json!({ "type": "text", "text": "thinking" })));
    let r = finish(&c, &id).await;
    let o = out(&r);
    assert_eq!(r["status"], "success", "{r}");
    let ok = &o["ok"];
    assert_eq!((ok["echo"].as_str(), ok["resource"].as_str(), ok["caller"].as_str(), ok["run"].as_bool()), (Some("hi"), Some(conn.as_str()), Some("t.user"), Some(true)), "{o}");
    let a = audit(&env, "interfaces.call");
    assert_eq!(a.len(), 1, "{a:?}");
    assert!(a[0].0.contains("t.prov") && a[0].1 == "t.chat/1:chat" && a[0].2.contains("t.user") && a[0].3 == "ok", "{a:?}");
    // Nothing else was run: one run.
    let runs = c.ok("run.tasks", json!({})).await;
    assert_eq!(runs.as_array().unwrap().iter().filter(|r| r["action"] == "t.user:ask").count(), 1);
    assert!(runs.as_array().unwrap().iter().all(|r| r["plugin"] != "t.prov"), "no run of its own for the callee: {runs}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_refusal_of_an_interface_call() {
    let (env, c) = world18(analyze_decl()).await;
    let conn = make(&c, "t.prov:conn", "c1", None).await;
    let plain = make(&c, "t.prov:plain", "p1", None).await;
    let ask = |iface: Option<&str>, action: Option<&str>, opts: Value| {
        let mut i = json!({ "opts": opts });
        if let Some(x) = iface {
            i["iface"] = json!(x);
        }
        if let Some(x) = action {
            i["action"] = json!(x);
        }
        async { out(&run(&c, "t.user:ask", i).await) }
    };
    let why = |v: &Value| (v["error"].as_str().unwrap_or("ok").to_string(), v["params"]["reason"].as_str().unwrap_or("").to_string());
    let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
    // Not declared in `uses`.
    let o = out(&run(&c, "t.other:ask", json!({ "opts": { "resource": conn } })).await);
    assert_eq!(why(&o), pair("denied", "notUsed"), "{o}");
    assert_eq!(why(&ask(Some("t.else/1"), None, json!({ "resource": conn })).await), pair("denied", "notUsed"));
    // The resource: missing, unknown, the wrong kind.
    assert_eq!(why(&ask(None, None, json!({})).await).0, "invalidParams");
    assert_eq!(why(&ask(None, None, json!({ "resource": "nope" })).await).0, "notFound");
    assert_eq!(why(&ask(None, None, json!({ "resource": plain })).await), pair("invalid", "wrongInterface"));
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "G" })).await;
    let gid = g["key"].as_str().or_else(|| g["id"].as_str()).unwrap_or_default().to_string();
    if !gid.is_empty() {
        assert_eq!(why(&ask(None, None, json!({ "resource": gid })).await), pair("invalid", "wrongInterface"));
    }
    // An action the interface does not list.
    let o = ask(None, Some("secret"), json!({ "resource": conn })).await;
    assert_eq!(why(&o), pair("invalid", "noImplementation"), "{o}");
    // Outside a run.
    let r = c.probe("t.user", "interfaces.call", json!(["t.chat/1", "chat", {}, { "resource": conn }])).await;
    assert_eq!(why(&r), pair("denied", "notInRun"), "{r}");
    // `list` also needs `uses`.
    let r = c.probe("t.other", "interfaces.list", json!(["t.chat/1"])).await;
    assert_eq!(why(&r), pair("denied", "notUsed"));
    // Without an implementer (the provider disabled).
    let conn2 = make(&c, "t.prov2:conn", "c2", None).await;
    assert_eq!(why(&ask(None, None, json!({ "resource": conn2 })).await).0, "ok");
    c.ok("plugin.setEnabled", json!({ "plugin": "t.prov2", "enabled": false })).await;
    let o = ask(None, None, json!({ "resource": conn2 })).await;
    assert_eq!(why(&o), pair("invalid", "noImplementation"), "{o}");
    let l = out(&run(&c, "t.user:list", json!({})).await);
    assert_eq!(l["ok"].as_array().unwrap().len(), 1, "{l}");
    // The refusals are audited.
    let a = audit(&env, "interfaces.call");
    assert!(a.iter().any(|x| x.3 == "failed:denied" && x.1 == "t.chat/1"), "{a:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_reaches_a_running_interface_call() {
    let (_env, c) = world18(analyze_decl()).await;
    let conn = make(&c, "t.prov:conn", "c1", None).await;
    let id = start(&c, "t.user:ask", json!({ "input": { "sleep": 10_000 }, "opts": { "resource": conn } })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t = Instant::now();
    c.ok("run.cancel", json!({ "id": id })).await;
    assert_eq!(finish(&c, &id).await["status"], "cancelled");
    assert!(t.elapsed() < Duration::from_secs(2));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_ref_field_can_ask_for_every_implementer_of_an_interface() {
    let (_env, c) = world18(analyze_decl()).await;
    for n in ["beta", "alpha"] {
        make(&c, "t.prov:conn", n, None).await;
    }
    make(&c, "t.prov:plain", "not-a-connection", None).await;
    let note = make(&c, "t.user:note", "n", None).await;
    let _ = note;
    // t.user's own page (it `uses` the interface) lists them; t.other's (it does not) lists none.
    let user = c.ok("page.resolve", json!({ "target": "page:t.user/p" })).await;
    let labels: Vec<&str> = user["view"][0]["fields"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
    assert_eq!(labels, ["alpha", "beta"], "{user}");
    let other = c.ok("page.resolve", json!({ "target": "page:t.other/p" })).await;
    assert_eq!(other["view"][0]["fields"][0]["options"], json!([]), "{other}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ranked_search_any_word_relevance_and_kinds() {
    let (_env, c) = world18(analyze_decl()).await;
    let a = make(&c, "t.prov:conn", "Orders guide", Some("how to read the orders table")).await;
    let b = make(&c, "t.prov:conn", "Notes", Some("orders orders orders and refund details")).await;
    let d = make(&c, "t.prov:conn", "Refunds", Some("when money goes back")).await;
    let e = make(&c, "t.prov:plain", "Other kind", Some("orders refund")).await;
    make(&c, "t.prov:conn", "Unrelated", Some("nothing here")).await;
    // The shell's search: `all` (default) needs both words; `any` one of them.
    let titles = |r: &Value| r.as_array().unwrap().iter().map(|h| h["title"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let all = c.ok("search.query", json!({ "text": "orders refund" })).await;
    let mut t = titles(&all);
    t.sort();
    assert_eq!(t, ["Notes", "Other kind"], "{all}");
    let any = c.ok("search.query", json!({ "text": "orders refund", "mode": "any", "rank": "relevance" })).await;
    let t = titles(&any);
    assert_eq!(t.len(), 4, "{any}");
    assert!(t[..2].contains(&"Orders guide".to_string()) || t[0] == "Refunds", "name hits first: {t:?}");
    assert!(t[..2].iter().any(|x| x == "Orders guide") && t[..2].iter().any(|x| x == "Refunds"), "{t:?}");
    assert!(t.iter().position(|x| x == "Notes").unwrap() >= 2 || t.iter().position(|x| x == "Other kind").unwrap() >= 2);
    let only = c.ok("search.query", json!({ "text": "orders refund", "mode": "any", "kinds": ["t.prov:plain"] })).await;
    assert_eq!(titles(&only), ["Other kind"], "{only}");
    let both = c.ok("search.query", json!({ "text": "orders refund", "mode": "any", "kind": "t.prov:plain", "kinds": ["t.prov:conn"] })).await;
    assert_eq!(both, json!([]));
    let none = c.ok("search.query", json!({ "text": "orders", "kinds": [] })).await;
    assert_eq!(none, json!([]), "an empty list of kinds finds nothing");

    // The plugin's `resources.search`: the new form answers a list with score and snippet.
    let s = out(&run(&c, "t.user:search", json!({ "opts": { "query": "orders refund", "mode": "any", "rank": "relevance", "kinds": ["t.prov:conn"] } })).await);
    let hits = s["ok"].as_array().unwrap();
    assert_eq!(hits.len(), 3, "{s}");
    let ids: Vec<&str> = hits.iter().map(|h| h["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&a.as_str()) && ids.contains(&b.as_str()) && ids.contains(&d.as_str()) && !ids.contains(&e.as_str()), "{s}");
    let scores: Vec<f64> = hits.iter().map(|h| h["score"].as_f64().unwrap()).collect();
    assert!(scores.windows(2).all(|w| w[0] >= w[1]) && scores[0] > 0.0, "{scores:?}");
    let notes = hits.iter().find(|h| h["id"] == b.as_str()).unwrap();
    assert_eq!((notes["name"].as_str(), notes["kind"].as_str()), (Some("Notes"), Some("t.prov:conn")));
    assert_eq!(notes["snippet"], "", "review #4: a kind of another plugin gives no body text: {notes}");
    // Its own kinds do.
    make(&c, "t.user:note", "Mine", Some("my orders are here")).await;
    let s = out(&run(&c, "t.user:search", json!({ "opts": { "query": "orders", "kinds": ["note"] } })).await);
    assert!(s["ok"][0]["snippet"].as_str().unwrap().contains("orders"), "{s}");
    // Without ranking the scores are 0.
    let s = out(&run(&c, "t.user:search", json!({ "opts": { "query": "orders", "limit": 1 } })).await);
    assert_eq!((s["ok"].as_array().unwrap().len(), s["ok"][0]["score"].as_f64()), (1, Some(0.0)), "{s}");
    // The old form is unchanged: `text` answers `{ items, total, next }`.
    let s = out(&run(&c, "t.user:search", json!({ "opts": { "text": "orders", "kinds": ["t.prov:conn"] } })).await);
    assert_eq!((s["ok"]["total"].as_u64(), s["ok"]["items"].as_array().map(Vec::len)), (Some(2), Some(2)), "{s}");
    let s = out(&run(&c, "t.user:search", json!({ "opts": { "text": "orders", "query": "x" } })).await);
    assert_eq!(s["error"], "invalidParams", "{s}");
    // A kind written short is the plugin's own: t.user has `note` and none match.
    let s = out(&run(&c, "t.user:search", json!({ "opts": { "query": "orders", "kinds": ["note"] } })).await);
    assert_eq!(s["ok"].as_array().map(Vec::len), Some(1), "{s}");
    // Too many words.
    let many = (0..17).map(|i| format!("w{i}x")).collect::<Vec<_>>().join(" ");
    let s = out(&run(&c, "t.user:search", json!({ "opts": { "query": many, "mode": "any" } })).await);
    assert_eq!(s["error"], "invalidParams", "{s}");
}

/* ------------------------------------------------------------------ D441, D442 */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn data_goes_to_the_caller_and_a_run_ignores_it() {
    let (_env, c) = world18(analyze_decl()).await;
    let conn = make(&c, "t.prov:conn", "c1", None).await;
    // As an action of its own: the run succeeds, `data` is not kept.
    let r = run(&c, "t.prov:models", json!({})).await;
    assert_eq!((r["status"].as_str(), r["output"]["text"].as_str()), (Some("success"), Some("m")), "{r}");
    assert!(r.get("data").is_none() && !r.to_string().contains("\"n\":[1,2]"), "{r}");
    // Through the interface and `actions.call`: the whole answer, `data` as it is.
    let o = out(&run(&c, "t.user:ask", json!({ "action": "models", "opts": { "resource": conn } })).await);
    assert_eq!(o["ok"]["data"], json!({ "s": "ok", "n": [1, 2] }), "{o}");
    assert_eq!(o["ok"]["output"]["text"], "m");
    let o = out(&run(&c, "t.user:viacall", json!({})).await);
    assert_eq!(o["ok"]["data"], json!({ "s": "ok", "n": [1, 2] }), "{o}");
    // Over 1 MB: refused.
    let o = out(&run(&c, "t.user:ask", json!({ "action": "models", "input": { "big": true }, "opts": { "resource": conn } })).await);
    assert_eq!(o["error"], "pluginError", "{o}");
    let o = out(&run(&c, "t.user:viacall", json!({ "input": { "big": true } })).await);
    assert_eq!(o["error"], "pluginError", "{o}");
}

fn artifact_count(env: &Env) -> i64 {
    let conn = rusqlite::Connection::open(env.kernel.db_path()).unwrap();
    conn.query_row("SELECT count(*) FROM run_artifacts", [], |r| r.get(0)).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn artifacts_are_kept_for_the_clicked_run_and_only_by_their_owner() {
    let (env, c) = world18(analyze_decl()).await;
    let source = run(&c, "t.user:emit", json!({})).await;
    let sid = source["id"].as_str().unwrap();
    let save = |name: &str, data: Value| json!({ "m": "saveArtifact", "a": ["$runId", { "name": name, "kind": "analysis", "data": data }] });
    let ops = json!([
        save("first", json!({ "q": "why", "answer": "because" })),
        save("second", json!([1, 2])),
        { "m": "listArtifacts", "a": ["$runId"] },
        { "m": "getArtifact", "a": ["$last"] },
        { "m": "saveArtifact", "a": ["$runId", { "name": "", "kind": "analysis", "data": 1 }] },
        { "m": "saveArtifact", "a": ["$runId", { "name": "n", "kind": "bad kind", "data": 1 }] },
        { "m": "saveArtifact", "a": ["$runId", { "name": "n", "kind": "k", "data": 1, "x": 1 }] },
        { "m": "saveArtifact", "a": ["$runId", { "name": "n", "kind": "k", "data": "x".repeat(1_100_000) }] },
        { "m": "saveArtifact", "a": ["other-run", { "name": "n", "kind": "k", "data": 1 }] },
    ]);
    let r = click(&c, "t.user:analyze", sid, json!({ "ops": ops })).await;
    assert_eq!(r["status"], "success", "{r}");
    let o = out(&r)["ops"].clone();
    let (first, second) = (o[0]["ok"]["id"].as_str().unwrap().to_string(), o[1]["ok"]["id"].as_str().unwrap().to_string());
    let listed = o[2]["ok"].as_array().unwrap();
    assert_eq!(listed.len(), 2, "{o}");
    assert_eq!((listed[0]["name"].as_str(), listed[0]["kind"].as_str(), listed[0]["createdAt"].is_number()), (Some("first"), Some("analysis"), true));
    assert!(listed[0].get("data").is_none(), "the list has no data");
    let got = &o[3]["ok"];
    assert_eq!((got["id"].as_str(), got["runId"].as_str(), got["data"].clone()), (Some(second.as_str()), Some(sid), json!([1, 2])), "{o}");
    for i in 4..7 {
        assert_eq!(o[i]["error"], "invalidParams", "{i}: {o}");
    }
    assert_eq!(o[7]["params"]["reason"], "tooLarge", "{o}");
    assert_eq!(o[8]["params"]["reason"], "notInResultAction", "a run that was not clicked: {o}");
    assert_eq!(artifact_count(&env), 2);
    // Not a click: no saving (reading and deleting its own are fine from any run).
    let r = run(&c, "t.user:ops", json!({ "runId": sid, "ops": [
        save("sneaky", json!(1)),
        { "m": "listArtifacts", "a": ["$runId"] },
        { "m": "getArtifact", "a": [first.clone()] },
    ] })).await;
    let o = out(&r);
    assert_eq!(o[0]["params"]["reason"], "notInResultAction", "{o}");
    assert_eq!((o[1]["ok"].as_array().map(Vec::len), o[2]["ok"]["name"].as_str()), (Some(2), Some("first")), "{o}");
    // A page handler (the user saving) may add to a run it already keeps things for, not to another.
    let ev = c.ok("page.event", json!({ "target": "page:t.user/p", "event": json!({ "runId": sid, "ops": [save("later", json!("d"))] }).to_string() })).await;
    let o: Value = serde_json::from_str(ev["message"].as_str().unwrap()).unwrap();
    assert!(o[0]["ok"]["id"].is_string(), "{ev}");
    let other = run(&c, "t.user:emit-text", json!({})).await;
    let ev = c.ok("page.event", json!({ "target": "page:t.user/p", "event": json!({ "runId": other["id"], "ops": [save("later", json!("d"))] }).to_string() })).await;
    let o: Value = serde_json::from_str(ev["message"].as_str().unwrap()).unwrap();
    assert_eq!(o[0]["params"]["reason"], "notInResultAction", "{ev}");
    assert_eq!(artifact_count(&env), 3);
    // Another plugin sees and removes nothing of it.
    let r = c.probe("t.other", "runs.getArtifact", json!([first])).await;
    assert_eq!(r["error"], "notFound", "{r}");
    let r = c.probe("t.other", "runs.listArtifacts", json!([sid])).await;
    assert_eq!(r["ok"], json!([]), "{r}");
    let r = c.probe("t.other", "runs.deleteArtifact", json!([first])).await;
    assert_eq!(r["error"], "notFound", "{r}");
    let r = c.probe("t.other", "runs.saveArtifact", json!([sid, { "name": "n", "kind": "k", "data": 1 }])).await;
    assert_eq!(r["params"]["reason"], "notInResultAction", "{r}");
    // Its own delete works; audits carry no content.
    let r = c.probe("t.user", "runs.deleteArtifact", json!([first])).await;
    assert_eq!(r["ok"], Value::Null, "{r}");
    assert_eq!(artifact_count(&env), 2);
    let all = audit(&env, "runs.saveArtifact");
    assert!(all.iter().any(|x| x.3 == "failed:denied"), "refusals are audited too");
    let a: Vec<_> = all.iter().filter(|x| x.3 == "ok").collect();
    assert_eq!(a.len(), 3, "{all:?}");
    assert!(a.iter().all(|x| x.2.contains("bytes")) && all.iter().all(|x| !x.2.contains("because") && !x.2.contains("first")), "{all:?}");
    assert_eq!(audit(&env, "runs.deleteArtifact").iter().filter(|x| x.3 == "ok").count(), 1);
    // The environment's read-only rule: no saving, no deleting; reading stays.
    let ws = c.ok("tree.children", json!({ "tree": "config" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    c.ok("params.set", json!({ "node": ws, "name": "protection.readonly", "value": "true", "type": "boolean" })).await;
    let r = c.probe("t.user", "runs.deleteArtifact", json!([second])).await;
    assert_eq!(r["params"]["reason"], "readonly", "{r}");
    let r = c.probe("t.user", "runs.getArtifact", json!([second])).await;
    assert_eq!(r["ok"]["data"], json!([1, 2]), "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn artifacts_go_with_their_run_however_it_goes() {
    let (env, c) = world18(analyze_decl()).await;
    let ops = |n: &str| json!([{ "m": "saveArtifact", "a": ["$runId", { "name": n, "kind": "k", "data": 1 }] }]);
    // Deleting a kept run.
    let a = run(&c, "t.user:emit-text", json!({})).await;
    let r = click(&c, "t.user:analyze", a["id"].as_str().unwrap(), json!({ "ops": ops("a") })).await;
    assert!(out(&r)["ops"][0]["ok"]["id"].is_string(), "{r}");
    assert_eq!(artifact_count(&env), 1);
    c.ok("run.setKept", json!({ "id": a["id"], "kept": true })).await;
    let t = format!("run:{}", a["id"].as_str().unwrap());
    c.ok("command.execute", json!({ "id": "run.delete", "context": { "target": t, "args": { "confirmed": true } } })).await;
    assert_eq!(artifact_count(&env), 0);
    // The retention of 200 per action: the oldest run goes, and what it kept.
    let first = run(&c, "t.user:emit", json!({})).await;
    let r = click(&c, "t.user:analyze", first["id"].as_str().unwrap(), json!({ "ops": ops("b") })).await;
    assert!(out(&r)["ops"][0]["ok"]["id"].is_string(), "{r}");
    assert_eq!(artifact_count(&env), 1);
    for _ in 0..200 {
        run(&c, "t.user:emit", json!({})).await;
    }
    assert!(c.call("run.get", json!({ "id": first["id"] })).await.map(|v| v.is_null()).unwrap_or(true), "the first run is gone");
    assert_eq!(artifact_count(&env), 0, "and its artifact with it");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resource_setting_names_a_connection_of_an_implementer() {
    let (_env, c) = world18(analyze_decl()).await;
    let conn = make(&c, "t.prov:conn", "c1", None).await;
    let plain = make(&c, "t.prov:plain", "p1", None).await;
    let detail = c.ok("plugin.get", json!({ "plugin": "t.user" })).await;
    let s = &detail["settings"][0];
    assert_eq!((s["kind"].as_str(), s["value"].as_str()), (Some("ref"), Some("")), "{s}");
    assert_eq!(s["options"], json!([{ "value": conn, "label": "c1" }]), "only the implementers' connections");
    let set = |v: &str| c.call("plugin.setSetting", json!({ "plugin": "t.user", "name": "conn", "value": v }));
    set(&conn).await.unwrap();
    let r = c.probe("t.user", "settings.get", json!(["conn"])).await;
    assert_eq!(r["ok"], conn.as_str(), "{r}");
    for bad in [plain.as_str(), "nope"] {
        let e = set(bad).await.unwrap_err();
        assert_eq!(code(&e), "invalid/badValue", "{bad}");
    }
    set("").await.unwrap();
    assert_eq!(c.probe("t.user", "settings.get", json!(["conn"])).await["ok"], "");
}

/* ------------------------------------------------------------------ review round */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn using_an_interface_is_a_permission_and_builtin_plugins_stay_confirmed() {
    let plain = |uses: Value| {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugins");
        std::fs::create_dir_all(&root).unwrap();
        let mut e = json!({ "contributes": { "actions": [{ "id": "go", "label": "g", "output": "text" }] } });
        if !uses.is_null() {
            e["uses"] = uses;
        }
        pkg(&root, "t.x", e, "export default { activate(host) { host.actions.handle('go', async () => ({ output: { type: 'text', text: 'ran' } })); } };");
        (tmp, root)
    };
    let load = |root: &Path| onedesk_kernel::manifest::load_package(&root.join("t.x").join("0.1.0")).unwrap();
    let (_t0, r0) = plain(Value::Null);
    let (_t1, r1) = plain(json!(["t.chat/1"]));
    let (_t2, r2) = plain(json!(["t.chat/1", "t.gen/1"]));
    let (p0, p1, p2) = (load(&r0), load(&r1), load(&r2));
    assert!(p0.permissions().is_empty());
    assert!(p1.permissions().contains("uses:t.chat/1"), "{:?}", p1.permissions());
    let fp = |p: &onedesk_kernel::manifest::Plugin| onedesk_kernel::manifest::perm_fingerprint(&p.permissions());
    assert!(fp(&p0) != fp(&p1) && fp(&p1) != fp(&p2), "a change of what it uses is a change of permissions");
    let shown = p2.permission_list(|_| false);
    assert_eq!(shown.iter().filter(|x| x.id == "uses").count(), 1, "{shown:?}");
    assert_eq!(shown.iter().find(|x| x.id == "uses").unwrap().detail, "t.chat/1, t.gen/1");
    // Not built in: it waits for the user. Built in: it does not.
    for (builtin, expected) in [(false, "error"), (true, "success")] {
        let (tmp, root) = plain(json!(["t.chat/1"]));
        let mut cfg = config_for(&root);
        cfg.builtin = if builtin { vec!["t.x@0.1.0".to_string()] } else { vec![] };
        let env = open_exact(tmp, &root, cfg);
        let c = Client::in_proc(env.kernel.clone());
        c.hello().await;
        let r = run(&c, "t.x:go", json!({})).await;
        assert_eq!(r["status"], expected, "builtin={builtin}: {r}");
        if !builtin {
            assert_eq!(r["error"]["code"], "pluginDisabled", "waits for the user: {r}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn interface_resources_need_only_uses_and_never_show_secrets() {
    let (_env, c) = world18(analyze_decl()).await;
    let r = c.ok("page.save", json!({ "target": "new:t.prov:conn", "changes": { "name": "c1", "body.model": "m-1", "body.key": "sk-very-secret" } })).await;
    let id = r["page"]["resourceId"].as_str().unwrap().to_string();
    make(&c, "t.prov:plain", "p1", None).await;
    let l = c.probe("t.thin", "interfaces.resources", json!(["t.chat/1"])).await;
    let items = l["ok"].as_array().unwrap_or_else(|| panic!("{l}"));
    assert_eq!(items.len(), 1, "only connections of implementers: {l}");
    assert_eq!((items[0]["id"].as_str(), items[0]["name"].as_str(), items[0]["kind"].as_str()), (Some(id.as_str()), Some("c1"), Some("t.prov:conn")));
    assert_eq!(items[0]["fields"]["model"], "m-1", "{l}");
    assert!(items[0]["fields"].get("key").is_none() && !l.to_string().contains("sk-very-secret"), "{l}");
    // It can use them too, with no `depends` and no `requires.resources`.
    let o = out(&run(&c, "t.thin:ask", json!({ "opts": { "resource": id } })).await);
    assert_eq!(o["ok"]["echo"], "thin", "{o}");
    // Not declared: refused.
    let l = c.probe("t.other", "interfaces.resources", json!(["t.chat/1"])).await;
    assert_eq!(l["params"]["reason"], "notUsed", "{l}");
    let l = c.probe("t.thin", "interfaces.resources", json!(["t.gen/1"])).await;
    assert_eq!(l["params"]["reason"], "notUsed", "{l}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_interface_without_a_kind_needs_no_resource() {
    let (_env, c) = world18(analyze_decl()).await;
    let conn = make(&c, "t.prov:conn", "c1", None).await;
    async fn ask(c: &Client, opts: Value) -> Value {
        out(&run(c, "t.user:ask", json!({ "iface": "t.gen/1", "action": "gen", "input": { "x": 7 }, "opts": opts })).await)
    }
    let o = ask(&c, json!({})).await;
    assert_eq!(o["ok"]["data"], json!({ "got": 7, "resource": null, "caller": "t.user" }), "{o}");
    let o = ask(&c, Value::Null).await;
    assert_eq!(o["ok"]["data"]["got"], 7, "{o}");
    // A resource given anyway must be one of the interface's kind: this one is not.
    let o = ask(&c, json!({ "resource": conn })).await;
    assert_eq!((o["error"].as_str(), o["params"]["reason"].as_str()), (Some("invalid"), Some("wrongInterface")), "{o}");
    // An action it does not list.
    let o = out(&run(&c, "t.user:ask", json!({ "iface": "t.gen/1", "action": "nope" })).await);
    assert_eq!(o["params"]["reason"], "noImplementation", "{o}");
    // The interface with a kind still wants one.
    let o = out(&run(&c, "t.user:ask", json!({})).await);
    assert_eq!(o["error"], "invalidParams", "{o}");
    // Listing: no kind; and `@implements:` of it expands to nothing.
    let l = out(&run(&c, "t.user:list", json!({ "iface": "t.gen/1" })).await);
    assert_eq!(l["ok"], json!([{ "plugin": "t.gen", "kind": null, "label": "t.gen" }]), "{l}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_clicked_result_action_runs_in_the_source_runs_environment() {
    let (_env, c) = world18(analyze_decl()).await;
    let root = c.ok("tree.children", json!({ "tree": "env" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    let mut envs = Vec::new();
    for n in ["Prod", "Dev"] {
        let eff = c.ok("command.execute", json!({ "id": "env.newChild", "context": { "tree": "env", "nodeKey": root, "args": { "name": n } } })).await;
        envs.push(eff[0]["key"].as_str().unwrap().to_string());
    }
    let (prod, dev) = (envs[0].clone(), envs[1].clone());
    let start = |env: &str| c.ok("run.start", json!({ "action": "t.user:emit", "target": "core:none", "tabId": "t", "envId": env }));
    let from_prod = finish(&c, start(&prod).await.as_str().unwrap()).await;
    let from_dev = finish(&c, start(&dev).await.as_str().unwrap()).await;
    // The environment the shell names is ignored: the run's own is used.
    let id = c
        .ok("run.start", json!({ "action": "t.user:analyze", "target": "core:none", "tabId": "t", "resultRun": from_dev["id"], "envId": prod }))
        .await;
    let r = finish(&c, id.as_str().unwrap()).await;
    assert_eq!((r["status"].as_str(), r["envId"].as_str()), (Some("success"), Some(dev.as_str())), "{r}");
    // A protection of the source run's environment holds, even when the shell names no environment.
    c.ok("params.set", json!({ "node": prod, "name": "protection.readonly", "value": "true", "type": "boolean" })).await;
    let e = c.call("run.start", json!({ "action": "t.user:analyze", "target": "core:none", "tabId": "t", "resultRun": from_prod["id"] })).await.unwrap_err();
    assert_eq!(code(&e), "denied/readonly");
    let e = c
        .call("run.start", json!({ "action": "t.user:analyze", "target": "core:none", "tabId": "t", "resultRun": from_prod["id"], "envId": dev }))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "denied/readonly", "naming another environment does not lift it");
    // And another source is untouched.
    let id = c.ok("run.start", json!({ "action": "t.user:analyze", "target": "core:none", "tabId": "t", "resultRun": from_dev["id"] })).await;
    assert_eq!(finish(&c, id.as_str().unwrap()).await["status"], "success");
    let l = c.ok("result.actions", json!({ "runId": from_prod["id"] })).await;
    assert_eq!(l[0]["disabledReason"], "readonly", "{l}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_error_body_is_scrubbed_before_it_is_cut_and_encodings_go_too() {
    let (env, c, port, _) = net_world(Duration::from_secs(20)).await;
    let secret = "p@ss w/ord+1&more";
    c.ok("secrets.set", json!({ "name": "k", "value": secret })).await;
    let enc = (onedesk_kernel::secrets::percent(secret), onedesk_kernel::secrets::base64(secret.as_bytes()));
    let check = |text: &str| {
        for bad in [secret, "p@ss", enc.0.as_str(), enc.1.as_str(), &enc.1[..8], &enc.0[..8]] {
            assert!(!text.contains(bad), "{bad:?} leaked in {}", &text[text.len().saturating_sub(120)..]);
        }
    };
    // Streamed, an error status: the key straddles the 8 KB cut.
    let o = out(&run(&c, "t.net:stream", json!({ "port": port, "path": "/errkey", "headers": { "x-key": "{{secret:k}}" } })).await);
    let body = o["r"]["ok"]["body"].as_str().unwrap_or_else(|| panic!("{o}"));
    assert_eq!(o["r"]["ok"]["status"], 500);
    assert!(body.len() <= 8192 + 8 && body.contains("***"), "{}", body.len());
    check(body);
    let chunks: String = o["chunks"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    check(&chunks);
    assert_eq!(chunks.matches("***").count(), 3, "all three forms are scrubbed in what the callback gets: {}", &chunks[chunks.len().saturating_sub(100)..]);
    // Not streamed.
    let o = out(&run(&c, "t.net:plain", json!({ "port": port, "path": "/errkey", "opts": { "headers": { "x-key": "{{secret:k}}" } } })).await);
    check(o["ok"]["body"].as_str().unwrap());
    let _ = env;
}

/* ------------------------------------------------------------------ D446 */

const FMT_MAIN: &str = r##"
export default { activate(host) {
  host.actions.handle("md", async () => ({ output: { type: "text", text: "# Hi", format: "markdown" } }));
  host.actions.handle("badfmt", async () => ({ output: { type: "text", text: "x", format: "html" } }));
  host.actions.handle("plainfmt", async () => ({ output: { type: "text", text: "x" } }));
  host.actions.handle("part", async (ctx) => {
    await ctx.host.runs.partial({ type: "text", text: "**so far**", format: "markdown" });
    await ctx.host.util.sleep(1500);
    return { output: { type: "text", text: "done", format: "markdown" } };
  });
  host.actions.handle("badpart", async (ctx) => {
    let r;
    try { await ctx.host.runs.partial({ type: "text", text: "x", format: "html" }); r = "ok"; } catch (e) { r = e.code + "/" + (e.params || {}).reason; }
    return { output: { type: "text", text: r } };
  });
} };
"##;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn text_output_keeps_its_format_and_a_run_is_titled_by_its_action_label() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    let a = |id: &str, label: &str| json!({ "id": id, "label": label, "output": "text" });
    pkg(&root, "t.fmt", json!({
        "contributes": { "actions": [a("md", "ra.analyze"), a("badfmt", "ra.analyze"), a("plainfmt", "no.such.key"), a("part", "ra.other"), a("badpart", "ra.other")],
                         "locales": { "en-US": "locales/en-US.json", "ja-JP": "locales/ja-JP.json" } }
    }), FMT_MAIN);
    let env = open_exact(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;

    let r = run(&c, "t.fmt:md", json!({})).await;
    assert_eq!(r["output"], json!({ "type": "text", "text": "# Hi", "format": "markdown" }), "{r}");
    // Saved as given: reading it again returns the same.
    assert_eq!(c.ok("run.get", json!({ "id": r["id"] })).await["output"]["format"], "markdown");
    assert_eq!(r["title"], "Analyze", "the label in the plugin's language");
    let r = run(&c, "t.fmt:plainfmt", json!({})).await;
    assert!(r["output"].get("format").is_none(), "{r}");
    assert_eq!(r["title"], "plainfmt", "no label text: the action's name, not the full id");
    // A value outside plain/markdown is refused.
    let r = run(&c, "t.fmt:badfmt", json!({})).await;
    assert_eq!(r["status"], "error", "{r}");
    let r = run(&c, "t.fmt:badpart", json!({})).await;
    assert_eq!(r["output"]["text"], "invalid/badOutput", "{r}");
    // `runs.partial` carries it while the run goes on.
    let id = start(&c, "t.fmt:part", json!({})).await;
    let mut seen = Value::Null;
    for _ in 0..100 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["partial"].is_object() {
            seen = r["partial"].clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(seen, json!({ "type": "text", "text": "**so far**", "format": "markdown" }));
    assert_eq!(finish(&c, &id).await["output"]["format"], "markdown");
    // The title follows the interface language the run was started in.
    let id = c.ok("run.start", json!({ "action": "t.fmt:md", "target": "core:none", "tabId": "t", "input": {}, "locale": "ja-JP" })).await;
    assert_eq!(finish(&c, id.as_str().unwrap()).await["title"], "分析");
}
