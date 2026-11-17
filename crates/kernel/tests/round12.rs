//! Round 12: basic information of every resource (`requires.resources`, `resourcesAll`,
//! `host.resources.search`, D389) and drops the kind decides (`drop`, `dropAny`, D390).
//! Temporary folders only; plugins here are generic test packages.

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
    return [{ type: "copy", text: JSON.stringify({ error: e.code || String(e), params: e.params || {} }) }];
  }
}
"#;

/// D393: a page with a table whose rows carry keys, targets and actions; `body.mode` breaks it.
const SHEET: &str = r#"
function sheet(host) {
  host.pages.handle("sheet", {
    render(ctx) {
      const b = ctx.resource.body;
      const targets = b.targets || [];
      const rows = targets.map((t, i) => ["row " + i]);
      const table = { type: "table", id: "t", columns: [{ key: "n", label: "N" }], rows, rowTargets: targets,
        rowKeys: targets.map((_, i) => "k" + i),
        rowActions: [{ id: "remove", label: "Remove", icon: "x" }, { id: "up", label: { "en-US": "Up" } }] };
      if (b.mode === "shortTargets") table.rowTargets = targets.slice(1);
      if (b.mode === "shortKeys") table.rowKeys = [];
      if (b.mode === "manyActions") table.rowActions = [1, 2, 3, 4, 5].map((i) => ({ id: "a" + i, label: "a" }));
      if (b.mode === "unknownField") table.rowColor = "red";
      return { view: [table] };
    },
    onEvent(ctx, event) {
      return { message: { "en-US": event + "@" + (ctx.row === undefined ? "none" : String(ctx.row)) } };
    },
  });
}
"#;

/// Has `requires.resources`: a `hub` kind that takes drops and supplies children.
const REACH_MAIN: &str = r#"
export default {
  activate(host) {
    sheet(host);
    host.commands.handle("probe", probe);
    host.commands.handle("fill", async (ctx, context) => {
      const n = (context && context.args && context.args.n) || 0;
      for (let i = 0; i < n; i++) await ctx.host.resources.create({ kind: "card", name: "fill " + i, tags: ["bulk"] });
      return [];
    });
    host.kinds.handle("hub", {
      async children(ctx, node, offset) {
        const items = ctx.resource.body.items || [];
        const found = await ctx.host.resources.search({ ids: items });
        return { nodes: items.map((id) => ({ key: id, label: id, icon: "box", target: "resource:" + id })) };
      },
      async drop(ctx, ev) {
        const mode = ctx.resource.body.mode || "take";
        if (mode === "throw") throw new Error("boom");
        if (mode === "hang") { await ctx.host.util.sleep(60000); return { handled: true }; }
        if (mode === "bad") return 42;
        if (mode === "none") return undefined;
        if (mode === "pass") return { handled: false };
        if (mode.startsWith("write")) {
          const r = await ctx.host.resources.update(ctx.resource.id, { "body.items": ["x"] });
          if (mode === "writeThenThrow") throw new Error("late");
          if (mode === "writeThenHang") { await ctx.host.util.sleep(60000); return { handled: true }; }
          if (mode === "writeThenBad") return { handled: "yes" };
          if (mode === "writeThenPass") return { handled: false };
          if (mode === "writeThenCreate") { await ctx.host.resources.create({ kind: "card", name: "side" }); return { handled: true }; }
          if (mode === "writeThenStorage") { await ctx.host.storage.set("k", "v"); return { handled: true }; }
          if (mode === "writeTwice") {
            await ctx.host.resources.update(ctx.resource.id, { "name": "Renamed" });
            return { handled: true, message: JSON.stringify(r) };
          }
        }
        const items = (ctx.resource.body.items || []).slice();
        for (const s of ev.sources) if (!items.includes(s.id)) items.push(s.id);
        await ctx.host.resources.update(ctx.resource.id, {
          "body.items": items,
          "body.lastEv": JSON.stringify(ev),
          "body.lastLocale": ctx.locale || "",
        });
        return { handled: true, message: { "en-US": "Added " + ev.sources.length } };
      },
    });
  },
};
"#;

/// Without `requires.resources`: children pointing at others' resources; a drop kind as well.
const BLIND_MAIN: &str = r#"
export default {
  activate(host) {
    sheet(host);
    host.commands.handle("probe", probe);
    host.kinds.handle("shelf", {
      children(ctx) {
        return { nodes: [
          { key: "a", label: "a", icon: "box", target: "resource:" + ctx.resource.body.foreign },
          { key: "b", label: "b", icon: "box", target: "resource:" + ctx.resource.id },
        ] };
      },
    });
    host.kinds.handle("bin", { drop(ctx, ev) { return { handled: true }; } });
  },
};
"#;

