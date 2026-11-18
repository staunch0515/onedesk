//! Round 15 (D413): `ctx.host.actions.call` — a plugin runs an action another plugin exports, as
//! that plugin. Every refusal has a case. Plugins are generated into a temporary folder.

mod common;

use std::path::Path;
use std::time::Duration;

use common::*;
use serde_json::{json, Value};

const PROBE: &str = r#"
async function probe(ctx, context) {
  const a = (context && context.args) || {};
  try { return [{ type: "copy", text: JSON.stringify({ ok: await ctx.host.actions.call(...a.args) }) }]; }
  catch (e) { return [{ type: "copy", text: JSON.stringify({ error: e.code || String(e), params: e.params || {} }) }]; }
}
const tryIt = async (f) => { try { return { ok: await f() }; } catch (e) { return { error: e.code || String(e), params: e.params || {} }; } };
const text = (v) => ({ output: { type: "text", text: JSON.stringify(v) } });
"#;

fn pkg(root: &Path, id: &str, extra: Value, main: &str) {
    pkg_v(root, id, "0.1.0", extra, main)
}

fn pkg_v(root: &Path, id: &str, version: &str, extra: Value, main: &str) {
    let dir = root.join(id).join(version);
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({ "id": id, "version": version, "apiVersion": "2", "name": id, "icon": "box", "main": "main.js" });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(dir.join("main.js"), format!("{PROBE}\n{main}")).unwrap();
}

const SRC: &str = r#"
export default { activate(host) {
  host.actions.handle("exec", async (ctx, input) => {
    if (input.fail) throw new Error("callee broke");
    if (input.sleep) { await ctx.host.util.sleep(input.sleep); return { slept: true }; }
    if (input.raw !== undefined) return { output: { type: "table", file: input.raw } };
    if (input.spare) {
      await ctx.host.process.run({ program: "sh", args: ["-c", "echo a > tmp/spare.csv"] });
      return { output: { type: "table", file: "tmp/spare.csv" } };
    }
    if (input.file) {
      await ctx.host.process.run({ program: "sh", args: ["-c", "printf 'a\\n1\\n2\\n' > tmp/r.csv"] });
      return { output: { type: "table", file: "tmp/r.csv" } };
    }
    const r = await tryIt(() => ctx.host.process.run({ program: "sh", args: ["-c", "printf %s \"$PW\""], env: { PW: "{{secret:pw}}" } }));
    return { echoed: input, caller: ctx.caller, resource: ctx.resource && ctx.resource.id, run: !!ctx.runId,
             out: r.ok ? r.ok.stdout : r };
  });
  host.actions.handle("hidden", async () => ({ ok: true }));
  host.actions.handle("onconn", async (ctx) => ({ resource: ctx.resource && ctx.resource.id }));
} };
"#;

const USE: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("via", async (ctx, input) => {
    if (input.before) await ctx.host.util.sleep(input.before);
    const r = await tryIt(() => ctx.host.actions.call(input.action, input.input || {}, input.opts));
    if (input.handOn && r.ok) return r.ok;
    return text(r);
  });
} };
"#;

