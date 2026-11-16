//! Round 7 (docs/handoff/round7-plan.md §8): dependencies between plugins, the two export points
//! (actions on another plugin's kind, reading its resources), and install requests.
//! Every plugin here is generated into a temporary folder.

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
const tryIt = async (f) => { try { return { ok: await f() }; } catch (e) { return { error: e.code || String(e), reason: (e.params || {}).reason }; } };
const text = (v) => ({ output: { type: "text", text: JSON.stringify(v) } });
"#;

const NOTE_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.pages.handle("ed", { async render() { return { view: [] }; } });
  host.actions.handle("tidy", async () => text("own"));
  host.actions.handle("remember", async (ctx) => { await ctx.host.storage.set("k", 7); return text("ok"); });
} };
"#;

const TOOLS_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("count", async (ctx) => {
    const r = ctx.resource;
    const words = String(r.body.text || "").split(/\s+/).filter(Boolean).length;
    const got = await tryIt(() => ctx.host.resources.get(r.id));
    const upd = await tryIt(() => ctx.host.resources.update(r.id, { name: "changed" }));
    const del = await tryIt(() => ctx.host.resources.remove(r.id));
    const list = await tryIt(() => ctx.host.resources.list({ kind: "t.note:note" }));
    const other = await tryIt(() => ctx.host.resources.list({ kind: "t.note:other" }));
    const created = await tryIt(() => ctx.host.resources.create({ kind: "t.note:note", name: "x" }));
    const stored = await ctx.host.storage.get("k");
    const secret = await tryIt(() => ctx.host.secrets.get("note-token"));
    return text({ words, keys: Object.keys(r.body).sort(), got: got.ok ? Object.keys(got.ok.body).sort() : got, upd, del,
                  listed: list.ok ? list.ok.length : list, other, created, stored, secret });
  });
} };
"#;

const MARKET_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("ask", async (ctx, input) => {
    let out;
    try { out = await ctx.host.plugins.requestInstall({ folder: input.folder }); } catch (e) { out = { error: e.code, reason: (e.params || {}).reason }; }
    return text(out);
  });
  host.pages.handle("p", {
    async render(ctx) {
      let r = "allowed";
      try { await ctx.host.plugins.requestInstall({ folder: "/" }); } catch (e) { r = (e.params || {}).reason; }
      return { view: [{ type: "text", id: "t", text: r }] };
    },
    async onEvent(ctx, e) {
      let r = "none";
      try { r = JSON.stringify(await ctx.host.plugins.requestInstall({ folder: e })); } catch (x) { r = (x.params || {}).reason; }
      return { message: r };
    },
  });
} };
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

fn note_manifest(exports: bool) -> Value {
    let mut m = json!({
        "requires": { "files": true },
        "contributes": {
            "kinds": [
                { "id": "note", "label": "Note", "icon": "file", "tree": "resources", "page": "ed",
                  "fields": { "token": { "type": "secret" } } },
                { "id": "other", "label": "Other", "icon": "file", "tree": "resources" }
            ],
            "pages": [{ "id": "ed", "actions": [{ "id": "tidy", "role": "run", "label": "Tidy", "action": "tidy" }] }],
            "actions": [
                { "id": "tidy", "label": "Tidy", "output": "text", "kinds": ["note"] },
                { "id": "remember", "label": "Remember", "output": "text" }
            ],
            "commands": [{ "id": "probe", "label": "probe" }]
        }
    });
    if exports {
        m["exports"] = json!({ "kinds": [{ "id": "note", "actions": true, "read": true }] });
    }
    m
}

fn tools_manifest(range: &str) -> Value {
    json!({
        "depends": [{ "id": "t.note", "version": range }],
        "contributes": {
            "actions": [{ "id": "count", "label": "Count words", "output": "text", "kinds": ["t.note:note"] }],
            "commands": [{ "id": "probe", "label": "probe" }]
        }
    })
}

fn market_manifest() -> Value {
    json!({
        "requires": { "files": true, "plugins": { "install": true } },
        "contributes": {
            "kinds": [{ "id": "x", "label": "X", "icon": "box", "tree": "resources", "page": "p" }],
            "pages": [{ "id": "p" }],
            "actions": [{ "id": "ask", "label": "Ask", "output": "text" }],
            "commands": [{ "id": "probe", "label": "probe" }]
        }
    })
}

