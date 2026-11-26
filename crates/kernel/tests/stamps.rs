//! D487 §23 (docs/redesign/book.md): stamps (K6) — a stamped resource's content is fixed, its references show what they
//! showed then, taking stamps off needs a reason — and the `flow` view node (K4). Temporary folders only; generic
//! packages (the kernel knows no document).

mod common;

use std::path::{Path, PathBuf};

use common::*;
use onedesk_protocol::ErrorCode;
use serde_json::{json, Value};

/// `paper` has a text with references; its page draws a flow (broken on purpose by `body.mode`) and its events stamp
/// and unstamp. `card` embeds its own text, or answers an inline call with `n`.
const MAIN: &str = r#"
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
export default {
  activate(host) {
    host.commands.handle("probe", probe);
    host.kinds.handle("card", {
      embed(ctx, ask) {
        if (ask.inline) return { text: "n=" + (ctx.resource.body.n ?? "?") };
        return { view: [{ type: "text", id: "t", text: String(ctx.resource.body.text ?? "") }] };
      },
    });
    host.pages.handle("paper", {
      render(ctx) {
        const m = (ctx.resource && ctx.resource.body && ctx.resource.body.mode) || "";
        const fields = [{ name: "t", label: "T", kind: "number", bind: "body.v.t" }, { name: "c", label: "C", kind: "text", param: true }];
        let text = "Temp {{field:t}} ℃, note {{field:c}}.";
        if (m === "missing") text = "Temp {{field:t}} only.";
        if (m === "twice") text = "{{field:t}} {{field:t}} {{field:c}}";
        return { view: [{ type: "flow", id: "f", text, fields }] };
      },
      async onEvent(ctx, event) {
        try {
          if (event === "sign") await ctx.host.resources.stamp(ctx.resource.id, { label: "Signed", signer: "Dr. A" });
          if (event === "sign2") await ctx.host.resources.stamp(ctx.resource.id, { label: "Checked", signer: "Dr. B" });
          if (event === "revise") await ctx.host.resources.unstamp(ctx.resource.id, { reason: String(ctx.params.reason || "") });
          if (event === "edit") await ctx.host.resources.update(ctx.resource.id, { "body.x": 1 });
          return { message: { "en-US": "ok" } };
        } catch (e) {
          return { message: { "en-US": e.code + "/" + ((e.params || {}).reason || "") } };
        }
      },
    });
  },
};
"#;

fn write_pkg(root: &Path, id: &str, contributes: Value, main: &str) {
    let pkg = root.join(id).join("0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js", "requires": { "resources": true, "contents": true }, "contributes": contributes });
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), main).unwrap();
}

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    let ev = |id: &str| json!({ "id": id, "role": "event", "label": id, "icon": "box" });
    let contributes = json!({
        "kinds": [
            { "id": "paper", "label": "paper", "icon": "box", "tree": "resources", "draggable": true, "page": "paper", "accepts": [],
              "fields": { "text": { "type": "longtext", "refs": true } } },
            { "id": "card", "label": "card", "icon": "box", "tree": "resources", "draggable": true, "embed": true, "accepts": ["*"] }
        ],
        "pages": [ { "id": "paper", "actions": [ev("sign"), ev("sign2"), ev("revise"), ev("edit")] } ],
        "commands": [ { "id": "probe", "label": "probe", "icon": "box" } ]
    });
    write_pkg(&root, "test.paper", contributes, MAIN);
    let other = MAIN.split("export default").next().unwrap().to_string() + "export default { activate(host) { host.commands.handle(\"probe\", probe); } };";
    write_pkg(&root, "test.other", json!({ "commands": [ { "id": "probe", "label": "probe", "icon": "box" } ] }), &other);
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

