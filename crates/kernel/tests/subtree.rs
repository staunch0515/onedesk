//! D487 §13 (docs/redesign/book.md): the general abilities a plugin that arranges other resources needs — the subtree
//! below a resource (K-a), what another resource shows embedded (K-b) with arguments (K-e), a kind that places what
//! comes into it (K-c), the `sequence` view node (K-d), interfaces anchored on several kinds, called by plugin and
//! outside runs (K-f), and a stored file written to a granted folder (K-g). Temporary folders only; generic packages.

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

/// Has `resources`, `contents` and `files`; `shelf` places what comes in by the node's name; `card` embeds its
/// arguments; `seq` draws sequences, broken by `body.mode`.
const BINDER: &str = r#"
export default {
  activate(host) {
    host.commands.handle("probe", probe);
    host.kinds.handle("shelf", {
      async place(ctx, ask) {
        const n = ask.node.name;
        if (n === "nope") return { refuse: { "en-US": "No room" } };
        if (n === "hang") { await ctx.host.util.sleep(3000); return { before: null }; }
        if (n === "bad") return 42;
        if (n === "write") { await ctx.host.resources.update(ctx.resource.id, { "body.x": 1 }); return { before: null }; }
        if (n.startsWith("first")) {
          const kids = await ctx.host.resources.tree(ctx.resource.id, { limit: 1 });
          const top = kids.nodes.find((k) => k.depth === 1 && k.id !== ask.node.id);
          return { before: top ? top.id : null };
        }
        return { before: ask.before };
      },
    });
    host.kinds.handle("card", {
      embed(ctx, ask) { return { view: [{ type: "text", id: "t", text: JSON.stringify({ args: ask.args || null, section: ask.section }) }] }; },
    });
    host.pages.handle("seq", {
      render(ctx) {
        const b = ctx.resource.body || {};
        const items = (b.items || []).map((r, i) => ({ key: "k" + i, title: "Item " + i, level: 1, resource: r, args: { n: i } }));
        const node = { type: "sequence", id: "s", items, toc: true, mode: "pages", start: "k0", positionEvent: "position" };
        if (b.mode === "level0") items[0].level = 0;
        if (b.mode === "dupKey") items.push({ key: "k0", title: "again", level: 1 });
        if (b.mode === "bigArgs") items[0].args = { x: "y".repeat(5000) };
        if (b.mode === "viewEvent") node.positionEvent = "view.x";
        if (b.mode === "unknown") items[0].color = "red";
        if (b.mode === "many") { node.items = []; for (let i = 0; i < 20001; i++) node.items.push({ key: "k" + i, title: "t", level: 1 }); }
        return { view: [node] };
      },
      onEvent(ctx, event) { return { message: { "en-US": event + "@" + ctx.row } }; },
    });
  },
};
"#;

/// Implements `test.part/1` anchored on `leaf` and `twig`: `who` says what it was called for; `touch` writes.
const PART: &str = r#"
export default {
  activate(host) {
    host.commands.handle("probe", probe);
    host.actions.handle("who", async (ctx, input) => ({ output: { type: "none" }, data: { kind: ctx.resource ? ctx.resource.kind : null, input, run: ctx.runId || null } }));
    host.actions.handle("touch", async (ctx) => {
      await ctx.host.resources.update(ctx.resource.id, { "body.x": 1 });
      return { output: { type: "none" }, data: "wrote" };
    });
  },
};
"#;

const BLIND: &str = r#"
export default { activate(host) { host.commands.handle("probe", probe); } };
"#;

