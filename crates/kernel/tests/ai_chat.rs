//! D479 (docs/redesign/ai-chat.md): the writing-help provider (`onedesk.assist/2`), the conversation view node,
//! a page event's `apply`, and what only the provider may read (`pages.fields`, `runs.latest`, `aiVisible` in
//! search results). Temporary folders only; plugins here are generic test packages.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use onedesk_protocol::ErrorCode;
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

/// A page with a conversation (`body.mode` breaks it) whose event "apply" hands back `body.values`.
const TALK: &str = r#"
export default {
  activate(host) {
    host.commands.handle("probe", probe);
    host.commands.handle("openChat", () => []);
    host.actions.handle("go", () => ({ output: { type: "text", text: "x" } }));
    host.pages.handle("talk", {
      render(ctx) {
        const m = ctx.resource.body.mode || "ok";
        const conv = { type: "conversation", id: "c", targetTab: "t1", input: { name: "message", send: "send", placeholder: "Say" },
          turns: [{ role: "user", text: "hi" }, { role: "assistant", text: "yo", caption: "m · 1 / 2", actions: [{ id: "apply", label: "Apply", icon: "check" }] }] };
        if (m === "viewInput") conv.input.name = "view.x";
        if (m === "noSend") conv.input.send = "";
        if (m === "manyButtons") conv.turns[1].actions = [1, 2, 3, 4, 5].map((i) => ({ id: "a" + i, label: "a" }));
        if (m === "badRole") conv.turns[0].role = "system";
        if (m === "unknownField") conv.turns[0].color = "red";
        return { view: [conv] };
      },
      onEvent(ctx, event) {
        const b = ctx.resource.body;
        return { apply: { target: b.target, tabId: "t1", label: "It", values: JSON.parse(b.values || "{}") } };
      },
    });
  },
};
"#;

fn write_pkg(root: &Path, id: &str, assist: bool) {
    let pkg = root.join(id).join("0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let mut m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js",
        "requires": { "resources": true },
        "exports": { "actions": ["go"] },
        "contributes": {
            "kinds": [ { "id": "talk", "label": "talk", "icon": "box", "tree": "resources", "page": "talk" } ],
            "actions": [ { "id": "go", "label": "go", "output": "text" } ],
            "pages": [ { "id": "talk" } ],
            "commands": [ { "id": "probe", "label": "probe", "icon": "box" }, { "id": "openChat", "label": "chat", "icon": "box" } ]
        } });
    if assist {
        m["implements"] = json!({ "onedesk.assist/2": { "actions": ["go"] } });
    }
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), format!("{PROBE}\n{TALK}")).unwrap();
}

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    write_pkg(&root, "test.helper", true);
    write_pkg(&root, "test.other", false);
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