/// Registers `drop` for a kind that does not declare it.
const NODROP_MAIN: &str = r#"
export default {
  activate(host) {
    host.kinds.handle("box", { drop() { return { handled: true }; } });
    host.commands.handle("ping", () => []);
  },
};
"#;

fn write_pkg(root: &Path, id: &str, requires: Value, contributes: Value, main: &str) {
    let pkg = root.join(id).join("0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box",
                    "main": "main.js", "requires": requires, "contributes": contributes });
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), format!("{PROBE}\n{SHEET}\n{main}")).unwrap();
}

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    let probe = json!({ "id": "probe", "label": "probe", "icon": "box" });
    write_pkg(
        &root,
        "test.reach",
        json!({ "resources": true }),
        json!({
            "kinds": [
                { "id": "hub", "label": "hub", "icon": "layers", "tree": "resources", "children": true, "drop": true, "accepts": ["hub"] },
                { "id": "card", "label": "card", "icon": "box", "tree": "resources", "draggable": true },
                { "id": "loose", "label": "loose", "icon": "box" },
                { "id": "pin", "label": "pin", "icon": "pin", "tree": "shelf" },
                { "id": "sheet", "label": "sheet", "icon": "table", "tree": "resources", "page": "sheet" }
            ],
            "trees": [ { "id": "shelf", "label": "shelf", "icon": "box", "source": "stored" } ],
            "pages": [ { "id": "sheet" } ],
            "commands": [probe, { "id": "fill", "label": "fill", "icon": "box" }]
        }),
        REACH_MAIN,
    );
    write_pkg(
        &root,
        "test.blind",
        json!({}),
        json!({
            "kinds": [
                { "id": "shelf", "label": "shelf", "icon": "box", "tree": "resources", "children": true },
                { "id": "bin", "label": "bin", "icon": "box", "tree": "resources", "drop": true },
                { "id": "sheet", "label": "sheet", "icon": "table", "tree": "resources", "page": "sheet" }
            ],
            "pages": [ { "id": "sheet" } ],
            "commands": [probe]
        }),
        BLIND_MAIN,
    );
    write_pkg(
        &root,
        "test.nodrop",
        json!({}),
        json!({
            "kinds": [ { "id": "box", "label": "box", "icon": "box", "tree": "resources" } ],
            "commands": [ { "id": "ping", "label": "ping", "icon": "box" } ]
        }),
        NODROP_MAIN,
    );
    root
}

