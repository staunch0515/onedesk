//! D487 §21 (docs/redesign/book.md): a subtree published as a package and kept as an edition (K9), withheld fields
//! with fingerprints and the keychain (K10), read-only copies in another workspace. Temporary folders only; generic
//! packages (the kernel knows no book).

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
    return [{ type: "copy", text: JSON.stringify({ error: e.code || String(e), params: e.params || {}, detail: e.detail || null }) }];
  }
}
"#;

/// `shelf` holds anything; `q` has a withheld `answer` (sealed with its accepted writings when `body.seal`) and a
/// withheld `note` (never sealed).
const PUB: &str = r#"
export default {
  activate(host) {
    host.commands.handle("probe", probe);
    host.kinds.handle("q", {
      async seal(ctx) {
        const b = ctx.resource.body || {};
        if (!b.seal) return { checks: {} };
        return { checks: { answer: [String(b.answer).trim().toLowerCase(), "eight"] } };
      },
    });
  },
};
"#;

fn write_pkg(root: &Path, id: &str, extra: Value, contributes: Value, main: &str) {
    let pkg = root.join(id).join("0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let mut m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js", "contributes": contributes });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(
        pkg.join("manifest.json"),
        serde_json::to_vec_pretty(&m).unwrap(),
    )
    .unwrap();
    std::fs::write(pkg.join("main.js"), format!("{PROBE}\n{main}")).unwrap();
}

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    let probe = json!({ "id": "probe", "label": "probe", "icon": "box" });
    write_pkg(
        &root,
        "test.pub",
        json!({ "requires": { "resources": true, "files": true } }),
        json!({
            "kinds": [
                { "id": "shelf", "label": "shelf", "icon": "box", "tree": "resources", "draggable": true, "accepts": ["*"] },
                { "id": "q", "label": "q", "icon": "box", "tree": "resources", "draggable": true,
                  "fields": { "answer": { "type": "text", "withheld": true }, "note": { "type": "longtext", "withheld": true },
                              "image": { "type": "attachment", "accept": ["image"] } } }
            ],
            "commands": [probe]
        }),
        PUB,
    );
    write_pkg(
        &root,
        "test.other",
        json!({ "requires": { "resources": true, "files": true } }),
        json!({ "commands": [probe] }),
        "export default { activate(host) { host.commands.handle(\"probe\", probe); } };",
    );
    root
}

struct Side {
    env: Env,
    c: Client,
    out: PathBuf,
}

