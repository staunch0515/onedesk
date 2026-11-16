//! Round 9 (docs/handoff/round9-plan.md §8): the manifest cache `plugins/.index` (D364), idle
//! runtimes (D365), `ctx.host` valid only on its own invocation (D366), and the small fixes of
//! §6 (D367–D368). Every plugin is generated into a temporary folder; HTTP goes to a local
//! temporary server; secrets to the memory store.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::*;
use onedesk_kernel::manifest::Registry;
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
const tryIt = async (f) => { try { return { ok: await f() }; } catch (e) { return { error: e.code || String(e), params: e.params || {} }; } };
const text = (v) => ({ output: { type: "text", text: JSON.stringify(v) } });
"#;

/// Writes `<root>/<id>/<version>/` with a manifest made of the basics plus `extra`.
fn pkg(root: &Path, id: &str, version: &str, extra: Value, main: &str) -> PathBuf {
    let dir = root.join(id).join(version);
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({ "id": id, "version": version, "apiVersion": "2", "name": format!("{id} name"), "icon": "box", "main": "main.js" });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(dir.join("main.js"), format!("{PROBE}\n{main}")).unwrap();
    dir
}

struct W {
    env: Env,
    c: Client,
    #[allow(dead_code)]
    root: PathBuf,
}

async fn world_cfg(build: impl FnOnce(&Path), cfg: impl FnOnce(&mut onedesk_kernel::KernelConfig)) -> W {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    build(&root);
    let mut c = config_for(&root);
    cfg(&mut c);
    let env = open_exact(tmp, &root, c);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    W { env, c, root }
}

fn db(env: &Env) -> Connection {
    Connection::open(env.kernel.db_path()).unwrap()
}

async fn wait_run(c: &Client, id: &Value) -> Value {
    for _ in 0..1500 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {id} did not end");
}

async fn start(c: &Client, action: &str, input: Value) -> Value {
    c.ok("run.start", json!({ "action": action, "target": "core:none", "tabId": "t", "input": input })).await
}

async fn run(c: &Client, action: &str, input: Value) -> Value {
    let id = start(c, action, input).await;
    wait_run(c, &id).await
}

fn out(run: &Value) -> Value {
    serde_json::from_str(run["output"]["text"].as_str().unwrap_or_else(|| panic!("no text output: {run}"))).unwrap()
}

