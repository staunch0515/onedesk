//! Sandbox limits and host-capability permissions, through the protocol.

mod common;

use std::time::{Duration, Instant};

use common::*;
use onedesk_protocol::ErrorCode;
use serde_json::{json, Value};

const GAMMA: &str = r#"
export default { activate(host) {
  host.commands.handle("fx", async (ctx, context) => context.args.effects);
  host.pages.handle("p", { async render(ctx) {
    const k = ctx.node.key;
    const text = (id, v) => ({ view: [{ type: "text", id, text: typeof v === "string" ? v : JSON.stringify(v) }] });
    if (k === "spin") { while (true) {} }
    if (k === "oom") { const a = []; while (true) a.push(new Array(100000).fill(1)); }
    if (k === "globals") {
      const names = ["require", "process", "fetch", "console", "setTimeout", "setInterval", "std", "os",
                     "XMLHttpRequest", "WebSocket", "Deno", "Bun", "importScripts", "module", "exports"];
      return text("g", names.filter((n) => typeof globalThis[n] !== "undefined"));
    }
    if (k === "import") {
      const out = {};
      for (const m of ["fs", "node:fs", "qjs:std", "qjs:os", "../../test.alpha/0.1.0/main.js", "/etc/passwd",
                       "https://example.com/a.js", "./helper.js", "./sub/../helper.js"]) {
        try { await import(m); out[m] = "loaded"; } catch (e) { out[m] = "blocked"; }
      }
      return text("i", out);
    }
    if (k === "badview") return { view: [{ type: "text", id: "t", text: "x", style: "color:red" }] };
    if (k === "badnode") return { view: [{ type: "iframe", id: "t" }] };
    if (k === "extra") return { view: [], script: "x" };
    if (k === "count") { globalThis.n = (globalThis.n || 0) + 1; return text("c", String(globalThis.n)); }
    return { view: [] };
  } });
} };
"#;

const DELTA: &str = r#"
export default { activate(host) {
  host.pages.handle("p2", { async render() { return { view: [] }; } });
  host.pages.handle("notInManifest", { async render() { return { view: [] }; } });
} };
"#;

fn tree(id: &str, page: &str) -> Value {
    json!({ "trees": [{ "id": id, "label": "t", "icon": "box", "source": "provided", "page": page }],
            "pages": [{ "id": page }] })
}

async fn setup() -> (Env, Client) {
    setup_with(test_config()).await
}

