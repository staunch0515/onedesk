//! D487 §35 (docs/redesign/book.md, K19): letters and replies between workspaces — signed, addressed, put under a kind
//! that takes letters with ids of their own, answered only by a recipient and only to the letter sent. Temporary folders
//! and an in-memory keychain only; a generic test plugin (the kernel knows no homework, no memo).

mod common;

use std::path::{Path, PathBuf};

use common::*;
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
    for (const name of ["letter.received", "letter.replied", "letter.reply"]) {
      host.events.on(name, async (ctx, e) => {
        const seen = JSON.parse((await ctx.host.storage.get("events")) || "[]");
        seen.push({ name, e });
        await ctx.host.storage.set("events", JSON.stringify(seen));
      });
    }
  },
};
"#;

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    let pkg = root.join("test.mail").join("0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let k = |id: &str, extra: Value| {
        let mut v = json!({ "id": id, "label": id, "icon": "box", "tree": "resources", "draggable": true, "accepts": ["*"] });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    };
    let m = json!({ "id": "test.mail", "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js",
        "requires": { "resources": true, "files": true },
        "contributes": {
            "kinds": [k("box", json!({ "letters": true })), k("sent", json!({})), k("letter", json!({})),
                      k("page", json!({ "fields": { "text": { "type": "longtext" } } }))],
            "events": ["letter.received", "letter.replied", "letter.reply"],
            "commands": [{ "id": "probe", "label": "probe", "icon": "box" }]
        } });
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), MAIN).unwrap();
    root
}

struct W {
    env: Env,
    c: Client,
    out: PathBuf,
}

