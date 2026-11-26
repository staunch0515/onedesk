//! Round 5 (docs/handoff/round5-plan.md §9): references, export and import, protection policies,
//! known parameters, exporting a run's table. Temporary folders and the in-memory secret store only.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::*;
use onedesk_kernel::secrets::SecretStoreHandle;
use onedesk_protocol::{ErrorCode, ProtocolError};
use rusqlite::Connection;
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

fn refs_plugin(root: &Path) {
    let dir = root.join("test.refs").join("0.1.0");
    std::fs::create_dir_all(&dir).unwrap();
    let m = json!({
        "id": "test.refs", "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js",
        "requires": { "network": { "fromResources": true } },
        "contributes": {
            "kinds": [{ "id": "doc", "label": "k", "icon": "file", "tree": "resources", "page": "p", "newName": "k",
                        "defaults": { "text": "" }, "accepts": [],
                        "fields": { "text": { "type": "longtext", "refs": true }, "link": { "type": "ref" },
                                    "token": { "type": "secret" }, "url": { "type": "text", "grants": "network" },
                                    "headers": { "type": "text", "secrets": true } } }],
            "pages": [{ "id": "p" }],
            "actions": [{ "id": "tab", "label": "a", "kinds": ["doc"], "output": "table" },
                        { "id": "txt", "label": "a", "kinds": ["doc"], "output": "text" }],
            "commands": [{ "id": "probe", "label": "c" }]
        }
    });
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    let main = format!(
        r#"{PROBE}
export default {{ activate(host) {{
  host.commands.handle("probe", probe);
  host.pages.handle("p", {{ async render(ctx) {{
    return {{ view: [{{ type: "form", id: "f", layout: "stack",
                        fields: [{{ name: "text", label: "t", kind: "longtext", bind: "body.text" }}] }}] }};
  }} }});
  host.actions.handle("tab", async () => ({{ output: {{ type: "table",
    columns: [{{ key: "a", label: "Name" }}, {{ key: "b", label: "Note, \"q\"" }}],
    rows: [["中文", "a,b"], ["x\ny", 3], [null, true], ["long", "row", "dropped"], ["short"]] }} }}));
  host.actions.handle("txt", async () => ({{ output: {{ type: "text", text: "hi" }} }}));
}} }};"#
    );
    std::fs::write(dir.join("main.js"), main).unwrap();
}

struct W {
    env: Env,
    c: Client,
    out: tempfile::TempDir,
}

