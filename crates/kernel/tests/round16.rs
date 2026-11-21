//! Round 16 (kernel): `activation: ["workspace.opened"]` (X13), `files.*` in a plugin's own folder,
//! `resources.upsertByKey` with the "missing" state (parity A1, A3, A4), `run.reuse` of a `new:`
//! run (E3), a toolbar command refreshing its provided tree (X9), and a called plugin's error text
//! reaching the caller (D413). Plugins are generated into a temporary folder.

mod common;

use std::path::Path;
use std::time::Duration;

use common::*;
use serde_json::{json, Value};

const PROBE: &str = r#"
async function probe(ctx, context) {
  const a = (context && context.args) || {};
  const [cap, op] = a.method.split(".");
  try { return [{ type: "copy", text: JSON.stringify({ ok: await ctx.host[cap][op](...a.args) }) }]; }
  catch (e) { return [{ type: "copy", text: JSON.stringify({ error: e.code || String(e), params: e.params || {}, message: e.message, detail: e.detail }) }]; }
}
"#;

fn pkg(root: &Path, id: &str, extra: Value, main: &str) {
    let dir = root.join(id).join("0.1.0");
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": id, "icon": "box", "main": "main.js" });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(dir.join("main.js"), format!("{PROBE}\n{main}")).unwrap();
}

/// An indexing plugin: indexes `<granted>/*.txt` when the workspace opens.
const CAT: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.commands.handle("mode", async (ctx) => {
    const m = await ctx.host.storage.get("mode");
    await ctx.host.storage.set("mode", m === 2 ? 1 : 2);
    return [];
  });
  host.trees.handle("t", { async children(ctx) {
    const m = (await ctx.host.storage.get("mode")) || 1;
    return { nodes: [{ key: "mode" + m, label: "mode " + m, icon: "box", expandable: false }] };
  } });
  host.events.on("workspace.opened", async (ctx, payload) => {
    const roots = await ctx.host.files.roots();
    const items = [];
    for (const r of roots) {
      const page = await ctx.host.files.list(r.path, {});
      for (const e of page.entries.filter((e) => !e.dir)) {
        const t = await ctx.host.files.readText(e.path);
        items.push({ key: e.path, description: "mtime " + (e.modifiedAt > 0), body: { text: t.text } });
      }
    }
    const done = await ctx.host.resources.upsertByKey("q", items, { othersMissing: true });
    await ctx.host.files.writeText("opened.json", JSON.stringify({ payload, event: ctx.event, done }));
  });
} };
"#;

fn cat_manifest() -> Value {
    json!({
        "requires": { "files": true },
        "activation": ["workspace.opened"],
        "contributes": {
            "kinds": [{ "id": "q", "label": "Q", "icon": "file", "tree": "resources", "newName": "q",
                        "defaults": { "text": "", "extra": "kept" } }],
            "commands": [{ "id": "probe", "label": "p" }, { "id": "mode", "label": "m" }],
            "trees": [{ "id": "t", "label": "T", "icon": "box", "source": "provided", "toolbar": ["mode"] }]
        }
    })
}

struct World {
    env: Env,
    c: Client,
    folder: std::path::PathBuf,
}