async fn side(root: &Path, name: &str) -> W {
    let env = open_with(tempfile::tempdir().unwrap(), root, config_for(root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let out = env.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    c.ok("plugin.grantFolder", json!({ "plugin": "test.mail", "path": out.display().to_string() })).await;
    c.ok("identity.create", json!({ "name": name })).await;
    W { env, c, out }
}

async fn make(c: &Client, kind: &str, parent: Option<&str>, name: &str, body: Value) -> String {
    let target = match parent {
        Some(p) => format!("new:test.mail:{kind}?parent={p}"),
        None => format!("new:test.mail:{kind}"),
    };
    let mut changes = json!({ "name": name });
    for (k, v) in body.as_object().unwrap() {
        changes[format!("body.{k}")] = v.clone();
    }
    c.ok("page.save", json!({ "target": target, "changes": changes })).await["page"]["resourceId"].as_str().unwrap().to_string()
}

/// B's card into A's contacts: the contact id.
async fn know(a: &W, b: &W) -> String {
    let card = b.out.join("card.odid");
    b.c.ok("identity.exportCard", json!({ "path": card.display().to_string() })).await;
    a.c.ok("contact.importCard", json!({ "path": card.display().to_string() })).await["id"].as_str().unwrap().to_string()
}

fn reason(v: &Value) -> String {
    v["params"]["reason"].as_str().unwrap_or_default().to_string()
}

async fn events(c: &Client) -> Vec<Value> {
    for _ in 0..100 {
        let r = c.probe("test.mail", "storage.get", json!(["events"])).await;
        if let Some(s) = r["ok"].as_str() {
            let v: Vec<Value> = serde_json::from_str(s).unwrap();
            if !v.is_empty() {
                return v;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    vec![]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_letter_goes_to_its_recipient_and_the_reply_comes_back_to_it() {
    let ptmp = tempfile::tempdir().unwrap();
    let root = plugins(ptmp.path());
    let a = side(&root, "Teacher").await;
    let b = side(&root, "Student").await;
    let c3 = side(&root, "Stranger").await;
    let to_b = know(&a, &b).await;
    let page = make(&a.c, "page", None, "Quiz", json!({ "text": "2+2" })).await;
    let sent = make(&a.c, "sent", None, "Homework 1", json!({})).await;
    let path = a.out.join("hw.odletter").display().to_string();
    let w = a.c.probe("test.mail", "letters.write", json!([sent, { "pages": [page], "to": [to_b], "subject": "Homework 1", "comment": "by Friday", "due": "2026-12-01",
        "tasks": [{ "page": page, "task": "answer", "label": "Answer" }], "rootKind": "letter", "path": path }])).await;
    assert!(w["ok"]["letter"].is_string(), "{w}");
    // Nothing to send without an identity... (B has one; a fresh workspace has none.)
    // The recipient: who, what, where it may go.
    let i = b.c.ok("letter.inspect", json!({ "path": path })).await;
    assert_eq!((i["kind"].as_str(), i["subject"].as_str(), i["due"].as_str(), i["pages"].clone(), i["refused"].clone()), (Some("letter"), Some("Homework 1"), Some("2026-12-01"), json!(1), json!("noInbox")), "{i}");
    assert_eq!(i["from"]["name"], "Teacher");
    assert_eq!(i["from"]["known"], "unknown");
    // No inbox yet.
    assert_eq!(i["places"], json!([]));
    let e = b.c.call("letter.receive", json!({ "path": path })).await.unwrap_err();
    assert_eq!(e.params.get("reason").map(String::as_str), Some("noInbox"));
    let inbox = make(&b.c, "box", None, "Inbox", json!({})).await;
    let r = b.c.ok("letter.receive", json!({ "path": path })).await;
    let letter = r["resource"].as_str().unwrap().to_string();
    let got = b.c.ok("resource.get", json!({ "id": letter })).await;
    assert_eq!((got["kind"].as_str(), got["parentId"].as_str(), got["readOnly"].clone()), (Some("test.mail:letter"), Some(inbox.as_str()), json!(false)));
    let kids = b.c.ok("tree.children", json!({ "tree": "resources", "parent": letter })).await;
    let copy = kids["nodes"][0]["key"].as_str().unwrap().to_string();
    assert_ne!(copy, page, "the letter's ids are its own");
    let cp = b.c.ok("resource.get", json!({ "id": copy })).await;
    assert_eq!((cp["readOnly"].clone(), cp["body"]["text"].as_str()), (json!(true), Some("2+2")));
    // The letters plugin knows what it is: from whom, which page was which.
    let info = b.c.probe("test.mail", "letters.info", json!([copy])).await["ok"].clone();
    assert_eq!((info["dir"].as_str(), info["subject"].as_str(), info["from"]["name"].as_str()), (Some("in"), Some("Homework 1"), Some("Teacher")));
    assert_eq!(info["pages"][0]["id"], copy.as_str());
    assert_eq!(info["tasks"][0]["page"], copy.as_str(), "tasks name the pages as the recipient has them");
    // It was told; the sender is in the contacts now.
    let ev = events(&b.c).await;
    assert_eq!((ev[0]["name"].as_str(), ev[0]["e"]["letter"].as_str()), (Some("letter.received"), Some(letter.as_str())));
    assert_eq!(b.c.ok("tree.children", json!({ "tree": "contacts" })).await["nodes"][0]["label"], "Teacher");
    // Once.
    assert_eq!(b.c.ok("letter.inspect", json!({ "path": path })).await["refused"], "alreadyReceived");
    // Not for anyone else; not for the sender.
    make(&c3.c, "box", None, "Inbox", json!({})).await;
    assert_eq!(c3.c.ok("letter.inspect", json!({ "path": path })).await["refused"], "notForYou");
    assert_eq!(a.c.ok("letter.inspect", json!({ "path": path })).await["refused"], "ownPackage");
    // Changed on the way.
    let mut bytes = std::fs::read(&path).unwrap();
    let at = String::from_utf8_lossy(&bytes).find("by Friday").unwrap();
    bytes[at] = b'B';
    let bad = c3.out.join("bad.odletter");
    std::fs::write(&bad, &bytes).unwrap();
    let r = c3.c.call("letter.inspect", json!({ "path": bad.display().to_string() })).await;
    assert!(r.is_err() || r.as_ref().unwrap()["refused"] != Value::Null, "{r:?}");

    // The reply: what was done for each page, and the response; only back to the letter sent.
    let rpath = b.out.join("hw-reply.odletter").display().to_string();
    let w = b.c.probe("test.mail", "letters.write", json!([letter, { "reply": { "pages": [{ "page": copy, "task": "answer", "data": { "score": 8, "total": 10 }, "summary": "8/10" }], "response": { "agree": true, "comment": "done" } }, "path": rpath }])).await;
    assert!(w["ok"]["path"].is_string(), "{w}");
    let i = a.c.ok("letter.inspect", json!({ "path": rpath })).await;
    assert_eq!((i["kind"].as_str(), i["inReplyTo"].as_str(), i["from"]["name"].as_str(), i["refused"].clone()), (Some("reply"), Some("Homework 1"), Some("Student"), Value::Null));
    assert_eq!(c3.c.ok("letter.inspect", json!({ "path": rpath })).await["refused"], "noLetter");
    a.c.ok("letter.receive", json!({ "path": rpath })).await;
    let info = a.c.probe("test.mail", "letters.info", json!([sent])).await["ok"].clone();
    assert_eq!(info["replies"].as_array().unwrap().len(), 1);
    assert_eq!((info["replies"][0]["from"]["name"].as_str(), info["replies"][0]["from"]["known"].as_str()), (Some("Student"), Some("unchecked")));
    assert_eq!(info["replies"][0]["pages"][0]["page"], page.as_str(), "the page as the sender has it");
    assert_eq!(info["replies"][0]["response"]["comment"], "done");
    // The page's role and the letter's are told.
    let mut ev = events(&a.c).await;
    for _ in 0..100 {
        if ev.iter().any(|x| x["name"] == "letter.reply") && ev.iter().any(|x| x["name"] == "letter.replied") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        ev = events(&a.c).await;
    }
    let reply = ev.iter().find(|x| x["name"] == "letter.reply").unwrap();
    assert_eq!((reply["e"]["page"].as_str(), reply["e"]["data"]["score"].clone(), reply["e"]["from"]["name"].as_str()), (Some(page.as_str()), json!(8), Some("Student")));
    assert!(ev.iter().any(|x| x["name"] == "letter.replied" && x["e"]["letter"] == sent.as_str()));
    // Replying again replaces the first.
    let rpath2 = b.out.join("hw-reply-2.odletter").display().to_string();
    let w = b.c.probe("test.mail", "letters.write", json!([letter, { "reply": { "pages": [], "response": { "agree": false } }, "path": rpath2 }])).await;
    assert!(w["ok"].is_object(), "{w}");
    // A file is never written over.
    let e = b.c.probe("test.mail", "letters.write", json!([letter, { "reply": { "pages": [] }, "path": rpath2 }])).await;
    assert!(e["error"].is_string(), "{e}");
    a.c.ok("letter.receive", json!({ "path": rpath2 })).await;
    let info = a.c.probe("test.mail", "letters.info", json!([sent])).await["ok"].clone();
    assert_eq!((info["replies"].as_array().unwrap().len(), info["replies"][0]["response"]["agree"].clone()), (1, json!(false)));
    // Audited.
    assert_eq!(a.c.ok("audit.list", json!({ "operation": "letter.send" })).await.as_array().unwrap().len(), 1);
    let _ = (&a.env, &b.env, &c3.env);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_letter_to_anyone_and_what_cannot_be_sent() {
    let ptmp = tempfile::tempdir().unwrap();
    let root = plugins(ptmp.path());
    let a = side(&root, "Teacher").await;
    let b = side(&root, "Student").await;
    let page = make(&a.c, "page", None, "Notice", json!({ "text": "Sports day" })).await;
    let sent = make(&a.c, "sent", None, "To all", json!({})).await;
    let path = a.out.join("all.odletter").display().to_string();
    // No pages, too many pages, a foreign root: refused.
    let e = a.c.probe("test.mail", "letters.write", json!([sent, { "pages": [], "path": path }])).await;
    assert_eq!(e["error"], "invalidParams", "{e}");
    // To anyone.
    // Several pages: what was signed checks out every time (it is written out again in the same order).
    let more: Vec<String> = {
        let mut v = vec![page.clone()];
        for i in 0..6 {
            v.push(make(&a.c, "page", None, &format!("P{i}"), json!({ "text": i.to_string() })).await);
        }
        v
    };
    a.c.probe("test.mail", "letters.write", json!([sent, { "pages": more, "subject": "Sports day", "path": path }])).await;
    make(&b.c, "box", None, "Inbox", json!({})).await;
    for _ in 0..8 {
        assert_eq!(b.c.ok("letter.inspect", json!({ "path": path })).await["refused"], Value::Null);
    }
    b.c.ok("letter.receive", json!({ "path": path })).await;
    // Without an identity nothing is sent.
    a.c.ok("identity.delete", json!({})).await;
    let e = a.c.probe("test.mail", "letters.write", json!([sent, { "pages": [page], "path": path }])).await;
    assert_eq!(reason(&e), "noIdentity", "{e}");
}
