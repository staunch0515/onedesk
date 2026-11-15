//! Round 2 (docs/handoff/round2-plan.md §8): parameters and environments, configuration,
//! history and restore, deleted, favorites, search, audit view.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use onedesk_protocol::ErrorCode;
use rusqlite::Connection;
use serde_json::{json, Value};

async fn setup() -> (Env, Client) {
    let env = open(&fixtures());
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

async fn root(c: &Client, tree: &str) -> String {
    let n = c.ok("tree.children", json!({ "tree": tree })).await;
    n["nodes"][0]["key"].as_str().unwrap().to_string()
}

async fn new_env(c: &Client, parent: Option<&str>, name: &str) -> String {
    let eff = c.ok("command.execute", json!({ "id": "env.newChild", "context": { "tree": "env", "nodeKey": parent, "args": { "name": name } } })).await;
    eff[0]["key"].as_str().unwrap().to_string()
}

async fn set(c: &Client, node: &str, name: &str, value: &str) {
    c.ok("params.set", json!({ "node": node, "name": name, "value": value })).await;
}

fn param<'a>(view: &'a Value, name: &str) -> &'a Value {
    view["params"].as_array().unwrap().iter().find(|p| p["name"] == name).unwrap_or_else(|| panic!("no param {name}"))
}

async fn item(c: &Client, name: &str, text: &str) -> String {
    let r = c.ok("page.save", json!({ "target": "new:test.alpha:item", "changes": { "name": name, "body.text": text } })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

fn db(env: &Env) -> Connection {
    Connection::open(env.kernel.db_path()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn kernel_trees_and_default_nodes_exist() {
    let (_env, c) = setup().await;
    let trees = c.ok("tree.list", Value::Null).await;
    let ids: Vec<&str> = trees.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    for t in ["resources", "env", "config", "favorites", "deleted"] {
        assert!(ids.contains(&t), "{t} in {ids:?}");
    }
    let envs = c.ok("tree.children", json!({ "tree": "env" })).await;
    assert_eq!(envs["nodes"][0]["label"], "Default");
    assert_eq!(envs["nodes"][0]["kind"], "core:env");
    let cfg = c.ok("tree.children", json!({ "tree": "config" })).await;
    assert_eq!(cfg["nodes"][0]["label"], "Workspace");
    // No groups in parameter trees; environments cannot leave their tree.
    let e = c.call("tree.createGroup", json!({ "tree": "env", "name": "G" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Invalid);
    let def = root(&c, "env").await;
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "G" })).await;
    let e = c.call("tree.move", json!({ "tree": "env", "key": def, "target": g["key"], "position": "inside" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Invalid);
    // Pages: environment → shell page; config → generated autosave form; core pages.
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{def}") })).await;
    assert_eq!((p["page"].as_str(), p["hasInfo"].as_bool()), (Some("env"), Some(true)));
    let cfg_id = root(&c, "config").await;
    set(&c, &cfg_id, "ui.theme", "dark").await;
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{cfg_id}") })).await;
    assert_eq!(p["page"], "view");
    assert!(p["autosave"].as_bool().unwrap());
    assert_eq!(p["view"][0]["fields"][0]["bind"], "params.ui.theme");
    assert_eq!(p["values"]["params.ui.theme"], "dark");
    assert_eq!(c.ok("page.resolve", json!({ "target": "core:audit" })).await["page"], "audit");
    assert_eq!(c.ok("page.resolve", json!({ "target": "core:deleted" })).await["page"], "deleted");
    assert_eq!(c.ok("command.execute", json!({ "id": "open.audit" })).await[0]["target"], "core:audit");
    // Options list the environment tree by depth.
    let child = new_env(&c, Some(&def), "Child").await;
    let opts = c.ok("params.envOptions", Value::Null).await;
    assert_eq!(opts, json!([{ "id": def, "name": "Default", "depth": 0 }, { "id": child, "name": "Child", "depth": 1 }]));
}

#[tokio::test(flavor = "multi_thread")]
async fn params_inherit_along_the_parent_chain_with_source_layers() {
    let (_env, c) = setup().await;
    let def = root(&c, "env").await;
    let dev = new_env(&c, Some(&def), "Dev").await;
    let local = new_env(&c, Some(&dev), "Local").await;
    set(&c, &def, "host", "prod.example").await;
    set(&c, &dev, "port", "8080").await;
    let v = c.ok("params.env", json!({ "envId": local })).await;
    assert_eq!(v["chain"].as_array().unwrap().iter().map(|n| n["name"].as_str().unwrap()).collect::<Vec<_>>(), vec!["Default", "Dev", "Local"]);
    let host = param(&v, "host");
    assert_eq!((host["value"].as_str(), host["sourceName"].as_str(), host["own"].as_bool()), (Some("prod.example"), Some("Default"), Some(false)));
    let layers: Vec<(Value, bool)> = host["layers"].as_array().unwrap().iter().map(|l| (l["value"].clone(), l["effective"].as_bool().unwrap())).collect();
    assert_eq!(layers, vec![(json!("prod.example"), true), (Value::Null, false)]);
    assert_eq!(param(&v, "port")["sourceName"], "Dev");
    let r = c.ok("params.resolve", json!({ "envId": local, "name": "host" })).await;
    assert_eq!((r["found"].as_bool(), r["value"].as_str(), r["sourceName"].as_str()), (Some(true), Some("prod.example"), Some("Default")));
    assert_eq!(c.ok("params.resolve", json!({ "name": "host" })).await["found"], false);
    assert_eq!(c.ok("params.resolve", json!({ "envId": local, "name": "nope" })).await["found"], false);
    // Override, then unset: the inherited value is back; unset at the only layer removes it.
    set(&c, &local, "host", "localhost").await;
    let v = c.ok("params.env", json!({ "envId": local })).await;
    let host = param(&v, "host");
    assert_eq!((host["value"].as_str(), host["own"].as_bool(), host["inherited"]["value"].as_str()), (Some("localhost"), Some(true), Some("prod.example")));
    c.ok("params.unset", json!({ "node": local, "name": "host" })).await;
    assert_eq!(param(&c.ok("params.env", json!({ "envId": local })).await, "host")["value"], "prod.example");
    c.ok("params.unset", json!({ "node": dev, "name": "port" })).await;
    let v = c.ok("params.env", json!({ "envId": local })).await;
    assert!(v["params"].as_array().unwrap().iter().all(|p| p["name"] != "port"));
    assert_eq!(c.call("params.set", json!({ "node": "nope", "name": "x", "value": "1" })).await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test(flavor = "multi_thread")]
async fn override_is_marked_when_upstream_changes_and_acknowledge_clears_it() {
    let (_env, c) = setup().await;
    let def = root(&c, "env").await;
    let a = new_env(&c, Some(&def), "A").await;
    let b = new_env(&c, Some(&def), "B").await;
    let child = new_env(&c, Some(&a), "Child").await;
    set(&c, &a, "host", "a-host").await;
    set(&c, &b, "host", "b-host").await;
    set(&c, &child, "host", "mine").await;
    let changed = |v: &Value| param(v, "host").get("changedUpstream").cloned();
    assert_eq!(changed(&c.ok("params.env", json!({ "envId": child })).await), None);
    // The parent changes another parameter: not marked.
    set(&c, &a, "port", "1").await;
    assert_eq!(changed(&c.ok("params.env", json!({ "envId": child })).await), None);
    // The parent changes this one: marked with was/now.
    set(&c, &a, "host", "a-host-2").await;
    assert_eq!(changed(&c.ok("params.env", json!({ "envId": child })).await), Some(json!({ "was": "a-host", "now": "a-host-2" })));
    c.ok("params.acknowledge", json!({ "node": child, "name": "host" })).await;
    assert_eq!(changed(&c.ok("params.env", json!({ "envId": child })).await), None);
    // Moving under another parent re-reads the chain.
    c.ok("tree.move", json!({ "tree": "env", "key": child, "target": b, "position": "inside" })).await;
    assert_eq!(changed(&c.ok("params.env", json!({ "envId": child })).await), Some(json!({ "was": "a-host-2", "now": "b-host" })));
    // Editing the override again keeps the recorded basis (only acknowledge clears it).
    set(&c, &child, "host", "mine-2").await;
    assert!(changed(&c.ok("params.env", json!({ "envId": child })).await).is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn config_names_repeat_only_along_one_ancestor_line() {
    let (_env, c) = setup().await;
    let ws = root(&c, "config").await;
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "ui.language" })).await, Value::Null);
    c.ok("workspace.setConfig", json!({ "name": "ui.language", "value": "zh-CN" })).await;
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "ui.language" })).await, "zh-CN");
    let ev = c.event(|e| e.topic == "config").await;
    assert_eq!(ev.topic, "config");
    let a = c.ok("command.execute", json!({ "id": "config.newChild", "context": { "tree": "config", "nodeKey": ws, "args": { "name": "A" } } })).await[0]["key"].as_str().unwrap().to_string();
    let b = c.ok("command.execute", json!({ "id": "config.newChild", "context": { "tree": "config", "nodeKey": ws, "args": { "name": "B" } } })).await[0]["key"].as_str().unwrap().to_string();
    // Child overrides parent: allowed (same ancestor line), and getConfig gives the deepest.
    set(&c, &a, "ui.language", "en-US").await;
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "ui.language" })).await, "en-US");
    // setConfig changes the node that already holds the name.
    c.ok("workspace.setConfig", json!({ "name": "ui.language", "value": "fr-FR" })).await;
    let av = c.ok("page.resolve", json!({ "target": format!("resource:{a}") })).await;
    assert_eq!(av["values"]["params.ui.language"], "fr-FR");
    // A sibling may not define the same name.
    let e = c.call("params.set", json!({ "node": b, "name": "ui.language", "value": "x" })).await.unwrap_err();
    assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::Invalid, "duplicateName"));
    set(&c, &b, "ui.density", "compact").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn param_saves_conflict_only_on_the_same_name() {
    let (_env, c) = setup().await;
    let ws = root(&c, "config").await;
    let t = format!("resource:{ws}");
    let basis = c.ok("page.resolve", json!({ "target": t })).await["basis"].clone();
    c.ok("page.save", json!({ "target": t, "changes": { "params.a": "1" }, "basis": basis })).await;
    c.ok("page.save", json!({ "target": t, "changes": { "params.b": "2" }, "basis": basis })).await;
    let e = c.call("page.save", json!({ "target": t, "changes": { "params.a": "3" }, "basis": basis })).await.unwrap_err();
    assert_eq!((e.code, e.params["field"].as_str()), (ErrorCode::Conflict, "params.a"));
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "a" })).await, "1");
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "b" })).await, "2");
}

