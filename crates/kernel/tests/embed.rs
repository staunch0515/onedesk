//! D481 (docs/redesign/embed-book.md §3): `![[name]]` / `![[name#section]]` — references that show the other
//! resource's content. The reference table knows which are embeds and their sections; `resource.embed` asks the
//! embedded kind's plugin for its read-only view. Temporary folders only; plugins here are generic test packages.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use onedesk_protocol::ErrorCode;
use serde_json::{json, Value};

/// `doc` has a text with references and an embed view: the section from `## <section>` to the next `## `, filled
/// from the environment's `who`. `body.mode` breaks the answer.
const DOCS: &str = r###"
export default {
  activate(host) {
    host.pages.handle("doc", { render() { return { view: [{ type: "form", id: "f", layout: "stack",
      fields: [{ name: "text", label: "Text", kind: "longtext", bind: "body.text" }] }] }; } });
    host.kinds.handle("doc", {
      async embed(ctx, ask) {
        const b = ctx.resource.body;
        if (b.mode === "form") return { view: [{ type: "form", id: "x", layout: "stack", fields: [] }] };
        if (b.mode === "extra") return { view: [], other: 1 };
        let text = String(b.text || "");
        if (ask.section) {
          const at = text.indexOf("## " + ask.section);
          if (at < 0) return { view: [], sectionMissing: true };
          const rest = text.slice(at);
          const next = rest.indexOf("\n## ", 1);
          text = next < 0 ? rest : rest.slice(0, next);
        }
        const who = await ctx.host.params.get("who");
        if (who && who.found) text = text.split("{{who}}").join(who.value);
        return { view: [{ type: "text", id: "e", text, format: "markdown" }] };
      },
    });
  },
};
"###;

/// The writing-help provider: reads pages for its conversation (`pages.fields`).
const HELPER: &str = r#"
export default {
  activate(host) {
    host.commands.handle("openChat", () => []);
    host.actions.handle("go", () => ({ output: { type: "text", text: "x" } }));
    host.commands.handle("probe", async (ctx, context) => {
      const r = await ctx.host.pages.fields(...context.args.args);
      return [{ type: "copy", text: JSON.stringify({ ok: r }) }];
    });
  },
};
"#;

/// Registers an embed view for a kind that does not declare it: activation fails.
const UNDECLARED: &str = r#"
export default { activate(host) { host.kinds.handle("plain", { embed() { return { view: [] }; } }); host.commands.handle("ping", () => []); } };
"#;

fn write_pkg(root: &Path, id: &str, kinds: Value, pages: Value, main: &str) {
    let pkg = root.join(id).join("0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js",
        "contributes": { "kinds": kinds, "pages": pages } });
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), main).unwrap();
}

fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    let text = json!({ "text": { "type": "longtext", "refs": true } });
    write_pkg(
        &root,
        "test.docs",
        json!([
            { "id": "doc", "label": "doc", "icon": "file-text", "tree": "resources", "page": "doc", "fields": text, "embed": true },
            { "id": "card", "label": "card", "icon": "box", "tree": "resources", "fields": text }
        ]),
        json!([{ "id": "doc" }]),
        DOCS,
    );
    write_pkg(&root, "test.undeclared", json!([{ "id": "plain", "label": "plain", "icon": "box", "tree": "resources" }]), json!([]), UNDECLARED);
    let pkg = root.join("test.helper/0.1.0");
    std::fs::create_dir_all(&pkg).unwrap();
    let m = json!({ "id": "test.helper", "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js",
        "requires": { "resources": true }, "exports": { "actions": ["go"] },
        "implements": { "onedesk.assist/2": { "actions": ["go"] } },
        "contributes": { "actions": [{ "id": "go", "label": "go", "output": "text" }],
            "commands": [{ "id": "openChat", "label": "c", "icon": "box" }, { "id": "probe", "label": "p", "icon": "box" }] } });
    std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(pkg.join("main.js"), HELPER).unwrap();
    let m = root.join("test.undeclared/0.1.0/manifest.json");
    let mut v: Value = serde_json::from_slice(&std::fs::read(&m).unwrap()).unwrap();
    v["contributes"]["commands"] = json!([{ "id": "ping", "label": "ping", "icon": "box" }]);
    std::fs::write(&m, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
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

async fn create(c: &Client, kind: &str, changes: Value) -> String {
    let r = c.ok("page.save", json!({ "target": format!("new:{kind}"), "changes": changes })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

const LAW: &str = "# Law\n\n## Art 35\nThirty-five.\n\n## Art 36\nEight hours for {{who}}.\n\n## Art 37\nThirty-seven.";

#[tokio::test(flavor = "multi_thread")]
async fn the_reference_table_knows_embeds_and_sections() {
    let (_env, c) = world().await;
    let law = create(&c, "test.docs:doc", json!({ "name": "Law", "body.text": LAW })).await;
    let contract = create(&c, "test.docs:doc", json!({ "name": "Contract", "body.text": "See [[Law]].\n\n![[Law#Art 36]]\n" })).await;
    let out = c.ok("refs.outgoing", json!({ "id": contract })).await;
    let rows = out.as_array().unwrap();
    assert_eq!(rows.len(), 2, "{out}");
    assert_eq!((rows[0]["text"].as_str(), rows[0].get("embed"), rows[0].get("section")), (Some("Law"), None, None));
    assert_eq!((rows[1]["text"].as_str(), rows[1]["embed"].as_bool(), rows[1]["section"].as_str()), (Some("Law#Art 36"), Some(true), Some("Art 36")));
    assert_eq!(rows[1]["target"]["id"], law);
    let inc = c.ok("refs.incoming", json!({ "id": law })).await;
    assert!(inc.as_array().unwrap().iter().any(|r| r["embed"] == json!(true) && r["section"] == "Art 36"), "{inc}");
    // A rename shows the new name and keeps the section; the reference still points there.
    c.ok("page.save", json!({ "target": format!("resource:{law}"), "changes": { "name": "Labour Law" } })).await;
    let shown = c.ok("resource.get", json!({ "id": contract })).await;
    assert!(shown["body"]["text"].as_str().unwrap().contains("![[Labour Law#Art 36]]"), "{shown}");
    // Written before its target exists: connected when a resource gets the name.
    let early = create(&c, "test.docs:doc", json!({ "name": "Early", "body.text": "![[Later#Part]]" })).await;
    let later = create(&c, "test.docs:doc", json!({ "name": "Later", "body.text": "## Part\nx" })).await;
    let out = c.ok("refs.outgoing", json!({ "id": early })).await;
    assert_eq!(out[0]["target"]["id"], later, "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_embedded_plugin_draws_its_section_in_the_tab_s_environment() {
    let (_env, c) = world().await;
    let law = create(&c, "test.docs:doc", json!({ "name": "Law", "body.text": LAW })).await;
    let e = c.ok("resource.embed", json!({ "id": law, "section": "Art 36" })).await;
    assert_eq!((e["name"].as_str(), e["icon"].as_str()), (Some("Law"), Some("file-text")), "{e}");
    let text = e["view"][0]["text"].as_str().unwrap();
    assert!(text.starts_with("## Art 36") && !text.contains("Art 37") && text.contains("{{who}}"), "{text}");
    // The tab's environment fills the template.
    let env = c.ok("tree.children", json!({ "tree": "env" })).await["nodes"][0]["key"].as_str().unwrap().to_string();
    c.ok("params.set", json!({ "node": env, "name": "who", "value": "drivers" })).await;
    let e = c.ok("resource.embed", json!({ "id": law, "section": "Art 36", "envId": env })).await;
    assert!(e["view"][0]["text"].as_str().unwrap().contains("Eight hours for drivers"), "{e}");
    // A section that is not there.
    let e = c.ok("resource.embed", json!({ "id": law, "section": "Art 99" })).await;
    assert_eq!(e["sectionMissing"], json!(true), "{e}");
    // A kind without an embed view: only what the card needs.
    let card = create(&c, "test.docs:card", json!({ "name": "Card", "description": "A card" })).await;
    let e = c.ok("resource.embed", json!({ "id": card })).await;
    assert!(e.get("view").is_none(), "{e}");
    assert_eq!(e["description"], "A card");
    // The view is read only and checked.
    for mode in ["form", "extra"] {
        let bad = create(&c, "test.docs:doc", json!({ "name": mode, "body.mode": mode })).await;
        let err = c.call("resource.embed", json!({ "id": bad })).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::PluginError, "{mode}: {err:?}");
    }
    // Gone: not found.
    c.ok("resource.delete", json!({ "id": card })).await;
    let err = c.call("resource.embed", json!({ "id": card })).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_embed_view_must_be_declared() {
    let (_env, c) = world().await;
    let e = c.call("command.execute", json!({ "id": "test.undeclared:ping" })).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::PluginError, "{e:?}");
    assert!(format!("{e:?}").contains("undeclared embed"), "{e:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_writing_help_reads_what_the_embeds_show_and_the_text_as_written() {
    let (_env, c) = world().await;
    let law = create(&c, "test.docs:doc", json!({ "name": "Law", "body.text": LAW })).await;
    let secret = create(&c, "test.docs:doc", json!({ "name": "Hidden", "body.text": "## X\nHIDDEN-MARKER" })).await;
    let contract = create(&c, "test.docs:doc", json!({ "name": "Contract", "body.text": "Intro\n![[Law#Art 36]]\n![[Hidden#X]]" })).await;
    for id in [&law, &contract] {
        c.ok("resource.setAiVisible", json!({ "id": id, "visible": true })).await;
    }
    let target = format!("resource:{contract}");
    let effects = c.ok("command.execute", json!({ "id": "test.helper:probe", "context": { "args": { "args": [target] } } })).await;
    let r: Value = serde_json::from_str(effects[0]["text"].as_str().unwrap()).unwrap();
    let field = r["ok"]["fields"].as_array().unwrap().iter().find(|f| f["name"] == "body.text").unwrap().clone();
    assert_eq!(field["value"], "Intro\n![[Law#Art 36]]\n![[Hidden#X]]", "{field}");
    let embeds = field["embeds"].as_array().unwrap();
    assert_eq!(embeds.len(), 1, "only what AI may see: {field}");
    assert_eq!((embeds[0]["mark"].as_str(), embeds[0]["section"].as_str()), (Some("![[Law#Art 36]]"), Some("Art 36")));
    assert!(embeds[0]["text"].as_str().unwrap().contains("Eight hours"), "{field}");
    assert!(!field.to_string().contains("HIDDEN-MARKER"));
    let _ = secret;
}

/* ------------------------------------------------------------------ D482: precise references */

async fn group(c: &Client, name: &str) -> String {
    c.ok("tree.createGroup", json!({ "tree": "resources", "name": name })).await["key"].as_str().unwrap().to_string()
}

async fn doc_in(c: &Client, parent: &str, name: &str, text: &str) -> String {
    let r = c.ok("page.save", json!({ "target": format!("new:test.docs:doc?parent={parent}"), "changes": { "name": name, "body.text": text } })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn outgoing(c: &Client, id: &str) -> Vec<Value> {
    c.ok("refs.outgoing", json!({ "id": id })).await.as_array().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_path_says_which_of_two_namesakes_is_meant_and_namesakes_are_flagged() {
    let (_env, c) = world().await;
    let a = group(&c, "Book A").await;
    let b = group(&c, "Book B").await;
    let ch_a = doc_in(&c, &a, "Chapter 1", "## S\na").await;
    let ch_b = doc_in(&c, &b, "Chapter 1", "## S\nb").await;
    let src = create(&c, "test.docs:doc", json!({ "name": "Reader", "body.text": "![[Book B/Chapter 1#S]]\n\n[[Chapter 1]]\n\n[[Book A/Chapter 1]]" })).await;
    let refs = outgoing(&c, &src).await;
    assert_eq!(refs[0]["target"]["id"], ch_b, "{refs:?}");
    assert_eq!(refs[0].get("ambiguous"), None);
    assert_eq!(refs[1]["ambiguous"], json!(2), "a bare name meaning two: {refs:?}");
    assert_eq!(refs[2]["target"]["id"], ch_a);
    // The embedded content is the one the path says.
    let e = c.ok("resource.embed", json!({ "id": ch_b, "section": "S" })).await;
    assert_eq!(e["path"], json!(["Book B"]), "{e}");
    // The page marks the field where references are written.
    let page = c.ok("page.resolve", json!({ "target": format!("resource:{src}") })).await;
    assert_eq!(page["view"][0]["fields"][0]["refs"], json!(true), "{page}");
}

#[tokio::test(flavor = "multi_thread")]
async fn suggestions_rank_by_name_and_give_the_shortest_unique_writing() {
    let (_env, c) = world().await;
    let a = group(&c, "Book A").await;
    let b = group(&c, "Book B").await;
    doc_in(&c, &a, "Chapter 1", "").await;
    doc_in(&c, &b, "Chapter 1", "").await;
    create(&c, "test.docs:doc", json!({ "name": "Chapter index" })).await;
    create(&c, "test.docs:doc", json!({ "name": "The chapter list" })).await;
    let s = c.ok("refs.suggest", json!({ "text": "chapter" })).await;
    let rows: Vec<(String, String)> = s.as_array().unwrap().iter().map(|x| (x["name"].as_str().unwrap().into(), x["write"].as_str().unwrap().into())).collect();
    assert_eq!(rows[0].0, "Chapter 1", "{s}");
    assert!(rows.contains(&("Chapter 1".into(), "Book A/Chapter 1".into())) && rows.contains(&("Chapter 1".into(), "Book B/Chapter 1".into())), "{s}");
    assert!(rows.contains(&("Chapter index".into(), "Chapter index".into())), "{s}");
    assert_eq!(rows.last().unwrap().0, "The chapter list", "contains, not starts with: last");
    // A path narrows the list.
    let s = c.ok("refs.suggest", json!({ "text": "Book B/chap" })).await;
    assert_eq!(s.as_array().unwrap().len(), 1, "{s}");
    assert_eq!(s[0]["path"], json!(["Book B"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reference_is_rewritten_to_mean_only_its_target_and_an_outdated_path_is_flagged() {
    let (_env, c) = world().await;
    let a = group(&c, "Book A").await;
    let b = group(&c, "Book B").await;
    let ch_a = doc_in(&c, &a, "Chapter 1", "").await;
    let ch_b = doc_in(&c, &b, "Chapter 1", "").await;
    let src = create(&c, "test.docs:doc", json!({ "name": "Reader", "body.text": "x ![[Chapter 1#S]] y\n\n[[Book B/Chapter 1]]" })).await;
    let before = c.ok("resource.history", json!({ "id": src })).await.as_array().unwrap().len();
    let target = outgoing(&c, &src).await[0]["target"]["id"].clone();
    let r = c.ok("refs.rewrite", json!({ "source": src, "field": "body.text", "seq": 0 })).await;
    let want = if target == json!(ch_a) { "Book A/Chapter 1#S" } else { "Book B/Chapter 1#S" };
    assert_eq!(r["text"], want, "{r}");
    let saved = c.ok("resource.get", json!({ "id": src })).await;
    assert!(saved["body"]["text"].as_str().unwrap().starts_with(&format!("x ![[{want}]] y")), "{saved}");
    assert_eq!(outgoing(&c, &src).await[0]["target"]["id"], target, "the same target");
    assert!(c.ok("resource.history", json!({ "id": src })).await.as_array().unwrap().len() > before, "in the history");
    // A parent renamed: the reference holds; the written path is outdated, and a rewrite brings it up to date.
    c.ok("page.save", json!({ "target": format!("resource:{b}"), "changes": { "name": "Book Two" } })).await;
    let refs = outgoing(&c, &src).await;
    assert_eq!((refs[1]["target"]["id"].clone(), refs[1]["stale"].clone()), (json!(ch_b), json!(true)), "{refs:?}");
    let r = c.ok("refs.rewrite", json!({ "source": src, "field": "body.text", "seq": 1 })).await;
    assert_eq!(r["text"], "Book Two/Chapter 1");
    let after = outgoing(&c, &src).await;
    assert_eq!(after[1].get("stale"), None, "{after:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_path_written_first_waits_for_the_resource_at_that_place() {
    let (_env, c) = world().await;
    let src = create(&c, "test.docs:doc", json!({ "name": "Early", "body.text": "![[Book C/Late]]" })).await;
    let elsewhere = create(&c, "test.docs:doc", json!({ "name": "Late" })).await;
    assert_eq!(outgoing(&c, &src).await[0].get("target"), None, "a Late elsewhere is not it");
    let g = group(&c, "Book C").await;
    let late = doc_in(&c, &g, "Late", "").await;
    assert_eq!(outgoing(&c, &src).await[0]["target"]["id"], late);
    let _ = elsewhere;
}
