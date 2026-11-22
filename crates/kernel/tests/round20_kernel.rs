//! Round 20 (kernel): a read-only page takes only the fields it binds (D453), and a configuration
//! page keeps a reference parameter a reference, with the candidates by name (D453).

mod common;

use std::path::Path;

use common::*;
use serde_json::{json, Value};

fn pkg(root: &Path, id: &str, extra: Value, main: &str) {
    let dir = root.join(id).join("0.1.0");
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": id, "icon": "box", "main": "main.js" });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(dir.join("main.js"), main).unwrap();
}

/// A page that binds only `body.text` and says `readOnly`; `body.extra` is stored but unbound.
const PAGES: &str = r#"
export default { activate(host) {
  host.pages.handle("p", { async render() {
    return { view: [{ type: "form", id: "f", layout: "stack", fields: [
        { name: "text", label: "t", kind: "code", bind: "body.text" }] }], readOnly: true };
  } });
  host.pages.handle("w", { async render() {
    return { view: [{ type: "form", id: "f", layout: "stack", fields: [
        { name: "text", label: "t", kind: "code", bind: "body.text" }] }] };
  } });
} };
"#;

async fn world() -> (Env, Client) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    pkg(&root, "t.ro", json!({ "contributes": {
        "kinds": [
            { "id": "doc", "label": "D", "icon": "file", "tree": "resources", "newName": "d", "page": "p" },
            { "id": "free", "label": "F", "icon": "file", "tree": "resources", "newName": "f", "page": "w" }
        ],
        "pages": [{ "id": "p" }, { "id": "w" }]
    } }), PAGES);
    let env = open_exact(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_only_page_refuses_unbound_body_fields() {
    let (_env, c) = world().await;
    // `new:` takes whatever it is given (the kind's own creation), including unbound fields.
    let made = c.ok("page.save", json!({ "target": "new:t.ro:doc", "changes": { "name": "a", "body.text": "t0", "body.extra": "e0" } })).await;
    let id = made["page"]["resourceId"].as_str().unwrap().to_string();
    let target = format!("resource:{id}");
    // An unbound field of a read-only page is refused, and nothing changes.
    let e = c.call("page.save", json!({ "target": target, "changes": { "body.extra": "DROP TABLE x" } })).await.unwrap_err();
    assert_eq!(serde_json::to_value(e.code).unwrap(), "denied");
    assert_eq!(e.params.get("reason").map(String::as_str), Some("readOnlyField"));
    // Mixed with allowed fields: the whole save is refused.
    let e = c.call("page.save", json!({ "target": target, "changes": { "name": "b", "body.extra": "x" } })).await.unwrap_err();
    assert_eq!(e.params.get("reason").map(String::as_str), Some("readOnlyField"));
    let r = c.ok("resource.get", json!({ "id": id })).await;
    assert_eq!((r["name"].as_str(), r["body"]["extra"].as_str()), (Some("a"), Some("e0")), "{r}");
    // Framework fields and the bound field are still accepted.
    c.ok("page.save", json!({ "target": target, "changes": { "name": "b", "tags": ["x"], "body.text": "t1" } })).await;
    let r = c.ok("resource.get", json!({ "id": id })).await;
    assert_eq!((r["name"].as_str(), r["body"]["text"].as_str()), (Some("b"), Some("t1")), "{r}");
    // A page that is not read-only is not affected.
    let made = c.ok("page.save", json!({ "target": "new:t.ro:free", "changes": { "name": "f" } })).await;
    let fid = made["page"]["resourceId"].as_str().unwrap().to_string();
    c.ok("page.save", json!({ "target": format!("resource:{fid}"), "changes": { "body.extra": "ok" } })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn config_page_keeps_a_reference_with_named_candidates() {
    let (_env, c) = world().await;
    let a = c.ok("page.save", json!({ "target": "new:t.ro:free", "changes": { "name": "Shop" } })).await["page"]["resourceId"].as_str().unwrap().to_string();
    let b = c.ok("page.save", json!({ "target": "new:t.ro:free", "changes": { "name": "Other" } })).await["page"]["resourceId"].as_str().unwrap().to_string();
    let root = c.ok("tree.children", json!({ "tree": "config" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    c.ok("params.set", json!({ "node": root, "name": "x.default", "value": a, "type": "ref" })).await;
    c.ok("params.set", json!({ "node": root, "name": "x.dangling", "value": "nope", "type": "ref" })).await;
    let page = c.ok("page.resolve", json!({ "target": format!("resource:{root}") })).await;
    let fields = page["view"][0]["fields"].as_array().unwrap();
    let f = |n: &str| fields.iter().find(|f| f["name"] == n).unwrap().clone();
    let d = f("x.default");
    assert_eq!(d["kind"], "ref", "{d}");
    let opts: Vec<(String, String)> =
        d["options"].as_array().unwrap().iter().map(|o| (o["value"].as_str().unwrap().into(), o["label"].as_str().unwrap().into())).collect();
    assert!(opts.contains(&(a.clone(), "Shop".into())) && opts.contains(&(b, "Other".into())), "{opts:?}");
    // A reference that names nothing has no candidates to offer: it stays a text box.
    assert_eq!(f("x.dangling")["kind"], "text");
}

/// D454: a thrown error's `detail` is its message, not the stack (`at fn (main.js:1:2)`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_thrown_errors_detail_has_no_stack() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    pkg(&root, "t.th", json!({ "contributes": { "actions": [{ "id": "boom", "label": "b", "output": "text" }] } }), r#"
function inner() { throw new Error("it broke\nsecond line"); }
export default { activate(host) { host.actions.handle("boom", async () => { inner(); }); } };
"#);
    let env = open_exact(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let id = c.ok("run.start", json!({ "action": "t.th:boom", "target": "core:none", "tabId": "t", "input": {} })).await;
    let mut r = Value::Null;
    for _ in 0..500 {
        r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(r["error"]["code"], "pluginError", "{r}");
    let detail = r["error"]["detail"].as_str().unwrap();
    assert!(detail.contains("it broke") && detail.contains("second line"), "{r}");
    assert!(!detail.contains("main.js") && !detail.contains("    at "), "{r}");
}
