//! D487 §29 (docs/redesign/book.md): proposals of changes (K16), a resource at a revision (K17), and the AI tools that
//! read a structure and propose (`tree`, `read`, `propose`, `search.within`). Temporary folders only; a generic test
//! plugin (the kernel knows no book).

mod common;

use std::path::{Path, PathBuf};

use common::*;
use onedesk_protocol::{ErrorCode, ProtocolError};
use serde_json::{json, Value};

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
    host.pages.handle("note", {
      render(ctx) {
        return { view: [{ type: "form", id: "f", layout: "stack", fields: [
          { name: "text", label: "Text", kind: "longtext", bind: "body.text" },
          { name: "n", label: "N", kind: "number", bind: "body.n" },
          { name: "key", label: "Key", kind: "secret", bind: "body.key" },
          { name: "ans", label: "Answer", kind: "longtext", bind: "body.ans" },
          { name: "fixed", label: "Fixed", kind: "text", bind: "body.fixed", readOnly: true },
        ] }] };
      },
      async onEvent(ctx, event) {
        if (event === "sign") await ctx.host.resources.stamp(ctx.resource.id, { label: "Signed", signer: "A" });
        return { message: { "en-US": "ok" } };
      },
    });
  },
};
"#;

fn write_pkg(root: &Path, id: &str, contributes: Value, main: &str) {
    let pkg = root.join(id).join("0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js", "requires": { "resources": true }, "contributes": contributes });
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), main).unwrap();
}

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    let contributes = json!({
        "kinds": [
            { "id": "note", "label": "note", "icon": "box", "tree": "resources", "draggable": true, "page": "note", "accepts": ["*"],
              "fields": { "text": { "type": "longtext", "refs": true }, "key": { "type": "secret" }, "ans": { "type": "longtext", "withheld": true } } }
        ],
        "pages": [ { "id": "note", "actions": [ { "id": "sign", "role": "event", "label": "sign", "icon": "box" } ] } ],
        "commands": [ { "id": "probe", "label": "probe", "icon": "box" } ]
    });
    write_pkg(&root, "t.note", contributes, MAIN);
    root
}

