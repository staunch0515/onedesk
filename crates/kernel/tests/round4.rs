//! Round 4 (docs/handoff/round4-plan.md §9): install and versions, secrets, network. Uses only
//! an in-memory secret store and a local HTTP server.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use onedesk_kernel::secrets::{MemoryStore, SecretStoreHandle};
use onedesk_protocol::ErrorCode;
use rusqlite::Connection;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

/// Writes `<root>/<id>/<version>/` with a manifest and `main.js`.
fn package(root: &Path, id: &str, version: &str, extra: Value, main: &str) -> PathBuf {
    let dir = root.join(id).join(version);
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({ "id": id, "version": version, "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js" });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(dir.join("main.js"), main).unwrap();
    dir
}

struct World {
    env: Env,
    c: Client,
    plugins: PathBuf,
    secrets: Arc<MemoryStore>,
}

async fn world(build: impl FnOnce(&Path)) -> World {
    let tmp = tempfile::tempdir().unwrap();
    let plugins = tmp.path().join("plugins");
    std::fs::create_dir_all(&plugins).unwrap();
    build(&plugins);
    let (handle, secrets) = SecretStoreHandle::memory();
    let mut cfg = test_config();
    cfg.secrets = handle;
    // An 8 MB response body is copied a few times inside the plugin (probe → JSON → effect).
    cfg.sandbox.memory_limit = 96 * 1024 * 1024;
    let env = open_with(tmp, &plugins, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    World { env, c, plugins, secrets }
}

fn db(env: &Env) -> Connection {
    Connection::open(env.kernel.db_path()).unwrap()
}

fn audit_ops(env: &Env, op: &str) -> Vec<String> {
    let conn = db(env);
    let mut st = conn.prepare("SELECT object FROM audit WHERE op = ?1 AND result = 'ok' ORDER BY seq").unwrap();
    st.query_map([op], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
}

/* ------------------------------------------------------------------ versions */

fn vers_main(tag: &str, migrate: &str) -> String {
    format!(
        r#"{PROBE}
export default {{ activate(host) {{
  host.pages.handle("p", {{ async render(ctx) {{ return {{ view: [{{ type: "text", id: "v", text: "{tag}" }}] }}; }} }});
  host.commands.handle("probe", probe);
  host.kinds.handle("doc", {{ {migrate} }});
}} }};"#
    )
}

fn vers_manifest(upgrades: Option<&str>, network: bool) -> Value {
    let mut m = json!({
        "contributes": {
            "kinds": [{ "id": "doc", "label": "k", "icon": "file", "tree": "resources", "page": "p", "newName": "k", "defaults": { "text": "" } }],
            "pages": [{ "id": "p" }],
            "commands": [{ "id": "probe", "label": "c", "palette": true }],
            "settings": [{ "name": "s", "label": "s", "type": "text", "default": "d" }],
            "menus": { "new": ["doc"] }
        }
    });
    if let Some(u) = upgrades {
        m["upgradesFrom"] = json!(u);
    }
    if network {
        m["requires"] = json!({ "network": { "hosts": ["example.invalid"] } });
    }
    m
}

const MIGRATE_V2: &str = r#"async migrate(body, from, ctx) {
    if (body.bad) throw new Error("cannot migrate");
    let writeError = null;
    try { await ctx.host.storage.set("x", 1); } catch (e) { writeError = e.code + "/" + (e.params || {}).reason; }
    const old = await ctx.host.storage.readFrom(from, "remember");
    return { ...body, note: "from " + from, writeError, old };
  }"#;

async fn doc(c: &Client, text: &str) -> String {
    let r = c.ok("page.save", json!({ "target": "new:test.vers:doc", "changes": { "body.text": text } })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn view_text(c: &Client, id: &str) -> Value {
    c.ok("page.resolve", json!({ "target": format!("resource:{id}") })).await["view"][0]["text"].clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inspect_reports_bad_packages_and_permissions() {
    let w = world(|p| {
        package(p, "test.vers", "0.1.0", vers_manifest(None, false), &vers_main("v1", ""));
    })
    .await;
    let outside = w.env.path().join("incoming");
    // Not a folder; a broken manifest; already installed; a good one with an added permission.
    let pv = w.c.ok("plugin.inspect", json!({ "folder": outside.join("nope").display().to_string() })).await;
    assert_eq!((pv["valid"].as_bool(), pv["problem"]["params"]["reason"].as_str()), (Some(false), Some("notFolder")));
    let bad = package(&outside, "x", "y", json!({ "apiVersion": "1", "contributes": {} }), "");
    let pv = w.c.ok("plugin.inspect", json!({ "folder": bad.display().to_string() })).await;
    assert_eq!(pv["problem"]["params"]["reason"], "apiVersion");
    let same = package(&outside, "a", "b", json!({ "id": "test.vers", "version": "0.1.0" }), "");
    std::fs::write(same.join("manifest.json"), std::fs::read(w.plugins.join("test.vers/0.1.0/manifest.json")).unwrap()).unwrap();
    let pv = w.c.ok("plugin.inspect", json!({ "folder": same.display().to_string() })).await;
    assert_eq!((pv["valid"].as_bool(), pv["problem"]["params"]["reason"].as_str()), (Some(false), Some("alreadyInstalled")));
    let next = package(&outside, "c", "d", json!({ "id": "test.vers", "version": "0.2.0" }), &vers_main("v2", MIGRATE_V2));
    let mut m = vers_manifest(Some(">=0.1.0"), true);
    m["id"] = json!("test.vers");
    m["version"] = json!("0.2.0");
    m["apiVersion"] = json!("2");
    m["name"] = json!("n");
    m["icon"] = json!("box");
    m["main"] = json!("main.js");
    std::fs::write(next.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
    let pv = w.c.ok("plugin.inspect", json!({ "folder": next.display().to_string() })).await;
    assert_eq!(pv["valid"], true, "{pv}");
    assert_eq!((pv["id"].as_str(), pv["version"].as_str()), (Some("test.vers"), Some("0.2.0")));
    assert_eq!(pv["installed"], json!(["0.1.0"]));
    assert_eq!(pv["addedPermissions"], json!(["network"]));
    assert_eq!(pv["permissions"][0]["id"], "network");
    assert_eq!(pv["permissions"][0]["detail"], "example.invalid");
    // Inspecting changed nothing.
    assert!(!w.plugins.join("test.vers/0.2.0").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn versions_install_confirm_take_over_switch_back_undo_and_remove() {
    let w = world(|p| {
        package(p, "test.vers", "0.1.0", vers_manifest(None, false), &vers_main("v1", ""));
    })
    .await;
    let c = &w.c;
    let a = doc(c, "a").await;
    let b = doc(c, "b").await;
    c.probe("test.vers", "storage.set", json!(["remember", "kept by v1"])).await;
    assert_eq!(view_text(c, &a).await, "v1");

    // Install 0.2.0: more permissions → installed but unconfirmed; 0.1.0 stays active.
    package(&w.plugins, "test.vers", "0.2.0", vers_manifest(Some(">=0.1.0"), true), &vers_main("v2", MIGRATE_V2));
    c.ok("plugin.rescan", Value::Null).await;
    assert_eq!(audit_ops(&w.env, "plugin.install"), vec!["test.vers@0.2.0"]);
    let d = c.ok("plugin.get", json!({ "plugin": "test.vers" })).await;
    assert_eq!(d["unconfirmed"], json!(["0.2.0"]));
    let active: Vec<&str> = d["versions"].as_array().unwrap().iter().filter(|v| v["active"] == true).map(|v| v["version"].as_str().unwrap()).collect();
    assert_eq!(active, vec!["0.1.0"]);
    let e = c.call("plugin.activateVersion", json!({ "plugin": "test.vers", "version": "0.2.0" })).await.unwrap_err();
    assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::Denied, "notConfirmed"));
    assert_eq!(view_text(c, &a).await, "v1");

    // Confirm → automatic switch with takeover (migrate: note, refused write, readFrom).
    c.ok("plugin.confirmPermissions", json!({ "plugin": "test.vers", "version": "0.2.0" })).await;
    let r = c.ok("resource.get", json!({ "id": a })).await;
    assert_eq!(r["pluginVersion"], "0.2.0");
    assert_eq!(r["body"]["note"], "from 0.1.0");
    assert_eq!(r["body"]["writeError"], "denied/pureCall", "writes are refused inside migrate");
    assert_eq!(r["body"]["old"], "kept by v1", "storage.readFrom reads the old version");
    assert_eq!(view_text(c, &a).await, "v2");
    let d = c.ok("plugin.get", json!({ "plugin": "test.vers" })).await;
    let batch = d["lastUpgrade"]["batch"].as_str().unwrap().to_string();
    assert_eq!(d["lastUpgrade"]["count"], 2);
    // Commands and settings exist once (the active version's).
    let palette = c.ok("command.palette", Value::Null).await;
    assert_eq!(palette.as_array().unwrap().iter().filter(|p| p["id"] == "test.vers:probe").count(), 1);
    assert_eq!(d["settings"].as_array().unwrap().len(), 1);

    // Switch back: new resources use 0.1.0, upgraded ones stay on 0.2.0.
    c.ok("plugin.activateVersion", json!({ "plugin": "test.vers", "version": "0.1.0" })).await;
    let n = doc(c, "new").await;
    assert_eq!(c.ok("resource.get", json!({ "id": n })).await["pluginVersion"], "0.1.0");
    assert_eq!(view_text(c, &n).await, "v1");
    assert_eq!(view_text(c, &a).await, "v2", "two versions side by side");

    // Undo the upgrade: untouched ones go back; a changed one is listed.
    c.ok("page.save", json!({ "target": format!("resource:{b}"), "changes": { "body.text": "b2" } })).await;
    let u = c.ok("plugin.undoUpgrade", json!({ "batch": batch, "also": [] })).await;
    assert_eq!(u["restored"], 1);
    assert_eq!(u["modified"], json!([{ "id": b, "name": "k" }]));
    let r = c.ok("resource.get", json!({ "id": a })).await;
    assert_eq!((r["pluginVersion"].as_str(), r["body"].get("note")), (Some("0.1.0"), None));
    assert_eq!(c.ok("resource.get", json!({ "id": b })).await["pluginVersion"], "0.2.0");

    // Remove 0.2.0 → b shows "missing plugin"; put it back → restored.
    let gone = w.env.path().join("removed");
    std::fs::rename(w.plugins.join("test.vers/0.2.0"), &gone).unwrap();
    c.ok("plugin.rescan", Value::Null).await;
    assert_eq!(audit_ops(&w.env, "plugin.remove"), vec!["test.vers@0.2.0"]);
    let node = c.ok("tree.children", json!({ "tree": "resources" })).await["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["key"] == b.as_str())
        .unwrap()
        .clone();
    assert_eq!((node["state"].as_str(), node["stateReason"].as_str()), (Some("missing-plugin"), Some("test.vers@0.2.0")));
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{b}") })).await;
    assert_eq!((p["state"].as_str(), p["readOnly"].as_bool(), p["view"].clone()), (Some("missing-plugin"), Some(true), json!([])));
    std::fs::rename(&gone, w.plugins.join("test.vers/0.2.0")).unwrap();
    c.ok("plugin.rescan", Value::Null).await;
    assert_eq!(c.ok("tree.children", json!({ "tree": "resources" })).await["nodes"].as_array().unwrap().iter().find(|n| n["key"] == b.as_str()).unwrap()["state"], "ok");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_migrate_changes_nothing_subset_needs_no_confirmation_and_old_ranges_stay() {
    let w = world(|p| {
        package(p, "test.vers", "0.1.0", vers_manifest(None, false), &vers_main("v1", ""));
    })
    .await;
    let c = &w.c;
    let a = doc(c, "a").await;
    let bad = c.ok("page.save", json!({ "target": "new:test.vers:doc", "changes": { "body.bad": true } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    package(&w.plugins, "test.vers", "0.2.0", vers_manifest(Some(">=0.1.0"), true), &vers_main("v2", MIGRATE_V2));
    c.ok("plugin.rescan", Value::Null).await;
    // One migrate fails: nothing is written, the active version does not change.
    let e = c.call("plugin.confirmPermissions", json!({ "plugin": "test.vers", "version": "0.2.0" })).await.unwrap_err();
    assert_eq!((e.code, e.params["reason"].as_str(), e.params["resource"].as_str()), (ErrorCode::PluginError, "migrateFailed", bad.as_str()));
    for id in [&a, &bad] {
        assert_eq!(c.ok("resource.get", json!({ "id": id })).await["pluginVersion"], "0.1.0");
    }
    let n: i64 = db(&w.env).query_row("SELECT count(*) FROM audit WHERE op = 'plugin.upgrade' AND result LIKE 'failed:%'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    c.ok("resource.delete", json!({ "id": bad })).await;
    c.ok("plugin.activateVersion", json!({ "plugin": "test.vers", "version": "0.2.0" })).await;
    // 0.3.0 asks for the same as 0.2.0 (subset): active without another confirmation, but it only
    // takes over 0.2.0 data — a 0.1.0 resource stays where it is.
    package(&w.plugins, "test.vers", "0.3.0", vers_manifest(Some(">=0.2.0"), true), &vers_main("v3", ""));
    let old = {
        c.ok("plugin.activateVersion", json!({ "plugin": "test.vers", "version": "0.1.0" })).await;
        doc(c, "old").await
    };
    c.ok("plugin.rescan", Value::Null).await;
    let d = c.ok("plugin.get", json!({ "plugin": "test.vers" })).await;
    assert_eq!(d["unconfirmed"], json!([]));
    assert_eq!(c.ok("resource.get", json!({ "id": a })).await["pluginVersion"], "0.3.0");
    assert_eq!(c.ok("resource.get", json!({ "id": old })).await["pluginVersion"], "0.1.0", "0.3.0 cannot take 0.1.0 over");
    assert_eq!(view_text(c, &old).await, "v1");
    // Pinned: a newer version does not take over automatically.
    c.ok("plugin.setPinned", json!({ "plugin": "test.vers", "version": "0.3.0", "pinned": true })).await;
    package(&w.plugins, "test.vers", "0.4.0", vers_manifest(Some(">=0.1.0"), true), &vers_main("v4", ""));
    c.ok("plugin.rescan", Value::Null).await;
    assert_eq!(c.ok("resource.get", json!({ "id": a })).await["pluginVersion"], "0.3.0");
    // History restore of a pre-upgrade value works on the current version.
    let h = c.ok("resource.history", json!({ "id": a })).await;
    let entry = h.as_array().unwrap().iter().find(|e| e["field"] == "body.note").unwrap()["id"].clone();
    c.ok("resource.restore", json!({ "id": a, "entryId": entry })).await;
    let r = c.ok("resource.get", json!({ "id": a })).await;
    assert_eq!((r["pluginVersion"].as_str(), r["body"].get("note")), (Some("0.3.0"), None));
}

/* ------------------------------------------------------------------ local HTTP server */

/// Answers: `/ok` → 200 echoing the Authorization header; `/redirect?to=<url>` → 302;
/// `/big` → 9 MB; `/slow` → waits 3 s.
async fn server() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { break };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 16384];
                let mut got = Vec::new();
                while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    got.extend_from_slice(&buf[..n]);
                }
                let head = String::from_utf8_lossy(&got).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let auth = head
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                    .map(|l| l[14..].trim().to_string())
                    .unwrap_or_default();
                let (status, extra, body) = if path.starts_with("/redirect") {
                    let to = path.split_once("to=").map(|(_, t)| t.to_string()).unwrap_or_default();
                    ("302 Found", format!("Location: {to}\r\n"), String::new())
                } else if path == "/big" {
                    ("200 OK", String::new(), "x".repeat(9 * 1024 * 1024))
                } else if path == "/slow" {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    ("200 OK", String::new(), "late".into())
                } else {
                    ("200 OK", String::new(), format!("hello auth={auth}"))
                };
                let resp = format!("HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = s.write_all(resp.as_bytes()).await;
            });
        }
    });
    port
}

fn net_plugins(p: &Path, port: u16) {
    let net = json!({
        "requires": { "network": { "hosts": [format!("127.0.0.1:{port}"), "*.localhost"], "fromResources": true },
                      "secrets": { "names": ["api-key"] } },
        "contributes": {
            "kinds": [{ "id": "call", "label": "k", "icon": "globe", "tree": "resources", "page": "p", "newName": "k",
                        "fields": { "url": { "type": "text", "grants": "network" }, "token": { "type": "secret" } } }],
            "pages": [{ "id": "p" }],
            "actions": [{ "id": "fetch", "label": "a", "kinds": ["call"], "output": "text" }],
            "commands": [{ "id": "probe", "label": "c" }]
        }
    });
    let main = format!(
        r#"{PROBE}
export default {{ activate(host) {{
  host.pages.handle("p", {{ async render() {{ return {{ view: [] }}; }} }});
  host.commands.handle("probe", probe);
  host.actions.handle("fetch", async (ctx, input) => {{
    let last;
    for (let i = 0; i < 3; i++) last = await ctx.host.network.request({{ url: input.url, headers: {{ Authorization: input.auth }} }});
    return {{ output: {{ type: "text", text: last.body }} }};
  }});
}} }};"#
    );
    package(p, "test.net", "0.1.0", net, &main);
    let peek = json!({ "requires": { "secrets": { "names": ["api-key"], "plaintext": true } },
                       "contributes": { "commands": [{ "id": "probe", "label": "c" }],
                                        "actions": [{ "id": "leak", "label": "a", "output": "text" }] } });
    package(p, "test.peek", "0.1.0", peek, &format!(
        r#"{PROBE} export default {{ activate(host) {{ host.commands.handle("probe", probe);
           host.actions.handle("leak", async (ctx) => ({{ output: {{ type: "text", text: "v=" + await ctx.host.secrets.get("api-key") }} }})); }} }};"#
    ));
    let other = json!({ "requires": { "secrets": { "names": ["other-key"] }, "network": { "hosts": [format!("127.0.0.1:{port}")] } },
                        "contributes": { "commands": [{ "id": "probe", "label": "c" }] } });
    package(p, "test.other", "0.1.0", other, &format!(r#"{PROBE} export default {{ activate(host) {{ host.commands.handle("probe", probe); }} }};"#));
}

fn req(url: String, auth: &str) -> Value {
    json!([{ "method": "GET", "url": url, "headers": { "Authorization": auth } }])
}

/* ------------------------------------------------------------------ secrets */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn secrets_are_substituted_scoped_and_never_stored_in_the_database() {
    let port = server().await;
    let w = world(|p| net_plugins(p, port)).await;
    let c = &w.c;
    let value = "S3cretValue-9z";
    c.ok("secrets.set", json!({ "name": "api-key", "value": value })).await;
    c.ok("secrets.set", json!({ "name": "other-key", "value": "other-value" })).await;
    let list = c.ok("secrets.list", Value::Null).await;
    assert_eq!(list[0]["name"], "api-key");
    assert!(list[0].get("value").is_none());
    assert!(list[0]["usedBy"].as_array().unwrap().contains(&json!("test.net")));
    assert_eq!(w.secrets.accounts().len(), 2);
    let ok = format!("http://127.0.0.1:{port}/ok");
    // Substituted on the way out, scrubbed on the way back.
    let r = c.probe("test.net", "network.request", req(ok.clone(), "Bearer {{secret:api-key}}")).await;
    assert_eq!(r["ok"]["body"], "hello auth=Bearer ***", "{r}");
    // Not on its list, another plugin's, unknown, plaintext without declaring it.
    assert_eq!(c.probe("test.net", "network.request", req(ok.clone(), "{{secret:other-key}}")).await["params"]["reason"], "secretNotAllowed");
    assert_eq!(c.probe("test.other", "network.request", req(ok.clone(), "{{secret:api-key}}")).await["params"]["reason"], "secretNotAllowed");
    c.ok("secrets.delete", json!({ "name": "other-key" })).await;
    assert_eq!(c.probe("test.other", "network.request", req(ok.clone(), "{{secret:other-key}}")).await["params"]["reason"], "unknownSecret");
    assert_eq!(c.probe("test.net", "secrets.get", json!(["api-key"])).await["params"]["reason"], "plaintextUndeclared");
    // Plaintext with the permission: the run's output is scrubbed.
    let id = c.ok("run.start", json!({ "action": "test.peek:leak", "target": "core:none", "tabId": "t" })).await;
    let run = loop {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            break r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(run["output"]["text"], "v=***");
    // Form secret field: value to the keychain, the resource keeps a name.
    let saved = c
        .ok("page.save", json!({ "target": "new:test.net:call", "changes": { "body.url": ok, "body.token": "FormSecret-77" } }))
        .await;
    let rid = saved["page"]["resourceId"].as_str().unwrap().to_string();
    let r = c.ok("resource.get", json!({ "id": rid })).await;
    assert_eq!(r["body"]["token"], json!({ "secret": format!("{rid}.token") }));
    assert_eq!(saved["page"]["values"].get("body.token").cloned().unwrap_or(json!(null)), json!(null), "the page binds no secret field here");
    // The plugin may now use the resource's own secret name.
    let r2 = c.probe("test.net", "network.request", req(format!("http://127.0.0.1:{port}/ok"), &format!("{{{{secret:{rid}.token}}}}"))).await;
    assert_eq!(r2["ok"]["body"], "hello auth=***");
    let ws = w.env.kernel.db_path().parent().unwrap().to_path_buf();
    drop(db(&w.env).query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())));
    for f in ["workspace.db", "workspace.db-wal"] {
        let bytes = std::fs::read(ws.join(f)).unwrap_or_default();
        for v in [value, "FormSecret-77"] {
            assert!(!bytes.windows(v.len()).any(|x| x == v.as_bytes()), "{v} in {f}");
        }
    }
    // Permanent deletion takes the resource's secrets along.
    c.ok("resource.delete", json!({ "id": rid })).await;
    c.ok("resource.purge", json!({ "id": rid })).await;
    assert!(!w.secrets.accounts().iter().any(|a| a.ends_with(&format!("{rid}.token"))));
    assert!(!c.ok("secrets.list", Value::Null).await.as_array().unwrap().iter().any(|s| s["name"] == format!("{rid}.token")));
    // A secret parameter must name an existing secret.
    let def = c.ok("tree.children", json!({ "tree": "env" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    let e = c.call("params.set", json!({ "node": def, "name": "k", "value": "nope", "type": "secret" })).await.unwrap_err();
    assert_eq!(e.params["reason"], "unknownSecret");
    c.ok("params.set", json!({ "node": def, "name": "k", "value": "api-key", "type": "secret" })).await;
}

/* ------------------------------------------------------------------ network */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn network_allow_lists_redirects_loopback_limits_and_counting() {
    let port = server().await;
    let w = world(|p| net_plugins(p, port)).await;
    let c = &w.c;
    let base = format!("http://127.0.0.1:{port}");
    let reason = |v: &Value| v["params"]["reason"].as_str().unwrap_or_default().to_string();
    // Allowed host; an unlisted one; a redirect to an unlisted host; a redirect that stays.
    assert_eq!(c.probe("test.net", "network.request", req(format!("{base}/ok"), "x")).await["ok"]["status"], 200);
    assert_eq!(reason(&c.probe("test.net", "network.request", req("http://example.invalid/".into(), "x")).await), "hostNotAllowed");
    let out = format!("{base}/redirect?to=http://localhost:{port}/ok");
    assert_eq!(reason(&c.probe("test.net", "network.request", req(out, "x")).await), "hostNotAllowed");
    let stay = format!("{base}/redirect?to=/ok");
    assert_eq!(c.probe("test.net", "network.request", req(stay, "x")).await["ok"]["body"], "hello auth=x");
    // A wildcard host that resolves to a loopback address: refused unless written out.
    assert_eq!(reason(&c.probe("test.net", "network.request", req(format!("http://a.localhost:{port}/ok"), "x")).await), "localAddress");
    // Truncated body; timeout.
    let big = c.probe("test.net", "network.request", req(format!("{base}/big"), "x")).await;
    assert_eq!((big["ok"]["truncated"].as_bool(), big["ok"]["body"].as_str().unwrap().len()), (Some(true), 8 * 1024 * 1024));
    let slow = c.probe("test.net", "network.request", json!([{ "url": format!("{base}/slow"), "timeoutMs": 300 }])).await;
    assert_eq!(reason(&slow), "timeout");
    // network.allow: a layer that does not list the host blocks it; an empty list blocks everything.
    let ws_cfg = c.ok("tree.children", json!({ "tree": "config" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    c.ok("params.set", json!({ "node": ws_cfg, "name": "network.allow", "value": "api.example.com", "type": "list" })).await;
    assert_eq!(reason(&c.probe("test.net", "network.request", req(format!("{base}/ok"), "x")).await), "blockedByPolicy");
    c.ok("params.set", json!({ "node": ws_cfg, "name": "network.allow", "value": format!("127.0.0.1:{port}") })).await;
    assert_eq!(c.probe("test.net", "network.request", req(format!("{base}/ok"), "x")).await["ok"]["status"], 200);
    c.ok("params.set", json!({ "node": ws_cfg, "name": "network.allow", "value": "" })).await;
    assert_eq!(reason(&c.probe("test.net", "network.request", req(format!("{base}/ok"), "x")).await), "blockedByPolicy");
    // An environment layer that lists more than the configuration allows is marked restricted.
    c.ok("params.set", json!({ "node": ws_cfg, "name": "network.allow", "value": format!("127.0.0.1:{port}") })).await;
    let def = c.ok("tree.children", json!({ "tree": "env" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    c.ok("params.set", json!({ "node": def, "name": "network.allow", "value": "other.example.com" })).await;
    let ev = c.ok("params.env", json!({ "envId": def })).await;
    let p = ev["params"].as_array().unwrap().iter().find(|p| p["name"] == "network.allow").unwrap();
    assert!(p.get("restricted").is_some());
    // A plugin without network permission.
    assert_eq!(reason(&c.probe("test.peek", "network.request", req(format!("{base}/ok"), "x")).await), "notRequested");
    // Hosts granted by a resource field: audited as network.grant when saved.
    c.ok("page.save", json!({ "target": "new:test.net:call", "changes": { "body.url": "http://granted.example.net/x" } })).await;
    assert_eq!(audit_ops(&w.env, "network.grant"), vec!["granted.example.net"]);
    // Counting: three calls in one run are one audit row with a count.
    let res = c.ok("page.save", json!({ "target": "new:test.net:call", "changes": { "body.url": format!("{base}/ok") } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    let id = c
        .ok("run.start", json!({ "action": "fetch", "resourceId": res, "target": format!("resource:{res}"), "tabId": "t",
                                 "input": { "url": format!("{base}/ok"), "auth": "a" } }))
        .await;
    loop {
        if c.ok("run.get", json!({ "id": id })).await["status"] != "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let rows = c.ok("audit.list", json!({ "operation": "network.request" })).await;
    let counted: Vec<&Value> = rows.as_array().unwrap().iter().filter(|r| r["count"] == 3).collect();
    assert_eq!(counted.len(), 1, "{rows}");
    assert_eq!(counted[0]["target"], "127.0.0.1");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn network_request_ends_when_the_run_is_cancelled() {
    let port = server().await;
    let w = world(|p| {
        net_plugins(p, port);
    })
    .await;
    let c = &w.c;
    let res = c.ok("page.save", json!({ "target": "new:test.net:call", "changes": {} })).await["page"]["resourceId"].as_str().unwrap().to_string();
    let id = c
        .ok("run.start", json!({ "action": "fetch", "resourceId": res, "target": format!("resource:{res}"), "tabId": "t",
                                 "input": { "url": format!("http://127.0.0.1:{port}/slow"), "auth": "a" } }))
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let t = std::time::Instant::now();
    c.ok("run.cancel", json!({ "id": id })).await;
    loop {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            assert_eq!(r["status"], "cancelled");
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(t.elapsed() < Duration::from_secs(2), "cancel did not wait for the slow server");
}
