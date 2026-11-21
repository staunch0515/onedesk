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

/// Confirms a version with the fingerprint the plugin page shows for it (D312).
async fn confirm(c: &Client, plugin: &str, version: &str) -> Result<Value, onedesk_protocol::ProtocolError> {
    let d = c.ok("plugin.get", json!({ "plugin": plugin })).await;
    let fp = d["versions"].as_array().unwrap().iter().find(|v| v["version"] == version).unwrap()["fingerprint"].clone();
    c.call("plugin.confirmPermissions", json!({ "plugin": plugin, "version": version, "fingerprint": fp })).await
}

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
    confirm(c, "test.vers", "0.2.0").await.unwrap();
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
    let e = confirm(c, "test.vers", "0.2.0").await.unwrap_err();
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
        // Going back by hand pins 0.1.0 (D314), so the scan below does not switch yet.
        c.ok("plugin.activateVersion", json!({ "plugin": "test.vers", "version": "0.1.0" })).await;
        doc(c, "old").await
    };
    c.ok("plugin.rescan", Value::Null).await;
    assert_eq!(c.ok("resource.get", json!({ "id": a })).await["pluginVersion"], "0.2.0", "pinned: no automatic switch");
    c.ok("plugin.setPinned", json!({ "plugin": "test.vers", "version": "0.1.0", "pinned": false })).await;
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
    // History restore of a pre-upgrade value (review #10): the snapshot was bound to 0.1.0, which
    // is still installed, so the restored content goes back to 0.1.0.
    let h = c.ok("resource.history", json!({ "id": a })).await;
    let entry = h.as_array().unwrap().iter().find(|e| e["field"] == "body.note").unwrap()["id"].clone();
    c.ok("resource.restore", json!({ "id": a, "entryId": entry })).await;
    let r = c.ok("resource.get", json!({ "id": a })).await;
    assert_eq!((r["pluginVersion"].as_str(), r["body"].get("note")), (Some("0.1.0"), None));
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
                } else if let Some(want) = path.strip_prefix("/match/") {
                    // Round 17: whether the Authorization header is exactly `want` (never echoed).
                    ("200 OK", String::new(), format!("match={}", auth == want.replace("%20", " ")))
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
    net_plugins_with(p, port, &[])
}

