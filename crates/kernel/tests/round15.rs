//! Round 15 (X2, D239): an action's result as a data file the kernel reads itself, and transfer
//! file ends in the plugin's own folder. Plugins are generated into a temporary folder; the only
//! programs run are the system's `sh` and `seq`.

mod common;

use std::path::Path;
use std::time::Duration;

use common::*;
use serde_json::{json, Value};

const MAIN: &str = r#"
export default { activate(host) {
  host.pages.handle("p", { async render(ctx) { return { view: [{ type: "form", id: "f", layout: "stack", fields: [
    { name: "src", label: "Source", kind: "ref", kinds: ["src"] },
    { name: "at", label: "At", kind: "time", presets: [{ value: "00:00", label: "Midnight" }] },
    { name: "fixed", label: "Fixed", kind: "ref", kinds: ["src"], options: [{ value: "x", label: "X" }] }
  ] }] }; } });
  host.actions.handle("cfg", async (ctx, input) =>
    ({ output: { type: "text", text: JSON.stringify(await ctx.host.params.config(input.name)) } }));
  host.actions.handle("cap", async (ctx, input) => {
    await ctx.host.transfer.capture({ program: "sh", args: ["-c", input.script], to: input.to });
    return { output: Object.assign({ type: input.type || "table", file: input.to }, input.extra || {}) };
  });
  host.actions.handle("direct", async (ctx, input) => {
    await ctx.host.process.run({ program: "sh", args: ["-c", input.script] });
    return { output: Object.assign({ type: input.type || "table", file: input.file }, input.extra || {}) };
  });
} };
"#;

