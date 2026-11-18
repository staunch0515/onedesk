//! Round 13 (docs/handoff/round13-plan.md §2, §3, §5): the first-version database (detection,
//! conversion in one transaction, `legacyKinds` claims with `upgrade`, unclaimed kinds) and
//! `workspace.settingsSnapshot` / `init-settings.json`. The first-version database is built here
//! from the first version's schema (git `bf8f6b0^:src-tauri/migrations/0001_init.sql`); nothing
//! outside temporary folders is read.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::*;
use rusqlite::Connection;
use serde_json::{json, Value};

/// The first version's schema, as published (plus `schema_version`, which its runner made).
const V1_SCHEMA: &str = r#"
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version (version) VALUES (1);
CREATE TABLE resources (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  group_name  TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '{}',
  visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  ai_visible  INTEGER NOT NULL DEFAULT 0 CHECK (ai_visible IN (0, 1)),
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'original' CHECK (origin IN ('original', 'subscribed', 'copied')),
  search_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_resources_kind ON resources (kind);
CREATE INDEX idx_resources_group ON resources (group_name);
CREATE TABLE collections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  rule_type  TEXT NOT NULL CHECK (rule_type IN ('tag', 'kind')),
  rule_value TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE plugins (
  id           TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  uninstalled  INTEGER NOT NULL DEFAULT 0 CHECK (uninstalled IN (0, 1)),
  settings     TEXT NOT NULL DEFAULT '{}',
  installed_at TEXT NOT NULL
);
CREATE TABLE plugin_storage (
  plugin_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE secret_names (
  name       TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
"#;

const T1: &str = "2025-11-15T09:46:40.000Z";
const T1_MS: i64 = 1_763_200_000_000;
const T2: &str = "2025-11-16T09:46:40.000Z";
const T2_MS: i64 = 1_763_286_400_000;

/// A first-version database with every kind of data.
fn v1_db(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let c = Connection::open(path).unwrap();
    c.execute_batch(V1_SCHEMA).unwrap();
    let res = |id: &str, kind: &str, name: &str, group: &str, tags: &str, desc: &str, body: &str| {
        c.execute(
            "INSERT INTO resources (id, kind, name, group_name, tags, description, body, visibility, ai_visible, version, created_at, updated_at, origin, search_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'public', 1, 7, ?8, ?9, 'copied', 'x')",
            rusqlite::params![id, kind, name, group, tags, desc, body, T1, T2],
        )
        .unwrap();
    };
    res("r-link", "link", "Docs", "Work/Web", r#"["a","b"]"#, "the docs", r#"{"url":"https://example.test/docs"}"#);
    res("r-note", "note", "Diary", "Work", "[]", "", r#"{"text":"hello"}"#);
    res("r-note2", "note", "Ideas", " Work / Web ", r#"["idea"]"#, "", r#"{"text":"more"}"#);
    res("r-top", "prompt", "Top", "", "[]", "", r#"{"template":"hi {{x}}"}"#);
    res("r-odd", "mystery", "Odd one", "Other", "[]", "", "{}");
    c.execute("INSERT INTO collections VALUES ('c-1', 'Tagged a', 'tag', 'a', ?1)", [T1]).unwrap();
    c.execute("INSERT INTO collections VALUES ('c-2', 'All links', 'kind', 'link', ?1)", [T2]).unwrap();
    c.execute("INSERT INTO plugins VALUES ('t.notes', 0, 0, '{}', ?1), ('t.web', 1, 0, '{}', ?1), ('ext.gone', 0, 1, '{}', ?1)", [T1]).unwrap();
    c.execute("INSERT INTO plugin_storage VALUES ('t.web', 'recent', '[1,2]'), ('t.web', 'opt', '\"x\"'), ('other', 'k', '1')", []).unwrap();
    c.execute("INSERT INTO app_settings VALUES ('language', 'zh-CN'), ('theme', '\"dark\"'), ('windowSize', '{}')", []).unwrap();
    c.execute("INSERT INTO secret_names VALUES ('API_TOKEN', ?1)", [T1]).unwrap();
}

/// Generated plugins of these tests.
fn pkg(root: &Path, id: &str, version: &str, contributes: Value, extra: Value, main: &str) -> PathBuf {
    let dir = root.join(id).join(version);
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({ "id": id, "version": version, "apiVersion": "2", "name": id, "icon": "box", "main": "main.js", "contributes": contributes });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(dir.join("main.js"), main).unwrap();
    dir
}

fn kind(id: &str) -> Value {
    json!({ "id": id, "label": id, "icon": "box", "tree": "resources" })
}

/// `t.web` takes `link` and changes `url` → `address`; `t.notes` takes `note` with no `upgrade`.
fn claimers(root: &Path) {
    pkg(
        root,
        "t.web",
        "1.0.0",
        json!({ "kinds": [kind("link")] }),
        json!({ "legacyKinds": ["link"] }),
        r#"export default { activate(host) {
            host.kinds.handle("link", { upgrade(ctx, input) {
              if (input.legacyKind !== "link" || ctx.resource.id === undefined) throw new Error("bad input");
              const b = Object.assign({}, input.body); b.address = b.url; delete b.url; b.locale = ctx.locale;
              return { body: b };
            } });
        } };"#,
    );
    pkg(root, "t.notes", "1.0.0", json!({ "kinds": [kind("note")] }), json!({ "legacyKinds": ["note"] }), "export default { activate() {} };");
}

struct W {
    env: Env,
    c: Client,
    root: PathBuf,
}

/// A workspace folder holding the first-version database, opened with `plugins` as built-in.
async fn legacy_world(build: impl FnOnce(&Path)) -> W {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    build(&root);
    v1_db(&tmp.path().join("ws").join("workspace.db"));
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    W { env, c, root }
}

fn db(env: &Env) -> Connection {
    Connection::open(env.kernel.db_path()).unwrap()
}

fn audit(env: &Env, op: &str) -> Vec<(String, String, Value, String)> {
    let conn = db(env);
    let mut st = conn.prepare("SELECT actor, object, summary, result FROM audit WHERE op = ?1 ORDER BY seq").unwrap();
    st.query_map([op], |r| Ok((r.get(0)?, r.get(1)?, serde_json::from_str(&r.get::<_, String>(2)?).unwrap(), r.get(3)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

/// (kind, parent name, tree, pluginVersion) of a resource.
fn place(env: &Env, id: &str) -> (String, Option<String>, String, Option<String>) {
    db(env)
        .query_row(
            "SELECT r.kind, p.name, r.tree, r.plugin_version FROM resources r LEFT JOIN resources p ON p.id = r.parent_id WHERE r.id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
}

async fn wait_kind(env: &Env, id: &str, want: &str) {
    for _ in 0..300 {
        if place(env, id).0 == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{id} never became {want}: {:?}", place(env, id));
}

async fn wait_audit(env: &Env, op: &str, n: usize) -> Vec<(String, String, Value, String)> {
    for _ in 0..300 {
        let a = audit(env, op);
        if a.len() >= n {
            return a;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("no {op} audit");
}

async fn set_enabled(c: &Client, id: &str, on: bool) {
    let cmd = if on { "plugin.enable" } else { "plugin.disable" };
    c.ok("command.execute", json!({ "id": cmd, "context": { "args": { "plugin": id } } })).await;
}

/* ------------------------------------------------------------------ detection */

#[test]
fn only_the_first_version_structure_is_recognised() {
    let tmp = tempfile::tempdir().unwrap();
    let v1 = tmp.path().join("v1.db");
    v1_db(&v1);
    assert!(onedesk_kernel::legacy::is_v1(&Connection::open(&v1).unwrap()).unwrap());
    // A current database is not.
    let mut cur = Connection::open_in_memory().unwrap();
    onedesk_kernel::workspace::migrate(&mut cur).unwrap();
    assert!(!onedesk_kernel::legacy::is_v1(&cur).unwrap());
    // Nor an empty one, nor one missing `group_name`.
    assert!(!onedesk_kernel::legacy::is_v1(&Connection::open_in_memory().unwrap()).unwrap());
    let odd = Connection::open_in_memory().unwrap();
    odd.execute_batch("CREATE TABLE schema_version (version INTEGER); CREATE TABLE collections (id TEXT); CREATE TABLE resources (id TEXT);").unwrap();
    assert!(!onedesk_kernel::legacy::is_v1(&odd).unwrap());
}

/* ------------------------------------------------------------------ conversion */

#[tokio::test(flavor = "multi_thread")]
async fn every_table_is_converted_with_counts_and_content() {
    // No plugin claims anything here: the converted rows are seen as they are.
    let w = legacy_world(|r| {
        pkg(r, "t.notes", "1.0.0", json!({}), json!({}), "export default { activate() {} };");
    })
    .await;
    let conn = db(&w.env);
    // Resources: content and times kept; kind keeps its short name; groups made.
    let row: (String, String, String, String, String, i64, i64, String, i64) = conn
        .query_row(
            "SELECT kind, name, tags, description, body, created_at, updated_at, created_by, rev FROM resources WHERE id = 'r-link'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "link".into(),
            "Docs".into(),
            r#"["a","b"]"#.into(),
            "the docs".into(),
            r#"{"url":"https://example.test/docs"}"#.into(),
            T1_MS,
            T2_MS,
            "user".into(),
            1
        )
    );
    // `group_name` → nested groups, one per path (`Work/Web` and ` Work / Web ` share one).
    assert_eq!(place(&w.env, "r-link").1.as_deref(), Some("Web"));
    let web_of = |id: &str| conn.query_row("SELECT parent_id FROM resources WHERE id = ?1", [id], |r| r.get::<_, String>(0)).unwrap();
    assert_eq!(web_of("r-link"), web_of("r-note2"), "same path, same group");
    assert_eq!(place(&w.env, "r-note").1.as_deref(), Some("Work"));
    let groups: Vec<(String, Option<String>)> = {
        let mut st = conn
            .prepare("SELECT g.name, p.name FROM resources g LEFT JOIN resources p ON p.id = g.parent_id WHERE g.kind = 'core:group' ORDER BY g.name")
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(groups, vec![("Other".into(), None), ("Web".into(), Some("Work".into())), ("Work".into(), None)]);
    assert_eq!(place(&w.env, "r-top"), ("prompt".into(), None, "resources".into(), None));
    // Collections → `collection` resources at the top level.
    let (k, body, created): (String, String, i64) =
        conn.query_row("SELECT kind, body, created_at FROM resources WHERE id = 'c-2'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!((k.as_str(), serde_json::from_str::<Value>(&body).unwrap(), created), ("collection", json!({ "ruleType": "kind", "ruleValue": "link" }), T2_MS));
    assert_eq!(place(&w.env, "c-1").1, None);
    // Every resource has its first revision.
    let revs: i64 = conn.query_row("SELECT count(*) FROM revisions WHERE rev = 1 AND op = 'create' AND resource_id IN ('r-link','r-note','r-note2','r-top','r-odd','c-1','c-2')", [], |r| r.get(0)).unwrap();
    assert_eq!(revs, 7);
    // Plugin storage waits under the first-version marker (nobody claimed it); secret names.
    let storage: i64 = conn.query_row("SELECT count(*) FROM plugin_storage WHERE version = 'legacy'", [], |r| r.get(0)).unwrap();
    assert_eq!(storage, 3);
    let secret: i64 = conn.query_row("SELECT updated_at FROM secret_names WHERE name = 'API_TOKEN'", [], |r| r.get(0)).unwrap();
    assert_eq!(secret, T1_MS);
    let names = w.c.ok("secrets.list", json!({})).await;
    assert!(names.to_string().contains("API_TOKEN"), "{names}");
    // Settings: language and theme; the rest is dropped and named in the audit summary.
    assert_eq!(w.c.ok("workspace.getConfig", json!({ "name": "ui.language" })).await, json!("zh-CN"));
    assert_eq!(w.c.ok("workspace.getConfig", json!({ "name": "ui.theme" })).await, json!("dark"));
    let roots: i64 = conn.query_row("SELECT count(*) FROM resources WHERE kind = 'core:config' AND parent_id IS NULL AND deleted_at IS NULL", [], |r| r.get(0)).unwrap();
    assert_eq!(roots, 1, "the converted node is the workspace configuration; startup adds no second root");
    // Only built-in plugins keep their "off" switch (`ext.gone` is not built-in).
    let plugin = w.c.ok("plugin.get", json!({ "plugin": "t.notes" })).await;
    assert_eq!(plugin["enabled"], json!(false), "{plugin}");
    let states: i64 = conn.query_row("SELECT count(*) FROM resources WHERE kind = 'core:plugin-state' AND name = 'ext.gone'", [], |r| r.get(0)).unwrap();
    assert_eq!(states, 0);
    // No first-version table is left.
    for t in ["schema_version", "collections", "plugins", "app_settings", "v1_resources", "v1_plugin_storage", "v1_secret_names"] {
        let n: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE name = ?1", [t], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "{t}");
    }
    // Audit: one row by the kernel with the counts.
    let a = audit(&w.env, "workspace.legacyUpgrade");
    assert_eq!(a.len(), 1);
    assert_eq!((a[0].0.as_str(), a[0].3.as_str()), ("core", "ok"));
    assert_eq!(a[0].2["resources"], 5);
    assert_eq!(a[0].2["groups"], 3);
    assert_eq!(a[0].2["collections"], 2);
    assert_eq!(a[0].2["pluginStorage"], 3);
    assert_eq!(a[0].2["secretNames"], 1);
    assert_eq!(a[0].2["settings"], 2);
    assert_eq!(a[0].2["disabledPlugins"], 1);
    assert_eq!(a[0].2["droppedSettings"], json!(["windowSize"]));
    // Search finds converted content (the index was rebuilt).
    let found = w.c.ok("search.query", json!({ "text": "docs" })).await;
    assert!(found.to_string().contains("r-link"), "{found}");
}

#[test]
fn a_failed_conversion_leaves_the_file_byte_for_byte_and_names_the_table() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    let file = ws.join("workspace.db");
    v1_db(&file);
    {
        let c = Connection::open(&file).unwrap();
        c.execute("INSERT INTO resources (id, kind, name, body, created_at, updated_at) VALUES ('bad', 'note', 'Bad', 'not json', ?1, ?1)", [T1]).unwrap();
    }
    let before = std::fs::read(&file).unwrap();
    let e = onedesk_kernel::legacy::upgrade_folder(&ws, &[]).unwrap_err();
    assert_eq!(e.table, "resources");
    assert_eq!(e.line(), r#"legacyUpgradeFailed {"table":"resources"}"#);
    assert_eq!(e.to_protocol().params.get("table").map(String::as_str), Some("resources"));
    assert_eq!(std::fs::read(&file).unwrap(), before, "the database is unchanged");
    // The kernel does not open it either, and still does not change it.
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    let err = onedesk_kernel::Kernel::open(&ws, &root, test_config()).err().expect("refused");
    assert!(err.starts_with("legacyUpgradeFailed"), "{err}");
    assert_eq!(std::fs::read(&file).unwrap(), before);
    // A bad time in another table names that table.
    let ws2 = tmp.path().join("ws2");
    v1_db(&ws2.join("workspace.db"));
    Connection::open(ws2.join("workspace.db")).unwrap().execute("UPDATE collections SET created_at = 'soon'", []).unwrap();
    assert_eq!(onedesk_kernel::legacy::upgrade_folder(&ws2, &[]).unwrap_err().table, "collections");
}

#[test]
fn an_empty_first_version_database_converts() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    Connection::open(ws.join("workspace.db")).unwrap().execute_batch(V1_SCHEMA).unwrap();
    let s = onedesk_kernel::legacy::upgrade_folder(&ws, &[]).unwrap().expect("converted");
    assert_eq!(s["droppedSettings"], json!([]));
    // A second open finds the current structure: nothing more to do.
    assert!(onedesk_kernel::legacy::upgrade_folder(&ws, &[]).unwrap().is_none());
    let (_w, conn) = onedesk_kernel::workspace::Workspace::open(&ws).unwrap();
    let v: String = conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap();
    assert_eq!(v, onedesk_kernel::workspace::MIGRATIONS.len().to_string());
}

/* ------------------------------------------------------------------ claims */

#[tokio::test(flavor = "multi_thread")]
async fn enabled_plugins_claim_their_kinds_and_upgrade_rewrites_the_body() {
    let w = legacy_world(claimers).await;
    // `t.notes` was off in the first version: only `t.web` claims at start.
    wait_kind(&w.env, "r-link", "t.web:link").await;
    let conn = db(&w.env);
    let (body, rev, pv): (String, i64, Option<String>) =
        conn.query_row("SELECT body, rev, plugin_version FROM resources WHERE id = 'r-link'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({ "address": "https://example.test/docs", "locale": "zh-CN" }));
    assert_eq!((rev, pv.as_deref()), (2, Some("1.0.0")));
    let op: String = conn.query_row("SELECT op FROM revisions WHERE resource_id = 'r-link' AND rev = 2", [], |r| r.get(0)).unwrap();
    assert_eq!(op, "legacyClaim");
    // Its first-version storage moved into its version; other plugins' storage waits.
    let st: Vec<(String, String)> = {
        let mut s = conn.prepare("SELECT plugin, version FROM plugin_storage ORDER BY plugin, key").unwrap();
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(st, vec![("other".into(), "legacy".into()), ("t.web".into(), "1.0.0".into()), ("t.web".into(), "1.0.0".into())]);
    let a = wait_audit(&w.env, "plugin.legacyClaim", 1).await;
    assert_eq!((a[0].1.as_str(), a[0].2["count"].clone(), a[0].2["storageKeys"].clone()), ("t.web", json!(1), json!(2)));
    assert_eq!(place(&w.env, "r-note").0, "note", "a disabled plugin claims nothing");
    // Enabling it claims; without `upgrade` the body stays.
    set_enabled(&w.c, "t.notes", true).await;
    wait_kind(&w.env, "r-note", "t.notes:note").await;
    wait_kind(&w.env, "r-note2", "t.notes:note").await;
    let body: String = conn.query_row("SELECT body FROM resources WHERE id = 'r-note'", [], |r| r.get(0)).unwrap();
    assert_eq!(body, r#"{"text":"hello"}"#);
    assert_eq!(place(&w.env, "r-note").1.as_deref(), Some("Work"), "the place in the tree stays");
    let a = wait_audit(&w.env, "plugin.legacyClaim", 2).await;
    assert_eq!(a[1].2["count"], 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_upgrade_leaves_the_whole_batch_unclaimed_and_is_audited() {
    let w = legacy_world(|r| {
        pkg(
            r,
            "t.notes",
            "1.0.0",
            json!({ "kinds": [kind("note")] }),
            json!({ "legacyKinds": ["note"] }),
            r#"export default { activate(host) {
                host.kinds.handle("note", { upgrade(ctx, input) {
                  if (input.body.text === "more") throw new Error("cannot");
                  return { body: { text: input.body.text + "!" } };
                } });
            } };"#,
        );
        pkg(
            r,
            "t.bad",
            "1.0.0",
            json!({ "kinds": [kind("prompt")] }),
            json!({ "legacyKinds": ["prompt"] }),
            r#"export default { activate(host) { host.kinds.handle("prompt", { upgrade() { return "nope"; } }); } };"#,
        );
    })
    .await;
    // `t.notes` was off in the first version.
    set_enabled(&w.c, "t.notes", true).await;
    let failed = wait_audit(&w.env, "plugin.legacyClaimFailed", 2).await;
    let objects: Vec<&str> = failed.iter().map(|a| a.1.as_str()).collect();
    assert!(objects.contains(&"t.notes") && objects.contains(&"t.bad"), "{failed:?}");
    assert!(failed.iter().all(|a| a.3.starts_with("failed:")));
    // Nothing of either batch changed (r-note would have succeeded on its own).
    let conn = db(&w.env);
    for (id, body) in [("r-note", r#"{"text":"hello"}"#), ("r-note2", r#"{"text":"more"}"#)] {
        let (k, b, rev): (String, String, i64) = conn.query_row("SELECT kind, body, rev FROM resources WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((k.as_str(), b.as_str(), rev), ("note", body, 1));
    }
    assert_eq!(place(&w.env, "r-top").0, "prompt");
    assert!(audit(&w.env, "plugin.legacyClaim").is_empty());
    // The plugin page shows why; the plugin itself stays enabled.
    let d = w.c.ok("plugin.get", json!({ "plugin": "t.notes" })).await;
    assert_eq!(d["enabled"], json!(true));
    assert_eq!(d["legacyClaimFailure"]["reason"], "upgradeFailed", "{d}");
    assert_eq!(d["legacyClaimFailure"]["resource"], "r-note2");
    assert_eq!(d["legacyClaimFailure"]["legacyKind"], "note");
    let b = w.c.ok("plugin.get", json!({ "plugin": "t.bad" })).await;
    assert_eq!(b["legacyClaimFailure"]["reason"], "badUpgrade", "{b}");
}

#[tokio::test(flavor = "multi_thread")]
async fn of_two_plugins_with_one_short_kind_the_first_enabled_claims() {
    let w = legacy_world(|r| {
        pkg(r, "t.a", "1.0.0", json!({ "kinds": [kind("mystery")] }), json!({ "legacyKinds": ["mystery"] }), "export default { activate() {} };");
        pkg(r, "t.b", "1.0.0", json!({ "kinds": [kind("mystery")] }), json!({ "legacyKinds": ["mystery"] }), "export default { activate() {} };");
    })
    .await;
    // At start both are enabled: plugin id order decides.
    wait_kind(&w.env, "r-odd", "t.a:mystery").await;
    wait_audit(&w.env, "plugin.legacyClaim", 1).await;
    set_enabled(&w.c, "t.b", false).await;
    set_enabled(&w.c, "t.b", true).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(place(&w.env, "r-odd").0, "t.a:mystery");
    assert_eq!(audit(&w.env, "plugin.legacyClaim").len(), 1, "nothing left for the second: {:?}", audit(&w.env, "plugin.legacyClaim"));
    assert!(audit(&w.env, "plugin.legacyClaimFailed").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn of_two_plugins_the_one_enabled_first_by_the_user_claims() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    // `t.z` sorts last but is the only one enabled when the workspace opens.
    pkg(&root, "t.a", "1.0.0", json!({ "kinds": [kind("mystery")] }), json!({ "legacyKinds": ["mystery"] }), "export default { activate() {} };");
    pkg(&root, "t.z", "1.0.0", json!({ "kinds": [kind("mystery")] }), json!({ "legacyKinds": ["mystery"] }), "export default { activate() {} };");
    let file = tmp.path().join("ws").join("workspace.db");
    v1_db(&file);
    Connection::open(&file).unwrap().execute("UPDATE plugins SET id = 't.a' WHERE id = 't.notes'", []).unwrap();
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    wait_kind(&env, "r-odd", "t.z:mystery").await;
    set_enabled(&c, "t.a", true).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(place(&env, "r-odd").0, "t.z:mystery");
}

#[tokio::test(flavor = "multi_thread")]
async fn unclaimed_kinds_show_as_unknown_and_can_be_moved_and_deleted_not_opened() {
    let w = legacy_world(|_| {}).await;
    let top = w.c.ok("tree.children", json!({ "tree": "resources" })).await;
    let items = top["nodes"].as_array().unwrap();
    let node = items.iter().find(|n| n["key"] == "r-top").expect("top-level resource");
    assert_eq!(node["state"], "unknownKind", "{node}");
    let col = items.iter().find(|n| n["key"] == "c-1").expect("collection");
    assert_eq!(col["state"], "unknownKind");
    // Not opened: no editor page.
    let opened = w.c.call("command.execute", json!({ "id": "node.open", "context": { "tree": "resources", "nodeKey": "r-top" } })).await;
    let page = w.c.call("page.resolve", json!({ "target": "resource:r-top" })).await;
    assert!(opened.is_ok());
    let page = page.unwrap();
    assert_eq!((page["state"].clone(), page["readOnly"].clone()), (json!("unknownKind"), json!(true)), "{page}");
    assert!(page["view"].as_array().is_none_or(|v| v.is_empty()), "no editor: {page}");
    // Moved into a group, then deleted.
    let work: String = db(&w.env).query_row("SELECT id FROM resources WHERE kind = 'core:group' AND name = 'Work'", [], |r| r.get(0)).unwrap();
    w.c.ok("tree.move", json!({ "tree": "resources", "key": "r-top", "target": work, "position": "inside" })).await;
    assert_eq!(place(&w.env, "r-top").1.as_deref(), Some("Work"));
    w.c.ok("resource.delete", json!({ "id": "r-top" })).await;
    let deleted: Option<i64> = db(&w.env).query_row("SELECT deleted_at FROM resources WHERE id = 'r-top'", [], |r| r.get(0)).unwrap();
    assert!(deleted.is_some());
    // Nothing claimed, no plugin present: no claim audits.
    assert!(audit(&w.env, "plugin.legacyClaim").is_empty() && audit(&w.env, "plugin.legacyClaimFailed").is_empty());
    let _ = &w.root;
}

/* ------------------------------------------------------------------ settings snapshot (D400) */

#[tokio::test(flavor = "multi_thread")]
async fn the_settings_snapshot_answers_only_the_main_process() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    pkg(&root, "t.one", "1.0.0", json!({}), json!({}), "export default { activate() {} };");
    pkg(&root, "t.two", "1.0.0", json!({}), json!({}), "export default { activate() {} };");
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    c.ok("workspace.setConfig", json!({ "name": "ui.theme", "value": "dark" })).await;
    set_enabled(&c, "t.two", false).await;
    let refused = c.call_as(Some("window-1"), "workspace.settingsSnapshot", json!({})).await.unwrap_err();
    assert_eq!(serde_json::to_value(refused.code).unwrap(), "denied");
    assert_eq!(refused.params.get("reason").map(String::as_str), Some("mainProcessOnly"));
    let s = c.call_as(None, "workspace.settingsSnapshot", json!({})).await.unwrap();
    assert_eq!(s["config"][0]["name"], "Workspace");
    assert_eq!(s["config"][0]["params"], json!([{ "name": "ui.theme", "type": "text", "value": "dark" }]));
    assert!(s["plugins"].as_array().unwrap().contains(&json!({ "plugin": "t.two", "enabled": false })), "{s}");
    assert!(s["plugins"].as_array().unwrap().contains(&json!({ "plugin": "t.one", "enabled": true })), "{s}");
}

#[tokio::test(flavor = "multi_thread")]
async fn init_settings_are_applied_once_to_a_new_workspace_and_the_file_is_deleted() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    pkg(&root, "t.one", "1.0.0", json!({}), json!({}), "export default { activate() {} };");
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let snap = json!({
        "config": [{ "name": "Team", "description": "copied", "params": [
            { "name": "ui.theme", "type": "text", "value": "light" },
            { "name": "x.ref", "type": "ref", "value": "someone-elses-id" }
        ], "children": [{ "name": "Child", "params": [{ "name": "ui.language", "type": "text", "value": "ja-JP" }] }] }],
        "plugins": [{ "plugin": "t.one", "enabled": false }]
    });
    std::fs::write(ws.join("init-settings.json"), snap.to_string()).unwrap();
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    assert!(!ws.join("init-settings.json").exists(), "deleted after use");
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "ui.theme" })).await, json!("light"));
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "ui.language" })).await, json!("ja-JP"));
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "x.ref" })).await, Value::Null, "references are not copied");
    assert_eq!(c.ok("plugin.get", json!({ "plugin": "t.one" })).await["enabled"], json!(false));
    let conn = db(&env);
    let roots: Vec<String> = {
        let mut st = conn.prepare("SELECT name FROM resources WHERE kind = 'core:config' AND parent_id IS NULL").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(roots, vec!["Team".to_string()], "the default root took the snapshot's place");
    assert_eq!(audit(&env, "workspace.initSettings").len(), 1);
    // Once the user made something, a file put back is not applied (and is still removed).
    c.ok("tree.createGroup", json!({ "tree": "resources", "name": "Mine" })).await;
    drop(c);
    let path = env.path();
    let Env { tmp, kernel } = env;
    kernel.shutdown();
    drop(kernel);
    std::fs::write(path.join("ws").join("init-settings.json"), json!({ "config": [{ "name": "Again", "params": [] }] }).to_string()).unwrap();
    let k = onedesk_kernel::Kernel::open(&path.join("ws"), &path.join("plugins"), test_config()).unwrap();
    assert!(!path.join("ws").join("init-settings.json").exists());
    let n: i64 = Connection::open(k.db_path()).unwrap().query_row("SELECT count(*) FROM resources WHERE name = 'Again'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    k.shutdown();
    drop(tmp);
}