fn net_plugins_with(p: &Path, port: u16, extra_hosts: &[String]) {
    let mut hosts = vec![format!("127.0.0.1:{port}"), format!("*.localhost:{port}")];
    hosts.extend(extra_hosts.iter().cloned());
    let net = json!({
        "requires": { "network": { "hosts": hosts, "fromResources": true },
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
    // Round 17: HTTP Basic and base64 encoded by the kernel; the encoded form is scrubbed too.
    let basic = format!("Basic {}", "YWxpY2U6UzNjcmV0VmFsdWUtOXo="); // alice:S3cretValue-9z
    let r = c.probe("test.net", "network.request", req(format!("http://127.0.0.1:{port}/match/{}", basic.replace(' ', "%20")), "Basic {{secret:api-key|basic:alice}}")).await;
    assert_eq!(r["ok"]["body"], "match=true", "{r}");
    let r = c.probe("test.net", "network.request", req(ok.clone(), "Basic {{secret:api-key|basic:alice}}")).await;
    assert_eq!(r["ok"]["body"], "hello auth=Basic ***", "{r}");
    let r = c.probe("test.net", "network.request", req(format!("http://127.0.0.1:{port}/match/UzNjcmV0VmFsdWUtOXo="), "{{secret:api-key|base64}}")).await;
    assert_eq!(r["ok"]["body"], "match=true", "{r}");
    let r = c.probe("test.net", "network.request", req(ok.clone(), "{{secret:api-key|rot13}}")).await;
    assert_eq!((r["error"].as_str(), r["params"]["reason"].as_str()), (Some("invalid"), Some("badSecretFormat")), "{r}");
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
    // The resource's own secret is usable for that resource (a run on it), not elsewhere (D318).
    let r2 = c.probe("test.net", "network.request", req(format!("http://127.0.0.1:{port}/ok"), &format!("{{{{secret:{rid}.token}}}}"))).await;
    assert_eq!(r2["params"]["reason"], "secretNotAllowed");
    let run = c
        .ok("run.start", json!({ "action": "fetch", "resourceId": rid, "target": format!("resource:{rid}"), "tabId": "t",
                                 "input": { "url": format!("http://127.0.0.1:{port}/ok"), "auth": format!("{{{{secret:{rid}.token}}}}") } }))
        .await;
    let done = loop {
        let r = c.ok("run.get", json!({ "id": run })).await;
        if r["status"] != "running" {
            break r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(done["output"]["text"], "hello auth=***", "{done}");
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
    assert_eq!(audit_ops(&w.env, "network.grant"), vec!["granted.example.net:80"]);
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

/* ------------------------------------------------------------------ after the round-4 review */

fn grant_plugin(p: &Path, version: &str, upgrades: Option<&str>) {
    let mut m = json!({
        "requires": { "network": { "fromResources": true } },
        "contributes": {
            "kinds": [{ "id": "site", "label": "k", "icon": "globe", "tree": "resources", "page": "p", "newName": "k",
                        "fields": { "url": { "type": "text", "grants": "network" } } }],
            "pages": [{ "id": "p" }],
            "commands": [{ "id": "probe", "label": "c" }]
        }
    });
    if let Some(u) = upgrades {
        m["upgradesFrom"] = json!(u);
    }
    let main = format!(
        r#"{PROBE}
export default {{ activate(host) {{
  host.commands.handle("probe", probe);
  host.pages.handle("p", {{
    async render() {{ return {{ view: [{{ type: "form", id: "f", layout: "stack", fields: [
      {{ name: "url", label: "u", kind: "text", bind: "body.url" }}, {{ name: "t", label: "t", kind: "text", bind: "body.text" }}] }}] }}; }},
    async onEvent() {{ return {{ changes: {{ "body.url": "http://evil.example/", "body.text": "ok" }} }}; }},
  }});
  host.kinds.handle("site", {{ migrate(body) {{ return {{ ...body, url: "http://evil.example/" }}; }} }});
}} }};"#
    );
    package(p, "test.grant", version, m, &main);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review1_plugins_cannot_grant_themselves_hosts_or_secrets() {
    let port = server().await;
    let w = world(|p| {
        grant_plugin(p, "0.1.0", None);
        net_plugins(p, port);
    })
    .await;
    let c = &w.c;
    let grant = |e: &Value| e["params"]["reason"].as_str().unwrap_or_default().to_string();
    // Creating or changing a granting field from plugin code: refused.
    let r = c.probe("test.grant", "resources.create", json!([{ "kind": "site", "name": "x", "body": { "url": "http://evil.example/" } }])).await;
    assert_eq!((r["error"].as_str(), grant(&r).as_str()), (Some("denied"), "grantField"));
    let r = c.probe("test.net", "resources.create", json!([{ "kind": "call", "name": "x", "body": { "token": { "secret": "api-key" } } }])).await;
    assert_eq!(grant(&r), "grantField", "secret references too");
    let id = c.ok("page.save", json!({ "target": "new:test.grant:site", "changes": { "body.url": "http://good.example/" } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    let r = c.probe("test.grant", "resources.update", json!([id, { "body.url": "http://evil.example/" }])).await;
    assert_eq!(grant(&r), "grantField");
    assert!(c.probe("test.grant", "resources.update", json!([id, { "body.text": "fine" }])).await.get("ok").is_some());
    // A page event cannot change it either (the field is dropped, the rest kept).
    let ev = c.ok("page.event", json!({ "target": format!("resource:{id}"), "event": "x", "context": { "draft": {} } })).await;
    assert_eq!(ev["changes"], json!({ "body.text": "ok" }));
    // Nor can a takeover: the whole batch fails and nothing changes.
    grant_plugin(&w.plugins, "0.2.0", Some(">=0.1.0"));
    c.ok("plugin.rescan", Value::Null).await;
    let r = c.ok("resource.get", json!({ "id": id })).await;
    assert_eq!((r["pluginVersion"].as_str(), r["body"]["url"].as_str()), (Some("0.1.0"), Some("http://good.example/")));
    let e = c.call("plugin.activateVersion", json!({ "plugin": "test.grant", "version": "0.2.0" })).await.unwrap_err();
    assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::Denied, "grantField"));
    assert_eq!(audit_ops(&w.env, "network.grant"), vec!["good.example:80"], "only the user's save granted a host");
    let n: i64 = db(&w.env).query_row("SELECT count(*) FROM resources WHERE body LIKE '%evil.example%'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review2_4_each_version_has_its_permissions_and_confirmation_checks_the_fingerprint() {
    let w = world(|p| {
        package(p, "test.vers", "0.1.0", vers_manifest(None, false), &vers_main("v1", ""));
    })
    .await;
    let c = &w.c;
    let incoming = w.env.path().join("incoming/test.vers/0.2.0");
    std::fs::create_dir_all(&incoming).unwrap();
    package(&w.env.path().join("incoming"), "test.vers", "0.2.0", vers_manifest(Some(">=0.1.0"), true), &vers_main("v2", ""));
    let pv = c.ok("plugin.inspect", json!({ "folder": incoming.display().to_string() })).await;
    let shown = pv["fingerprint"].as_str().unwrap().to_string();
    assert!(!shown.is_empty());
    package(&w.plugins, "test.vers", "0.2.0", vers_manifest(Some(">=0.1.0"), true), &vers_main("v2", ""));
    c.ok("plugin.rescan", Value::Null).await;
    let d = c.ok("plugin.get", json!({ "plugin": "test.vers" })).await;
    let v = |ver: &str| d["versions"].as_array().unwrap().iter().find(|x| x["version"] == ver).unwrap().clone();
    assert_eq!(v("0.2.0")["permissions"][0]["id"], "network", "the unconfirmed version's own permissions");
    assert_eq!(v("0.1.0")["permissions"], json!([]));
    assert_eq!(v("0.2.0")["fingerprint"], shown.as_str(), "the same fingerprint as in the install preview");
    let e = c.call("plugin.confirmPermissions", json!({ "plugin": "test.vers", "version": "0.2.0", "fingerprint": "not-it" })).await.unwrap_err();
    assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::Invalid, "fingerprintMismatch"));
    assert_eq!(c.ok("plugin.get", json!({ "plugin": "test.vers" })).await["unconfirmed"], json!(["0.2.0"]));
    c.ok("plugin.confirmPermissions", json!({ "plugin": "test.vers", "version": "0.2.0", "fingerprint": shown })).await;
    assert_eq!(c.ok("plugin.get", json!({ "plugin": "test.vers" })).await["unconfirmed"], json!([]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review3_secret_fields_of_a_new_page_never_reach_the_run_or_the_database() {
    let port = server().await;
    let w = world(|p| net_plugins(p, port)).await;
    let c = &w.c;
    let value = "NewPageSecret-55x";
    let id = c
        .ok("run.start", json!({ "action": "fetch", "target": "new:test.net:call", "tabId": "t",
                                 "input": { "url": format!("http://127.0.0.1:{port}/ok"), "auth": "a", "body.token": value } }))
        .await;
    let run = loop {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            break r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(run["input"].get("body.token").is_none(), "{run}");
    drop(db(&w.env).query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())));
    let dir = w.env.kernel.db_path().parent().unwrap().to_path_buf();
    for f in ["workspace.db", "workspace.db-wal"] {
        let bytes = std::fs::read(dir.join(f)).unwrap_or_default();
        assert!(!bytes.windows(value.len()).any(|x| x == value.as_bytes()), "{value} in {f}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review5_only_builtin_packages_are_confirmed_without_asking() {
    let port = server().await;
    let tmp = tempfile::tempdir().unwrap();
    let plugins = tmp.path().join("plugins");
    std::fs::create_dir_all(&plugins).unwrap();
    net_plugins(&plugins, port);
    let mut cfg = test_config();
    cfg.builtin = vec!["test.other@0.1.0".into()];
    let env = open_exact(tmp, &plugins, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    // Not built in, never confirmed: present but not usable.
    assert_eq!(c.ok("plugin.get", json!({ "plugin": "test.net" })).await["unconfirmed"], json!(["0.1.0"]));
    assert_eq!(c.ok("plugin.get", json!({ "plugin": "test.net" })).await["enabled"], false, "no usable version");
    assert_eq!(c.probe("test.other", "storage.keys", json!([])).await["ok"], json!([]), "the built-in one runs");
    assert_eq!(c.ok("plugin.get", json!({ "plugin": "test.other" })).await["unconfirmed"], json!([]));
    // The main process names it as built-in on a later scan: confirmed then.
    c.ok("plugin.rescan", json!({ "builtin": ["test.net@0.1.0"] })).await;
    let d = c.ok("plugin.get", json!({ "plugin": "test.net" })).await;
    assert_eq!((d["unconfirmed"].clone(), d["enabled"].as_bool()), (json!([]), Some(true)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review6_7_undo_stays_put_and_unconfirmed_code_never_runs() {
    let w = world(|p| {
        package(p, "test.vers", "0.1.0", vers_manifest(None, false), &vers_main("v1", ""));
    })
    .await;
    let c = &w.c;
    let a = doc(c, "a").await;
    package(&w.plugins, "test.vers", "0.2.0", vers_manifest(Some(">=0.1.0"), true), &vers_main("v2", MIGRATE_V2));
    c.ok("plugin.rescan", Value::Null).await;
    confirm(c, "test.vers", "0.2.0").await.unwrap();
    let batch = c.ok("plugin.get", json!({ "plugin": "test.vers" })).await["lastUpgrade"]["batch"].clone();
    c.ok("plugin.undoUpgrade", json!({ "batch": batch, "also": [] })).await;
    // D314: back on the version that was active before, pinned — a scan does not upgrade again.
    c.ok("plugin.rescan", Value::Null).await;
    let d = c.ok("plugin.get", json!({ "plugin": "test.vers" })).await;
    let active: Vec<(String, bool)> = d["versions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["active"] == true)
        .map(|v| (v["version"].as_str().unwrap().to_string(), v["pinned"].as_bool().unwrap()))
        .collect();
    assert_eq!(active, vec![("0.1.0".to_string(), true)]);
    assert_eq!(c.ok("resource.get", json!({ "id": a })).await["pluginVersion"], "0.1.0");
    // D315: a resource bound to 0.2.0, then 0.2.0 replaced by a package asking for more: disabled, not run.
    c.ok("plugin.setPinned", json!({ "plugin": "test.vers", "version": "0.2.0", "pinned": true })).await;
    assert_eq!(c.ok("resource.get", json!({ "id": a })).await["pluginVersion"], "0.2.0");
    std::fs::remove_dir_all(w.plugins.join("test.vers/0.2.0")).unwrap();
    let mut more = vers_manifest(Some(">=0.1.0"), true);
    more["requires"]["network"]["hosts"] = json!(["example.invalid", "more.example"]);
    package(&w.plugins, "test.vers", "0.2.0", more, &vers_main("v2-more", ""));
    c.ok("plugin.rescan", Value::Null).await;
    let node = c.ok("tree.children", json!({ "tree": "resources" })).await["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["key"] == a.as_str())
        .unwrap()
        .clone();
    assert_eq!((node["state"].as_str(), node["stateReason"].as_str()), (Some("disabled"), Some("unconfirmedVersion")));
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{a}") })).await;
    assert_eq!(p["view"], json!([]), "its page code is not run");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review8_11_redirects_drop_credentials_and_requests_are_limited() {
    let port = server().await;
    let port2 = server().await;
    let w = world(|p| net_plugins_with(p, port, &[format!("127.0.0.1:{port2}")])).await;
    let c = &w.c;
    c.ok("secrets.set", json!({ "name": "api-key", "value": "RedirectSecret-1" })).await;
    // Same host and port: the header stays (and its value is scrubbed in the answer).
    let same = format!("http://127.0.0.1:{port}/redirect?to=/ok");
    assert_eq!(c.probe("test.net", "network.request", req(same, "Bearer {{secret:api-key}}")).await["ok"]["body"], "hello auth=Bearer ***");
    // Another origin: Authorization and the substituted header are dropped.
    let other = format!("http://127.0.0.1:{port}/redirect?to=http://127.0.0.1:{port2}/ok");
    assert_eq!(c.probe("test.net", "network.request", req(other, "Bearer {{secret:api-key}}")).await["ok"]["body"], "hello auth=");
    // Methods and connection-level headers.
    let ok = format!("http://127.0.0.1:{port}/ok");
    let r = c.probe("test.net", "network.request", json!([{ "method": "TRACE", "url": ok }])).await;
    assert_eq!(r["params"]["reason"], "badMethod");
    for h in ["Host", "content-length", "Transfer-Encoding", "Connection"] {
        let r = c.probe("test.net", "network.request", json!([{ "url": ok, "headers": { h: "x" } }])).await;
        assert_eq!(r["params"]["reason"], "forbiddenHeader", "{h}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review10_restore_follows_version_rules_and_audits_grants() {
    let w = world(|p| {
        package(p, "test.vers", "0.1.0", vers_manifest(None, false), &vers_main("v1", ""));
        grant_plugin(p, "0.1.0", None);
    })
    .await;
    let c = &w.c;
    // Grants coming back through a restore are audited like a save.
    let id = c.ok("page.save", json!({ "target": "new:test.grant:site", "changes": { "body.url": "http://first.example/" } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "body.url": "http://second.example/" } })).await;
    let h = c.ok("resource.history", json!({ "id": id })).await;
    c.ok("resource.restore", json!({ "id": id, "entryId": h[0]["id"] })).await;
    assert_eq!(audit_ops(&w.env, "network.grant"), vec!["first.example:80", "second.example:80", "first.example:80"]);
    // A snapshot bound to a version that is gone, and the active one cannot take it over: refused.
    let a = doc(c, "a").await;
    c.ok("page.save", json!({ "target": format!("resource:{a}"), "changes": { "body.text": "a2" } })).await;
    package(&w.plugins, "test.vers", "0.2.0", vers_manifest(Some(">=0.1.0"), false), &vers_main("v2", ""));
    c.ok("plugin.rescan", json!({ "builtin": ["test.vers@0.2.0"] })).await;
    package(&w.plugins, "test.vers", "0.3.0", vers_manifest(Some(">=0.2.0"), false), &vers_main("v3", ""));
    c.ok("plugin.rescan", json!({ "builtin": ["test.vers@0.3.0"] })).await;
    assert_eq!(c.ok("resource.get", json!({ "id": a })).await["pluginVersion"], "0.3.0");
    std::fs::remove_dir_all(w.plugins.join("test.vers/0.1.0")).unwrap();
    std::fs::remove_dir_all(w.plugins.join("test.vers/0.2.0")).unwrap();
    c.ok("plugin.rescan", Value::Null).await;
    let h = c.ok("resource.history", json!({ "id": a })).await;
    let entry = h.as_array().unwrap().iter().find(|e| e["field"] == "body.text" && e["after"] == "a2").unwrap()["id"].clone();
    let e = c.call("resource.restore", json!({ "id": a, "entryId": entry })).await.unwrap_err();
    assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::Invalid, "needsVersion"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review14_a_failed_save_does_not_touch_the_keychain() {
    let port = server().await;
    let w = world(|p| net_plugins(p, port)).await;
    let c = &w.c;
    let saved = c.ok("page.save", json!({ "target": "new:test.net:call", "changes": { "body.token": "first-value" } })).await;
    let id = saved["page"]["resourceId"].as_str().unwrap().to_string();
    let account = w.secrets.accounts().into_iter().find(|a| a.ends_with(&format!("{id}.token"))).unwrap();
    use onedesk_kernel::secrets::SecretStore;
    assert_eq!(w.secrets.get(&account).unwrap().as_deref(), Some("first-value"));
    c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "body.url": "http://a.example/" } })).await;
    // A stale basis on the same field conflicts; the secret in the same save is not written.
    let e = c
        .call("page.save", json!({ "target": format!("resource:{id}"), "basis": "1",
                                   "changes": { "body.url": "http://b.example/", "body.token": "second-value" } }))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(w.secrets.get(&account).unwrap().as_deref(), Some("first-value"));
}

/* ------------------------------------------------------------------ acceptance fixes (D317, D318) */

/// Like the HTTP request plugin: the address grants its host and port; headers may hold secret references.
fn http_like(p: &Path) {
    let m = json!({
        "requires": { "network": { "fromResources": true } },
        "contributes": {
            "kinds": [{ "id": "req", "label": "k", "icon": "globe", "tree": "resources", "page": "p", "newName": "k",
                        "fields": { "url": { "type": "text", "grants": "network" }, "headers": { "type": "text", "secrets": true } } }],
            "pages": [{ "id": "p" }],
            "actions": [{ "id": "send", "label": "a", "kinds": ["req"], "output": "text" }],
            "commands": [{ "id": "probe", "label": "c" }]
        }
    });
    let main = format!(
        r#"{PROBE}
export default {{ activate(host) {{
  host.commands.handle("probe", probe);
  host.pages.handle("p", {{ async render() {{ return {{ view: [] }}; }} }});
  host.actions.handle("send", async (ctx, input) => {{
    const headers = {{}};
    for (const line of String(input["body.headers"] || "").split("\n")) {{
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }}
    const r = await ctx.host.network.request({{ url: input["body.url"], headers }});
    return {{ output: {{ type: "text", text: r.body }} }};
  }});
}} }};"#
    );
    package(p, "test.http", "0.1.0", m, &main);
}

async fn send(c: &Client, id: &str, url: &str, headers: &str) -> Value {
    let run = c
        .ok("run.start", json!({ "action": "send", "resourceId": id, "target": format!("resource:{id}"), "tabId": "t",
                                 "input": { "body.url": url, "body.headers": headers } }))
        .await;
    loop {
        let r = c.ok("run.get", json!({ "id": run })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn d317_a_granted_address_grants_its_port_only() {
    let port = server().await;
    let port2 = server().await;
    let w = world(http_like).await;
    let c = &w.c;
    let url = format!("http://127.0.0.1:{port}/ok");
    let id = c.ok("page.save", json!({ "target": "new:test.http:req", "changes": { "body.url": url } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(audit_ops(&w.env, "network.grant"), vec![format!("127.0.0.1:{port}")]);
    assert_eq!(send(c, &id, &url, "").await["output"]["text"], "hello auth=");
    // Same address, another port: refused, and the run says why.
    let r = send(c, &id, &format!("http://127.0.0.1:{port2}/other"), "").await;
    assert_eq!((r["error"]["code"].as_str(), r["error"]["reason"].as_str()), (Some("denied"), Some("hostNotAllowed")));
    // A redirect to the other port is checked the same way.
    let r = send(c, &id, &format!("http://127.0.0.1:{port}/redirect?to=http://127.0.0.1:{port2}/ok"), "").await;
    assert_eq!(r["error"]["reason"], "hostNotAllowed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn d318_saved_secret_references_are_usable_draft_ones_and_plugin_writes_are_not() {
    let port = server().await;
    let w = world(http_like).await;
    let c = &w.c;
    c.ok("secrets.set", json!({ "name": "api_key", "value": "SavedKey-123" })).await;
    c.ok("secrets.set", json!({ "name": "other_key", "value": "OtherKey-456" })).await;
    let url = format!("http://127.0.0.1:{port}/ok");
    let saved = "Authorization: Bearer {{secret:api_key}}";
    let id = c.ok("page.save", json!({ "target": "new:test.http:req", "changes": { "body.url": url, "body.headers": saved } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    // Saved: usable, and the value never comes back.
    let r = send(c, &id, &url, saved).await;
    assert_eq!((r["status"].as_str(), r["output"]["text"].as_str()), (Some("success"), Some("hello auth=Bearer ***")), "{r}");
    // A name only in the unsaved draft: not granted.
    let r = send(c, &id, &url, "Authorization: Bearer {{secret:other_key}}").await;
    assert_eq!((r["error"]["code"].as_str(), r["error"]["reason"].as_str()), (Some("denied"), Some("secretNotAllowed")));
    // The plugin cannot put a name there itself.
    let r = c.probe("test.http", "resources.update", json!([id, { "body.headers": "X: {{secret:other_key}}" }])).await;
    assert_eq!((r["error"].as_str(), r["params"]["reason"].as_str()), (Some("denied"), Some("grantField")));
    // Nor use a resource's names without being about that resource.
    let r = c.probe("test.http", "network.request", json!([{ "url": url, "headers": { "Authorization": "{{secret:api_key}}" } }])).await;
    assert_eq!(r["params"]["reason"], "secretNotAllowed");
    let dir = w.env.kernel.db_path().parent().unwrap().to_path_buf();
    drop(db(&w.env).query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())));
    for f in ["workspace.db", "workspace.db-wal"] {
        let bytes = std::fs::read(dir.join(f)).unwrap_or_default();
        assert!(!bytes.windows(12).any(|x| x == b"SavedKey-123"), "value in {f}");
    }
}