async fn world(timeout_ms: u64) -> (Env, Client) {
    let tmp = tempfile::tempdir().unwrap();
    let root = plugins(tmp.path());
    let mut cfg = config_for(&root);
    cfg.sandbox.call_timeout = std::time::Duration::from_millis(timeout_ms);
    let env = open_with(tmp, &root, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    (env, c)
}

async fn create(c: &Client, kind: &str, parent: Option<&str>, changes: Value) -> String {
    let target = match parent {
        Some(p) => format!("new:{kind}?parent={p}"),
        None => format!("new:{kind}"),
    };
    let r = c.ok("page.save", json!({ "target": target, "changes": changes })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn search(c: &Client, plugin: &str, opts: Value) -> Value {
    c.probe(plugin, "resources.search", json!([opts])).await
}

fn ids(r: &Value) -> Vec<String> {
    r["ok"]["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()).collect()
}

async fn get(c: &Client, id: &str) -> Value {
    c.ok("resource.get", json!({ "id": id })).await
}

async fn kids(c: &Client, parent: &str) -> Vec<Value> {
    c.ok("tree.children", json!({ "tree": "resources", "parent": parent })).await["nodes"].as_array().unwrap().clone()
}

async fn root_node(c: &Client, key: &str) -> Value {
    let roots = c.ok("tree.children", json!({ "tree": "resources" })).await;
    roots["nodes"].as_array().unwrap().iter().find(|n| n["key"] == key).unwrap().clone()
}

fn mv(key: &str, target: &str) -> Value {
    json!({ "tree": "resources", "key": key, "target": target, "position": "inside" })
}

async fn audits(c: &Client, op: &str) -> Vec<Value> {
    c.ok("audit.list", json!({ "operation": op })).await.as_array().unwrap().clone()
}

/* ------------------------------------------------------------------ §3 resourcesAll */

#[tokio::test(flavor = "multi_thread")]
async fn the_permission_is_listed_for_confirmation_and_in_the_fingerprint() {
    let (_env, c) = world(5000).await;
    let reach = c.ok("plugin.get", json!({ "plugin": "test.reach" })).await;
    let blind = c.ok("plugin.get", json!({ "plugin": "test.blind" })).await;
    let perms = |p: &Value| -> Vec<String> {
        p["permissions"].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap().to_string()).collect()
    };
    let version_perms = |p: &Value| -> Vec<String> {
        p["versions"][0]["permissions"].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap().to_string()).collect()
    };
    assert!(version_perms(&reach).contains(&"resourcesAll".to_string()), "{reach}");
    assert_ne!(reach["versions"][0]["fingerprint"], blind["versions"][0]["fingerprint"]);
    assert!(perms(&reach).contains(&"resourcesAll".to_string()), "{reach}");
    assert!(!perms(&blind).contains(&"resourcesAll".to_string()), "{blind}");
}

#[tokio::test(flavor = "multi_thread")]
async fn search_without_the_permission_is_refused() {
    let (_env, c) = world(5000).await;
    let r = search(&c, "test.blind", json!({})).await;
    assert_eq!((r["error"].as_str(), r["params"]["reason"].as_str()), (Some("denied"), Some("notRequested")), "{r}");
    let denied = c.ok("audit.list", json!({ "result": "denied" })).await;
    assert!(denied.as_array().unwrap().iter().any(|a| a["operation"] == "resources.search"), "{denied}");
}

#[tokio::test(flavor = "multi_thread")]
async fn search_conditions_alone_and_together() {
    let (_env, c) = world(5000).await;
    let a = create(&c, "test.alpha:item", None, json!({ "name": "Alpha apple", "tags": ["red", "fruit"], "body.text": "zebra crossing", "description": "secret words" })).await;
    let b = create(&c, "test.alpha:item", None, json!({ "name": "Beta banana", "tags": ["fruit"], "body.text": "yellow" })).await;
    let card = create(&c, "test.reach:card", None, json!({ "name": "Card", "tags": ["red"] })).await;
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "Folder" })).await["key"].as_str().unwrap().to_string();
    let inner = create(&c, "test.reach:card", Some(&g), json!({ "name": "Inner card" })).await;

    // Kinds (full names).
    let r = search(&c, "test.reach", json!({ "kinds": ["test.alpha:item"] })).await;
    let mut got = ids(&r);
    got.sort();
    let mut want = vec![a.clone(), b.clone()];
    want.sort();
    assert_eq!(got, want);
    assert_eq!(r["ok"]["total"], 2);
    // Tags: all of them.
    assert_eq!(ids(&search(&c, "test.reach", json!({ "tags": ["red", "fruit"] })).await), vec![a.clone()]);
    let mut red = ids(&search(&c, "test.reach", json!({ "tags": ["red"] })).await);
    red.sort();
    let mut want = vec![a.clone(), card.clone()];
    want.sort();
    assert_eq!(red, want);
    // Text: through the body and the description too, short words as well.
    assert_eq!(ids(&search(&c, "test.reach", json!({ "text": "zebra" })).await), vec![a.clone()]);
    assert_eq!(ids(&search(&c, "test.reach", json!({ "text": "secret" })).await), vec![a.clone()]);
    assert_eq!(ids(&search(&c, "test.reach", json!({ "text": "ye" })).await), vec![b.clone()]);
    // Together.
    assert_eq!(ids(&search(&c, "test.reach", json!({ "kinds": ["test.reach:card"], "tags": ["red"] })).await), vec![card.clone()]);
    assert_eq!(search(&c, "test.reach", json!({ "kinds": ["test.reach:card"], "text": "zebra" })).await["ok"]["total"], 0);
    // Nothing but basic information: no body, no description.
    let all = search(&c, "test.reach", json!({})).await;
    for i in all["ok"]["items"].as_array().unwrap() {
        let keys: Vec<&str> = i.as_object().unwrap().keys().map(String::as_str).collect();
        assert!(!keys.contains(&"body") && !keys.contains(&"description"), "{i}");
        for k in &keys {
            assert!(["id", "name", "kind", "kindLabel", "icon", "tree", "parent", "tags", "deleted"].contains(k), "{k}");
        }
    }
    let inner_info = all["ok"]["items"].as_array().unwrap().iter().find(|i| i["id"] == inner.as_str()).unwrap().clone();
    assert_eq!(
        (inner_info["parent"].as_str(), inner_info["tree"].as_str(), inner_info["icon"].as_str(), inner_info["deleted"].as_bool()),
        (Some(g.as_str()), Some("resources"), Some("box"), Some(false))
    );
    assert_eq!(inner_info["kind"], "test.reach:card");
    // The group itself is a resource as well; no plugin state is ever listed.
    assert!(all["ok"]["items"].as_array().unwrap().iter().any(|i| i["id"] == g.as_str()));
    assert!(all["ok"]["items"].as_array().unwrap().iter().all(|i| i["tree"] != "plugin-state" && !i["kind"].as_str().unwrap().starts_with("core:plugin")));
    // Unknown option → invalidParams.
    let bad = search(&c, "test.reach", json!({ "sort": "name" })).await;
    assert_eq!(bad["error"], "invalidParams", "{bad}");
}

