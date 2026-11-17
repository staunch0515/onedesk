//! Round 10: field merge of a stale `page.save` (D374), type-supplied children (D375), start-up
//! with very many packages (§7). Temporary folders only.

mod common;

use common::*;
use onedesk_protocol::{ErrorCode, ProtocolError};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

fn db(env: &Env) -> Connection {
    Connection::open_with_flags(env.kernel.db_path(), OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap()
}

async fn setup() -> (Env, Client) {
    let env = open(&fixtures());
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

async fn new_item(c: &Client) -> String {
    let r = c.ok("page.save", json!({ "target": "new:test.alpha:item", "changes": { "body.text": "a", "body.extra": 1, "tags": ["x"] } })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn save(c: &Client, id: &str, changes: Value, basis: &str) -> Result<Value, ProtocolError> {
    c.call("page.save", json!({ "target": format!("resource:{id}"), "changes": changes, "basis": basis })).await
}

async fn get(c: &Client, id: &str) -> Value {
    c.ok("resource.get", json!({ "id": id })).await
}

fn stale(e: &ProtocolError) -> (ErrorCode, &str, &str, &str) {
    (e.code, e.params["reason"].as_str(), e.params["fields"].as_str(), e.params["rev"].as_str())
}

/* ------------------------------------------------------------------ §4 merge */

#[tokio::test(flavor = "multi_thread")]
async fn stale_basis_without_overlap_saves_and_keeps_the_other_change() {
    let (_env, c) = setup().await;
    let id = new_item(&c).await;
    // Elsewhere: the name (rev 2) and a body field (rev 3).
    save(&c, &id, json!({ "name": "elsewhere" }), "1").await.unwrap();
    save(&c, &id, json!({ "body.extra": 2 }), "2").await.unwrap();
    // This editor is still on rev 1 and changed only the text.
    let r = save(&c, &id, json!({ "body.text": "mine" }), "1").await.unwrap();
    assert_eq!(r["page"]["basis"], "4");
    let res = get(&c, &id).await;
    assert_eq!((res["name"].as_str(), res["body"]["text"].as_str(), res["body"]["extra"].as_i64()), (Some("elsewhere"), Some("mine"), Some(2)));
}

#[tokio::test(flavor = "multi_thread")]
async fn stale_basis_with_overlap_is_refused_listing_the_fields_and_the_rev() {
    let (env, c) = setup().await;
    let id = new_item(&c).await;
    save(&c, &id, json!({ "name": "elsewhere", "tags": ["y"], "body.text": "theirs" }), "1").await.unwrap();
    let e = save(&c, &id, json!({ "name": "mine", "tags": ["z"], "body.text": "mine", "description": "d" }), "1").await.unwrap_err();
    let (code, reason, fields, rev) = stale(&e);
    assert_eq!((code, reason, rev), (ErrorCode::Conflict, "stale", "2"));
    let mut f: Vec<&str> = fields.split(',').collect();
    f.sort();
    assert_eq!(f, vec!["body.text", "name", "tags"]);
    // Nothing written, not even the free `description`.
    let res = get(&c, &id).await;
    assert_eq!((res["name"].as_str(), res["description"].as_str(), res["body"]["text"].as_str()), (Some("elsewhere"), Some(""), Some("theirs")));
    let n: i64 = db(&env).query_row("SELECT count(*) FROM revisions WHERE resource_id = ?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn each_kind_of_field_conflicts_on_its_own() {
    let (_env, c) = setup().await;
    for (theirs, mine, field) in [
        (json!({ "name": "t" }), json!({ "name": "m" }), "name"),
        (json!({ "tags": ["t"] }), json!({ "tags": ["m"] }), "tags"),
        (json!({ "body.text": "t" }), json!({ "body.text": "m" }), "body.text"),
        (json!({ "body.new": "t" }), json!({ "body.new": "m" }), "body.new"),
        (json!({ "body.extra": null }), json!({ "body.extra": 5 }), "body.extra"),
    ] {
        let id = new_item(&c).await;
        save(&c, &id, theirs, "1").await.unwrap();
        let e = save(&c, &id, mine.clone(), "1").await.unwrap_err();
        assert_eq!(stale(&e), (ErrorCode::Conflict, "stale", field, "2"), "{field}");
        // A different body field next to it is not a conflict.
        save(&c, &id, json!({ "body.other": 1 }), "1").await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn overwrite_keeps_mine_for_the_named_fields_only() {
    let (_env, c) = setup().await;
    let id = new_item(&c).await;
    save(&c, &id, json!({ "name": "theirs", "body.text": "theirs" }), "1").await.unwrap();
    let t = format!("resource:{id}");
    // Only one of the two clashing fields named: still refused, for the other one.
    let e = c
        .call("page.save", json!({ "target": t, "changes": { "name": "mine", "body.text": "mine" }, "basis": "1", "overwrite": ["name"] }))
        .await
        .unwrap_err();
    assert_eq!(stale(&e), (ErrorCode::Conflict, "stale", "body.text", "2"));
    // Both named: written.
    c.ok("page.save", json!({ "target": t, "changes": { "name": "mine", "body.text": "mine" }, "basis": "1", "overwrite": ["name", "body.text"] }))
        .await;
    let res = get(&c, &id).await;
    assert_eq!((res["name"].as_str(), res["body"]["text"].as_str()), (Some("mine"), Some("mine")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_basis_gone_from_the_history_counts_every_field_as_changed() {
    let (env, c) = setup().await;
    let id = new_item(&c).await;
    save(&c, &id, json!({ "name": "theirs" }), "1").await.unwrap();
    db(&env).execute("DELETE FROM revisions WHERE resource_id = ?1 AND rev = 1", [&id]).unwrap();
    let e = save(&c, &id, json!({ "body.text": "mine" }), "1").await.unwrap_err();
    assert_eq!(stale(&e), (ErrorCode::Conflict, "stale", "body.text", "2"));
    // "Keep mine" still gets through.
    c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "body.text": "mine" }, "basis": "1", "overwrite": ["body.text"] }))
        .await;
    assert_eq!(get(&c, &id).await["body"]["text"], "mine");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_current_basis_or_none_behaves_as_before() {
    let (_env, c) = setup().await;
    let id = new_item(&c).await;
    save(&c, &id, json!({ "name": "one" }), "1").await.unwrap();
    // Current basis: the same field again is fine.
    save(&c, &id, json!({ "name": "two" }), "2").await.unwrap();
    // No basis at all: written without any check.
    c.ok("page.save", json!({ "target": format!("resource:{id}"), "changes": { "name": "three" } })).await;
    assert_eq!(get(&c, &id).await["name"], "three");
    // A field changed and changed back since the basis is not a conflict (compared by value).
    save(&c, &id, json!({ "body.text": "b" }), "4").await.unwrap();
    save(&c, &id, json!({ "body.text": "a" }), "5").await.unwrap();
    save(&c, &id, json!({ "body.text": "mine" }), "4").await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn plugin_writes_keep_their_rules() {
    let (_env, c) = setup().await;
    let id = new_item(&c).await;
    save(&c, &id, json!({ "body.text": "user" }), "1").await.unwrap();
    // Without a basis a plugin write simply applies.
    let r = c.probe("test.alpha", "resources.update", json!([id, { "body.text": "plugin" }])).await;
    assert!(r.get("error").is_none(), "{r}");
    assert_eq!(get(&c, &id).await["body"]["text"], "plugin");
    // An editor that was on rev 2 and changed the same field is now refused.
    let e = save(&c, &id, json!({ "body.text": "mine" }), "2").await.unwrap_err();
    assert_eq!(stale(&e), (ErrorCode::Conflict, "stale", "body.text", "3"));
}

/* ------------------------------------------------------------------ §5 type-supplied children */

const KIDS_MAIN: &str = r#"
export default {
  activate(host) {
    host.kinds.handle("shelf", {
      async children(ctx, node, offset) {
        const b = ctx.resource.body;
        if (b.mode === "throw") throw new Error("boom");
        if (b.mode === "hang") { await ctx.host.util.sleep(60000); return { nodes: [] }; }
        if (b.mode === "mutate") {
          let refused = false;
          try { ctx.resource.body.count = 99; ctx.resource.name = "changed"; } catch (e) { refused = true; }
          return { nodes: [{ key: "m", label: ctx.resource.name + ":" + ctx.resource.body.count + ":" + refused, icon: "box" }] };
        }
        if (node) return { nodes: [{ key: node + ".1", label: "deep", icon: "box" }] };
        const count = b.count || 0;
        const word = ctx.locale === "zh-CN" ? "项 " : "Item ";
        const targets = [
          "resource:" + ctx.resource.id, "core:audit", "resource:" + (b.foreign || "x"), "plugin:test.kids",
          "plugin:test.alpha", "nonsense",
        ];
        const nodes = [];
        for (let i = offset; i < Math.min(count, offset + 500); i++) {
          const n = { key: "k" + i, label: word + i, icon: "box", expandable: i === 1 };
          if (i < targets.length) n.target = targets[i];
          nodes.push(n);
        }
        return offset + 500 < count ? { nodes, next: offset + 500 } : { nodes };
      },
    });
  },
};
"#;

const NOKIDS_MAIN: &str = r#"
export default {
  activate(host) {
    host.kinds.handle("box", { children() { return { nodes: [] }; } });
    host.commands.handle("ping", () => []);
  },
};
"#;

fn kids_plugins(dir: &std::path::Path) -> std::path::PathBuf {
    plugins_with(
        dir,
        &[
            (
                "test.kids",
                json!({ "kinds": [
                    { "id": "shelf", "label": "shelf", "icon": "box", "tree": "resources", "children": true, "accepts": ["leaf"] },
                    { "id": "leaf", "label": "leaf", "icon": "box", "tree": "resources" }
                ] }),
                KIDS_MAIN,
            ),
            (
                "test.nokids",
                json!({ "kinds": [ { "id": "box", "label": "box", "icon": "box", "tree": "resources" } ],
                        "commands": [ { "id": "ping", "label": "ping", "icon": "box" } ] }),
                NOKIDS_MAIN,
            ),
        ],
    )
}

async fn kids_world(timeout_ms: u64) -> (Env, Client) {
    let tmp = tempfile::tempdir().unwrap();
    let plugins = kids_plugins(tmp.path());
    let mut cfg = config_for(&plugins);
    cfg.sandbox.call_timeout = std::time::Duration::from_millis(timeout_ms);
    let env = open_with(tmp, &plugins, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

async fn create(c: &Client, kind: &str, parent: Option<&str>, body: Value) -> String {
    let target = match parent {
        Some(p) => format!("new:{kind}?parent={p}"),
        None => format!("new:{kind}"),
    };
    let changes: serde_json::Map<String, Value> =
        body.as_object().unwrap().iter().map(|(k, v)| (format!("body.{k}"), v.clone())).collect();
    let r = c.ok("page.save", json!({ "target": target, "changes": changes })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn kids(c: &Client, parent: &str, offset: u32, locale: Option<&str>) -> Value {
    c.ok("tree.children", json!({ "tree": "resources", "parent": parent, "offset": offset, "locale": locale })).await
}

/// All children of `parent`, following `next`.
async fn all_kids(c: &Client, parent: &str) -> (Vec<Value>, usize) {
    let (mut out, mut offset, mut calls) = (vec![], 0u32, 0usize);
    loop {
        let p = kids(c, parent, offset, None).await;
        calls += 1;
        out.extend(p["nodes"].as_array().unwrap().iter().cloned());
        match p["next"].as_u64() {
            Some(n) => offset = n as u32,
            None => return (out, calls),
        }
    }
}

#[test]
fn a_manifest_children_kind_needs_a_tree_and_a_boolean() {
    let tmp = tempfile::tempdir().unwrap();
    let bad_tree = plugins_with(
        tmp.path(),
        &[("test.k1", json!({ "kinds": [ { "id": "s", "label": "s", "icon": "box", "children": true } ] }), "export default { activate() {} };")],
    );
    let reg = onedesk_kernel::manifest::Registry::scan(&bad_tree);
    let why = |reg: &onedesk_kernel::manifest::Registry, id: &str| {
        reg.rejected().into_iter().find(|r| r.path.to_string_lossy().contains(id)).map(|r| r.reason)
    };
    assert_eq!(why(&reg, "test.k1").as_deref(), Some("childrenWithoutTree"));
    let tmp2 = tempfile::tempdir().unwrap();
    let bad_type = plugins_with(
        tmp2.path(),
        &[("test.k2", json!({ "kinds": [ { "id": "s", "label": "s", "icon": "box", "tree": "resources", "children": "yes" } ] }), "export default { activate() {} };")],
    );
    let reg = onedesk_kernel::manifest::Registry::scan(&bad_type);
    assert!(why(&reg, "test.k2").is_some());
    assert!(reg.plugin("test.k2").is_none() && reg.plugin("test.alpha").is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn registering_children_for_a_kind_that_does_not_declare_them_is_refused() {
    let (_env, c) = kids_world(5000).await;
    let e = c.call("command.execute", json!({ "id": "test.nokids:ping" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::PluginError, "{e:?}");
    assert!(format!("{e:?}").contains("undeclared children"), "{e:?}");
    // Its resources show no supplied children.
    let id = create(&c, "test.nokids:box", None, json!({})).await;
    assert_eq!(kids(&c, &id, 0, None).await["nodes"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn stored_children_come_first_then_the_plugin_nodes_in_batches() {
    let (_env, c) = kids_world(5000).await;
    let shelf = create(&c, "test.kids:shelf", None, json!({ "count": 450 })).await;
    let mut leaves = vec![];
    for _ in 0..3 {
        leaves.push(create(&c, "test.kids:leaf", Some(&shelf), json!({})).await);
    }
    // The shelf is expandable even when it has no stored children; a plain leaf is not.
    let roots = c.ok("tree.children", json!({ "tree": "resources" })).await;
    let node = roots["nodes"].as_array().unwrap().iter().find(|n| n["key"] == shelf.as_str()).unwrap().clone();
    assert_eq!(node["expandable"], true);
    let (all, calls) = all_kids(&c, &shelf).await;
    assert_eq!(all.len(), 453);
    let keys: Vec<&str> = all.iter().map(|n| n["key"].as_str().unwrap()).collect();
    assert_eq!(&keys[..3], leaves.iter().map(String::as_str).collect::<Vec<_>>().as_slice());
    assert_eq!(keys[3], format!("@{shelf}/k0"));
    assert_eq!(keys[452], format!("@{shelf}/k449"));
    // 1 batch of stored, then 3 of the plugin's (its 500 cut to 200 each time).
    assert_eq!(calls, 4);
    // No plugin key collides with a resource id, and all are unique.
    let set: std::collections::BTreeSet<&str> = keys.iter().copied().collect();
    assert_eq!(set.len(), 453);
    // Plugin nodes: not draggable, nothing to drop on, no rename/delete — at most "open".
    for n in &all[3..] {
        assert_eq!((n["draggable"].as_bool(), n["accepts"].as_array().map(Vec::len)), (Some(false), Some(0)));
        let menu: Vec<&str> = n["menu"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert!(menu.is_empty() || menu == ["node.open"], "{menu:?}");
        assert_eq!(n["parentKey"], shelf.as_str());
    }
    // They cannot be renamed, moved or deleted.
    let k0 = format!("@{shelf}/k0");
    assert!(c.call("tree.rename", json!({ "tree": "resources", "key": k0, "name": "x" })).await.is_err());
    assert!(c.call("tree.move", json!({ "tree": "resources", "key": k0, "position": "inside" })).await.is_err());
    // A node the plugin marks expandable asks the plugin again with its key.
    let deep = kids(&c, &format!("@{shelf}/k1"), 0, None).await;
    assert_eq!(deep["nodes"][0]["key"], format!("@{shelf}/k1.1"));
    assert_eq!(deep["nodes"][0]["parentKey"], format!("@{shelf}/k1"));
    // Its path is the resource's path plus the node.
    let path = c.ok("tree.path", json!({ "tree": "resources", "key": format!("@{shelf}/k1.1") })).await;
    assert_eq!(path, json!([shelf, format!("@{shelf}/k1.1")]));
}

#[tokio::test(flavor = "multi_thread")]
async fn targets_are_kept_only_when_the_plugin_could_open_them() {
    let (_env, c) = kids_world(5000).await;
    let foreign = create(&c, "test.alpha:item", None, json!({})).await;
    let shelf = create(&c, "test.kids:shelf", None, json!({ "count": 7, "foreign": foreign })).await;
    let p = kids(&c, &shelf, 0, None).await;
    let t: Vec<Value> = p["nodes"].as_array().unwrap().iter().map(|n| n["target"].clone()).collect();
    assert_eq!(
        t,
        vec![json!(format!("resource:{shelf}")), Value::Null, Value::Null, json!("plugin:test.kids"), Value::Null, Value::Null, Value::Null]
    );
    assert_eq!(p["nodes"][0]["menu"][0]["id"], "node.open");
    assert_eq!(p["nodes"][1]["menu"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_or_slow_handler_gives_one_load_failed_node() {
    let (_env, c) = kids_world(800).await;
    let thrower = create(&c, "test.kids:shelf", None, json!({ "mode": "throw" })).await;
    let hanger = create(&c, "test.kids:shelf", None, json!({ "mode": "hang" })).await;
    let fine = create(&c, "test.kids:shelf", None, json!({ "count": 2 })).await;
    let leaf = create(&c, "test.kids:leaf", Some(&thrower), json!({})).await;
    // Stored children still come; the plugin's part is one failed node.
    let (all, _) = all_kids(&c, &thrower).await;
    assert_eq!(all.len(), 2);
    assert_eq!(all[0]["key"], leaf.as_str());
    assert_eq!((all[1]["state"].as_str(), all[1]["expandable"].as_bool(), all[1]["stateReason"].as_str()), (Some("load-failed"), Some(false), Some("pluginError")));
    assert_eq!(all[1]["target"], Value::Null);
    let p = kids(&c, &hanger, 0, None).await;
    assert_eq!(p["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(p["nodes"][0]["state"], "load-failed");
    assert!(p.get("next").is_none());
    // The others are not affected.
    assert_eq!(kids(&c, &fine, 0, None).await["nodes"].as_array().unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_disabled_plugin_shows_none_of_its_nodes() {
    let (_env, c) = kids_world(5000).await;
    let shelf = create(&c, "test.kids:shelf", None, json!({ "count": 3 })).await;
    assert_eq!(kids(&c, &shelf, 0, None).await["nodes"].as_array().unwrap().len(), 3);
    c.ok("command.execute", json!({ "id": "plugin.disable", "context": { "args": { "plugin": "test.kids" } } })).await;
    let p = kids(&c, &shelf, 0, None).await;
    assert_eq!(p["nodes"], json!([]));
    assert_eq!(kids(&c, &format!("@{shelf}/k1"), 0, None).await["nodes"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn ctx_resource_is_read_only_and_locale_is_passed() {
    let (_env, c) = kids_world(5000).await;
    let m = create(&c, "test.kids:shelf", None, json!({ "mode": "mutate", "count": 5 })).await;
    let p = kids(&c, &m, 0, None).await;
    let label = p["nodes"][0]["label"].as_str().unwrap().to_string();
    let r = get(&c, &m).await;
    assert_eq!(label, format!("{}:5:true", r["name"].as_str().unwrap()));
    assert_eq!(r["body"]["count"], 5);
    let shelf = create(&c, "test.kids:shelf", None, json!({ "count": 1 })).await;
    assert_eq!(kids(&c, &shelf, 0, Some("zh-CN")).await["nodes"][0]["label"], "项 0");
    assert_eq!(kids(&c, &shelf, 0, Some("en-US")).await["nodes"][0]["label"], "Item 0");
}

/* ------------------------------------------------------------------ §7 many packages */

#[tokio::test(flavor = "multi_thread")]
async fn with_thousands_of_packages_the_first_answers_do_not_look_at_every_plugin() {
    // Round 10 §7: after opening, neither the background automatic switch nor the first batch
    // of the `plugins` tree may ask each package's state (that took seconds with 10 000).
    const N: usize = 3000;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    let mut entries = Vec::new();
    for i in 0..N {
        let id = format!("t.many-{i:05}");
        let dir = root.join(&id).join("0.1.0");
        std::fs::create_dir_all(&dir).unwrap();
        let m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js" }).to_string();
        std::fs::write(dir.join("manifest.json"), &m).unwrap();
        std::fs::write(dir.join("main.js"), "export default { activate() {} };").unwrap();
        entries.push(json!({ "dir": format!("{id}/0.1.0"), "mtime": 0, "size": m.len(), "manifest": m }));
    }
    std::fs::write(root.join(".index"), serde_json::to_vec(&json!({ "version": 1, "entries": entries })).unwrap()).unwrap();
    let ws = tmp.path().join("ws");
    // First open registers the packages; the second is the start that has to be quick.
    onedesk_kernel::Kernel::open(&ws, &root, test_config()).unwrap().shutdown();
    let t = std::time::Instant::now();
    let k = std::sync::Arc::new(onedesk_kernel::Kernel::open(&ws, &root, test_config()).unwrap());
    let c = Client::in_proc(k.clone());
    c.hello().await;
    let page = c.ok("tree.children", json!({ "tree": "plugins" })).await;
    let took = t.elapsed();
    assert_eq!(page["nodes"].as_array().unwrap().len(), 200);
    assert_eq!(page["next"], 200);
    // Let the background automatic switch run: nothing has a newer version, so it asks nothing.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let q = k.state_queries();
    assert!(q < 8 * 200, "{q} plugin state queries for one batch of {N} packages");
    // The last batch is there too, with the same shape.
    let last = c.ok("tree.children", json!({ "tree": "plugins", "offset": 2800 })).await;
    assert_eq!(last["nodes"].as_array().unwrap().len(), 200);
    assert!(last.get("next").is_none());
    assert_eq!(last["nodes"][199]["key"], "t.many-02999");
    // A loose backstop only (debug build, busy machines).
    assert!(took < std::time::Duration::from_secs(60), "{took:?}");
}