async fn let_ai_see(c: &Client, id: &str) {
    c.ok("resource.setAiVisible", json!({ "id": id, "visible": true })).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_provider_is_the_plugin_with_the_chat_command() {
    let (_env, c) = world().await;
    let p = c.ok("assist.provider", json!(null)).await;
    assert_eq!((p["available"].as_bool(), p["plugin"].as_str(), p["command"].as_str()), (Some(true), Some("test.helper"), Some("test.helper:openChat")), "{p}");
    // The old way to start writing help is gone.
    let e = c.call("assist.start", json!({ "target": "core:none", "tabId": "t" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::UnknownMethod);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_is_drawn_and_checked() {
    let (_env, c) = world().await;
    let ok = create(&c, "test.helper:talk", json!({ "name": "T" })).await;
    let d = c.ok("page.resolve", json!({ "target": format!("resource:{ok}") })).await;
    let conv = &d["view"][0];
    assert_eq!(conv["type"], "conversation", "{d}");
    assert_eq!(conv["turns"][1]["caption"], "m · 1 / 2");
    assert_eq!(conv["input"]["name"], "message");
    assert_eq!(conv["targetTab"], "t1");
    for mode in ["viewInput", "noSend", "manyButtons", "badRole", "unknownField"] {
        let id = create(&c, "test.helper:talk", json!({ "name": mode })).await;
        // Saved, though the page drawn after it is refused.
        let _ = c.call("page.save", json!({ "target": format!("resource:{id}"), "changes": { "body.mode": mode } })).await;
        let e = c.call("page.resolve", json!({ "target": format!("resource:{id}") })).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::PluginError, "{mode}: {e:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn apply_keeps_only_the_editable_text_of_the_page_and_writes_nothing() {
    let (_env, c) = world().await;
    let item = create(&c, "test.alpha:item", json!({ "name": "It", "body.text": "old" })).await;
    let values = json!({ "body.text": "new", "name": "Renamed", "body.other": "x", "params.x": "y", "body.n": 3 }).to_string();
    let talk = create(&c, "test.helper:talk", json!({ "body.target": format!("resource:{item}"), "body.values": values })).await;
    let r = c.ok("page.event", json!({ "target": format!("resource:{talk}"), "event": "apply" })).await;
    assert_eq!(r["apply"]["values"], json!({ "body.text": "new", "name": "Renamed" }), "{r}");
    assert_eq!((r["apply"]["tabId"].as_str(), r["apply"]["label"].as_str()), (Some("t1"), Some("It")));
    let saved = c.ok("resource.get", json!({ "id": item })).await;
    assert_eq!((saved["name"].as_str(), saved["body"]["text"].as_str()), (Some("It"), Some("old")));
    // Nothing editable left: no apply at all.
    let none = create(&c, "test.helper:talk", json!({ "body.target": format!("resource:{item}"), "body.values": json!({ "body.other": "x" }).to_string() })).await;
    let r = c.ok("page.event", json!({ "target": format!("resource:{none}"), "event": "apply" })).await;
    assert!(r.get("apply").is_none(), "{r}");
    // A new page works too (its fields, nothing saved yet).
    let fresh = create(&c, "test.helper:talk", json!({ "body.target": "new:test.alpha:item", "body.values": json!({ "body.text": "draft" }).to_string() })).await;
    let r = c.ok("page.event", json!({ "target": format!("resource:{fresh}"), "event": "apply" })).await;
    assert_eq!(r["apply"]["values"], json!({ "body.text": "draft" }));
    // Another plugin may not put values into other pages.
    let other = create(&c, "test.other:talk", json!({ "body.target": format!("resource:{item}"), "body.values": json!({ "body.text": "x" }).to_string() })).await;
    let e = c.call("page.event", json!({ "target": format!("resource:{other}"), "event": "apply" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::PluginError, "{e:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_provider_reads_pages_and_only_what_ai_may_see() {
    let (_env, c) = world().await;
    let item = create(&c, "test.alpha:item", json!({ "name": "It", "body.text": "hello" })).await;
    let target = format!("resource:{item}");
    let r = c.probe("test.helper", "pages.fields", json!([target])).await;
    assert_eq!((r["error"].as_str(), r["params"]["reason"].as_str()), (Some("denied"), Some("notAiVisible")), "{r}");
    let r = c.probe("test.other", "pages.fields", json!([target])).await;
    assert_eq!(r["params"]["reason"], "notAssistProvider", "{r}");
    let_ai_see(&c, &item).await;
    let r = c.probe("test.helper", "pages.fields", json!([target])).await;
    let ok = &r["ok"];
    assert_eq!(ok["name"], "It", "{r}");
    let text = ok["fields"].as_array().unwrap().iter().find(|f| f["name"] == "body.text").unwrap();
    assert_eq!((text["value"].as_str(), text["kind"].as_str(), text["editable"].as_bool()), (Some("hello"), Some("longtext"), Some(true)));
    // A new page: its fields, empty.
    let r = c.probe("test.helper", "pages.fields", json!(["new:test.alpha:item"])).await;
    assert!(r["ok"]["fields"].as_array().unwrap().iter().any(|f| f["name"] == "body.text"), "{r}");
    // The provider learns from search which results AI may see; others do not.
    let hit = c.probe("test.helper", "resources.search", json!([{ "ids": [item] }])).await;
    assert_eq!(hit["ok"]["items"][0]["aiVisible"], json!(true), "{hit}");
    let hit = c.probe("test.other", "resources.search", json!([{ "ids": [item] }])).await;
    assert!(hit["ok"]["items"][0].get("aiVisible").is_none(), "{hit}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_last_result_of_a_resource_in_an_environment() {
    let (_env, c) = world().await;
    let job = create(&c, "test.runner:job", json!({ "name": "J", "body.text": "rows 3" })).await;
    let r = c.probe("test.helper", "runs.latest", json!([job, null])).await;
    assert_eq!(r["params"]["reason"], "notAiVisible", "{r}");
    let_ai_see(&c, &job).await;
    assert_eq!(c.probe("test.helper", "runs.latest", json!([job, null])).await["ok"], Value::Null);
    let id = c.ok("run.start", json!({ "action": "test.runner:run", "resourceId": job, "target": format!("resource:{job}"), "tabId": "t1", "input": { "body.text": "rows 3" } })).await;
    for _ in 0..500 {
        if c.ok("run.get", json!({ "id": id })).await["status"] != "running" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let r = c.probe("test.helper", "runs.latest", json!([job, null])).await;
    assert_eq!(r["ok"]["runId"], id, "{r}");
    assert_eq!(r["ok"]["output"]["type"], "table");
    // In an environment it never ran in: nothing.
    let r = c.probe("test.helper", "runs.latest", json!([job, "nowhere"])).await;
    assert_eq!(r["ok"], Value::Null, "{r}");
    let r = c.probe("test.other", "runs.latest", json!([job, null])).await;
    assert_eq!(r["params"]["reason"], "notAssistProvider", "{r}");
}