async fn world() -> W {
    let tmp = tempfile::tempdir().unwrap();
    let plugins = tmp.path().join("plugins");
    std::fs::create_dir_all(&plugins).unwrap();
    refs_plugin(&plugins);
    let mut cfg = test_config();
    cfg.secrets = SecretStoreHandle::memory().0;
    let env = open_with(tmp, &plugins, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    W { env, c, out: tempfile::tempdir().unwrap() }
}

impl W {
    fn out(&self, name: &str) -> PathBuf {
        std::fs::canonicalize(self.out.path()).unwrap().join(name)
    }
    fn db(&self) -> Connection {
        Connection::open(self.env.kernel.db_path()).unwrap()
    }
    fn body_text(&self, id: &str) -> String {
        let b: String = self.db().query_row("SELECT body FROM resources WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        serde_json::from_str::<Value>(&b).unwrap()["text"].as_str().unwrap_or_default().to_string()
    }
    fn count(&self, stmt_text: &str) -> i64 {
        self.db().query_row(stmt_text, [], |r| r.get(0)).unwrap()
    }
}

async fn doc_in(c: &Client, parent: Option<&str>, name: &str, text: &str) -> String {
    let target = match parent {
        Some(p) => format!("new:test.refs:doc?parent={p}"),
        None => "new:test.refs:doc".to_string(),
    };
    let r = c.ok("page.save", json!({ "target": target, "changes": { "name": name, "body.text": text } })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn doc(c: &Client, name: &str, text: &str) -> String {
    doc_in(c, None, name, text).await
}

async fn save_text(c: &Client, id: &str, text: &str) -> Result<Value, ProtocolError> {
    c.call("page.save", json!({ "target": format!("resource:{id}"), "changes": { "body.text": text } })).await
}

async fn outgoing(c: &Client, id: &str) -> Vec<(String, String, Option<String>)> {
    let v = c.ok("refs.outgoing", json!({ "id": id })).await;
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| (r["text"].as_str().unwrap().to_string(), r["state"].as_str().unwrap().to_string(), r["target"]["id"].as_str().map(String::from)))
        .collect()
}

async fn incoming(c: &Client, id: &str) -> Vec<String> {
    let v = c.ok("refs.incoming", json!({ "id": id })).await;
    v.as_array().unwrap().iter().map(|r| r["source"]["id"].as_str().unwrap().to_string()).collect()
}

async fn group(c: &Client, name: &str) -> String {
    c.ok("tree.createGroup", json!({ "tree": "resources", "name": name })).await["key"].as_str().unwrap().to_string()
}

async fn root(c: &Client, tree: &str) -> String {
    c.ok("tree.children", json!({ "tree": tree })).await["nodes"][0]["key"].as_str().unwrap().to_string()
}

fn reason(e: &ProtocolError) -> (&ErrorCode, Option<&str>) {
    (&e.code, e.params.get("reason").map(String::as_str))
}

/* ------------------------------------------------------------------ references */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refs_rows_follow_the_saved_text() {
    let w = world().await;
    let c = &w.c;
    let a = doc(c, "Alpha", "").await;
    let b = doc(c, "Beta", "").await;
    let long = "x".repeat(201);
    let text = format!("[[Alpha]] then [[Beta]] and [[Alpha]] again; \\[[Beta]] is escaped; [[{long}]]; [[across\nlines]]; [[Nobody]]");
    let s = doc(c, "Source", &text).await;
    assert_eq!(
        outgoing(c, &s).await,
        vec![
            ("Alpha".into(), "ok".into(), Some(a.clone())),
            ("Beta".into(), "ok".into(), Some(b.clone())),
            ("Alpha".into(), "ok".into(), Some(a.clone())),
            ("Nobody".into(), "missing".into(), None),
        ]
    );
    let v = c.ok("refs.outgoing", json!({ "id": s })).await;
    assert_eq!((v[0]["field"].as_str(), v[0]["source"]["name"].as_str()), (Some("body.text"), Some("Source")));
    assert_eq!(incoming(c, &a).await, vec![s.clone(), s.clone()]);
    // Saving again with fewer marks replaces the rows.
    save_text(c, &s, "only [[Beta]]").await.unwrap();
    assert_eq!(outgoing(c, &s).await, vec![("Beta".into(), "ok".into(), Some(b.clone()))]);
    assert!(incoming(c, &a).await.is_empty());
    // Only declared fields count: the description is not a reference field.
    c.ok("page.save", json!({ "target": format!("resource:{s}"), "changes": { "description": "[[Alpha]]" } })).await;
    assert_eq!(outgoing(c, &s).await.len(), 1);
    // A single-reference field.
    let p = c.probe("test.refs", "resources.update", json!([s, { "body.link": { "ref": a } }])).await;
    assert!(p.get("ok").is_some(), "{p}");
    let v = c.ok("refs.outgoing", json!({ "id": s })).await;
    let link = v.as_array().unwrap().iter().find(|r| r["field"] == "body.link").expect("link row");
    assert_eq!((link["text"].as_str(), link["target"]["id"].as_str()), (Some("Alpha"), Some(a.as_str())));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn names_resolve_exactly_near_the_source_then_nearest_the_top() {
    let w = world().await;
    let c = &w.c;
    // Case-sensitive; groups, environments and configuration nodes are never targets.
    group(c, "Shared").await;
    let s = doc(c, "S", "[[shared]] [[Shared]] [[Default]] [[Workspace]]").await;
    assert!(outgoing(c, &s).await.iter().all(|(_, st, _)| st == "missing"));
    let lower = doc(c, "shared", "").await;
    save_text(c, &s, "[[shared]]").await.unwrap();
    assert_eq!(outgoing(c, &s).await[0].2.as_deref(), Some(lower.as_str()));
    // Several with the name: the one under the source's parent first.
    let g1 = group(c, "G1").await;
    let g2 = group(c, "G2").await;
    let top = doc(c, "Twin", "").await;
    let far = doc_in(c, Some(&g2), "Twin", "").await;
    let near = doc_in(c, Some(&g1), "Twin", "").await;
    let src = doc_in(c, Some(&g1), "Src", "[[Twin]]").await;
    assert_eq!(outgoing(c, &src).await[0].2.as_deref(), Some(near.as_str()));
    // Otherwise the one nearest the top of the tree.
    let other = doc_in(c, Some(&g2), "Other", "").await;
    let src2 = doc_in(c, Some(&g1), "Src2", "[[Other]] [[Twin]]").await;
    assert_eq!(outgoing(c, &src2).await[0].2.as_deref(), Some(other.as_str()));
    c.ok("resource.delete", json!({ "id": near })).await;
    let src3 = doc_in(c, Some(&g1), "Src3", "[[Twin]]").await;
    // Deleted ones do not count; of the rest, the first in tree order (G2 comes before the top-level Twin).
    assert_eq!(outgoing(c, &src3).await[0].2.as_deref(), Some(far.as_str()));
    c.ok("resource.delete", json!({ "id": far })).await;
    let src4 = doc_in(c, Some(&g1), "Src4", "[[Twin]]").await;
    assert_eq!(outgoing(c, &src4).await[0].2.as_deref(), Some(top.as_str()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_renamed_target_reads_under_its_new_name_and_the_stored_text_stays() {
    let w = world().await;
    let c = &w.c;
    let t = doc(c, "Old name", "").await;
    let s = doc(c, "S", "see [[Old name]] and [[Nobody]]").await;
    c.ok("tree.rename", json!({ "tree": "resources", "key": t, "name": "New name" })).await;
    let r = c.ok("resource.get", json!({ "id": s })).await;
    assert_eq!(r["body"]["text"], "see [[New name]] and [[Nobody]]");
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{s}") })).await;
    assert_eq!(p["values"]["body.text"], "see [[New name]] and [[Nobody]]");
    assert_eq!(w.body_text(&s), "see [[Old name]] and [[Nobody]]", "the database keeps what was written");
    let n = w.count(&format!("SELECT count(*) FROM revisions WHERE resource_id = '{s}'"));
    assert_eq!(n, 1, "no history for the rename of the target");
    // The user saves what they see: still connected.
    save_text(c, &s, "see [[New name]] and [[Nobody]] more").await.unwrap();
    assert_eq!(outgoing(c, &s).await[0], ("New name".into(), "ok".into(), Some(t.clone())));
    assert_eq!(outgoing(c, &s).await[1].1, "missing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleted_restored_purged_and_a_new_namesake_is_not_connected() {
    let w = world().await;
    let c = &w.c;
    let t = doc(c, "Target", "").await;
    let s = doc(c, "S", "[[Target]] and other text").await;
    c.ok("resource.delete", json!({ "id": t })).await;
    assert_eq!(outgoing(c, &s).await[0], ("Target".into(), "deleted".into(), Some(t.clone())));
    c.ok("resource.undelete", json!({ "id": t })).await;
    assert_eq!(outgoing(c, &s).await[0].1, "ok");
    // A deleted source is not listed as incoming; restored, it is again.
    c.ok("resource.delete", json!({ "id": s })).await;
    assert!(incoming(c, &t).await.is_empty());
    c.ok("resource.undelete", json!({ "id": s })).await;
    assert_eq!(incoming(c, &t).await, vec![s.clone()]);
    c.ok("resource.delete", json!({ "id": t })).await;
    c.ok("resource.purge", json!({ "id": t })).await;
    assert_eq!(outgoing(c, &s).await[0], ("Target".into(), "missing".into(), None));
    let again = doc(c, "Target", "").await;
    assert_eq!(outgoing(c, &s).await[0].1, "missing", "references are by id (D323)");
    assert!(incoming(c, &again).await.is_empty());
    // A purged source takes its rows with it.
    let s2 = doc(c, "S2", "[[Target]]").await;
    c.ok("resource.delete", json!({ "id": s2 })).await;
    c.ok("resource.purge", json!({ "id": s2 })).await;
    assert_eq!(w.count(&format!("SELECT count(*) FROM refs WHERE source_id = '{s2}'")), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn plugin_writes_and_history_restores_recompute_references() {
    let w = world().await;
    let c = &w.c;
    let a = doc(c, "A", "").await;
    let b = doc(c, "B", "").await;
    let s = doc(c, "S", "[[A]]").await;
    // Plugins may write reference fields (a reference is not a grant).
    let p = c.probe("test.refs", "resources.update", json!([s, { "body.text": "[[B]]" }])).await;
    assert!(p.get("ok").is_some(), "{p}");
    assert_eq!(outgoing(c, &s).await[0].2.as_deref(), Some(b.as_str()));
    let p = c.probe("test.refs", "resources.create", json!([{ "kind": "doc", "name": "P", "body": { "text": "[[A]]" } }])).await;
    let pid = p["ok"]["id"].as_str().unwrap().to_string();
    assert_eq!(outgoing(c, &pid).await[0].2.as_deref(), Some(a.as_str()));
    // Back to the first text from history.
    let h = c.ok("resource.history", json!({ "id": s })).await;
    // Restoring the plugin's change puts back the text before it.
    let change = h.as_array().unwrap().iter().find(|e| e["field"] == "body.text").unwrap()["id"].clone();
    c.ok("resource.restore", json!({ "id": s, "entryId": change })).await;
    assert_eq!(w.body_text(&s), "[[A]]");
    assert_eq!(outgoing(c, &s).await[0].2.as_deref(), Some(a.as_str()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn migration_0008_rebuilds_references_of_existing_resources() {
    let tmp = tempfile::tempdir().unwrap();
    let plugins = tmp.path().join("plugins");
    std::fs::create_dir_all(&plugins).unwrap();
    refs_plugin(&plugins);
    let ws = tmp.path().join("ws");
    let (a, s) = {
        let env = open_exact(tempfile::tempdir().unwrap(), &plugins, config_for(&plugins));
        drop(env);
        let k = onedesk_kernel::Kernel::open(&ws, &plugins, config_for(&plugins)).unwrap();
        let c = Client::in_proc(std::sync::Arc::new(k));
        c.hello().await;
        let a = doc(&c, "A", "").await;
        let s = doc(&c, "S", "[[A]] [[A]]").await;
        (a, s)
    };
    // Make it look like a database from before 0008.
    {
        let conn = Connection::open(ws.join("workspace.db")).unwrap();
        conn.execute_batch("DROP TABLE refs; DROP INDEX resources_name; DELETE FROM meta WHERE key = 'refs_built'; UPDATE meta SET value = '7' WHERE key = 'schema_version';
                            ALTER TABLE audit_counts DROP COLUMN last_summary; ALTER TABLE audit_counts DROP COLUMN failures;
                            ALTER TABLE resources DROP COLUMN default_env;
                            ALTER TABLE stamps DROP COLUMN signer_key; ALTER TABLE stamps DROP COLUMN signer_name;
                            ALTER TABLE stamps DROP COLUMN content_hash; ALTER TABLE stamps DROP COLUMN signature;
                            ALTER TABLE copies DROP COLUMN publisher_key; DROP TABLE identity;").unwrap();
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let k = onedesk_kernel::Kernel::open(&ws, &plugins, config_for(&plugins)).unwrap();
    let c = Client::in_proc(std::sync::Arc::new(k));
    c.hello().await;
    assert_eq!(outgoing(&c, &s).await, vec![("A".into(), "ok".into(), Some(a.clone())), ("A".into(), "ok".into(), Some(a.clone()))]);
    let conn = Connection::open(ws.join("workspace.db")).unwrap();
    let v: String = conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap();
    assert_eq!(v, onedesk_kernel::workspace::MIGRATIONS.len().to_string());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reference_changes_publish_both_ends() {
    let w = world().await;
    let t = doc(&w.c, "T", "").await;
    let s = doc(&w.c, "S", "").await;
    // A client connected from here on sees only the events below.
    let c = Client::in_proc(w.env.kernel.clone());
    c.hello().await;
    save_text(&c, &s, "[[T]]").await.unwrap();
    let topic = format!("resource:{t}");
    c.event(|e| e.topic == topic).await;
    let c2 = Client::in_proc(w.env.kernel.clone());
    c2.hello().await;
    c2.ok("tree.rename", json!({ "tree": "resources", "key": t, "name": "T2" })).await;
    let topic = format!("resource:{s}");
    c2.event(|e| e.topic == topic).await;
    let c3 = Client::in_proc(w.env.kernel.clone());
    c3.hello().await;
    c3.ok("resource.delete", json!({ "id": t })).await;
    c3.event(|e| e.topic == topic).await;
}

/* ------------------------------------------------------------------ export */

fn read_json(p: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn export_writes_readable_files_without_secrets_state_or_deleted_data() {
    let w = world().await;
    let c = &w.c;
    c.ok("secrets.set", json!({ "name": "tok", "value": "SuperSecret-987" })).await;
    let a = doc(c, "A", "").await;
    let s = doc(c, "S", "[[A]]").await;
    c.ok("page.save", json!({ "target": format!("resource:{s}"), "changes": { "body.token": "Another-Secret-654" } })).await;
    let gone = doc(c, "Gone", "deleted text").await;
    c.ok("resource.delete", json!({ "id": gone })).await;
    c.ok("ui.set", json!({ "key": "layout.marker", "value": "UiStateMarker" })).await;
    c.ok("resource.setFavorite", json!({ "id": a, "favorite": true })).await;
    c.probe("test.refs", "storage.set", json!(["k", "PluginStorageMarker"])).await;
    let folder = w.out("export");
    let r = c.ok("workspace.export", json!({ "folder": folder })).await;
    assert_eq!(r["folder"], folder.to_string_lossy().as_ref());
    let mut names: Vec<String> = std::fs::read_dir(&folder).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["audit.json", "blobs", "manifest.json", "resources.json", "revisions.json", "runs.json"]);
    let m = read_json(&folder.join("manifest.json"));
    assert_eq!((m["format"].as_str(), m["version"].as_u64()), (Some("onedesk-export"), Some(1)));
    assert_eq!(m["workspace"]["id"], c.ok("workspace.info", json!({})).await["id"]);
    assert_eq!(m["counts"]["resources"], r["resources"]);
    let res = read_json(&folder.join("resources.json"));
    let list = res.as_array().unwrap();
    assert_eq!(list.len() as u64, r["resources"].as_u64().unwrap());
    let kinds: Vec<&str> = list.iter().map(|x| x["kind"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"core:env") && kinds.contains(&"core:config"));
    assert!(!kinds.contains(&"core:plugin-state"), "plugin state nodes stay home");
    assert!(list.iter().all(|x| x["name"] != "Gone"), "deleted resources are not exported");
    let sx = list.iter().find(|x| x["id"] == s).unwrap();
    assert_eq!(sx["refs"][0]["target"], a);
    assert_eq!((sx["plugin"].as_str(), sx["pluginVersion"].as_str()), (Some("test.refs"), Some("0.1.0")));
    assert_eq!(sx["body"]["token"]["secret"].as_str().map(|n| !n.is_empty()), Some(true), "secret fields keep only a name");
    // Readable: two-space indentation, keys in order.
    let text = std::fs::read_to_string(folder.join("resources.json")).unwrap();
    assert!(text.starts_with("[\n  {\n    \"body\""));
    // Nothing that must not leave.
    for f in ["manifest.json", "resources.json", "revisions.json", "runs.json", "audit.json"] {
        let t = std::fs::read_to_string(folder.join(f)).unwrap();
        for bad in ["SuperSecret-987", "Another-Secret-654", "UiStateMarker", "PluginStorageMarker", "deleted text", "layout.marker"] {
            assert!(!t.contains(bad), "{bad} in {f}");
        }
    }
    let revs = read_json(&folder.join("revisions.json"));
    assert!(revs.as_array().unwrap().iter().all(|x| x["resourceId"] != gone));
    assert!(!revs.as_array().unwrap().is_empty());
    assert_eq!(w.count("SELECT count(*) FROM audit WHERE op = 'workspace.export' AND result = 'ok'"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn export_refuses_bad_folders() {
    let w = world().await;
    let c = &w.c;
    let e = c.call("workspace.export", json!({ "folder": "relative/dir" })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("notAbsolute")));
    let full = w.out("full");
    std::fs::create_dir_all(&full).unwrap();
    std::fs::write(full.join("x.txt"), "x").unwrap();
    let e = c.call("workspace.export", json!({ "folder": full })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("notEmpty")));
    let e = c.call("workspace.export", json!({ "folder": w.out("no/such/parent") })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("noParent")));
    let inside = w.env.kernel.db_path().parent().unwrap().join("exp");
    let e = c.call("workspace.export", json!({ "folder": inside })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("insideDataDir")));
    // An existing empty folder is fine.
    let empty = w.out("empty");
    std::fs::create_dir_all(&empty).unwrap();
    c.ok("workspace.export", json!({ "folder": empty })).await;
    assert!(empty.join("manifest.json").exists());
}

/* ------------------------------------------------------------------ import */

fn write_export(dir: &Path, name: &str, resources: Value) -> PathBuf {
    let f = dir.join(name);
    std::fs::create_dir_all(&f).unwrap();
    let m = json!({ "format": "onedesk-export", "version": 1, "workspace": { "id": "src", "name": "Elsewhere" }, "exportedAt": 5 });
    std::fs::write(f.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(f.join("resources.json"), serde_json::to_vec_pretty(&resources).unwrap()).unwrap();
    f
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn export_then_import_gives_new_ids_rewired_references_and_an_import_history() {
    let w = world().await;
    let c = &w.c;
    let g = group(c, "Notes").await;
    let a = doc_in(c, Some(&g), "A", "to [[B]]").await;
    let b = doc_in(c, Some(&g), "B", "back to [[A]]").await;
    c.probe("test.refs", "resources.update", json!([a, { "body.link": { "ref": b } }])).await;
    let ws = root(c, "config").await;
    c.ok("params.set", json!({ "node": ws, "name": "x.policy", "value": "home" })).await;
    let folder = w.out("e1");
    c.ok("workspace.export", json!({ "folder": folder })).await;
    let p = c.ok("workspace.importPreview", json!({ "folder": folder })).await;
    assert_eq!((p["valid"].as_bool(), p["source"].as_str()), (Some(true), Some("ws")));
    // group + 2 docs + Default env; the configuration node is listed as not imported.
    assert_eq!((p["create"].as_u64(), p["update"].as_u64()), (Some(4), Some(0)));
    let sk = p["skipped"].as_array().unwrap();
    assert_eq!(sk.len(), 1);
    assert_eq!((sk[0]["kind"].as_str(), sk[0]["reason"].as_str()), (Some("core:config"), Some("config")));
    let r = c.ok("workspace.import", json!({ "folder": folder, "fingerprint": p["fingerprint"] })).await;
    assert_eq!((r["created"].as_u64(), r["updated"].as_u64(), r["group"]["name"].as_str()), (Some(4), Some(0), Some("ws")));
    let top = r["group"]["id"].as_str().unwrap().to_string();
    let kids = c.ok("tree.children", json!({ "tree": "resources", "parent": top })).await;
    let ng = kids["nodes"][0]["key"].as_str().unwrap().to_string();
    assert_eq!(kids["nodes"][0]["label"], "Notes");
    let docs = c.ok("tree.children", json!({ "tree": "resources", "parent": ng })).await;
    let ids: Vec<String> = docs["nodes"].as_array().unwrap().iter().map(|n| n["key"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids.len(), 2);
    assert!(!ids.contains(&a) && !ids.contains(&b), "new ids");
    let (na, nb) = (&ids[0], &ids[1]);
    assert_eq!(outgoing(c, na).await[0].2.as_deref(), Some(nb.as_str()));
    assert_eq!(outgoing(c, nb).await[0].2.as_deref(), Some(na.as_str()));
    let got = c.ok("resource.get", json!({ "id": na })).await;
    assert_eq!(got["body"]["link"]["ref"], nb.as_str(), "single references are rewritten too");
    let h = c.ok("resource.history", json!({ "id": na })).await;
    assert!(!h.as_array().unwrap().is_empty());
    assert!(h.as_array().unwrap().iter().all(|e| e["op"] == "import" && e["actor"] == "user"), "{h}");
    let revs = w.count(&format!("SELECT count(*) FROM revisions WHERE resource_id = '{na}'"));
    assert_eq!(revs, 1, "history starts with one import revision");
    // The environment came in with a number; the configuration did not come in.
    let envs = c.ok("tree.children", json!({ "tree": "env" })).await;
    let names: Vec<&str> = envs["nodes"].as_array().unwrap().iter().map(|n| n["label"].as_str().unwrap()).collect();
    assert_eq!(names, ["Default", "Default 2"]);
    assert_eq!(c.ok("tree.children", json!({ "tree": "config" })).await["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(w.count("SELECT count(*) FROM audit WHERE op = 'workspace.import' AND result = 'ok'"), 1);
    // A second import gets a numbered group.
    let p = c.ok("workspace.importPreview", json!({ "folder": folder })).await;
    let r = c.ok("workspace.import", json!({ "folder": folder, "fingerprint": p["fingerprint"] })).await;
    assert_eq!(r["group"]["name"], "ws 2");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn import_updates_by_external_key_skips_what_it_cannot_take_and_is_all_or_nothing() {
    let w = world().await;
    let c = &w.c;
    let existing = doc(c, "Keyed here", "old").await;
    w.db().execute("UPDATE resources SET external_key = 'K1' WHERE id = ?1", [&existing]).unwrap();
    let dir = w.out.path().to_path_buf();
    let good = write_export(
        &dir,
        "good",
        json!([
            { "id": "x1", "kind": "test.refs:doc", "pluginVersion": "0.1.0", "name": "Keyed", "body": { "text": "new [[Fresh]]" }, "externalKey": "K1" },
            { "id": "x2", "kind": "test.refs:doc", "name": "Fresh", "body": { "text": "to [[Keyed]] and [[Nowhere]]" } },
            { "id": "x3", "kind": "nobody.here:thing", "name": "Unknown" },
            { "id": "x4", "kind": "test.refs:doc", "pluginVersion": "0.0.1", "name": "Old" },
            { "id": "x5", "kind": "test.refs:doc", "name": "Bad", "body": { "text": 5 } }
        ]),
    );
    let p = c.ok("workspace.importPreview", json!({ "folder": good })).await;
    assert_eq!((p["create"].as_u64(), p["update"].as_u64()), (Some(1), Some(1)));
    let reasons: Vec<(&str, &str)> =
        p["skipped"].as_array().unwrap().iter().map(|s| (s["name"].as_str().unwrap(), s["reason"].as_str().unwrap())).collect();
    assert_eq!(reasons, [("Unknown", "unknownKind"), ("Old", "needsVersion"), ("Bad", "invalid")]);
    // The fingerprint must match the preview.
    let e = c.call("workspace.import", json!({ "folder": good, "fingerprint": "nope" })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("fingerprintChanged")));
    let r = c.ok("workspace.import", json!({ "folder": good, "fingerprint": p["fingerprint"] })).await;
    assert_eq!((r["created"].as_u64(), r["updated"].as_u64(), r["skipped"].as_array().unwrap().len()), (Some(1), Some(1), 3));
    assert_eq!(w.body_text(&existing), "new [[Fresh]]");
    let fresh = c.ok("tree.children", json!({ "tree": "resources", "parent": r["group"]["id"] })).await["nodes"][0]["key"]
        .as_str()
        .unwrap()
        .to_string();
    // A hand-written export without `refs`: resolved by name once everything is in.
    assert_eq!(outgoing(c, &existing).await[0].2.as_deref(), Some(fresh.as_str()));
    let o = outgoing(c, &fresh).await;
    assert_eq!((o[0].2.as_deref(), o[1].1.as_str()), (Some(existing.as_str()), "missing"));
    // One row that cannot be written: nothing is.
    let before = w.count("SELECT count(*) FROM resources");
    let audit_before = w.count("SELECT count(*) FROM audit WHERE result = 'ok'");
    let bad = write_export(
        &dir,
        "bad",
        json!([
            { "id": "y1", "kind": "test.refs:doc", "name": "One", "externalKey": "DUP" },
            { "id": "y2", "kind": "test.refs:doc", "name": "Two", "externalKey": "DUP" }
        ]),
    );
    let p = c.ok("workspace.importPreview", json!({ "folder": bad })).await;
    assert_eq!(p["create"].as_u64(), Some(2));
    assert!(c.call("workspace.import", json!({ "folder": bad, "fingerprint": p["fingerprint"] })).await.is_err());
    assert_eq!(w.count("SELECT count(*) FROM resources"), before);
    assert_eq!(w.count("SELECT count(*) FROM audit WHERE result = 'ok'"), audit_before);
    // Not an export / another version.
    let junk = dir.join("junk");
    std::fs::create_dir_all(&junk).unwrap();
    let p = c.ok("workspace.importPreview", json!({ "folder": junk })).await;
    assert_eq!((p["valid"].as_bool(), p["problem"]["params"]["reason"].as_str()), (Some(false), Some("notExport")));
    std::fs::write(junk.join("manifest.json"), r#"{"format":"onedesk-export","version":2,"workspace":{"name":"x"}}"#).unwrap();
    let p = c.ok("workspace.importPreview", json!({ "folder": junk })).await;
    assert_eq!(p["problem"]["params"]["reason"], "badVersion");
    // Into a given group.
    let into = group(c, "Into").await;
    let p = c.ok("workspace.importPreview", json!({ "folder": good })).await;
    let r = c.ok("workspace.import", json!({ "folder": good, "fingerprint": p["fingerprint"], "parent": into })).await;
    assert_eq!(r["group"]["id"], into.as_str());
}

/* ------------------------------------------------------------------ protection policies */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn readonly_refuses_every_content_write_and_lets_the_rest_through() {
    let w = world().await;
    let c = &w.c;
    let d = doc(c, "D", "text").await;
    let deleted = doc(c, "Del", "").await;
    c.ok("resource.delete", json!({ "id": deleted })).await;
    let g = group(c, "G").await;
    save_text(c, &d, "text").await.unwrap();
    c.ok("page.save", json!({ "target": format!("resource:{d}"), "changes": { "description": "x" } })).await;
    let h = c.ok("resource.history", json!({ "id": d })).await;
    let entry = h[0]["id"].clone();
    let ws = root(c, "config").await;
    c.ok("params.set", json!({ "node": ws, "name": "protection.readonly", "value": "true", "type": "boolean" })).await;
    let ro = |e: ProtocolError| {
        assert_eq!(reason(&e), (&ErrorCode::Denied, Some("readonly")), "{e:?}");
        assert_eq!(e.params.get("layer").map(String::as_str), Some(ws.as_str()));
    };
    ro(save_text(c, &d, "changed").await.unwrap_err());
    ro(c.call("page.save", json!({ "target": "new:test.refs:doc", "changes": { "name": "N" } })).await.unwrap_err());
    ro(c.call("tree.createGroup", json!({ "tree": "resources", "name": "X" })).await.unwrap_err());
    ro(c.call("tree.rename", json!({ "tree": "resources", "key": d, "name": "R" })).await.unwrap_err());
    ro(c.call("tree.move", json!({ "tree": "resources", "key": d, "target": g, "position": "inside" })).await.unwrap_err());
    ro(c.call("resource.delete", json!({ "id": d })).await.unwrap_err());
    ro(c.call("resource.undelete", json!({ "id": deleted })).await.unwrap_err());
    ro(c.call("resource.purge", json!({ "id": deleted })).await.unwrap_err());
    ro(c.call("resource.restore", json!({ "id": d, "entryId": entry })).await.unwrap_err());
    ro(c.call("run.start", json!({ "action": "test.refs:txt", "resourceId": d, "target": format!("resource:{d}"), "tabId": "t" })).await.unwrap_err());
    for (m, args) in [
        ("resources.update", json!([d, { "name": "P" }])),
        ("resources.create", json!([{ "kind": "doc", "name": "P" }])),
        ("resources.remove", json!([d])),
        ("storage.set", json!(["k", "v"])),
    ] {
        let r = c.probe("test.refs", m, args).await;
        assert_eq!((r["error"].as_str(), r["params"]["reason"].as_str()), (Some("denied"), Some("readonly")), "{m}: {r}");
    }
    let folder = w.out("ro-export");
    c.ok("workspace.export", json!({ "folder": folder })).await;
    let p = c.ok("workspace.importPreview", json!({ "folder": folder })).await;
    ro(c.call("workspace.import", json!({ "folder": folder, "fingerprint": p["fingerprint"] })).await.unwrap_err());
    assert_eq!(w.body_text(&d), "text");
    assert!(w.count("SELECT count(*) FROM audit WHERE result = 'failed:denied'") >= 10);
    // Not refused: interface state, favourites, secrets, plugin enable/disable, parameters.
    c.ok("ui.set", json!({ "key": "k", "value": 1 })).await;
    c.ok("resource.setFavorite", json!({ "id": d, "favorite": true })).await;
    c.ok("secrets.set", json!({ "name": "s1", "value": "v" })).await;
    c.ok("secrets.delete", json!({ "name": "s1" })).await;
    c.ok("plugin.setEnabled", json!({ "plugin": "test.refs", "enabled": false })).await;
    c.ok("plugin.setEnabled", json!({ "plugin": "test.refs", "enabled": true })).await;
    c.ok("page.save", json!({ "target": format!("resource:{ws}"), "changes": { "params.other": "1" } })).await;
    let page = c.ok("page.resolve", json!({ "target": format!("resource:{d}") })).await;
    assert_eq!(page["restrictions"], json!(["readonly"]));
    // And it can be turned off.
    c.ok("params.set", json!({ "node": ws, "name": "protection.readonly", "value": "false" })).await;
    save_text(c, &d, "changed").await.unwrap();
    assert!(c.ok("page.resolve", json!({ "target": format!("resource:{d}") })).await.get("restrictions").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_environment_layer_only_affects_saves_and_runs_with_that_environment() {
    let w = world().await;
    let c = &w.c;
    let d = doc(c, "D", "text").await;
    let root_env = root(c, "env").await;
    let eff = c.ok("command.execute", json!({ "id": "env.newChild", "context": { "tree": "env", "nodeKey": root_env, "args": { "name": "Prod" } } })).await;
    let prod = eff[0]["key"].as_str().unwrap().to_string();
    let eff = c.ok("command.execute", json!({ "id": "env.newChild", "context": { "tree": "env", "nodeKey": prod, "args": { "name": "Prod EU" } } })).await;
    let prod_eu = eff[0]["key"].as_str().unwrap().to_string();
    c.ok("params.set", json!({ "node": prod, "name": "protection.readonly", "value": "true", "type": "boolean" })).await;
    let with_env = |env: &str| json!({ "target": format!("resource:{d}"), "changes": { "body.text": "x" }, "context": { "envId": env } });
    let e = c.call("page.save", with_env(&prod_eu)).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Denied, Some("readonly")));
    assert_eq!(e.params.get("layer"), Some(&prod), "inherited from the parent environment");
    let run = |env: &str| json!({ "action": "test.refs:txt", "resourceId": d, "target": format!("resource:{d}"), "tabId": "t", "envId": env });
    assert_eq!(reason(&c.call("run.start", run(&prod)).await.unwrap_err()), (&ErrorCode::Denied, Some("readonly")));
    // Other environments and the tree are not affected.
    c.ok("page.save", with_env(&root_env)).await;
    c.ok("run.start", run(&root_env)).await;
    c.ok("tree.rename", json!({ "tree": "resources", "key": d, "name": "Renamed" })).await;
    let page = c.ok("page.resolve", json!({ "target": format!("resource:{d}"), "context": { "envId": prod_eu } })).await;
    assert_eq!(page["restrictions"], json!(["readonly"]));
    assert!(c.ok("page.resolve", json!({ "target": format!("resource:{d}"), "context": { "envId": root_env } })).await.get("restrictions").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_export_refuses_workspace_and_result_exports() {
    let w = world().await;
    let c = &w.c;
    let d = doc(c, "D", "").await;
    let run = c.ok("run.start", json!({ "action": "test.refs:tab", "resourceId": d, "target": format!("resource:{d}"), "tabId": "t" })).await;
    wait_run(c, run.as_str().unwrap()).await;
    let ws = root(c, "config").await;
    c.ok("params.set", json!({ "node": ws, "name": "protection.no_export", "value": "true", "type": "boolean" })).await;
    let e = c.call("workspace.export", json!({ "folder": w.out("ne") })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Denied, Some("noExport")));
    assert_eq!(e.params.get("layer"), Some(&ws));
    let e = c.call("run.export", json!({ "run": run, "path": w.out("r.csv"), "format": "csv" })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Denied, Some("noExport")));
    assert!(!w.out("ne").exists() && !w.out("r.csv").exists());
    let page = c.ok("page.resolve", json!({ "target": format!("resource:{d}") })).await;
    assert_eq!(page["restrictions"], json!(["noExport"]));
    let page = c.ok("page.resolve", json!({ "target": format!("run:{}", run.as_str().unwrap()) })).await;
    assert_eq!(page["restrictions"], json!(["noExport"]));
    // Saving is still fine.
    save_text(c, &d, "ok").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn known_parameters_are_listed() {
    let w = world().await;
    let v = w.c.ok("params.known", json!(null)).await;
    let rows: Vec<(String, String, String, Value)> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["name"].as_str().unwrap().into(), p["type"].as_str().unwrap().into(), p["merge"].as_str().unwrap().into(), p["layers"].clone()))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("ui.language".into(), "text".into(), "plain".into(), json!(["config"])),
            ("network.allow".into(), "list".into(), "allowList".into(), json!(["config", "env"])),
            ("process.allow".into(), "list".into(), "allowList".into(), json!(["config", "env"])),
            ("protection.readonly".into(), "boolean".into(), "deny".into(), json!(["config", "env"])),
            ("protection.no_export".into(), "boolean".into(), "deny".into(), json!(["config", "env"])),
            // Round 19 (D448): what the kernel lets an AI client do.
            ("mcp.enabled".into(), "boolean".into(), "plain".into(), json!(["config"])),
            ("mcp.rate_per_minute".into(), "number".into(), "plain".into(), json!(["config"])),
            ("mcp.max_rows".into(), "number".into(), "plain".into(), json!(["config"])),
            ("mcp.allow_free_query".into(), "boolean".into(), "plain".into(), json!(["config"])),
            ("mcp.env".into(), "ref".into(), "plain".into(), json!(["config"])),
            ("mcp.allow_proposals".into(), "boolean".into(), "plain".into(), json!(["config"])),
        ]
    );
}

/* ------------------------------------------------------------------ run.export */

async fn wait_run(c: &Client, id: &str) -> Value {
    loop {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_export_writes_rfc4180_csv_with_a_bom_and_never_overwrites() {
    let w = world().await;
    let c = &w.c;
    let d = doc(c, "D", "").await;
    let start = |a: &str| json!({ "action": format!("test.refs:{a}"), "resourceId": d, "target": format!("resource:{d}"), "tabId": "t" });
    let run = c.ok("run.start", start("tab")).await.as_str().unwrap().to_string();
    assert_eq!(wait_run(c, &run).await["status"], "success");
    let path = w.out("result.csv");
    let r = c.ok("run.export", json!({ "run": run, "path": path, "format": "csv" })).await;
    assert_eq!(r["rows"], 5);
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[..3], b"\xEF\xBB\xBF");
    let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
    // Review #10: every line has as many fields as the header.
    assert_eq!(text, "Name,\"Note, \"\"q\"\"\"\r\n中文,\"a,b\"\r\n\"x\ny\",3\r\n,true\r\nlong,row\r\nshort,\r\n");
    let e = c.call("run.export", json!({ "run": run, "path": path, "format": "csv" })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("exists")));
    assert_eq!(std::fs::read(&path).unwrap().len(), text.len() + 3, "untouched");
    let txt = c.ok("run.start", start("txt")).await.as_str().unwrap().to_string();
    wait_run(c, &txt).await;
    let e = c.call("run.export", json!({ "run": txt, "path": w.out("t.csv"), "format": "csv" })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("notTable")));
    let e = c.call("run.export", json!({ "run": run, "path": w.out("x.xlsx"), "format": "xlsx" })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("badFormat")));
    let e = c.call("run.export", json!({ "run": run, "path": "rel.csv", "format": "csv" })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("notAbsolute")));
    let inside = w.env.kernel.db_path().parent().unwrap().join("r.csv");
    let e = c.call("run.export", json!({ "run": run, "path": inside, "format": "csv" })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("insideDataDir")));
    assert_eq!(w.count("SELECT count(*) FROM audit WHERE op = 'run.export' AND result = 'ok'"), 1);
    // Review #10: a cleared result says so.
    w.db().execute("UPDATE runs SET output = NULL WHERE id = ?1", [&run]).unwrap();
    let e = c.call("run.export", json!({ "run": run, "path": w.out("gone.csv"), "format": "csv" })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("noOutput")));
}

/* ------------------------------------------------------------------ review (docs/handoff/round5-review.md) */

async fn preview(c: &Client, folder: &Path) -> Value {
    c.ok("workspace.importPreview", json!({ "folder": folder })).await
}

async fn import(c: &Client, folder: &Path) -> Value {
    let p = preview(c, folder).await;
    c.ok("workspace.import", json!({ "folder": folder, "fingerprint": p["fingerprint"] })).await
}

fn skipped(p: &Value) -> Vec<(String, String)> {
    p["skipped"].as_array().unwrap().iter().map(|s| (s["name"].as_str().unwrap().into(), s["reason"].as_str().unwrap().into())).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review1_imported_structure_follows_the_creation_rules() {
    let w = world().await;
    let c = &w.c;
    let hidden_before = w.count("SELECT count(*) FROM resources WHERE tree NOT IN ('resources')");
    let f = write_export(
        w.out.path(),
        "forged",
        json!([
            { "id": "g1", "kind": "core:group", "tree": "env", "name": "GroupInEnv" },
            { "id": "g2", "kind": "core:group", "tree": "core:plugin-state", "name": "GroupInState" },
            { "id": "g3", "kind": "core:group", "tree": "config", "name": "GroupInConfig" },
            { "id": "d1", "kind": "test.refs:doc", "tree": "core:plugin-state", "name": "DocClaimsHidden" },
            { "id": "e1", "kind": "core:env", "name": "Env" },
            { "id": "d2", "kind": "test.refs:doc", "parent": "e1", "name": "DocUnderEnv" },
            { "id": "d3", "kind": "test.refs:doc", "parent": "d1", "name": "DocUnderDoc" },
            { "id": "e2", "kind": "core:env", "parent": "d1", "name": "EnvUnderDoc" },
            { "id": "s1", "kind": "core:plugin-state", "tree": "core:plugin-state", "name": "test.refs" }
        ]),
    );
    let p = preview(c, &f).await;
    let mut got = skipped(&p);
    got.sort();
    let mut want: Vec<(String, String)> = ["DocUnderDoc", "DocUnderEnv", "EnvUnderDoc", "GroupInConfig", "GroupInEnv", "GroupInState", "test.refs"]
        .iter()
        .map(|n| (n.to_string(), "invalid".to_string()))
        .collect();
    want.sort();
    assert_eq!(got, want);
    assert_eq!(p["create"], 2);
    let r = import(c, &f).await;
    assert_eq!(r["created"], 2);
    // The document that claimed the hidden tree is an ordinary visible resource; nothing hidden came in.
    let kids = c.ok("tree.children", json!({ "tree": "resources", "parent": r["group"]["id"] })).await;
    assert_eq!(kids["nodes"][0]["label"], "DocClaimsHidden");
    assert_eq!(w.count("SELECT count(*) FROM resources WHERE tree NOT IN ('resources')"), hidden_before + 1, "only the environment");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review2_preview_lists_granted_hosts_and_secret_names() {
    let w = world().await;
    let c = &w.c;
    let f = write_export(
        w.out.path(),
        "grants",
        json!([
            { "id": "d1", "kind": "test.refs:doc", "name": "A", "body": { "url": "https://evil.example:8443/x", "token": { "secret": "stolen" },
                                                                      "headers": "Authorization: {{secret:api}}" } },
            { "id": "d2", "kind": "test.refs:doc", "name": "B", "body": { "url": "http://evil.example:8443/y" } },
            { "id": "e1", "kind": "core:env", "name": "E", "body": { "params": { "k": { "type": "secret", "value": "env_key" } } } },
            { "id": "x", "kind": "nobody.here:x", "name": "Skipped", "body": { "url": "https://skipped.example/" } }
        ]),
    );
    let p = preview(c, &f).await;
    assert_eq!(p["grantHosts"], json!(["evil.example:8443"]));
    assert_eq!(p["secretNames"], json!(["api", "env_key", "stolen"]));
    import(c, &f).await;
    assert_eq!(w.count("SELECT count(*) FROM audit WHERE op = 'network.grant' AND object = 'evil.example:8443'"), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review3_saving_what_was_shown_after_a_rename_keeps_the_target() {
    let w = world().await;
    let c = &w.c;
    let other = doc(c, "New", "").await;
    let t = doc(c, "Old", "").await;
    let s = doc(c, "S", "[[Old]] x").await;
    c.ok("tree.rename", json!({ "tree": "resources", "key": t, "name": "New" })).await;
    let shown = c.ok("resource.get", json!({ "id": s })).await["body"]["text"].as_str().unwrap().to_string();
    assert_eq!(shown, "[[New]] x");
    save_text(c, &s, &format!("{shown} y")).await.unwrap();
    assert_eq!(outgoing(c, &s).await[0].2.as_deref(), Some(t.as_str()), "not the other resource named New ({other})");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review4_a_single_reference_to_something_not_imported_is_cleared() {
    let w = world().await;
    let c = &w.c;
    let local = doc(c, "Local", "").await;
    let f = write_export(
        w.out.path(),
        "single",
        json!([{ "id": "d1", "kind": "test.refs:doc", "name": "A", "body": { "link": { "ref": local } },
                 "refs": [{ "field": "body.link", "seq": 0, "text": "Far away", "target": local }] }]),
    );
    let r = import(c, &f).await;
    let id = c.ok("tree.children", json!({ "tree": "resources", "parent": r["group"]["id"] })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    assert_eq!(c.ok("resource.get", json!({ "id": id })).await["body"]["link"]["ref"], Value::Null);
    let v = c.ok("refs.outgoing", json!({ "id": id })).await;
    assert_eq!((v[0]["text"].as_str(), v[0]["state"].as_str()), (Some("Far away"), Some("missing")));
    // Saving it again does not connect it to the local resource.
    c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "name": "A2" } })).await;
    assert!(incoming(c, &local).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review5_8_limits_duplicate_ids_and_untrusted_refs() {
    let w = world().await;
    let c = &w.c;
    // Too large: checked from the size, before reading.
    let big = write_export(w.out.path(), "big", json!([]));
    std::fs::File::options().write(true).open(big.join("resources.json")).unwrap().set_len(257 * 1024 * 1024).unwrap();
    let p = preview(c, &big).await;
    assert_eq!((p["valid"].as_bool(), p["problem"]["params"]["reason"].as_str()), (Some(false), Some("tooLarge")));
    let many: Vec<Value> = (0..200_001).map(|i| json!({ "id": format!("i{i}"), "kind": "x:y", "name": "n" })).collect();
    let p = preview(c, &write_export(w.out.path(), "many", Value::Array(many))).await;
    assert_eq!(p["problem"]["params"]["reason"], "tooLarge");
    let huge = "x".repeat(9 * 1024 * 1024);
    let p = preview(c, &write_export(w.out.path(), "huge", json!([{ "id": "h", "kind": "test.refs:doc", "name": "Huge", "body": { "text": huge } }]))).await;
    assert_eq!(skipped(&p), [("Huge".to_string(), "invalid".to_string())]);
    // Duplicate ids.
    let dup = write_export(w.out.path(), "dup", json!([{ "id": "a", "kind": "test.refs:doc", "name": "A" }, { "id": "a", "kind": "test.refs:doc", "name": "B" }]));
    let p = preview(c, &dup).await;
    assert_eq!((p["valid"].as_bool(), p["problem"]["params"]["reason"].as_str()), (Some(false), Some("duplicateId")));
    let e = c.call("workspace.import", json!({ "folder": dup, "fingerprint": "x" })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Invalid, Some("duplicateId")));
    // The file's refs rows are hints: wrong or repeated rows do not decide anything.
    let f = write_export(
        w.out.path(),
        "hints",
        json!([
            { "id": "a", "kind": "test.refs:doc", "name": "A", "body": { "text": "[[B]] [[C]]" },
              "refs": [{ "field": "body.text", "seq": 0, "text": "Z", "target": "c" }, { "field": "body.text", "seq": 0, "text": "Z", "target": "c" },
                       { "field": "body.text", "seq": 1, "text": "C", "target": "c" }, { "field": "body.other", "seq": 0, "text": "Q", "target": "b" }] },
            { "id": "b", "kind": "test.refs:doc", "name": "B" },
            { "id": "c", "kind": "test.refs:doc", "name": "C" }
        ]),
    );
    let r = import(c, &f).await;
    let kids = c.ok("tree.children", json!({ "tree": "resources", "parent": r["group"]["id"] })).await;
    let id = |n: &str| kids["nodes"].as_array().unwrap().iter().find(|x| x["label"] == n).unwrap()["key"].as_str().unwrap().to_string();
    let o = outgoing(c, &id("A")).await;
    assert_eq!(o.len(), 2, "only what the content holds");
    assert_eq!((o[0].0.as_str(), o[0].2.clone()), ("B", Some(id("B"))));
    assert_eq!((o[1].0.as_str(), o[1].2.clone()), ("C", Some(id("C"))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review6_resource_names_are_indexed() {
    let w = world().await;
    assert_eq!(w.count("SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'resources_name'"), 1);
}

fn refs_v2(root: &Path) {
    let dir = root.join("test.refs").join("0.2.0");
    std::fs::create_dir_all(&dir).unwrap();
    let mut m: Value = serde_json::from_slice(&std::fs::read(root.join("test.refs/0.1.0/manifest.json")).unwrap()).unwrap();
    m["version"] = json!("0.2.0");
    m["upgradesFrom"] = json!(">=0.1.0");
    m["contributes"]["kinds"][0]["fields"]["note"] = json!({ "type": "text", "refs": true });
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    let main = std::fs::read_to_string(root.join("test.refs/0.1.0/main.js")).unwrap().replace(
        "host.commands.handle(\"probe\", probe);",
        "host.commands.handle(\"probe\", probe);\n  host.kinds.handle(\"doc\", { async migrate(body) { return body; } });",
    );
    std::fs::write(dir.join("main.js"), main).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review7_9_new_reference_fields_and_undo_under_readonly() {
    let w = world().await;
    let c = &w.c;
    let a = doc(c, "A", "").await;
    let d = doc(c, "D", "").await;
    c.probe("test.refs", "resources.update", json!([d, { "body.note": "see [[A]]" }])).await;
    assert!(outgoing(c, &d).await.is_empty(), "note is not a reference field yet");
    let plugins = w.env.path().join("plugins");
    refs_v2(&plugins);
    c.ok("plugin.rescan", json!({ "builtin": ["test.refs@0.2.0"] })).await;
    // Review #7: the newly declared field's references appear.
    assert_eq!(outgoing(c, &d).await, vec![("A".into(), "ok".into(), Some(a.clone()))]);
    let batch: String = w.db().query_row("SELECT id FROM upgrade_batches ORDER BY at DESC LIMIT 1", [], |r| r.get(0)).unwrap();
    let ws = root(c, "config").await;
    c.ok("params.set", json!({ "node": ws, "name": "protection.readonly", "value": "true", "type": "boolean" })).await;
    // Review #9: an empty save writes nothing and is not refused …
    c.ok("page.save", json!({ "target": format!("resource:{d}"), "changes": {} })).await;
    // … an undo that would rewrite resources is …
    let e = c.call("plugin.undoUpgrade", json!({ "batch": batch })).await.unwrap_err();
    assert_eq!(reason(&e), (&ErrorCode::Denied, Some("readonly")));
    // … and one that rewrites nothing (everything changed since) is not.
    c.ok("params.set", json!({ "node": ws, "name": "protection.readonly", "value": "false" })).await;
    save_text(c, &d, "changed").await.unwrap();
    save_text(c, &a, "changed").await.unwrap();
    c.ok("params.set", json!({ "node": ws, "name": "protection.readonly", "value": "true" })).await;
    let r = c.ok("plugin.undoUpgrade", json!({ "batch": batch })).await;
    assert_eq!(r["restored"], 0);
    assert_eq!(r["modified"].as_array().unwrap().len(), 2);
}

/* ------------------------------------------------------------------ D330: written before the target existed */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn d330_a_reference_written_first_connects_when_the_name_appears() {
    let w = world().await;
    let c = &w.c;
    let s = doc(c, "S", "see [[乙]] and [[丙]]").await;
    assert_eq!(outgoing(c, &s).await[0].1, "missing");
    // Watch from here on: both ends are told.
    let watch = Client::in_proc(w.env.kernel.clone());
    watch.hello().await;
    let yi = doc(c, "乙", "").await;
    assert_eq!(outgoing(c, &s).await[0], ("乙".into(), "ok".into(), Some(yi.clone())));
    assert_eq!(incoming(c, &yi).await, vec![s.clone()]);
    let topic = format!("resource:{s}");
    watch.event(|e| e.topic == topic).await;
    // Renaming another resource to the waited-for name connects too.
    let other = doc(c, "Other", "").await;
    c.ok("tree.rename", json!({ "tree": "resources", "key": other, "name": "丙" })).await;
    assert_eq!(outgoing(c, &s).await[1], ("丙".into(), "ok".into(), Some(other.clone())));
    // Undeleting something with the name connects as well.
    let t = doc(c, "S2 target", "").await;
    c.ok("resource.delete", json!({ "id": t })).await;
    let s2 = doc(c, "S2", "[[S2 target]]").await;
    assert_eq!(outgoing(c, &s2).await[0].1, "missing");
    c.ok("resource.undelete", json!({ "id": t })).await;
    assert_eq!(outgoing(c, &s2).await[0].2.as_deref(), Some(t.as_str()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn d330_purged_targets_stay_missing_and_namesakes_are_chosen_from_the_source() {
    let w = world().await;
    let c = &w.c;
    // Pointed once, target purged: a new namesake is not connected (D323).
    let t = doc(c, "Gone", "").await;
    let s = doc(c, "S", "[[Gone]]").await;
    c.ok("resource.delete", json!({ "id": t })).await;
    c.ok("resource.purge", json!({ "id": t })).await;
    // Editing elsewhere in the text keeps it "has pointed".
    save_text(c, &s, "[[Gone]] edited").await.unwrap();
    doc(c, "Gone", "").await;
    assert_eq!(outgoing(c, &s).await[0].1, "missing");
    // Waiting sources in different groups; the name appears in G2: each source resolves from its own
    // side (D322) and, with one candidate, all take it.
    let g1 = group(c, "G1").await;
    let g2 = group(c, "G2").await;
    let s1 = doc_in(c, Some(&g1), "S1", "[[Twin]]").await;
    let s2 = doc_in(c, Some(&g2), "S2", "[[Twin]]").await;
    let in2 = doc_in(c, Some(&g2), "Twin", "").await;
    assert_eq!(outgoing(c, &s1).await[0].2.as_deref(), Some(in2.as_str()));
    assert_eq!(outgoing(c, &s2).await[0].2.as_deref(), Some(in2.as_str()));
    // Connected rows stay with their target (by id) when another namesake appears in G1.
    let in1 = doc_in(c, Some(&g1), "Twin", "").await;
    assert_eq!(outgoing(c, &s1).await[0].2.as_deref(), Some(in2.as_str()));
    let _ = in1;
    // Two namesakes appear at once (one import): a waiting source outside both takes the one first in
    // tree order — inside the imported group "Box" (position 0) before the one after it.
    let w8 = doc(c, "Waits", "[[Double]]").await;
    let f = write_export(
        w.out.path(),
        "double",
        json!([
            { "id": "box", "kind": "core:group", "name": "Box" },
            { "id": "d1", "kind": "test.refs:doc", "parent": "box", "name": "Double" },
            { "id": "d2", "kind": "test.refs:doc", "name": "Double" }
        ]),
    );
    let r = import(c, &f).await;
    let top = c.ok("tree.children", json!({ "tree": "resources", "parent": r["group"]["id"] })).await;
    let bx = top["nodes"][0]["key"].as_str().unwrap().to_string();
    let inner = c.ok("tree.children", json!({ "tree": "resources", "parent": bx })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    assert_eq!(outgoing(c, &w8).await[0].2.as_deref(), Some(inner.as_str()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn d330_imported_names_connect_waiting_references() {
    let w = world().await;
    let c = &w.c;
    let s = doc(c, "S", "[[From elsewhere]]").await;
    let f = write_export(w.out.path(), "names", json!([{ "id": "x", "kind": "test.refs:doc", "name": "From elsewhere" }]));
    let r = import(c, &f).await;
    let id = c.ok("tree.children", json!({ "tree": "resources", "parent": r["group"]["id"] })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    assert_eq!(outgoing(c, &s).await[0].2.as_deref(), Some(id.as_str()));
}