fn write_pkg(root: &Path, id: &str, extra: Value, contributes: Value, main: &str) {
    let pkg = root.join(id).join("0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let mut m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js", "contributes": contributes });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), format!("{PROBE}\n{main}")).unwrap();
}

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    let probe = json!({ "id": "probe", "label": "probe", "icon": "box" });
    write_pkg(
        &root,
        "test.binder",
        json!({ "requires": { "resources": true, "contents": true, "files": true }, "uses": ["test.part/1"] }),
        json!({
            "kinds": [
                { "id": "shelf", "label": "shelf", "icon": "box", "tree": "resources", "draggable": true, "accepts": ["*"], "place": true },
                { "id": "card", "label": "card", "icon": "box", "tree": "resources", "draggable": true, "embed": true,
                  "fields": { "image": { "type": "attachment", "accept": ["image"] } } },
                { "id": "seq", "label": "seq", "icon": "box", "tree": "resources", "draggable": true, "page": "seq" }
            ],
            "pages": [ { "id": "seq" } ],
            "commands": [probe]
        }),
        BINDER,
    );
    let a = |id: &str| json!({ "id": id, "label": id, "output": "none" });
    write_pkg(
        &root,
        "test.part",
        json!({ "implements": { "test.part/1": { "actions": ["who", "touch"], "kind": "leaf", "kinds": ["twig"] } },
                "exports": { "actions": ["who", "touch"] } }),
        json!({
            "kinds": [
                { "id": "leaf", "label": "leaf", "icon": "leaf", "tree": "resources", "draggable": true },
                { "id": "twig", "label": "twig", "icon": "leaf", "tree": "resources", "draggable": true },
                { "id": "stone", "label": "stone", "icon": "box", "tree": "resources", "draggable": true, "accepts": ["*"] }
            ],
            "actions": [a("who"), a("touch")],
            "commands": [probe]
        }),
        PART,
    );
    write_pkg(&root, "test.blind", json!({ "uses": ["test.part/1"] }), json!({ "commands": [probe] }), BLIND);
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

