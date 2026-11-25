//! D484 §16 (K1, K2): files kept by their content — upload by content or by a chosen path, only images, read only by a
//! resource that uses them or the client that just put them; attachment fields and `blob:` images in text; history,
//! purge, unused files going after a day, export and import; the image view node. Temporary folders only.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use onedesk_protocol::ErrorCode;
use serde_json::{json, Value};

/// `pic` has an image field, a text with references, and a page that shows the image; `body.mode` breaks it.
const PICS: &str = r#"
export default {
  activate(host) {
    host.pages.handle("pic", { render(ctx) {
      const b = (ctx.resource && ctx.resource.body) || {};
      const view = [{ type: "form", id: "f", layout: "stack", fields: [
        { name: "image", label: "Image", kind: "attachment", bind: "body.image" },
        { name: "text", label: "Text", kind: "longtext", bind: "body.text" }] }];
      if (b.mode === "bad") view.push({ type: "image", id: "i", blob: "0".repeat(64) });
      else if (b.image && b.image.blob) view.push({ type: "image", id: "i", blob: b.image.blob, width: "small", alt: "x" });
      return { view };
    } });
  },
};
"#;

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    let pkg = root.join("test.pics/0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let m = json!({ "id": "test.pics", "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js",
        "contributes": {
            "kinds": [{ "id": "pic", "label": "pic", "icon": "image", "tree": "resources", "page": "pic",
                "fields": { "image": { "type": "attachment", "accept": ["image"] }, "text": { "type": "longtext", "refs": true } } }],
            "pages": [{ "id": "pic" }]
        } });
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), PICS).unwrap();
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

fn png(w: u32, h: u32, salt: u8) -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    b.extend(w.to_be_bytes());
    b.extend(h.to_be_bytes());
    b.extend([8, 6, 0, 0, 0, salt]);
    b
}

fn b64(b: &[u8]) -> String {
    onedesk_kernel::secrets::base64(b)
}

async fn put(c: &Client, client: &str, bytes: &[u8]) -> Value {
    c.call_as(Some(client), "blob.put", json!({ "data": b64(bytes) })).await.unwrap()
}

async fn read(c: &Client, client: &str, blob: &str, resource: Option<&str>) -> Result<Value, onedesk_protocol::ProtocolError> {
    c.call_as(Some(client), "blob.read", json!({ "blob": blob, "resource": resource })).await
}