async fn create(c: &Client, kind: &str, parent: Option<&str>, changes: Value) -> String {
    let target = match parent {
        Some(p) => format!("new:{kind}?parent={p}"),
        None => format!("new:{kind}"),
    };
    let r = c.ok("page.save", json!({ "target": target, "changes": changes })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn event(c: &Client, id: &str, name: &str, params: Value) -> String {
    let r = c.ok("page.event", json!({ "target": format!("resource:{id}"), "event": name, "context": { "params": params } })).await;
    r["message"]["en-US"].as_str().unwrap_or_default().to_string()
}

fn embed(id: &str, within: Option<&str>, inline: bool, params: Option<&str>) -> Value {
    json!({ "id": id, "within": within, "inline": inline.then_some(true), "params": params })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stamp_fixes_the_content_and_keeps_what_references_showed() {
    let (_env, c) = world().await;
    let card = create(&c, "test.paper:card", None, json!({ "name": "Card", "body.text": "first", "body.n": 1 })).await;
    let paper = create(&c, "test.paper:paper", None, json!({ "name": "Paper", "body.text": "![[Card]] and [[=Card | a=1]]" })).await;
    assert_eq!(event(&c, &paper, "sign", json!({})).await, "ok");
    let r = c.ok("resource.get", json!({ "id": paper })).await;
    assert_eq!(r["readOnly"], true);
    assert_eq!(r["stamps"][0]["label"], "Signed");
    assert_eq!(r["stamps"][0]["signer"], "Dr. A");
    assert_eq!(r["stampLog"][0]["action"], "stamp");
    // Fixed: no edits by the user or the plugin, no restore, no delete; it may move.
    let e = c.call("page.save", json!({ "target": format!("resource:{paper}"), "changes": { "name": "X" } })).await.unwrap_err();
    assert_eq!((e.code, e.params.get("reason").map(String::as_str)), (ErrorCode::Denied, Some("stamped")));
    assert_eq!(event(&c, &paper, "edit", json!({})).await, "denied/stamped");
    let e = c.call("resource.delete", json!({ "id": paper })).await.unwrap_err();
    assert_eq!(e.params.get("reason").map(String::as_str), Some("stamped"));
    let folder = create(&c, "test.paper:card", None, json!({ "name": "Folder" })).await;
    c.ok("tree.move", json!({ "tree": "resources", "key": paper, "target": folder, "position": "inside" })).await;
    // The card changes: within the paper, it shows as it was; elsewhere, as it is.
    c.ok("page.save", json!({ "target": format!("resource:{card}"), "changes": { "body.text": "second", "body.n": 2 } })).await;
    let then = c.ok("resource.embed", embed(&card, Some(&paper), false, None)).await;
    assert_eq!(then["view"][0]["text"], "first");
    let now = c.ok("resource.embed", embed(&card, None, false, None)).await;
    assert_eq!(now["view"][0]["text"], "second");
    let call = c.ok("resource.embed", embed(&card, Some(&paper), true, Some("a=1"))).await;
    assert_eq!(call["text"], "n=1");
    // A second stamp adds a signer; what was kept stays.
    assert_eq!(event(&c, &paper, "sign2", json!({})).await, "ok");
    assert_eq!(c.ok("resource.get", json!({ "id": paper })).await["stamps"].as_array().unwrap().len(), 2);
    assert_eq!(c.ok("resource.embed", embed(&card, Some(&paper), false, None)).await["view"][0]["text"], "first");
    // Taking the stamps off needs a reason; then it is live and writable again.
    assert_eq!(event(&c, &paper, "revise", json!({})).await, "invalid/noReason");
    assert_eq!(event(&c, &paper, "revise", json!({ "reason": "wrong dose" })).await, "ok");
    let r = c.ok("resource.get", json!({ "id": paper })).await;
    assert!(r["stamps"].is_null() && r["readOnly"] == false, "{r}");
    assert_eq!(r["stampLog"][2]["action"], "unstamp");
    assert_eq!(r["stampLog"][2]["reason"], "wrong dose");
    assert_eq!(c.ok("resource.embed", embed(&card, Some(&paper), false, None)).await["view"][0]["text"], "second");
    c.ok("page.save", json!({ "target": format!("resource:{paper}"), "changes": { "name": "Paper 2" } })).await;
    // Audited.
    let a = c.ok("audit.list", json!({ "operation": "resource.unstamp" })).await;
    assert_eq!(a.as_array().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_owner_stamps_and_only_as_the_users_act() {
    let (_env, c) = world().await;
    let paper = create(&c, "test.paper:paper", None, json!({ "name": "Paper" })).await;
    let e = c.probe("test.other", "resources.stamp", json!([paper, { "label": "X" }])).await;
    assert_eq!(e["params"]["reason"], "foreignKind", "{e}");
    let e = c.probe("test.paper", "resources.stamp", json!([paper, { "label": "" }])).await;
    assert_eq!(e["error"], "invalidParams", "{e}");
    let ok = c.probe("test.paper", "resources.stamp", json!([paper, { "label": "Run", "signer": "S" }])).await;
    assert!(ok.get("ok").is_some(), "{ok}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_flow_puts_each_field_once_in_its_text() {
    let (_env, c) = world().await;
    let good = create(&c, "test.paper:paper", None, json!({ "name": "Good" })).await;
    let r = c.ok("page.resolve", json!({ "target": format!("resource:{good}") })).await;
    let flow = &r["view"][0];
    assert_eq!(flow["type"], "flow", "{r}");
    assert_eq!(flow["fields"][0]["bind"], "body.v.t");
    for mode in ["missing", "twice"] {
        let e = c.call("page.save", json!({ "target": "new:test.paper:paper", "changes": { "name": mode, "body.mode": mode } })).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::PluginError, "{mode}");
    }
    // Bound flow fields save like form fields.
    c.ok("page.save", json!({ "target": format!("resource:{good}"), "changes": { "body.v.t": 37.2 } })).await;
    assert_eq!(c.ok("resource.get", json!({ "id": good })).await["body"]["v.t"], 37.2);
}
