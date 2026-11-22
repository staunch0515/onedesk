//! Round 19 (D448): the AI actor (MCP). Every refusal, the rate limit, row and cell cuts,
//! `ai_visible`, the audit, secrets. The plugin is generated into a temporary folder; the kernel
//! knows none of it (names, kinds and tools are what its manifest says).

mod common;

use std::path::Path;
use std::sync::Arc;

use common::*;
use onedesk_protocol::ProtocolError;
use serde_json::{json, Value};

const MAIN: &str = r#"
const table = (n, big) => { const rows = []; for (let i = 0; i < n; i++) rows.push([i, i === 0 && big ? "z".repeat(3000) : "v" + i]);
  return { output: { type: "table", columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }], rows, total: n, truncated: false } }; };
export default { activate(host) {
  host.actions.handle("read", async (ctx) => table(Number(ctx.params.n || 5), !!ctx.params.big));
  host.actions.handle("bigtext", async () => ({ output: { type: "text", text: "t".repeat(70000) } }));
  host.actions.handle("info", async (ctx, input) => ({ output: { type: "text", text: JSON.stringify({ env: ctx.envId, ai: ctx.ai || null, input, params: ctx.params }) } }));
  host.actions.handle("write", async () => ({ output: { type: "text", text: "written" } }));
  host.actions.handle("dyn", async () => ({ output: { type: "none" }, data: { description: "dynamic", params: [{ name: "x", type: "text", required: true, description: "X" }] } }));
  host.actions.handle("dynbad", async () => ({ output: { type: "none" }, data: { params: "nope" } }));
  host.actions.handle("only", async () => ({ output: { type: "text", text: "only" } }));
  host.actions.handle("tool", async (ctx, input) => ({ output: { type: "text", text: JSON.stringify({ echo: input, ai: ctx.ai || null }) } }));
  host.actions.handle("freeq", async () => ({ output: { type: "text", text: "free" } }));
  host.actions.handle("leak", async (ctx, input) => {
    const pw = await ctx.host.secrets.get("pw");
    if (input.boom) throw new Error("bad password " + pw);
    return { output: { type: "table", columns: [{ key: "p", label: "P" }], rows: [["pw=" + pw]], total: 1, truncated: false } };
  });
  host.actions.handle("probe", async (ctx, input) => {
    const out = {};
    const t = async (k, f) => { try { await f(); out[k] = "ok"; } catch (e) { out[k] = (e.params && e.params.reason) || e.code || String(e); } };
    await t("create", () => ctx.host.resources.create({ kind: "query", name: "made" }));
    await t("update", () => ctx.host.resources.update(ctx.resource.id, { name: "renamed" }));
    await t("open", () => ctx.host.ui.openExternal("https://example.invalid/"));
    await t("notify", () => ctx.host.ui.notify("hello"));
    await t("secret", () => ctx.host.secrets.get("pw"));
    await t("storage", () => ctx.host.storage.set("k", "v"));
    await t("post", () => ctx.host.network.request({ url: "http://127.0.0.1:1/", method: "POST", body: "x" }));
    await t("upload", () => ctx.host.transfer.upload({ url: "http://127.0.0.1:1/", from: "x" }));
    await t("download", () => ctx.host.transfer.download({ url: "http://127.0.0.1:1/", to: "tmp/x" }));
    await t("captureAbs", () => ctx.host.transfer.capture({ program: "x", to: "/tmp/x" }));
    await t("captureUp", () => ctx.host.transfer.capture({ program: "x", to: "tmp/../../x" }));
    await t("captureOwn", () => ctx.host.transfer.capture({ program: "x", to: "tmp/x.csv" }));
    await t("list", async () => { out.listed = (await ctx.host.resources.list({ kind: "query" })).map((r) => r.name).sort(); });
    await t("get", async () => { out.got = ctx.params.other ? (await ctx.host.resources.get(ctx.params.other)) !== null : null; });
    return { output: { type: "text", text: JSON.stringify(out) } };
  });
  host.actions.handle("dynlong", async () => ({ output: { type: "none" }, data: { description: "D".repeat(5000),
    params: [{ name: "x", type: "text", required: false, description: "d".repeat(5000), junk: "z" }] } }));
  host.actions.handle("fail", async () => { throw new Error("nope: " + "q".repeat(900)); });
} };
"#;

