//! Write pipeline (§4) through the protocol, checked against the database itself.

mod common;

use common::*;
use onedesk_protocol::ErrorCode;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

fn db(env: &Env) -> Connection {
    Connection::open_with_flags(env.kernel.db_path(), OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap()
}

fn count(conn: &Connection, sql: &str, p: &str) -> i64 {
    conn.query_row(sql, [p], |r| r.get(0)).unwrap()
}

async fn setup() -> (Env, Client) {
    let env = open(&fixtures());
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

async fn new_item(c: &Client, parent: Option<&str>, text: &str) -> String {
    let target = match parent {
        Some(p) => format!("new:test.alpha:item?parent={p}"),
        None => "new:test.alpha:item".to_string(),
    };
    let r = c.ok("page.save", json!({ "target": target, "changes": { "body.text": text } })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn group(c: &Client, parent: Option<&str>, name: &str) -> String {
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "parent": parent, "name": name })).await;
    g["key"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn pipeline_transaction_history_and_audit_agree() {
    let (env, c) = setup().await;
    let id = new_item(&c, None, "a").await;
    c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "body.text": "b", "name": "N" }, "basis": "1" })).await;
    let conn = db(&env);
    let rev: i64 = count(&conn, "SELECT rev FROM resources WHERE id = ?1", &id);
    assert_eq!(rev, 2);
    assert_eq!(count(&conn, "SELECT count(*) FROM revisions WHERE resource_id = ?1", &id), 2);
    assert_eq!(count(&conn, "SELECT count(*) FROM audit WHERE object = ?1 AND result = 'ok'", &id), 2);
    let (snapshot, fields, actor): (String, String, String) = conn
        .query_row("SELECT snapshot, fields, actor FROM revisions WHERE resource_id = ?1 AND rev = 2", [&id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    let snap: Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!((snap["name"].as_str(), snap["body"]["text"].as_str(), snap["rev"].as_i64()), (Some("N"), Some("b"), Some(2)));
    let fields: Vec<String> = serde_json::from_str(&fields).unwrap();
    assert_eq!(fields, vec!["name", "body.text"]);
    assert_eq!(actor, "user");
}

#[tokio::test(flavor = "multi_thread")]
async fn pipeline_concurrency_is_per_field() {
    let (env, c) = setup().await;
    let id = new_item(&c, None, "a").await;
    let t = format!("resource:{id}");
    // Two editors both based on rev 1: different fields both apply.
    c.ok("page.save", json!({ "target": t, "changes": { "name": "from A" }, "basis": "1" })).await;
    let r = c.ok("page.save", json!({ "target": t, "changes": { "body.text": "from B" }, "basis": "1" })).await;
    assert_eq!(r["page"]["values"]["body.text"], "from B");
    let res = c.ok("resource.get", json!({ "id": id })).await;
    assert_eq!((res["name"].as_str(), res["body"]["text"].as_str()), (Some("from A"), Some("from B")));
    // The same field changed after the basis: conflict, nothing written, refusal audited.
    let e = c.call("page.save", json!({ "target": t, "changes": { "name": "from B" }, "basis": "1" })).await.unwrap_err();
    assert_eq!((e.code, e.params["field"].as_str()), (ErrorCode::Conflict, "name"));
    assert_eq!(c.ok("resource.get", json!({ "id": id })).await["name"], "from A");
    let conn = db(&env);
    assert_eq!(count(&conn, "SELECT count(*) FROM audit WHERE object = ?1 AND result = 'failed:conflict'", &id), 1);
    assert_eq!(count(&conn, "SELECT count(*) FROM revisions WHERE resource_id = ?1", &id), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn pipeline_unchanged_values_record_nothing() {
    let (env, c) = setup().await;
    let id = new_item(&c, None, "same").await;
    let r = c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "body.text": "same", "name": "New item" } })).await;
    assert_eq!(r["page"]["basis"], "1");
    c.ok("tree.move", json!({ "tree": "resources", "key": id, "position": "inside" })).await; // already there
    let conn = db(&env);
    assert_eq!(count(&conn, "SELECT count(*) FROM revisions WHERE resource_id = ?1", &id), 1);
    assert_eq!(count(&conn, "SELECT count(*) FROM audit WHERE object = ?1", &id), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn pipeline_group_delete_is_one_batch() {
    let (env, c) = setup().await;
    let g = group(&c, None, "G").await;
    let sub = group(&c, Some(&g), "Sub").await;
    let a = new_item(&c, Some(&g), "a").await;
    let b = new_item(&c, Some(&sub), "b").await;
    let keep = new_item(&c, None, "keep").await;
    let eff = c.ok("command.execute", json!({ "id": "node.delete", "context": { "tree": "resources", "nodeKey": g } })).await;
    let mut closed: Vec<String> = eff.as_array().unwrap().iter().map(|e| e["target"].as_str().unwrap().to_string()).collect();
    closed.sort();
    let mut expect = vec![format!("resource:{a}"), format!("resource:{b}")];
    expect.sort();
    assert_eq!(closed, expect);
    let conn = db(&env);
    let batches: i64 = conn
        .query_row("SELECT count(DISTINCT delete_batch) FROM resources WHERE deleted_at IS NOT NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(batches, 1);
    let deleted: i64 = conn.query_row("SELECT count(*) FROM resources WHERE deleted_at IS NOT NULL", [], |r| r.get(0)).unwrap();
    assert_eq!(deleted, 4);
    assert_eq!(count(&conn, "SELECT count(*) FROM audit WHERE op = 'resource.delete' AND object = ?1", &g), 1);
    let top = c.ok("tree.children", json!({ "tree": "resources" })).await;
    assert_eq!(top["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(top["nodes"][0]["key"], keep.as_str());
    // History is kept for every row of the batch.
    for id in [&g, &sub, &a, &b] {
        assert_eq!(count(&conn, "SELECT count(*) FROM revisions WHERE resource_id = ?1 AND op = 'delete'", id), 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pipeline_audit_rows_cannot_be_changed_or_removed() {
    let (env, c) = setup().await;
    new_item(&c, None, "a").await;
    let conn = db(&env);
    assert!(conn.execute("UPDATE audit SET actor = 'someone'", []).is_err());
    assert!(conn.execute("DELETE FROM audit", []).is_err());
    let n: i64 = conn.query_row("SELECT count(*) FROM audit WHERE actor = 'user'", [], |r| r.get(0)).unwrap();
    assert!(n >= 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_move_rejects_every_illegal_destination() {
    let (_env, c) = setup().await;
    let g = group(&c, None, "G").await;
    let sub = group(&c, Some(&g), "Sub").await;
    let item = new_item(&c, None, "x").await;
    let mv = |key: &str, target: Option<&str>, pos: &str| {
        json!({ "tree": "resources", "key": key, "target": target, "position": pos })
    };
    let reason = |e: onedesk_protocol::ProtocolError| (e.code, e.params.get("reason").cloned().unwrap_or_default());
    // Into itself, into its own descendant.
    let e = c.call("tree.move", mv(&g, Some(&g), "inside")).await.unwrap_err();
    assert_eq!(reason(e), (ErrorCode::Invalid, "self".into()));
    let e = c.call("tree.move", mv(&g, Some(&sub), "inside")).await.unwrap_err();
    assert_eq!(reason(e), (ErrorCode::Invalid, "descendant".into()));
    // Next to its own child = into itself.
    let e = c.call("tree.move", mv(&g, Some(&sub), "before")).await.unwrap_err();
    assert_eq!(reason(e), (ErrorCode::Invalid, "self".into()));
    let deep = group(&c, Some(&sub), "Deep").await;
    let e = c.call("tree.move", mv(&g, Some(&deep), "after")).await.unwrap_err();
    assert_eq!(reason(e), (ErrorCode::Invalid, "descendant".into()));
    // Into a node whose kind accepts nothing.
    let e = c.call("tree.move", mv(&sub, Some(&item), "inside")).await.unwrap_err();
    assert_eq!(reason(e), (ErrorCode::Invalid, "notAccepted".into()));
    // Unknown target; unknown node; wrong tree; provided tree; missing target for before.
    let e = c.call("tree.move", mv(&item, Some("nope"), "inside")).await.unwrap_err();
    assert_eq!(reason(e), (ErrorCode::Invalid, "targetNotFound".into()));
    assert_eq!(c.call("tree.move", mv("nope", None, "inside")).await.unwrap_err().code, ErrorCode::NotFound);
    let e = c.call("tree.move", json!({ "tree": "test.alpha:disk", "key": item, "position": "inside" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert_eq!(c.call("tree.move", json!({ "tree": "nope", "key": item, "position": "inside" })).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(c.call("tree.move", mv(&item, None, "after")).await.unwrap_err().code, ErrorCode::InvalidParams);
    // A legal move still works afterwards and the order is as asked.
    c.ok("tree.move", mv(&item, Some(&sub), "after")).await;
    let kids = c.ok("tree.children", json!({ "tree": "resources", "parent": g })).await;
    let keys: Vec<&str> = kids["nodes"].as_array().unwrap().iter().map(|n| n["key"].as_str().unwrap()).collect();
    assert_eq!(keys, vec![sub.as_str(), item.as_str()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn new_group_command_picks_unique_default_names() {
    let (_env, c) = setup().await;
    let eff = c.ok("command.execute", json!({ "id": "node.newGroup", "context": { "tree": "resources" } })).await;
    assert_eq!(eff[0]["type"], "reveal");
    assert_eq!(eff[1]["type"], "rename");
    c.ok("command.execute", json!({ "id": "node.newGroup", "context": { "tree": "resources" } })).await;
    c.ok("command.execute", json!({ "id": "node.newGroup", "context": { "tree": "resources", "args": { "name": "Mine" } } })).await;
    let top = c.ok("tree.children", json!({ "tree": "resources" })).await;
    let labels: Vec<&str> = top["nodes"].as_array().unwrap().iter().map(|n| n["label"].as_str().unwrap()).collect();
    assert_eq!(labels, vec!["New group", "New group 2", "Mine"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn grants_are_written_through_the_pipeline_and_validated() {
    let (env, c) = setup().await;
    // Not the temporary root itself: it contains the workspace (round 6 review #5).
    let folder = env.path().join("granted");
    std::fs::create_dir_all(&folder).unwrap();
    let e = c.call("plugin.grantFolder", json!({ "plugin": "test.alpha", "path": "relative/x" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Invalid);
    let e = c.call("plugin.grantFolder", json!({ "plugin": "test.alpha", "path": folder.join("missing").display().to_string() })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Invalid);
    // A plugin that did not ask for `files` cannot be granted folders.
    let e = c.call("plugin.grantFolder", json!({ "plugin": "test.beta", "path": folder.display().to_string() })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Denied);
    assert_eq!(c.call("plugin.grants", json!({ "plugin": "nope" })).await.unwrap_err().code, ErrorCode::NotFound);
    // Stored canonicalized (a path through a symlink is stored as its real path).
    let link = folder.join("lnk");
    std::os::unix::fs::symlink(&folder, &link).unwrap();
    let g = c.ok("plugin.grantFolder", json!({ "plugin": "test.alpha", "path": link.display().to_string() })).await;
    assert_eq!(g["folders"], json!([folder.display().to_string()]));
    c.ok("plugin.grantFolder", json!({ "plugin": "test.alpha", "path": folder.display().to_string() })).await;
    assert_eq!(c.ok("plugin.grants", json!({ "plugin": "test.alpha" })).await["folders"].as_array().unwrap().len(), 1);
    let conn = db(&env);
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM revisions r JOIN resources x ON x.id = r.resource_id
             WHERE x.kind = 'core:plugin-state' AND x.name = 'test.alpha' AND r.fields LIKE '%files.folders%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "one grant, one revision (the state node itself exists since start-up)");
    // The hidden plugin-state tree is not reachable through the generic methods.
    let id: String = conn.query_row("SELECT id FROM resources WHERE kind = 'core:plugin-state' AND name = 'test.alpha'", [], |r| r.get(0)).unwrap();
    assert_eq!(c.ok("resource.get", json!({ "id": id })).await, Value::Null);
    assert_eq!(c.call("resource.delete", json!({ "id": id })).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(c.call("tree.children", json!({ "tree": "core:plugin-state" })).await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_grants_lose_nothing_and_make_one_state_node() {
    let (env, c) = setup().await;
    let c = std::sync::Arc::new(c);
    let mut dirs = vec![];
    for i in 0..8 {
        let d = env.path().join(format!("d{i}"));
        std::fs::create_dir_all(&d).unwrap();
        dirs.push(d.display().to_string());
    }
    let tasks: Vec<_> = dirs
        .iter()
        .map(|d| {
            let (c, d) = (c.clone(), d.clone());
            tokio::spawn(async move { c.ok("plugin.grantFolder", json!({ "plugin": "test.alpha", "path": d })).await })
        })
        .collect();
    for t in tasks {
        t.await.unwrap();
    }
    let g = c.ok("plugin.grants", json!({ "plugin": "test.alpha" })).await;
    assert_eq!(g["folders"].as_array().unwrap().len(), 8);
    let conn = db(&env);
    let n: i64 = conn.query_row("SELECT count(*) FROM resources WHERE kind = 'core:plugin-state' AND name = 'test.alpha'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn page_save_on_a_node_of_a_stored_tree_is_not_found() {
    let (_env, c) = setup().await;
    let e = c.call("page.save", json!({ "target": "node:resources/x", "changes": {} })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}
