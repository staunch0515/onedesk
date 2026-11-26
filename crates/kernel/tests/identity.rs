//! D487 §33 (docs/redesign/book.md, K18): a workspace's identity (Ed25519; the private key only in the keychain), its
//! card, the contacts, and signed stamps. Temporary folders and an in-memory keychain only; a generic test plugin.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::*;
use onedesk_kernel::secrets::{MemoryStore, SecretStore, SecretStoreHandle};
use onedesk_protocol::ErrorCode;
use serde_json::{json, Value};

const MAIN: &str = r#"
export default {
  activate(host) {
    host.pages.handle("paper", {
      render() { return { view: [{ type: "form", id: "f", layout: "stack", fields: [{ name: "text", label: "Text", kind: "longtext", bind: "body.text" }] }] }; },
      async onEvent(ctx, event) {
        try {
          if (event === "sign") await ctx.host.resources.stamp(ctx.resource.id, { label: "Signed", signer: "Dr. A" });
          return { message: { "en-US": "ok" } };
        } catch (e) {
          return { message: { "en-US": e.code + "/" + ((e.params || {}).reason || "") } };
        }
      },
    });
  },
};
"#;

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    let pkg = root.join("test.paper").join("0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let m = json!({ "id": "test.paper", "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js", "requires": { "resources": true },
        "contributes": {
            "kinds": [{ "id": "paper", "label": "paper", "icon": "box", "tree": "resources", "draggable": true, "page": "paper", "accepts": [], "fields": { "text": { "type": "longtext" } } }],
            "pages": [{ "id": "paper", "actions": [{ "id": "sign", "role": "event", "label": "sign", "icon": "box" }] }]
        } });
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), MAIN).unwrap();
    root
}

struct W {
    env: Env,
    c: Client,
    keys: Arc<MemoryStore>,
}