fn manifest() -> Value {
    let ai = |extra: Value| {
        let mut v = json!({ "readOnly": true });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    };
    json!({
        "id": "t.ai", "version": "0.1.0", "apiVersion": "2", "name": "t.ai", "icon": "box", "main": "main.js",
        "requires": { "secrets": { "names": ["pw"], "plaintext": true } },
        "contributes": {
            "locales": { "en-US": "locales/en-US.json" },
            "kinds": [
                { "id": "query", "label": "Query", "icon": "box", "tree": "resources", "newName": "q" },
                { "id": "single", "label": "Single", "icon": "box", "tree": "resources", "newName": "s" }
            ],
            "actions": [
                { "id": "read", "label": "Read", "output": "table", "kinds": ["query"],
                  "ai": ai(json!({ "description": "d.read", "params": [
                      { "name": "n", "type": "number", "required": false },
                      { "name": "mode", "type": "enum", "options": ["a", "b"] },
                      { "name": "big", "type": "text" }] })) },
                { "id": "bigtext", "label": "Big", "output": "text", "kinds": ["query"], "ai": ai(json!({})) },
                { "id": "info", "label": "Info", "output": "text", "kinds": ["query"], "ai": ai(json!({})) },
                { "id": "leak", "label": "Leak", "output": "table", "kinds": ["query"], "ai": ai(json!({})) },
                { "id": "probe", "label": "Probe", "output": "text", "kinds": ["query"], "ai": ai(json!({ "params": [{ "name": "other", "type": "text" }] })) },
                { "id": "readLong", "label": "Long", "output": "text", "kinds": ["query"], "ai": ai(json!({ "describe": "dynlong" })) },
                { "id": "dynlong", "label": "d", "output": "none", "kinds": ["query"] },
                { "id": "fail", "label": "Fail", "output": "text", "kinds": ["query"], "ai": ai(json!({})) },
                { "id": "write", "label": "Write", "output": "text", "kinds": ["query"] },
                { "id": "readDyn", "label": "Dyn", "output": "text", "kinds": ["query"], "ai": ai(json!({ "describe": "dyn" })) },
                { "id": "readBad", "label": "Bad", "output": "text", "kinds": ["query"], "ai": ai(json!({ "describe": "dynbad" })) },
                { "id": "dyn", "label": "d", "output": "none", "kinds": ["query"] },
                { "id": "dynbad", "label": "d", "output": "none", "kinds": ["query"] },
                { "id": "only", "label": "Only", "output": "text", "kinds": ["single"], "ai": ai(json!({})) },
                { "id": "tool", "label": "Tool", "output": "text", "ai": ai(json!({})) },
                { "id": "freeq", "label": "Free", "output": "text", "ai": ai(json!({})) }
            ],
            "aiTools": [
                { "name": "lookup", "description": "tool.lookup", "action": "tool",
                  "inputSchema": { "type": "object", "properties": { "text": { "type": "string", "maxLength": 20 }, "n": { "type": "integer", "minimum": 1 } },
                                   "required": ["text"], "additionalProperties": false } },
                { "name": "free", "description": "tool.free", "action": "freeq", "freeQuery": true,
                  "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } }
            ]
        }
    })
}

fn write_pkg(root: &Path, id: &str, m: &Value, main: &str) {
    let dir = root.join(id).join("0.1.0");
    std::fs::create_dir_all(dir.join("locales")).unwrap();
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(m).unwrap()).unwrap();
    std::fs::write(dir.join("main.js"), main).unwrap();
    std::fs::write(dir.join("locales/en-US.json"), r#"{ "tool.lookup": "Looks things up", "d.read": "Reads rows" }"#).unwrap();
}

async fn world_with(cfg_edit: impl FnOnce(&mut onedesk_kernel::KernelConfig), policy: &[(&str, &str)]) -> (Env, Client) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();
    write_pkg(&root, "t.ai", &manifest(), MAIN);
    let mut cfg = config_for(&root);
    cfg_edit(&mut cfg);
    let env = open_exact(tmp, &root, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    for (k, v) in policy {
        c.ok("workspace.setConfig", json!({ "name": k, "value": v })).await;
    }
    (env, c)
}

async fn world(policy: &[(&str, &str)]) -> (Env, Client) {
    world_with(|_| {}, policy).await
}

const ON: (&str, &str) = ("mcp.enabled", "true");

fn code(e: &ProtocolError) -> String {
    let c = serde_json::to_value(e.code).unwrap();
    format!("{}/{}", c.as_str().unwrap(), e.params.get("reason").map(String::as_str).unwrap_or(""))
}

const CLIENT: &str = "tester";

async fn call(c: &Client, name: &str, args: Value) -> Result<Value, ProtocolError> {
    c.call_ai(CLIENT, "mcp.call", json!({ "name": name, "arguments": args })).await.map(|v| v["content"].clone())
}

async fn call_ok(c: &Client, name: &str, args: Value) -> Value {
    call(c, name, args.clone()).await.unwrap_or_else(|e| panic!("{name} {args} failed: {e:?}"))
}

async fn call_err(c: &Client, name: &str, args: Value) -> String {
    match call(c, name, args.clone()).await {
        Ok(v) => panic!("{name} {args} should fail, got {v}"),
        Err(e) => code(&e),
    }
}

async fn make(c: &Client, kind: &str, name: &str, description: &str, tags: Option<Value>) -> String {
    let mut ch = json!({ "name": name, "description": description });
    if let Some(t) = tags {
        ch["tags"] = t;
    }
    let r = c.ok("page.save", json!({ "target": format!("new:t.ai:{kind}"), "changes": ch })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

async fn visible(c: &Client, id: &str, v: bool) {
    c.ok("resource.setAiVisible", json!({ "id": id, "visible": v })).await;
}

fn db(env: &Env) -> rusqlite::Connection {
    rusqlite::Connection::open(env.kernel.db_path()).unwrap()
}

fn audit(env: &Env, op: &str) -> Vec<(String, String, Value, String)> {
    let conn = db(env);
    let mut st = conn.prepare("SELECT actor, object, summary, result FROM audit WHERE op = ?1 ORDER BY seq").unwrap();
    st.query_map([op], |r| {
        let s: String = r.get(2)?;
        Ok((r.get(0)?, r.get(1)?, serde_json::from_str(&s).unwrap_or(Value::Null), r.get(3)?))
    })
    .unwrap()
    .map(|r| r.unwrap())
    .collect()
}

fn count(env: &Env, sql: &str) -> i64 {
    db(env).query_row(sql, [], |r| r.get(0)).unwrap()
}

/* ------------------------------------------------------------------ visibility (D448 ①) */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn new_resources_are_hidden_from_ai_and_the_switch_turns_them_on_and_off() {
    let (env, c) = world(&[]).await;
    let a = make(&c, "query", "alpha", "", None).await;
    assert_eq!(c.ok("resource.get", json!({ "id": a })).await["aiVisible"], false);
    assert_eq!(count(&env, "SELECT count(*) FROM resources WHERE ai_visible <> 0"), 0, "the trigger turns every new row off");
    let r = c.ok("resource.setAiVisible", json!({ "id": a, "visible": true })).await;
    assert_eq!(r["changed"], 1);
    assert_eq!(c.ok("resource.get", json!({ "id": a })).await["aiVisible"], true);
    let again = c.ok("resource.setAiVisible", json!({ "id": a, "visible": true })).await;
    assert_eq!(again["changed"], 0, "nothing to change");
    c.ok("resource.setAiVisible", json!({ "id": a, "visible": false })).await;
    assert_eq!(c.ok("resource.get", json!({ "id": a })).await["aiVisible"], false);
    assert!(!audit(&env, "resource.aiVisible").is_empty());
    // Not for what the user does not see in a tree.
    let e = c.call("resource.setAiVisible", json!({ "id": "nope", "visible": true })).await.unwrap_err();
    assert_eq!(code(&e), "notFound/");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_can_be_made_visible_with_everything_below_it() {
    let (_env, c) = world(&[]).await;
    let g = c.ok("tree.createGroup", json!({ "tree": "resources", "name": "G" })).await["key"].as_str().unwrap().to_string();
    let r = c.ok("page.save", json!({ "target": format!("new:t.ai:query?parent={g}"), "changes": { "name": "inner" } })).await;
    let inner = r["page"]["resourceId"].as_str().unwrap().to_string();
    let outer = make(&c, "query", "outer", "", None).await;
    let n = c.ok("resource.setAiVisible", json!({ "id": g, "visible": true, "withChildren": true })).await;
    assert_eq!(n["changed"], 2, "the group and its child");
    assert_eq!(c.ok("resource.get", json!({ "id": inner })).await["aiVisible"], true);
    assert_eq!(c.ok("resource.get", json!({ "id": outer })).await["aiVisible"], false);
}

#[test]
fn migration_0014_turns_existing_rows_off_and_new_rows_too() {
    use rusqlite::Connection;
    let conn = Connection::open_in_memory().unwrap();
    for (i, (_, sql)) in onedesk_kernel::workspace::MIGRATIONS.iter().enumerate() {
        if i == 13 {
            // Before 0014: rows made by the old default are visible.
            conn.execute(
                "INSERT INTO resources (id, kind, name, rev, created_at, created_by, updated_at, updated_by) VALUES ('old', 'k', 'n', 1, 0, 'u', 0, 'u')",
                [],
            )
            .unwrap();
            let v: i64 = conn.query_row("SELECT ai_visible FROM resources WHERE id = 'old'", [], |r| r.get(0)).unwrap();
            assert_eq!(v, 1, "0001's default");
        }
        conn.execute_batch(sql).unwrap();
    }
    let v: i64 = conn.query_row("SELECT ai_visible FROM resources WHERE id = 'old'", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 0);
    conn.execute(
        "INSERT INTO resources (id, kind, name, rev, created_at, created_by, updated_at, updated_by, ai_visible) VALUES ('new', 'k', 'n', 1, 0, 'u', 0, 'u', 1)",
        [],
    )
    .unwrap();
    let v: i64 = conn.query_row("SELECT ai_visible FROM resources WHERE id = 'new'", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 0, "even an insert that asks for 1");
}

/* ------------------------------------------------------------------ the gate */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_switch_is_off_by_default_and_everything_but_status_says_so() {
    let (env, c) = world(&[]).await;
    let st = c.call_ai(CLIENT, "mcp.status", json!({})).await.unwrap();
    assert_eq!((st["enabled"].clone(), st["ratePerMinute"].clone(), st["maxRows"].clone(), st["allowFreeQuery"].clone()), (json!(false), json!(30), json!(200), json!(false)));
    let e = c.call_ai(CLIENT, "mcp.tools", json!({})).await.unwrap_err();
    assert_eq!(code(&e), "denied/aiOff");
    assert_eq!(call_err(&c, "search", json!({ "query": "x" })).await, "denied/aiOff");
    // The refusal is audited (a call that never ran is still a call).
    let rows = audit(&env, "mcp.call");
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].0.as_str(), rows[0].3.as_str()), ("ai:tester", "failed:denied"));
    assert_eq!(rows[0].2["reason"], "aiOff");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_ai_client_may_make_no_request_but_the_few_it_is_given() {
    let (env, c) = world(&[ON]).await;
    let a = make(&c, "query", "alpha", "", None).await;
    visible(&c, &a, true).await;
    let before = count(&env, "SELECT count(*) FROM resources");
    let revs = count(&env, "SELECT count(*) FROM revisions");
    for (m, p) in [
        ("page.save", json!({ "target": "new:t.ai:query", "changes": { "name": "evil" } })),
        ("resource.delete", json!({ "id": a })),
        ("resource.setAiVisible", json!({ "id": a, "visible": false })),
        ("tree.createGroup", json!({ "tree": "resources", "name": "x" })),
        ("tree.move", json!({ "tree": "resources", "key": a })),
        ("workspace.setConfig", json!({ "name": "mcp.enabled", "value": "false" })),
        ("workspace.getConfig", json!({ "name": "mcp.enabled" })),
        ("run.start", json!({ "action": "t.ai:write", "target": format!("resource:{a}"), "tabId": "t" })),
        ("resource.get", json!({ "id": a })),
        ("search.query", json!({ "text": "alpha" })),
        ("plugin.install", json!({})),
        ("secrets.set", json!({ "name": "k", "value": "v" })),
        ("secrets.get", json!({ "name": "k" })),
        ("command.execute", json!({ "id": "node.delete", "context": { "nodeKey": a } })),
        ("audit.list", json!({})),
        ("ui.set", json!({ "key": "k", "value": 1 })),
        ("definitely.not.a.method", json!({})),
    ] {
        let e = c.call_ai(CLIENT, m, p).await.unwrap_err();
        assert_eq!(code(&e), "denied/aiNotAllowed", "{m}");
        assert_eq!(e.params.get("method").map(String::as_str), Some(m));
    }
    assert_eq!(count(&env, "SELECT count(*) FROM resources"), before, "nothing was written");
    assert_eq!(count(&env, "SELECT count(*) FROM revisions"), revs);
    assert_eq!(c.ok("workspace.getConfig", json!({ "name": "mcp.enabled" })).await, json!("true"));
    // D450: what a client can repeat for free is written once a second, with the count.
    let refused = audit(&env, "mcp.refused");
    assert!(refused.len() <= 2, "{}", refused.len());
    assert!(refused.iter().all(|r| r.0 == "ai:tester" && r.3 == "failed:denied"));
    let seen: u64 = refused.iter().map(|r| 1 + r.2["suppressed"].as_u64().unwrap_or(0)).sum();
    assert!(seen <= 17);
    // The count of what was left out comes with the next one written, a second on.
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    c.call_ai(CLIENT, "page.save", json!({})).await.unwrap_err();
    let refused = audit(&env, "mcp.refused");
    let seen: u64 = refused.iter().map(|r| 1 + r.2["suppressed"].as_u64().unwrap_or(0)).sum();
    assert_eq!(seen, 18, "every refusal is counted: {refused:?}");
    // What it may: hello, workspace.info, mcp.status.
    c.call_ai(CLIENT, "hello", json!({ "protocol": onedesk_protocol::PROTOCOL_VERSION })).await.unwrap();
    c.call_ai(CLIENT, "workspace.info", json!({})).await.unwrap();
    c.call_ai(CLIENT, "mcp.status", json!({})).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_writer_itself_refuses_every_command_of_an_ai_actor() {
    use onedesk_kernel::pipeline::{Actor, Changes, Command, NewResource};
    let (env, c) = world(&[ON]).await;
    let a = make(&c, "query", "alpha", "", None).await;
    let ai = || Actor::Ai { client: "x".into() };
    let k = &env.kernel;
    let denied = |r: Result<onedesk_kernel::pipeline::Outcome, ProtocolError>, what: &str| {
        let e = r.expect_err(what);
        assert_eq!(code(&e), "denied/aiReadOnly", "{what}");
    };
    denied(
        k.execute_for_test(ai(), Command::Create(NewResource { kind: "t.ai:query".into(), tree: None, parent: None, name: "n".into(), description: String::new(), tags: vec![], body: Default::default(), plugin_version: None })).await,
        "create",
    );
    denied(k.execute_for_test(ai(), Command::Update { id: a.clone(), changes: Changes { name: Some("z".into()), ..Default::default() }, basis: None, overwrite: vec![] }).await, "update");
    denied(k.execute_for_test(ai(), Command::Delete { id: a.clone() }).await, "delete");
    denied(k.execute_for_test(ai(), Command::Purge { id: a.clone() }).await, "purge");
    denied(k.execute_for_test(ai(), Command::AiVisible { ids: vec![a.clone()], visible: true }).await, "visible");
    denied(k.execute_for_test(ai(), Command::Audit { op: "x".into(), object: String::new(), summary: json!({}) }).await, "audit");
    denied(k.execute_for_test(ai(), Command::PluginState { plugin: "t.ai".into(), set: vec![("enabled".into(), Some("false".into()))] }).await, "plugin state");
    denied(k.execute_for_test(ai(), Command::SecretName { name: "k".into(), present: true, audit: true }).await, "secret name");
    assert_eq!(c.ok("resource.get", json!({ "id": a })).await["name"], "alpha");
    assert_eq!(c.ok("resource.get", json!({ "id": a })).await["aiVisible"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_tools_are_the_ais_alone_and_the_envelope_is_checked() {
    let (_env, c) = world(&[ON]).await;
    let e = c.call("mcp.tools", json!({})).await.unwrap_err();
    assert_eq!(code(&e), "denied/aiOnly");
    let e = c.call("mcp.call", json!({ "name": "search", "arguments": { "query": "x" } })).await.unwrap_err();
    assert_eq!(code(&e), "denied/aiOnly");
    // `actor` that is not an AI is not a way to be the user.
    let id = 9_000;
    let req = onedesk_protocol::Request { id, method: "resource.delete".into(), params: json!({ "id": "x" }), client: None, actor: Some("user".into()) };
    let r = c.raw(serde_json::to_string(&req).unwrap(), id).await;
    assert_eq!(r.error.unwrap().code, onedesk_protocol::ErrorCode::InvalidParams);
    // A status any actor may read.
    c.ok("mcp.status", json!({})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kernel_started_for_ai_takes_every_request_as_the_ais() {
    let (env, c) = world_with(|cfg| cfg.ai_only = Some("headless".into()), &[]).await;
    // `hello` ran in `world_with`; the setConfig calls above were refused, so nothing is on.
    let e = c.call("page.save", json!({ "target": "new:t.ai:query", "changes": { "name": "x" } })).await.unwrap_err();
    assert_eq!(code(&e), "denied/aiNotAllowed");
    let e = c.call("workspace.setConfig", json!({ "name": "mcp.enabled", "value": "true" })).await.unwrap_err();
    assert_eq!(code(&e), "denied/aiNotAllowed");
    assert_eq!(c.ok("mcp.status", json!({})).await["enabled"], false);
    let e = c.call("mcp.tools", json!({})).await.unwrap_err();
    assert_eq!(code(&e), "denied/aiOff", "it is the AI's tools call now");
    assert!(audit(&env, "mcp.refused").iter().all(|r| r.0 == "ai:headless"));
}

/* ------------------------------------------------------------------ tools list */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tools_are_the_four_general_ones_and_the_plugins_with_a_prefix() {
    let (_env, c) = world(&[ON]).await;
    let t = c.call_ai(CLIENT, "mcp.tools", json!({})).await.unwrap();
    let names: Vec<&str> = t.as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["search", "describe", "run", "get_run", "t_ai__lookup"], "the free-query tool is not offered while it is off");
    let lookup = &t[4];
    assert_eq!(lookup["description"], "Looks things up");
    assert_eq!(lookup["inputSchema"]["required"], json!(["text"]));
    for g in &t.as_array().unwrap()[..4] {
        assert_eq!(g["inputSchema"]["type"], "object");
        assert!(g["description"].as_str().unwrap().len() > 10);
    }
    c.ok("workspace.setConfig", json!({ "name": "mcp.allow_free_query", "value": "true" })).await;
    let t = c.call_ai(CLIENT, "mcp.tools", json!({})).await.unwrap();
    assert_eq!(t.as_array().unwrap().len(), 6);
    assert_eq!(t[5]["name"], "t_ai__free");
    assert_eq!(c.ok("mcp.status", json!({})).await["tools"], 6);
}

/* ------------------------------------------------------------------ search */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn search_finds_only_what_the_user_made_visible() {
    let (_env, c) = world(&[ON]).await;
    let shown = make(&c, "query", "orders report", "monthly orders", Some(json!(["sales"]))).await;
    let hidden = make(&c, "query", "orders secret plan", "", None).await;
    let other = make(&c, "single", "orders single", "", None).await;
    let gone = make(&c, "query", "orders deleted", "", None).await;
    for id in [&shown, &other, &gone] {
        visible(&c, id, true).await;
    }
    c.ok("resource.delete", json!({ "id": gone })).await;
    let r = call_ok(&c, "search", json!({ "query": "orders" })).await;
    let ids: Vec<&str> = r["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&shown.as_str()) && ids.contains(&other.as_str()), "{r}");
    assert!(!ids.contains(&hidden.as_str()), "ai_visible = 0 is not found");
    assert!(!ids.contains(&gone.as_str()), "a deleted one neither");
    let first = r["items"].as_array().unwrap().iter().find(|i| i["id"] == json!(shown)).unwrap();
    assert_eq!(first["kind"], "t.ai:query");
    assert_eq!(first["kindLabel"], "Query");
    assert_eq!(first["name"], "orders report");
    assert_eq!(first["description"], "monthly orders");
    assert_eq!(first["tags"], json!(["sales"]));
    // The search finds words in the body of what is visible, not of what is not: the hidden name's words.
    let r = call_ok(&c, "search", json!({ "query": "secret plan" })).await;
    assert!(!r.to_string().contains(&hidden), "{r}");
    // Kinds and limit.
    let r = call_ok(&c, "search", json!({ "query": "orders", "kinds": ["t.ai:single"] })).await;
    assert_eq!(r["items"].as_array().unwrap().len(), 1);
    let r = call_ok(&c, "search", json!({ "query": "orders", "limit": 1 })).await;
    assert_eq!(r["items"].as_array().unwrap().len(), 1);
    assert_eq!(r["total"], 2);
    // Turning it off hides it again.
    visible(&c, &shown, false).await;
    let r = call_ok(&c, "search", json!({ "query": "orders report" })).await;
    assert!(!r.to_string().contains(&shown), "{r}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn search_arguments_are_checked() {
    let (_env, c) = world(&[ON]).await;
    assert_eq!(call_err(&c, "search", json!({})).await, "invalidParams/badArguments");
    assert_eq!(call_err(&c, "search", json!({ "query": "" })).await, "invalidParams/badArguments");
    assert_eq!(call_err(&c, "search", json!({ "query": "x", "limit": 51 })).await, "invalidParams/badArguments");
    assert_eq!(call_err(&c, "search", json!({ "query": "x", "extra": 1 })).await, "invalidParams/badArguments");
    assert_eq!(call_err(&c, "search", json!({ "query": 5 })).await, "invalidParams/badArguments");
    let e = call(&c, "search", json!({ "query": "x", "limit": 0 })).await.unwrap_err();
    assert_eq!((e.params["path"].as_str(), e.params["rule"].as_str()), ("/limit", "minimum"));
    assert_eq!(call_err(&c, "nope", json!({})).await, "notFound/");
}

/* ------------------------------------------------------------------ describe */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn describe_lists_the_ai_actions_with_parameters_and_nothing_else() {
    let (_env, c) = world(&[ON]).await;
    let q = make(&c, "query", "q1", "the first", None).await;
    // The body is the user's, with a connection string in it: never given.
    c.ok("page.save", json!({ "target": format!("resource:{q}"), "changes": { "body.sql": "select 'postgres://u:pw@h/db'" } })).await;
    visible(&c, &q, true).await;
    let d = call_ok(&c, "describe", json!({ "id": q })).await;
    assert_eq!((d["name"].clone(), d["kind"].clone(), d["description"].clone()), (json!("q1"), json!("t.ai:query"), json!("the first")));
    assert!(!d.to_string().contains("postgres"), "the body is not described: {d}");
    let names: Vec<&str> = d["actions"].as_array().unwrap().iter().map(|a| a["action"].as_str().unwrap()).collect();
    assert_eq!(names, ["read", "bigtext", "info", "leak", "probe", "readLong", "fail", "readDyn", "readBad"], "the action without `ai` is not offered");
    let read = &d["actions"][0];
    assert_eq!(read["description"], "Reads rows");
    assert_eq!(read["params"][0], json!({ "name": "n", "type": "number", "required": false }));
    assert_eq!(read["params"][1]["options"], json!(["a", "b"]));
    let dynamic = d["actions"].as_array().unwrap().iter().find(|a| a["action"] == "readDyn").unwrap();
    assert_eq!(dynamic["params"][0]["name"], "x");
    assert_eq!(dynamic["description"], "dynamic");
    let bad = d["actions"].as_array().unwrap().iter().find(|a| a["action"] == "readBad").unwrap();
    assert_eq!(bad["paramsError"], "badOutput", "a bad answer fails that action's parameters only");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn what_is_not_visible_cannot_be_described_or_run_and_looks_like_it_is_not_there() {
    let (_env, c) = world(&[ON]).await;
    let q = make(&c, "query", "q1", "", None).await;
    assert_eq!(call_err(&c, "describe", json!({ "id": q })).await, "notFound/");
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "read" })).await, "notFound/");
    assert_eq!(call_err(&c, "describe", json!({ "id": "no-such-id" })).await, "notFound/", "the same answer as for one that exists");
    // The environment, configuration and plugin-state rows are not resources to it.
    let cfg = c.ok("tree.children", json!({ "tree": "config" })).await;
    let cfg_id = cfg["nodes"][0]["key"].as_str().unwrap().to_string();
    assert_eq!(call_err(&c, "describe", json!({ "id": cfg_id })).await, "notFound/");
    visible(&c, &q, true).await;
    call_ok(&c, "describe", json!({ "id": q })).await;
    c.ok("resource.delete", json!({ "id": q })).await;
    assert_eq!(call_err(&c, "describe", json!({ "id": q })).await, "notFound/", "deleted");
}

/* ------------------------------------------------------------------ run */

async fn table_world(policy: &[(&str, &str)]) -> (Env, Client, String) {
    let mut p = vec![ON];
    p.extend_from_slice(policy);
    let (env, c) = world(&p).await;
    let q = make(&c, "query", "q1", "", None).await;
    visible(&c, &q, true).await;
    (env, c, q)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_gives_the_table_and_records_the_run_as_the_ais() {
    let (env, c, q) = table_world(&[]).await;
    let r = call_ok(&c, "run", json!({ "id": q, "action": "read", "params": { "n": 3, "mode": "a" } })).await;
    assert_eq!(r["status"], "success", "{r}");
    assert_eq!(r["output"]["type"], "table");
    assert_eq!(r["output"]["columns"], json!(["a", "b"]));
    assert_eq!(r["output"]["rows"], json!([[0, "v0"], [1, "v1"], [2, "v2"]]));
    assert_eq!((r["output"]["total"].clone(), r["output"]["truncated"].clone()), (json!(3), json!(false)));
    let run = db(&env).query_row("SELECT actor, source, in_task_panel, params FROM runs WHERE id = ?1", [r["runId"].as_str().unwrap()], |x| {
        Ok((x.get::<_, String>(0)?, x.get::<_, String>(1)?, x.get::<_, i64>(2)?, x.get::<_, String>(3)?))
    })
    .unwrap();
    assert_eq!((run.0.as_str(), run.1.as_str(), run.2), ("ai:tester", "ai", 0));
    assert!(run.3.contains("\"n\":\"3\""), "values go as text: {}", run.3);
    // The user's list of tasks does not show it.
    let tasks = c.ok("run.tasks", json!({})).await;
    assert!(!tasks.to_string().contains(r["runId"].as_str().unwrap()), "{tasks}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_refuses_what_is_not_declared_for_ai_and_what_is_badly_asked() {
    let (_env, c, q) = table_world(&[]).await;
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "write" })).await, "denied/notAiAction");
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "dyn" })).await, "denied/notAiAction", "a helper action is not an AI action");
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "tool" })).await, "denied/notAiAction", "an action of no kind");
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "t.ai:write" })).await, "denied/notAiAction", "no full names either");
    assert_eq!(call_err(&c, "run", json!({ "id": q })).await, "invalidParams/needAction");
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "read", "params": { "mode": "c" } })).await, "invalidParams/badArguments");
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "read", "params": { "n": "many" } })).await, "invalidParams/badArguments");
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "read", "params": { "zzz": "1" } })).await, "invalidParams/badArguments");
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "read", "params": { "n": [1] } })).await, "invalidParams/badArguments");
    // Neither the environment nor the saved content is the AI's to change.
    for extra in [json!({ "env": "x" }), json!({ "envId": "x" }), json!({ "input": { "body.sql": "drop" } }), json!({ "target": "x" })] {
        let mut a = json!({ "id": q, "action": "read" });
        for (k, v) in extra.as_object().unwrap() {
            a[k] = v.clone();
        }
        assert_eq!(call_err(&c, "run", a).await, "invalidParams/badArguments", "{extra}");
    }
    // A resource of a kind with one AI action needs no action name.
    let s = make(&c, "single", "s1", "", None).await;
    visible(&c, &s, true).await;
    let r = call_ok(&c, "run", json!({ "id": s })).await;
    assert_eq!(r["output"]["text"], "only");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_cuts_rows_cells_and_text_before_they_leave() {
    let (_env, c, q) = table_world(&[("mcp.max_rows", "3")]).await;
    let r = call_ok(&c, "run", json!({ "id": q, "action": "read", "params": { "n": 10, "big": "1" } })).await;
    assert_eq!(r["output"]["rows"].as_array().unwrap().len(), 3);
    assert_eq!((r["output"]["total"].clone(), r["output"]["truncated"].clone()), (json!(10), json!(true)));
    let cell = r["output"]["rows"][0][1].as_str().unwrap();
    assert_eq!(cell.chars().count(), 2001, "2000 characters and the mark");
    // A short table is not marked.
    let r = call_ok(&c, "run", json!({ "id": q, "action": "read", "params": { "n": 2 } })).await;
    assert_eq!(r["output"]["truncated"], false);
    // Text.
    let r = call_ok(&c, "run", json!({ "id": q, "action": "bigtext" })).await;
    assert_eq!(r["output"]["text"].as_str().unwrap().chars().count(), 65536);
    assert_eq!((r["output"]["truncated"].clone(), r["output"]["totalChars"].clone()), (json!(true), json!(70000)));
    // The cut shows in the call's own answer too.
    let full = c.call_ai(CLIENT, "mcp.call", json!({ "name": "run", "arguments": { "id": q, "action": "read", "params": { "n": 10 } } })).await.unwrap();
    assert_eq!((full["truncated"].clone(), full["rows"].clone()), (json!(true), json!(3)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn get_run_pages_through_the_rows_of_the_ais_own_runs_only() {
    let (_env, c, q) = table_world(&[("mcp.max_rows", "4")]).await;
    let r = call_ok(&c, "run", json!({ "id": q, "action": "read", "params": { "n": 10 } })).await;
    let id = r["runId"].as_str().unwrap();
    assert_eq!(r["output"]["rows"].as_array().unwrap().len(), 4);
    let p2 = call_ok(&c, "get_run", json!({ "runId": id, "offset": 4 })).await;
    assert_eq!(p2["output"]["rows"], json!([[4, "v4"], [5, "v5"], [6, "v6"], [7, "v7"]]));
    assert_eq!((p2["output"]["offset"].clone(), p2["output"]["truncated"].clone()), (json!(4), json!(true)));
    let p3 = call_ok(&c, "get_run", json!({ "runId": id, "offset": 8, "limit": 100 })).await;
    assert_eq!(p3["output"]["rows"].as_array().unwrap().len(), 2, "the limit never beats the policy, the end ends it");
    assert_eq!(p3["output"]["truncated"], false);
    // Another client's run, and a run the user made, are not there.
    let other = c.call_ai("other", "mcp.call", json!({ "name": "get_run", "arguments": { "runId": id } })).await.unwrap_err();
    assert_eq!(code(&other), "notFound/");
    let user_run = c.ok("run.start", json!({ "action": "t.ai:read", "resourceId": q, "target": format!("resource:{q}"), "tabId": "t" })).await;
    assert_eq!(call_err(&c, "get_run", json!({ "runId": user_run.as_str().unwrap() })).await, "notFound/");
    assert_eq!(call_err(&c, "get_run", json!({ "runId": "nope" })).await, "notFound/");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_run_says_why_in_few_words() {
    let (_env, c, q) = table_world(&[]).await;
    let r = call_ok(&c, "run", json!({ "id": q, "action": "fail" })).await;
    assert_eq!(r["status"], "error");
    assert!(r["error"]["code"].is_string());
    assert!(r["error"]["message"].as_str().unwrap_or("").chars().count() <= 500, "{r}");
    assert!(r.get("output").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_secret_is_not_in_the_result_the_audit_or_the_records() {
    let (env, c, q) = table_world(&[]).await;
    c.ok("secrets.set", json!({ "name": "pw", "value": "hunter2-secret" })).await;
    // Plain-text secrets are not for an AI's run at all (D450); the user's own run of the same action gets it, scrubbed.
    let r = call_ok(&c, "run", json!({ "id": q, "action": "leak" })).await;
    assert_eq!(r["status"], "error", "{r}");
    assert_eq!(r["error"]["code"], "aiRun");
    assert!(!r.to_string().contains("hunter2"), "{r}");
    let user = c.ok("run.start", json!({ "action": "t.ai:leak", "resourceId": q, "target": format!("resource:{q}"), "tabId": "t" })).await;
    let user = wait_run(&c, user.as_str().unwrap()).await;
    assert_eq!(user["output"]["rows"], json!([["pw=***"]]), "the scrubbing of results is the old one's, and stays");
    let s = call_ok(&c, "search", json!({ "query": "q1" })).await;
    assert!(!s.to_string().contains("hunter2"));
    let dump: String = {
        let conn = db(&env);
        let mut all = String::new();
        for (t, cols) in [("audit", "summary || object"), ("runs", "params || input || coalesce(output, '') || coalesce(error, '') || coalesce(summary, '')"), ("resources", "body || name || description")] {
            let mut st = conn.prepare(&format!("SELECT {cols} FROM {t}")).unwrap();
            for r in st.query_map([], |r| r.get::<_, String>(0)).unwrap() {
                all.push_str(&r.unwrap());
            }
        }
        all
    };
    assert!(!dump.contains("hunter2"), "a secret value is in the database");
}

async fn wait_run(c: &Client, id: &str) -> Value {
    for _ in 0..500 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("run did not end");
}

/* ------------------------------------------------------------------ D450: an AI's run reads only */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inside_an_ais_run_the_plugin_may_read_and_nothing_more_whatever_it_declared() {
    let (env, c, q) = table_world(&[]).await;
    let hidden = make(&c, "query", "hidden one", "", None).await;
    // The same action, run by the user: the writes work (so the refusals below are the AI mode's).
    let user = c.ok("run.start", json!({ "action": "t.ai:probe", "resourceId": q, "target": format!("resource:{q}"), "tabId": "t", "params": { "other": hidden } })).await;
    let user = wait_run(&c, user.as_str().unwrap()).await;
    let u: Value = serde_json::from_str(user["output"]["text"].as_str().unwrap()).unwrap();
    assert_eq!((u["create"].clone(), u["update"].clone()), (json!("ok"), json!("ok")), "{u}");
    assert_eq!(u["listed"], json!(["hidden one", "made", "renamed"]), "the user sees them all");
    c.ok("page.save", json!({ "target": format!("resource:{q}"), "changes": { "name": "q1" } })).await;
    let made: String = db(&env).query_row("SELECT id FROM resources WHERE name = 'made'", [], |r| r.get(0)).unwrap();
    c.ok("resource.delete", json!({ "id": made })).await;
    let live = |env: &Env| count(env, "SELECT count(*) FROM resources WHERE deleted_at IS NULL");
    let live_before = live(&env);
    let r = call_ok(&c, "run", json!({ "id": q, "action": "probe", "params": { "other": hidden } })).await;
    assert_eq!(r["status"], "success", "{r}");
    let o: Value = serde_json::from_str(r["output"]["text"].as_str().unwrap()).unwrap();
    for k in ["create", "update", "open", "notify", "secret", "post"] {
        assert_eq!(o[k], "aiRun", "{k}: {o}");
    }
    for k in ["upload", "download", "captureAbs", "captureUp"] {
        assert_eq!(o[k], "aiRun", "{k}: {o}");
    }
    assert_ne!(o["captureOwn"], "aiRun", "D451: capturing a program's output into its own data folder is let through to the usual checks: {o}");
    assert_eq!(o["storage"], "ok", "its own storage stays");
    assert_eq!(o["listed"], json!(["q1"]), "only what is visible to AI: {o}");
    assert_eq!(o["got"], false, "a resource not visible to AI reads as not there");
    assert_eq!(live(&env), live_before, "nothing was made");
    assert_eq!(c.ok("resource.get", json!({ "id": q })).await["name"], "q1", "nor renamed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_free_tools_run_is_limited_the_same_way() {
    // A tool's action has no resource, and `ctx.ai` is set: the same gate.
    let (_env, c, _q) = table_world(&[]).await;
    let r = call_ok(&c, "t_ai__lookup", json!({ "text": "x" })).await;
    assert_eq!(r["status"], "success");
}

/* ------------------------------------------------------------------ environment and policy */

async fn make_env(c: &Client, name: &str) -> String {
    let e = c.ok("command.execute", json!({ "id": "env.newChild", "context": { "args": { "name": name } } })).await;
    e.as_array().unwrap().iter().find_map(|x| x["key"].as_str()).unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn runs_use_the_environment_the_workspace_names_and_no_other() {
    let (_env, c, q) = table_world(&[]).await;
    let r = call_ok(&c, "run", json!({ "id": q, "action": "info", "params": {} })).await;
    let info: Value = serde_json::from_str(r["output"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(info["env"], Value::Null, "none named: none used");
    assert_eq!(info["ai"], json!({ "client": "tester" }), "the plugin can see it is an AI's run");
    assert_eq!(info["input"], json!({}), "the saved content is all it runs");
    let e = make_env(&c, "for-ai").await;
    c.ok("workspace.setConfig", json!({ "name": "mcp.env", "value": e })).await;
    let r = call_ok(&c, "run", json!({ "id": q, "action": "info" })).await;
    let info: Value = serde_json::from_str(r["output"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(info["env"], json!(e));
    let st = c.ok("mcp.status", json!({})).await;
    assert_eq!((st["envId"].clone(), st["envName"].clone()), (json!(e), json!("for-ai")));
    // An environment that is gone is an error, not "no environment".
    c.ok("resource.delete", json!({ "id": e })).await;
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "info" })).await, "invalid/aiEnvMissing");
    c.ok("workspace.setConfig", json!({ "name": "mcp.env", "value": "no-such" })).await;
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "info" })).await, "invalid/aiEnvMissing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_ban_on_export_stops_what_gives_data_out_and_nothing_else() {
    let (_env, c, q) = table_world(&[]).await;
    let ok = call_ok(&c, "run", json!({ "id": q, "action": "read" })).await;
    c.ok("workspace.setConfig", json!({ "name": "protection.no_export", "value": "true" })).await;
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "read" })).await, "denied/noExport");
    assert_eq!(call_err(&c, "get_run", json!({ "runId": ok["runId"].as_str().unwrap() })).await, "denied/noExport");
    assert_eq!(call_err(&c, "t_ai__lookup", json!({ "text": "x" })).await, "denied/noExport");
    call_ok(&c, "search", json!({ "query": "q1" })).await;
    call_ok(&c, "describe", json!({ "id": q })).await;
    // A run writes its record, so `readonly` stops an AI's run as it stops the user's (D327).
    c.ok("workspace.setConfig", json!({ "name": "protection.no_export", "value": "false" })).await;
    call_ok(&c, "run", json!({ "id": q, "action": "read" })).await;
    c.ok("workspace.setConfig", json!({ "name": "protection.readonly", "value": "true" })).await;
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "read" })).await, "denied/readonly");
    call_ok(&c, "search", json!({ "query": "q1" })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_rate_limit_counts_all_ai_clients_together_over_a_minute() {
    let (env, c) = world(&[ON, ("mcp.rate_per_minute", "2")]).await;
    call_ok(&c, "search", json!({ "query": "a" })).await;
    call_ok(&c, "search", json!({ "query": "a" })).await;
    let e = call(&c, "search", json!({ "query": "a" })).await.unwrap_err();
    assert_eq!(code(&e), "denied/aiRateLimit");
    assert_eq!(e.params["limit"], "2");
    assert!(e.params["retryAfterMs"].parse::<u64>().unwrap() > 0);
    // D451: another client name buys no new window; `mcp.tools` and `mcp.status` are not counted.
    let e = c.call_ai("other", "mcp.call", json!({ "name": "search", "arguments": { "query": "a" } })).await.unwrap_err();
    assert_eq!(code(&e), "denied/aiRateLimit");
    let e = c.call_ai("tester-9f3a", "mcp.call", json!({ "name": "search", "arguments": { "query": "a" } })).await.unwrap_err();
    assert_eq!(code(&e), "denied/aiRateLimit");
    c.call_ai(CLIENT, "mcp.tools", json!({})).await.unwrap();
    c.call_ai(CLIENT, "mcp.status", json!({})).await.unwrap();
    // The refusal is audited as one.
    let rows = audit(&env, "mcp.call");
    assert!(rows.iter().any(|r| r.3 == "failed:denied" && r.2["reason"] == "aiRateLimit"));
    // The ceiling is the policy's: 600 at most, 1 at least, text is the default.
    c.ok("workspace.setConfig", json!({ "name": "mcp.rate_per_minute", "value": "100000" })).await;
    assert_eq!(c.ok("mcp.status", json!({})).await["ratePerMinute"], 600);
    c.ok("workspace.setConfig", json!({ "name": "mcp.rate_per_minute", "value": "0" })).await;
    assert_eq!(c.ok("mcp.status", json!({})).await["ratePerMinute"], 1);
    c.ok("workspace.setConfig", json!({ "name": "mcp.rate_per_minute", "value": "lots" })).await;
    assert_eq!(c.ok("mcp.status", json!({})).await["ratePerMinute"], 30);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_limit_holds_after_the_process_is_gone_and_comes_back() {
    let (env, c) = world(&[ON, ("mcp.rate_per_minute", "2")]).await;
    call_ok(&c, "search", json!({ "query": "a" })).await;
    call_ok(&c, "search", json!({ "query": "a" })).await;
    let Env { tmp, kernel } = env;
    kernel.shutdown();
    drop(c);
    drop(kernel);
    // A headless worker that idled out is a new process on the same workspace.
    let root = tmp.path().join("plugins");
    let again = Arc::new(onedesk_kernel::Kernel::open(&tmp.path().join("ws"), &root, config_for(&root)).unwrap());
    let c = Client::in_proc(again);
    c.hello().await;
    assert_eq!(call_err(&c, "search", json!({ "query": "a" })).await, "denied/aiRateLimit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn calls_that_run_at_once_do_not_get_past_the_limit() {
    let (_env, c, q) = table_world(&[("mcp.rate_per_minute", "3")]).await;
    let c = Arc::new(c);
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let (c, q) = (c.clone(), q.clone());
        tasks.push(tokio::spawn(async move { call(&c, "run", json!({ "id": q, "action": "read" })).await.is_ok() }));
    }
    let mut ok = 0;
    for t in tasks {
        ok += usize::from(t.await.unwrap());
    }
    assert_eq!(ok, 3);
}

/* ------------------------------------------------------------------ plugin tools */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn plugin_tools_are_checked_against_their_schema_before_the_plugin_hears_of_it() {
    let (env, c, _q) = table_world(&[]).await;
    let runs = |env: &Env| count(env, "SELECT count(*) FROM runs");
    let before = runs(&env);
    for bad in [json!({}), json!({ "text": 5 }), json!({ "text": "x".repeat(21) }), json!({ "text": "a", "n": 0 }), json!({ "text": "a", "n": 1.5 }), json!({ "text": "a", "zzz": 1 })] {
        assert_eq!(call_err(&c, "t_ai__lookup", bad.clone()).await, "invalidParams/badArguments", "{bad}");
    }
    assert_eq!(runs(&env), before, "the plugin was not called");
    let r = call_ok(&c, "t_ai__lookup", json!({ "text": "hi", "n": 2 })).await;
    assert_eq!(r["status"], "success", "{r}");
    let o: Value = serde_json::from_str(r["output"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(o, json!({ "echo": { "text": "hi", "n": 2 }, "ai": { "client": "tester" } }));
    assert_eq!(runs(&env), before + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_free_query_tool_needs_the_workspace_to_allow_it() {
    let (_env, c, _q) = table_world(&[]).await;
    // Not offered, so not found (a name it does not know says nothing about it).
    assert_eq!(call_err(&c, "t_ai__free", json!({})).await, "notFound/");
    c.ok("workspace.setConfig", json!({ "name": "mcp.allow_free_query", "value": "true" })).await;
    assert_eq!(call_ok(&c, "t_ai__free", json!({})).await["output"]["text"], "free");
    c.ok("workspace.setConfig", json!({ "name": "mcp.allow_free_query", "value": "false" })).await;
    assert_eq!(call_err(&c, "t_ai__free", json!({})).await, "notFound/");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_disabled_plugin_offers_no_tools_and_runs_nothing() {
    let (_env, c, q) = table_world(&[]).await;
    c.ok("plugin.setEnabled", json!({ "plugin": "t.ai", "enabled": false })).await;
    let t = c.call_ai(CLIENT, "mcp.tools", json!({})).await.unwrap();
    assert_eq!(t.as_array().unwrap().len(), 4);
    assert_eq!(call_err(&c, "t_ai__lookup", json!({ "text": "x" })).await, "notFound/");
    let d = call_ok(&c, "describe", json!({ "id": q })).await;
    assert_eq!(d["actions"], json!([]));
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "read" })).await, "denied/notAiAction");
}

/* ------------------------------------------------------------------ audit */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_call_is_audited_without_secrets_and_the_page_can_filter_by_ai() {
    let (env, c, q) = table_world(&[]).await;
    call_ok(&c, "search", json!({ "query": "q1" })).await;
    call_ok(&c, "run", json!({ "id": q, "action": "read", "params": { "n": 2 } })).await;
    // Arguments that look like secrets, and the call that was refused.
    let e = call(&c, "t_ai__lookup", json!({ "text": "x", "password": "hunter2-very-secret", "api_key": "sk-123456" })).await.unwrap_err();
    assert_eq!(code(&e), "invalidParams/badArguments");
    assert!(!format!("{e:?}").contains("hunter2"), "the error does not repeat values: {e:?}");
    call_ok(&c, "t_ai__lookup", json!({ "text": "y".repeat(20) })).await;
    let rows = audit(&env, "mcp.call");
    assert_eq!(rows.len(), 4);
    let s = &rows[0];
    assert_eq!((s.0.as_str(), s.1.as_str(), s.3.as_str()), ("ai:tester", "search", "ok"));
    assert_eq!((s.2["tool"].clone(), s.2["args"].clone(), s.2["ok"].clone()), (json!("search"), json!({ "query": "q1" }), json!(true)));
    assert!(s.2["rows"].is_number() && s.2["ms"].is_number(), "{}", s.2);
    let r = &rows[1];
    assert_eq!((r.1.as_str(), r.2["rows"].clone(), r.2["resource"].clone()), ("run", json!(2), json!(q)));
    assert!(r.2["runId"].is_string());
    assert_eq!(r.2["args"]["params"], json!({ "n": 2 }));
    let bad = &rows[2];
    assert_eq!((bad.3.as_str(), bad.2["code"].clone(), bad.2["reason"].clone()), ("failed:invalidParams", json!("invalidParams"), json!("badArguments")));
    assert_eq!(bad.2["args"]["password"], "***");
    assert_eq!(bad.2["args"]["api_key"], "***");
    assert_eq!(bad.2["ok"], false);
    let long = &rows[3];
    assert_eq!(long.2["args"]["text"], "y".repeat(20), "short strings stay");
    // Nowhere in the database.
    for needle in ["hunter2", "sk-123456"] {
        assert_eq!(count(&env, &format!("SELECT count(*) FROM audit WHERE summary LIKE '%{needle}%' OR object LIKE '%{needle}%'")), 0, "{needle}");
        assert_eq!(count(&env, &format!("SELECT count(*) FROM runs WHERE params LIKE '%{needle}%' OR input LIKE '%{needle}%' OR output LIKE '%{needle}%'")), 0);
    }
    // Long strings are cut.
    let _ = call(&c, "search", json!({ "query": "w".repeat(150) })).await;
    let last = audit(&env, "mcp.call").pop().unwrap();
    assert!(last.2["args"]["query"].as_str().unwrap().chars().count() <= 81, "{}", last.2);
    // The audit page: by operator type.
    let all = c.ok("audit.list", json!({})).await;
    let ai = c.ok("audit.list", json!({ "source": "ai" })).await;
    assert!(ai.as_array().unwrap().len() >= 5);
    assert!(ai.as_array().unwrap().iter().all(|r| r["source"] == "ai" && r["actor"] == "ai:tester"), "{ai}");
    assert!(all.as_array().unwrap().iter().any(|r| r["source"] == "user"), "the user's rows are there without the filter");
    let user = c.ok("audit.list", json!({ "source": "user" })).await;
    assert!(user.as_array().unwrap().iter().all(|r| r["source"] == "user"));
    let facets = c.ok("audit.facets", json!({})).await;
    assert!(facets["actors"].as_array().unwrap().iter().any(|a| a == "ai:tester"), "{facets}");
}

/* ------------------------------------------------------------------ manifests */

#[test]
fn manifests_with_bad_ai_declarations_are_rejected() {
    let check = |edit: &dyn Fn(&mut Value)| -> String {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugins");
        let mut m = manifest();
        edit(&mut m);
        write_pkg(&root, "t.ai", &m, "export default { activate() {} };");
        match onedesk_kernel::manifest::load_package(&root.join("t.ai").join("0.1.0")) {
            Ok(_) => "ok".into(),
            Err(r) => r.reason,
        }
    };
    assert_eq!(check(&|_| {}), "ok");
    let set = |id: &'static str, key: &'static str, v: Value| move |m: &mut Value| {
        let a = m["contributes"]["actions"].as_array_mut().unwrap().iter_mut().find(|a| a["id"] == id).unwrap();
        a[key] = v.clone();
    };
    assert_eq!(check(&set("read", "ai", json!({ "readOnly": false }))), "badAiAction");
    assert_eq!(check(&set("read", "ai", json!({}))), "schema");
    assert_eq!(check(&set("read", "confirm", json!("c.key"))), "badAiAction");
    assert_eq!(check(&set("read", "ai", json!({ "readOnly": true, "params": [{ "name": "1x", "type": "text" }] }))), "badAiAction");
    assert_eq!(check(&set("read", "ai", json!({ "readOnly": true, "params": [{ "name": "a", "type": "date" }] }))), "badAiAction");
    assert_eq!(check(&set("read", "ai", json!({ "readOnly": true, "params": [{ "name": "a", "type": "enum" }] }))), "badAiAction");
    assert_eq!(check(&set("read", "ai", json!({ "readOnly": true, "params": [{ "name": "a", "type": "text" }, { "name": "a", "type": "text" }] }))), "badAiAction");
    assert_eq!(check(&set("read", "ai", json!({ "readOnly": true, "describe": "nope" }))), "badAiAction");
    assert_eq!(check(&set("read", "ai", json!({ "readOnly": true, "describe": "read" }))), "badAiAction");
    assert_eq!(check(&set("read", "ai", json!({ "readOnly": true, "describe": "readDyn" }))), "badAiAction", "no chains");
    let tool = |edit: fn(&mut Value)| move |m: &mut Value| edit(&mut m["contributes"]["aiTools"][0]);
    assert_eq!(check(&tool(|t| t["name"] = json!("Bad"))), "badAiTools");
    assert_eq!(check(&tool(|t| t["name"] = json!("a__b"))), "badAiTools");
    assert_eq!(check(&tool(|t| t["name"] = json!("free"))), "badAiTools", "twice");
    assert_eq!(check(&tool(|t| t["action"] = json!("write"))), "badAiTools", "an action with no `ai`");
    assert_eq!(check(&tool(|t| t["action"] = json!("read"))), "badAiTools", "an action of a kind");
    assert_eq!(check(&tool(|t| t["action"] = json!("nope"))), "badAiTools");
    assert_eq!(check(&tool(|t| t["inputSchema"] = json!({ "type": "string" }))), "badAiTools");
    assert_eq!(check(&tool(|t| t["inputSchema"] = json!({ "type": "object", "$ref": "#/x" }))), "badAiTools");
    assert_eq!(check(&tool(|t| t["inputSchema"] = json!({ "type": "object", "oneOf": [] }))), "badAiTools");
    assert_eq!(check(&tool(|t| t["inputSchema"] = json!({ "type": "object", "properties": { "a": { "type": "date" } } }))), "badAiTools");
}

/* ------------------------------------------------------------------ the policy keys */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_policy_keys_are_known_parameters() {
    let (_env, c) = world(&[]).await;
    let known = c.ok("params.known", json!({})).await;
    let names: Vec<&str> = known.as_array().unwrap().iter().map(|k| k["name"].as_str().unwrap()).collect();
    for k in ["mcp.enabled", "mcp.rate_per_minute", "mcp.max_rows", "mcp.allow_free_query", "mcp.env"] {
        assert!(names.contains(&k), "{k} in {names:?}");
    }
}

/* ------------------------------------------------------------------ review (D450) */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn audit_fields_are_cut_and_a_flood_of_refusals_is_a_few_rows() {
    let (env, c, q) = table_world(&[]).await;
    let long = "x".repeat(5000);
    call_err(&c, &long, json!({})).await;
    let rows = audit(&env, "mcp.call");
    assert!(rows[0].1.chars().count() <= 81 && rows[0].2["tool"].as_str().unwrap().chars().count() <= 81, "{:?}", rows[0]);
    let r = call_ok(&c, "run", json!({ "id": q, "action": "read" })).await;
    let last = audit(&env, "mcp.call").pop().unwrap();
    assert_eq!(last.2["runId"], r["runId"]);
    // 200 calls of a tool that is not there: not 200 rows.
    for _ in 0..200 {
        let _ = call(&c, "nope", json!({})).await;
    }
    let n = audit(&env, "mcp.call").iter().filter(|r| r.2["reason"].is_null() && r.3 == "failed:notFound").count();
    assert!(n <= 3, "{n}");
    // The switch off, the limit: the same.
    c.ok("workspace.setConfig", json!({ "name": "mcp.enabled", "value": "false" })).await;
    let before = count(&env, "SELECT count(*) FROM audit");
    for _ in 0..100 {
        let _ = call(&c, "search", json!({ "query": "x" })).await;
    }
    assert!(count(&env, "SELECT count(*) FROM audit") - before <= 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn search_gives_no_text_of_the_body_and_a_run_is_unreadable_once_switched_off() {
    let (_env, c, q) = table_world(&[]).await;
    c.ok("page.save", json!({ "target": format!("resource:{q}"), "changes": { "body.text": "needle-in-the-body secret words" } })).await;
    let r = call_ok(&c, "search", json!({ "query": "needle" })).await;
    for it in r["items"].as_array().unwrap() {
        assert!(it.get("snippet").is_none(), "{it}");
    }
    assert!(!r.to_string().contains("secret words"), "{r}");
    let run = call_ok(&c, "run", json!({ "id": q, "action": "read" })).await;
    let id = run["runId"].as_str().unwrap().to_string();
    call_ok(&c, "get_run", json!({ "runId": id })).await;
    visible(&c, &q, false).await;
    assert_eq!(call_err(&c, "get_run", json!({ "runId": id })).await, "notFound/");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parameters_are_checked_against_what_the_action_declares_or_its_own_answer() {
    let (_env, c, q) = table_world(&[]).await;
    // No declaration: no parameters.
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "info", "params": { "a": "1" } })).await, "invalidParams/badArguments");
    // Its own answer (required `x`): missing, with none given at all, is refused too; unknown and too long as well.
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "readDyn" })).await, "invalidParams/badArguments");
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "readDyn", "params": { "y": "1" } })).await, "invalidParams/badArguments");
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "readDyn", "params": { "x": "z".repeat(1001) } })).await, "invalidParams/badArguments");
    let many: serde_json::Map<String, Value> = (0..40).map(|i| (format!("p{i}"), json!("1"))).collect();
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "read", "params": many })).await, "invalidParams/badArguments");
    let r = call_ok(&c, "run", json!({ "id": q, "action": "readDyn", "params": { "x": "1" } })).await;
    assert!(r["status"].is_string(), "it started: {r}");
    // A bad answer of the plugin is not run on.
    assert_eq!(call_err(&c, "run", json!({ "id": q, "action": "readBad" })).await, "pluginError/badOutput");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn what_the_plugin_answers_about_its_parameters_is_cut_to_the_format() {
    let (_env, c, q) = table_world(&[]).await;
    let d = call_ok(&c, "describe", json!({ "id": q })).await;
    let long = d["actions"].as_array().unwrap().iter().find(|a| a["action"] == "readLong").unwrap();
    assert_eq!(long["description"].as_str().unwrap().chars().count(), 400);
    let p = &long["params"][0];
    assert_eq!(p["description"].as_str().unwrap().chars().count(), 400);
    assert!(p.get("junk").is_none(), "{p}");
}