/// `t.hN` calls `t.h(N+1)` while `n > 0`, and says how deep it got.
fn hop(next: Option<&str>) -> String {
    let call = match next {
        Some(n) => format!(r#"if (input.n > 0) {{ const r = await tryIt(() => ctx.host.actions.call("{n}:hop", {{ n: input.n - 1 }})); return done(r.ok ? r.ok : r); }}"#),
        None => String::new(),
    };
    format!(r#"{TEXT}
export default {{ activate(host) {{
  host.actions.handle("hop", async (ctx, input) => {{
    const done = (r) => ctx.caller ? r : text(r);
    {call}
    return done({{ reached: input.n }});
  }});
}} }};"#, TEXT = "")
}

async fn world() -> (Env, Client) {
    world_t(Duration::from_secs(20)).await
}

async fn world_t(timeout: Duration) -> (Env, Client) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    let action = |id: &str, out: &str| json!({ "id": id, "label": id, "output": out });
    pkg(&root, "t.src", json!({
        "requires": { "programs": [{ "name": "sh", "source": "system" }], "secrets": { "names": ["pw"] } },
        "contributes": { "kinds": [{ "id": "conn", "label": "C", "icon": "box", "tree": "resources", "newName": "c" }],
                         "actions": [action("exec", "text"), action("hidden", "text"),
                                     { "id": "onconn", "label": "o", "output": "text", "kinds": ["conn"] }] },
        "exports": { "actions": ["exec", "onconn"] }
    }), SRC);
    let user = |id: &str, deps: Value| {
        pkg(&root, id, json!({
            "depends": deps,
            "contributes": { "actions": [action("via", "text"), action("via-table", "table")], "commands": [{ "id": "probe", "label": "p" }] }
        }), &USE.replace(r#"host.actions.handle("via","#, r#"for (const n of ["via", "via-table"]) host.actions.handle(n,"#));
    };
    user("t.use", json!([{ "id": "t.src", "version": ">=0.1.0" }]));
    user("t.nodep", json!([]));
    // D417: a caller whose range only an older version of t.old satisfies.
    for v in ["0.1.0", "0.2.0"] {
        pkg_v(&root, "t.old", v, json!({
            "contributes": { "kinds": [{ "id": "doc", "label": "D", "icon": "box", "tree": "resources", "newName": "d" }],
                             "actions": [action("hop", "text")] },
            "exports": { "actions": ["hop"] }
        }), r#"export default { activate(host) { host.actions.handle("hop", async () => ({ ok: true })); } };"#);
    }
    user("t.range", json!([{ "id": "t.old", "version": ">=0.2.0" }]));
    // A chain t.h0 → t.h1 → … → t.h5.
    for i in 0..6 {
        let next = (i < 5).then(|| format!("t.h{}", i + 1));
        let mut extra = json!({ "contributes": { "actions": [action("hop", "text")] }, "exports": { "actions": ["hop"] } });
        if let Some(n) = &next {
            extra["depends"] = json!([{ "id": n, "version": ">=0.1.0" }]);
        }
        pkg(&root, &format!("t.h{i}"), extra, &hop(next.as_deref()));
    }
    let mut cfg = config_for(&root);
    cfg.action_timeout = timeout;
    let env = open_exact(tmp, &root, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

async fn run(c: &Client, action: &str, input: Value) -> Value {
    let id = c.ok("run.start", json!({ "action": action, "target": "core:none", "tabId": "t", "input": input })).await;
    for _ in 0..1500 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {id} did not end");
}

fn out(r: &Value) -> Value {
    serde_json::from_str(r["output"]["text"].as_str().unwrap_or_else(|| panic!("no text: {r}"))).unwrap()
}

async fn via(c: &Client, plugin: &str, input: Value) -> Value {
    let r = run(c, &format!("{plugin}:via"), input).await;
    assert_eq!(r["status"], "success", "{r}");
    out(&r)
}

fn audit(env: &Env, op: &str) -> Vec<(String, String, String)> {
    let conn = rusqlite::Connection::open(env.kernel.db_path()).unwrap();
    let mut st = conn.prepare("SELECT actor, object, summary FROM audit WHERE op = ?1 ORDER BY seq").unwrap();
    st.query_map([op], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(|r| r.unwrap()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_exported_action_runs_as_its_owner_with_its_secrets_and_resource() {
    let (env, c) = world().await;
    c.ok("secrets.set", json!({ "name": "pw", "value": "hunter2" })).await;
    let r = via(&c, "t.use", json!({ "action": "t.src:exec", "input": { "q": 1 } })).await;
    let ok = &r["ok"];
    assert_eq!(ok["echoed"], json!({ "q": 1 }), "{r}");
    assert_eq!((ok["caller"].as_str(), ok["run"].as_bool()), (Some("t.use"), Some(true)));
    // The callee's own secret was substituted for its program (the caller never declared it);
    // what the program printed is scrubbed, as for any substituted value.
    assert_eq!(ok["out"], "***", "{r}");
    let a = audit(&env, "actions.call");
    let last = a.last().unwrap();
    assert!(last.0.contains("t.src") && last.1 == "t.src:exec" && last.2.contains("t.use"), "{a:?}");
    // With one of the callee's own resources.
    let res = c.ok("page.save", json!({ "target": "new:t.src:conn", "changes": { "name": "c1" } })).await;
    let rid = res["page"]["resourceId"].as_str().unwrap().to_string();
    let r = via(&c, "t.use", json!({ "action": "t.src:exec", "opts": { "resource": rid } })).await;
    assert_eq!(r["ok"]["resource"], rid.as_str(), "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_data_file_answer_is_handed_to_the_caller() {
    let (_env, c) = world().await;
    let r = run(&c, "t.use:via-table", json!({ "action": "t.src:exec", "input": { "file": true }, "handOn": true })).await;
    assert_eq!(r["status"], "success", "{r}");
    assert_eq!((r["output"]["total"].as_u64(), r["output"]["rows"][1][0].as_str()), (Some(2), Some("2")), "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_refusal() {
    let (env, c) = world().await;
    let why = |v: &Value| (v["error"].as_str().unwrap_or("ok").to_string(), v["params"]["reason"].as_str().unwrap_or("").to_string());
    let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
    // Not exported; no dependency; own action; unknown plugin.
    for (who, action) in [("t.use", "t.src:hidden"), ("t.nodep", "t.src:exec"), ("t.use", "t.use:via"), ("t.use", "t.none:x")] {
        let r = via(&c, who, json!({ "action": action })).await;
        assert_eq!(why(&r), pair("denied", "notExported"), "{who} {action}: {r}");
        assert_eq!(r["params"]["action"], action);
    }
    // Outside a run.
    let r = c.probe("t.use", "actions.call", json!(["t.src:exec", {}])).await;
    assert_eq!(why(&r), pair("denied", "notInRun"), "{r}");
    // A resource that is not the callee's.
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "G" })).await;
    let r = via(&c, "t.use", json!({ "action": "t.src:exec", "opts": { "resource": g["key"] } })).await;
    assert_eq!(why(&r), pair("denied", "notOwnResource"), "{r}");
    // The callee fails: the caller gets a plugin error naming the action.
    let r = via(&c, "t.use", json!({ "action": "t.src:exec", "input": { "fail": true } })).await;
    assert_eq!(why(&r), pair("pluginError", "calleeFailed"), "{r}");
    // Depth: four nested calls work, a fifth is refused.
    let r = run(&c, "t.h0:hop", json!({ "n": 4 })).await;
    assert_eq!(out(&r), json!({ "reached": 0 }), "{r}");
    let r = run(&c, "t.h0:hop", json!({ "n": 5 })).await;
    assert_eq!(why(&out(&r)), pair("denied", "callDepth"), "{r}");
    // Refusals are audited under the caller (the generic refusal record of host calls).
    assert!(!audit(&env, "actions.call").is_empty());
}

fn own(env: &Env, plugin: &str) -> std::path::PathBuf {
    env.path().join("ws").join("plugin-data").join(plugin)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn d417_kinds_version_range_and_budget() {
    let (env, c) = world().await;
    let why = |v: &Value| (v["error"].as_str().unwrap_or("ok").to_string(), v["params"]["reason"].as_str().unwrap_or("").to_string());
    let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
    // An action bound to kinds: without a resource, or with one of another of its kinds → wrongKind.
    let r = via(&c, "t.use", json!({ "action": "t.src:onconn" })).await;
    assert_eq!(why(&r), pair("denied", "wrongKind"), "{r}");
    let res = c.ok("page.save", json!({ "target": "new:t.src:conn", "changes": { "name": "c1" } })).await;
    let rid = res["page"]["resourceId"].as_str().unwrap().to_string();
    let r = via(&c, "t.use", json!({ "action": "t.src:onconn", "opts": { "resource": rid } })).await;
    assert_eq!(r["ok"]["resource"], rid.as_str(), "{r}");
    // The version that would run must satisfy the caller's range: a resource bound to t.old 0.1.0.
    let r = via(&c, "t.range", json!({ "action": "t.old:hop" })).await;
    assert_eq!(r["ok"]["ok"], true, "active 0.2.0 satisfies >=0.2.0: {r}");
    let doc = c.ok("page.save", json!({ "target": "new:t.old:doc", "changes": { "name": "d" } })).await;
    let did = doc["page"]["resourceId"].as_str().unwrap().to_string();
    rusqlite::Connection::open(env.kernel.db_path()).unwrap()
        .execute("UPDATE resources SET plugin_version = '0.1.0' WHERE id = ?1", [&did]).unwrap();
    let r = via(&c, "t.range", json!({ "action": "t.old:hop", "opts": { "resource": did } })).await;
    assert_eq!(why(&r), pair("denied", "notExported"), "{r}");
    drop(env);
    // The caller's budget keeps running while it waits: 0.6 s before + 0.6 s in the callee > 1 s.
    let (_env, c) = world_t(Duration::from_millis(1000)).await;
    let r = run(&c, "t.use:via", json!({ "action": "t.src:exec", "before": 600, "input": { "sleep": 600 } })).await;
    assert_eq!((r["status"].as_str(), r["error"]["code"].as_str()), (Some("error"), Some("timeout")), "{r}");
    let r = run(&c, "t.use:via", json!({ "action": "t.src:exec", "input": { "sleep": 100 } })).await;
    assert_eq!(r["status"], "success", "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hand_over_takes_only_regular_files_and_unused_ones_are_removed() {
    let (env, c) = world().await;
    let why = |v: &Value| (v["error"].as_str().unwrap_or("ok").to_string(), v["params"]["reason"].as_str().unwrap_or("").to_string());
    // Review #12: a folder (`tmp`, or the own folder itself) is never moved.
    for raw in ["tmp", "", "."] {
        let r = via(&c, "t.use", json!({ "action": "t.src:exec", "input": { "raw": raw } })).await;
        assert_eq!(why(&r), ("pluginError".to_string(), "badOutput".to_string()), "{raw:?}: {r}");
    }
    assert!(own(&env, "t.src").join("tmp").is_dir());
    // Review #13: nor anything in the own `bin/`.
    std::fs::create_dir_all(own(&env, "t.src").join("bin")).unwrap();
    std::fs::write(own(&env, "t.src").join("bin/tool"), "x").unwrap();
    let r = via(&c, "t.use", json!({ "action": "t.src:exec", "input": { "raw": "bin/tool" } })).await;
    assert_eq!(why(&r).0, "pluginError", "{r}");
    assert!(own(&env, "t.src").join("bin/tool").exists());
    // A hand-over file the caller did not return is removed when its run ends.
    let r = via(&c, "t.use", json!({ "action": "t.src:exec", "input": { "spare": true } })).await;
    let f = r["ok"]["output"]["file"].as_str().unwrap().to_string();
    assert!(f.starts_with("tmp/call-"), "{r}");
    assert!(!own(&env, "t.use").join(&f).exists());
    assert!(!own(&env, "t.src").join("tmp/spare.csv").exists());
}
