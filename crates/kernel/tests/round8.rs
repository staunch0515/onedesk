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
