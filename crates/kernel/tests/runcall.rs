//! D487 §25 (docs/redesign/book.md, K14): a plugin runs another plugin's resource from inside a run, as the user would
//! from its page — its saved values as input, its parameters from the environment unless given. Temporary folders
//! only; generic packages (the kernel knows no step).

mod common;

use std::path::{Path, PathBuf};

use common::*;
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
"#;

/// `job`: its page has a parameter `who` (from the environment) and a run button; the run answers with its input and
/// parameters, as text and as data; `fail` in the body fails it.
const JOBS: &str = r#"
export default {
  activate(host) {
    host.commands.handle("probe", probe);
    host.pages.handle("job", {
      async render(ctx) {
        const f = { name: "who", label: "who", kind: "text", param: true };
        try { const p = await ctx.host.params.get("who"); if (p && p.found) f.envValue = String(p.value); } catch {}
        return { view: [{ type: "form", id: "f", layout: "stack", fields: [{ name: "cmd", label: "cmd", kind: "text", bind: "body.cmd" }, f] }] };
      },
    });
    host.actions.handle("go", async (ctx, input) => {
      if (input["body.cmd"] === "slow") { await ctx.host.util.sleep(8000); return { output: { type: "text", text: "late" } }; }
      if (input["body.cmd"] === "fail") return { output: { type: "text", text: "no" }, failed: { message: "it failed" } };
      return { output: { type: "text", text: input["body.cmd"] + " for " + ctx.params.who }, data: { status: 200, who: ctx.params.who } };
    });
  },
};
"#;

/// `book`: its run calls the resources named in its body, one after another, and answers with what came back.
const RUNNER: &str = r#"
export default {
  activate(host) {
    host.commands.handle("probe", probe);
    host.pages.handle("flow", { render() { return { view: [] }; } });
    host.actions.handle("play", async (ctx) => {
      const out = [];
      for (const s of ctx.resource.body.steps || []) {
        try { out.push(await ctx.host.runs.call(s.id, { params: s.params || {} })); } catch (e) { out.push({ thrown: e.code + "/" + ((e.params || {}).reason || "") }); }
      }
      return { output: { type: "text", text: JSON.stringify(out) } };
    });
  },
};
"#;

fn write_pkg(root: &Path, id: &str, requires: Value, contributes: Value, main: &str) {
    let pkg = root.join(id).join("0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js", "requires": requires, "contributes": contributes });
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), format!("{PROBE}\n{main}")).unwrap();
}

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    let probe = json!({ "id": "probe", "label": "probe", "icon": "box" });
    write_pkg(
        &root,
        "test.jobs",
        json!({}),
        json!({
            "kinds": [ { "id": "job", "label": "job", "icon": "box", "tree": "resources", "draggable": true, "page": "job" },
                       { "id": "note", "label": "note", "icon": "box", "tree": "resources", "draggable": true } ],
            "pages": [ { "id": "job", "actions": [ { "id": "go", "role": "run", "action": "go", "label": "go", "icon": "play" } ] } ],
            "actions": [ { "id": "go", "label": "go", "kinds": ["job"], "output": "text" } ],
            "commands": [probe]
        }),
        JOBS,
    );
    for (id, runs) in [("test.runner", true), ("test.norun", false)] {
        write_pkg(
            &root,
            id,
            json!({ "runs": runs }),
            json!({
                "kinds": [ { "id": "flow", "label": "flow", "icon": "box", "tree": "resources", "draggable": true, "page": "flow" } ],
                "pages": [ { "id": "flow", "actions": [ { "id": "play", "role": "run", "action": "play", "label": "play", "icon": "play" } ] } ],
                "actions": [ { "id": "play", "label": "play", "kinds": ["flow"], "output": "text" } ],
                "commands": [probe]
            }),
            RUNNER,
        );
    }
    root
}