async fn create(c: &Client, changes: Value) -> String {
    let r = c.ok("page.save", json!({ "target": "new:test.pics:pic", "changes": changes })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

fn db(env: &Env) -> rusqlite::Connection {
    let mut found = None;
    for e in walk(env.tmp.path()) {
        if e.file_name().is_some_and(|n| n == "workspace.db") {
            found = Some(e);
        }
    }
    rusqlite::Connection::open(found.expect("workspace.db")).unwrap()
}

fn walk(p: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn images_are_stored_by_content_and_only_images_are_taken() {
    let (env, c) = world().await;
    let a = put(&c, "one", &png(640, 480, 1)).await;
    assert_eq!((a["type"].as_str(), a["width"].as_u64(), a["height"].as_u64()), (Some("image/png"), Some(640), Some(480)), "{a}");
    let blob = a["blob"].as_str().unwrap().to_string();
    assert_eq!(blob.len(), 64);
    // The same content is the same blob.
    assert_eq!(put(&c, "one", &png(640, 480, 1)).await["blob"], json!(blob));
    // Not an image (svg, text, a renamed file), or too large: refused.
    for bad in [b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec(), b"hello".to_vec()] {
        let e = c.call_as(Some("one"), "blob.put", json!({ "data": b64(&bad) })).await.unwrap_err();
        assert_eq!(e.params.get("reason").map(String::as_str), Some("notAnImage"), "{e:?}");
    }
    let huge = "A".repeat(28 * 1024 * 1024);
    let e = c.call_as(Some("one"), "blob.put", json!({ "data": huge })).await.unwrap_err();
    assert_eq!(e.params.get("reason").map(String::as_str), Some("tooLarge"));
    // A file the user chose.
    let f = env.tmp.path().join("chosen.png");
    std::fs::write(&f, png(10, 20, 2)).unwrap();
    let b = c.call_as(Some("one"), "blob.put", json!({ "path": f.to_string_lossy() })).await.unwrap();
    assert_eq!(b["width"], json!(10));
    // The audit says a file came, never what it holds.
    let audit = c.ok("audit.list", json!({ "operation": "blob.put" })).await.to_string();
    assert!(audit.contains("image/png") && !audit.contains("IHDR"), "{audit}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_blob_is_read_by_the_client_that_put_it_and_by_the_resources_that_use_it() {
    let (_env, c) = world().await;
    let blob = put(&c, "one", &png(4, 4, 3)).await["blob"].as_str().unwrap().to_string();
    let r = read(&c, "one", &blob, None).await.unwrap();
    assert_eq!(r["type"], "image/png");
    assert!(read(&c, "two", &blob, None).await.is_err(), "another client cannot");
    // An attachment field that names it; a text that shows it.
    let att = json!({ "blob": blob, "name": "a.png", "type": "image/png", "size": 30 });
    let pic = create(&c, json!({ "name": "P", "body.image": att })).await;
    assert!(read(&c, "two", &blob, Some(&pic)).await.is_ok(), "through the resource that uses it");
    let other = create(&c, json!({ "name": "Q" })).await;
    assert!(read(&c, "two", &blob, Some(&other)).await.is_err(), "not through another one");
    let blob2 = put(&c, "one", &png(4, 4, 4)).await["blob"].as_str().unwrap().to_string();
    let doc = create(&c, json!({ "name": "D", "body.text": format!("Look: ![shot](blob:{blob2})") })).await;
    assert!(read(&c, "two", &blob2, Some(&doc)).await.is_ok());
    // An attachment that is not a stored file is refused.
    let e = c.call("page.save", json!({ "target": "new:test.pics:pic", "changes": { "name": "X", "body.image": { "blob": "f".repeat(64) } } })).await.unwrap_err();
    assert_eq!(e.params.get("reason").map(String::as_str), Some("unknownBlob"), "{e:?}");
    // The page draws it; an image node of a file not stored is the plugin's error.
    let page = c.ok("page.resolve", json!({ "target": format!("resource:{pic}") })).await;
    let node = page["view"].as_array().unwrap().iter().find(|n| n["type"] == "image").cloned().unwrap();
    assert_eq!((node["blob"].as_str(), node["width"].as_str()), (Some(blob.as_str()), Some("small")));
    // Saved, though the page drawn after it is refused.
    let _ = c.call("page.save", json!({ "target": format!("resource:{other}"), "changes": { "body.mode": "bad" } })).await;
    let e = c.call("page.resolve", json!({ "target": format!("resource:{other}") })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::PluginError);
}

#[tokio::test(flavor = "multi_thread")]
async fn history_keeps_old_images_purge_lets_them_go_and_unused_ones_go_after_a_day() {
    let (env, c) = world().await;
    let old = put(&c, "one", &png(4, 4, 5)).await["blob"].as_str().unwrap().to_string();
    let new = put(&c, "one", &png(4, 4, 6)).await["blob"].as_str().unwrap().to_string();
    let att = |b: &str| json!({ "blob": b, "name": "a.png", "type": "image/png", "size": 30 });
    let pic = create(&c, json!({ "name": "P", "body.image": att(&old) })).await;
    c.ok("page.save", json!({ "target": format!("resource:{pic}"), "changes": { "body.image": att(&new) } })).await;
    // The old image is still there for the history; restoring it works.
    assert!(read(&c, "two", &old, Some(&pic)).await.is_ok());
    let h = c.ok("resource.history", json!({ "id": pic })).await;
    let entry = h.as_array().unwrap().iter().find(|e| e["field"] == "body.image" && e["op"] == "update").unwrap()["id"].clone();
    c.ok("resource.restore", json!({ "id": pic, "entryId": entry })).await;
    assert_eq!(c.ok("resource.get", json!({ "id": pic })).await["body"]["image"]["blob"], json!(old));
    // Put a day ago and never used: it goes with the next upload.
    let stray = put(&c, "one", &png(4, 4, 7)).await["blob"].as_str().unwrap().to_string();
    let conn = db(&env);
    conn.execute("UPDATE blobs SET created_at = 0 WHERE hash = ?1", [&stray]).unwrap();
    put(&c, "one", &png(4, 4, 8)).await;
    let left: i64 = conn.query_row("SELECT count(*) FROM blobs WHERE hash = ?1", [&stray], |r| r.get(0)).unwrap();
    assert_eq!(left, 0, "an unused file goes");
    assert!(!walk(env.tmp.path()).iter().any(|p| p.file_name().is_some_and(|n| n.to_string_lossy() == stray)), "and its file");
    // Purged: its files are no longer kept for it; they go once a day has passed.
    c.ok("resource.delete", json!({ "id": pic })).await;
    c.ok("resource.purge", json!({ "id": pic })).await;
    let uses: i64 = conn.query_row("SELECT count(*) FROM blob_uses WHERE resource_id = ?1", [&pic], |r| r.get(0)).unwrap();
    assert_eq!(uses, 0);
    conn.execute("UPDATE blobs SET created_at = 0", []).unwrap();
    put(&c, "one", &png(4, 4, 9)).await;
    let n: i64 = conn.query_row("SELECT count(*) FROM blobs WHERE hash IN (?1, ?2)", [&old, &new], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn export_and_import_carry_the_files() {
    let (env, c) = world().await;
    let blob = put(&c, "one", &png(8, 8, 10)).await["blob"].as_str().unwrap().to_string();
    let att = json!({ "blob": blob, "name": "a.png", "type": "image/png", "size": 30 });
    create(&c, json!({ "name": "Exported pic", "body.image": att })).await;
    let folder = env.tmp.path().join("out");
    let r = c.ok("workspace.export", json!({ "folder": folder.to_string_lossy() })).await;
    assert_eq!(r["blobs"], json!(1), "{r}");
    assert!(folder.join("blobs").join(&blob).exists());
    // Into another workspace.
    let (_env2, c2) = world().await;
    let p = c2.ok("workspace.importPreview", json!({ "folder": folder.to_string_lossy() })).await;
    c2.ok("workspace.import", json!({ "folder": folder.to_string_lossy(), "fingerprint": p["fingerprint"] })).await;
    let found = c2.ok("search.query", json!({ "text": "Exported pic" })).await;
    let id = found[0]["target"].as_str().unwrap().trim_start_matches("resource:").to_string();
    let got = read(&c2, "x", &blob, Some(&id)).await.unwrap();
    assert_eq!(got["type"], "image/png");
}
