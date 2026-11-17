//! Round 11 (docs/handoff/round11-plan.md §3–§4, §7): language plugins (`i18n.languages`,
//! `i18n.shell`, the `languages` topic), `host.ui.openExternal`, `text.format`, startup pages and
//! standalone `page:` targets, `legacyKinds`. Every plugin is generated into a temporary folder.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::*;
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
const tryIt = async (f) => { try { await f(); return "ok"; } catch (e) { return (e.params || {}).reason || e.code || String(e); } };
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

/// A language plugin: no code, one shell file per language.
fn lang(root: &Path, id: &str, langs: &[(&str, &str, &str)]) -> PathBuf {
    let list: Vec<Value> = langs.iter().map(|(l, n, _)| json!({ "locale": l, "name": n, "shell": format!("shell/{l}.json") })).collect();
    let dir = pkg(root, id, "0.1.0", json!({ "contributes": { "languages": list } }), "export default {};");
    std::fs::create_dir_all(dir.join("shell")).unwrap();
    for (l, _, body) in langs {
        std::fs::write(dir.join(format!("shell/{l}.json")), body).unwrap();
    }
    dir
}

struct W {
    env: Env,
    c: Client,
    root: PathBuf,
}

async fn world(build: impl FnOnce(&Path)) -> W {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    build(&root);
    let env = open_in(tmp, &root);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    W { env, c, root }
}

fn db(env: &Env) -> Connection {
    Connection::open(env.kernel.db_path()).unwrap()
}

