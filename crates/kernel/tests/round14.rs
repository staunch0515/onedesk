//! Round 14 (docs/handoff/round14-plan.md, round14-kernel.md): kernel items of `todo.md` that touch
//! daily use. Everything runs in temporary folders.

mod common;

use std::time::Duration;

use common::*;
use onedesk_protocol::ErrorCode;
use rusqlite::Connection;
use serde_json::{json, Value};

fn empty_plugins(tmp: &tempfile::TempDir) -> std::path::PathBuf {
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    root
}

async fn config_root(c: &Client) -> (String, String) {
    let n = &c.ok("tree.children", json!({ "tree": "config" })).await["nodes"][0];
    (n["key"].as_str().unwrap().to_string(), n["label"].as_str().unwrap().to_string())
}

/// Round 13 review #10: the main process renames by rewriting `workspace.json` while the worker
/// runs; `workspace.info` (and `hello`) give the new name without a restart.
#[tokio::test(flavor = "multi_thread")]
async fn workspace_info_follows_a_rename_of_workspace_json() {
    let tmp = tempfile::tempdir().unwrap();
    let root = empty_plugins(&tmp);
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let file = env.path().join("ws").join("workspace.json");
    let mut info: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(c.ok("workspace.info", Value::Null).await["name"], info["name"]);
    info["name"] = json!("Renamed");
    std::fs::write(&file, serde_json::to_vec_pretty(&info).unwrap()).unwrap();
    assert_eq!(c.ok("workspace.info", Value::Null).await["name"], json!("Renamed"));
    let c2 = Client::in_proc(env.kernel.clone());
    assert_eq!(c2.ok("hello", json!({ "protocol": onedesk_protocol::PROTOCOL_VERSION })).await["workspace"]["name"], json!("Renamed"));
    // A broken or emptied file falls back to the name read when the workspace was opened.
    std::fs::write(&file, b"{").unwrap();
    assert!(!c.ok("workspace.info", Value::Null).await["name"].as_str().unwrap().is_empty());
}

/// Round 13 review #9: a workspace whose user only changed settings (no resources of their own) is
/// not new, so an `init-settings.json` put into it is not applied (and still removed).
#[tokio::test(flavor = "multi_thread")]
async fn init_settings_leave_a_workspace_with_only_changed_settings_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let root = empty_plugins(&tmp);
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    c.ok("workspace.setConfig", json!({ "name": "ui.theme", "value": "dark" })).await;
    drop(c);
    let path = env.path();
    let Env { tmp, kernel } = env;
    kernel.shutdown();
    drop(kernel);
    let ws = path.join("ws");
    let snap = json!({ "config": [{ "name": "Other", "params": [{ "name": "ui.theme", "type": "text", "value": "light" }] }], "plugins": [] });
    std::fs::write(ws.join("init-settings.json"), snap.to_string()).unwrap();
    let k = std::sync::Arc::new(onedesk_kernel::Kernel::open(&ws, &path.join("plugins"), test_config()).unwrap());
    assert!(!ws.join("init-settings.json").exists(), "removed even when not applied");
    let c = Client::in_proc(k.clone());
    c.hello().await;
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "ui.theme" })).await, json!("dark"));
    let n: i64 = Connection::open(k.db_path()).unwrap().query_row("SELECT count(*) FROM resources WHERE name = 'Other'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    drop(c);
    k.shutdown();
    drop(tmp);
}

/// todo (round 8 acceptance): a prohibition names its layer by name too, like the network and
/// program refusals (`layerName`), so the interface can say which configuration forbids.
#[tokio::test(flavor = "multi_thread")]
async fn a_readonly_refusal_names_the_layer() {
    let tmp = tempfile::tempdir().unwrap();
    let root = empty_plugins(&tmp);
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let (ws, name) = config_root(&c).await;
    c.ok("params.set", json!({ "node": ws, "name": "protection.readonly", "value": "true", "type": "boolean" })).await;
    let e = c.call("tree.createGroup", json!({ "tree": "resources", "name": "X" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Denied);
    assert_eq!(e.params.get("reason").map(String::as_str), Some("readonly"));
    assert_eq!(e.params.get("layer"), Some(&ws));
    assert_eq!(e.params.get("layerName"), Some(&name));
    assert!(!name.is_empty());
}

/// Round 2 review #14: a cycle in a damaged database (the protocol cannot make one) does not hang
/// deleting, purging or listing environments.
#[tokio::test(flavor = "multi_thread")]
async fn a_parent_cycle_in_the_database_does_not_hang_the_walks() {
    let tmp = tempfile::tempdir().unwrap();
    let root = empty_plugins(&tmp);
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let a = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "A" })).await["key"].as_str().unwrap().to_string();
    let b = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "B", "parent": a })).await["key"].as_str().unwrap().to_string();
    {
        let conn = Connection::open(env.kernel.db_path()).unwrap();
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let moved = conn.execute("UPDATE resources SET parent_id = ?1 WHERE id = ?2", [&b, &a]).unwrap();
        assert_eq!(moved, 1);
    }
    let walks = async {
        let _ = c.call("resource.delete", json!({ "id": a })).await;
        let _ = c.call("resource.purge", json!({ "id": a })).await;
        let _ = c.call("params.envOptions", Value::Null).await;
    };
    tokio::time::timeout(Duration::from_secs(20), walks).await.expect("the walks end");
}