#[tokio::test(flavor = "multi_thread")]
async fn history_is_by_field_newest_first_and_restore_is_a_new_revision() {
    let (env, c) = setup().await;
    let id = item(&c, "First", "one").await;
    let t = format!("resource:{id}");
    c.ok("page.save", json!({ "target": t, "changes": { "name": "Second" } })).await;
    c.ok("page.save", json!({ "target": t, "changes": { "body.text": "two", "description": "d" } })).await;
    let h = c.ok("resource.history", json!({ "id": id })).await;
    let rows: Vec<(String, String, String, String)> = h
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["op"].as_str().unwrap().into(), e["field"].as_str().unwrap().into(), e["before"].as_str().unwrap().into(), e["after"].as_str().unwrap().into()))
        .collect();
    assert_eq!(rows[0].0, "update");
    assert_eq!(&rows[..3], &[
        ("update".to_string(), "description".to_string(), "".to_string(), "d".to_string()),
        ("update".into(), "body.text".into(), "one".into(), "two".into()),
        ("update".into(), "name".into(), "First".into(), "Second".into()),
    ]);
    assert!(rows[3..].iter().all(|r| r.0 == "create"));
    assert!(!rows.iter().any(|r| r.1 == "pos"));
    let name_entry = h.as_array().unwrap().iter().find(|e| e["field"] == "name" && e["op"] == "update").unwrap()["id"].clone();
    c.ok("resource.restore", json!({ "id": id, "entryId": name_entry })).await;
    let r = c.ok("resource.get", json!({ "id": id })).await;
    assert_eq!((r["name"].as_str(), r["body"]["text"].as_str(), r["rev"].as_i64()), (Some("First"), Some("two"), Some(4)));
    let h = c.ok("resource.history", json!({ "id": id })).await;
    assert_eq!((h[0]["op"].as_str(), h[0]["field"].as_str(), h[0]["restoredFrom"].clone()), (Some("restore"), Some("name"), name_entry));
    // Parameters and moves have history too.
    let ws = root(&c, "config").await;
    set(&c, &ws, "x", "1").await;
    set(&c, &ws, "x", "2").await;
    let h = c.ok("resource.history", json!({ "id": ws })).await;
    assert_eq!((h[0]["field"].as_str(), h[0]["before"].as_str(), h[0]["after"].as_str()), (Some("params.x"), Some("1"), Some("2")));
    c.ok("resource.restore", json!({ "id": ws, "entryId": h[0]["id"] })).await;
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "x" })).await, "1");
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "G" })).await;
    c.ok("tree.move", json!({ "tree": "resources", "key": id, "target": g["key"], "position": "inside" })).await;
    let h = c.ok("resource.history", json!({ "id": id })).await;
    assert_eq!((h[0]["op"].as_str(), h[0]["field"].as_str()), (Some("move"), Some("parent")));
    c.ok("resource.restore", json!({ "id": id, "entryId": h[0]["id"] })).await;
    assert!(c.ok("resource.get", json!({ "id": id })).await.get("parentId").is_none());
    let n: i64 = db(&env).query_row("SELECT count(*) FROM revisions WHERE resource_id = ?1 AND op = 'restore'", [&id], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
    assert_eq!(c.call("resource.restore", json!({ "id": id, "entryId": "99:name" })).await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test(flavor = "multi_thread")]
async fn undelete_restores_the_whole_batch_and_falls_back_to_the_root() {
    let (_env, c) = setup().await;
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "G" })).await["key"].as_str().unwrap().to_string();
    let sub = c.ok("tree.createGroup", json!({ "tree": "resources", "parent": g, "name": "Sub" })).await["key"].as_str().unwrap().to_string();
    let a = c.ok("page.save", json!({ "target": format!("new:test.alpha:item?parent={sub}"), "changes": { "name": "A" } })).await["page"]["resourceId"].as_str().unwrap().to_string();
    // Batch 1: Sub with A. Batch 2: G.
    c.ok("resource.delete", json!({ "id": sub })).await;
    c.ok("resource.delete", json!({ "id": g })).await;
    let del = c.ok("resource.listDeleted", Value::Null).await;
    let names: Vec<&str> = del.as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["G", "Sub"], "only batch tops, newest first");
    let tree = c.ok("tree.children", json!({ "tree": "deleted" })).await;
    assert_eq!(tree["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(tree["nodes"][0]["draggable"], false);
    // Restoring through an inner row brings the whole batch; G is still deleted → Sub goes to the root.
    c.ok("resource.undelete", json!({ "id": a })).await;
    let top = c.ok("tree.children", json!({ "tree": "resources" })).await;
    let labels: Vec<&str> = top["nodes"].as_array().unwrap().iter().map(|n| n["label"].as_str().unwrap()).collect();
    assert_eq!(labels, vec!["Sub"]);
    let kids = c.ok("tree.children", json!({ "tree": "resources", "parent": sub })).await;
    assert_eq!(kids["nodes"][0]["label"], "A");
    c.ok("command.execute", json!({ "id": "deleted.restore", "context": { "tree": "deleted", "nodeKey": g } })).await;
    assert_eq!(c.ok("resource.listDeleted", Value::Null).await, json!([]));
    assert_eq!(c.call("resource.undelete", json!({ "id": g })).await.unwrap_err().code, ErrorCode::Invalid);
}

#[tokio::test(flavor = "multi_thread")]
async fn purge_leaves_no_name_or_content_anywhere_in_the_database() {
    let (env, c) = setup().await;
    let id = item(&c, "Zebraquux", "secretcontent").await;
    c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "body.text": "secretcontent2" } })).await;
    assert_eq!(c.ok("search.query", json!({ "text": "zebraquux" })).await.as_array().unwrap().len(), 1);
    assert_eq!(c.call("resource.purge", json!({ "id": id })).await.unwrap_err().code, ErrorCode::Invalid, "only deleted ones");
    c.ok("resource.delete", json!({ "id": id })).await;
    // The command asks first.
    let eff = c.ok("command.execute", json!({ "id": "deleted.purge", "context": { "tree": "deleted", "nodeKey": id } })).await;
    assert_eq!(eff[0]["type"], "confirm");
    c.ok("command.execute", json!({ "id": "deleted.purge", "context": { "tree": "deleted", "nodeKey": id, "args": { "confirmed": true } } })).await;
    assert_eq!(c.ok("resource.listDeleted", Value::Null).await, json!([]));
    assert_eq!(c.ok("search.query", json!({ "text": "zebraquux" })).await, json!([]));
    let conn = db(&env);
    let tables: Vec<String> = {
        let mut st = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    for t in &tables {
        let cols: Vec<String> = {
            let mut st = conn.prepare(&format!("PRAGMA table_info(\"{t}\")")).unwrap();
            st.query_map([], |r| r.get(1)).unwrap().map(|r| r.unwrap()).collect()
        };
        for col in cols {
            for needle in ["Zebraquux", "secretcontent"] {
                let n: i64 = conn
                    .query_row(&format!("SELECT count(*) FROM \"{t}\" WHERE instr(CAST(\"{col}\" AS BLOB), CAST(?1 AS BLOB)) > 0"), [needle], |r| r.get(0))
                    .unwrap();
                assert_eq!(n, 0, "{needle} found in {t}.{col}");
            }
        }
    }
    let n: i64 = conn.query_row("SELECT count(*) FROM audit WHERE op = 'resource.purge' AND object = ?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn favorites_list_and_leave_no_history() {
    let (env, c) = setup().await;
    let id = item(&c, "Fav", "x").await;
    let conn = db(&env);
    let count = |sql: &str| -> i64 { conn.query_row(sql, [&id], |r| r.get(0)).unwrap() };
    let (revs, audits) = (count("SELECT count(*) FROM revisions WHERE resource_id = ?1"), count("SELECT count(*) FROM audit WHERE object = ?1"));
    c.ok("command.execute", json!({ "id": "node.favorite", "context": { "tree": "resources", "nodeKey": id } })).await;
    c.event(|e| e.topic == "tree:favorites").await;
    let favs = c.ok("tree.children", json!({ "tree": "favorites" })).await;
    assert_eq!(favs["nodes"][0]["key"], id.as_str());
    assert_eq!(favs["nodes"][0]["target"], format!("resource:{id}"));
    assert!(c.ok("resource.get", json!({ "id": id })).await["favorite"].as_bool().unwrap());
    c.ok("resource.setFavorite", json!({ "id": id, "favorite": false })).await;
    assert_eq!(c.ok("tree.children", json!({ "tree": "favorites" })).await["nodes"], json!([]));
    assert_eq!(count("SELECT count(*) FROM revisions WHERE resource_id = ?1"), revs);
    assert_eq!(count("SELECT count(*) FROM audit WHERE object = ?1"), audits);
}

#[tokio::test(flavor = "multi_thread")]
async fn search_matches_all_words_short_words_and_ranks() {
    let (_env, c) = setup().await;
    let a = item(&c, "Alpha report", "quarterly numbers").await;
    let b = item(&c, "Notes", "alpha report draft").await;
    let cn = item(&c, "部署测试环境", "").await;
    let titles = |v: &Value| v.as_array().unwrap().iter().map(|h| h["title"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    // Every word must match; name hits first.
    let r = c.ok("search.query", json!({ "text": "alpha report" })).await;
    assert_eq!(titles(&r), vec!["Alpha report", "Notes"]);
    assert_eq!(titles(&c.ok("search.query", json!({ "text": "alpha quarterly" })).await), vec!["Alpha report"]);
    assert_eq!(c.ok("search.query", json!({ "text": "alpha nothing" })).await, json!([]));
    // Two-character Chinese word: substring.
    assert_eq!(titles(&c.ok("search.query", json!({ "text": "测试" })).await), vec!["部署测试环境"]);
    assert_eq!(r[0]["target"], format!("resource:{a}"));
    // Favorite beats non-favorite; recent use beats older (both only body hits).
    let c1 = item(&c, "One", "shared word").await;
    let c2 = item(&c, "Two", "shared word").await;
    c.ok("resource.setFavorite", json!({ "id": c2, "favorite": true })).await;
    assert_eq!(titles(&c.ok("search.query", json!({ "text": "shared" })).await), vec!["Two", "One"]);
    c.ok("resource.setFavorite", json!({ "id": c2, "favorite": false })).await;
    c.ok("page.resolve", json!({ "target": format!("resource:{c2}") })).await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    c.ok("page.resolve", json!({ "target": format!("resource:{c1}") })).await;
    assert_eq!(titles(&c.ok("search.query", json!({ "text": "shared" })).await), vec!["One", "Two"]);
    // Deleted ones are not found; neither is the hidden plugin-state tree.
    c.ok("resource.delete", json!({ "id": b })).await;
    assert_eq!(titles(&c.ok("search.query", json!({ "text": "alpha" })).await), vec!["Alpha report"]);
    let dir = std::fs::canonicalize(_env.tmp.path()).unwrap();
    c.ok("plugin.grantFolder", json!({ "plugin": "test.alpha", "path": dir.display().to_string() })).await;
    assert_eq!(c.ok("search.query", json!({ "text": "test.alpha" })).await, json!([]));
    // Kind filter.
    assert_eq!(c.ok("search.query", json!({ "text": "alpha", "kind": "core:group" })).await, json!([]));
    let _ = cn;
}

#[tokio::test(flavor = "multi_thread")]
async fn search_over_ten_thousand_resources_is_fast() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    {
        let k = onedesk_kernel::Kernel::open(&ws, &fixtures(), test_config()).unwrap();
        k.shutdown();
    }
    {
        // Bulk rows straight into the table, then let the kernel rebuild the index on open.
        let mut conn = Connection::open(ws.join("workspace.db")).unwrap();
        let tx = conn.transaction().unwrap();
        for i in 0..10_000 {
            tx.execute(
                "INSERT INTO resources (id, kind, tree, name, body, rev, created_at, created_by, updated_at, updated_by, pos)
                 VALUES (?1, 'test.alpha:item', 'resources', ?2, ?3, 1, 0, 'user', 0, 'user', ?4)",
                rusqlite::params![format!("r{i}"), format!("Item {i} 报表"), format!("{{\"text\":\"body number {i} lorem ipsum\"}}"), i],
            )
            .unwrap();
        }
        tx.execute("DELETE FROM meta WHERE key = 'search_built'", []).unwrap();
        tx.commit().unwrap();
    }
    let kernel = Arc::new(onedesk_kernel::Kernel::open(&ws, &fixtures(), test_config()).unwrap());
    let c = Client::in_proc(kernel.clone());
    c.hello().await;
    let limit = if cfg!(debug_assertions) { Duration::from_millis(2000) } else { Duration::from_millis(200) };
    for q in ["number 4242", "lorem ipsum", "报表", "Item 99"] {
        let t = Instant::now();
        let r = c.ok("search.query", json!({ "text": q })).await;
        let took = t.elapsed();
        eprintln!("search {q:?}: {} hits in {took:?}", r.as_array().unwrap().len());
        if r.as_array().unwrap().is_empty() {
            let conn = Connection::open(ws.join("workspace.db")).unwrap();
            let n: i64 = conn.query_row("SELECT count(*) FROM search", [], |r| r.get(0)).unwrap();
            let t: String = conn.query_row("SELECT text FROM search WHERE id = 'r4242'", [], |r| r.get(0)).unwrap_or_default();
            panic!("{q}: no hits; search rows {n}; r4242 text {t:?}");
        }
        assert!(took < limit, "{q} took {took:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_list_filters_and_facets() {
    let (_env, c) = setup().await;
    let id = item(&c, "Audited", "x").await;
    c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "name": "Audited 2" } })).await;
    c.probe("test.alpha", "files.roots", json!([])).await; // no grant yet → roots is fine (empty)
    c.probe("test.beta", "files.roots", json!([])).await; // refused
    let all = c.ok("audit.list", json!({})).await;
    assert!(all.as_array().unwrap().len() >= 4);
    assert!(all[0]["id"].as_str().unwrap().parse::<i64>().unwrap() > all[1]["id"].as_str().unwrap().parse::<i64>().unwrap());
    let upd = c.ok("audit.list", json!({ "operation": "resource.update" })).await;
    assert!(upd.as_array().unwrap().iter().all(|r| r["operation"] == "resource.update"));
    assert!(upd.as_array().unwrap().iter().any(|r| r["target"] == "Audited 2"), "target shows the current name");
    let denied = c.ok("audit.list", json!({ "result": "denied" })).await;
    assert_eq!(denied.as_array().unwrap().len(), 1);
    assert_eq!((denied[0]["source"].as_str(), denied[0]["actor"].as_str()), (Some("plugin"), Some("plugin:test.beta@0.1.0")));
    let by_actor = c.ok("audit.list", json!({ "actor": "core" })).await;
    assert!(by_actor.as_array().unwrap().iter().all(|r| r["source"] == "core"));
    assert!(!by_actor.as_array().unwrap().is_empty(), "startup nodes were created by core");
    assert_eq!(c.ok("audit.list", json!({ "text": "files.roots" })).await.as_array().unwrap().len(), 1);
    assert_eq!(c.ok("audit.list", json!({ "limit": 2 })).await.as_array().unwrap().len(), 2);
    assert_eq!(c.ok("audit.list", json!({ "sinceMs": 60_000 })).await.as_array().unwrap().len(), all.as_array().unwrap().len());
    let f = c.ok("audit.facets", Value::Null).await;
    assert!(f["actors"].as_array().unwrap().contains(&json!("user")));
    assert!(f["operations"].as_array().unwrap().contains(&json!("resource.update")));
}