fn audit(env: &Env, op: &str) -> Vec<(String, String, String, String)> {
    let conn = db(env);
    let mut st = conn.prepare("SELECT actor, object, summary, result FROM audit WHERE op = ?1 ORDER BY seq").unwrap();
    st.query_map([op], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(|r| r.unwrap()).collect()
}

async fn set_enabled(c: &Client, id: &str, on: bool) {
    let cmd = if on { "plugin.enable" } else { "plugin.disable" };
    c.ok("command.execute", json!({ "id": cmd, "context": { "args": { "plugin": id } } })).await;
}

async fn locales(c: &Client) -> Vec<(String, Option<String>)> {
    let l = c.ok("i18n.languages", json!({})).await;
    l.as_array()
        .unwrap()
        .iter()
        .map(|x| (x["locale"].as_str().unwrap().to_string(), x["plugin"].as_str().map(String::from)))
        .collect()
}

fn pair(l: &str, p: Option<&str>) -> (String, Option<String>) {
    (l.to_string(), p.map(String::from))
}

async fn wait_run(c: &Client, id: &Value) -> Value {
    for _ in 0..500 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {id} did not end");
}

/* ------------------------------------------------------------------ §3 languages */

fn three_language_plugins(r: &Path) {
    lang(r, "t.lang.b", &[("zh-CN", "简体中文 B", r#"{ "a": "甲B" }"#), ("ja-JP", "日本語", r#"{ "a": "あ", "b": "い" }"#)]);
    lang(r, "t.lang.a", &[("zh-CN", "简体中文", r#"{ "a": "甲", "status.ready": "就绪 {name}" }"#)]);
    // A plugin cannot replace the shell's English.
    lang(r, "t.lang.c", &[("en-US", "Other English", r#"{ "a": "x" }"#), ("de-DE", "Deutsch", "{}")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn languages_are_listed_english_first_then_by_locale_and_the_smaller_plugin_id_wins() {
    let w = world(three_language_plugins).await;
    let l = w.c.ok("i18n.languages", Value::Null).await;
    assert_eq!(l[0], json!({ "locale": "en-US", "name": "English" }), "no plugin on the shell's own language");
    assert_eq!(
        locales(&w.c).await,
        vec![pair("en-US", None), pair("de-DE", Some("t.lang.c")), pair("ja-JP", Some("t.lang.b")), pair("zh-CN", Some("t.lang.a"))]
    );
    assert_eq!(l[3]["name"], "简体中文");
    // Reading languages and their texts starts no plugin.
    w.c.ok("i18n.shell", json!({ "locale": "zh-CN" })).await;
    w.c.ok("i18n.shell", json!({ "locale": "ja-JP" })).await;
    assert_eq!(w.env.kernel.activation_count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn disabling_enabling_and_removing_change_the_languages_and_publish_the_topic() {
    let w = world(three_language_plugins).await;
    // Disabling the winner of zh-CN hands it to the other plugin.
    set_enabled(&w.c, "t.lang.a", false).await;
    w.c.event(|e| e.topic == "languages").await;
    let l = locales(&w.c).await;
    assert!(l.contains(&pair("zh-CN", Some("t.lang.b"))), "{l:?}");
    assert_eq!(w.c.ok("i18n.shell", json!({ "locale": "zh-CN" })).await["texts"], json!({ "a": "甲B" }));
    // Disabling the only provider of a language removes it.
    set_enabled(&w.c, "t.lang.c", false).await;
    w.c.event(|e| e.topic == "languages").await;
    assert!(!locales(&w.c).await.iter().any(|(l, _)| l == "de-DE"));
    assert_eq!(w.c.ok("i18n.shell", json!({ "locale": "de-DE" })).await["texts"], json!({}));
    set_enabled(&w.c, "t.lang.a", true).await;
    w.c.event(|e| e.topic == "languages").await;
    assert!(locales(&w.c).await.contains(&pair("zh-CN", Some("t.lang.a"))));
    // Removing a package.
    std::fs::remove_dir_all(w.root.join("t.lang.b")).unwrap();
    w.c.ok("plugin.rescan", Value::Null).await;
    w.c.event(|e| e.topic == "languages").await;
    assert_eq!(locales(&w.c).await, vec![pair("en-US", None), pair("zh-CN", Some("t.lang.a"))]);
    // Installing one.
    lang(&w.root, "t.lang.d", &[("fr-FR", "Français", r#"{ "a": "à" }"#)]);
    w.c.ok("plugin.rescan", json!({ "builtin": ["t.lang.d@0.1.0"] })).await;
    w.c.event(|e| e.topic == "languages").await;
    assert!(locales(&w.c).await.contains(&pair("fr-FR", Some("t.lang.d"))));
    assert_eq!(w.env.kernel.activation_count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_languages_topic_is_not_sent_when_nothing_about_languages_changed() {
    let w = world(|r| {
        three_language_plugins(r);
        pkg(r, "t.plain", "0.1.0", json!({ "contributes": { "commands": [{ "id": "probe", "label": "probe" }] } }), "export default { activate(host) { host.commands.handle(\"probe\", probe); } };");
    })
    .await;
    // A plugin without languages: `plugins` but no `languages`.
    set_enabled(&w.c, "t.plain", false).await;
    w.c.event(|e| e.topic == "plugins").await;
    set_enabled(&w.c, "t.lang.c", false).await;
    // The next `languages` is the one for t.lang.c (none for t.plain came before it).
    w.c.event(|e| e.topic == "languages").await;
    assert!(!locales(&w.c).await.iter().any(|(l, _)| l == "de-DE"));
}

#[tokio::test(flavor = "multi_thread")]
async fn shell_texts_are_the_file_or_an_empty_table() {
    let w = world(|r| {
        three_language_plugins(r);
        let big = format!("{{ \"k\": \"{}\" }}", "x".repeat(1024 * 1024));
        lang(r, "t.lang.big", &[("ko-KR", "한국어", &big)]);
        lang(r, "t.lang.nested", &[("it-IT", "Italiano", r#"{ "a": { "b": "c" } }"#)]);
        lang(r, "t.lang.list", &[("pt-BR", "Português", r#"["a"]"#)]);
        lang(r, "t.lang.num", &[("es-ES", "Español", r#"{ "a": 1 }"#)]);
        lang(r, "t.lang.broken", &[("nl-NL", "Nederlands", "{ not json")]);
    })
    .await;
    let zh = w.c.ok("i18n.shell", json!({ "locale": "zh-CN" })).await;
    assert_eq!(zh, json!({ "locale": "zh-CN", "texts": { "a": "甲", "status.ready": "就绪 {name}" } }));
    for l in ["en-US", "xx-YY", "ko-KR", "it-IT", "pt-BR", "es-ES", "nl-NL"] {
        let r = w.c.ok("i18n.shell", json!({ "locale": l })).await;
        assert_eq!(r["texts"], json!({}), "{l}");
        assert_eq!(r["locale"], l);
    }
    // Such files still list their language (the file is only read when asked for).
    assert!(locales(&w.c).await.iter().any(|(l, _)| l == "ko-KR"));
    // A file replaced after loading is read as it is now.
    std::fs::write(w.root.join("t.lang.a/0.1.0/shell/zh-CN.json"), r#"{ "a": "新" }"#).unwrap();
    assert_eq!(w.c.ok("i18n.shell", json!({ "locale": "zh-CN" })).await["texts"], json!({ "a": "新" }));
    assert!(w.c.call("i18n.shell", json!({})).await.is_err(), "locale is required");
    assert_eq!(w.env.kernel.activation_count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn ui_language_is_a_known_parameter() {
    let w = world(|_| {}).await;
    let known = w.c.ok("params.known", Value::Null).await;
    let p = known.as_array().unwrap().iter().find(|p| p["name"] == "ui.language").expect("ui.language known").clone();
    assert_eq!((p["type"].clone(), p["layers"].clone()), (json!("text"), json!(["config"])));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bad_languages_declaration_keeps_the_package_out() {
    let w = world(|r| {
        let d = pkg(r, "t.lang.bad", "0.1.0", json!({ "contributes": { "languages": [{ "locale": "zh-CN", "name": "x", "shell": "../x.json" }] } }), "export default {};");
        std::fs::write(d.join("x.json"), "{}").unwrap();
    })
    .await;
    assert_eq!(locales(&w.c).await, vec![pair("en-US", None)]);
    let d = w.c.ok("plugin.get", json!({ "plugin": "t.lang.bad" })).await;
    assert_eq!(d["load"]["message"], "badLanguages");
}

/* ------------------------------------------------------------------ §4 openExternal */

fn web_manifest() -> Value {
    json!({
        "legacyKinds": ["link", "old-link"],
        "contributes": {
            "kinds": [{ "id": "x", "label": "X", "icon": "box", "tree": "resources", "page": "ed" }],
            "pages": [{ "id": "ed" }, { "id": "home", "startup": true, "actions": [{ "id": "go", "role": "run", "label": "Go", "action": "open" }] }],
            "actions": [{ "id": "open", "label": "Open", "output": "text" }],
            "commands": [{ "id": "probe", "label": "probe" }],
            "events": ["resource.changed"]
        }
    })
}

const WEB_MAIN: &str = r##"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("open", async (ctx, input) => ({ output: { type: "text", text: await tryIt(() => ctx.host.ui.openExternal(input.url)) } }));
  host.pages.handle("ed", { async render() { return { view: [] }; } });
  host.pages.handle("home", {
    async render(ctx) {
      const p = ctx.params || {};
      if (p.fmt) return { view: [{ type: "text", id: "t", text: "# hi", format: p.fmt }] };
      const r = await tryIt(() => ctx.host.ui.openExternal("https://example.com/from-render"));
      return { title: "Home", view: [{ type: "text", id: "t", text: r, format: "markdown" }] };
    },
    async onEvent(ctx, e) { return { message: await tryIt(() => ctx.host.ui.openExternal(e)) }; },
  });
  host.events.on("resource.changed", async (ctx) => {
    await ctx.host.storage.set("ev", await tryIt(() => ctx.host.ui.openExternal("https://example.com/from-event")));
  });
} };
"##;

async fn web_world() -> W {
    world(|r| {
        pkg(r, "t.web", "0.1.0", web_manifest(), WEB_MAIN);
    })
    .await
}

async fn run_open(c: &Client, url: &str) -> String {
    let id = c.ok("run.start", json!({ "action": "t.web:open", "target": "core:none", "tabId": "t", "input": { "url": url } })).await;
    let r = wait_run(c, &id).await;
    r["output"]["text"].as_str().unwrap_or_else(|| panic!("{r}")).to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn open_external_in_a_run_publishes_the_effect_and_audits_only_the_host() {
    let w = web_world().await;
    assert_eq!(run_open(&w.c, "https://Example.com/secret/path?q=token#frag").await, "ok");
    let e = w.c.event(|e| e.topic == "ui" && e.payload.as_ref().is_some_and(|p| p["type"] == "openExternal")).await;
    assert_eq!(e.payload.unwrap()["url"], "https://example.com/secret/path?q=token#frag");
    assert_eq!(run_open(&w.c, "http://a.test:8080/x").await, "ok");
    assert_eq!(run_open(&w.c, "mailto:Someone@Mail.Example.org?subject=hello").await, "ok");
    let rows = audit(&w.env, "ui.openExternal");
    let objects: Vec<&str> = rows.iter().map(|r| r.1.as_str()).collect();
    assert_eq!(objects, vec!["example.com", "a.test", "mail.example.org"]);
    for (actor, object, summary, result) in &rows {
        assert_eq!((actor.as_str(), result.as_str()), ("plugin:t.web@0.1.0", "ok"), "{object}");
        for leak in ["secret", "path", "token", "someone", "hello", "/x"] {
            assert!(!summary.contains(leak) && !object.contains(leak), "{object} {summary}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn open_external_refuses_other_schemes_and_long_addresses() {
    let w = web_world().await;
    let long = format!("https://example.com/{}", "a".repeat(2048));
    for bad in ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "example.com", "", "https://", "mailto:", long.as_str()] {
        assert_eq!(run_open(&w.c, bad).await, "badUrl", "{bad}");
    }
    let edge = format!("https://example.com/{}", "a".repeat(2048 - "https://example.com/".len()));
    assert_eq!(run_open(&w.c, &edge).await, "ok", "2048 characters are allowed");
    assert_eq!(audit(&w.env, "ui.openExternal").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn open_external_only_where_the_user_just_acted() {
    let w = web_world().await;
    // Page event: allowed.
    let ev = w.c.ok("page.event", json!({ "target": "page:t.web/home", "event": "https://example.com/ev" })).await;
    assert_eq!(ev["message"], "ok");
    // Render: refused (and the refusal is audited by host only).
    let page = w.c.ok("page.resolve", json!({ "target": "page:t.web/home" })).await;
    assert_eq!(page["view"][0]["text"], "notInteractive");
    // A command (no run, no page event): refused.
    let r = w.c.probe("t.web", "ui.openExternal", json!(["https://example.com/cmd"])).await;
    assert_eq!((r["error"].clone(), r["params"]["reason"].clone()), (json!("denied"), json!("notInteractive")));
    // An event handler: refused.
    w.c.ok("page.save", json!({ "target": "new:t.web:x", "changes": { "name": "n" } })).await;
    let mut got = Value::Null;
    for _ in 0..250 {
        got = w.c.probe("t.web", "storage.get", json!(["ev"])).await["ok"].clone();
        if !got.is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(got, "notInteractive");
    let rows = audit(&w.env, "ui.openExternal");
    let refused: Vec<&str> = rows.iter().filter(|r| r.3 != "ok").map(|r| r.1.as_str()).collect();
    assert_eq!(refused, vec!["example.com"; 3], "{rows:?}");
    assert!(rows.iter().all(|r| !r.1.contains('/') && !r.2.contains("from-") && !r.2.contains("cmd")), "{rows:?}");
    assert_eq!(rows.iter().filter(|r| r.3 == "ok").count(), 1, "only the page event opened");
}

/* ------------------------------------------------------------------ §4 text.format, startup, page: */

#[tokio::test(flavor = "multi_thread")]
async fn text_nodes_take_plain_or_markdown_only() {
    let w = web_world().await;
    for f in ["plain", "markdown"] {
        let page = w.c.ok("page.resolve", json!({ "target": "page:t.web/home", "context": { "params": { "fmt": f } } })).await;
        assert_eq!(page["view"][0]["format"], f);
    }
    let page = w.c.ok("page.resolve", json!({ "target": "page:t.web/home" })).await;
    assert_eq!(page["view"][0]["format"], "markdown");
    let e = w.c.call("page.resolve", json!({ "target": "page:t.web/home", "context": { "params": { "fmt": "html" } } })).await.unwrap_err();
    assert_eq!(serde_json::to_value(e.code).unwrap(), "pluginError", "{e:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_pages_follow_enabling_and_resolve_as_standalone_pages() {
    let w = world(|r| {
        pkg(r, "t.web", "0.1.0", web_manifest(), WEB_MAIN);
        pkg(r, "t.aaa", "0.1.0", json!({ "contributes": { "pages": [{ "id": "hello", "startup": true }, { "id": "other" }] } }),
            "export default { activate(host) { host.pages.handle(\"hello\", { async render() { return { view: [] }; } }); } };");
        pkg(r, "t.none", "0.1.0", json!({ "contributes": { "pages": [{ "id": "p" }] } }), "export default {};");
    })
    .await;
    let info = w.c.ok("workspace.info", Value::Null).await;
    assert_eq!(info["startupPages"], json!(["page:t.aaa/hello", "page:t.web/home"]));
    let hello = w.c.ok("hello", json!({ "protocol": onedesk_protocol::PROTOCOL_VERSION })).await;
    assert_eq!(hello["workspace"]["startupPages"], info["startupPages"]);
    set_enabled(&w.c, "t.web", false).await;
    assert_eq!(w.c.ok("workspace.info", Value::Null).await["startupPages"], json!(["page:t.aaa/hello"]));
    let off = w.c.ok("page.resolve", json!({ "target": "page:t.web/home" })).await;
    assert_eq!((off["state"].clone(), off["found"].clone()), (json!("disabled"), json!(false)));
    set_enabled(&w.c, "t.web", true).await;
    assert_eq!(w.c.ok("workspace.info", Value::Null).await["startupPages"], json!(["page:t.aaa/hello", "page:t.web/home"]));
    // The standalone page: title, icon, actions of its declaration.
    let home = w.c.ok("page.resolve", json!({ "target": "page:t.web/home" })).await;
    assert_eq!((home["found"].clone(), home["page"].clone(), home["title"].clone()), (json!(true), json!("view"), json!("Home")));
    assert_eq!(home["actions"][0]["id"], "go");
    let plain = w.c.ok("page.resolve", json!({ "target": "page:t.aaa/hello" })).await;
    assert_eq!((plain["title"].clone(), plain["icon"].clone()), (json!("t.aaa name"), json!("box")));
    // A kind's page, an unknown page or plugin is not a standalone page.
    for t in ["page:t.web/ed", "page:t.web/nope", "page:t.nobody/home", "page:t.web", "page:t.web/home/x"] {
        assert_eq!(w.c.ok("page.resolve", json!({ "target": t })).await["found"], false, "{t}");
    }
    // A run item of the standalone page runs its action.
    let id = w.c.ok("run.start", json!({ "action": "go", "target": "page:t.web/home", "tabId": "t", "input": { "url": "https://example.com" } })).await;
    assert_eq!(wait_run(&w.c, &id).await["output"]["text"], "ok");
}

/* ------------------------------------------------------------------ legacyKinds */

#[tokio::test(flavor = "multi_thread")]
async fn legacy_kinds_are_shown_in_the_plugin_detail() {
    let w = world(|r| {
        pkg(r, "t.web", "0.1.0", web_manifest(), WEB_MAIN);
        pkg(r, "t.none", "0.1.0", json!({}), "export default {};");
        pkg(r, "t.bad", "0.1.0", json!({ "legacyKinds": ["a:b"] }), "export default {};");
    })
    .await;
    assert_eq!(w.c.ok("plugin.get", json!({ "plugin": "t.web" })).await["legacyKinds"], json!(["link", "old-link"]));
    assert_eq!(w.c.ok("plugin.get", json!({ "plugin": "t.none" })).await["legacyKinds"], json!([]));
    let bad = w.c.ok("plugin.get", json!({ "plugin": "t.bad" })).await;
    assert_eq!((bad["load"]["message"].clone(), bad["legacyKinds"].clone()), (json!("badLegacyKinds"), json!([])));
    // Not taken over this round: nothing in the database names them.
    let n: i64 = db(&w.env).query_row("SELECT count(*) FROM resources WHERE kind IN ('link', 'old-link')", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

/* ------------------------------------------------------------------ review fixes (round11-review.md #2, #4, #5) */

/// #2: the 2048 limit is on the normalized address (non-ASCII is percent-encoded, IDN hosts punycode).
#[tokio::test(flavor = "multi_thread")]
async fn open_external_limits_the_normalized_length_of_non_ascii_addresses() {
    let w = web_world().await;
    assert_eq!(run_open(&w.c, "https://例子.测试/路径?q=值").await, "ok");
    let e = w.c.event(|e| e.topic == "ui" && e.payload.as_ref().is_some_and(|p| p["type"] == "openExternal")).await;
    let url = e.payload.unwrap()["url"].as_str().unwrap().to_string();
    assert!(url.is_ascii() && url.starts_with("https://xn--"), "{url}");
    assert!(url.contains("%E8%B7%AF"), "{url}");
    assert_eq!(audit(&w.env, "ui.openExternal")[0].1, "xn--fsqu00a.xn--0zwm56d");
    // "https://example.com/" is 20 characters; each 中 becomes 9 (`%E4%B8%AD`).
    let fits = format!("https://example.com/{}", "中".repeat(225)); // 2045 once encoded
    let over = format!("https://example.com/{}", "中".repeat(228)); // 248 characters as written, 2072 encoded
    assert!(over.chars().count() < 2048);
    assert_eq!(run_open(&w.c, &fits).await, "ok");
    assert_eq!(run_open(&w.c, &over).await, "badUrl");
    assert_eq!(audit(&w.env, "ui.openExternal").iter().filter(|r| r.3 == "ok").count(), 2, "the refused one is not audited as opened");
}

fn many_manifest() -> Value {
    let mut m = web_manifest();
    m["contributes"]["actions"] = json!([{ "id": "open", "label": "Open", "output": "text" }, { "id": "many", "label": "Many", "output": "text" }]);
    m
}

const MANY_MAIN: &str = r##"
const seven = async (ctx, bad) => {
  const out = [];
  if (bad) out.push(await tryIt(() => ctx.host.ui.openExternal("ftp://nope")));
  for (let i = 0; i < 7; i++) out.push(await tryIt(() => ctx.host.ui.openExternal("https://example.com/" + i)));
  return out.join(",");
};
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.actions.handle("open", async (ctx, input) => ({ output: { type: "text", text: await tryIt(() => ctx.host.ui.openExternal(input.url)) } }));
  host.actions.handle("many", async (ctx) => ({ output: { type: "text", text: await seven(ctx, true) } }));
  host.pages.handle("ed", { async render() { return { view: [] }; } });
  host.pages.handle("home", { async render() { return { view: [] }; }, async onEvent(ctx) { return { message: await seven(ctx, false) }; } });
} };
"##;

/// #5 (D386): at most five per invocation; each run or page event starts again.
#[tokio::test(flavor = "multi_thread")]
async fn open_external_at_most_five_times_per_invocation() {
    let w = world(|r| {
        pkg(r, "t.web", "0.1.0", many_manifest(), MANY_MAIN);
    })
    .await;
    let five_then_refused = "ok,ok,ok,ok,ok,tooMany,tooMany";
    for _ in 0..2 {
        let id = w.c.ok("run.start", json!({ "action": "t.web:many", "target": "core:none", "tabId": "t" })).await;
        // An invalid address does not use up one of the five.
        assert_eq!(wait_run(&w.c, &id).await["output"]["text"], format!("badUrl,{five_then_refused}"));
    }
    let ev = w.c.ok("page.event", json!({ "target": "page:t.web/home", "event": "x" })).await;
    assert_eq!(ev["message"], five_then_refused);
    let rows = audit(&w.env, "ui.openExternal");
    assert_eq!(rows.iter().filter(|r| r.3 == "ok").count(), 15);
    assert_eq!(rows.iter().filter(|r| r.3 != "ok").count(), 6, "the refusals are audited: {rows:?}");
    // Another run after all that still may open.
    assert_eq!(run_open(&w.c, "https://example.com/again").await, "ok");
}

/// #4: `migrate` and tree handlers may not open addresses.
#[tokio::test(flavor = "multi_thread")]
async fn open_external_is_refused_in_migrate_and_tree_handlers() {
    let mig = |v: &str| {
        json!({
            "upgradesFrom": ">=0.1.0",
            "contributes": {
                "kinds": [{ "id": "doc", "label": "k", "icon": "file", "tree": "resources", "page": "p" }],
                "pages": [{ "id": "p" }],
                "trees": [{ "id": "t", "label": "t", "icon": "box", "source": "provided" }],
                "commands": [{ "id": "probe", "label": "probe" }]
            },
            "version": v
        })
    };
    const MIG_MAIN: &str = r##"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.pages.handle("p", { async render() { return { view: [] }; } });
  host.trees.handle("t", { async children(ctx) {
    return { nodes: [{ key: "k", label: await tryIt(() => ctx.host.ui.openExternal("https://example.com/tree")), icon: "box" }] };
  } });
  host.kinds.handle("doc", { async migrate(body, from, ctx) {
    return { ...body, opened: await tryIt(() => ctx.host.ui.openExternal("https://example.com/migrate")) };
  } });
} };
"##;
    let w = world(|r| {
        pkg(r, "t.mig", "0.1.0", mig("0.1.0"), MIG_MAIN);
    })
    .await;
    let tree = w.c.ok("tree.children", json!({ "tree": "t.mig:t" })).await;
    assert_eq!(tree["nodes"][0]["label"], "notInteractive", "{tree}");
    let id = w.c.ok("page.save", json!({ "target": "new:t.mig:doc", "changes": { "name": "d" } })).await["page"]["resourceId"].as_str().unwrap().to_string();
    // A new version with the same permissions: the main process confirms it (built-in), the
    // kernel switches and takes the resource over with `migrate`.
    pkg(&w.root, "t.mig", "0.2.0", mig("0.2.0"), MIG_MAIN);
    w.c.ok("plugin.rescan", json!({ "builtin": ["t.mig@0.2.0"] })).await;
    let r = w.c.ok("resource.get", json!({ "id": id })).await;
    assert_eq!(r["pluginVersion"], "0.2.0", "{r}");
    assert_eq!(r["body"]["opened"], "pureCall");
    assert!(audit(&w.env, "ui.openExternal").iter().all(|r| r.3 != "ok"));
}

fn lang_at(root: &Path, id: &str, version: &str, langs: &[(&str, &str, &str)]) {
    let list: Vec<Value> = langs.iter().map(|(l, n, _)| json!({ "locale": l, "name": n, "shell": format!("shell/{l}.json") })).collect();
    let dir = pkg(root, id, version, json!({ "contributes": { "languages": list } }), "export default {};");
    std::fs::create_dir_all(dir.join("shell")).unwrap();
    for (l, _, body) in langs {
        std::fs::write(dir.join(format!("shell/{l}.json")), body).unwrap();
    }
}

/// #4: switching a language plugin's version changes the languages and publishes the topic.
#[tokio::test(flavor = "multi_thread")]
async fn switching_a_language_plugins_version_publishes_languages() {
    let w = world(|r| lang_at(r, "t.lang.v", "0.1.0", &[("zh-CN", "简体中文", r#"{ "a": "一" }"#)])).await;
    assert_eq!(locales(&w.c).await, vec![pair("en-US", None), pair("zh-CN", Some("t.lang.v"))]);
    lang_at(&w.root, "t.lang.v", "0.2.0", &[("ja-JP", "日本語", r#"{ "a": "二" }"#)]);
    w.c.ok("plugin.rescan", json!({ "builtin": ["t.lang.v@0.2.0"] })).await;
    w.c.event(|e| e.topic == "languages").await;
    assert_eq!(locales(&w.c).await, vec![pair("en-US", None), pair("ja-JP", Some("t.lang.v"))]);
    assert_eq!(w.c.ok("i18n.shell", json!({ "locale": "ja-JP" })).await["texts"], json!({ "a": "二" }));
    // Back to the old version by hand.
    w.c.ok("plugin.activateVersion", json!({ "plugin": "t.lang.v", "version": "0.1.0" })).await;
    w.c.event(|e| e.topic == "languages").await;
    assert_eq!(locales(&w.c).await, vec![pair("en-US", None), pair("zh-CN", Some("t.lang.v"))]);
    assert_eq!(w.env.kernel.activation_count(), 0);
}
