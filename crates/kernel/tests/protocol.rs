//! The protocol suite: the same test function runs in-process and over a Unix socket.

mod common;

use common::*;
use onedesk_protocol::{ErrorCode, PROTOCOL_VERSION};
use serde_json::{json, Value};

async fn suite(env: &Env, c: &Client) {
    // The first request must be `hello`; a wrong version is refused.
    let e = c.call("tree.list", Value::Null).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Invalid);
    let e = c.call("hello", json!({ "protocol": "0" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::VersionMismatch);
    let hello = c.ok("hello", json!({ "protocol": PROTOCOL_VERSION })).await;
    assert_eq!(hello["workspace"]["id"].as_str().unwrap().len(), 32);
    assert_eq!(c.call("nope.nope", Value::Null).await.unwrap_err().code, ErrorCode::UnknownMethod);
    assert_eq!(c.call("tree.children", json!({ "tree": 5 })).await.unwrap_err().code, ErrorCode::InvalidParams);
    assert_eq!(c.ok("workspace.info", Value::Null).await, hello["workspace"]);

    // Listing trees, stored children and the "new" menu activate no plugin.
    let trees = c.ok("tree.list", Value::Null).await;
    let ids: Vec<&str> = trees.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"resources") && ids.contains(&"test.alpha:disk"), "{ids:?}");
    let disk = trees.as_array().unwrap().iter().find(|t| t["id"] == "test.alpha:disk").unwrap();
    assert_eq!(disk["title"]["en-US"], "Disk");
    assert_eq!(disk["toolbar"][0]["id"], "plugin.grantFolder");
    let items = c.ok("command.newItems", Value::Null).await;
    assert_eq!(items[0]["id"], "node.newGroup");
    assert!(items.as_array().unwrap().iter().any(|i| i["id"] == "new:test.alpha:item" && i["label"]["zh-CN"] == "条目"));
    assert_eq!(c.ok("tree.children", json!({ "tree": "resources" })).await["nodes"], json!([]));
    assert!(env.kernel.active_plugins().is_empty());

    // Group → new item saved into it → rename → move → delete.
    let group = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "G" })).await;
    assert_eq!(group["kind"], "core:group");
    assert!(group.get("target").is_none());
    let gid = group["key"].as_str().unwrap().to_string();
    let eff = c.ok("command.execute", json!({ "id": "new:test.alpha:item", "context": { "tree": "resources", "nodeKey": gid } })).await;
    let new_target = eff[0]["target"].as_str().unwrap().to_string();
    assert_eq!(new_target, format!("new:test.alpha:item?parent={gid}"));
    let draft = c.ok("page.resolve", json!({ "target": new_target, "context": { "locale": "zh-CN" } })).await;
    assert_eq!(draft["title"], "新条目");
    assert_eq!(draft["values"]["body.text"], "");
    assert_eq!(draft["view"][0]["fields"][0]["label"]["en-US"], "Text", "ctx.t gives the localized label");
    assert_eq!(draft["kindLabel"]["zh-CN"], "条目");
    assert!(draft.get("resourceId").is_none());
    assert_eq!(env.kernel.active_plugins(), vec!["test.alpha".to_string()]);
    let saved = c.ok("page.save", json!({ "target": new_target, "changes": { "body.text": "hello" } })).await;
    let page = &saved["page"];
    let rid = page["resourceId"].as_str().unwrap().to_string();
    assert_eq!(page["target"], format!("resource:{rid}"));
    assert_eq!(page["title"], "New item");
    assert_eq!(page["values"]["body.text"], "hello");
    assert_eq!(page["basis"], "1");
    assert_eq!(page["breadcrumb"][0]["label"], "G");
    assert_eq!(page["actions"][0]["role"], "save");
    assert!(page["hasInfo"].as_bool().unwrap());
    c.event(|e| e.topic == "tree:resources").await;

    let kids = c.ok("tree.children", json!({ "tree": "resources", "parent": gid })).await;
    let node = &kids["nodes"][0];
    assert_eq!((node["key"].as_str().unwrap(), node["target"].as_str().unwrap()), (rid.as_str(), format!("resource:{rid}").as_str()));
    let menu: Vec<&str> = node["menu"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(menu, vec!["node.open", "node.rename", "test.alpha:probe", "node.delete"]);
    assert_eq!(c.ok("tree.path", json!({ "tree": "resources", "key": rid })).await, json!([gid, rid]));

    c.ok("tree.rename", json!({ "tree": "resources", "key": rid, "name": "Renamed" })).await;
    assert_eq!(c.call("tree.rename", json!({ "tree": "resources", "key": rid, "name": " " })).await.unwrap_err().code, ErrorCode::Invalid);
    c.ok("tree.move", json!({ "tree": "resources", "key": rid, "position": "inside" })).await;
    let top = c.ok("tree.children", json!({ "tree": "resources" })).await;
    let labels: Vec<&str> = top["nodes"].as_array().unwrap().iter().map(|n| n["label"].as_str().unwrap()).collect();
    assert_eq!(labels, vec!["G", "Renamed"]);
    c.ok("tree.move", json!({ "tree": "resources", "key": rid, "target": gid, "position": "before" })).await;
    let top = c.ok("tree.children", json!({ "tree": "resources" })).await;
    assert_eq!(top["nodes"][0]["key"], rid.as_str());
    let res = c.ok("resource.get", json!({ "id": rid })).await;
    assert_eq!((res["name"].as_str().unwrap(), res["rev"].as_i64().unwrap()), ("Renamed", 4));
    let eff = c.ok("command.execute", json!({ "id": "node.delete", "context": { "tree": "resources", "nodeKey": rid } })).await;
    assert_eq!(eff, json!([{ "type": "close-target", "target": format!("resource:{rid}") }]));
    assert_eq!(c.ok("resource.get", json!({ "id": rid })).await, Value::Null);
    let gone = c.ok("page.resolve", json!({ "target": format!("resource:{rid}") })).await;
    assert_eq!((gone["found"].as_bool().unwrap(), gone["page"].as_str().unwrap()), (false, "missing"));

    // Grant a folder → the provided tree lists it → open a file node, save, open again.
    let folder = env.path().join("shared");
    std::fs::create_dir_all(folder.join("sub")).unwrap();
    std::fs::write(folder.join("a.txt"), "first").unwrap();
    let eff = c.ok("command.execute", json!({ "id": "plugin.grantFolder", "context": { "tree": "test.alpha:disk" } })).await;
    assert_eq!(eff, json!([{ "type": "pick-folder", "plugin": "test.alpha" }]));
    let g = c.ok("plugin.grantFolder", json!({ "plugin": "test.alpha", "path": folder.display().to_string() })).await;
    assert_eq!(g["folders"], json!([folder.display().to_string()]));
    c.event(|e| e.topic == "plugins").await;
    let roots = c.ok("tree.children", json!({ "tree": "test.alpha:disk" })).await;
    let root_key = roots["nodes"][0]["key"].as_str().unwrap().to_string();
    assert_eq!(root_key, folder.display().to_string());
    let files = c.ok("tree.children", json!({ "tree": "test.alpha:disk", "parent": root_key })).await;
    let names: Vec<&str> = files["nodes"].as_array().unwrap().iter().map(|n| n["label"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["sub", "a.txt"]);
    let file = &files["nodes"][1];
    let target = file["target"].as_str().unwrap().to_string();
    assert!(target.starts_with("node:test.alpha:disk/"), "{target}");
    let opened = c.ok("page.resolve", json!({ "target": target })).await;
    assert_eq!((opened["title"].as_str().unwrap(), opened["values"]["text"].as_str().unwrap()), ("a.txt", "first"));
    assert!(!opened["hasInfo"].as_bool().unwrap());
    let path = c.ok("tree.path", json!({ "tree": "test.alpha:disk", "key": file["key"] })).await;
    assert_eq!(path, json!([root_key, file["key"]]));
    let saved = c.ok("page.save", json!({ "target": target, "changes": { "text": "second" }, "basis": opened["basis"] })).await;
    assert_eq!(saved["page"]["values"]["text"], "second");
    assert_ne!(saved["page"]["basis"], opened["basis"]);
    assert_eq!(std::fs::read_to_string(folder.join("a.txt")).unwrap(), "second");
    c.event(|e| e.topic == "tree:test.alpha:disk").await;
    let again = c.ok("page.resolve", json!({ "target": target })).await;
    assert_eq!(again["values"]["text"], "second");
    // A stale basis conflicts and leaves the file alone.
    let e = c.call("page.save", json!({ "target": target, "changes": { "text": "third" }, "basis": opened["basis"] })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(std::fs::read_to_string(folder.join("a.txt")).unwrap(), "second");
    // tree.move on a provided tree is unsupported.
    let e = c.call("tree.move", json!({ "tree": "test.alpha:disk", "key": root_key, "position": "inside" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Unsupported);
    let g = c.ok("plugin.revokeFolder", json!({ "plugin": "test.alpha", "path": folder.display().to_string() })).await;
    assert_eq!(g["folders"], json!([]));
    assert_eq!(c.ok("tree.children", json!({ "tree": "test.alpha:disk" })).await["nodes"], json!([]));

    // Interface state is kept per client.
    c.ok("ui.set", json!({ "key": "tabs", "value": [1, 2] })).await;
    c.call_as(Some("w2"), "ui.set", json!({ "key": "tabs", "value": ["x"] })).await.unwrap();
    assert_eq!(c.ok("ui.get", json!({ "key": "tabs" })).await, json!([1, 2]));
    assert_eq!(c.call_as(Some("w2"), "ui.get", json!({ "key": "tabs" })).await.unwrap(), json!(["x"]));
    c.ok("ui.set", json!({ "key": "tabs", "value": null })).await;
    assert_eq!(c.ok("ui.get", json!({ "key": "tabs" })).await, Value::Null);

    // `host.ui` effects reach only the client that started the call.
    let r = c.call_as(Some("w2"), "command.execute", json!({ "id": "test.alpha:probe",
        "context": { "args": { "method": "ui.open", "args": ["resource:x"] } } })).await.unwrap();
    assert!(r[0]["text"].as_str().unwrap().contains("\"ok\""));
    let ev = c.event(|e| e.topic == "ui").await;
    assert_eq!(ev.client.as_deref(), Some("w2"));
    assert_eq!(ev.payload.unwrap(), json!({ "type": "open", "target": "resource:x" }));
    let bad = c.probe("test.alpha", "ui.open", json!(["https://example.com"])).await;
    assert_eq!(bad["error"], "invalid");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn protocol_suite_in_process() {
    let env = open(&fixtures());
    let c = Client::in_proc(env.kernel.clone());
    suite(&env, &c).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn protocol_suite_over_socket() {
    let env = open(&fixtures());
    let c = Client::socket(env.kernel.clone(), env.tmp.path()).await;
    suite(&env, &c).await;
}
