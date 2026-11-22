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
  host.actions.handle("models", async () => ({ models: ["m1"] }));
  host.actions.handle("test", async () => ({ ok: true }));
  host.actions.handle("secret", async () => ({}));
  host.actions.handle("readit", async (ctx, input) => ({ read: await tryIt(() => ctx.host.runs.read(input.id)) }));
} };
"#;

const USER_MAIN: &str = r#"
export default { activate(host) {
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
    return text({ input, own, other, viaCall, viaIface });
  });
  host.actions.handle("plain", async (ctx, input) => text({ input, read: await tryIt(() => ctx.host.runs.read(input.id)) }));
  host.actions.handle("search", async (ctx, input) => text(await tryIt(() => ctx.host.resources.search(input.opts))));
  host.pages.handle("p", { async render(ctx) { return { view: [{ type: "form", id: "f", layout: "stack", fields: [
    { name: "conn", label: "Connection", kind: "ref", kinds: input_kinds }
  ] }] }; } });
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
        "uses": ["t.chat/1"],
        "requires": { "resources": true },
        "contributes": {
            "kinds": [{ "id": "note", "label": "Note", "icon": "box", "tree": "resources", "newName": "n" }],
            "pages": [{ "id": "p" }],
            "actions": [a("ask", "text"), a("list", "text"), a("emit", "table"), a("emit-text", "text"), a("emit-link", "link"), a("fail", "text"),
                        a("analyze", "text"), a("plain", "text"), a("search", "text")],
            "commands": [{ "id": "probe", "label": "p" }],
            "locales": { "en-US": "locales/en-US.json", "ja-JP": "locales/ja-JP.json" },
            "resultActions": result_actions
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
            "kinds": [{ "id": "conn", "label": "Conn", "icon": "box", "tree": "resources", "newName": "c" },
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
            if k == "resultActions" {
                e["contributes"]["resultActions"] = v.clone();
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
    for bad in [
        json!([]),
        json!({ "t.chat": { "actions": ["chat"], "kind": "conn" } }),
        json!({ "t.chat/1": { "actions": [], "kind": "conn" } }),
        json!({ "t.chat/1": { "actions": ["hid"], "kind": "conn" } }),
        json!({ "t.chat/1": { "actions": ["chat", "chat"], "kind": "conn" } }),
        json!({ "t.chat/1": { "actions": ["chat"], "kind": "nope" } }),
        json!({ "t.chat/1": { "actions": ["chat"] } }),
        json!({ "t.chat/1": { "actions": ["chat"], "kind": "conn", "x": 1 } }),
    ] {
        assert_eq!(im(bad.clone()), "badImplements", "{bad}");
    }
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
    assert!(notes["snippet"].as_str().unwrap().contains("orders"), "{notes}");
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
    assert_eq!(s["ok"], json!([]), "{s}");
    // Too many words.
    let many = (0..17).map(|i| format!("w{i}x")).collect::<Vec<_>>().join(" ");
    let s = out(&run(&c, "t.user:search", json!({ "opts": { "query": many, "mode": "any" } })).await);
    assert_eq!(s["error"], "invalidParams", "{s}");
}