#[tokio::test(flavor = "multi_thread")]
async fn search_pages_with_total_and_next_and_caps_the_limit() {
    let (_env, c) = world(20000).await;
    c.ok("command.execute", json!({ "id": "test.reach:fill", "context": { "args": { "n": 520 } } })).await;
    let q = json!({ "tags": ["bulk"] });
    // Default limit 200.
    let p1 = search(&c, "test.reach", q.clone()).await;
    assert_eq!((p1["ok"]["items"].as_array().unwrap().len(), p1["ok"]["total"].as_u64(), p1["ok"]["next"].as_u64()), (200, Some(520), Some(200)));
    // At most 500.
    let big = search(&c, "test.reach", json!({ "tags": ["bulk"], "limit": 100000 })).await;
    assert_eq!((big["ok"]["items"].as_array().unwrap().len(), big["ok"]["next"].as_u64()), (500, Some(500)));
    // Walking with offset gives every one once.
    let mut seen = std::collections::BTreeSet::new();
    let mut offset = 0u64;
    loop {
        let p = search(&c, "test.reach", json!({ "tags": ["bulk"], "limit": 150, "offset": offset })).await;
        for id in ids(&p) {
            assert!(seen.insert(id));
        }
        match p["ok"]["next"].as_u64() {
            Some(n) => offset = n,
            None => break,
        }
    }
    assert_eq!(seen.len(), 520);
    let last = search(&c, "test.reach", json!({ "tags": ["bulk"], "limit": 20, "offset": 510 })).await;
    assert_eq!((last["ok"]["items"].as_array().unwrap().len(), last["ok"].get("next")), (10, None));
}

#[tokio::test(flavor = "multi_thread")]
async fn search_by_ids_keeps_the_order_marks_deleted_and_skips_missing() {
    let (_env, c) = world(5000).await;
    let a = create(&c, "test.alpha:item", None, json!({ "name": "A" })).await;
    let b = create(&c, "test.alpha:item", None, json!({ "name": "B" })).await;
    let d = create(&c, "test.alpha:item", None, json!({ "name": "D" })).await;
    let gone = create(&c, "test.alpha:item", None, json!({ "name": "Gone" })).await;
    c.ok("resource.delete", json!({ "id": d })).await;
    c.ok("resource.delete", json!({ "id": gone })).await;
    c.ok("resource.purge", json!({ "id": gone })).await;
    let r = search(&c, "test.reach", json!({ "ids": [b, "0123456789abcdef0123456789abcdef", d, gone, a] })).await;
    assert_eq!(ids(&r), vec![b.clone(), d.clone(), a.clone()]);
    let items = r["ok"]["items"].as_array().unwrap();
    assert_eq!(items.iter().map(|i| i["deleted"].as_bool().unwrap()).collect::<Vec<_>>(), vec![false, true, false]);
    assert_eq!(r["ok"]["total"], 3);
    // Without `ids` the deleted one is not there.
    assert!(!ids(&search(&c, "test.reach", json!({ "kinds": ["test.alpha:item"] })).await).contains(&d));
}

#[tokio::test(flavor = "multi_thread")]
async fn children_may_point_anywhere_only_with_the_permission() {
    let (_env, c) = world(5000).await;
    let foreign = create(&c, "test.alpha:item", None, json!({ "name": "Foreign" })).await;
    // With `requires.resources`: kept.
    let hub = create(&c, "test.reach:hub", None, json!({ "body.items": [foreign] })).await;
    let n = kids(&c, &hub).await;
    assert_eq!(n[0]["target"], format!("resource:{foreign}"));
    // Without: dropped (its own resource still fine).
    let shelf = create(&c, "test.blind:shelf", None, json!({ "body.foreign": foreign })).await;
    let n = kids(&c, &shelf).await;
    assert_eq!((n[0]["target"].clone(), n[1]["target"].clone()), (Value::Null, json!(format!("resource:{shelf}"))));
    // A deleted resource is not a target any more, even with the permission.
    c.ok("resource.delete", json!({ "id": foreign })).await;
    assert_eq!(kids(&c, &hub).await[0]["target"], Value::Null);
}