struct W {
    env: Env,
    c: Client,
    root: PathBuf,
}

async fn world(build: impl FnOnce(&Path)) -> W {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    build(&root);
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    W { env, c, root }
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

async fn enabled(c: &Client, id: &str) -> bool {
    detail(c, id).await["load"]["state"] == "loaded"
}

async fn set_enabled(c: &Client, id: &str, on: bool) -> Result<Value, ProtocolError> {
    let cmd = if on { "plugin.enable" } else { "plugin.disable" };
    c.call("command.execute", json!({ "id": cmd, "context": { "args": { "plugin": id } } })).await
}

async fn wait_run(c: &Client, id: &Value) -> Value {
    for _ in 0..500 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {id} did not end");
}

fn out(run: &Value) -> Value {
    serde_json::from_str(run["output"]["text"].as_str().unwrap_or_else(|| panic!("no text output: {run}"))).unwrap()
}

async fn new_note(c: &Client, text: &str) -> String {
    // The user saves it (a plugin may not write secret fields).
    let saved = c.ok("page.save", json!({ "target": "new:t.note:note", "changes": { "body.text": text, "body.token": "Note-Secret-1" } })).await;
    let id = saved["page"]["resourceId"].as_str().unwrap_or_else(|| panic!("{saved}")).to_string();
    c.ok("tree.rename", json!({ "tree": "resources", "key": id, "name": "n" })).await;
    id
}

fn audit(env: &Env, op: &str) -> Vec<(String, String, String, String)> {
    let conn = db(env);
    let mut st = conn.prepare("SELECT actor, object, summary, result FROM audit WHERE op = ?1 ORDER BY seq").unwrap();
    st.query_map([op], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(|r| r.unwrap()).collect()
}

/* ------------------------------------------------------------------ dependencies */

#[tokio::test]
async fn a_met_dependency_lists_both_ways() {
    let w = world(|r| {
        pkg(r, "t.note", "0.1.0", note_manifest(true), NOTE_MAIN);
        pkg(r, "t.tools", "0.1.0", tools_manifest(">=0.1.0, <0.2.0"), TOOLS_MAIN);
    })
    .await;
    let d = detail(&w.c, "t.tools").await;
    assert_eq!(d["load"]["state"], "loaded", "{d}");
    assert_eq!(d["depends"], json!([{ "id": "t.note", "range": ">=0.1.0, <0.2.0", "satisfied": true, "activeVersion": "0.1.0" }]));
    assert_eq!(detail(&w.c, "t.note").await["dependents"], json!(["t.tools"]));
    // `depends` is no permission: nothing to confirm for it, `resources` lists the readable kind.
    let perms = d["permissions"].as_array().unwrap();
    assert_eq!(perms.len(), 1, "{perms:?}");
    assert_eq!(perms[0]["id"], "resources");
    assert_eq!(perms[0]["detail"], "t.note:note");
}

#[tokio::test]
async fn each_unmet_reason_turns_the_dependent_off() {
    // Not installed.
    let w = world(|r| {
        pkg(r, "t.tools", "0.1.0", tools_manifest(">=0.1.0"), TOOLS_MAIN);
    })
    .await;
    let d = detail(&w.c, "t.tools").await;
    assert_eq!((d["load"]["state"].clone(), d["load"]["message"].clone()), (json!("disabled"), json!("dependsUnmet")));
    assert_eq!(d["enabled"], true, "the user's switch stays on");
    assert_eq!(d["depends"][0]["satisfied"], false);
    assert!(d["depends"][0].get("activeVersion").is_none());
    let tree = w.c.ok("tree.children", json!({ "tree": "plugins" })).await;
    let node = tree["nodes"].as_array().unwrap().iter().find(|n| n["key"] == "t.tools").unwrap().clone();
    assert_eq!((node["state"].clone(), node["stateReason"].clone()), (json!("disabled"), json!("dependsUnmet")), "{node}");
    // Its code does not run.
    assert_eq!(w.c.call("command.execute", json!({ "id": "t.tools:probe", "context": {} })).await.unwrap_err().code, ErrorCode::Denied);

    // Version out of range.
    let w = world(|r| {
        pkg(r, "t.note", "0.2.0", note_manifest(true), NOTE_MAIN);
        pkg(r, "t.tools", "0.1.0", tools_manifest("<0.2.0"), TOOLS_MAIN);
    })
    .await;
    let d = detail(&w.c, "t.tools").await;
    assert_eq!(d["load"]["message"], "dependsUnmet");
    assert_eq!(d["depends"][0]["activeVersion"], "0.2.0");
    assert_eq!(d["depends"][0]["satisfied"], false);

    // Not confirmed: the only version of the dependency asks for a permission nobody confirmed.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    pkg(&root, "t.note", "0.1.0", note_manifest(true), NOTE_MAIN);
    pkg(&root, "t.tools", "0.1.0", tools_manifest(">=0.1.0"), TOOLS_MAIN);
    let env = open_exact(tmp, &root, onedesk_kernel::KernelConfig { builtin: vec!["t.tools@0.1.0".into()], ..test_config() });
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    assert_eq!(detail(&c, "t.note").await["unconfirmed"], json!(["0.1.0"]));
    assert_eq!(detail(&c, "t.tools").await["load"]["message"], "dependsUnmet");
    // Confirming it brings the dependent back by itself.
    let fp = detail(&c, "t.note").await["versions"][0]["fingerprint"].clone();
    c.ok("plugin.confirmPermissions", json!({ "plugin": "t.note", "version": "0.1.0", "fingerprint": fp })).await;
    assert!(enabled(&c, "t.tools").await);

    // A cycle: both unmet.
    let w = world(|r| {
        pkg(r, "t.c1", "0.1.0", json!({ "depends": [{ "id": "t.c2", "version": "*" }] }), "export default { activate() {} };");
        pkg(r, "t.c2", "0.1.0", json!({ "depends": [{ "id": "t.c1", "version": "*" }] }), "export default { activate() {} };");
    })
    .await;
    for id in ["t.c1", "t.c2"] {
        assert_eq!(detail(&w.c, id).await["load"]["message"], "dependsUnmet", "{id}");
    }
}

#[tokio::test]
async fn a_disabled_dependency_turns_off_and_coming_back_restores() {
    let w = world(|r| {
        pkg(r, "t.note", "0.1.0", note_manifest(true), NOTE_MAIN);
        pkg(r, "t.tools", "0.1.0", tools_manifest(">=0.1.0"), TOOLS_MAIN);
    })
    .await;
    // The dependent first (the dependency cannot go while it is on), then the dependency.
    set_enabled(&w.c, "t.tools", false).await.unwrap();
    set_enabled(&w.c, "t.note", false).await.unwrap();
    set_enabled(&w.c, "t.tools", true).await.unwrap();
    let d = detail(&w.c, "t.tools").await;
    assert_eq!((d["enabled"].clone(), d["load"]["message"].clone()), (json!(true), json!("dependsUnmet")));
    assert_eq!(detail(&w.c, "t.note").await["dependents"], json!([]), "only enabled dependents are listed");
    // Met again: back without anything else.
    set_enabled(&w.c, "t.note", true).await.unwrap();
    assert!(enabled(&w.c, "t.tools").await);
    assert!(detail(&w.c, "t.tools").await["load"].get("message").is_none());
}

#[tokio::test]
async fn switching_disabling_and_removing_a_dependency_are_refused_while_dependents_are_on() {
    let w = world(|r| {
        pkg(r, "t.note", "0.1.0", note_manifest(true), NOTE_MAIN);
        pkg(r, "t.tools", "0.1.0", tools_manifest(">=0.1.0, <0.2.0"), TOOLS_MAIN);
        pkg(r, "t.more", "0.1.0", tools_manifest("<0.2.0"), TOOLS_MAIN);
    })
    .await;
    let dependents = |e: &ProtocolError| {
        assert_eq!(reason(e), (ErrorCode::Conflict, Some("dependents")), "{e:?}");
        e.params["plugins"].clone()
    };
    // A newer version arrives: the automatic switch does not happen and is recorded.
    pkg(&w.root, "t.note", "0.2.0", note_manifest(true), NOTE_MAIN);
    w.c.ok("plugin.rescan", json!({ "builtin": ["t.note@0.2.0"] })).await;
    let d = detail(&w.c, "t.note").await;
    assert_eq!(d["switchFailure"]["reason"], "dependents", "{d}");
    assert_eq!(d["versions"].as_array().unwrap().iter().find(|v| v["active"] == true).unwrap()["version"], "0.1.0");
    // By hand: refused, listing the dependents.
    let e = w.c.call("plugin.activateVersion", json!({ "plugin": "t.note", "version": "0.2.0" })).await.unwrap_err();
    assert_eq!(dependents(&e), "t.more,t.tools");
    let e = set_enabled(&w.c, "t.note", false).await.unwrap_err();
    assert_eq!(dependents(&e), "t.more,t.tools");
    let e = w.c.call("plugin.checkRemove", json!({ "plugin": "t.note", "version": "0.1.0" })).await.unwrap_err();
    assert_eq!(dependents(&e), "t.more,t.tools");
    // Removing a version that is not the active one is fine.
    w.c.ok("plugin.checkRemove", json!({ "plugin": "t.note", "version": "0.2.0" })).await;
    // Refusals are audited.
    let refused = audit(&w.env, "plugin.upgrade");
    let is_refusal = |s: &str, r: &str| s.contains("dependents") && r == "failed:conflict";
    assert!(refused.iter().any(|(_, o, s, r)| o == "t.note" && is_refusal(s, r)), "{refused:?}");
    assert!(audit(&w.env, "plugin.state").iter().any(|(_, o, s, r)| o == "t.note" && is_refusal(s, r)));
    assert!(audit(&w.env, "plugin.remove").iter().any(|(_, o, s, r)| o == "t.note@0.1.0" && is_refusal(s, r)));
    // The dependents step aside: everything is allowed.
    set_enabled(&w.c, "t.tools", false).await.unwrap();
    let e = w.c.call("plugin.activateVersion", json!({ "plugin": "t.note", "version": "0.2.0" })).await.unwrap_err();
    assert_eq!(dependents(&e), "t.more");
    set_enabled(&w.c, "t.more", false).await.unwrap();
    w.c.ok("plugin.checkRemove", json!({ "plugin": "t.note", "version": "0.1.0" })).await;
    w.c.ok("plugin.activateVersion", json!({ "plugin": "t.note", "version": "0.2.0" })).await;
    set_enabled(&w.c, "t.note", false).await.unwrap();
}

/* ------------------------------------------------------------------ exports */

#[tokio::test]
async fn a_dependent_adds_a_read_only_action_to_an_exported_kind() {
    let w = world(|r| {
        pkg(r, "t.note", "0.1.0", note_manifest(true), NOTE_MAIN);
        pkg(r, "t.tools", "0.1.0", tools_manifest(">=0.1.0"), TOOLS_MAIN);
    })
    .await;
    let id = new_note(&w.c, "one two three").await;
    w.c.probe("t.note", "resources.create", json!([{ "kind": "other", "name": "o" }])).await;
    let page = w.c.ok("page.resolve", json!({ "target": format!("resource:{id}") })).await;
    let ids: Vec<&str> = page["actions"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["tidy", "t.tools:count"], "its own first");
    let added = &page["actions"][1];
    assert_eq!((added["role"].clone(), added["action"].clone()), (json!("run"), json!("t.tools:count")));
    // What the note plugin stored stays its own.
    let run = wait_run(&w.c, &w.c.ok("run.start", json!({ "action": "t.note:remember", "target": "core:none", "tabId": "t" })).await).await;
    assert_eq!(run["status"], "success");

    let rid = w.c.ok("run.start", json!({ "action": "t.tools:count", "resourceId": id, "target": format!("resource:{id}"), "tabId": "t" })).await;
    let run = wait_run(&w.c, &rid).await;
    assert_eq!(run["status"], "success", "{run}");
    assert_eq!(run["action"], "t.tools:count");
    // The dependent is the actor of the run's own part.
    let ends = audit(&w.env, "run.end");
    assert!(ends.iter().any(|(a, o, _, _)| a.starts_with("plugin:t.tools") && o == rid.as_str().unwrap()), "{ends:?}");
    let o = out(&run);
    assert_eq!(o["words"], 3);
    assert_eq!(o["keys"], json!(["text"]), "no secret fields: {o}");
    assert_eq!(o["got"], json!(["text"]));
    for write in ["upd", "del", "created"] {
        assert_eq!((o[write]["error"].clone(), o[write]["reason"].clone()), (json!("denied"), json!("foreignKind")), "{write}: {o}");
    }
    assert_eq!(o["listed"], 1);
    assert_eq!((o["other"]["error"].clone(), o["other"]["reason"].clone()), (json!("denied"), json!("foreignKind")), "not exported");
    assert_eq!(o["stored"], Value::Null, "another plugin's storage");
    assert_eq!(o["secret"]["reason"], "plaintextUndeclared");
    // The resource is untouched; the run is in the history like any other.
    assert_eq!(w.c.ok("resource.get", json!({ "id": id })).await["name"], "n");
    let audit_runs = audit(&w.env, "run.start");
    assert!(audit_runs.iter().any(|(a, o, _, _)| a == "user" && o == rid.as_str().unwrap()), "{audit_runs:?}");

    // Outside a run, the dependent reads the same way and no further.
    assert_eq!(w.c.probe("t.tools", "resources.get", json!([id])).await["ok"]["id"], id.as_str());
    let other = w.c.probe("t.tools", "resources.list", json!([{ "kind": "t.note:other" }])).await;
    assert_eq!(other["params"]["reason"], "foreignKind");
    let other_plugin = w.c.probe("t.tools", "resources.list", json!([{ "kind": "t.nope:note" }])).await;
    assert_eq!(other_plugin["params"]["reason"], "foreignKind");

    // Turned off: the action is gone from the page.
    set_enabled(&w.c, "t.tools", false).await.unwrap();
    let page = w.c.ok("page.resolve", json!({ "target": format!("resource:{id}") })).await;
    assert_eq!(page["actions"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn nothing_crosses_without_an_export() {
    let w = world(|r| {
        pkg(r, "t.note", "0.1.0", note_manifest(false), NOTE_MAIN);
        pkg(r, "t.tools", "0.1.0", tools_manifest(">=0.1.0"), TOOLS_MAIN);
    })
    .await;
    let id = new_note(&w.c, "a b").await;
    let page = w.c.ok("page.resolve", json!({ "target": format!("resource:{id}") })).await;
    assert_eq!(page["actions"].as_array().unwrap().len(), 1, "no added action: {page}");
    let d = detail(&w.c, "t.tools").await;
    assert_eq!((d["load"]["state"].clone(), d["load"]["message"].clone()), (json!("loaded"), json!("notExported")));
    let run = wait_run(&w.c, &w.c.ok("run.start", json!({ "action": "t.tools:count", "resourceId": id, "target": format!("resource:{id}"), "tabId": "t" })).await).await;
    assert_eq!(run["status"], "error");
    assert_eq!(run["error"]["code"], "invalidInput", "{run}");
    assert_eq!(w.c.probe("t.tools", "resources.get", json!([id])).await["params"]["reason"], "foreignKind");
}

/* ------------------------------------------------------------------ install requests */

fn market_world(r: &Path) {
    pkg(r, "t.market", "0.1.0", market_manifest(), MARKET_MAIN);
    pkg(r, "t.plain", "0.1.0", json!({ "contributes": { "commands": [{ "id": "probe", "label": "probe" }] } }), "export default { activate(host) { host.commands.handle(\"probe\", probe); } };");
}

async fn ask(c: &Client, folder: &str) -> Value {
    c.ok("run.start", json!({ "action": "t.market:ask", "target": "core:none", "tabId": "t", "input": { "folder": folder } })).await
}

async fn next_request(c: &Client) -> Value {
    for _ in 0..500 {
        let l = c.ok("plugin.installRequests", json!({})).await;
        if let Some(r) = l.as_array().unwrap().first() {
            return r.clone();
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no install request");
}

#[tokio::test]
async fn install_requests_are_recorded_answered_and_audited() {
    let w = world(market_world).await;
    let pkg_dir = std::fs::canonicalize(w.root.join("t.market/0.1.0")).unwrap();
    let folder = pkg_dir.display().to_string();
    // Installed.
    let run = ask(&w.c, &folder).await;
    w.c.event(|e| e.topic == "install-requests").await;
    let req = next_request(&w.c).await;
    assert_eq!((req["plugin"].clone(), req["folder"].clone()), (json!("t.market"), json!(folder)));
    assert_eq!(req["pluginName"], "t.market name");
    // Only one at a time.
    let second = wait_run(&w.c, &ask(&w.c, &folder).await).await;
    assert_eq!(out(&second), json!({ "error": "conflict", "reason": "pendingRequest" }));
    w.c.ok("plugin.answerInstallRequest", json!({ "id": req["id"], "outcome": "installed", "plugin": "x.y", "version": "1.0.0" })).await;
    let r = wait_run(&w.c, &run).await;
    assert_eq!(out(&r), json!({ "outcome": "installed", "id": "x.y", "version": "1.0.0" }));
    assert_eq!(w.c.ok("plugin.installRequests", json!({})).await, json!([]));
    // Declined, failed.
    let run = ask(&w.c, &folder).await;
    let req = next_request(&w.c).await;
    w.c.ok("plugin.answerInstallRequest", json!({ "id": req["id"], "outcome": "declined" })).await;
    assert_eq!(out(&wait_run(&w.c, &run).await), json!({ "outcome": "declined" }));
    let run = ask(&w.c, &folder).await;
    let req = next_request(&w.c).await;
    w.c.ok("plugin.answerInstallRequest", json!({ "id": req["id"], "outcome": "failed", "reason": "notValid" })).await;
    assert_eq!(out(&wait_run(&w.c, &run).await), json!({ "outcome": "failed", "reason": "notValid" }));
    // An answer for nothing.
    let e = w.c.call("plugin.answerInstallRequest", json!({ "id": req["id"], "outcome": "declined" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    // Audit: the request by the plugin, the answer by the user.
    let reqs = audit(&w.env, "plugin.installRequest");
    assert_eq!(reqs.len(), 3);
    assert!(reqs[0].0.starts_with("plugin:t.market"), "{reqs:?}");
    assert_eq!(reqs[0].1, folder);
    let answers = audit(&w.env, "plugin.installAnswer");
    assert_eq!(answers.len(), 3);
    assert_eq!(answers[0].0, "user");
    let s: Value = serde_json::from_str(&answers[1].2).unwrap();
    assert_eq!((s["outcome"].clone(), s["requester"].clone()), (json!("declined"), json!("t.market")));
}

#[tokio::test]
async fn request_folders_stay_inside_what_the_plugin_can_read() {
    let w = world(market_world).await;
    let outside = tempfile::tempdir().unwrap();
    let outside_path = std::fs::canonicalize(outside.path()).unwrap();
    let r = wait_run(&w.c, &ask(&w.c, &outside_path.display().to_string()).await).await;
    assert_eq!(out(&r), json!({ "error": "denied", "reason": "outsideGrant" }));
    let r = wait_run(&w.c, &ask(&w.c, "relative/path").await).await;
    assert_eq!(out(&r)["error"], "invalid");
    // Its plugin-data folder.
    let data = w.env.kernel.db_path().parent().unwrap().join("plugin-data/t.market/pkg");
    std::fs::create_dir_all(&data).unwrap();
    let run = ask(&w.c, &data.display().to_string()).await;
    let req = next_request(&w.c).await;
    w.c.ok("plugin.answerInstallRequest", json!({ "id": req["id"], "outcome": "declined" })).await;
    assert_eq!(out(&wait_run(&w.c, &run).await)["outcome"], "declined");
    // A folder the user granted.
    w.c.ok("plugin.grantFolder", json!({ "plugin": "t.market", "path": outside_path })).await;
    std::fs::create_dir_all(outside_path.join("pkg")).unwrap();
    let run = ask(&w.c, &outside_path.join("pkg").display().to_string()).await;
    let req = next_request(&w.c).await;
    assert_eq!(req["folder"], outside_path.join("pkg").display().to_string());
    w.c.ok("plugin.answerInstallRequest", json!({ "id": req["id"], "outcome": "declined" })).await;
    wait_run(&w.c, &run).await;
}

#[tokio::test]
async fn requests_need_the_declaration_and_a_user_action() {
    let w = world(market_world).await;
    let folder = std::fs::canonicalize(w.root.join("t.market/0.1.0")).unwrap().display().to_string();
    // Not declared.
    let r = w.c.probe("t.plain", "plugins.requestInstall", json!([{ "folder": folder }])).await;
    assert_eq!((r["error"].clone(), r["params"]["reason"].clone()), (json!("denied"), json!("notRequested")));
    assert_eq!(w.c.probe("t.plain", "plugins.list", json!([])).await["params"]["reason"], "notRequested");
    // A command is not where the user acts on a page or a run.
    assert_eq!(w.c.probe("t.market", "plugins.requestInstall", json!([{ "folder": folder }])).await["params"]["reason"], "notInteractive");
    // Nor is a render.
    let x = w.c.probe("t.market", "resources.create", json!([{ "kind": "x", "name": "x" }])).await["ok"]["id"].clone();
    let page = w.c.ok("page.resolve", json!({ "target": format!("resource:{}", x.as_str().unwrap()) })).await;
    assert_eq!(page["view"][0]["text"], "notInteractive", "{page}");
    // A page event is.
    let target = format!("resource:{}", x.as_str().unwrap());
    let c2 = Client::in_proc(w.env.kernel.clone());
    let ev = tokio::spawn(async move {
        c2.hello().await;
        c2.ok("page.event", json!({ "target": target, "event": folder })).await
    });
    let req = next_request(&w.c).await;
    w.c.ok("plugin.answerInstallRequest", json!({ "id": req["id"], "outcome": "declined" })).await;
    let res = ev.await.unwrap();
    assert_eq!(res["message"], r#"{"outcome":"declined"}"#, "{res}");
    // The answer and the app methods have no way in from a plugin.
    let r = w.c.probe("t.market", "plugins.answerInstallRequest", json!([{ "id": "x", "outcome": "installed" }])).await;
    assert!(r["error"].as_str().unwrap().contains("TypeError") || r["error"] == "unknownMethod", "{r}");
    let r = w.c.probe("t.market", "app.installPlugin", json!([{}])).await;
    assert!(r["error"].as_str().unwrap().contains("TypeError"), "{r}");
    // `list`: the basics of every installed plugin.
    let l = w.c.probe("t.market", "plugins.list", json!([])).await["ok"].clone();
    let me = l.as_array().unwrap().iter().find(|p| p["id"] == "t.market").unwrap().clone();
    assert_eq!(me, json!({ "id": "t.market", "name": "t.market name", "versions": ["0.1.0"], "active": "0.1.0" }));
}

#[tokio::test]
async fn unanswered_requests_expire_and_die_with_their_plugin() {
    let w = world(market_world).await;
    let folder = std::fs::canonicalize(w.root.join("t.market/0.1.0")).unwrap().display().to_string();
    w.env.kernel.set_install_request_ttl(Duration::from_millis(300));
    let r = wait_run(&w.c, &ask(&w.c, &folder).await).await;
    assert_eq!(out(&r), json!({ "outcome": "expired" }));
    assert_eq!(w.c.ok("plugin.installRequests", json!({})).await, json!([]));
    // The requester is turned off: its request is void.
    w.env.kernel.set_install_request_ttl(Duration::from_secs(60));
    let run = ask(&w.c, &folder).await;
    next_request(&w.c).await;
    set_enabled(&w.c, "t.market", false).await.unwrap();
    assert_eq!(w.c.ok("plugin.installRequests", json!({})).await, json!([]));
    let r = wait_run(&w.c, &run).await;
    assert_ne!(r["status"], "success", "{r}");
}

#[tokio::test]
async fn waiting_for_the_user_does_not_count_against_the_time_budget() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    market_world(&root);
    let env = open_with(tmp, &root, onedesk_kernel::KernelConfig { action_timeout: Duration::from_millis(800), ..test_config() });
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let folder = std::fs::canonicalize(root.join("t.market/0.1.0")).unwrap().display().to_string();
    let run = ask(&c, &folder).await;
    let req = next_request(&c).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    c.ok("plugin.answerInstallRequest", json!({ "id": req["id"], "outcome": "declined" })).await;
    let r = wait_run(&c, &run).await;
    assert_eq!(r["status"], "success", "{r}");
    assert_eq!(out(&r), json!({ "outcome": "declined" }));
}
