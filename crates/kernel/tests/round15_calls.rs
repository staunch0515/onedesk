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
    let dir = root.join(id).join("0.1.0");
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": id, "icon": "box", "main": "main.js" });
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
    if (input.file) {
      await ctx.host.process.run({ program: "sh", args: ["-c", "printf 'a\\n1\\n2\\n' > tmp/r.csv"] });
      return { output: { type: "table", file: "tmp/r.csv" } };
    }
    const r = await tryIt(() => ctx.host.process.run({ program: "sh", args: ["-c", "printf %s \"$PW\""], env: { PW: "{{secret:pw}}" } }));
    return { echoed: input, caller: ctx.caller, resource: ctx.resource && ctx.resource.id, run: !!ctx.runId,
             out: r.ok ? r.ok.stdout : r };
  });
  host.actions.handle("hidden", async () => ({ ok: true }));
} };
"#;

const USE: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("via", async (ctx, input) => {
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
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    let action = |id: &str, out: &str| json!({ "id": id, "label": id, "output": out });
    pkg(&root, "t.src", json!({
        "requires": { "programs": [{ "name": "sh", "source": "system" }], "secrets": { "names": ["pw"] } },
        "contributes": { "kinds": [{ "id": "conn", "label": "C", "icon": "box", "tree": "resources", "newName": "c" }],
                         "actions": [action("exec", "text"), action("hidden", "text")] },
        "exports": { "actions": ["exec"] }
    }), SRC);
    let user = |id: &str, deps: Value| {
        pkg(&root, id, json!({
            "depends": deps,
            "contributes": { "actions": [action("via", "text"), action("via-table", "table")], "commands": [{ "id": "probe", "label": "p" }] }
        }), &USE.replace(r#"host.actions.handle("via","#, r#"for (const n of ["via", "via-table"]) host.actions.handle(n,"#));
    };
    user("t.use", json!([{ "id": "t.src", "version": ">=0.1.0" }]));
    user("t.nodep", json!([]));
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
    cfg.action_timeout = Duration::from_secs(20);
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