async fn setup_with(cfg: onedesk_kernel::KernelConfig) -> (Env, Client) {
    let tmp = tempfile::tempdir().unwrap();
    let mut gamma = tree("t", "p");
    gamma["commands"] = json!([{ "id": "fx", "label": "fx" }]);
    let plugins = plugins_with(tmp.path(), &[("test.gamma", gamma, GAMMA), ("test.delta", tree("t2", "p2"), DELTA)]);
    std::fs::write(plugins.join("test.gamma/0.1.0/helper.js"), "export const x = 1;").unwrap();
    let env = open_with(tmp, &plugins, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

async fn render(c: &Client, key: &str) -> Result<Value, onedesk_protocol::ProtocolError> {
    c.call("page.resolve", json!({ "target": format!("node:test.gamma:t/{key}") })).await
}

fn text_of(page: &Value) -> String {
    page["view"][0]["text"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sandbox_has_no_require_process_fetch_or_other_ambient_globals() {
    let (_env, c) = setup().await;
    assert_eq!(text_of(&render(&c, "globals").await.unwrap()), "[]");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sandbox_modules_load_only_files_of_the_package() {
    let (_env, c) = setup().await;
    let out: Value = serde_json::from_str(&text_of(&render(&c, "import").await.unwrap())).unwrap();
    for (m, v) in out.as_object().unwrap() {
        let expect = if m == "./helper.js" { "loaded" } else { "blocked" };
        assert_eq!(v, expect, "{m}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sandbox_dead_loop_is_interrupted_and_kernel_keeps_answering() {
    let (env, c) = setup().await;
    let c = std::sync::Arc::new(c);
    let c2 = c.clone();
    let spinning = tokio::spawn(async move { render(&c2, "spin").await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let t = Instant::now();
    c.ok("tree.list", Value::Null).await;
    c.ok("tree.children", json!({ "tree": "resources" })).await;
    assert!(t.elapsed() < Duration::from_millis(250), "kernel answered in {:?}", t.elapsed());
    let e = spinning.await.unwrap().unwrap_err();
    assert_eq!(e.code, ErrorCode::PluginTimeout);
    // The runtime was discarded; the next use activates the plugin again.
    let before = env.kernel.activation_count();
    assert_eq!(text_of(&render(&c, "count").await.unwrap()), "1");
    assert_eq!(env.kernel.activation_count(), before + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sandbox_out_of_memory_discards_the_runtime_and_reactivates() {
    let (env, c) = setup().await;
    assert_eq!(text_of(&render(&c, "count").await.unwrap()), "1");
    assert_eq!(text_of(&render(&c, "count").await.unwrap()), "2");
    let n = env.kernel.activation_count();
    let e = render(&c, "oom").await.unwrap_err();
    assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::PluginError, "outOfMemory"));
    assert!(!env.kernel.active_plugins().contains(&"test.gamma".to_string()));
    assert_eq!(text_of(&render(&c, "count").await.unwrap()), "1", "fresh runtime after the discard");
    assert_eq!(env.kernel.activation_count(), n + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn view_validation_rejects_unknown_fields_and_node_types() {
    let (_env, c) = setup().await;
    for k in ["badview", "badnode", "extra"] {
        let e = render(&c, k).await.unwrap_err();
        assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::PluginError, "badOutput"), "{k}");
    }
    // The plugin stays usable.
    render(&c, "count").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registering_a_page_missing_from_the_manifest_fails_activation() {
    let (env, c) = setup().await;
    let e = c.call("page.resolve", json!({ "target": "node:test.delta:t2/x" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::PluginError);
    assert!(e.detail.unwrap_or_default().contains("notInManifest"));
    assert!(!env.kernel.active_plugins().contains(&"test.delta".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resources_of_another_plugins_kind_are_denied() {
    let (_env, c) = setup().await;
    let thing = c.ok("page.save", json!({ "target": "new:test.beta:thing", "changes": { "name": "T" } })).await;
    let tid = thing["page"]["resourceId"].as_str().unwrap().to_string();
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "G" })).await;
    let gid = g["key"].as_str().unwrap().to_string();
    for (method, args) in [
        ("resources.get", json!([tid])),
        ("resources.update", json!([tid, { "name": "x" }])),
        ("resources.move", json!([tid, { "parent": gid }])),
        ("resources.remove", json!([tid])),
        ("resources.list", json!([{ "kind": "test.beta:thing" }])),
        ("resources.create", json!([{ "kind": "test.beta:thing", "name": "x", "body": {} }])),
        ("resources.update", json!([gid, { "name": "x" }])),
        ("resources.create", json!([{ "kind": "core:group", "name": "x", "body": {} }])),
    ] {
        let r = c.probe("test.alpha", method, args.clone()).await;
        assert_eq!(r["error"], "denied", "{method} {args}");
    }
    assert_eq!(c.ok("resource.get", json!({ "id": tid })).await["name"], "T");
    // Its own kind works, through the same pipeline, as the plugin.
    let r = c.probe("test.alpha", "resources.create", json!([{ "kind": "item", "name": "mine", "parent": gid, "body": { "text": "t" } }])).await;
    let created = &r["ok"];
    assert_eq!(created["createdBy"], "plugin:test.alpha@0.1.0");
    assert_eq!(created["parentId"], gid.as_str());
    let id = created["id"].as_str().unwrap();
    let r = c.probe("test.alpha", "resources.update", json!([id, { "body.text": "u" }, 1])).await;
    assert_eq!(r["ok"]["rev"], 2);
    let r = c.probe("test.alpha", "resources.update", json!([id, { "body.text": "v" }, 1])).await;
    assert_eq!(r["error"], "conflict");
    let r = c.probe("test.alpha", "resources.list", json!([{}])).await;
    assert_eq!(r["ok"].as_array().unwrap().len(), 1);
    assert_eq!(c.probe("test.alpha", "resources.remove", json!([id])).await["ok"], Value::Null);
}

/// Grants `<tmp>/a/b` to test.alpha and lays out the escape routes next to it.
async fn files_setup() -> (Env, Client, std::path::PathBuf, std::path::PathBuf) {
    let (env, c) = setup().await;
    let base = env.path();
    let grant = base.join("a/b");
    let outside = base.join("outside");
    std::fs::create_dir_all(&grant).unwrap();
    std::fs::create_dir_all(base.join("a/bc")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "outside").unwrap();
    std::fs::write(base.join("a/bc/secret.txt"), "sibling").unwrap();
    std::fs::write(grant.join("ok.txt"), "fine").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), grant.join("link.txt")).unwrap();
    c.ok("plugin.grantFolder", json!({ "plugin": "test.alpha", "path": grant.display().to_string() })).await;
    (env, c, grant, outside)
}

#[tokio::test(flavor = "multi_thread")]
async fn host_files_outside_granted_folder_is_denied() {
    let (_env, c, grant, outside) = files_setup().await;
    let ok = c.probe("test.alpha", "files.readText", json!([grant.join("ok.txt").display().to_string()])).await;
    assert_eq!(ok["ok"]["text"], "fine");
    let p = outside.join("secret.txt").display().to_string();
    assert_eq!(c.probe("test.alpha", "files.readText", json!([p])).await["error"], "denied");
    assert_eq!(c.probe("test.alpha", "files.writeText", json!([p, "x"])).await["error"], "denied");
    assert_eq!(c.probe("test.alpha", "files.list", json!([outside.display().to_string()])).await["error"], "denied");
    assert_eq!(std::fs::read_to_string(outside.join("secret.txt")).unwrap(), "outside");
}

#[tokio::test(flavor = "multi_thread")]
async fn host_files_dotdot_is_denied() {
    let (_env, c, grant, outside) = files_setup().await;
    let p = format!("{}/../../outside/secret.txt", grant.display());
    assert_eq!(c.probe("test.alpha", "files.readText", json!([p])).await["error"], "denied");
    let w = format!("{}/../../outside/new.txt", grant.display());
    assert_eq!(c.probe("test.alpha", "files.writeText", json!([w, "x"])).await["error"], "denied");
    assert!(!outside.join("new.txt").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn host_files_symlink_pointing_outside_is_denied() {
    let (_env, c, grant, outside) = files_setup().await;
    let l = grant.join("link.txt").display().to_string();
    assert_eq!(c.probe("test.alpha", "files.readText", json!([l])).await["error"], "denied");
    assert_eq!(c.probe("test.alpha", "files.writeText", json!([l, "x"])).await["error"], "denied");
    assert_eq!(std::fs::read_to_string(outside.join("secret.txt")).unwrap(), "outside");
}

#[tokio::test(flavor = "multi_thread")]
async fn host_files_same_name_prefix_is_denied() {
    let (_env, c, grant, _outside) = files_setup().await;
    let p = format!("{}c/secret.txt", grant.display());
    assert_eq!(c.probe("test.alpha", "files.readText", json!([p])).await["error"], "denied");
    assert_eq!(c.probe("test.alpha", "files.stat", json!([p])).await["error"], "denied");
}

#[tokio::test(flavor = "multi_thread")]
async fn host_files_without_manifest_request_is_denied() {
    let (env, c) = setup().await;
    let p = env.path().display().to_string();
    // test.beta's manifest does not set requires.files; even its roots are refused.
    for (m, a) in [("files.roots", json!([])), ("files.list", json!([p])), ("files.readText", json!([p]))] {
        assert_eq!(c.probe("test.beta", m, a).await["error"], "denied", "{m}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn host_file_writes_are_audited_as_the_plugin() {
    let (env, c, grant, _) = files_setup().await;
    let p = grant.join("new.txt");
    let r = c.probe("test.alpha", "files.writeText", json!([p.display().to_string(), "hi"])).await;
    assert!(r["ok"]["basis"].is_string());
    let conn = rusqlite::Connection::open(env.kernel.db_path()).unwrap();
    let (actor, object): (String, String) = conn
        .query_row("SELECT actor, object FROM audit WHERE op = 'files.write'", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((actor.as_str(), object.as_str()), ("plugin:test.alpha@0.1.0", p.display().to_string().as_str()));
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_or_undeclared_commands_are_not_found() {
    let (_env, c) = setup().await;
    for id in ["test.alpha:nope", "nope:probe", "node.nope", "new:test.alpha:nope"] {
        let e = c.call("command.execute", json!({ "id": id })).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound, "{id}");
    }
}

fn audit_rows(env: &Env, sql: &str) -> Vec<(String, String, String)> {
    let conn = rusqlite::Connection::open(env.kernel.db_path()).unwrap();
    let mut st = conn.prepare(sql).unwrap();
    st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(|r| r.unwrap()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn refused_host_calls_are_audited() {
    let (env, c, _grant, outside) = files_setup().await;
    let thing = c.ok("page.save", json!({ "target": "new:test.beta:thing", "changes": { "name": "T" } })).await;
    let tid = thing["page"]["resourceId"].as_str().unwrap().to_string();
    assert_eq!(c.probe("test.alpha", "resources.update", json!([tid, { "name": "x" }])).await["error"], "denied");
    let secret = outside.join("secret.txt").display().to_string();
    assert_eq!(c.probe("test.alpha", "files.readText", json!([secret])).await["error"], "denied");
    assert_eq!(c.probe("test.beta", "files.roots", json!([])).await["error"], "denied");
    let rows = audit_rows(&env, "SELECT actor, op, object FROM audit WHERE result = 'failed:denied' ORDER BY seq");
    assert_eq!(
        rows,
        vec![
            ("plugin:test.alpha@0.1.0".into(), "resources.update".into(), tid),
            ("plugin:test.alpha@0.1.0".into(), "files.readText".into(), secret),
            ("plugin:test.beta@0.1.0".into(), "files.roots".into(), String::new()),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn plugin_commands_cannot_return_consent_effects_or_bad_targets() {
    let (_env, c) = setup().await;
    let run = |effects: Value| {
        let c = &c;
        async move { c.call("command.execute", json!({ "id": "test.gamma:fx", "context": { "args": { "effects": effects } } })).await }
    };
    for bad in [
        json!([{ "type": "pick-folder", "plugin": "test.alpha" }]),
        json!([{ "type": "confirm", "message": "m", "command": "node.delete" }]),
        json!([{ "type": "open", "target": "https://example.com" }]),
        json!([{ "type": "toast", "message": "ok" }, { "type": "pick-folder", "plugin": "test.gamma" }]),
    ] {
        let e = run(bad.clone()).await.unwrap_err();
        assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::PluginError, "badOutput"), "{bad}");
    }
    let ok = json!([{ "type": "open", "target": "resource:x" }, { "type": "toast", "message": "hi" }, { "type": "copy", "text": "t" }, { "type": "reload" }]);
    assert_eq!(run(ok.clone()).await.unwrap(), ok);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn file_write_finished_after_call_timeout_is_still_audited() {
    let mut cfg = test_config();
    cfg.sandbox.call_timeout = Duration::from_millis(500);
    let (env, c) = setup_with(cfg).await;
    let grant = env.path().join("g");
    std::fs::create_dir_all(&grant).unwrap();
    c.ok("plugin.grantFolder", json!({ "plugin": "test.alpha", "path": grant.display().to_string() })).await;
    // The basis check reads the file first; a FIFO makes that read wait until we feed it,
    // so the plugin call times out while the write is still in progress.
    let fifo = grant.join("slow.txt");
    assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
    let basis = onedesk_kernel::util::fingerprint(b"old");
    let args = json!({ "method": "files.writeText", "args": [fifo.display().to_string(), "new", { "basis": basis }] });
    let e = c.call("command.execute", json!({ "id": "test.alpha:probe", "context": { "args": args } })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::PluginTimeout);
    let f2 = fifo.clone();
    tokio::task::spawn_blocking(move || std::fs::write(f2, "old")).await.unwrap().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let rows = audit_rows(&env, "SELECT actor, op, object FROM audit WHERE op = 'files.write'");
        if !rows.is_empty() {
            assert_eq!(rows[0].2, fifo.display().to_string());
            break;
        }
        assert!(Instant::now() < deadline, "the finished write was never audited");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(std::fs::read_to_string(&fifo).unwrap(), "new");
}