async fn world() -> W {
    let tmp = tempfile::tempdir().unwrap();
    let root = plugins(tmp.path());
    let (handle, keys): (SecretStoreHandle, Arc<MemoryStore>) = SecretStoreHandle::memory();
    let mut cfg = config_for(&root);
    cfg.secrets = handle;
    let env = open_with(tmp, &root, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    W { env, c, keys }
}

fn db(w: &W) -> rusqlite::Connection {
    rusqlite::Connection::open(w.env.path().join("ws").join(onedesk_kernel::workspace::DB_FILE)).unwrap()
}

fn code(e: &onedesk_protocol::ProtocolError) -> String {
    let c = serde_json::to_value(e.code).unwrap();
    format!("{}/{}", c.as_str().unwrap(), e.params.get("reason").map(String::as_str).unwrap_or(""))
}

async fn paper(c: &Client, text: &str) -> String {
    let r = c.ok("page.save", json!({ "target": "new:test.paper:paper", "changes": { "name": "Paper", "body.text": text } })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_identity_is_made_by_the_user_and_its_private_key_stays_in_the_keychain() {
    let w = world().await;
    assert_eq!(w.c.ok("identity.get", json!({})).await, Value::Null);
    assert_eq!(w.c.call("identity.create", json!({ "name": "  " })).await.unwrap_err().code, ErrorCode::InvalidParams);
    let id = w.c.ok("identity.create", json!({ "name": "Zhang", "org": "School" })).await;
    let fp = id["fingerprint"].as_str().unwrap();
    assert_eq!(fp.split(' ').count(), 8);
    assert_eq!(id["publicKey"].as_str().unwrap().len(), 64);
    // The private key: one keychain entry no secret name can reach; not in the secrets list, not in the database.
    let accounts = w.keys.accounts();
    let account = accounts.iter().find(|a| a.ends_with("/#identity")).expect("key in the keychain").clone();
    let seed = w.keys.get(&account).unwrap().unwrap();
    assert_eq!(seed.len(), 64);
    let listed = w.c.ok("secrets.list", json!({})).await;
    assert!(!listed.to_string().contains("identity"), "{listed}");
    let dbfile = std::fs::read(w.env.path().join("ws").join(onedesk_kernel::workspace::DB_FILE)).unwrap();
    assert!(!String::from_utf8_lossy(&dbfile).contains(&seed));
    // One per workspace; the name changes, the key does not.
    assert_eq!(code(&w.c.call("identity.create", json!({ "name": "Again" })).await.unwrap_err()), "conflict/exists");
    let up = w.c.ok("identity.update", json!({ "name": "Zhang Wei" })).await;
    assert_eq!((up["name"].as_str(), up["publicKey"].clone(), up["org"].as_str()), (Some("Zhang Wei"), id["publicKey"].clone(), Some("School")));
    // Audited.
    assert_eq!(w.c.ok("audit.list", json!({ "operation": "identity.create" })).await.as_array().unwrap().len(), 1);
    // Deleted: the key goes too; a new one is another key.
    w.c.ok("identity.delete", json!({})).await;
    assert_eq!(w.c.ok("identity.get", json!({})).await, Value::Null);
    assert!(w.keys.get(&account).unwrap().is_none());
    let again = w.c.ok("identity.create", json!({ "name": "Zhang" })).await;
    assert_ne!(again["publicKey"], id["publicKey"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn cards_go_into_the_contacts_one_per_key_and_are_checked_by_the_user() {
    let a = world().await;
    let b = world().await;
    a.c.ok("identity.create", json!({ "name": "Zhang" })).await;
    b.c.ok("identity.create", json!({ "name": "Li" })).await;
    let card = a.env.path().join("zhang.odid");
    a.c.ok("identity.exportCard", json!({ "path": card.display().to_string() })).await;
    let r = b.c.ok("contact.importCard", json!({ "path": card.display().to_string() })).await;
    assert_eq!(r["created"], true);
    let id = r["id"].as_str().unwrap().to_string();
    let contact = b.c.ok("resource.get", json!({ "id": id })).await;
    assert_eq!((contact["kind"].as_str(), contact["name"].as_str(), contact["body"]["checked"].clone()), (Some("core:contact"), Some("Zhang"), json!(false)));
    let page = b.c.ok("page.resolve", json!({ "target": format!("resource:{id}") })).await;
    assert_eq!(page["page"], "contact");
    let kids = b.c.ok("tree.children", json!({ "tree": "contacts" })).await;
    assert_eq!(kids["nodes"][0]["key"], id.as_str());
    // The same card again: the same contact.
    assert_eq!(b.c.ok("contact.importCard", json!({ "path": card.display().to_string() })).await["created"], false);
    // A changed card is refused; so is one's own.
    let mut forged: Value = serde_json::from_slice(&std::fs::read(&card).unwrap()).unwrap();
    forged["name"] = json!("Zhang (boss)");
    let bad = a.env.path().join("forged.odid");
    std::fs::write(&bad, serde_json::to_vec(&forged).unwrap()).unwrap();
    assert_eq!(code(&b.c.call("contact.importCard", json!({ "path": bad.display().to_string() })).await.unwrap_err()), "invalid/badCard");
    assert_eq!(code(&a.c.call("contact.importCard", json!({ "path": card.display().to_string() })).await.unwrap_err()), "invalid/ownCard");
    // Checked by the user; the key never changes.
    b.c.ok("contact.setChecked", json!({ "id": id, "checked": true })).await;
    assert_eq!(b.c.ok("resource.get", json!({ "id": id })).await["body"]["checked"], true);
    let e = b.c.call("page.save", json!({ "target": format!("resource:{id}"), "changes": { "body.publicKey": "00" } })).await.unwrap_err();
    // (the page binds no field: refused before the pipeline's own check, `badContact`)
    assert_eq!(code(&e), "denied/readOnlyField");
    // A renamed contact is renamed; exporting it gives the card it came with.
    b.c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "name": "Teacher Zhang" } })).await;
    let out = b.env.path().join("again.odid");
    b.c.ok("contact.exportCard", json!({ "id": id, "path": out.display().to_string() })).await;
    let back: Value = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
    assert_eq!(back["publicKey"], forged["publicKey"]);
    assert_eq!(back["name"], "Zhang");
}

#[tokio::test(flavor = "multi_thread")]
async fn stamps_are_signed_and_verified_against_the_content() {
    let w = world().await;
    let event = |id: String| json!({ "target": format!("resource:{id}"), "event": "sign" });
    // Without an identity: stamped, unsigned.
    let p0 = paper(&w.c, "first").await;
    w.c.ok("page.event", event(p0.clone())).await;
    let r = w.c.ok("resource.get", json!({ "id": p0 })).await;
    assert_eq!(r["stamps"][0]["verified"], "unsigned");
    assert!(r["stamps"][0].get("signedBy").is_none());
    // With one: signed, valid, by this workspace.
    w.c.ok("identity.create", json!({ "name": "Dr. A" })).await;
    let p = paper(&w.c, "the text").await;
    w.c.ok("page.event", event(p.clone())).await;
    let r = w.c.ok("resource.get", json!({ "id": p })).await;
    assert_eq!(r["stamps"][0]["verified"], "valid", "{r}");
    assert_eq!((r["stamps"][0]["signedBy"]["name"].as_str(), r["stamps"][0]["signedBy"]["known"].as_str()), (Some("Dr. A"), Some("self")));
    // Moving it is no change of content.
    let folder = w.c.ok("tree.createGroup", json!({ "tree": "resources", "parent": null, "name": "Folder" })).await["key"].as_str().unwrap().to_string();
    w.c.ok("tree.move", json!({ "tree": "resources", "key": p, "target": folder, "position": "inside" })).await;
    assert_eq!(w.c.ok("resource.get", json!({ "id": p })).await["stamps"][0]["verified"], "valid");
    // A new name signs with the new name; the old signature keeps the old one and stays valid.
    w.c.ok("identity.update", json!({ "name": "Dr. Anna" })).await;
    let r = w.c.ok("resource.get", json!({ "id": p })).await;
    assert_eq!((r["stamps"][0]["verified"].as_str(), r["stamps"][0]["signedBy"]["name"].as_str()), (Some("valid"), Some("Dr. A")));
    // The content changed behind the kernel's back (someone edited the database): invalid.
    db(&w).execute("UPDATE resources SET body = json_set(body, '$.text', 'changed') WHERE id = ?1", [&p]).unwrap();
    assert_eq!(w.c.ok("resource.get", json!({ "id": p })).await["stamps"][0]["verified"], "invalid");
    // The identity deleted: the signature still checks out, by a key no longer known.
    let q = paper(&w.c, "q").await;
    w.c.ok("page.event", event(q.clone())).await;
    w.c.ok("identity.delete", json!({})).await;
    let r = w.c.ok("resource.get", json!({ "id": q })).await;
    assert_eq!((r["stamps"][0]["verified"].as_str(), r["stamps"][0]["signedBy"]["known"].as_str()), (Some("valid"), Some("unknown")));
}