/// Opens a workspace, grants `folder` to `t.cat`, and opens it again (so `workspace.opened` sees it).
async fn world(files: &[(&str, &str)]) -> World {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    pkg(&root, "t.cat", cat_manifest(), CAT);
    let folder = tmp.path().join("queries");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = std::fs::canonicalize(folder).unwrap();
    for (n, t) in files {
        std::fs::write(folder.join(n), t).unwrap();
    }
    let ws = tmp.path().join("ws");
    {
        let k = std::sync::Arc::new(onedesk_kernel::Kernel::open(&ws, &root, config_for(&root)).unwrap());
        let c = Client::in_proc(k.clone());
        c.hello().await;
        // The first opening already sent `workspace.opened` (nothing granted yet).
        let first = ws.join("plugin-data/t.cat/opened.json");
        for _ in 0..500 {
            if first.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(first.exists(), "workspace.opened on the first opening");
        std::fs::remove_file(&first).unwrap();
        c.ok("plugin.grantFolder", json!({ "plugin": "t.cat", "path": folder.display().to_string() })).await;
        k.shutdown();
    }
    let env = open_exact(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    World { env, c, folder }
}

fn own(env: &Env, plugin: &str) -> std::path::PathBuf {
    env.path().join("ws").join("plugin-data").join(plugin)
}

/// Waits until the `workspace.opened` handler wrote its report into its own folder.
async fn opened(env: &Env) -> Value {
    let f = own(env, "t.cat").join("opened.json");
    for _ in 0..500 {
        if let Ok(t) = std::fs::read_to_string(&f) {
            return serde_json::from_str(&t).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("workspace.opened did not run");
}

async fn of_kind(c: &Client) -> Vec<Value> {
    let nodes = c.ok("tree.children", json!({ "tree": "resources" })).await["nodes"].as_array().unwrap().clone();
    nodes.into_iter().filter(|n| n["kind"] == "t.cat:q").collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_opened_activates_and_indexes_by_external_key() {
    let w = world(&[("a.txt", "select 1"), ("b.txt", "select 2")]).await;
    let r = opened(&w.env).await;
    assert_eq!((r["event"].as_str(), &r["payload"]), (Some("workspace.opened"), &json!({})), "{r}");
    assert_eq!(r["done"]["created"], 2, "{r}");
    let a_key = w.folder.join("a.txt").display().to_string();
    let a_id = r["done"]["ids"][&a_key].as_str().unwrap().to_string();
    let res = w.c.ok("resource.get", json!({ "id": a_id })).await;
    // Name from the key's last part; body = the kind's defaults with the given keys on top.
    assert_eq!((res["name"].as_str(), res["body"]["text"].as_str(), res["body"]["extra"].as_str()), (Some("a.txt"), Some("select 1"), Some("kept")));
    assert_eq!(res["description"], "mtime true", "modifiedAt is there: {res}");
    assert_eq!(of_kind(&w.c).await.len(), 2);
    // The plugin sees the key and the state.
    let p = w.c.probe("t.cat", "resources.get", json!([a_id])).await;
    assert_eq!((p["ok"]["externalKey"].as_str(), p["ok"]["missing"].as_bool()), (Some(a_key.as_str()), Some(false)), "{p}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upsert_commits_given_fields_only_and_marks_others_missing() {
    let w = world(&[("a.txt", "one")]).await;
    let r = opened(&w.env).await;
    let a_key = w.folder.join("a.txt").display().to_string();
    let id = r["done"]["ids"][&a_key].as_str().unwrap().to_string();
    // The user tags it, favourites it, renames it.
    let rev = w.c.ok("resource.get", json!({ "id": id })).await["rev"].as_i64().unwrap();
    w.c.ok("page.save", json!({ "target": format!("resource:{id}"), "basis": rev.to_string(), "changes": { "tags": ["mine"], "name": "Mine" } })).await;
    w.c.ok("resource.setFavorite", json!({ "id": id, "favorite": true })).await;
    let up = |items: Value, opts: Value| w.c.probe("t.cat", "resources.upsertByKey", json!(["q", items, opts]));
    // Same content: unchanged, nothing written.
    let before = w.c.ok("resource.get", json!({ "id": id })).await;
    let u = up(json!([{ "key": a_key, "body": { "text": "one" } }]), json!({})).await;
    assert_eq!((u["ok"]["unchanged"].as_u64(), u["ok"]["updated"].as_u64()), (Some(1), Some(0)), "{u}");
    assert_eq!(w.c.ok("resource.get", json!({ "id": id })).await["rev"], before["rev"]);
    // New text and description: only those change; tags, favourite, name and `extra` stay.
    let u = up(json!([{ "key": a_key, "description": "d2", "body": { "text": "two" } }]), json!({})).await;
    assert_eq!(u["ok"]["updated"], 1, "{u}");
    let res = w.c.ok("resource.get", json!({ "id": id })).await;
    assert_eq!(
        (res["body"]["text"].as_str(), res["description"].as_str(), res["name"].as_str(), res["tags"].clone(), res["favorite"].as_bool(), res["body"]["extra"].as_str()),
        (Some("two"), Some("d2"), Some("Mine"), json!(["mine"]), Some(true), Some("kept")),
        "{res}"
    );
    // A run of it, to see that it survives the file going away.
    // (No action here: the run record is checked through its resource id below.)
    // The file is gone: a sync without it marks it missing.
    let u = up(json!([]), json!({ "othersMissing": true })).await;
    assert_eq!(u["ok"]["missing"], 1, "{u}");
    let res = w.c.ok("resource.get", json!({ "id": id })).await;
    assert_eq!((res["state"].as_str(), res["stateReason"].as_str()), (Some("broken"), Some("sourceMissing")), "{res}");
    let node = of_kind(&w.c).await.into_iter().find(|n| n["key"] == id.as_str()).unwrap();
    assert_eq!((node["state"].as_str(), node["stateReason"].as_str()), (Some("broken"), Some("sourceMissing")));
    // Not found by search (with and without text), still openable with its tags and favourite.
    assert_eq!(w.c.ok("search.query", json!({ "text": "Mine" })).await, json!([]));
    let page = w.c.ok("page.resolve", json!({ "target": format!("resource:{id}") })).await;
    assert_eq!((page["state"].as_str(), page["stateReason"].as_str()), (Some("broken"), Some("sourceMissing")), "{page}");
    // It comes back when the file does.
    let u = up(json!([{ "key": a_key }]), json!({ "othersMissing": true })).await;
    assert_eq!((u["ok"]["restored"].as_u64(), u["ok"]["missing"].as_u64()), (Some(1), Some(0)), "{u}");
    assert_eq!(w.c.ok("resource.get", json!({ "id": id })).await["state"], "ok");
    assert_eq!(w.c.ok("search.query", json!({ "text": "Mine" })).await.as_array().unwrap().len(), 1);
    // A deleted one is restored, not made anew (§3.4).
    w.c.ok("resource.delete", json!({ "id": id })).await;
    let u = up(json!([{ "key": a_key }]), json!({})).await;
    assert_eq!((u["ok"]["restored"].as_u64(), u["ok"]["created"].as_u64(), u["ok"]["ids"][&a_key].as_str()), (Some(1), Some(0), Some(id.as_str())), "{u}");
    // Refusals.
    let e = up(json!([{ "key": "x" }, { "key": "x" }]), json!({})).await;
    assert_eq!((e["error"].as_str(), e["params"]["reason"].as_str()), (Some("invalid"), Some("duplicateKey")), "{e}");
    let e = up(json!([{ "key": "" }]), json!({})).await;
    assert_eq!(e["params"]["reason"], "badKey", "{e}");
    let e = up(json!([{ "key": "y", "tags": ["t"] }]), json!({})).await;
    assert_eq!(e["error"], "invalidParams", "{e}");
    let many: Vec<Value> = (0..5001).map(|i| json!({ "key": format!("k{i}") })).collect();
    let e = up(json!(many), json!({})).await;
    assert_eq!(e["params"]["reason"], "tooMany", "{e}");
    let e = w.c.probe("t.cat", "resources.upsertByKey", json!(["core:group", [], {}])).await;
    assert_eq!(e["params"]["reason"], "foreignKind", "{e}");
    // All or nothing: a bad parent refuses the whole batch.
    let e = up(json!([{ "key": "new1" }, { "key": "new2", "parent": "nope" }]), json!({})).await;
    assert!(e["error"].is_string(), "{e}");
    assert_eq!(of_kind(&w.c).await.len(), 1, "nothing of the refused batch was written");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn missing_resources_keep_their_runs() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    let mut m = cat_manifest();
    m["contributes"]["actions"] = json!([{ "id": "go", "label": "g", "output": "text", "kinds": ["q"] }]);
    pkg(&root, "t.cat", m, &CAT.replace("host.commands.handle(\"probe\", probe);", "host.commands.handle(\"probe\", probe); host.actions.handle(\"go\", async () => ({ output: { type: \"text\", text: \"ran\" } }));"));
    let env = open_exact(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let u = c.probe("t.cat", "resources.upsertByKey", json!(["q", [{ "key": "/x/a.txt" }], {}])).await;
    let id = u["ok"]["ids"]["/x/a.txt"].as_str().unwrap().to_string();
    let run = c.ok("run.start", json!({ "action": "t.cat:go", "resourceId": id, "target": format!("resource:{id}"), "tabId": "t", "input": {} })).await;
    for _ in 0..200 {
        if c.ok("run.get", json!({ "id": run })).await["status"] != "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    c.probe("t.cat", "resources.upsertByKey", json!(["q", [], { "othersMissing": true }])).await;
    let runs = c.ok("run.listFor", json!({ "id": id })).await;
    assert_eq!(runs.as_array().unwrap().len(), 1, "{runs}");
    // `resources.search` (D389) is for plugins with `requires.resources`; the kernel's own filter
    // is checked through `search.query` above.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn files_in_the_plugins_own_folder_need_no_grant() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    // No `requires.files`.
    pkg(&root, "t.own", json!({ "contributes": { "commands": [{ "id": "probe", "label": "p" }] } }),
        r#"export default { activate(host) { host.commands.handle("probe", probe); } };"#);
    let env = open_exact(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let p = |m: &'static str, a: Value| c.probe("t.own", m, a);
    let w = p("files.writeText", json!(["notes.txt", "hello"])).await;
    assert!(w["ok"]["basis"].is_string(), "{w}");
    let r = p("files.readText", json!(["notes.txt"])).await;
    assert_eq!(r["ok"]["text"], "hello", "{r}");
    let l = p("files.list", json!(["", {}])).await;
    let names: Vec<&str> = l["ok"]["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"notes.txt"), "{l}");
    let entry = l["ok"]["entries"].as_array().unwrap().iter().find(|e| e["name"] == "notes.txt").unwrap().clone();
    assert!(entry["modifiedAt"].as_i64().unwrap() > 0);
    // The absolute path it was given back works too.
    let s = p("files.stat", json!([entry["path"]])).await;
    assert_eq!(s["ok"]["size"], 5, "{s}");
    // Never out of it, never its programs; other absolute paths still need `files`.
    let e = p("files.readText", json!(["../../x"])).await;
    assert_eq!((e["error"].as_str(), e["params"]["reason"].as_str()), (Some("denied"), Some("outsideGrant")), "{e}");
    let e = p("files.writeText", json!(["bin/tool", "#!"])).await;
    assert_eq!(e["params"]["reason"], "ownPrograms", "{e}");
    let e = p("files.list", json!(["/tmp", {}])).await;
    assert_eq!(e["params"]["reason"], "notRequested", "{e}");
    assert_eq!(std::fs::read_to_string(own(&env, "t.own").join("notes.txt")).unwrap(), "hello");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn activation_values_are_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    for (id, act) in [("t.bad", json!(["resource.changed"])), ("t.twice", json!(["workspace.opened", "workspace.opened"])), ("t.type", json!("workspace.opened"))] {
        pkg(&root, id, json!({ "activation": act }), "export default { activate() {} };");
    }
    // Declared but disabled: never called.
    pkg(&root, "t.off", json!({ "activation": ["workspace.opened"], "contributes": { "commands": [{ "id": "probe", "label": "p" }] } }),
        r#"export default { activate(host) {
             host.commands.handle("probe", probe);
             host.events.on("workspace.opened", async (ctx) => { await ctx.host.files.writeText("ran", "1"); });
           } };"#);
    let env = open_exact(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    for (id, why) in [("t.bad", "badActivation"), ("t.twice", "badActivation"), ("t.type", "schema")] {
        let d = c.ok("plugin.get", json!({ "plugin": id })).await;
        assert_eq!(d["load"]["message"].as_str().map(|m| m.contains(why)), Some(true), "{id}: {d}");
    }
    // Enabled by default: it ran once; disabled and opened again: not.
    let f = own(&env, "t.off").join("ran");
    for _ in 0..250 {
        if f.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(f.exists(), "enabled plugin got workspace.opened");
    std::fs::remove_file(&f).unwrap();
    c.ok("plugin.setEnabled", json!({ "plugin": "t.off", "enabled": false })).await;
    env.kernel.shutdown();
    let tmp = env.tmp;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let env = open_exact(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!f.exists(), "a disabled plugin is not activated");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_toolbar_command_refreshes_its_provided_tree() {
    let w = world(&[]).await;
    let trees = w.c.ok("tree.list", json!({})).await;
    let t = trees.as_array().unwrap().iter().find(|t| t["id"] == "t.cat:t").unwrap().clone();
    assert_eq!(t["toolbar"][0]["id"], "t.cat:mode", "{t}");
    let before = w.c.ok("tree.children", json!({ "tree": "t.cat:t" })).await;
    assert_eq!(before["nodes"][0]["key"], "mode1");
    w.c.ok("command.execute", json!({ "id": "t.cat:mode", "context": { "tree": "t.cat:t" } })).await;
    w.c.event(|e| e.topic == "tree:t.cat:t").await;
    let after = w.c.ok("tree.children", json!({ "tree": "t.cat:t" })).await;
    assert_eq!(after["nodes"][0]["key"], "mode2");
}

/// A plugin with a page whose `new:` tab runs `go` with a parameter.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reuse_of_a_new_tab_run_reopens_a_new_tab_with_its_values() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    pkg(&root, "t.q", json!({
        "contributes": {
            "kinds": [{ "id": "q", "label": "Q", "icon": "file", "tree": "resources", "newName": "q", "page": "p" }],
            "pages": [{ "id": "p", "actions": [] }],
            "actions": [{ "id": "go", "label": "g", "output": "text" }]
        }
    }), r#"export default { activate(host) {
      host.pages.handle("p", { async render() { return { view: [] }; } });
      host.actions.handle("go", async (ctx) => ({ output: { type: "text", text: JSON.stringify(ctx.params) } }));
    } };"#);
    let env = open_exact(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let run = c
        .ok("run.start", json!({ "action": "t.q:go", "target": "new:t.q:q", "tabId": "t", "input": {}, "params": { "day": "2026-11-21" } }))
        .await;
    for _ in 0..200 {
        if c.ok("run.get", json!({ "id": run })).await["status"] != "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let node = c.ok("tree.children", json!({ "tree": "runs", "parent": "@runs:recent" })).await["nodes"][0].clone();
    assert!(node["menu"].as_array().unwrap().iter().any(|m| m["id"] == "run.reuse"), "{node}");
    let fx = c.ok("command.execute", json!({ "id": "run.reuse", "context": { "args": { "run": run } } })).await;
    assert_eq!(fx[0], json!({ "type": "open", "target": "new:t.q:q", "params": { "day": "2026-11-21" } }), "{fx}");
    // A run of a saved resource: back to it with the values (unchanged behaviour).
    let saved = c.ok("page.save", json!({ "target": "new:t.q:q", "changes": { "name": "s" } })).await;
    let rid = saved["page"]["resourceId"].as_str().unwrap().to_string();
    let run = c
        .ok("run.start", json!({ "action": "t.q:go", "resourceId": rid, "target": format!("resource:{rid}"), "tabId": "t", "input": {}, "params": { "day": "d" } }))
        .await;
    for _ in 0..200 {
        if c.ok("run.get", json!({ "id": run })).await["status"] != "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    c.ok("run.setKept", json!({ "id": run, "kept": true })).await;
    let fx = c.ok("command.execute", json!({ "id": "run.reuse", "context": { "args": { "run": run } } })).await;
    assert_eq!(fx[0], json!({ "type": "open", "target": format!("resource:{rid}"), "params": { "day": "d" } }), "{fx}");
}

const SRC: &str = r#"
export default { activate(host) {
  host.actions.handle("exec", async (ctx, input) => {
    const pw = await ctx.host.secrets.get("pw");
    if (input.coded) { const e = new Error("no such table for " + pw); e.code = "invalid"; throw e; }
    throw new Error("connection refused, password " + pw + " rejected\nsecond line");
  });
} };
"#;

const USE: &str = r#"
export default { activate(host) {
  host.actions.handle("via", async (ctx, input) => {
    try { await ctx.host.actions.call("t.src:exec", input, {}); }
    catch (e) {
      if (input.rethrow) throw e;
      return { output: { type: "text", text: JSON.stringify({ code: e.code, params: e.params, message: e.message, detail: e.detail }) } };
    }
  });
} };
"#;

async fn run_to_end(c: &Client, action: &str, input: Value) -> Value {
    let id = c.ok("run.start", json!({ "action": action, "target": "core:none", "tabId": "t", "input": input })).await;
    for _ in 0..500 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run did not end");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_called_plugins_error_text_reaches_the_caller_scrubbed() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    pkg(&root, "t.src", json!({
        "requires": { "secrets": { "names": ["pw"], "plaintext": true } },
        "contributes": { "actions": [{ "id": "exec", "label": "e", "output": "text" }] },
        "exports": { "actions": ["exec"] }
    }), SRC);
    pkg(&root, "t.use", json!({
        "depends": [{ "id": "t.src", "version": ">=0.1.0" }],
        "contributes": { "actions": [{ "id": "via", "label": "v", "output": "text" }] }
    }), USE);
    let env = open_exact(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    c.ok("secrets.set", json!({ "name": "pw", "value": "hunter2" })).await;
    let r = run_to_end(&c, "t.use:via", json!({})).await;
    assert_eq!(r["status"], "success", "{r}");
    let e: Value = serde_json::from_str(r["output"]["text"].as_str().unwrap()).unwrap();
    assert_eq!((e["code"].as_str(), e["params"]["reason"].as_str()), (Some("pluginError"), Some("calleeFailed")), "{e}");
    assert_eq!(e["message"], "connection refused, password *** rejected", "{e}");
    assert_eq!(e["detail"], e["message"]);
    // A host-coded error keeps its code and gets its message as the detail.
    let r = run_to_end(&c, "t.use:via", json!({ "coded": true })).await;
    let e: Value = serde_json::from_str(r["output"]["text"].as_str().unwrap()).unwrap();
    assert_eq!((e["code"].as_str(), e["detail"].as_str()), (Some("invalid"), Some("no such table for ***")), "{e}");
    // Not caught by the caller: the run's error says it.
    let r = run_to_end(&c, "t.use:via", json!({ "rethrow": true })).await;
    assert_eq!(r["status"], "error", "{r}");
    assert_eq!((r["error"]["code"].as_str(), r["error"]["message"].as_str()), (Some("pluginError"), Some("connection refused, password *** rejected")), "{r}");
    assert!(!r.to_string().contains("hunter2"), "{r}");
}