/* ------------------------------------------------------------------ §4 drop */

#[test]
fn a_manifest_drop_kind_needs_a_tree_and_a_boolean() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("p");
    write_pkg(&root, "test.d1", json!({}), json!({ "kinds": [ { "id": "s", "label": "s", "icon": "box", "drop": true } ] }), "export default { activate() {} };");
    write_pkg(&root, "test.d2", json!({}), json!({ "kinds": [ { "id": "s", "label": "s", "icon": "box", "tree": "resources", "drop": 1 } ] }), "export default { activate() {} };");
    write_pkg(&root, "test.d3", json!({ "resources": "all" }), json!({}), "export default { activate() {} };");
    let reg = onedesk_kernel::manifest::Registry::scan(&root);
    let why = |id: &str| reg.rejected().into_iter().find(|r| r.path.to_string_lossy().contains(id)).map(|r| r.reason);
    assert_eq!(why("test.d1").as_deref(), Some("dropWithoutTree"));
    assert_eq!(why("test.d2").as_deref(), Some("schema"));
    assert_eq!(why("test.d3").as_deref(), Some("schema"));
}

#[tokio::test(flavor = "multi_thread")]
async fn registering_drop_for_a_kind_that_does_not_declare_it_is_refused() {
    let (_env, c) = world(5000).await;
    let e = c.call("command.execute", json!({ "id": "test.nodrop:ping" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::PluginError, "{e:?}");
    assert!(format!("{e:?}").contains("undeclared drop"), "{e:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn drop_any_is_on_the_nodes_of_drop_kinds_only() {
    let (_env, c) = world(5000).await;
    let hub = create(&c, "test.reach:hub", None, json!({})).await;
    let card = create(&c, "test.reach:card", None, json!({})).await;
    assert_eq!(root_node(&c, &hub).await["dropAny"], true);
    assert!(root_node(&c, &card).await.get("dropAny").is_none());
    // Its ordinary `accepts` is unchanged.
    assert_eq!(root_node(&c, &hub).await["accepts"], json!(["test.reach:hub"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drop_calls_the_plugin_and_moves_nothing() {
    let (_env, c) = world(5000).await;
    let hub = create(&c, "test.reach:hub", None, json!({ "name": "Hub" })).await;
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "G" })).await["key"].as_str().unwrap().to_string();
    let item = create(&c, "test.alpha:item", Some(&g), json!({ "name": "Note", "description": "private", "body.text": "inside", "tags": ["t"] })).await;
    let r = c.ok("tree.move", json!({ "tree": "resources", "key": item, "target": hub, "position": "inside", "locale": "zh-CN" })).await;
    assert_eq!(r, json!({ "handled": true, "message": { "en-US": "Added 1" } }));
    // The resource stays where it was.
    let it = get(&c, &item).await;
    assert_eq!(it["parentId"], g.as_str());
    // The plugin wrote its own resource.
    let h = get(&c, &hub).await;
    assert_eq!(h["body"]["items"], json!([item]));
    assert_eq!(h["body"]["lastLocale"], "zh-CN");
    assert_eq!(h["updatedBy"].as_str().map(|s| s.starts_with("plugin:test.reach")), Some(true), "{h}");
    // `ev.sources`: basic information only.
    let ev: Value = serde_json::from_str(h["body"]["lastEv"].as_str().unwrap()).unwrap();
    let s = &ev["sources"][0];
    assert_eq!((s["id"].as_str(), s["name"].as_str(), s["kind"].as_str(), s["parent"].as_str()), (Some(item.as_str()), Some("Note"), Some("test.alpha:item"), Some(g.as_str())));
    assert!(s.get("body").is_none() && s.get("description").is_none(), "{s}");
    assert_eq!(ev["sources"].as_array().unwrap().len(), 1);
    // Audited as the plugin, object = the target, summary counts the sources.
    let a = audits(&c, "tree.drop").await;
    assert_eq!(a.len(), 1);
    assert_eq!((a[0]["source"].as_str(), a[0]["actor"].as_str(), a[0]["result"].as_str()), (Some("plugin"), Some("plugin:test.reach@0.1.0"), Some("ok")));
    assert_eq!(a[0]["target"], "Hub", "{}", a[0]);
    assert!(a[0]["detail"].as_str().unwrap().contains("\"sources\":1"), "{}", a[0]);
    // No move was recorded.
    assert!(audits(&c, "resource.move").await.is_empty());
    // An ordinary move answers an empty result.
    let other = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "H" })).await["key"].as_str().unwrap().to_string();
    assert_eq!(c.ok("tree.move", mv(&item, &other)).await, json!({}));
}

#[tokio::test(flavor = "multi_thread")]
async fn not_handled_goes_on_as_an_ordinary_move() {
    let (_env, c) = world(5000).await;
    let pass = create(&c, "test.reach:hub", None, json!({ "body.mode": "pass" })).await;
    let none = create(&c, "test.reach:hub", None, json!({ "body.mode": "none" })).await;
    let item = create(&c, "test.alpha:item", None, json!({})).await;
    // The hub does not accept items: the ordinary move is refused as before.
    let e = c.call("tree.move", mv(&item, &pass)).await.unwrap_err();
    assert_eq!((e.code, e.params.get("reason").map(String::as_str)), (ErrorCode::Invalid, Some("notAccepted")));
    let e = c.call("tree.move", mv(&item, &none)).await.unwrap_err();
    assert_eq!(e.params.get("reason").map(String::as_str), Some("notAccepted"));
    // A hub it accepts by the ordinary rule, also when the plugin says "not handled".
    let inner = create(&c, "test.reach:hub", None, json!({ "body.mode": "pass" })).await;
    c.ok("tree.move", mv(&inner, &pass)).await;
    assert_eq!(get(&c, &inner).await["parentId"], pass.as_str());
    assert!(audits(&c, "tree.drop").await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn what_accepts_takes_is_moved_without_asking_the_plugin() {
    let (_env, c) = world(5000).await;
    // Mode `throw`: if the plugin were asked, the move would fail.
    let outer = create(&c, "test.reach:hub", None, json!({ "body.mode": "throw" })).await;
    let inner = create(&c, "test.reach:hub", None, json!({})).await;
    assert_eq!(c.ok("tree.move", mv(&inner, &outer)).await, json!({}));
    assert_eq!(get(&c, &inner).await["parentId"], outer.as_str());
    assert_eq!(get(&c, &outer).await["body"].get("items"), None);
    // Before / after a drop node: ordinary rules, never the plugin.
    let item = create(&c, "test.alpha:item", None, json!({})).await;
    c.ok("tree.move", json!({ "tree": "resources", "key": item, "target": outer, "position": "before" })).await;
    assert!(audits(&c, "tree.drop").await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn errors_and_timeouts_move_nothing() {
    let (_env, c) = world(800).await;
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "G" })).await["key"].as_str().unwrap().to_string();
    let item = create(&c, "test.alpha:item", Some(&g), json!({})).await;
    for mode in ["throw", "hang", "bad"] {
        let hub = create(&c, "test.reach:hub", None, json!({ "body.mode": mode })).await;
        let e = c.call("tree.move", mv(&item, &hub)).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::PluginError, "{mode}: {e:?}");
        assert_eq!(get(&c, &item).await["parentId"], g.as_str(), "{mode}");
        assert_eq!(get(&c, &hub).await["body"].get("items"), None, "{mode}");
    }
    assert!(audits(&c, "tree.drop").await.is_empty());
    assert!(audits(&c, "resource.move").await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_disabled_plugin_s_nodes_follow_the_ordinary_rules() {
    let (_env, c) = world(5000).await;
    let hub = create(&c, "test.reach:hub", None, json!({})).await;
    let item = create(&c, "test.alpha:item", None, json!({})).await;
    c.ok("command.execute", json!({ "id": "plugin.disable", "context": { "args": { "plugin": "test.reach" } } })).await;
    assert!(root_node(&c, &hub).await.get("dropAny").is_none());
    let e = c.call("tree.move", mv(&item, &hub)).await.unwrap_err();
    assert_eq!(e.params.get("reason").map(String::as_str), Some("notAccepted"), "{e:?}");
    assert_eq!(get(&c, &hub).await["body"].get("items"), None);
    assert!(audits(&c, "tree.drop").await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn sources_need_no_permission_and_the_drop_kind_of_a_plugin_without_it_works() {
    let (_env, c) = world(5000).await;
    let bin = create(&c, "test.blind:bin", None, json!({})).await;
    let item = create(&c, "test.alpha:item", None, json!({})).await;
    assert_eq!(c.ok("tree.move", mv(&item, &bin)).await["handled"], true);
    assert_eq!(get(&c, &item).await.get("parentId"), None);
    assert_eq!(audits(&c, "tree.drop").await.len(), 1);
}

/* ------------------------------------------------------------------ review #1 (D393) table rows */

async fn env_root(c: &Client, tree: &str) -> String {
    c.ok("tree.children", json!({ "tree": tree })).await["nodes"][0]["key"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn table_rows_carry_actions_keys_and_checked_targets() {
    let (_env, c) = world(5000).await;
    let foreign = create(&c, "test.alpha:item", None, json!({ "name": "F" })).await;
    let env = env_root(&c, "env").await;
    let targets = json!([format!("resource:{foreign}"), null, format!("resource:{env}"), "nonsense", "plugin:test.reach"]);
    let sheet = create(&c, "test.reach:sheet", None, json!({ "body.targets": targets })).await;
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{sheet}"), "context": {} })).await;
    let t = &p["view"][0];
    // With resourcesAll: the foreign resource stays; environments are never targets (D395).
    assert_eq!(t["rowTargets"], json!([format!("resource:{foreign}"), null, null, null, "plugin:test.reach"]), "{t}");
    assert_eq!(t["rowKeys"], json!(["k0", "k1", "k2", "k3", "k4"]));
    assert_eq!(t["rowActions"], json!([{ "id": "remove", "label": "Remove", "icon": "x" }, { "id": "up", "label": { "en-US": "Up" } }]));
    // Without the permission the foreign resource is not a target.
    let blind = create(&c, "test.blind:sheet", None, json!({ "body.targets": [format!("resource:{foreign}")] })).await;
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{blind}"), "context": {} })).await;
    assert_eq!(p["view"][0]["rowTargets"], json!([null]));
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_tables_are_plugin_errors() {
    let (_env, c) = world(5000).await;
    let t = json!(["plugin:test.reach", "plugin:test.reach"]);
    for mode in ["shortTargets", "shortKeys", "manyActions", "unknownField"] {
        let s = create(&c, "test.reach:sheet", None, json!({ "body.targets": t })).await;
        c.probe("test.reach", "resources.update", json!([s, { "body.mode": mode }])).await;
        let e = c.call("page.resolve", json!({ "target": format!("resource:{s}"), "context": {} })).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::PluginError, "{mode}: {e:?}");
    }
    // Exactly 4 row actions are fine.
    let s = create(&c, "test.reach:sheet", None, json!({ "body.targets": t })).await;
    c.ok("page.resolve", json!({ "target": format!("resource:{s}"), "context": {} })).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_row_action_event_hands_the_row_to_ctx_row() {
    let (_env, c) = world(5000).await;
    let s = create(&c, "test.reach:sheet", None, json!({ "body.targets": ["plugin:test.reach"] })).await;
    let target = format!("resource:{s}");
    let r = c.ok("page.event", json!({ "target": target, "event": "remove", "context": { "row": "k0" } })).await;
    assert_eq!(r["message"], json!({ "en-US": "remove@k0" }));
    let r = c.ok("page.event", json!({ "target": target, "event": "up", "context": {} })).await;
    assert_eq!(r["message"], json!({ "en-US": "up@none" }));
    let e = c.call("page.event", json!({ "target": target, "event": "up", "context": { "row": "x".repeat(1001) } })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidParams);
}

/* ------------------------------------------------------------------ review #2 (D394) one transaction */

#[tokio::test(flavor = "multi_thread")]
async fn writes_made_before_a_failure_are_not_kept() {
    let (_env, c) = world(800).await;
    let item = create(&c, "test.alpha:item", None, json!({})).await;
    for mode in ["writeThenThrow", "writeThenHang", "writeThenBad", "writeThenCreate", "writeThenStorage"] {
        let hub = create(&c, "test.reach:hub", None, json!({ "body.mode": mode })).await;
        let rev = get(&c, &hub).await["rev"].clone();
        let e = c.call("tree.move", mv(&item, &hub)).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::PluginError, "{mode}: {e:?}");
        let h = get(&c, &hub).await;
        assert_eq!((h["body"].get("items"), h["rev"].clone()), (None, rev), "{mode}");
        assert_eq!(get(&c, &item).await.get("parentId"), None, "{mode}");
    }
    // Nothing else was created or stored either.
    let cards = search(&c, "test.reach", json!({ "kinds": ["test.reach:card"] })).await;
    assert_eq!(cards["ok"]["total"], 0);
    assert!(audits(&c, "tree.drop").await.iter().all(|a| a["result"] != "ok"));
    // The refused create was recorded as refused.
    let denied = c.ok("audit.list", json!({ "result": "denied" })).await;
    assert!(denied.as_array().unwrap().iter().any(|a| a["operation"] == "resources.create"), "{denied}");
}

#[tokio::test(flavor = "multi_thread")]
async fn not_handled_drops_the_kept_writes_too() {
    let (_env, c) = world(5000).await;
    let hub = create(&c, "test.reach:hub", None, json!({ "body.mode": "writeThenPass" })).await;
    let item = create(&c, "test.alpha:item", None, json!({})).await;
    let e = c.call("tree.move", mv(&item, &hub)).await.unwrap_err();
    assert_eq!(e.params.get("reason").map(String::as_str), Some("notAccepted"));
    assert_eq!(get(&c, &hub).await["body"].get("items"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_handled_drop_writes_everything_together_with_its_audit() {
    let (_env, c) = world(5000).await;
    let hub = create(&c, "test.reach:hub", None, json!({ "body.mode": "writeTwice", "name": "H" })).await;
    let item = create(&c, "test.alpha:item", None, json!({})).await;
    let r = c.ok("tree.move", mv(&item, &hub)).await;
    // The update answered before the commit: no rev yet.
    assert_eq!(r, json!({ "handled": true, "message": "{\"rev\":null}" }));
    let h = get(&c, &hub).await;
    assert_eq!((h["body"]["items"].clone(), h["name"].as_str()), (json!(["x"]), Some("Renamed")));
    assert_eq!(audits(&c, "tree.drop").await.len(), 1);
}

/* ------------------------------------------------------------------ review #3 (D395) stored trees only */

#[tokio::test(flavor = "multi_thread")]
async fn search_and_any_targets_only_reach_stored_trees() {
    let (_env, c) = world(5000).await;
    let env = env_root(&c, "env").await;
    let cfg = env_root(&c, "config").await;
    // A resource without a tree, with a word only it has.
    let loose = c.probe("test.reach", "resources.create", json!([{ "kind": "loose", "name": "Loose quokka" }])).await;
    let loose = loose["ok"]["id"].as_str().expect("created").to_string();
    // A plugin's stored tree is in.
    let pin = c.probe("test.reach", "resources.create", json!([{ "kind": "pin", "name": "Pinned quokka" }])).await;
    let pin = pin["ok"]["id"].as_str().expect("created").to_string();
    let item = create(&c, "test.alpha:item", None, json!({ "name": "Plain quokka" })).await;

    let all = search(&c, "test.reach", json!({ "limit": 500 })).await;
    let got = ids(&all);
    for (id, want) in [(&env, false), (&cfg, false), (&loose, false), (&pin, true), (&item, true)] {
        assert_eq!(got.contains(id), want, "{id}");
    }
    assert!(all["ok"]["items"].as_array().unwrap().iter().all(|i| ["resources", "test.reach:shelf"].contains(&i["tree"].as_str().unwrap())));
    // Not by text, not by id, not by kind.
    let mut q = ids(&search(&c, "test.reach", json!({ "text": "quokka" })).await);
    q.sort();
    let mut want = vec![pin.clone(), item.clone()];
    want.sort();
    assert_eq!(q, want);
    assert_eq!(ids(&search(&c, "test.reach", json!({ "ids": [env, cfg, loose, pin] })).await), vec![pin.clone()]);
    assert_eq!(search(&c, "test.reach", json!({ "kinds": ["core:env", "core:config", "test.reach:loose"] })).await["ok"]["total"], 0);

    // Supplied children of a resourcesAll plugin: the same boundary.
    let hub = create(&c, "test.reach:hub", None, json!({ "body.items": [env, cfg, pin, item] })).await;
    let t: Vec<Value> = kids(&c, &hub).await.iter().map(|n| n["target"].clone()).collect();
    assert_eq!(t, vec![Value::Null, Value::Null, json!(format!("resource:{pin}")), json!(format!("resource:{item}"))]);
    // A loose resource of another plugin is never a target; its own still is (as before).
    let hub2 = create(&c, "test.reach:hub", None, json!({ "body.items": [loose] })).await;
    assert_eq!(kids(&c, &hub2).await[0]["target"], json!(format!("resource:{loose}")));
}