async fn world(policy: &[(&str, &str)]) -> (Env, Client) {
    let tmp = tempfile::tempdir().unwrap();
    let root = plugins(tmp.path());
    let env = open_with(tmp, &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    for (k, v) in policy {
        c.ok("workspace.setConfig", json!({ "name": k, "value": v })).await;
    }
    (env, c)
}

const AI: &[(&str, &str)] = &[("mcp.enabled", "true"), ("mcp.allow_proposals", "true")];

async fn note(c: &Client, parent: Option<&str>, name: &str, text: &str) -> String {
    let target = match parent {
        Some(p) => format!("new:t.note:note?parent={p}"),
        None => "new:t.note:note".to_string(),
    };
    let r = c.ok("page.save", json!({ "target": target, "changes": { "name": name, "body.text": text } })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

fn code(e: &ProtocolError) -> String {
    let c = serde_json::to_value(e.code).unwrap();
    format!("{}/{}", c.as_str().unwrap(), e.params.get("reason").map(String::as_str).unwrap_or(""))
}

async fn tool(c: &Client, name: &str, args: Value) -> Result<Value, ProtocolError> {
    c.call_ai("tester", "mcp.call", json!({ "name": name, "arguments": args })).await.map(|v| v["content"].clone())
}

async fn body(c: &Client, id: &str) -> Value {
    c.ok("resource.get", json!({ "id": id })).await
}

/// A book-like structure: a root, two pages under it, a draft; all shown to AI.
async fn shelf(c: &Client) -> (String, String, String, String) {
    let root = note(c, None, "Root", "").await;
    let a = note(c, Some(&root), "Chapter 1", "line one\nline two").await;
    let b = note(c, Some(&root), "Chapter 2", "second chapter").await;
    let d = note(c, Some(&root), "Draft", "scratch").await;
    c.ok("resource.setAiVisible", json!({ "id": root, "visible": true, "withChildren": true })).await;
    (root, a, b, d)
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ai_reads_a_structure_and_proposes_nothing_is_written_until_accepted() {
    let (_env, c) = world(AI).await;
    let (root, a, b, d) = shelf(&c).await;
    let hidden = note(&c, Some(&root), "Hidden", "secret stuff").await;
    c.ok("resource.setAiVisible", json!({ "id": hidden, "visible": false })).await;

    // tree: in order, with depths and revisions; nothing it may not see.
    let t = tool(&c, "tree", json!({ "id": root })).await.unwrap();
    let names: Vec<&str> = t["nodes"].as_array().unwrap().iter().map(|n| n["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Chapter 1", "Chapter 2", "Draft"]);
    assert_eq!(t["nodes"][0]["depth"], 1);
    // read: the page's fields, which ones may change; never a secret or withheld field.
    let r = tool(&c, "read", json!({ "id": a })).await.unwrap();
    let paths: Vec<&str> = r["fields"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["body.text", "body.n", "body.fixed"], "{r}");
    assert_eq!(r["fields"][0]["value"], "line one\nline two");
    assert_eq!(r["fields"][0]["changeable"], true);
    assert_eq!(r["fields"][1]["changeable"], false);
    assert_eq!(r["fields"][2]["changeable"], false);
    let rev = r["rev"].as_i64().unwrap();
    assert_eq!(code(&tool(&c, "read", json!({ "id": hidden })).await.unwrap_err()), "notFound/");
    // search within: only below the root.
    let other = note(&c, None, "Elsewhere", "second chapter too").await;
    c.ok("resource.setAiVisible", json!({ "id": other, "visible": true })).await;
    let s = tool(&c, "search", json!({ "query": "second", "within": root })).await.unwrap();
    let ids: Vec<&str> = s["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [b.as_str()]);

    // propose: two changes, one new page, one deletion.
    let p = tool(&c, "propose", json!({ "title": "Tighten chapter 1", "comment": "Shorter, plus a summary", "items": [
        { "op": "update", "id": a, "rev": rev, "changes": { "body.text": "line one, better\nline two", "name": "Chapter One" } },
        { "op": "create", "kind": "t.note:note", "parent": root, "before": d, "name": "Summary", "values": { "body.text": "In short." } },
        { "op": "delete", "id": d, "rev": 1 }
    ] })).await.unwrap();
    let pid = p["proposal"].as_str().unwrap().to_string();
    // Nothing changed.
    assert_eq!(body(&c, &a).await["body"]["text"], "line one\nline two");
    assert!(body(&c, &d).await["name"] == "Draft");
    // The AI writes nothing else.
    let e = c.call_ai("tester", "page.save", json!({ "target": format!("resource:{a}"), "changes": { "name": "X" } })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Denied);
    // It is a resource in the kernel's tree of proposals, pending.
    let kids = c.ok("tree.children", json!({ "tree": "proposals" })).await;
    assert_eq!(kids["nodes"][0]["key"], pid.as_str());
    assert_eq!(c.ok("proposal.count", json!({})).await["pending"], 1);
    assert_eq!(c.ok("proposal.count", json!({ "resourceId": a })).await["pending"], 1);
    assert_eq!(c.ok("proposal.count", json!({ "resourceId": b })).await["pending"], 0);
    let page = c.ok("page.resolve", json!({ "target": format!("resource:{pid}") })).await;
    assert_eq!(page["page"], "proposal");
    let v = c.ok("proposal.get", json!({ "id": pid })).await;
    assert_eq!(v["proposer"], "ai:tester");
    assert_eq!(v["status"], "pending");
    assert_eq!(v["items"][0]["fields"][0]["path"], "body.text");
    assert_eq!(v["items"][0]["fields"][0]["current"], "line one\nline two");
    assert_eq!(v["items"][0]["fields"][0]["label"], "Text");
    assert_eq!(v["items"][1]["location"], json!(["", "Root"]));
    assert_eq!(v["items"][2]["name"], "Draft");
    // The page itself cannot be edited; nor can a proposal be made as a plain resource.
    let e = c.call("resource.update", json!({ "id": pid, "changes": { "body.status": "accepted" } })).await;
    assert!(e.is_err());
    let e = c.call("page.save", json!({ "target": "new:core:proposal", "changes": { "name": "x" } })).await.unwrap_err();
    assert!(matches!(e.code, ErrorCode::Denied | ErrorCode::NotFound | ErrorCode::Invalid), "{e:?}");

    // Review: accept the first, reject the deletion, change the new page and accept it.
    let v = c
        .ok("proposal.review", json!({ "id": pid, "comment": "Thanks", "items": [
            { "index": 0, "decision": "accept" },
            { "index": 2, "decision": "reject" },
            { "index": 1, "decision": "accept", "values": { "body.text": "In short, better." } }
        ] }))
        .await;
    assert_eq!(v["status"], "partial");
    assert_eq!(v["reviewComment"], "Thanks");
    assert_eq!(v["items"][2]["result"], "rejected");
    let a_now = body(&c, &a).await;
    assert_eq!((a_now["name"].clone(), a_now["body"]["text"].clone()), (json!("Chapter One"), json!("line one, better\nline two")));
    assert_eq!(body(&c, &d).await["name"], "Draft");
    let made = v["items"][1]["created"].as_str().unwrap().to_string();
    let m = body(&c, &made).await;
    assert_eq!((m["name"].clone(), m["body"]["text"].clone(), m["parentId"].clone()), (json!("Summary"), json!("In short, better."), json!(root)));
    // Put before the draft; seen by AI like its parent.
    let kids = c.ok("tree.children", json!({ "tree": "resources", "parent": root })).await;
    let order: Vec<&str> = kids["nodes"].as_array().unwrap().iter().map(|n| n["label"].as_str().unwrap()).collect();
    assert_eq!(order, ["Chapter One", "Chapter 2", "Summary", "Draft", "Hidden"]);
    assert!(tool(&c, "read", json!({ "id": made })).await.is_ok());
    // History: by the user, marked with the proposal and its proposer.
    let h = c.ok("resource.history", json!({ "id": a })).await;
    let e0 = h.as_array().unwrap().iter().find(|e| e["field"] == "body.text").unwrap().clone();
    assert_eq!(e0["actor"], "user");
    assert_eq!(e0["proposal"]["id"], pid.as_str());
    assert_eq!(e0["proposal"]["title"], "Tighten chapter 1");
    assert_eq!(e0["proposal"]["proposer"], "ai:tester");
    // The audit has who proposed and who accepted.
    let au = c.ok("audit.list", json!({ "operation": "proposal.review" })).await;
    assert_eq!(au[0]["actor"], "user");
    assert!(au[0]["detail"].as_str().unwrap().contains("ai:tester"), "{au}");
    let au = c.ok("audit.list", json!({ "operation": "proposal.create" })).await;
    assert_eq!(au[0]["actor"], "ai:tester");
    // Every item decided: it is closed.
    let e = c.call("proposal.review", json!({ "id": pid, "items": [{ "index": 0, "decision": "reject" }] })).await.unwrap_err();
    assert_eq!(code(&e), "invalid/proposalClosed");
    assert_eq!(c.ok("proposal.count", json!({})).await["pending"], 0);
    let e = c.call("proposal.withdraw", json!({ "id": pid })).await.unwrap_err();
    assert_eq!(code(&e), "invalid/proposalClosed");
}

#[tokio::test(flavor = "multi_thread")]
async fn what_a_proposal_may_not_touch() {
    let (_env, c) = world(AI).await;
    let (root, a, _b, _d) = shelf(&c).await;
    let one = |item: Value| json!({ "title": "T", "items": [item] });
    let err = |r: Result<Value, ProtocolError>| code(&r.unwrap_err());
    // Not a field the page edits: a number, a read-only field, a secret, a withheld one, an unknown one.
    for f in ["body.n", "body.fixed", "body.key", "body.ans", "body.nothere", "params.x"] {
        let r = tool(&c, "propose", one(json!({ "op": "update", "id": a, "changes": { f: "1" } }))).await;
        assert_eq!(err(r), "invalid/proposalField", "{f}");
    }
    // A name must be a text.
    assert_eq!(err(tool(&c, "propose", one(json!({ "op": "update", "id": a, "changes": { "name": 3 } }))).await), "invalid/proposalField");
    // Not seen, not there.
    let hidden = note(&c, None, "Hidden", "").await;
    assert_eq!(err(tool(&c, "propose", one(json!({ "op": "update", "id": hidden, "changes": { "name": "x" } }))).await), "invalid/proposalTarget");
    assert_eq!(err(tool(&c, "propose", one(json!({ "op": "delete", "id": "nope" }))).await), "invalid/proposalTarget");
    // An AI adds only inside what it was shown.
    assert_eq!(err(tool(&c, "propose", one(json!({ "op": "create", "kind": "t.note:note", "name": "x" }))).await), "invalid/proposalTarget");
    assert_eq!(err(tool(&c, "propose", one(json!({ "op": "create", "kind": "core:env", "parent": root, "name": "x" }))).await), "invalid/proposalKind");
    // Read at another revision.
    assert_eq!(err(tool(&c, "propose", one(json!({ "op": "update", "id": a, "rev": 99, "changes": { "name": "x" } }))).await), "invalid/proposalChanged");
    // Both changed and deleted.
    let r = tool(&c, "propose", json!({ "title": "T", "items": [ { "op": "update", "id": a, "changes": { "name": "x" } }, { "op": "delete", "id": a } ] })).await;
    assert_eq!(err(r), "invalid/proposalSameTarget");
    // Too many items.
    let many: Vec<Value> = (0..51).map(|i| json!({ "op": "create", "kind": "t.note:note", "parent": root, "name": format!("n{i}") })).collect();
    assert!(tool(&c, "propose", json!({ "title": "T", "items": many })).await.is_err());
    // Stamped.
    c.ok("page.event", json!({ "target": format!("resource:{a}"), "event": "sign" })).await;
    assert_eq!(err(tool(&c, "propose", one(json!({ "op": "update", "id": a, "changes": { "name": "x" } }))).await), "invalid/proposalStamped");
    // Nothing was proposed.
    assert_eq!(c.ok("proposal.count", json!({})).await["pending"], 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_switch_and_who_may_propose() {
    let (_env, c) = world(&[("mcp.enabled", "true")]).await;
    let (_root, a, _b, _d) = shelf(&c).await;
    let one = json!({ "title": "T", "items": [{ "op": "update", "id": a, "changes": { "name": "x" } }] });
    // Off by default.
    assert_eq!(c.ok("mcp.status", json!({})).await["allowProposals"], false);
    assert_eq!(code(&tool(&c, "propose", one.clone()).await.unwrap_err()), "denied/aiProposeOff");
    // The other tools are there.
    let tools = c.call_ai("tester", "mcp.tools", json!({})).await.unwrap();
    let names: Vec<&str> = tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["search", "describe", "run", "get_run", "tree", "read", "propose"]);
    // The user may propose (later: what others send), and withdraw it.
    let p = c.ok("proposal.create", one.clone()).await;
    let id = p["id"].as_str().unwrap().to_string();
    assert_eq!(c.ok("proposal.get", json!({ "id": id })).await["proposer"], "user");
    let v = c.ok("proposal.withdraw", json!({ "id": id })).await;
    assert_eq!(v["status"], "withdrawn");
    assert_eq!(code(&c.call("proposal.review", json!({ "id": id, "items": [{ "index": 0, "decision": "accept" }] })).await.unwrap_err()), "invalid/proposalClosed");
    // A plugin, in the user's act.
    let r = c.probe("t.note", "proposals.create", json!([one])).await;
    let pid = r["ok"]["id"].as_str().unwrap_or_else(|| panic!("{r}")).to_string();
    assert!(c.ok("proposal.get", json!({ "id": pid })).await["proposer"].as_str().unwrap().starts_with("plugin:t.note"));
    // An AI client may not review.
    let e = c.call_ai("tester", "proposal.review", json!({ "id": pid, "items": [{ "index": 0, "decision": "accept" }] })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Denied);
}

#[tokio::test(flavor = "multi_thread")]
async fn when_the_original_changed_since() {
    let (_env, c) = world(AI).await;
    let (_root, a, b, d) = shelf(&c).await;
    let rev = |v: &Value| v["rev"].as_i64().unwrap();
    let ra = rev(&body(&c, &a).await);
    let rb = rev(&body(&c, &b).await);
    let p = tool(&c, "propose", json!({ "title": "Two", "items": [
        { "op": "update", "id": a, "rev": ra, "changes": { "body.text": "A by AI" } },
        { "op": "update", "id": b, "rev": rb, "changes": { "body.text": "B by AI" } },
        { "op": "delete", "id": d }
    ] })).await.unwrap();
    let pid = p["proposal"].as_str().unwrap().to_string();
    // The user changes A's name (not what the proposal changes) and B's text (what it changes); D is deleted.
    c.ok("page.save", json!({ "target": format!("resource:{a}"), "changes": { "name": "A renamed" } })).await;
    c.ok("page.save", json!({ "target": format!("resource:{b}"), "changes": { "body.text": "B by user" } })).await;
    c.ok("resource.delete", json!({ "id": d })).await;
    let v = c.ok("proposal.get", json!({ "id": pid })).await;
    assert_eq!(v["items"][0]["stale"], false);
    assert_eq!(v["items"][1]["stale"], true);
    assert_eq!(v["items"][1]["fields"][0]["current"], "B by user");
    assert_eq!(v["items"][1]["fields"][0]["before"], "second chapter");
    assert_eq!(v["items"][1]["fields"][0]["changed"], true);
    assert_eq!(v["items"][2]["gone"], true);
    // Not overlapping: accepted, only its own field written.
    // Overlapping: refused until accepted against what is there now.
    let e = c.call("proposal.review", json!({ "id": pid, "items": [{ "index": 0, "decision": "accept" }, { "index": 1, "decision": "accept" }] })).await.unwrap_err();
    assert_eq!(code(&e), "conflict/proposalStale");
    // One transaction: neither was written.
    assert_eq!(body(&c, &a).await["body"]["text"], "line one\nline two");
    let now_b = rev(&body(&c, &b).await);
    let v = c
        .ok("proposal.review", json!({ "id": pid, "items": [
            { "index": 0, "decision": "accept" }, { "index": 1, "decision": "accept", "basis": now_b }, { "index": 2, "decision": "accept" }
        ] }))
        .await;
    let a_now = body(&c, &a).await;
    assert_eq!((a_now["name"].clone(), a_now["body"]["text"].clone()), (json!("A renamed"), json!("A by AI")));
    assert_eq!(body(&c, &b).await["body"]["text"], "B by AI");
    // The deleted target: void.
    assert_eq!(v["items"][2]["result"], "void");
    assert_eq!(v["status"], "partial");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resource_at_one_revision() {
    let (_env, c) = world(&[]).await;
    let a = note(&c, None, "A", "first").await;
    c.ok("page.save", json!({ "target": format!("resource:{a}"), "changes": { "body.text": "second" } })).await;
    let one = c.ok("resource.at", json!({ "id": a, "rev": 1 })).await;
    assert_eq!((one["name"].clone(), one["body"]["text"].clone()), (json!("A"), json!("first")));
    let two = c.ok("resource.at", json!({ "id": a, "rev": 2 })).await;
    assert_eq!(two["body"]["text"], "second");
    assert_eq!(c.call("resource.at", json!({ "id": a, "rev": 9 })).await.unwrap_err().code, ErrorCode::NotFound);
    // History entries carry their revision.
    let h = c.ok("resource.history", json!({ "id": a })).await;
    assert_eq!(h[0]["rev"], 2);
}
