//! Round 13 (docs/handoff/round13-plan.md §3, §5; D400): `workspace.settingsSnapshot` (only the
//! main process) and `init-settings.json` (applied once to a new workspace, then deleted).
//! The first-version upgrade was dropped (D403). Everything runs in temporary folders.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use rusqlite::Connection;
use serde_json::{json, Value};

/// Generated plugins of these tests.
fn pkg(root: &Path, id: &str, version: &str, contributes: Value, extra: Value, main: &str) -> PathBuf {
    let dir = root.join(id).join(version);
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({ "id": id, "version": version, "apiVersion": "2", "name": id, "icon": "box", "main": "main.js", "contributes": contributes });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(dir.join("main.js"), main).unwrap();
    dir
}

fn db(env: &Env) -> Connection {
    Connection::open(env.kernel.db_path()).unwrap()
}

fn audit(env: &Env, op: &str) -> Vec<(String, String, Value, String)> {
    let conn = db(env);
    let mut st = conn.prepare("SELECT actor, object, summary, result FROM audit WHERE op = ?1 ORDER BY seq").unwrap();
    st.query_map([op], |r| Ok((r.get(0)?, r.get(1)?, serde_json::from_str(&r.get::<_, String>(2)?).unwrap(), r.get(3)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

async fn set_enabled(c: &Client, id: &str, on: bool) {
    let cmd = if on { "plugin.enable" } else { "plugin.disable" };
    c.ok("command.execute", json!({ "id": cmd, "context": { "args": { "plugin": id } } })).await;
}

/* ------------------------------------------------------------------ settings snapshot (D400) */

#[tokio::test(flavor = "multi_thread")]
async fn the_settings_snapshot_answers_only_the_main_process() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    pkg(&root, "t.one", "1.0.0", json!({}), json!({}), "export default { activate() {} };");
    pkg(&root, "t.two", "1.0.0", json!({}), json!({}), "export default { activate() {} };");
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    c.ok("workspace.setConfig", json!({ "name": "ui.theme", "value": "dark" })).await;
    // Review #8: a secret parameter (a secret's name) is not copied.
    c.ok("secrets.set", json!({ "name": "api-key", "value": "s3cr3t" })).await;
    let root = c.ok("tree.children", json!({ "tree": "config" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    c.ok("params.set", json!({ "node": root, "name": "x.token", "value": "api-key", "type": "secret" })).await;
    set_enabled(&c, "t.two", false).await;
    let refused = c.call_as(Some("window-1"), "workspace.settingsSnapshot", json!({})).await.unwrap_err();
    assert_eq!(serde_json::to_value(refused.code).unwrap(), "denied");
    assert_eq!(refused.params.get("reason").map(String::as_str), Some("mainProcessOnly"));
    let s = c.call_as(None, "workspace.settingsSnapshot", json!({})).await.unwrap();
    assert_eq!(s["config"][0]["name"], "Workspace");
    assert_eq!(s["config"][0]["params"], json!([{ "name": "ui.theme", "type": "text", "value": "dark" }]));
    assert!(s["plugins"].as_array().unwrap().contains(&json!({ "plugin": "t.two", "enabled": false })), "{s}");
    assert!(s["plugins"].as_array().unwrap().contains(&json!({ "plugin": "t.one", "enabled": true })), "{s}");
}

#[tokio::test(flavor = "multi_thread")]
async fn init_settings_are_applied_once_to_a_new_workspace_and_the_file_is_deleted() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    pkg(&root, "t.one", "1.0.0", json!({}), json!({}), "export default { activate() {} };");
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let snap = json!({
        "config": [{ "name": "Team", "description": "copied", "params": [
            { "name": "ui.theme", "type": "text", "value": "light" },
            { "name": "x.ref", "type": "ref", "value": "someone-elses-id" },
            { "name": "x.token", "type": "secret", "value": "api-key" }
        ], "children": [{ "name": "Child", "params": [{ "name": "ui.language", "type": "text", "value": "ja-JP" }] }] }],
        "plugins": [{ "plugin": "t.one", "enabled": false }]
    });
    std::fs::write(ws.join("init-settings.json"), snap.to_string()).unwrap();
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    assert!(!ws.join("init-settings.json").exists(), "deleted after use");
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "ui.theme" })).await, json!("light"));
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "ui.language" })).await, json!("ja-JP"));
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "x.ref" })).await, Value::Null, "references are not copied");
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "x.token" })).await, Value::Null, "secret parameters are not copied");
    assert_eq!(c.ok("plugin.get", json!({ "plugin": "t.one" })).await["enabled"], json!(false));
    let conn = db(&env);
    let roots: Vec<String> = {
        let mut st = conn.prepare("SELECT name FROM resources WHERE kind = 'core:config' AND parent_id IS NULL").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(roots, vec!["Team".to_string()], "the default root took the snapshot's place");
    assert_eq!(audit(&env, "workspace.initSettings").len(), 1);
    // Once the user made something, a file put back is not applied (and is still removed).
    c.ok("tree.createGroup", json!({ "tree": "resources", "name": "Mine" })).await;
    drop(c);
    let path = env.path();
    let Env { tmp, kernel } = env;
    kernel.shutdown();
    drop(kernel);
    std::fs::write(path.join("ws").join("init-settings.json"), json!({ "config": [{ "name": "Again", "params": [] }] }).to_string()).unwrap();
    let k = onedesk_kernel::Kernel::open(&path.join("ws"), &path.join("plugins"), test_config()).unwrap();
    assert!(!path.join("ws").join("init-settings.json").exists());
    let n: i64 = Connection::open(k.db_path()).unwrap().query_row("SELECT count(*) FROM resources WHERE name = 'Again'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    k.shutdown();
    drop(tmp);
}