async fn create(c: &Client, kind: &str, parent: Option<&str>, changes: Value) -> String {
    let target = match parent {
        Some(p) => format!("new:{kind}?parent={p}"),
        None => format!("new:{kind}"),
    };
    let r = c.ok("page.save", json!({ "target": target, "changes": changes })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn names(c: &Client, parent: &str) -> Vec<String> {
    let k = c.ok("tree.children", json!({ "tree": "resources", "parent": parent })).await;
    k["nodes"].as_array().unwrap().iter().map(|n| n["label"].as_str().unwrap().to_string()).collect()
}

fn mv(key: &str, target: &str, position: &str) -> Value {
    json!({ "tree": "resources", "key": key, "target": target, "position": position })
}

/* ------------------------------------------------------------------ K-a */

#[tokio::test(flavor = "multi_thread")]
async fn the_subtree_comes_in_tree_order_with_depth_and_revision_in_pages() {
    let (_env, c) = world().await;
    let top = create(&c, "test.part:stone", None, json!({ "name": "Top" })).await;
    let a = create(&c, "test.part:stone", Some(&top), json!({ "name": "A" })).await;
    create(&c, "test.part:stone", Some(&a), json!({ "name": "A1" })).await;
    create(&c, "test.part:stone", Some(&a), json!({ "name": "A2" })).await;
    create(&c, "test.part:stone", Some(&top), json!({ "name": "B" })).await;
    let r = c.probe("test.binder", "resources.tree", json!([top])).await;
    let nodes = r["ok"]["nodes"].as_array().unwrap();
    let got: Vec<(String, u64)> = nodes.iter().map(|n| (n["name"].as_str().unwrap().into(), n["depth"].as_u64().unwrap())).collect();
    assert_eq!(got, vec![("A".into(), 1), ("A1".into(), 2), ("A2".into(), 2), ("B".into(), 1)]);
    assert_eq!(nodes[1]["parent"], json!(a));
    assert!(nodes[0]["rev"].as_i64().unwrap() >= 1 && nodes[0]["icon"].is_string() && nodes[0].get("body").is_none());
    assert!(r["ok"]["next"].is_null());
    // In pages.
    let p1 = c.probe("test.binder", "resources.tree", json!([top, { "limit": 3 }])).await;
    assert_eq!(p1["ok"]["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(p1["ok"]["next"], json!(3));
    let p2 = c.probe("test.binder", "resources.tree", json!([top, { "offset": 3, "limit": 3 }])).await;
    assert_eq!(p2["ok"]["nodes"][0]["name"], "B");
    assert!(p2["ok"]["next"].is_null());
    // Without `requires.resources`.
    let e = c.probe("test.blind", "resources.tree", json!([top])).await;
    assert_eq!(e["error"], "denied");
    assert_eq!(e["params"]["reason"], "notRequested");
}

/* ------------------------------------------------------------------ K-b, K-e */

#[tokio::test(flavor = "multi_thread")]
async fn another_resources_embed_view_is_read_with_contents_and_arguments_reach_the_kind() {
    let (_env, c) = world().await;
    let card = create(&c, "test.binder:card", None, json!({ "name": "Card" })).await;
    let r = c.probe("test.binder", "resources.embed", json!([card, { "section": "S", "args": { "n": 7 } }])).await;
    let text = r["ok"]["view"][0]["text"].as_str().unwrap();
    assert_eq!(serde_json::from_str::<Value>(text).unwrap(), json!({ "args": { "n": 7 }, "section": "S" }));
    assert_eq!(r["ok"]["name"], "Card");
    // The interface asks the same way.
    let r = c.ok("resource.embed", json!({ "id": card, "args": { "k": "v" } })).await;
    assert!(r["view"][0]["text"].as_str().unwrap().contains("\"k\":\"v\""));
    let e = c.call("resource.embed", json!({ "id": card, "args": { "x": "y".repeat(5000) } })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidParams);
    // Without `requires.contents`.
    let e = c.probe("test.blind", "resources.embed", json!([card])).await;
    assert_eq!(e["params"]["reason"], "notRequested");
    // A permission of its own, listed for the user.
    let p = c.ok("plugin.get", json!({ "plugin": "test.binder" })).await;
    assert!(p["permissions"].as_array().unwrap().iter().any(|x| x["id"] == "contents"), "{p}");
    let p = c.ok("plugin.get", json!({ "plugin": "test.blind" })).await;
    assert!(!p["permissions"].as_array().unwrap().iter().any(|x| x["id"] == "contents"));
}

/* ------------------------------------------------------------------ K-c */

#[tokio::test(flavor = "multi_thread")]
async fn a_kind_that_places_decides_where_moved_and_new_nodes_land_or_refuses() {
    let (_env, c) = world().await;
    let shelf = create(&c, "test.binder:shelf", None, json!({ "name": "Shelf" })).await;
    let a = create(&c, "test.part:stone", Some(&shelf), json!({ "name": "a" })).await;
    let b = create(&c, "test.part:stone", Some(&shelf), json!({ "name": "b" })).await;
    assert_eq!(names(&c, &shelf).await, ["a", "b"]);
    // Made in it: "first…" goes first (asked before, moved after).
    create(&c, "test.part:stone", Some(&shelf), json!({ "name": "first new" })).await;
    assert_eq!(names(&c, &shelf).await, ["first new", "a", "b"]);
    // Moved into it, to the end: the kind puts it first; one move, audited once.
    let loose = create(&c, "test.part:stone", None, json!({ "name": "first moved" })).await;
    let before = c.ok("audit.list", json!({ "operation": "resource.move" })).await.as_array().unwrap().len();
    c.ok("tree.move", mv(&loose, &shelf, "inside")).await;
    assert_eq!(names(&c, &shelf).await, ["first moved", "first new", "a", "b"]);
    let after = c.ok("audit.list", json!({ "operation": "resource.move" })).await.as_array().unwrap().len();
    assert_eq!(after, before + 1);
    // An ordinary one keeps the place asked for (before/after a sibling).
    let o = create(&c, "test.part:stone", None, json!({ "name": "o" })).await;
    c.ok("tree.move", mv(&o, &b, "before")).await;
    assert_eq!(names(&c, &shelf).await, ["first moved", "first new", "a", "o", "b"]);
    c.ok("tree.move", mv(&o, &a, "after")).await;
    assert_eq!(names(&c, &shelf).await, ["first moved", "first new", "a", "o", "b"]);
    // A refusal: nothing moves; the kind's message comes back. Made in it: an error with the message.
    let nope = create(&c, "test.part:stone", None, json!({ "name": "nope" })).await;
    let r = c.ok("tree.move", mv(&nope, &shelf, "inside")).await;
    assert_eq!(r["handled"], true);
    assert_eq!(r["message"]["en-US"], "No room");
    assert!(!names(&c, &shelf).await.contains(&"nope".to_string()));
    let e = c.call("page.save", json!({ "target": format!("new:test.part:stone?parent={shelf}"), "changes": { "name": "nope" } })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Invalid);
    assert_eq!(e.params.get("reason").map(String::as_str), Some("refused"));
    assert_eq!(e.params.get("message").map(String::as_str), Some("No room"));
    // Too slow, broken, or writing (a pure computation): the place asked for.
    for n in ["hang", "bad", "write"] {
        let x = create(&c, "test.part:stone", None, json!({ "name": n })).await;
        c.ok("tree.move", mv(&x, &shelf, "inside")).await;
        assert_eq!(names(&c, &shelf).await.last().map(String::as_str), Some(n), "{n}");
    }
    let s = c.ok("resource.get", json!({ "id": shelf })).await;
    assert!(s["body"].get("x").is_none(), "a placement writes nothing");
    let _ = b;
}

#[test]
fn place_needs_a_tree_and_implements_kinds_must_be_its_own() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("p");
    let k = |extra: Value| {
        let mut d = json!({ "id": "x", "label": "x", "icon": "box" });
        for (a, b) in extra.as_object().unwrap() {
            d[a] = b.clone();
        }
        json!({ "kinds": [d], "actions": [{ "id": "a", "label": "a", "output": "none" }] })
    };
    write_pkg(&root, "test.p1", json!({}), k(json!({ "place": true })), BLIND);
    write_pkg(&root, "test.p2", json!({}), k(json!({ "tree": "resources", "place": "yes" })), BLIND);
    let imp = |kinds: Value| json!({ "implements": { "t.i/1": { "actions": ["a"], "kind": "x", "kinds": kinds } }, "exports": { "actions": ["a"] } });
    write_pkg(&root, "test.p3", imp(json!(["y"])), k(json!({ "tree": "resources" })), BLIND);
    write_pkg(&root, "test.p4", imp(json!(["x"])), k(json!({ "tree": "resources" })), BLIND);
    write_pkg(&root, "test.p5", imp(json!([])), k(json!({ "tree": "resources", "place": true })), BLIND);
    let reg = onedesk_kernel::manifest::Registry::scan(&root);
    let why = |id: &str| reg.rejected().into_iter().find(|r| r.path.to_string_lossy().contains(id)).map(|r| r.reason);
    assert_eq!(why("test.p1").as_deref(), Some("placeWithoutTree"));
    assert_eq!(why("test.p2").as_deref(), Some("schema"));
    assert_eq!(why("test.p3").as_deref(), Some("badImplements"));
    assert_eq!(why("test.p4").as_deref(), Some("badImplements"), "the anchor kind twice");
    assert_eq!(why("test.p5"), None);
}

/* ------------------------------------------------------------------ K-d */

#[tokio::test(flavor = "multi_thread")]
async fn a_sequence_is_checked_and_items_whose_resource_is_gone_keep_only_their_title() {
    let (_env, c) = world().await;
    let card = create(&c, "test.binder:card", None, json!({ "name": "Card" })).await;
    let gone = create(&c, "test.binder:card", None, json!({ "name": "Gone" })).await;
    c.ok("resource.delete", json!({ "id": gone })).await;
    let seq = create(&c, "test.binder:seq", None, json!({ "name": "S", "body.items": [card, gone] })).await;
    let p = c.ok("page.resolve", json!({ "target": format!("resource:{seq}"), "context": {} })).await;
    let node = &p["view"][0];
    assert_eq!(node["type"], "sequence");
    assert_eq!(node["mode"], "pages");
    assert_eq!(node["positionEvent"], "position");
    assert_eq!(node["items"][0]["resource"], json!(card));
    assert_eq!(node["items"][0]["args"], json!({ "n": 0 }));
    assert!(node["items"][1].get("resource").is_none(), "{node}");
    // The position event carries the item's key.
    let r = c.ok("page.event", json!({ "target": format!("resource:{seq}"), "event": "position", "context": { "row": "k1" } })).await;
    assert!(r.to_string().contains("position@k1"), "{r}");
    for mode in ["level0", "dupKey", "bigArgs", "viewEvent", "unknown", "many"] {
        // Written by the plugin itself (saving through the page would draw the broken page first).
        let w = c.probe("test.binder", "resources.update", json!([seq, { "body.mode": mode }])).await;
        assert!(w.get("ok").is_some(), "{w}");
        let e = c.call("page.resolve", json!({ "target": format!("resource:{seq}"), "context": {} })).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::PluginError, "{mode}");
    }
}

/* ------------------------------------------------------------------ K-f */

#[tokio::test(flavor = "multi_thread")]
async fn an_interface_is_reached_by_any_of_its_kinds_or_by_plugin_and_outside_a_run_only_computes() {
    let (_env, c) = world().await;
    let leaf = create(&c, "test.part:leaf", None, json!({ "name": "L" })).await;
    let twig = create(&c, "test.part:twig", None, json!({ "name": "T" })).await;
    let stone = create(&c, "test.part:stone", None, json!({ "name": "S" })).await;
    let call = |res: Value| json!(["test.part/1", "who", { "q": 1 }, res]);
    let r = c.probe("test.binder", "interfaces.call", call(json!({ "resource": twig }))).await;
    assert_eq!(r["ok"]["data"]["kind"], "test.part:twig", "{r}");
    assert_eq!(r["ok"]["data"]["input"], json!({ "q": 1 }));
    assert!(r["ok"]["data"]["run"].is_null(), "outside a run");
    let r = c.probe("test.binder", "interfaces.call", call(json!({ "resource": leaf }))).await;
    assert_eq!(r["ok"]["data"]["kind"], "test.part:leaf");
    // A kind it does not anchor on.
    let r = c.probe("test.binder", "interfaces.call", call(json!({ "resource": stone }))).await;
    assert_eq!(r["params"]["reason"], "wrongInterface");
    // By plugin.
    let r = c.probe("test.binder", "interfaces.call", call(json!({ "plugin": "test.part" }))).await;
    assert!(r["ok"]["data"]["kind"].is_null(), "{r}");
    let r = c.probe("test.binder", "interfaces.call", call(json!({ "plugin": "test.nobody" }))).await;
    assert_eq!(r["params"]["reason"], "noImplementation");
    // Outside a run the callee may not write.
    let r = c.probe("test.binder", "interfaces.call", json!(["test.part/1", "touch", {}, { "resource": leaf }])).await;
    assert_eq!(r["params"]["reason"], "pureCall", "{r}");
    assert!(c.ok("resource.get", json!({ "id": leaf })).await["body"].get("x").is_none());
    // The kinds are listed with the implementer.
    let l = c.probe("test.binder", "interfaces.list", json!(["test.part/1"])).await;
    assert_eq!(l["ok"][0]["plugin"], "test.part");
}

/* ------------------------------------------------------------------ K-g */

#[tokio::test(flavor = "multi_thread")]
async fn a_used_blob_is_written_to_a_granted_folder_never_over_a_file() {
    let (env, c) = world().await;
    let folder = env.path().join("out");
    std::fs::create_dir_all(&folder).unwrap();
    c.ok("plugin.grantFolder", json!({ "plugin": "test.binder", "path": folder.display().to_string() })).await;
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    png.extend(4u32.to_be_bytes());
    png.extend(4u32.to_be_bytes());
    png.extend([8, 6, 0, 0, 0, 9]);
    let put = c.call_as(Some("one"), "blob.put", json!({ "data": onedesk_kernel::secrets::base64(&png) })).await.unwrap();
    let blob = put["blob"].as_str().unwrap().to_string();
    // Not used by any resource yet.
    let target = folder.join("a.png").display().to_string();
    let e = c.probe("test.binder", "files.writeBlob", json!([blob, target])).await;
    assert_eq!(e["params"]["reason"], "unknownBlob", "{e}");
    create(&c, "test.binder:card", None, json!({ "name": "C", "body.image": { "blob": blob, "name": "a.png", "type": "image/png", "size": png.len() } })).await;
    let r = c.probe("test.binder", "files.writeBlob", json!([blob, target])).await;
    assert!(r["ok"]["path"].as_str().unwrap().ends_with("a.png"), "{r}");
    assert_eq!(std::fs::read(folder.join("a.png")).unwrap(), png);
    // Never over an existing file; never outside the granted folder.
    let e = c.probe("test.binder", "files.writeBlob", json!([blob, target])).await;
    assert_eq!(e["error"], "conflict", "{e}");
    let outside = env.path().join("elsewhere.png").display().to_string();
    let e = c.probe("test.binder", "files.writeBlob", json!([blob, outside])).await;
    assert!(e["error"].is_string() && e.get("ok").is_none(), "{e}");
    // Without an extension: the image's own is added.
    let r = c.probe("test.binder", "files.writeBlob", json!([blob, folder.join("b").display().to_string()])).await;
    assert!(r["ok"]["path"].as_str().unwrap().ends_with("b.png"), "{r}");
    // Without `files`.
    let e = c.probe("test.blind", "files.writeBlob", json!([blob, target])).await;
    assert_eq!(e["params"]["reason"], "notRequested");
}