async fn side(tmp: tempfile::TempDir, root: &Path) -> Side {
    let env = open_with(tmp, root, config_for(root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let out = env.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    c.ok(
        "plugin.grantFolder",
        json!({ "plugin": "test.pub", "path": out.display().to_string() }),
    )
    .await;
    // D487 §33: what is published is signed.
    c.ok("identity.create", json!({ "name": "Side" })).await;
    Side { env, c, out }
}

/// A teacher and a student: two workspaces with the same plugins.
async fn two() -> (Side, Side, tempfile::TempDir) {
    let ptmp = tempfile::tempdir().unwrap();
    let root = plugins(ptmp.path());
    let a = side(tempfile::tempdir().unwrap(), &root).await;
    let b = side(tempfile::tempdir().unwrap(), &root).await;
    (a, b, ptmp)
}

async fn create(c: &Client, kind: &str, parent: Option<&str>, changes: Value) -> String {
    let target = match parent {
        Some(p) => format!("new:{kind}?parent={p}"),
        None => format!("new:{kind}"),
    };
    let r = c
        .ok("page.save", json!({ "target": target, "changes": changes }))
        .await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

fn png() -> Vec<u8> {
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    png.extend(4u32.to_be_bytes());
    png.extend(4u32.to_be_bytes());
    png.extend([8, 6, 0, 0, 0, 9]);
    png
}

/// A shelf with: q1 (sealed answer, an image), q2 (answer not sealed), and an extra page `x` with a child.
async fn book(s: &Side) -> (String, String, String, String, String) {
    let put =
        s.c.call_as(
            Some("one"),
            "blob.put",
            json!({ "data": onedesk_kernel::secrets::base64(&png()) }),
        )
        .await
        .unwrap();
    let blob = put["blob"].as_str().unwrap().to_string();
    let root = create(&s.c, "test.pub:shelf", None, json!({ "name": "Math" })).await;
    let q1 = create(&s.c, "test.pub:q", Some(&root), json!({ "name": "Q1", "body.answer": "8", "body.note": "because", "body.seal": true,
        "body.image": { "blob": blob, "name": "a.png", "type": "image/png", "size": png().len() } })).await;
    let q2 = create(
        &s.c,
        "test.pub:q",
        Some(&root),
        json!({ "name": "Q2", "body.answer": "secret", "body.note": "n" }),
    )
    .await;
    let x = create(
        &s.c,
        "test.pub:shelf",
        Some(&root),
        json!({ "name": "Teacher notes" }),
    )
    .await;
    create(
        &s.c,
        "test.pub:q",
        Some(&x),
        json!({ "name": "Inside notes", "body.answer": "1" }),
    )
    .await;
    (root, q1, q2, x, blob)
}

async fn publish(s: &Side, op: &str, root: &str, opts: Value) -> Value {
    s.c.probe("test.pub", &format!("packages.{op}"), json!([root, opts]))
        .await
}

fn file(s: &Side, name: &str) -> String {
    s.out.join(name).display().to_string()
}

async fn names(c: &Client, parent: &str) -> Vec<String> {
    let k = c
        .ok(
            "tree.children",
            json!({ "tree": "resources", "parent": parent }),
        )
        .await;
    k["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["label"].as_str().unwrap().to_string())
        .collect()
}

fn db(s: &Side) -> rusqlite::Connection {
    rusqlite::Connection::open(
        s.env
            .path()
            .join("ws")
            .join(onedesk_kernel::workspace::DB_FILE),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_published_edition_is_kept_and_variants_drop_what_they_should() {
    let (t, _s, _p) = two().await;
    let (root, q1, q2, x, blob) = book(&t).await;
    // Teacher variant: everything.
    let r = publish(&t, "publish", &root, json!({ "edition": 1, "printing": 1, "variant": "teacher", "path": file(&t, "math-teacher.odpack") })).await;
    assert_eq!(r["ok"]["resources"], 5, "{r}");
    let (pkg, blobs) = onedesk_kernel::packages::read_package(
        &std::fs::read(t.out.join("math-teacher.odpack")).unwrap(),
    )
    .unwrap();
    assert_eq!(pkg.variant, "teacher");
    assert_eq!(pkg.resources[0].id, root);
    assert_eq!(
        pkg.resources.iter().find(|r| r.id == q2).unwrap().body["answer"],
        "secret"
    );
    assert_eq!(blobs.len(), 1);
    assert_eq!(blobs[0].0, blob);
    // The edition is kept once.
    let e = publish(&t, "publish", &root, json!({ "edition": 1, "printing": 1, "variant": "teacher", "path": file(&t, "again.odpack") })).await;
    assert_eq!(e["error"], "conflict", "{e}");
    // Student variant from the kept edition, after the book changed: without `x` (and below it), withheld fields gone
    // or sealed.
    t.c.ok(
        "page.save",
        json!({ "target": format!("resource:{q2}"), "changes": { "name": "Q2 changed" } }),
    )
    .await;
    let r = publish(&t, "reprint", &root, json!({ "edition": 1, "printing": 2, "variant": "student", "exclude": [x], "path": file(&t, "math-student.odpack") })).await;
    assert_eq!(r["ok"]["resources"], 3, "{r}");
    let (pkg, blobs) = onedesk_kernel::packages::read_package(
        &std::fs::read(t.out.join("math-student.odpack")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        (pkg.edition, pkg.printing, pkg.variant.as_str()),
        (1, 2, "student")
    );
    let q2row = pkg.resources.iter().find(|r| r.id == q2).unwrap();
    assert_eq!(q2row.name, "Q2", "printed from the kept edition");
    assert!(!q2row.body.contains_key("answer") && !q2row.body.contains_key("note"));
    let q1row = pkg.resources.iter().find(|r| r.id == q1).unwrap();
    assert!(!q1row.body.contains_key("answer"));
    assert_eq!(pkg.sealed.len(), 1, "only the sealed field of q1");
    assert_eq!(pkg.sealed[0].field, "answer");
    assert_eq!(pkg.sealed[0].value, "8");
    assert_eq!(pkg.sealed[0].hashes.len(), 2);
    assert_eq!(blobs.len(), 1, "the image of q1 goes along");
    // Revealed: the original text, no fingerprint.
    let r = publish(&t, "reprint", &root, json!({ "edition": 1, "printing": 3, "variant": "student", "exclude": [x], "reveal": { q2.clone(): ["answer"] }, "path": file(&t, "math-student-3.odpack") })).await;
    assert!(r.get("ok").is_some(), "{r}");
    let (pkg, _) = onedesk_kernel::packages::read_package(
        &std::fs::read(t.out.join("math-student-3.odpack")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        pkg.resources.iter().find(|r| r.id == q2).unwrap().body["answer"],
        "secret"
    );
    // An edition never kept; not one's own kind; no files permission; not in a granted folder.
    let e = publish(&t, "reprint", &root, json!({ "edition": 9, "printing": 1, "variant": "student", "path": file(&t, "nine.odpack") })).await;
    assert_eq!(e["params"]["what"], "edition", "{e}");
    let e = t.c.probe("test.other", "packages.publish", json!([root, { "edition": 2, "printing": 1, "variant": "student", "path": file(&t, "o.odpack") }])).await;
    assert_eq!(e["params"]["reason"], "foreignKind", "{e}");
    let outside = t.env.path().join("elsewhere.odpack").display().to_string();
    let e = publish(
        &t,
        "publish",
        &root,
        json!({ "edition": 2, "printing": 1, "variant": "student", "path": outside }),
    )
    .await;
    assert!(e["error"].is_string(), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_copy_keeps_ids_is_read_only_and_a_newer_printing_replaces_it() {
    let (t, s, _p) = two().await;
    let (root, q1, q2, x, blob) = book(&t).await;
    publish(&t, "publish", &root, json!({ "edition": 1, "printing": 1, "variant": "student", "exclude": [x], "path": file(&t, "s1.odpack") })).await;
    let path = file(&t, "s1.odpack");
    // What it is, before importing.
    let info = s.c.ok("package.inspect", json!({ "path": path })).await;
    assert_eq!(info["title"], "Math");
    assert_eq!(info["resources"], 3);
    assert_eq!(info["update"], false);
    assert!(info["refused"].is_null(), "{info}");
    // Its own package is refused.
    let own = t.c.ok("package.inspect", json!({ "path": path })).await;
    assert_eq!(own["refused"], "ownPackage");
    let e =
        t.c.call("package.import", json!({ "path": path }))
            .await
            .unwrap_err();
    assert_eq!(
        e.params.get("reason").map(String::as_str),
        Some("ownPackage")
    );
    // Imported: same ids, read-only, where it came from.
    let r = s.c.ok("package.import", json!({ "path": path })).await;
    assert_eq!(r["created"], 3);
    let got = s.c.ok("resource.get", json!({ "id": q1 })).await;
    assert_eq!(got["readOnly"], true);
    assert_eq!(got["origin"], "subscribed");
    assert!(got["copy"]["publisherName"].is_string(), "{got}");
    assert_eq!(got["copy"]["edition"], 1);
    assert!(got["body"].get("answer").is_none());
    assert_eq!(names(&s.c, &root).await, ["Q1", "Q2"]);
    // The image came along.
    let b =
        s.c.call("blob.read", json!({ "blob": blob, "resource": q1 }))
            .await;
    assert!(b.is_ok(), "{b:?}");
    // Nothing changes inside: no edits, no partial deletes, nothing added, nothing dragged out or in.
    let denied = |e: onedesk_protocol::ProtocolError| {
        assert_eq!(e.code, ErrorCode::Denied, "{e:?}");
        assert_eq!(
            e.params.get("reason").map(String::as_str),
            Some("readOnlyCopy")
        );
    };
    denied(
        s.c.call(
            "page.save",
            json!({ "target": format!("resource:{q1}"), "changes": { "name": "mine" } }),
        )
        .await
        .unwrap_err(),
    );
    denied(
        s.c.call("resource.delete", json!({ "id": q2 }))
            .await
            .unwrap_err(),
    );
    denied(s.c.call("page.save", json!({ "target": format!("new:test.pub:q?parent={root}"), "changes": { "name": "added" } })).await.unwrap_err());
    let loose = create(&s.c, "test.pub:shelf", None, json!({ "name": "Mine" })).await;
    denied(
        s.c.call(
            "tree.move",
            json!({ "tree": "resources", "key": q1, "target": loose, "position": "inside" }),
        )
        .await
        .unwrap_err(),
    );
    denied(
        s.c.call(
            "tree.move",
            json!({ "tree": "resources", "key": loose, "target": root, "position": "inside" }),
        )
        .await
        .unwrap_err(),
    );
    // The whole copy may be moved among the student's own things.
    s.c.ok(
        "tree.move",
        json!({ "tree": "resources", "key": root, "target": loose, "position": "inside" }),
    )
    .await;
    s.c.ok(
        "tree.move",
        json!({ "tree": "resources", "key": root, "target": loose, "position": "after" }),
    )
    .await;
    // Same printing again: not newer.
    assert_eq!(
        s.c.ok("package.inspect", json!({ "path": path })).await["refused"],
        "notNewer"
    );
    // The teacher changes things; a new edition: replaced, what is gone is gone, the student's own resources stay.
    t.c.ok(
        "page.save",
        json!({ "target": format!("resource:{q1}"), "changes": { "name": "Q1 new" } }),
    )
    .await;
    t.c.ok("resource.delete", json!({ "id": q2 })).await;
    let q3 = create(&t.c, "test.pub:q", Some(&root), json!({ "name": "Q3" })).await;
    publish(&t, "publish", &root, json!({ "edition": 2, "printing": 1, "variant": "student", "exclude": [x], "path": file(&t, "s2.odpack") })).await;
    let info =
        s.c.ok("package.inspect", json!({ "path": file(&t, "s2.odpack") }))
            .await;
    assert_eq!(info["update"], true);
    assert_eq!(info["current"]["edition"], 1);
    let r =
        s.c.ok("package.import", json!({ "path": file(&t, "s2.odpack") }))
            .await;
    assert_eq!(
        (r["created"].as_u64(), r["removed"].as_u64()),
        (Some(1), Some(1)),
        "{r}"
    );
    assert_eq!(names(&s.c, &root).await, ["Q1 new", "Q3"]);
    assert!(s.c.ok("resource.get", json!({ "id": q3 })).await["readOnly"] == true);
    assert!(s.c.ok("resource.get", json!({ "id": loose })).await["readOnly"] != true);
    // The root stays where the student moved it.
    s.c.ok(
        "tree.move",
        json!({ "tree": "resources", "key": root, "target": loose, "position": "inside" }),
    )
    .await;
    t.c.ok(
        "page.save",
        json!({ "target": format!("resource:{q3}"), "changes": { "name": "Q3 again" } }),
    )
    .await;
    publish(&t, "reprint", &root, json!({ "edition": 2, "printing": 2, "variant": "student", "exclude": [x], "path": file(&t, "s3.odpack") })).await;
    s.c.ok("package.import", json!({ "path": file(&t, "s3.odpack") }))
        .await;
    assert_eq!(names(&s.c, &loose).await, ["Math"]);
    // The whole copy may be deleted, and imported again (any printing).
    s.c.ok("resource.delete", json!({ "id": root })).await;
    assert!(s
        .c
        .ok("package.inspect", json!({ "path": file(&t, "s2.odpack") }))
        .await["refused"]
        .is_null());
    s.c.ok("package.import", json!({ "path": file(&t, "s2.odpack") }))
        .await;
    assert_eq!(names(&s.c, &root).await, ["Q1 new", "Q3"]);
    // A broken file.
    std::fs::write(t.out.join("bad.odpack"), b"nope").unwrap();
    let e =
        s.c.call("package.inspect", json!({ "path": file(&t, "bad.odpack") }))
            .await
            .unwrap_err();
    assert_eq!(
        e.params.get("reason").map(String::as_str),
        Some("badPackage")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn sealed_fields_are_checked_by_fingerprint_and_opened_from_the_keychain_only() {
    let (t, s, _p) = two().await;
    let (root, q1, q2, x, _) = book(&t).await;
    publish(&t, "publish", &root, json!({ "edition": 1, "printing": 1, "variant": "student", "exclude": [x], "path": file(&t, "s1.odpack") })).await;
    s.c.ok("package.import", json!({ "path": file(&t, "s1.odpack") }))
        .await;
    let check = |id: &str, text: &str| {
        s.c.probe("test.pub", "sealed.check", json!([id, "answer", text]))
    };
    assert_eq!(check(&q1, "8").await["ok"], true);
    assert_eq!(check(&q1, "eight").await["ok"], true);
    assert_eq!(check(&q1, "9").await["ok"], false);
    assert!(
        check(&q2, "secret").await["ok"].is_null(),
        "nothing to check against"
    );
    let r =
        s.c.probe("test.pub", "sealed.open", json!([q1, "answer"]))
            .await;
    assert_eq!(r["ok"], "8");
    assert!(s
        .c
        .probe("test.pub", "sealed.open", json!([q2, "answer"]))
        .await["ok"]
        .is_null());
    // Another plugin may not ask.
    assert_eq!(
        s.c.probe("test.other", "sealed.open", json!([q1, "answer"]))
            .await["params"]["reason"],
        "foreignKind"
    );
    // The database holds no original text; the keychain names are not listed as the user's secrets.
    let conn = db(&s);
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM resources WHERE body LIKE '%secret%' OR body LIKE '%\"answer\"%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM sealed", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    let list = s.c.ok("secrets.list", json!({})).await;
    assert!(!list.to_string().contains("sealed."), "{list}");
    // Revealed in a later printing: the text comes along.
    publish(&t, "reprint", &root, json!({ "edition": 1, "printing": 2, "variant": "student", "exclude": [x], "reveal": { q2.clone(): ["answer"] }, "path": file(&t, "s2.odpack") })).await;
    s.c.ok("package.import", json!({ "path": file(&t, "s2.odpack") }))
        .await;
    assert_eq!(
        s.c.ok("resource.get", json!({ "id": q2 })).await["body"]["answer"],
        "secret"
    );
}

#[test]
fn a_zip_from_elsewhere_with_compressed_entries_is_refused() {
    let mut z = onedesk_kernel::packages::zip_write(&[("package.json".into(), b"{}".to_vec())]);
    // Method 8 (deflate) in the central directory.
    let at = z
        .windows(4)
        .position(|w| w == [0x50, 0x4b, 0x01, 0x02])
        .unwrap();
    z[at + 10] = 8;
    assert!(onedesk_kernel::packages::zip_read(&z).is_err());
}

/* ------------------------------------------------------------------ D487 §33 (K18): signed packages */

/// A package file rewritten: `edit` changes its `package.json`; `key` signs it again with another key.
fn rewrite(path: &str, out: &str, edit: impl Fn(&mut onedesk_kernel::packages::PackageFile), key: Option<&ed25519_dalek::SigningKey>) {
    use ed25519_dalek::Signer;
    let entries = onedesk_kernel::packages::zip_read(&std::fs::read(path).unwrap()).unwrap();
    let (mut pkg, blobs) = onedesk_kernel::packages::read_package(&std::fs::read(path).unwrap()).unwrap();
    edit(&mut pkg);
    if let Some(k) = key {
        pkg.publisher_key = Some(onedesk_kernel::identity::hex(k.verifying_key().as_bytes()));
        pkg.signature = None;
        let names: Vec<String> = blobs.iter().map(|(h, _)| h.clone()).collect();
        let msg = onedesk_kernel::packages::package_message(&pkg, &names);
        pkg.signature = Some(onedesk_kernel::identity::hex(&k.sign(msg.as_bytes()).to_bytes()));
    }
    let out_entries: Vec<(String, Vec<u8>)> = entries
        .into_iter()
        .map(|(n, b)| if n == "package.json" { (n, serde_json::to_vec(&pkg).unwrap()) } else { (n, b) })
        .collect();
    std::fs::write(out, onedesk_kernel::packages::zip_write(&out_entries)).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn packages_are_signed_by_their_publisher_and_a_copy_follows_that_key() {
    let (t, s, _p) = two().await;
    let (root, _q1, _q2, x, _blob) = book(&t).await;
    publish(&t, "publish", &root, json!({ "edition": 1, "printing": 1, "variant": "student", "exclude": [x], "path": file(&t, "s1.odpack") })).await;
    let path = file(&t, "s1.odpack");
    let me = t.c.ok("identity.get", json!({})).await;
    // Signed: who published it.
    let info = s.c.ok("package.inspect", json!({ "path": path })).await;
    assert_eq!(info["signature"], "valid", "{info}");
    assert_eq!(info["publisherIdentity"]["fingerprint"], me["fingerprint"]);
    assert_eq!(info["publisherIdentity"]["known"], "unknown");
    assert_eq!(info["publisherName"], me["name"]);
    // Changed on the way: refused.
    let bad = file(&t, "bad.odpack");
    rewrite(&path, &bad, |p| p.title = "Math (pirated)".into(), None);
    let e = s.c.call("package.import", json!({ "path": bad })).await.unwrap_err();
    assert_eq!(e.params.get("reason").map(String::as_str), Some("badSignature"));
    assert_eq!(s.c.ok("package.inspect", json!({ "path": bad })).await["refused"], "badSignature");
    // Imported: the publisher is in the contacts, not checked.
    s.c.ok("package.import", json!({ "path": path })).await;
    let contacts = s.c.ok("tree.children", json!({ "tree": "contacts" })).await;
    let cid = contacts["nodes"][0]["key"].as_str().unwrap().to_string();
    let c = s.c.ok("resource.get", json!({ "id": cid })).await;
    assert_eq!((c["body"]["fingerprint"].clone(), c["body"]["checked"].clone(), c["body"]["source"].as_str()), (me["fingerprint"].clone(), json!(false), Some("package")));
    s.c.ok("contact.setChecked", json!({ "id": cid, "checked": true })).await;
    // An update signed by someone else (same book, a newer printing): refused; so is one without a signature.
    let other = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
    let forged = file(&t, "forged.odpack");
    rewrite(&path, &forged, |p| p.printing = 9, Some(&other));
    let i = s.c.ok("package.inspect", json!({ "path": forged })).await;
    assert_eq!((i["signature"].as_str(), i["refused"].as_str()), (Some("valid"), Some("otherPublisher")));
    let unsigned = file(&t, "unsigned.odpack");
    rewrite(&path, &unsigned, |p| {
        p.printing = 9;
        p.publisher_key = None;
        p.signature = None;
    }, None);
    let i = s.c.ok("package.inspect", json!({ "path": unsigned })).await;
    assert_eq!((i["signature"].as_str(), i["refused"].as_str()), (Some("unsigned"), Some("otherPublisher")));
    // The real publisher's next printing: accepted, and now known as checked.
    publish(&t, "reprint", &root, json!({ "edition": 1, "printing": 2, "variant": "student", "exclude": [x], "path": file(&t, "s2.odpack") })).await;
    let i = s.c.ok("package.inspect", json!({ "path": file(&t, "s2.odpack") })).await;
    assert!(i["refused"].is_null(), "{i}");
    assert_eq!(i["publisherIdentity"]["known"], "checked");
    // A package from before signatures may still be imported where there is no copy yet (shown unsigned).
    let (_t2, s2, _p2) = two().await;
    let old = file(&t, "old.odpack");
    rewrite(&path, &old, |p| {
        p.publisher_key = None;
        p.signature = None;
    }, None);
    let i = s2.c.ok("package.inspect", json!({ "path": old })).await;
    assert_eq!((i["signature"].as_str(), i["refused"].clone()), (Some("unsigned"), Value::Null));
    assert!(i.get("publisherIdentity").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn publishing_needs_an_identity() {
    let (t, _s, _p) = two().await;
    let (root, _q1, _q2, _x, _blob) = book(&t).await;
    t.c.ok("identity.delete", json!({})).await;
    let e = publish(&t, "publish", &root, json!({ "edition": 1, "printing": 1, "variant": "teacher", "path": file(&t, "x.odpack") })).await;
    assert_eq!(e["params"]["reason"], "noIdentity", "{e}");
}