fn audit(env: &Env, op: &str) -> Vec<(String, String, String, String)> {
    let conn = db(env);
    let mut st = conn.prepare("SELECT actor, object, summary, result FROM audit WHERE op = ?1 ORDER BY seq").unwrap();
    st.query_map([op], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(|r| r.unwrap()).collect()
}

async fn eventually(what: &str, mut f: impl AsyncFnMut() -> bool) {
    for _ in 0..300 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("not reached: {what}");
}

/* ================================================================== §3 the manifest cache (D364) */

/// A package with a language file (still read from the package when the cache is used).
fn localized(root: &Path, id: &str, version: &str) -> PathBuf {
    let dir = pkg(
        root,
        id,
        version,
        json!({ "name": "plugin.name", "contributes": { "locales": { "en-US": "locales/en-US.json", "zh-CN": "locales/zh-CN.json" },
                "commands": [{ "id": "probe", "label": "plugin.name" }] } }),
        r#"export default { activate(host) { host.commands.handle("probe", probe); } };"#,
    );
    std::fs::create_dir_all(dir.join("locales")).unwrap();
    std::fs::write(dir.join("locales/en-US.json"), r#"{ "plugin.name": "Cached" }"#).unwrap();
    std::fs::write(dir.join("locales/zh-CN.json"), r#"{ "plugin.name": "缓存" }"#).unwrap();
    dir
}

/// The packages of the cache tests: good ones and one of each kind of bad entry.
fn cache_packages(root: &Path) {
    localized(root, "t.one", "0.1.0");
    localized(root, "t.one", "0.2.0");
    pkg(root, "t.two", "1.0.0", json!({}), "export default { activate() {} };");
    // Not JSON.
    let d = root.join("t.badjson/0.1.0");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("manifest.json"), "{ not json").unwrap();
    std::fs::write(d.join("main.js"), "").unwrap();
    // JSON, but not a valid manifest.
    pkg(root, "t.schema", "0.1.0", json!({ "unknownField": 1 }), "");
    // Valid JSON manifest that does not match its folder.
    pkg(root, "t.mismatch", "0.1.0", json!({ "version": "0.9.0" }), "");
    // No manifest at all.
    std::fs::create_dir_all(root.join("t.empty/0.1.0")).unwrap();
}

/// What the main process writes (round9-plan §3): every `<id>/<version>`, sorted by `dir`.
fn index_of(root: &Path) -> Value {
    let mut entries = Vec::new();
    let mut ids: Vec<_> = std::fs::read_dir(root).unwrap().map(|e| e.unwrap().path()).filter(|p| p.is_dir()).collect();
    ids.sort();
    for id in ids {
        let mut vs: Vec<_> = std::fs::read_dir(&id).unwrap().map(|e| e.unwrap().path()).filter(|p| p.is_dir()).collect();
        vs.sort();
        for v in vs {
            let dir = format!("{}/{}", id.file_name().unwrap().to_string_lossy(), v.file_name().unwrap().to_string_lossy());
            let m = v.join("manifest.json");
            let mut e = json!({ "dir": dir, "mtime": 1794800000000u64, "size": 0 });
            match std::fs::read_to_string(&m) {
                Ok(text) => {
                    e["size"] = json!(text.len());
                    e["manifest"] = json!(text);
                }
                Err(_) => e["error"] = json!("unreadable"),
            }
            entries.push(e);
        }
    }
    json!({ "version": 1, "entries": entries })
}

/// Copies a plugins folder without any `manifest.json` (code and language files only).
fn copy_without_manifests(from: &Path, to: &Path) {
    for e in walk(from) {
        let rel = e.strip_prefix(from).unwrap();
        if rel.file_name().is_some_and(|n| n == "manifest.json") {
            continue;
        }
        let dest = to.join(rel);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::copy(&e, &dest).unwrap();
    }
    // Empty package folders too.
    for id in std::fs::read_dir(from).unwrap() {
        for v in std::fs::read_dir(id.unwrap().path()).unwrap() {
            let v = v.unwrap().path();
            std::fs::create_dir_all(to.join(v.strip_prefix(from).unwrap())).unwrap();
        }
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

/// Everything a registry knows, with paths relative to its root: (id, version, manifest
/// fingerprint, language tables) and (package folder, reason) of the refused ones.
type Seen = (Vec<(String, String, String, String)>, Vec<(String, String)>);

fn seen(reg: &Registry, root: &Path) -> Seen {
    let mut ok = Vec::new();
    for id in reg.ids() {
        for p in reg.versions(&id) {
            ok.push((p.id.clone(), p.version.clone(), p.manifest_hash.clone(), serde_json::to_string(&p.locales).unwrap()));
        }
    }
    let mut bad: Vec<(String, String)> =
        reg.rejected().into_iter().map(|r| (r.path.strip_prefix(root).unwrap().display().to_string(), r.reason)).collect();
    bad.sort();
    (ok, bad)
}

#[test]
fn with_an_index_the_scan_reads_only_it_and_finds_the_same() {
    let tmp = tempfile::tempdir().unwrap();
    let full = tmp.path().join("full");
    cache_packages(&full);
    let direct = Registry::scan(&full);
    let expected = seen(&direct, &full);
    assert_eq!(expected.0.len(), 3, "{expected:?}");
    assert_eq!(
        expected.1,
        vec![
            ("t.badjson/0.1.0".to_string(), "badJson".to_string()),
            ("t.empty/0.1.0".into(), "noManifest".into()),
            ("t.mismatch/0.1.0".into(), "versionMismatch".into()),
            ("t.schema/0.1.0".into(), "schema".into()),
        ]
    );

    // The same packages with no `manifest.json` anywhere, only `.index`: if the kernel opened a
    // manifest file it would find none; if it listed folders it would find `t.extra`.
    let cached = tmp.path().join("cached");
    copy_without_manifests(&full, &cached);
    std::fs::write(cached.join(".index"), serde_json::to_vec(&index_of(&full)).unwrap()).unwrap();
    pkg(&cached, "t.extra", "0.1.0", json!({}), "export default { activate() {} };");
    assert!(walk(&cached).iter().filter(|p| p.ends_with("manifest.json")).count() == 1, "only t.extra has one");
    let from_index = Registry::scan(&cached);
    assert_eq!(seen(&from_index, &cached), expected, "same versions, fingerprints, languages and problems");
    assert!(from_index.versions("t.extra").is_empty(), "folders are not listed while the cache exists");

    // A bad entry is that package's problem only.
    let mut idx = index_of(&full);
    idx["entries"].as_array_mut().unwrap().push(json!({ "dir": "../escape", "mtime": 0, "size": 0, "manifest": "{}" }));
    std::fs::write(cached.join(".index"), serde_json::to_vec(&idx).unwrap()).unwrap();
    assert_eq!(seen(&Registry::scan(&cached), &cached), expected, "an entry that is not <id>/<version> is ignored");
    // Review #10: an absolute `dir` is ignored; a repeated `dir` counts once (the first).
    let mut idx = index_of(&full);
    let first = idx["entries"].as_array().unwrap().iter().find(|e| e["dir"] == "t.two/1.0.0").unwrap().clone();
    let mut twin = first.clone();
    twin["manifest"] = json!(first["manifest"].as_str().unwrap().replace("\"icon\": \"box\"", "\"icon\": \"star\""));
    let abs = full.join("t.two/1.0.0").display().to_string();
    idx["entries"].as_array_mut().unwrap().extend([twin, json!({ "dir": abs, "mtime": 0, "size": 0, "manifest": first["manifest"] })]);
    std::fs::write(cached.join(".index"), serde_json::to_vec(&idx).unwrap()).unwrap();
    let reg = Registry::scan(&cached);
    assert_eq!(seen(&reg, &cached), expected, "the twin and the absolute entry change nothing");
    assert_eq!(reg.version("t.two", "1.0.0").unwrap().manifest.icon, "box", "the first of two entries wins");

    // Rescan reads the cache again: the main process refreshed it with t.extra.
    std::fs::write(cached.join(".index"), serde_json::to_vec(&index_of(&full)).unwrap()).unwrap();
    let reg = Registry::scan(&cached);
    let mut idx = index_of(&full);
    let extra = std::fs::read_to_string(cached.join("t.extra/0.1.0/manifest.json")).unwrap();
    idx["entries"].as_array_mut().unwrap().push(json!({ "dir": "t.extra/0.1.0", "mtime": 0, "size": extra.len(), "manifest": extra }));
    std::fs::write(cached.join(".index"), serde_json::to_vec(&idx).unwrap()).unwrap();
    let diff = reg.rescan();
    assert_eq!(diff.added, vec![("t.extra".to_string(), "0.1.0".to_string())]);
    assert!(diff.removed.is_empty());
}

#[test]
fn without_a_usable_index_the_folder_is_scanned() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    cache_packages(&root);
    let expected = seen(&Registry::scan(&root), &root);
    // Not JSON, an unknown version, unreadable (a folder): the folder is read as before.
    for bad in [b"{ broken".to_vec(), br#"{ "version": 2, "entries": [] }"#.to_vec()] {
        std::fs::write(root.join(".index"), bad).unwrap();
        assert_eq!(seen(&Registry::scan(&root), &root), expected);
    }
    std::fs::remove_file(root.join(".index")).unwrap();
    std::fs::create_dir(root.join(".index")).unwrap();
    assert_eq!(seen(&Registry::scan(&root), &root), expected);
}

#[test]
fn a_scan_does_not_follow_symlinked_package_folders() {
    // Review #4: like the main process's cache, a link is not a package (id level or version level).
    let tmp = tempfile::tempdir().unwrap();
    let elsewhere = tmp.path().join("elsewhere");
    pkg(&elsewhere, "t.linked", "0.1.0", json!({}), "export default { activate() {} };");
    pkg(&elsewhere, "t.inner", "0.1.0", json!({}), "export default { activate() {} };");
    let root = tmp.path().join("plugins");
    pkg(&root, "t.real", "0.1.0", json!({}), "export default { activate() {} };");
    std::os::unix::fs::symlink(elsewhere.join("t.linked"), root.join("t.linked")).unwrap();
    std::fs::create_dir_all(root.join("t.inner")).unwrap();
    std::os::unix::fs::symlink(elsewhere.join("t.inner/0.1.0"), root.join("t.inner/0.1.0")).unwrap();
    let reg = Registry::scan(&root);
    assert_eq!(reg.ids(), vec!["t.real".to_string()]);
    assert!(reg.rejected().is_empty(), "{:?}", reg.rejected());
}

#[tokio::test]
async fn a_kernel_started_on_an_index_runs_plugins_from_their_folders() {
    let tmp = tempfile::tempdir().unwrap();
    let full = tmp.path().join("full");
    localized(&full, "t.one", "0.1.0");
    let root = tmp.path().join("plugins");
    copy_without_manifests(&full, &root);
    std::fs::write(root.join(".index"), serde_json::to_vec(&index_of(&full)).unwrap()).unwrap();
    let env = open_exact(tempfile::tempdir().unwrap(), &root, KernelConfigExt::with_builtin(&["t.one@0.1.0"]));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    // `main.js` comes from the package folder; the plugin answers.
    let r = c.probe("t.one", "storage.keys", json!([])).await;
    assert_eq!(r, json!({ "ok": [] }));
    // Language files too (D367: the plugins tree in the asked language).
    let zh = c.ok("tree.children", json!({ "tree": "plugins", "locale": "zh-CN" })).await;
    assert_eq!(zh["nodes"][0]["label"], "缓存");
    let en = c.ok("tree.children", json!({ "tree": "plugins" })).await;
    assert_eq!(en["nodes"][0]["label"], "Cached");
    drop(tmp);
}

#[test]
fn opening_with_thousands_of_packages_reads_and_writes_plugin_state_in_bulk() {
    // Round 9 addendum: start-up cost must not grow with one query and one transaction per
    // package. Counted, with a loose time bound only as a backstop.
    const N: usize = 2000;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    for i in 0..N {
        let id = format!("t.many-{i:05}");
        let dir = root.join(&id).join("0.1.0");
        std::fs::create_dir_all(&dir).unwrap();
        let m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js" });
        std::fs::write(dir.join("manifest.json"), m.to_string()).unwrap();
        std::fs::write(dir.join("main.js"), "export default { activate() {} };").unwrap();
    }
    std::fs::write(root.join(".index"), serde_json::to_vec(&index_of(&root)).unwrap()).unwrap();
    let ws = tmp.path().join("ws");
    for round in ["first", "second"] {
        let t = std::time::Instant::now();
        let k = onedesk_kernel::Kernel::open(&ws, &root, test_config()).unwrap();
        let took = t.elapsed();
        // First sight: one batch; later: nothing to write.
        assert!(k.writes_sent() <= 2, "{round}: {} writer commands", k.writes_sent());
        assert_eq!(k.state_queries(), 0, "{round}: plugin state read one by one");
        assert_eq!(k.rejected_plugins().len(), 0);
        assert!(took < Duration::from_secs(120), "{round}: {took:?}");
        let n: i64 = Connection::open(k.db_path())
            .unwrap()
            .query_row("SELECT count(*) FROM resources WHERE kind = 'core:plugin-state'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, N as i64, "{round}");
        k.shutdown();
    }
}

struct KernelConfigExt;
impl KernelConfigExt {
    fn with_builtin(ids: &[&str]) -> onedesk_kernel::KernelConfig {
        onedesk_kernel::KernelConfig { builtin: ids.iter().map(|s| s.to_string()).collect(), ..test_config() }
    }
}

/* ================================================================== §4 idle runtimes (D365) */

const IDLE_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("hold", async (ctx, input) => { await ctx.host.util.sleep(input.ms || 0); return text("held"); });
  host.actions.handle("remember", async (ctx, input) => { await ctx.host.storage.set("kept", input.v); return text("ok"); });
  host.actions.handle("ask", async (ctx, input) => {
    try { return text(await ctx.host.plugins.requestInstall({ folder: input.folder })); }
    catch (e) { return text({ error: e.code, reason: (e.params || {}).reason }); }
  });
  host.pages.handle("p", {
    async render(ctx) {
      await ctx.host.util.sleep((ctx.params && Number(ctx.params.ms)) || 0);
      return { view: [{ type: "text", id: "t", text: "page" }] };
    },
    async onEvent(ctx, e) {
      if (e === "wait") await ctx.host.util.sleep(1200);
      return { message: "event" };
    },
  });
  host.trees.handle("live", { async children(ctx) { return { nodes: [{ key: "a", label: "A", icon: "box" }] }; } });
  host.events.on("resource.changed", async (ctx, e) => {
    const n = ((await ctx.host.storage.get("events")) || 0) + 1;
    await ctx.host.storage.set("events", n);
  });
} };
"#;

fn idle_manifest() -> Value {
    json!({
        "requires": { "files": true, "plugins": { "install": true } },
        "contributes": {
            "kinds": [{ "id": "k", "label": "K", "icon": "box", "tree": "resources", "page": "p", "newName": "k" }],
            "pages": [{ "id": "p" }],
            "trees": [{ "id": "live", "label": "Live", "icon": "box", "source": "provided" }],
            "actions": [{ "id": "hold", "label": "H", "output": "text" }, { "id": "remember", "label": "R", "output": "text" },
                        { "id": "ask", "label": "A", "output": "text" }],
            "commands": [{ "id": "probe", "label": "probe" }],
            "events": ["resource.changed"]
        }
    })
}

const IDLE: Duration = Duration::from_millis(300);

async fn idle_world() -> W {
    world_cfg(
        |r| {
            pkg(r, "t.idle", "0.1.0", idle_manifest(), IDLE_MAIN);
        },
        |c| c.plugin_idle = IDLE,
    )
    .await
}

fn live(w: &W) -> bool {
    w.env.kernel.active_plugins().contains(&"t.idle".to_string())
}

async fn runtime_field(c: &Client) -> Value {
    c.ok("plugin.get", json!({ "plugin": "t.idle" })).await["runtime"].clone()
}

async fn wait_idle(w: &W) {
    for _ in 0..200 {
        if !live(w) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("t.idle was not released");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_quiet_runtime_is_released_and_every_use_brings_it_back() {
    let w = idle_world().await;
    let c = &w.c;
    assert!(!live(&w));
    assert_eq!(runtime_field(c).await, "idle", "nothing ran yet");
    let r = run(c, "t.idle:remember", json!({ "v": "stays" })).await;
    assert_eq!(r["status"], "success", "{r}");
    assert!(live(&w));
    assert_eq!(runtime_field(c).await, "live");
    // Released after the idle time, with the `plugins` topic; not a deactivation.
    let audit_rows = || db(&w.env).query_row("SELECT count(*) FROM audit", [], |r| r.get::<_, i64>(0)).unwrap();
    let rows_before = audit_rows();
    let topic = c.event(|e| e.topic == "plugins");
    let (_, _) = tokio::join!(topic, wait_idle(&w));
    assert_eq!(runtime_field(c).await, "idle");
    let d = c.ok("plugin.get", json!({ "plugin": "t.idle" })).await;
    assert_eq!(d["enabled"], true);
    assert_eq!(audit_rows(), rows_before, "no audit for a release");

    // Every way of using it activates it again; storage is still there.
    let page = c.ok("page.save", json!({ "target": "new:t.idle:k", "changes": { "name": "x" } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    let target = format!("resource:{page}");
    wait_idle(&w).await;
    let before = w.env.kernel.activation_count();
    let r = run(c, "t.idle:hold", json!({})).await;
    assert_eq!(out(&r), json!("held"));
    assert_eq!(c.probe("t.idle", "storage.get", json!(["kept"])).await, json!({ "ok": "stays" }), "storage survives a release");
    wait_idle(&w).await;
    let p = c.ok("page.resolve", json!({ "target": target, "context": {} })).await;
    assert_eq!(p["view"][0]["text"], "page");
    wait_idle(&w).await;
    let e = c.ok("page.event", json!({ "target": target, "event": "go" })).await;
    assert_eq!(e["message"], "event");
    wait_idle(&w).await;
    let t = c.ok("tree.children", json!({ "tree": "t.idle:live" })).await;
    assert_eq!(t["nodes"][0]["key"], "a");
    wait_idle(&w).await;
    let r = c.probe("t.idle", "storage.keys", json!([])).await;
    assert!(r["ok"].as_array().unwrap().contains(&json!("kept")), "{r}");
    wait_idle(&w).await;
    // An event subscription is delivered to a released runtime.
    let n0 = c.probe("t.idle", "storage.get", json!(["events"])).await["ok"].as_u64().unwrap_or(0);
    wait_idle(&w).await;
    c.ok("page.save", json!({ "target": "new:t.idle:k", "changes": { "name": "y" } })).await;
    eventually("event delivered after a release", async || {
        c.probe("t.idle", "storage.get", json!(["events"])).await["ok"].as_u64().unwrap_or(0) > n0
    })
    .await;
    assert!(w.env.kernel.activation_count() >= before + 6, "{} → {}", before, w.env.kernel.activation_count());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nothing_in_flight_is_released() {
    let w = idle_world().await;
    let c = &w.c;
    let still_live_after = async |w: &W| {
        tokio::time::sleep(IDLE * 3).await;
        assert!(live(w), "released while in use");
    };
    // A run waiting on a host call.
    let id = start(c, "t.idle:hold", json!({ "ms": 1500 })).await;
    still_live_after(&w).await;
    assert_eq!(wait_run(c, &id).await["status"], "success");
    wait_idle(&w).await;
    // A render and a page event in progress.
    let page = c.ok("page.save", json!({ "target": "new:t.idle:k", "changes": { "name": "x" } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    let target = format!("resource:{page}");
    wait_idle(&w).await;
    let render = c.ok("page.resolve", json!({ "target": target, "context": { "params": { "ms": "1200" } } }));
    let (p, _) = tokio::join!(render, still_live_after(&w));
    assert_eq!(p["view"][0]["text"], "page");
    wait_idle(&w).await;
    let ev = c.ok("page.event", json!({ "target": target, "event": "wait" }));
    let (e, _) = tokio::join!(ev, still_live_after(&w));
    assert_eq!(e["message"], "event");
    wait_idle(&w).await;
    // An install request waiting for the user.
    w.env.kernel.set_install_request_cooldown(Duration::ZERO);
    let folder = std::fs::canonicalize(w.root.join("t.idle/0.1.0")).unwrap().display().to_string();
    let ask = start(c, "t.idle:ask", json!({ "folder": folder })).await;
    let mut req = Value::Null;
    for _ in 0..300 {
        let l = c.ok("plugin.installRequests", json!({})).await;
        if let Some(r) = l.as_array().unwrap().first() {
            req = r.clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!req.is_null(), "no install request: {}", c.ok("run.get", json!({ "id": ask })).await);
    still_live_after(&w).await;
    c.ok("plugin.answerInstallRequest", json!({ "id": req["id"], "outcome": "declined" })).await;
    assert_eq!(wait_run(c, &ask).await["status"], "success");
    wait_idle(&w).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn releases_racing_new_calls_lose_nothing() {
    // Review #10: a release every few milliseconds while calls keep coming.
    let w = world_cfg(|r| { pkg(r, "t.idle", "0.1.0", idle_manifest(), IDLE_MAIN); }, |c| c.plugin_idle = Duration::from_millis(5)).await;
    let c = &w.c;
    c.probe("t.idle", "storage.set", json!(["n", 0])).await;
    for i in 0..60u64 {
        let r = c.probe("t.idle", "storage.set", json!(["n", i])).await;
        assert_eq!(r, json!({ "ok": null }), "call {i}");
        tokio::time::sleep(Duration::from_millis(i % 4 * 20)).await;
    }
    let r = run(c, "t.idle:hold", json!({ "ms": 200 })).await;
    assert_eq!(r["status"], "success", "{r}");
    assert_eq!(c.probe("t.idle", "storage.get", json!(["n"])).await, json!({ "ok": 59 }));
    assert!(w.env.kernel.activation_count() > 2, "it was released in between: {}", w.env.kernel.activation_count());
}

/* ================================================================== §5 ctx.host per invocation (D366) */

const CTX_MAIN: &str = r#"
const reason = (r) => r.error ? (r.params.reason || r.error) : "ok";
export default { activate(host) {
  host.commands.handle("probe", probe);
  // Keeps its `ctx.host` where other code can find it, then waits (still running).
  host.actions.handle("keep", async (ctx, input) => {
    globalThis.saved = ctx.host;
    await ctx.host.util.sleep(input.ms);
    // Legit: its own host after an await, and inside an `onOutput` callback.
    const own = await tryIt(() => ctx.host.storage.set("own", input.tag || "a"));
    let cb = "none";
    await ctx.host.process.run({ program: "sh", args: ["-c", "echo x"], onOutput: async () => {
      cb = reason(await tryIt(() => ctx.host.storage.set("cb", 1)));
    } });
    ctx.progress(0.5, input.tag || "a");
    return text({ own: reason(own), cb });
  });
  // Another run that uses the first one's host.
  host.actions.handle("borrow", async (ctx) => {
    const sync = reason(await tryIt(() => globalThis.saved.storage.get("own")));
    await ctx.host.util.sleep(10);
    const later = reason(await tryIt(() => globalThis.saved.network.request({ url: "http://127.0.0.1:9/" })));
    const mine = reason(await tryIt(() => ctx.host.storage.get("own")));
    return text({ sync, later, mine });
  });
  // Leaves work behind that outlives the run.
  host.actions.handle("leave", async (ctx) => {
    (async () => {
      const r = await tryIt(() => ctx.host.util.sleep(300));
      const after = await tryIt(() => ctx.host.storage.get("own"));
      globalThis.late = [reason(r), reason(after)];
    })();
    return text("left");
  });
  host.commands.handle("late", async () => [{ type: "copy", text: JSON.stringify(globalThis.late || null) }]);
  host.commands.handle("useSaved", async (ctx) => {
    const a = reason(await tryIt(() => globalThis.saved.storage.get("own")));
    await ctx.host.util.sleep(5);
    const b = reason(await tryIt(() => globalThis.saved.process.run({ program: "sh", args: ["-c", "echo"] })));
    return [{ type: "copy", text: JSON.stringify([a, b]) }];
  });
  host.pages.handle("p", {
    async render(ctx) {
      const a = reason(await tryIt(() => globalThis.saved.storage.get("own")));
      await ctx.host.util.sleep(5);
      const b = reason(await tryIt(() => globalThis.saved.network.request({ url: "http://127.0.0.1:9/" })));
      const mine = reason(await tryIt(() => ctx.host.storage.get("own")));
      return { view: [{ type: "text", id: "t", text: JSON.stringify([a, b, mine]) }] };
    },
    async onEvent(ctx) {
      const a = reason(await tryIt(() => globalThis.saved.storage.get("own")));
      await ctx.host.util.sleep(5);
      const b = reason(await tryIt(() => globalThis.saved.transfer.download({ url: "http://127.0.0.1:9/", to: "/tmp/x" })));
      return { message: JSON.stringify([a, b]) };
    },
  });
  host.events.on("resource.changed", async (ctx) => {
    if (!globalThis.saved) return;
    const a = reason(await tryIt(() => globalThis.saved.storage.set("fromEvent", 1)));
    await ctx.host.storage.set("eventSaw", a);
  });
} };
"#;

fn ctx_manifest() -> Value {
    json!({
        "requires": { "files": true, "network": { "hosts": ["127.0.0.1:9"] }, "programs": [{ "name": "sh", "source": "system" }] },
        "contributes": {
            "kinds": [{ "id": "k", "label": "K", "icon": "box", "tree": "resources", "page": "p", "newName": "k" }],
            "pages": [{ "id": "p" }],
            "actions": [{ "id": "keep", "label": "K", "output": "text" }, { "id": "borrow", "label": "B", "output": "text" },
                        { "id": "leave", "label": "L", "output": "text" }],
            "commands": [{ "id": "probe", "label": "probe" }, { "id": "late", "label": "late" }, { "id": "useSaved", "label": "u" }],
            "events": ["resource.changed"]
        }
    })
}

async fn copy_cmd(c: &Client, id: &str) -> Value {
    let effects = c.ok("command.execute", json!({ "id": id, "context": {} })).await;
    serde_json::from_str(effects[0]["text"].as_str().unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kept_ctx_host_works_only_for_its_own_invocation() {
    let w = world_cfg(
        |r| {
            pkg(r, "t.ctx", "0.1.0", ctx_manifest(), CTX_MAIN);
        },
        |c| c.action_timeout = Duration::from_secs(20),
    )
    .await;
    let c = &w.c;
    let page = c.ok("page.save", json!({ "target": "new:t.ctx:k", "changes": { "name": "x" } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    let target = format!("resource:{page}");
    // Run A keeps its host and stays running.
    let a = start(c, "t.ctx:keep", json!({ "ms": 3000, "tag": "a" })).await;
    eventually("run A kept its host", async || c.probe("t.ctx", "storage.keys", json!([])).await["ok"].is_array()).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    // From a render, a page event, a command, an event handler: refused, before and after an await.
    let p = c.ok("page.resolve", json!({ "target": target, "context": {} })).await;
    let v: Value = serde_json::from_str(p["view"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(v, json!(["staleContext", "staleContext", "ok"]), "render: {p}");
    let e = c.ok("page.event", json!({ "target": target, "event": "go" })).await;
    let v: Value = serde_json::from_str(e["message"].as_str().unwrap()).unwrap();
    assert_eq!(v, json!(["staleContext", "staleContext"]), "page event");
    assert_eq!(copy_cmd(c, "t.ctx:useSaved").await, json!(["staleContext", "staleContext"]), "command");
    c.ok("page.save", json!({ "target": "new:t.ctx:k", "changes": { "name": "y" } })).await;
    eventually("the event handler ran", async || c.probe("t.ctx", "storage.get", json!(["eventSaw"])).await["ok"].is_string()).await;
    assert_eq!(c.probe("t.ctx", "storage.get", json!(["eventSaw"])).await, json!({ "ok": "staleContext" }));
    assert_eq!(c.probe("t.ctx", "storage.get", json!(["fromEvent"])).await, json!({ "ok": null }), "nothing written");
    // Two runs at once: B cannot use A's host, its own works.
    let b = run(c, "t.ctx:borrow", json!({})).await;
    assert_eq!(out(&b), json!({ "sync": "staleContext", "later": "staleContext", "mine": "ok" }), "{b}");
    // A itself is not affected: its host after awaits and in a callback.
    let ra = wait_run(c, &a).await;
    assert_eq!(out(&ra), json!({ "own": "ok", "cb": "ok" }), "{ra}");
    // After the run ended: refused from anywhere else.
    let p = c.ok("page.resolve", json!({ "target": target, "context": {} })).await;
    let v: Value = serde_json::from_str(p["view"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(v[0], "staleContext", "{p}");
    // And on its own chain after its end: `callEnded` (the code it had before D366).
    let r = run(c, "t.ctx:leave", json!({})).await;
    assert_eq!(out(&r), json!("left"));
    tokio::time::sleep(Duration::from_millis(500)).await;
    let late = copy_cmd(c, "t.ctx:late").await;
    assert_eq!(late, json!(["callEnded", "callEnded"]), "{late}");
}

const SHARE_MAIN: &str = r#"
const reason = (r) => r.error ? (r.params.reason || r.error) : "ok";
export default { activate(host) {
  host.commands.handle("probe", probe);
  // Keeps its host, then settles the promise a page event waits on.
  host.actions.handle("opener", async (ctx) => {
    globalThis.saved = ctx.host;
    await ctx.host.util.sleep(400);
    if (globalThis.release) globalThis.release();
    await ctx.host.util.sleep(400);
    return text("opened");
  });
  // Waits on a promise a page event settles, then uses its own host.
  host.actions.handle("waiter", async (ctx) => {
    await new Promise((r) => { globalThis.wake = r; });
    const own = reason(await tryIt(() => ctx.host.storage.get("x")));
    return text(own);
  });
  host.pages.handle("p", {
    async render() { return { view: [] }; },
    async onEvent(ctx, e) {
      if (e === "wait") {
        await new Promise((r) => { globalThis.release = r; });
        return { message: reason(await tryIt(() => globalThis.saved.storage.get("x"))) };
      }
      if (globalThis.wake) globalThis.wake();
      return { message: "woke" };
    },
  });
} };
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_shared_promise_continues_as_the_invocation_that_settled_it() {
    // D370 (known limit, fixed here so a change is noticed): code after awaiting a promise that
    // another invocation settles runs as that invocation.
    let manifest = json!({ "contributes": {
        "kinds": [{ "id": "k", "label": "K", "icon": "box", "tree": "resources", "page": "p", "newName": "k" }],
        "pages": [{ "id": "p" }],
        "actions": [{ "id": "opener", "label": "O", "output": "text" }, { "id": "waiter", "label": "W", "output": "text" }],
        "commands": [{ "id": "probe", "label": "probe" }]
    } });
    let w = world_cfg(|r| { pkg(r, "t.share", "0.1.0", manifest, SHARE_MAIN); }, |c| c.action_timeout = Duration::from_secs(20)).await;
    let c = &w.c;
    let page = c.ok("page.save", json!({ "target": "new:t.share:k", "changes": { "name": "x" } })).await["page"]["resourceId"]
        .as_str()
        .unwrap()
        .to_string();
    let target = format!("resource:{page}");
    // A page event waiting on a promise the run settles may then use the run's kept host.
    let ev = c.ok("page.event", json!({ "target": target, "event": "wait" }));
    let opener = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        run(c, "t.share:opener", json!({})).await
    };
    let (e, r) = tokio::join!(ev, opener);
    assert_eq!(e["message"], "ok", "{e}");
    assert_eq!(out(&r), json!("opened"));
    // A run waiting on a promise a page event settles: its own host is refused afterwards.
    let id = start(c, "t.share:waiter", json!({})).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let e = c.ok("page.event", json!({ "target": target, "event": "wake" })).await;
    assert_eq!(e["message"], "woke");
    assert_eq!(out(&wait_run(c, &id).await), json!("staleContext"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_runs_at_once_keep_their_own_progress_and_writes() {
    let w = world_cfg(|r| { pkg(r, "t.ctx", "0.1.0", ctx_manifest(), CTX_MAIN); }, |c| c.action_timeout = Duration::from_secs(20)).await;
    let c = &w.c;
    let a = start(c, "t.ctx:keep", json!({ "ms": 600, "tag": "a" })).await;
    let b = start(c, "t.ctx:keep", json!({ "ms": 900, "tag": "b" })).await;
    // Each one's progress goes to its own run (seen while B still runs).
    let ra = wait_run(c, &a).await;
    assert_eq!(out(&ra), json!({ "own": "ok", "cb": "ok" }));
    let rb = wait_run(c, &b).await;
    assert_eq!(out(&rb), json!({ "own": "ok", "cb": "ok" }));
    // The last run.progress of each run carried its own message.
    let conn = db(&w.env);
    for (id, tag) in [(&a, "a"), (&b, "b")] {
        let progress: Option<String> =
            conn.query_row("SELECT progress FROM runs WHERE id = ?1", [id.as_str().unwrap()], |r| r.get(0)).unwrap_or(None);
        // Cleared at the end (round 3); the run's title/summary stay its own.
        assert!(progress.is_none() || progress.unwrap().contains(tag));
    }
}

/* ================================================================== §6 small fixes (D367–D368) */

const FIX_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("go", async (ctx, input) => {
    const r = await tryIt(() => ctx.host.transfer[input.op](input.opts));
    return text(r);
  });
  host.actions.handle("net", async (ctx, input) => { await ctx.host.network.request({ url: input.url }); return text("ran"); });
  host.actions.handle("read", async (ctx, input) => { await ctx.host.files.readText(input.path); return text("ran"); });
  host.actions.handle("unknown", async (ctx) => {
    // Progress is written at most every 100 ms (round 3): spaced out here.
    ctx.progress(null, "counting");
    await ctx.host.util.sleep(800);
    ctx.progress(undefined, "still");
    await ctx.host.util.sleep(800);
    ctx.progress(0.5, "half");
    await ctx.host.util.sleep(400);
    return text("ok");
  });
  host.trees.handle("words", { async children(ctx) {
    return { nodes: [{ key: "k", label: ctx.locale === "zh-CN" ? "词" : "word:" + String(ctx.locale), icon: "box" }] };
  } });
} };
"#;

fn fix_manifest(port: u16) -> Value {
    json!({
        "requires": { "files": true, "network": { "hosts": [format!("127.0.0.1:{port}"), "127.0.0.1:1"] },
                      "programs": [{ "name": "sh", "source": "system" }] },
        "contributes": {
            "trees": [{ "id": "words", "label": "W", "icon": "box", "source": "provided" }],
            "actions": [{ "id": "go", "label": "G", "output": "text" }, { "id": "net", "label": "N", "output": "text" },
                        { "id": "read", "label": "R", "output": "text" }, { "id": "unknown", "label": "U", "output": "text" }],
            "commands": [{ "id": "probe", "label": "probe" }]
        }
    })
}

/// `/slow`: a body that never ends; anything else: `hello`.
async fn server() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { break };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let mut got = Vec::new();
                while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    got.extend_from_slice(&buf[..n]);
                }
                let head = String::from_utf8_lossy(&got).to_string();
                if head.split_whitespace().nth(1) == Some("/slow") {
                    let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000000\r\nConnection: close\r\n\r\n").await;
                    for _ in 0..300 {
                        if s.write_all(&[b'z'; 1024]).await.is_err() {
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    return;
                }
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello").await;
            });
        }
    });
    port
}

struct F {
    w: W,
    port: u16,
    grant: PathBuf,
    outside: PathBuf,
}

async fn fix_world() -> F {
    let port = server().await;
    let w = world_cfg(|r| { pkg(r, "t.fix", "0.1.0", fix_manifest(port), FIX_MAIN); }, |c| c.action_timeout = Duration::from_secs(20)).await;
    let base = w.env.path();
    let grant = base.join("grant");
    let outside = base.join("outside");
    std::fs::create_dir_all(&grant).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    w.c.ok("plugin.grantFolder", json!({ "plugin": "t.fix", "path": grant.display().to_string() })).await;
    F { w, port, grant, outside }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_and_timed_out_transfers_are_audited() {
    let f = fix_world().await;
    let c = &f.w.c;
    let to = f.grant.join("s.bin").display().to_string();
    let url = format!("http://127.0.0.1:{}/slow", f.port);
    // Timeout.
    let r = run(c, "t.fix:go", json!({ "op": "download", "opts": { "url": url, "to": to, "timeoutMs": 500 } })).await;
    assert_eq!(out(&r)["params"]["reason"], "timeout", "{r}");
    let rows = audit(&f.w.env, "transfer.download");
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!((rows[0].1.as_str(), rows[0].3.as_str()), ("127.0.0.1", "timeout"), "{rows:?}");
    let s: Value = serde_json::from_str(&rows[0].2).unwrap();
    assert!(s["ms"].as_u64().unwrap() >= 400, "{s}");
    // Cancelled while it runs (download, capture).
    for (op, opts, object) in [
        ("download", json!({ "url": url, "to": to }), "127.0.0.1"),
        ("capture", json!({ "program": "sh", "args": ["-c", "while true; do echo x; sleep 0.1; done"], "to": f.grant.join("c.txt").display().to_string() }), "sh"),
    ] {
        let id = start(c, "t.fix:go", json!({ "op": op, "opts": opts })).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        c.ok("run.cancel", json!({ "id": id })).await;
        assert_eq!(wait_run(c, &id).await["status"], "cancelled");
        let op_name = format!("transfer.{op}");
        let env = &f.w.env;
        eventually("the cancelled transfer's audit row", async || audit(env, &op_name).iter().any(|r| r.3 == "cancelled")).await;
        let row = audit(env, &op_name).into_iter().find(|r| r.3 == "cancelled").unwrap();
        assert_eq!((row.0.as_str(), row.1.as_str()), ("plugin:t.fix@0.1.0", object), "{row:?}");
    }
    // Review #1 (D369): audit.list shows them as `cancelled` / `timeout` and filters by them.
    let results = |v: Value| -> Vec<String> { v.as_array().unwrap().iter().map(|r| r["result"].as_str().unwrap().to_string()).collect() };
    let all = results(c.ok("audit.list", json!({ "operation": "transfer.download" })).await);
    assert!(all.contains(&"timeout".to_string()) && all.contains(&"cancelled".to_string()), "{all:?}");
    for want in ["cancelled", "timeout"] {
        let got = results(c.ok("audit.list", json!({ "result": want })).await);
        assert!(!got.is_empty() && got.iter().all(|r| r == want), "{want}: {got:?}");
    }
    let errors = results(c.ok("audit.list", json!({ "result": "error" })).await);
    assert!(errors.iter().all(|r| r == "error"), "{errors:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refusals_name_the_path_and_the_layer() {
    let f = fix_world().await;
    let c = &f.w.c;
    // outsideGrant carries the path as given (at most 200 characters), also in RunError.params.
    let p = f.outside.join("x.txt").display().to_string();
    let r = c.probe("t.fix", "files.readText", json!([p])).await;
    assert_eq!(r["params"], json!({ "reason": "outsideGrant", "path": p }), "{r}");
    let mut long = f.outside.clone();
    for i in 0..6 {
        long = long.join(format!("{i}{}", "a".repeat(60)));
    }
    std::fs::create_dir_all(&long).unwrap();
    let r = c.probe("t.fix", "files.readText", json!([long.join("x").display().to_string()])).await;
    assert_eq!(r["params"]["path"].as_str().map(|s| s.chars().count()), Some(200), "{r}");
    let r = run(c, "t.fix:read", json!({ "path": p })).await;
    assert_eq!((r["error"]["reason"].as_str(), r["error"]["params"]["path"].as_str()), (Some("outsideGrant"), Some(p.as_str())), "{r}");
    let r = c.probe("t.fix", "transfer.download", json!([{ "url": "http://127.0.0.1:1/", "to": p }])).await;
    assert_eq!(r["error"], "denied", "transfer is run-only; checked in a run below: {r}");
    let r = run(c, "t.fix:go", json!({ "op": "download", "opts": { "url": format!("http://127.0.0.1:{}/", f.port), "to": p } })).await;
    assert_eq!(out(&r)["params"], json!({ "reason": "outsideGrant", "path": p }), "{r}");
    // blockedByPolicy names the layer (id and name), network and programs.
    let ws_cfg = c.ok("tree.children", json!({ "tree": "config" })).await["nodes"][0].clone();
    let (layer, layer_name) = (ws_cfg["key"].as_str().unwrap().to_string(), ws_cfg["label"].as_str().unwrap().to_string());
    c.ok("params.set", json!({ "node": layer, "name": "network.allow", "value": "api.example.com", "type": "list" })).await;
    let r = run(c, "t.fix:net", json!({ "url": format!("http://127.0.0.1:{}/", f.port) })).await;
    assert_eq!(r["error"]["reason"], "blockedByPolicy", "{r}");
    assert_eq!(
        (r["error"]["params"]["layer"].as_str(), r["error"]["params"]["layerName"].as_str()),
        (Some(layer.as_str()), Some(layer_name.as_str())),
        "{r}"
    );
    c.ok("params.set", json!({ "node": layer, "name": "process.allow", "value": "cat", "type": "list" })).await;
    let r = c.probe("t.fix", "process.ready", json!(["sh"])).await;
    assert_eq!(r["ok"]["reason"], "blockedByPolicy");
    let r = run(c, "t.fix:go", json!({ "op": "capture", "opts": { "program": "sh", "to": f.grant.join("c").display().to_string() } })).await;
    assert_eq!((out(&r)["params"]["layer"].as_str(), out(&r)["params"]["layerName"].as_str()), (Some(layer.as_str()), Some(layer_name.as_str())), "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_request_names_the_host_not_the_address() {
    let f = fix_world().await;
    // Port 1 on loopback: nothing listens; the request fails to connect.
    let r = run(&f.w.c, "t.fix:net", json!({ "url": "http://127.0.0.1:1/secret/path?token=abc" })).await;
    assert_eq!(r["status"], "error", "{r}");
    let d = r["error"]["detail"].as_str().unwrap_or_default();
    assert!(d.contains("127.0.0.1"), "the host is named: {r}");
    assert!(!d.contains("/secret") && !d.contains("token") && !d.contains("http://"), "no address: {d}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn provided_trees_get_the_locale_and_progress_may_have_no_fraction() {
    let f = fix_world().await;
    let c = &f.w.c;
    let zh = c.ok("tree.children", json!({ "tree": "t.fix:words", "locale": "zh-CN" })).await;
    assert_eq!(zh["nodes"][0]["label"], "词");
    let none = c.ok("tree.children", json!({ "tree": "t.fix:words" })).await;
    assert_eq!(none["nodes"][0]["label"], "word:null");
    // Review #7: a locale that is not letters, digits and `-` (≤ 35) is as if not given.
    for bad in ["../x", "zh_CN", "a b"] {
        let t = c.ok("tree.children", json!({ "tree": "t.fix:words", "locale": bad })).await;
        assert_eq!(t["nodes"][0]["label"], "word:null", "{bad}");
    }
    // ctx.progress(null | undefined, …): no fraction, the message kept.
    let id = start(c, "t.fix:unknown", json!({})).await;
    for (message, want) in [
        ("counting", json!({ "message": "counting" })),
        ("still", json!({ "message": "still" })),
        ("half", json!({ "fraction": 0.5, "message": "half" })),
    ] {
        let mut seen = Value::Null;
        for _ in 0..200 {
            let r = c.ok("run.get", json!({ "id": id })).await;
            if r["progress"]["message"] == message {
                seen = r["progress"].clone();
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(seen, want, "{message}");
    }
    assert_eq!(wait_run(c, &id).await["status"], "success");
}