fn pkg(root: &Path) {
    let dir = root.join("t.data").join("0.1.0");
    std::fs::create_dir_all(&dir).unwrap();
    let m = json!({
        "id": "t.data", "version": "0.1.0", "apiVersion": "2", "name": "data", "icon": "box", "main": "main.js",
        "requires": { "programs": [{ "name": "sh", "source": "system" }, { "name": "seq", "source": "system" }] },
        "contributes": {
          "kinds": [{ "id": "src", "label": "S", "icon": "box", "tree": "resources", "page": "p", "newName": "s" }],
          "pages": [{ "id": "p" }],
          "actions": [
            { "id": "cap", "label": "Cap", "output": "table" },
            { "id": "direct", "label": "Direct", "output": "table" },
            { "id": "text", "label": "Text", "output": "text" },
            { "id": "cfg", "label": "Cfg", "output": "text" }
        ] }
    });
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    // `text` is `direct` under another declared output type.
    std::fs::write(dir.join("main.js"), MAIN.replace(r#"host.actions.handle("direct","#, r#"for (const n of ["direct", "text"]) host.actions.handle(n,"#)).unwrap();
}

async fn world() -> (Env, Client) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    pkg(&root);
    let mut cfg = config_for(&root);
    cfg.action_timeout = Duration::from_secs(20);
    let env = open_exact(tmp, &root, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

async fn run(c: &Client, action: &str, input: Value) -> Value {
    let id = c.ok("run.start", json!({ "action": format!("t.data:{action}"), "target": "core:none", "tabId": "t", "input": input })).await;
    for _ in 0..1500 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {id} did not end");
}

fn own(env: &Env) -> std::path::PathBuf {
    let ws = std::fs::read_dir(env.path().join("workspaces")).ok().and_then(|mut d| d.next()).map(|e| e.unwrap().path());
    ws.unwrap_or_else(|| env.kernel.db_path().parent().unwrap().to_path_buf()).join("plugin-data").join("t.data")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_captured_csv_becomes_the_table_without_a_files_grant() {
    let (env, c) = world().await;
    let script = r#"printf 'id,name\n1,ann\n2,\n3,""\n'"#;
    let r = run(&c, "cap", json!({ "script": script, "to": "tmp/r.csv" })).await;
    assert_eq!(r["status"], "success", "{r}");
    let o = &r["output"];
    assert_eq!((o["total"].as_u64(), o["truncated"].as_bool()), (Some(3), Some(false)), "{o}");
    assert_eq!(o["columns"][0]["label"], "id");
    assert_eq!(o["columns"][0]["numeric"], true);
    assert_eq!(o["rows"][1], json!(["2", null]));
    assert_eq!(o["rows"][2], json!(["3", ""]));
    assert_eq!(r["summary"]["rows"], 3);
    // Handed over: the file in the plugin's own folder is gone.
    assert!(own(&env).join("tmp").is_dir(), "{:?}", own(&env));
    assert!(!own(&env).join("tmp/r.csv").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_long_result_is_cut_in_the_run_and_exported_whole() {
    let (env, c) = world().await;
    let r = run(&c, "direct", json!({ "script": "{ echo n; seq 1 10005; } > tmp/big.csv", "file": "tmp/big.csv" })).await;
    assert_eq!(r["status"], "success", "{r}");
    let o = &r["output"];
    assert_eq!((o["total"].as_u64(), o["truncated"].as_bool()), (Some(10005), Some(true)));
    // The run stores 10,000 rows (D377) and sends the first 200 (D414).
    assert_eq!(o["rows"].as_array().unwrap().len(), 200);
    let stored: String = rusqlite::Connection::open(env.kernel.db_path()).unwrap()
        .query_row("SELECT output FROM runs WHERE id = ?1", [r["id"].as_str().unwrap()], |x| x.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&stored).unwrap()["rows"].as_array().unwrap().len(), 10_000);
    let to = env.path().join("export.csv");
    let e = c.ok("run.export", json!({ "run": r["id"], "path": to.display().to_string(), "format": "csv" })).await;
    assert_eq!(e["rows"], 10005);
    let text = std::fs::read_to_string(&to).unwrap();
    assert!(text.starts_with("\u{feff}n\r\n1\r\n"));
    assert!(text.ends_with("10005\r\n"));
    assert_eq!(text.lines().count(), 10006);
    // D414: the run carries the first 200 rows; `run.rows` reads every row, from the kept file.
    let g = c.ok("run.get", json!({ "id": r["id"] })).await;
    assert_eq!((g["output"]["paged"].as_bool(), g["output"]["rows"].as_array().unwrap().len()), (Some(true), 200));
    let page = c.ok("run.rows", json!({ "id": r["id"], "offset": 10_000, "limit": 1000 })).await;
    assert_eq!(page["total"], 10005);
    assert_eq!(page["rows"], json!([["10001"], ["10002"], ["10003"], ["10004"], ["10005"]]));
    let page = c.ok("run.rows", json!({ "id": r["id"], "offset": 0, "limit": 2 })).await;
    assert_eq!(page["rows"], json!([["1"], ["2"]]));
    for limit in [0, 1001] {
        let e = c.call("run.rows", json!({ "id": r["id"], "offset": 0, "limit": limit })).await.unwrap_err();
        assert_eq!(e.code, onedesk_protocol::ErrorCode::InvalidParams, "{limit}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn text_from_a_file_and_refused_paths() {
    let (env, c) = world().await;
    let r = run(&c, "text", json!({ "script": "echo hello > tmp/t.txt", "file": "tmp/t.txt", "type": "text" })).await;
    assert_eq!(r["status"], "success", "{r}");
    assert_eq!(r["output"]["text"], "hello\n");
    // Outside the own folder (relative escape, or an absolute path without a grant): badOutput.
    let outside = env.path().join("secret.csv");
    std::fs::write(&outside, "a\n1\n").unwrap();
    for file in ["../../secret.csv".to_string(), outside.display().to_string()] {
        let r = run(&c, "direct", json!({ "script": "true", "file": file })).await;
        assert_eq!((r["status"].as_str(), r["error"]["code"].as_str()), (Some("error"), Some("badOutput")), "{r}");
    }
    assert!(outside.exists());
    // Ragged CSV and a type the file form does not take.
    let r = run(&c, "direct", json!({ "script": "printf 'a,b\\n1\\n' > tmp/x.csv", "file": "tmp/x.csv" })).await;
    assert_eq!(r["error"]["code"], "badOutput", "{r}");
    // Transfer ends: relative paths stay in the own folder.
    let r = run(&c, "cap", json!({ "script": "echo x", "to": "../escape.csv" })).await;
    assert_eq!(r["status"], "error", "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugin_reads_a_workspace_configuration_value() {
    let (_env, c) = world().await;
    let r = run(&c, "cfg", json!({ "name": "default.source" })).await;
    let v: Value = serde_json::from_str(r["output"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(v["found"], false, "{v}");
    c.ok("workspace.setConfig", json!({ "name": "default.source", "value": "r-123" })).await;
    let r = run(&c, "cfg", json!({ "name": "default.source" })).await;
    let v: Value = serde_json::from_str(r["output"]["text"].as_str().unwrap()).unwrap();
    assert_eq!((v["found"].as_bool(), v["value"].as_str()), (Some(true), Some("r-123")), "{v}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn small_paged_tables_read_from_the_run_and_ref_fields_list_their_kinds() {
    let (_env, c) = world().await;
    let r = run(&c, "direct", json!({ "script": "printf 'a,b\\n1,x\\n2,\\n3,z\\n' > tmp/s.csv", "file": "tmp/s.csv" })).await;
    assert_eq!(r["output"]["paged"], true, "{r}");
    let page = c.ok("run.rows", json!({ "id": r["id"], "offset": 1, "limit": 5 })).await;
    assert_eq!(page, json!({ "rows": [["2", null], ["3", "z"]], "total": 3 }));
    // A `ref` field with kinds and no options gets the resources of those kinds, by name.
    for n in ["beta", "alpha"] {
        c.ok("page.save", json!({ "target": "new:t.data:src", "changes": { "name": n } })).await;
    }
    let first = c.ok("page.save", json!({ "target": "new:t.data:src", "changes": { "name": "gamma" } })).await;
    let page = c.ok("page.resolve", json!({ "target": first["page"]["target"] })).await;
    let fields = &page["view"][0]["fields"];
    let labels: Vec<&str> = fields[0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
    assert_eq!(labels, ["alpha", "beta", "gamma"], "{page}");
    assert_eq!(fields[1]["kind"], "time");
    assert_eq!(fields[2]["options"], json!([{ "value": "x", "label": "X" }]));
}