/* ------------------------------------------------------------------ after the round-2 review */

async fn cfg_child(c: &Client, parent: &str, name: &str) -> String {
    let eff = c.ok("command.execute", json!({ "id": "config.newChild", "context": { "tree": "config", "nodeKey": parent, "args": { "name": name } } })).await;
    eff[0]["key"].as_str().unwrap().to_string()
}

fn reason(e: &onedesk_protocol::ProtocolError) -> (ErrorCode, String) {
    (e.code, e.params.get("reason").cloned().unwrap_or_default())
}

#[tokio::test(flavor = "multi_thread")]
async fn review1_secret_parameters_are_refused() {
    let (env, c) = setup().await;
    let def = root(&c, "env").await;
    let e = c.call("params.set", json!({ "node": def, "name": "token", "value": "s3cr3t-value", "type": "secret" })).await.unwrap_err();
    assert_eq!(reason(&e), (ErrorCode::Invalid, "secretUnsupported".into()));
    let n: i64 = db(&env).query_row("SELECT count(*) FROM resources WHERE body LIKE '%s3cr3t-value%'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn review2_config_same_name_rule_cannot_be_bypassed() {
    let (_env, c) = setup().await;
    let ws = root(&c, "config").await;
    let a = cfg_child(&c, &ws, "A").await;
    let b = cfg_child(&c, &ws, "B").await;
    set(&c, &a, "dup", "1").await;
    let dup = |e: onedesk_protocol::ProtocolError| assert_eq!(reason(&e), (ErrorCode::Invalid, "duplicateName".into()));
    // 1. Replacing the whole table through `body.params`.
    let e = c
        .call("page.save", json!({ "target": format!("resource:{b}"), "changes": { "body.params": { "dup": { "type": "text", "value": "2" } } } }))
        .await
        .unwrap_err();
    assert_eq!(reason(&e), (ErrorCode::Invalid, "reservedField".into()));
    // 2. Moving a holder onto another line: C (under A, allowed) moved under B.
    let cc = cfg_child(&c, &a, "C").await;
    set(&c, &cc, "dup", "child overrides").await;
    dup(c.call("tree.move", json!({ "tree": "config", "key": cc, "target": b, "position": "inside" })).await.unwrap_err());
    assert_eq!(c.ok("resource.get", json!({ "id": cc })).await["parentId"], a.as_str(), "the move was rolled back");
    // 3. Undeleting a holder after a sibling took the name.
    let d = cfg_child(&c, &ws, "D").await;
    set(&c, &d, "dup2", "d").await;
    c.ok("resource.delete", json!({ "id": d })).await;
    set(&c, &b, "dup2", "b").await;
    dup(c.call("resource.undelete", json!({ "id": d })).await.unwrap_err());
    assert_eq!(c.ok("resource.listDeleted", Value::Null).await[0]["id"], d.as_str());
    // 4. Restoring a parameter from history after a sibling took the name.
    let f = cfg_child(&c, &ws, "F").await;
    set(&c, &f, "dup3", "f").await;
    c.ok("params.unset", json!({ "node": f, "name": "dup3" })).await;
    set(&c, &b, "dup3", "b").await;
    let h = c.ok("resource.history", json!({ "id": f })).await;
    assert_eq!((h[0]["field"].as_str(), h[0]["before"].as_str()), (Some("params.dup3"), Some("f")));
    dup(c.call("resource.restore", json!({ "id": f, "entryId": h[0]["id"] })).await.unwrap_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn review3_params_set_with_basis_conflicts_on_the_same_name_only() {
    let (_env, c) = setup().await;
    let def = root(&c, "env").await;
    let rev = c.ok("params.env", json!({ "envId": def })).await["rev"].as_i64().unwrap();
    c.ok("params.set", json!({ "node": def, "name": "a", "value": "1", "basis": rev })).await;
    c.ok("params.set", json!({ "node": def, "name": "b", "value": "2", "basis": rev })).await;
    let e = c.call("params.set", json!({ "node": def, "name": "a", "value": "3", "basis": rev })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    let e = c.call("params.unset", json!({ "node": def, "name": "b", "basis": rev })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    let v = c.ok("params.env", json!({ "envId": def })).await;
    assert_eq!((param(&v, "a")["value"].as_str(), param(&v, "b")["value"].as_str()), (Some("1"), Some("2")));
}

#[tokio::test(flavor = "multi_thread")]
async fn review4_purge_leaves_descendants_of_another_batch() {
    let (_env, c) = setup().await;
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "G" })).await["key"].as_str().unwrap().to_string();
    let child = c.ok("page.save", json!({ "target": format!("new:test.alpha:item?parent={g}"), "changes": { "name": "Child" } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    c.ok("resource.delete", json!({ "id": child })).await; // batch 1
    c.ok("resource.delete", json!({ "id": g })).await; // batch 2
    c.ok("resource.purge", json!({ "id": g })).await;
    let del = c.ok("resource.listDeleted", Value::Null).await;
    assert_eq!(del.as_array().unwrap().len(), 1);
    assert_eq!(del[0]["id"], child.as_str());
    // Its parent is gone: restoring puts it at the top level.
    c.ok("resource.undelete", json!({ "id": child })).await;
    assert_eq!(c.ok("tree.children", json!({ "tree": "resources" })).await["nodes"][0]["key"], child.as_str());
}

#[tokio::test(flavor = "multi_thread")]
async fn review5_13_audit_has_param_operations_but_no_param_names() {
    let (env, c) = setup().await;
    let ws = root(&c, "config").await;
    let a = cfg_child(&c, &ws, "A").await;
    let b = cfg_child(&c, &ws, "B").await;
    set(&c, &a, "privatename", "v").await;
    c.ok("params.acknowledge", json!({ "node": a, "name": "privatename" })).await;
    c.call("params.set", json!({ "node": b, "name": "privatename", "value": "x" })).await.unwrap_err();
    c.ok("params.unset", json!({ "node": a, "name": "privatename" })).await;
    let conn = db(&env);
    let n: i64 = conn.query_row("SELECT count(*) FROM audit WHERE summary LIKE '%privatename%' OR object LIKE '%privatename%'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    let ops: Vec<String> = {
        let mut st = conn.prepare("SELECT op || ':' || result FROM audit WHERE object IN (?1, ?2) AND op LIKE 'params.%' ORDER BY seq").unwrap();
        st.query_map([&a, &b], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(ops, vec!["params.set:ok", "params.set:failed:invalid", "params.unset:ok"], "acknowledge without change records nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn review8_set_config_recreates_a_deleted_root() {
    let (_env, c) = setup().await;
    let ws = root(&c, "config").await;
    c.ok("resource.delete", json!({ "id": ws })).await;
    assert_eq!(c.ok("tree.children", json!({ "tree": "config" })).await["nodes"], json!([]));
    c.ok("workspace.setConfig", json!({ "name": "ui.theme", "value": "dark" })).await;
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "ui.theme" })).await, "dark");
    assert_eq!(c.ok("tree.children", json!({ "tree": "config" })).await["nodes"][0]["label"], "Workspace");
}

#[tokio::test(flavor = "multi_thread")]
async fn review11_audit_text_filter_treats_wildcards_literally() {
    let (_env, c) = setup().await;
    item(&c, "x", "y").await;
    assert!(!c.ok("audit.list", json!({})).await.as_array().unwrap().is_empty());
    assert_eq!(c.ok("audit.list", json!({ "text": "%" })).await, json!([]));
    assert_eq!(c.ok("audit.list", json!({ "text": "_" })).await.as_array().unwrap().len(),
               c.ok("audit.list", json!({ "text": "_" })).await.as_array().unwrap().iter().filter(|r| r.to_string().contains('_')).count());
}
