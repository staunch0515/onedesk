//! Round 3 (docs/handoff/round3-plan.md §9): runs, page events, recompute, plugin state and
//! settings, host params/storage/settings, palette, the plugins and runs trees.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use onedesk_protocol::ErrorCode;
use rusqlite::Connection;
use serde_json::{json, Value};

async fn setup() -> (Env, Arc<Client>) {
    let env = open(&fixtures());
    let c = Arc::new(Client::in_proc(env.kernel.clone()));
    c.hello().await;
    (env, c)
}

async fn job(c: &Client, text: &str) -> String {
    let r = c.ok("page.save", json!({ "target": "new:test.runner:job", "changes": { "name": "J", "body.text": text } })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn start(c: &Client, res: Option<&str>, action: &str, input: Value, env: Option<&str>, params: Value) -> String {
    let target = res.map(|r| format!("resource:{r}")).unwrap_or_else(|| "core:none".into());
    let id = c
        .ok("run.start", json!({ "action": action, "resourceId": res, "target": target, "tabId": "t1", "envId": env, "input": input, "params": params }))
        .await;
    id.as_str().unwrap().to_string()
}

/// Waits until the run is no longer running and returns it (with output).
async fn finished(c: &Client, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        assert!(Instant::now() < deadline, "run {id} did not finish");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn run_text(c: &Client, res: &str, text: &str) -> Value {
    let id = start(c, Some(res), "run", json!({ "body.text": text }), None, json!({})).await;
    finished(c, &id).await
}

fn db(env: &Env) -> Connection {
    Connection::open(env.kernel.db_path()).unwrap()
}

fn count(env: &Env, stmt_text: &str, arg: &str) -> i64 {
    db(env).query_row(stmt_text, [arg], |r| r.get(0)).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_success_is_recorded_with_events_output_and_audit() {
    let (env, c) = setup().await;
    let j = job(&c, "hello").await;
    let t = Instant::now();
    let id = start(&c, Some(&j), "run", json!({ "body.text": "plain" }), None, json!({ "who": "me" })).await;
    assert!(t.elapsed() < Duration::from_millis(500));
    c.event(|e| e.topic == format!("run:{id}")).await;
    let r = finished(&c, &id).await;
    assert_eq!(r["status"], "success");
    assert_eq!(r["seq"], 1);
    assert_eq!((r["title"].as_str(), r["resourceId"].as_str(), r["action"].as_str()), (Some("J"), Some(j.as_str()), Some("test.runner:run")));
    assert_eq!(r["actionLabel"]["en-US"], "Run");
    assert_eq!(r["output"]["type"], "table");
    assert_eq!(r["output"]["rows"][1][1], "{\"who\":\"me\"}");
    assert_eq!(r["output"]["rows"][2][1], "plain", "the input snapshot, not the saved text");
    assert_eq!(r["summary"]["rows"], 3);
    assert!(r["summary"]["durationMs"].is_number());
    assert_eq!(r["params"]["who"], "me");
    assert!(r.get("progress").is_none(), "cleared at the end");
    assert_eq!(count(&env, "SELECT count(*) FROM audit WHERE object = ?1 AND op IN ('run.start', 'run.end')", &id), 2);
    let actor: String = db(&env).query_row("SELECT actor FROM audit WHERE object = ?1 AND op = 'run.end'", [&id], |r| r.get(0)).unwrap();
    assert_eq!(actor, "plugin:test.runner@0.1.0");
    let list = c.ok("run.listFor", json!({ "id": j })).await;
    assert_eq!(list[0]["id"], id.as_str());
    assert!(list[0].get("output").is_none());
    let tasks = c.ok("run.tasks", Value::Null).await;
    assert_eq!(tasks.as_array().unwrap().len(), 1);
    c.ok("run.clearFinished", Value::Null).await;
    assert_eq!(c.ok("run.tasks", Value::Null).await, json!([]));
    // A page item id resolves to its action, a full id works too, and a run without resource.
    let id2 = start(&c, Some(&j), "save-run", json!({ "body.text": "x" }), None, json!({})).await;
    assert_eq!(finished(&c, &id2).await["status"], "success");
    let id3 = start(&c, None, "test.runner:say", json!({}), None, json!({})).await;
    let r3 = finished(&c, &id3).await;
    assert_eq!((r3["status"].as_str(), r3["output"]["text"].as_str()), (Some("success"), Some("said -")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_failures_are_error_runs_not_protocol_errors() {
    let (_env, c) = setup().await;
    let j = job(&c, "").await;
    let r = run_text(&c, &j, "fail").await;
    assert_eq!((r["status"].as_str(), r["error"]["code"].as_str(), r["error"]["message"].as_str()), (Some("error"), Some("pluginError"), Some("boom from plugin")));
    assert_eq!(run_text(&c, &j, "wrongtype").await["error"]["code"], "badOutput", "output does not match the declared type");
    assert_eq!(run_text(&c, &j, "extra").await["error"]["code"], "badOutput");
    let id = start(&c, Some(&j), "nope", json!({}), None, json!({})).await;
    assert_eq!(finished(&c, &id).await["error"]["code"], "unknownAction");
    // An action bound to a kind, run without a resource of it.
    let id = start(&c, None, "test.runner:run", json!({}), None, json!({})).await;
    assert_eq!(finished(&c, &id).await["error"]["code"], "invalidInput");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_can_be_cancelled_while_kernel_keeps_answering_and_late_host_calls_are_refused() {
    let (env, c) = setup().await;
    let j = job(&c, "").await;
    let id = start(&c, Some(&j), "run", json!({ "body.text": "slow" }), None, json!({})).await;
    // Progress arrives, throttled.
    c.event(|e| e.topic == format!("run:{id}")).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mid = c.ok("run.get", json!({ "id": id })).await;
    assert_eq!(mid["status"], "running");
    assert!(mid["cancellable"].as_bool().unwrap());
    assert!(mid["progress"]["fraction"].as_f64().unwrap() > 0.0);
    let t = Instant::now();
    c.ok("tree.list", Value::Null).await;
    c.ok("tree.children", json!({ "tree": "resources" })).await;
    assert!(t.elapsed() < Duration::from_millis(250), "kernel answers during a run");
    let progress_rows: i64 = count(&env, "SELECT count(*) FROM audit WHERE object = ?1", &id);
    assert_eq!(progress_rows, 1, "progress is not audited");
    c.ok("command.execute", json!({ "id": "run.cancel", "context": { "target": format!("run:{id}") } })).await;
    let r = finished(&c, &id).await;
    assert_eq!(r["status"], "cancelled");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(count(&env, "SELECT count(*) FROM plugin_storage WHERE key = ?1", "afterCancel"), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_times_out() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = test_config();
    cfg.action_timeout = Duration::from_millis(800);
    let env = open_with(tmp, &fixtures(), cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let j = job(&c, "").await;
    let r = run_text(&c, &j, "sleepy").await;
    assert_eq!((r["status"].as_str(), r["error"]["code"].as_str()), (Some("error"), Some("timeout")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn input_snapshot_is_kept_and_table_is_truncated_to_10000_rows() {
    let (_env, c) = setup().await;
    // D377: the limit went from 1000 to 10 000 rows.
    let j = job(&c, "rows 10500").await;
    let r = run_text(&c, &j, "rows 10500").await;
    let out = &r["output"];
    assert_eq!((out["rows"].as_array().unwrap().len(), out["total"].as_u64(), out["truncated"].as_bool()), (10000, Some(10500), Some(true)));
    assert_eq!(r["summary"]["message"], "made 10500");
    c.ok("page.save", json!({ "target": format!("resource:{j}"), "changes": { "body.text": "changed later" } })).await;
    let again = c.ok("run.get", json!({ "id": r["id"] })).await;
    assert_eq!(again["input"]["body.text"], "rows 10500");
    // The run page shows the snapshot read-only, with the run's number at the end of the breadcrumb.
    let p = c.ok("page.resolve", json!({ "target": format!("run:{}", r["id"].as_str().unwrap()) })).await;
    assert_eq!((p["readOnly"].as_bool(), p["runId"].as_str(), p["values"]["body.text"].as_str()), (Some(true), r["id"].as_str(), Some("rows 10500")));
    assert_eq!(p["breadcrumb"].as_array().unwrap().last().unwrap()["label"], format!("#{}", r["seq"]));
    assert_eq!(p["view"].as_array().unwrap().last().unwrap()["text"], format!("run {}", r["seq"]));
    // Still opens when the resource is gone (from the snapshot).
    c.ok("resource.delete", json!({ "id": j })).await;
    let p = c.ok("page.resolve", json!({ "target": format!("run:{}", r["id"].as_str().unwrap()) })).await;
    assert_eq!((p["found"].as_bool(), p["values"]["body.text"].as_str()), (Some(true), Some("rows 10500")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn leftover_running_runs_become_interrupted_after_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    let id = {
        let k = Arc::new(onedesk_kernel::Kernel::open(&ws, &fixtures(), config_for(&fixtures())).unwrap());
        let c = Client::in_proc(k.clone());
        c.hello().await;
        let j = job(&c, "").await;
        let id = start(&c, Some(&j), "run", json!({ "body.text": "slow" }), None, json!({})).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        k.shutdown();
        id
    };
    let k = Arc::new(onedesk_kernel::Kernel::open(&ws, &fixtures(), config_for(&fixtures())).unwrap());
    let c = Client::in_proc(k.clone());
    c.hello().await;
    let r = c.ok("run.get", json!({ "id": id })).await;
    assert_eq!((r["status"].as_str(), r["error"]["code"].as_str()), (Some("error"), Some("interrupted")));
    // Review #13: the end of an interrupted run is audited too.
    let n: i64 = Connection::open(ws.join("workspace.db"))
        .unwrap()
        .query_row("SELECT count(*) FROM audit WHERE op = 'run.end' AND object = ?1 AND summary LIKE '%interrupted%'", [&id], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_200_runs_per_resource_are_kept_except_kept_ones() {
    let (env, c) = setup().await;
    let j = job(&c, "").await;
    let first = run_text(&c, &j, "rows 1").await["id"].as_str().unwrap().to_string();
    c.ok("run.setKept", json!({ "id": first, "kept": true, "name": "baseline" })).await;
    let second = run_text(&c, &j, "rows 1").await["id"].as_str().unwrap().to_string();
    for _ in 0..200 {
        run_text(&c, &j, "rows 1").await;
    }
    assert_eq!(count(&env, "SELECT count(*) FROM runs WHERE resource_id = ?1", &j), 201);
    assert_eq!(c.ok("run.get", json!({ "id": second })).await, Value::Null, "the oldest unkept one went");
    let kept = c.ok("run.get", json!({ "id": first })).await;
    assert_eq!((kept["kept"].as_bool(), kept["keptName"].as_str()), (Some(true), Some("baseline")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn purge_removes_runs_and_leaves_no_trace_in_the_files() {
    let (env, c) = setup().await;
    let marker = "RunMarkerQz9";
    let j = job(&c, "").await;
    for i in 0..3 {
        run_text(&c, &j, &format!("rows 2 {marker}{i}")).await;
        run_text(&c, &j, &format!("plain {marker}")).await;
    }
    c.ok("resource.delete", json!({ "id": j })).await;
    c.ok("resource.purge", json!({ "id": j })).await;
    assert_eq!(count(&env, "SELECT count(*) FROM runs WHERE resource_id = ?1", &j), 0);
    let dir = env.kernel.db_path().parent().unwrap().to_path_buf();
    for f in ["workspace.db", "workspace.db-wal"] {
        let bytes = std::fs::read(dir.join(f)).unwrap_or_default();
        assert!(!bytes.windows(marker.len()).any(|w| w == marker.as_bytes()), "{marker} in {f}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disabled_plugin_greys_out_hides_and_refuses_then_comes_back() {
    let (_env, c) = setup().await;
    let j = job(&c, "hello").await;
    let slow = start(&c, Some(&j), "run", json!({ "body.text": "slow" }), None, json!({})).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    c.ok("plugin.setEnabled", json!({ "plugin": "test.runner", "enabled": false })).await;
    let r = finished(&c, &slow).await;
    assert_eq!((r["status"].as_str(), r["error"]["code"].as_str()), (Some("error"), Some("pluginDisabled")));
    let node = &c.ok("tree.children", json!({ "tree": "resources" })).await["nodes"][0];
    assert_eq!(node["state"], "disabled");
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{j}") })).await;
    assert_eq!((p["state"].as_str(), p["readOnly"].as_bool(), p["view"].clone()), (Some("disabled"), Some(true), json!([])));
    assert!(!c.ok("command.newItems", Value::Null).await.as_array().unwrap().iter().any(|i| i["id"] == "new:test.runner:job"));
    let palette = c.ok("command.palette", Value::Null).await;
    assert!(!palette.as_array().unwrap().iter().any(|i| i["id"].as_str().unwrap().contains("test.runner")));
    assert_eq!(run_text(&c, &j, "plain").await["error"]["code"], "pluginDisabled");
    let e = c.call("command.execute", json!({ "id": "test.runner:probe" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Denied);
    let plugins = c.ok("tree.children", json!({ "tree": "plugins" })).await;
    let runner = plugins["nodes"].as_array().unwrap().iter().find(|n| n["key"] == "test.runner").unwrap();
    assert_eq!((runner["state"].as_str(), runner["target"].as_str()), (Some("disabled"), Some("plugin:test.runner")));
    assert_eq!(c.ok("plugin.get", json!({ "plugin": "test.runner" })).await["enabled"], false);
    // A provided tree disappears while its plugin is off.
    c.ok("plugin.setEnabled", json!({ "plugin": "test.alpha", "enabled": false })).await;
    let ids = |v: Value| v.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert!(!ids(c.ok("tree.list", Value::Null).await).contains(&"test.alpha:disk".to_string()));
    // Back on: everything as before, data untouched.
    c.ok("command.execute", json!({ "id": "plugin.enable", "context": { "tree": "plugins", "nodeKey": "test.runner" } })).await;
    c.ok("plugin.setEnabled", json!({ "plugin": "test.alpha", "enabled": true })).await;
    assert!(ids(c.ok("tree.list", Value::Null).await).contains(&"test.alpha:disk".to_string()));
    assert_eq!(c.ok("tree.children", json!({ "tree": "resources" })).await["nodes"][0]["state"], "ok");
    assert_eq!(run_text(&c, &j, "plain").await["status"], "success");
    assert_eq!(c.ok("resource.get", json!({ "id": j })).await["body"]["text"], "hello");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn settings_are_validated_and_default() {
    let (_env, c) = setup().await;
    let d = c.ok("plugin.get", json!({ "plugin": "test.runner" })).await;
    let value = |d: &Value, n: &str| d["settings"].as_array().unwrap().iter().find(|s| s["name"] == n).unwrap()["value"].clone();
    assert_eq!((value(&d, "rowLimit"), value(&d, "style")), (json!("5"), json!("upper")));
    assert_eq!((d["author"].as_str(), d["license"].as_str()), (Some("Test"), Some("MIT")));
    let j = job(&c, "").await;
    assert_eq!(run_text(&c, &j, "limit").await["output"]["rows"].as_array().unwrap().len(), 5);
    let bad = |name: &str, v: &str| json!({ "plugin": "test.runner", "name": name, "value": v });
    for (n, v, reason) in [("rowLimit", "many", "badValue"), ("style", "sideways", "badValue"), ("verbose", "yes", "badValue"), ("nope", "1", "unknownSetting")] {
        let e = c.call("plugin.setSetting", bad(n, v)).await.unwrap_err();
        assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::Invalid, reason), "{n}={v}");
    }
    c.ok("plugin.setSetting", bad("rowLimit", " 7 ")).await;
    c.ok("plugin.setSetting", bad("style", "lower")).await;
    assert_eq!(value(&c.ok("plugin.get", json!({ "plugin": "test.runner" })).await, "rowLimit"), "7");
    assert_eq!(run_text(&c, &j, "limit").await["output"]["rows"].as_array().unwrap().len(), 7);
    // A plugin reads only settings its own manifest declares.
    assert_eq!(c.probe("test.runner", "settings.get", json!(["style"])).await["ok"], "lower");
    assert_eq!(c.probe("test.runner", "settings.get", json!(["other"])).await["error"], "denied");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn storage_is_isolated_per_plugin_and_version_and_limited() {
    let tmp = tempfile::tempdir().unwrap();
    let plugins = plugins_with(tmp.path(), &[]);
    let ws = tmp.path().join("ws");
    {
        let k = Arc::new(onedesk_kernel::Kernel::open(&ws, &plugins, config_for(&plugins)).unwrap());
        let c = Client::in_proc(k.clone());
        c.hello().await;
        assert_eq!(c.probe("test.runner", "storage.set", json!(["k", { "a": 1 }])).await["ok"], Value::Null);
        assert_eq!(c.probe("test.runner", "storage.get", json!(["k"])).await["ok"], json!({ "a": 1 }));
        assert_eq!(c.probe("test.runner", "storage.keys", json!([])).await["ok"], json!(["k"]));
        assert_eq!(c.probe("test.alpha", "storage.get", json!(["k"])).await["ok"], Value::Null, "another plugin");
        let big = "x".repeat(256 * 1024 + 1);
        assert_eq!(c.probe("test.runner", "storage.set", json!(["big", big])).await["error"], "invalid");
        let long_key = "k".repeat(201);
        assert_eq!(c.probe("test.runner", "storage.set", json!([long_key, 1])).await["error"], "invalid");
        c.probe("test.runner", "storage.set", json!(["gone", 1])).await;
        c.probe("test.runner", "storage.remove", json!(["gone"])).await;
        assert_eq!(c.probe("test.runner", "storage.keys", json!([])).await["ok"], json!(["k"]));
        k.shutdown();
    }
    // The same plugin at another version does not see it.
    let old = plugins.join("test.runner/0.1.0");
    let new = plugins.join("test.runner/0.2.0");
    std::fs::rename(&old, &new).unwrap();
    let m = std::fs::read_to_string(new.join("manifest.json")).unwrap().replace("\"0.1.0\"", "\"0.2.0\"");
    std::fs::write(new.join("manifest.json"), m).unwrap();
    let k = Arc::new(onedesk_kernel::Kernel::open(&ws, &plugins, config_for(&plugins)).unwrap());
    let c = Client::in_proc(k.clone());
    c.hello().await;
    assert_eq!(c.probe("test.runner", "storage.get", json!(["k"])).await["ok"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn params_get_inherits_from_the_tab_environment_or_finds_nothing() {
    let (_env, c) = setup().await;
    let def = c.ok("tree.children", json!({ "tree": "env" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    c.ok("params.set", json!({ "node": def, "name": "host", "value": "db.local" })).await;
    let child = c.ok("command.execute", json!({ "id": "env.newChild", "context": { "tree": "env", "nodeKey": def, "args": { "name": "Dev" } } })).await[0]["key"]
        .as_str()
        .unwrap()
        .to_string();
    let j = job(&c, "").await;
    let id = start(&c, Some(&j), "run", json!({ "body.text": "plain" }), Some(&child), json!({})).await;
    let r = finished(&c, &id).await;
    assert_eq!(r["output"]["rows"][0][1], "db.local@Default");
    assert_eq!(r["envName"], "Dev");
    let id = start(&c, Some(&j), "run", json!({ "body.text": "plain" }), None, json!({})).await;
    assert_eq!(finished(&c, &id).await["output"]["rows"][0][1], "-");
    // run.reuse opens the resource with that run's parameters and environment.
    let id = start(&c, Some(&j), "run", json!({ "body.text": "plain" }), Some(&child), json!({ "x": "1" })).await;
    finished(&c, &id).await;
    let eff = c.ok("command.execute", json!({ "id": "run.reuse", "context": { "target": format!("run:{id}") } })).await;
    assert_eq!(eff, json!([{ "type": "open", "target": format!("resource:{j}"), "params": { "x": "1" }, "envId": child }]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn page_events_recompute_frame_and_result_tabs() {
    let (_env, c) = setup().await;
    let j = job(&c, "select 1").await;
    let t = format!("resource:{j}");
    let ev = c.ok("page.event", json!({ "target": t, "event": "tidy", "context": { "draft": { "body.text": "select :name" } } })).await;
    assert_eq!(ev["changes"]["body.text"], "SELECT :NAME");
    assert_eq!(ev["message"]["en-US"], "Tidied");
    assert_eq!(c.ok("resource.get", json!({ "id": j })).await["body"]["text"], "select 1", "events change only the draft");
    // Recompute: render with the draft gives the parameter strip.
    let p = c.ok("page.resolve", json!({ "target": t, "context": { "draft": { "body.text": "where id = :user_id" } } })).await;
    assert_eq!(p["view"][0]["fields"][0]["name"], "user_id");
    assert!(p["recompute"].as_bool().unwrap() && p["usesEnv"].as_bool().unwrap());
    let tabs: Vec<&str> = p["resultTabs"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(tabs, vec!["result", "final", "history"]);
    let run_item = p["actions"].as_array().unwrap().iter().find(|a| a["id"] == "run").unwrap();
    assert_eq!(run_item["action"], "test.runner:run");
    // Result tab of type `view`, drawn by the plugin for one run.
    let r = run_text(&c, &j, "rows 1").await;
    let v = c.ok("run.render", json!({ "id": r["id"], "tabId": "final" })).await;
    assert_eq!(v[0]["text"], "final:rows 1");
    assert_eq!(c.call("run.render", json!({ "id": r["id"], "tabId": "result" })).await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn palette_plugins_tree_and_broken_packages() {
    let tmp = tempfile::tempdir().unwrap();
    let plugins = plugins_with(tmp.path(), &[]);
    let bad = plugins.join("test.broken/0.1.0");
    std::fs::create_dir_all(&bad).unwrap();
    std::fs::write(bad.join("manifest.json"), r#"{"id":"test.broken","version":"0.1.0","apiVersion":"1"}"#).unwrap();
    let env = open_in(tmp, &plugins);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let palette = c.ok("command.palette", Value::Null).await;
    let ids: Vec<&str> = palette.as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
    for want in ["open.audit", "open.deleted", "node.newGroup", "env.newChild", "test.runner:probe", "new:test.runner:job"] {
        assert!(ids.contains(&want), "{want} in {ids:?}");
    }
    // D296: commands without `palette: true` (node commands in a kind's menu) stay out, and so do
    // kernel commands that need a node.
    for unwanted in ["test.runner:inspect", "test.alpha:probe", "node.rename", "node.delete", "node.open", "run.cancel", "plugin.grantFolder"] {
        assert!(!ids.contains(&unwanted), "{unwanted} not in {ids:?}");
    }
    let j0 = job(&c, "").await;
    let node = &c.ok("tree.children", json!({ "tree": "resources" })).await["nodes"][0];
    assert_eq!(node["key"], j0.as_str());
    assert!(node["menu"].as_array().unwrap().iter().any(|m| m["id"] == "test.runner:inspect"), "still in the context menu");
    let runner = palette.as_array().unwrap().iter().find(|p| p["id"] == "test.runner:probe").unwrap();
    assert_eq!(runner["group"]["en-US"], "Runner");
    let nodes = c.ok("tree.children", json!({ "tree": "plugins" })).await;
    let broken = nodes["nodes"].as_array().unwrap().iter().find(|n| n["key"] == "test.broken").unwrap();
    assert_eq!((broken["state"].as_str(), broken["stateReason"].as_str()), (Some("broken"), Some("schema")));
    assert_eq!(c.ok("plugin.get", json!({ "plugin": "test.broken" })).await["load"]["state"], "error");
    let p = c.ok("page.resolve", json!({ "target": "plugin:test.runner" })).await;
    assert_eq!((p["page"].as_str(), p["title"].as_str()), (Some("plugin"), Some("Runner")));
    // The runs tree separates recent runs from results explicitly kept by the user.
    let j = job(&c, "").await;
    let a = run_text(&c, &j, "rows 1").await;
    let b = run_text(&c, &j, "rows 2").await;
    let runs = c.ok("tree.children", json!({ "tree": "runs" })).await;
    assert_eq!(runs["nodes"][0]["key"], "@runs:recent");
    assert_eq!(runs["nodes"][1]["key"], "@runs:saved");
    let recent = c.ok("tree.children", json!({ "tree": "runs", "parent": "@runs:recent" })).await;
    assert_eq!(recent["nodes"][0]["key"], b["id"]);
    assert_eq!(recent["nodes"][1]["target"], format!("run:{}", a["id"].as_str().unwrap()));
    c.ok("run.setKept", json!({ "id": a["id"], "kept": true, "name": "Saved baseline" })).await;
    let saved = c.ok("tree.children", json!({ "tree": "runs", "parent": "@runs:saved" })).await;
    assert_eq!(saved["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(saved["nodes"][0]["label"], "#1 Saved baseline");
    assert_eq!(saved["nodes"][0]["parentKey"], "@runs:saved");
    let path = c.ok("tree.path", json!({ "tree": "runs", "key": a["id"] })).await;
    assert_eq!(path, json!(["@runs:saved", a["id"]]));
    let saved_id = a["id"].as_str().unwrap();
    let confirmation = c.ok("command.execute", json!({ "id": "run.delete", "context": { "target": format!("run:{saved_id}") } })).await;
    assert_eq!(confirmation[0]["type"], "confirm");
    c.ok("command.execute", json!({ "id": "run.delete", "context": { "target": format!("run:{saved_id}"), "args": { "confirmed": true } } })).await;
    assert!(c.ok("run.get", json!({ "id": a["id"] })).await.is_null());
    let saved = c.ok("tree.children", json!({ "tree": "runs", "parent": "@runs:saved" })).await;
    assert_eq!(saved["nodes"].as_array().unwrap().len(), 0);
    c.ok("plugin.reload", json!({ "plugin": "test.runner" })).await;
    assert_eq!(run_text(&c, &j, "rows 1").await["status"], "success");
}

/* ------------------------------------------------------------------ after the round-3 review */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review1_runs_on_an_unsaved_new_page() {
    let (_env, c) = setup().await;
    let id = c
        .ok("run.start", json!({ "action": "run", "target": "new:test.runner:job", "tabId": "t", "input": { "body.text": "rows 2" } }))
        .await;
    let r = finished(&c, id.as_str().unwrap()).await;
    assert_eq!((r["status"].as_str(), r["output"]["total"].as_u64()), (Some("success"), Some(2)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review2_actions_never_get_resources_of_other_plugins() {
    let (_env, c) = setup().await;
    let alpha = c.ok("page.save", json!({ "target": "new:test.alpha:item", "changes": { "body.text": "private" } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    let env_id = c.ok("tree.children", json!({ "tree": "env" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    for res in [alpha.as_str(), env_id.as_str()] {
        let id = start(&c, Some(res), "test.runner:say", json!({}), None, json!({})).await;
        let r = finished(&c, &id).await;
        assert_eq!((r["status"].as_str(), r["error"]["code"].as_str()), (Some("error"), Some("invalidInput")), "{res}");
        assert!(r.get("output").is_none());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review3_disabled_plugin_resources_cannot_be_saved_created_or_renamed() {
    let (_env, c) = setup().await;
    let j = job(&c, "keep").await;
    c.ok("plugin.setEnabled", json!({ "plugin": "test.runner", "enabled": false })).await;
    let denied = |e: onedesk_protocol::ProtocolError| assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::Denied, "pluginDisabled"));
    denied(c.call("page.save", json!({ "target": format!("resource:{j}"), "changes": { "body.text": "x" } })).await.unwrap_err());
    denied(c.call("page.save", json!({ "target": "new:test.runner:job", "changes": { "name": "N" } })).await.unwrap_err());
    denied(c.call("tree.rename", json!({ "tree": "resources", "key": j, "name": "R" })).await.unwrap_err());
    let r = c.ok("resource.get", json!({ "id": j })).await;
    assert_eq!((r["name"].as_str(), r["body"]["text"].as_str()), (Some("J"), Some("keep")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review4_event_changes_are_limited_to_bound_fields() {
    let (_env, c) = setup().await;
    let j = job(&c, "x").await;
    let ev = c.ok("page.event", json!({ "target": format!("resource:{j}"), "event": "sneaky", "context": { "draft": { "body.text": "x" } } })).await;
    assert_eq!(ev["changes"], json!({ "body.text": "kept" }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review5_oversized_input_draft_and_lines_are_refused() {
    let (env, c) = setup().await;
    let j = job(&c, "").await;
    let big = "x".repeat(8 * 1024 * 1024 + 1);
    let id = start(&c, Some(&j), "run", json!({ "body.text": big }), None, json!({})).await;
    let r = finished(&c, &id).await;
    assert_eq!(r["error"]["code"], "invalidInput");
    let e = c.call("page.resolve", json!({ "target": format!("resource:{j}"), "context": { "draft": { "body.text": big } } })).await.unwrap_err();
    assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::InvalidParams, "tooLarge"));
    let e = c.call("page.event", json!({ "target": format!("resource:{j}"), "event": "tidy", "context": { "draft": { "body.text": big } } })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidParams);
    // Over the socket, a line longer than 32 MB is answered and skipped; the connection goes on.
    let s = Client::socket(env.kernel.clone(), env.tmp.path()).await;
    s.hello().await;
    let huge = format!("{{\"id\":77,\"method\":\"tree.list\",\"params\":{{\"x\":\"{}\"}}}}", "y".repeat(33 * 1024 * 1024));
    let resp = s.raw(huge, 0).await;
    let err = resp.error.unwrap();
    assert_eq!((err.code, err.params["reason"].as_str()), (ErrorCode::InvalidParams, "tooLarge"));
    s.ok("tree.list", Value::Null).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review6_locale_reaches_actions_and_result_tabs() {
    let (_env, c) = setup().await;
    let j = job(&c, "").await;
    let id = c
        .ok("run.start", json!({ "action": "run", "resourceId": j, "target": format!("resource:{j}"), "tabId": "t",
                                 "input": { "body.text": "locale" }, "locale": "zh-CN" }))
        .await;
    let r = finished(&c, id.as_str().unwrap()).await;
    assert_eq!(r["output"]["rows"][0][1], "zh-CN");
    let v = c.ok("run.render", json!({ "id": r["id"], "tabId": "final", "locale": "zh-CN" })).await;
    assert_eq!(v[0]["text"], "final:locale@zh-CN");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review11_storage_and_setting_size_limits() {
    let (_env, c) = setup().await;
    let chunk = "z".repeat(250 * 1024);
    let mut refused_at = None;
    for i in 0..70 {
        let r = c.probe("test.runner", "storage.set", json!([format!("k{i}"), chunk])).await;
        if r.get("error").is_some() {
            assert_eq!(r["params"]["reason"], "tooLarge");
            refused_at = Some(i);
            break;
        }
    }
    let at = refused_at.expect("the 16 MB total was enforced");
    assert!((60..=67).contains(&at), "refused at {at}");
    for i in 0..at {
        c.probe("test.runner", "storage.remove", json!([format!("k{i}")])).await;
    }
    for i in 0..1000 {
        assert!(c.probe("test.runner", "storage.set", json!([format!("n{i}"), 1])).await.get("error").is_none(), "{i}");
    }
    let r = c.probe("test.runner", "storage.set", json!(["one-too-many", 1])).await;
    assert_eq!(r["params"]["reason"], "tooManyKeys");
    assert!(c.probe("test.runner", "storage.set", json!(["n5", 2])).await.get("error").is_none(), "overwriting is fine");
    let e = c.call("plugin.setSetting", json!({ "plugin": "test.runner", "name": "style", "value": "u".repeat(4097) })).await.unwrap_err();
    assert_eq!(e.params["reason"], "tooLarge");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn new_pages_carry_the_page_frame_from_the_manifest() {
    let (_env, c) = setup().await;
    let p = c.ok("page.resolve", json!({ "target": "new:test.runner:job" })).await;
    let tabs: Vec<&str> = p["resultTabs"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(tabs, vec!["result", "final", "history"]);
    assert!(p["recompute"].as_bool().unwrap() && p["usesEnv"].as_bool().unwrap());
    let run = p["actions"].as_array().unwrap().iter().find(|a| a["id"] == "run").unwrap();
    assert_eq!(run["action"], "test.runner:run");
}