async fn world() -> (Env, Client) {
    let tmp = tempfile::tempdir().unwrap();
    let root = plugins(tmp.path());
    let env = open_with(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

async fn create(c: &Client, kind: &str, changes: Value) -> String {
    let r = c.ok("page.save", json!({ "target": format!("new:{kind}"), "changes": changes })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

/// Runs a flow and answers with what each call gave.
async fn play(c: &Client, plugin: &str, steps: Value, env: Option<&str>) -> Vec<Value> {
    let flow = create(c, &format!("{plugin}:flow"), json!({ "name": "Flow", "body.steps": steps })).await;
    let run = c
        .ok("run.start", json!({ "action": format!("{plugin}:play"), "resourceId": flow, "target": format!("resource:{flow}"), "tabId": "t", "envId": env, "input": {}, "params": {} }))
        .await;
    let id = run.as_str().map(String::from).unwrap_or_else(|| run["id"].as_str().unwrap().to_string());
    for _ in 0..200 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            let text = r["output"]["text"].as_str().unwrap_or_else(|| panic!("{r}"));
            return serde_json::from_str(text).unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("run did not end");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_runs_another_resource_as_its_page_would_and_gets_its_output_and_data() {
    let (_env, c) = world().await;
    let env = c.ok("tree.children", json!({ "tree": "env" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    c.ok("params.set", json!({ "node": env, "name": "who", "value": "staging" })).await;
    let job = create(&c, "test.jobs:job", json!({ "name": "Deploy", "body.cmd": "deploy" })).await;
    let bad = create(&c, "test.jobs:job", json!({ "name": "Bad", "body.cmd": "fail" })).await;
    let note = create(&c, "test.jobs:note", json!({ "name": "Note" })).await;
    let out = play(&c, "test.runner", json!([{ "id": job }, { "id": job, "params": { "who": "prod" } }, { "id": bad }, { "id": note }, { "id": "nope" }]), Some(&env)).await;
    assert_eq!(out[0]["status"], "ok", "{out:?}");
    assert_eq!(out[0]["output"]["text"], "deploy for staging");
    assert_eq!(out[0]["data"], json!({ "status": 200, "who": "staging" }));
    assert!(out[0]["ms"].is_u64());
    assert_eq!(out[1]["output"]["text"], "deploy for prod", "given values come first");
    assert_eq!(out[2]["status"], "failed");
    assert_eq!(out[2]["error"], "it failed");
    assert_eq!(out[3]["thrown"], "invalid/notRunnable");
    assert_eq!(out[4]["thrown"], "notFound/");
    // Audited.
    let a = c.ok("audit.list", json!({ "operation": "run.call" })).await;
    assert_eq!(a.as_array().unwrap().len(), 3, "{a}");
}

#[tokio::test(flavor = "multi_thread")]
async fn only_with_the_permission_only_in_a_run_and_never_itself() {
    let (_env, c) = world().await;
    let job = create(&c, "test.jobs:job", json!({ "name": "Deploy", "body.cmd": "x" })).await;
    let out = play(&c, "test.norun", json!([{ "id": job }]), None).await;
    assert_eq!(out[0]["thrown"], "denied/notRequested");
    // A command is not a run.
    let e = c.probe("test.runner", "runs.call", json!([job])).await;
    assert_eq!(e["params"]["reason"], "notInRun", "{e}");
    // A flow that runs itself.
    let flow = create(&c, "test.runner:flow", json!({ "name": "Self" })).await;
    c.ok("page.save", json!({ "target": format!("resource:{flow}"), "changes": { "body.steps": [{ "id": flow }] } })).await;
    let run = c.ok("run.start", json!({ "action": "test.runner:play", "resourceId": flow, "target": format!("resource:{flow}"), "tabId": "t", "input": {}, "params": {} })).await;
    let id = run.as_str().unwrap().to_string();
    let mut text = String::new();
    for _ in 0..200 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            text = r["output"]["text"].as_str().unwrap_or_default().to_string();
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(text.contains("denied/loop"), "{text}");
    // The permission is listed for the user.
    let p = c.ok("plugin.get", json!({ "plugin": "test.runner" })).await;
    assert!(p["permissions"].as_array().unwrap().iter().any(|x| x["id"] == "runs"), "{p}");
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_the_caller_stops_what_it_runs_and_waiting_is_not_its_time() {
    let (_env, c) = world().await;
    let slow = create(&c, "test.jobs:job", json!({ "name": "Slow", "body.cmd": "slow" })).await;
    let flow = create(&c, "test.runner:flow", json!({ "name": "Flow", "body.steps": [{ "id": slow }] })).await;
    let run = c.ok("run.start", json!({ "action": "test.runner:play", "resourceId": flow, "target": format!("resource:{flow}"), "tabId": "t", "input": {}, "params": {} })).await;
    let id = run.as_str().unwrap().to_string();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let started = std::time::Instant::now();
    c.ok("run.cancel", json!({ "id": id })).await;
    loop {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            assert_ne!(r["status"], "ok", "{r}");
            break;
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(4), "the called run kept going");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}
