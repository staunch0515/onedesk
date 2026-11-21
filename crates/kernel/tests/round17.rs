//! Round 17 (kernel): line tones and the terminal appearance (X10), program output by lines and
//! partial run output (X17), the new `files.*` operations and the granted-folder list (X18), and
//! fuzzy short words in search (X6). Plugins are generated into a temporary folder; the Trash and
//! "open in Finder" are a temporary folder and a log file.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::*;
use serde_json::{json, Value};

const MAIN: &str = r#"
async function probe(ctx, context) {
  const a = (context && context.args) || {};
  const [cap, op] = a.method.split(".");
  try { return [{ type: "copy", text: JSON.stringify({ ok: await ctx.host[cap][op](...a.args) }) }]; }
  catch (e) { return [{ type: "copy", text: JSON.stringify({ error: e.code || String(e), params: e.params || {}, detail: e.detail }) }]; }
}
const fail = (e) => ({ error: e.code || String(e), params: e.params || {} });
const COLS = [{ key: "stream", label: "Stream" }, { key: "line", label: "Line" }];
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.commands.handle("ask", async (ctx, context) => {
    const a = (context && context.args) || {};
    if (a.confirmed) return [{ type: "copy", text: "chose " + a.conflict }];
    const mode = a.mode || "own";
    const command = mode === "other" ? "deleted.purge" : "t.r17:ask";
    const choices = mode === "bad" ? [] : [{ id: "overwrite", danger: true }, { id: "skip" }, { id: "keepBoth", label: "Keep both" }];
    return [{ type: "confirm", message: "Exists", command, choices, choiceArg: "conflict", irreversible: true }];
  });
  host.trees.handle("t", { async children(ctx, parent) {
    if (parent) return { nodes: [] };
    return { nodes: [
      { key: "/a", label: "a", icon: "folder", expandable: true, draggable: true, accepts: ["file", "folder"],
        menu: ["ask", "t.r17:probe", "node.open", "ask", "other.plugin:x", "nope", "node.explode"] },
      { key: "/b", label: "b", icon: "file", target: "node:t.r17:t//b" },
      { key: "/c", label: "c", icon: "file", menu: [] },
    ] };
  } });
  host.pages.handle("p", { async render() {
    return { view: [{ type: "text", id: "t", text: "ok\nbad\nplain", mono: true,
                      lineTones: ["success", "stderr"], appearance: "terminal" }] };
  } });
  host.actions.handle("lines", async (ctx, input) => {
    const opts = Object.assign({ program: "sh" }, input.opts);
    const chunks = [];
    const rows = [];
    if (input.stream) opts.onOutput = async (c) => {
      chunks.push(c);
      rows.push([c.stream, c.text]);
      await ctx.host.runs.partial({ type: "text", text: rows.map((r) => r[1]).join("\n"),
        lineTones: rows.map((r) => (r[0] === "stderr" ? "stderr" : null)), appearance: "terminal" });
    };
    let out;
    try { out = { ok: await ctx.host.process.run(opts) }; } catch (e) { out = fail(e); }
    out.chunks = chunks;
    return { output: { type: "text", text: JSON.stringify(out) } };
  });
  host.actions.handle("table", async (ctx) => {
    await ctx.host.runs.partial({ type: "table", columns: COLS, rows: [["stdout", "so far"]], appearance: "terminal", toneColumn: "stream" });
    return { output: { type: "table", columns: COLS,
    rows: [["stdout", "a"], ["stderr", "b"]], appearance: "terminal", toneColumn: "stream", lineColumn: "line" } };
  });
  host.actions.handle("text", async () => ({ output: { type: "text", text: "a\nb", lineTones: [null, "danger"], appearance: "plain" } }));
  host.actions.handle("badpartial", async (ctx) => {
    const r = [];
    for (const o of [{ type: "text", text: "x" }, { type: "table", rows: "no" }, { type: "table", columns: COLS, rows: [], file: "x.csv" }]) {
      try { await ctx.host.runs.partial(o); r.push("ok"); } catch (e) { r.push(e.code + "/" + (e.params || {}).reason); }
    }
    return { output: { type: "table", columns: [{ key: "r", label: "r" }], rows: r.map((x) => [x]) } };
  });
  host.events.on("resource.changed", async (ctx) => {
    let r;
    try { await ctx.host.files.mkdir("evt"); r = "ran"; } catch (e) { r = e.code + "/" + (e.params || {}).reason; }
    await ctx.host.storage.set("evt", r);
  });
} };
"#;

fn manifest() -> Value {
    json!({
        "requires": { "files": true, "resources": true, "programs": [{ "name": "sh", "source": "system" }] },
        "contributes": {
            "kinds": [{ "id": "k", "label": "K", "icon": "box", "tree": "resources", "page": "p", "newName": "k" }],
            "actions": [{ "id": "lines", "label": "a", "output": "text" },
                        { "id": "table", "label": "a", "output": "table" },
                        { "id": "text", "label": "a", "output": "text" },
                        { "id": "badpartial", "label": "a", "output": "table" }],
            "commands": [{ "id": "probe", "label": "p" }, { "id": "ask", "label": "a" }],
            "trees": [{ "id": "t", "label": "T", "icon": "folder", "source": "provided" }],
            "pages": [{ "id": "p", "actions": [{ "id": "go", "role": "run", "label": "Go", "command": "ask" },
                                               { "id": "run", "role": "run", "label": "Run", "action": "text" }] }],
            "events": ["resource.changed"]
        }
    })
}

struct World {
    env: Env,
    c: Client,
    /// A granted folder (canonical).
    grant: PathBuf,
    trash: PathBuf,
    open_log: PathBuf,
}

async fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(tmp.path()).unwrap();
    let root = base.join("plugins");
    let dir = root.join("t.r17").join("0.1.0");
    std::fs::create_dir_all(&dir).unwrap();
    let mut m = json!({ "id": "t.r17", "version": "0.1.0", "apiVersion": "2", "name": "r17", "icon": "box", "main": "main.js" });
    for (k, v) in manifest().as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    std::fs::write(dir.join("main.js"), MAIN).unwrap();
    let grant = base.join("grant");
    let trash = base.join("trash");
    std::fs::create_dir_all(&grant).unwrap();
    std::fs::create_dir_all(&trash).unwrap();
    let open_log = base.join("open.log");
    let mut cfg = config_for(&root);
    cfg.trash_dir = trash.clone();
    cfg.opener = onedesk_kernel::Opener::log_to(open_log.clone());
    cfg.action_timeout = Duration::from_secs(20);
    let env = open_with(tmp, &root, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    c.ok("plugin.grantFolder", json!({ "plugin": "t.r17", "path": grant.display().to_string() })).await;
    World { env, c, grant, trash, open_log }
}

impl World {
    async fn probe(&self, method: &str, args: Value) -> Value {
        self.c.probe("t.r17", method, args).await
    }
    async fn ok(&self, method: &str, args: Value) -> Value {
        let r = self.probe(method, args).await;
        assert!(r.get("error").is_none(), "{method}: {r}");
        r["ok"].clone()
    }
    async fn err(&self, method: &str, args: Value) -> (String, String) {
        let r = self.probe(method, args).await;
        (r["error"].as_str().unwrap_or("ok").to_string(), r["params"]["reason"].as_str().or(r["params"]["what"].as_str()).unwrap_or("").to_string())
    }
    fn p(&self, rel: &str) -> String {
        self.grant.join(rel).display().to_string()
    }
    fn audit(&self, op: &str) -> Vec<(String, Value)> {
        let conn = rusqlite::Connection::open(self.env.kernel.db_path()).unwrap();
        let mut st = conn.prepare("SELECT object, summary FROM audit WHERE op = ?1 AND result = 'ok' ORDER BY seq").unwrap();
        st.query_map([op], |r| Ok((r.get::<_, String>(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap())))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }
    async fn no_programs_left(&self) {
        for _ in 0..200 {
            if self.env.kernel.live_programs() == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("programs still running: {}", self.env.kernel.live_programs());
    }
}

async fn start(c: &Client, action: &str, input: Value) -> String {
    let p = json!({ "action": format!("t.r17:{action}"), "target": "core:none", "tabId": "t", "input": input });
    c.ok("run.start", p).await.as_str().unwrap().to_string()
}

async fn wait_run(c: &Client, id: &str) -> Value {
    for _ in 0..1000 {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {id} did not end");
}

async fn lines(w: &World, opts: Value, stream: bool) -> Value {
    let id = start(&w.c, "lines", json!({ "opts": opts, "stream": stream })).await;
    let r = wait_run(&w.c, &id).await;
    assert_eq!(r["status"], "success", "{r}");
    serde_json::from_str(r["output"]["text"].as_str().unwrap()).unwrap()
}

fn write(p: &Path, text: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/* ------------------------------------------------------------------ X10 */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn x10_line_tones_and_terminal_appearance_reach_the_shell() {
    let w = world().await;
    let page = w.c.ok("page.resolve", json!({ "target": "new:t.r17:k" })).await;
    let t = &page["view"][0];
    assert_eq!(t["lineTones"], json!(["success", "stderr"]));
    assert_eq!(t["appearance"], "terminal");

    let r = wait_run(&w.c, &start(&w.c, "table", json!({})).await).await;
    assert_eq!(r["status"], "success", "{r}");
    assert_eq!(r["output"]["appearance"], "terminal");
    assert_eq!(r["output"]["toneColumn"], "stream");
    assert_eq!(r["output"]["lineColumn"], "line");
    let r = wait_run(&w.c, &start(&w.c, "text", json!({})).await).await;
    assert_eq!(r["output"]["lineTones"], json!([null, "danger"]));
    assert_eq!(r["output"]["appearance"], "plain");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn d428_confirm_choices_pass_through_and_d429_page_items_name_commands() {
    let w = world().await;
    let eff = w.c.ok("command.execute", json!({ "id": "t.r17:ask", "context": {} })).await;
    assert_eq!(
        eff,
        json!([{ "type": "confirm", "message": "Exists", "command": "t.r17:ask", "choiceArg": "conflict", "irreversible": true,
                 "choices": [{ "id": "overwrite", "danger": true }, { "id": "skip" }, { "id": "keepBoth", "label": "Keep both" }] }])
    );
    // What the shell sends back after a choice.
    let eff = w.c.ok("command.execute", json!({ "id": "t.r17:ask", "context": { "args": { "confirmed": true, "conflict": "keepBoth" } } })).await;
    assert_eq!(eff[0]["text"], "chose keepBoth");
    // Only its own commands; no empty choice list.
    for mode in ["other", "bad"] {
        let e = w.c.call("command.execute", json!({ "id": "t.r17:ask", "context": { "args": { "mode": mode } } })).await.unwrap_err();
        assert_eq!(e.code, onedesk_protocol::ErrorCode::PluginError, "{mode}");
    }
    // D429: the page item carries the full command id, the other one its action.
    let page = w.c.ok("page.resolve", json!({ "target": "new:t.r17:k" })).await;
    let items = page["actions"].as_array().unwrap();
    assert_eq!(items[0]["command"], "t.r17:ask");
    assert!(items[0].get("action").is_none());
    assert_eq!(items[1]["action"], "t.r17:text");
    assert!(items[1].get("command").is_none());
    // Kernel confirmations say they cannot be undone.
    let id = wait_run(&w.c, &start(&w.c, "text", json!({})).await).await["id"].as_str().unwrap().to_string();
    w.c.ok("run.setKept", json!({ "id": id, "kept": true })).await;
    let eff = w.c.ok("command.execute", json!({ "id": "run.delete", "context": { "args": { "run": id } } })).await;
    assert_eq!(eff[0]["irreversible"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn d430_provided_nodes_carry_their_checked_menu_draggable_and_accepts() {
    let w = world().await;
    let page = w.c.ok("tree.children", json!({ "tree": "t.r17:t" })).await;
    let nodes = page["nodes"].as_array().unwrap();
    let a = &nodes[0];
    let ids: Vec<&str> = a["menu"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
    // Its own commands (short or full), the kernel's node.*; repeats, others' and unknown dropped.
    assert_eq!(ids, vec!["t.r17:ask", "t.r17:probe", "node.open"]);
    assert_eq!(a["menu"][0]["label"], "a", "the command's own label");
    assert_eq!(a["draggable"], true);
    assert_eq!(a["accepts"], json!(["file", "folder"]));
    // Without a menu: "open" for a node with a target, as before; nothing else, not draggable.
    let b = &nodes[1];
    assert_eq!(b["menu"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["node.open"]);
    assert_eq!(b["draggable"], false);
    assert_eq!(b["accepts"], json!([]));
    // An explicit empty menu is empty.
    assert_eq!(nodes[2]["menu"], json!([]));
}

/* ------------------------------------------------------------------ X17 */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn x17_output_comes_back_as_lines_marked_by_stream() {
    let w = world().await;
    let script = "printf 'one\\r\\n'; echo two >&2; printf 'three'";
    let r = lines(&w, json!({ "args": ["-c", script], "lines": true }), true).await;
    let ok = &r["ok"];
    assert_eq!(ok["code"], 0);
    assert_eq!(ok["stopped"], Value::Null);
    let got: Vec<(String, String)> =
        ok["lines"].as_array().unwrap().iter().map(|l| (l["stream"].as_str().unwrap().into(), l["text"].as_str().unwrap().into())).collect();
    assert!(got.contains(&("stdout".into(), "one".into())), "{got:?}");
    assert!(got.contains(&("stderr".into(), "two".into())));
    assert_eq!(got.last().unwrap(), &("stdout".to_string(), "three".to_string()), "the last line without a newline counts");
    assert_eq!(got.len(), 3);
    // `onOutput` got whole lines, the same ones.
    assert_eq!(r["chunks"].as_array().unwrap().len(), 3);
    assert_eq!(ok["stdout"], "one\r\nthree", "stdout / stderr stay as before");
    // Without `lines`, nothing changes.
    let r = lines(&w, json!({ "args": ["-c", "echo a"] }), false).await;
    assert!(r["ok"].get("lines").is_none());
    // `maxLines` needs `lines`.
    let r = lines(&w, json!({ "args": ["-c", "echo a"], "maxLines": 3 }), false).await;
    assert_eq!(r["error"], "invalidParams");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn x17_line_limit_and_timeout_end_the_program_at_once_and_keep_the_lines() {
    let w = world().await;
    let t0 = std::time::Instant::now();
    let r = lines(&w, json!({ "args": ["-c", "while :; do echo x; done"], "lines": true, "maxLines": 50 }), false).await;
    let ok = &r["ok"];
    assert_eq!(ok["stopped"], "maxLines", "{r}");
    assert_eq!(ok["lines"].as_array().unwrap().len(), 50);
    assert_eq!(ok["truncated"], true);
    assert_eq!(ok["code"], Value::Null);
    let r = lines(&w, json!({ "args": ["-c", "echo first; sleep 30"], "lines": true, "timeoutMs": 400 }), false).await;
    let ok = &r["ok"];
    assert_eq!(ok["stopped"], "timeout", "{r}");
    assert_eq!(ok["lines"], json!([{ "stream": "stdout", "text": "first" }]));
    assert!(t0.elapsed() < Duration::from_secs(10));
    w.no_programs_left().await;
    // Without `lines` a timeout is still an error.
    let r = lines(&w, json!({ "args": ["-c", "sleep 30"], "timeoutMs": 300 }), false).await;
    assert_eq!((r["error"].as_str().unwrap(), r["params"]["reason"].as_str().unwrap()), ("invalid", "timeout"));
    w.no_programs_left().await;
    let summaries: Vec<Value> = w.audit("process.run").into_iter().map(|(_, s)| s).collect();
    assert!(summaries.iter().any(|s| s["stopped"] == "maxLines"), "{summaries:?}");
    assert!(summaries.iter().any(|s| s["stopped"] == "timeout"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn x17_cancelling_ends_the_program_at_once() {
    let w = world().await;
    let id = start(&w.c, "lines", json!({ "opts": { "args": ["-c", "echo go; sleep 30"], "lines": true }, "stream": true })).await;
    for _ in 0..200 {
        if w.env.kernel.live_programs() > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let t0 = std::time::Instant::now();
    w.c.ok("run.cancel", json!({ "id": id })).await;
    let r = wait_run(&w.c, &id).await;
    assert_eq!(r["status"], "cancelled");
    w.no_programs_left().await;
    assert!(t0.elapsed() < Duration::from_secs(4));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn x17_partial_output_is_shown_while_running_and_gone_after() {
    let w = world().await;
    let script = "echo one; echo two >&2; sleep 2; echo three";
    let id = start(&w.c, "lines", json!({ "opts": { "args": ["-c", script], "lines": true }, "stream": true })).await;
    let mut seen = Value::Null;
    for _ in 0..150 {
        let r = w.c.ok("run.get", json!({ "id": id })).await;
        if r["status"] != "running" {
            break;
        }
        if r["partial"]["lineTones"].as_array().is_some_and(|a| a.len() == 2) {
            seen = r["partial"].clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(seen["type"], "text", "partial output while running");
    assert_eq!(seen["appearance"], "terminal");
    let text = seen["text"].as_str().unwrap();
    let tones = seen["lineTones"].as_array().unwrap();
    let i = text.split('\n').position(|l| l == "two").unwrap();
    assert_eq!(tones[i], "stderr");
    assert_eq!(tones[1 - i], Value::Null);
    // Lists never carry it.
    let tasks = w.c.ok("run.tasks", json!({})).await;
    assert!(tasks.as_array().unwrap().iter().all(|t| t.get("partial").is_none()));
    let r = wait_run(&w.c, &id).await;
    assert_eq!(r["status"], "success");
    assert!(r.get("partial").is_none(), "gone once the run ended");
    // A wrong shape is refused; outside a run, `notInRun`.
    let r = wait_run(&w.c, &start(&w.c, "badpartial", json!({})).await).await;
    assert_eq!(r["output"]["rows"], json!([["invalid/badOutput"], ["invalid/badOutput"], ["invalid/badOutput"]]), "{r}");
    assert_eq!(w.err("runs.partial", json!([{ "type": "text", "text": "x" }])).await, ("denied".into(), "notInRun".into()));
}

/* ------------------------------------------------------------------ X18 */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn x18_mkdir_copy_move_with_name_conflicts() {
    let w = world().await;
    let e = w.ok("files.mkdir", json!([w.p("docs")])).await;
    assert_eq!(e["dir"], true);
    assert_eq!(w.err("files.mkdir", json!([w.p("docs")])).await, ("conflict".into(), "exists".into()));
    assert_eq!(w.err("files.mkdir", json!([w.p("a/b/c")])).await, ("notFound".into(), "path".into()));
    w.ok("files.mkdir", json!([w.p("a/b/c"), { "recursive": true }])).await;
    assert!(w.grant.join("a/b/c").is_dir());

    write(&w.grant.join("docs/r.txt"), "one");
    write(&w.grant.join("r.txt"), "two");
    // Fail (default), skip, keep both, overwrite.
    assert_eq!(w.err("files.copy", json!([w.p("r.txt"), w.p("docs/r.txt")])).await, ("conflict".into(), "exists".into()));
    let r = w.ok("files.copy", json!([w.p("r.txt"), w.p("docs/r.txt"), { "conflict": "skip" }])).await;
    assert_eq!(r, json!({ "path": w.p("docs/r.txt"), "skipped": true }));
    let r = w.ok("files.copy", json!([w.p("r.txt"), w.p("docs/r.txt"), { "conflict": "keepBoth" }])).await;
    assert_eq!(r["path"], w.p("docs/r 2.txt"));
    let r = w.ok("files.copy", json!([w.p("r.txt"), w.p("docs/r.txt"), { "conflict": "keepBoth" }])).await;
    assert_eq!(r["path"], w.p("docs/r 3.txt"));
    w.ok("files.copy", json!([w.p("r.txt"), w.p("docs/r.txt"), { "conflict": "overwrite" }])).await;
    assert_eq!(std::fs::read_to_string(w.grant.join("docs/r.txt")).unwrap(), "two");
    // A folder is copied whole; into itself is refused.
    write(&w.grant.join("a/b/c/deep.txt"), "deep");
    w.ok("files.copy", json!([w.p("a"), w.p("a2")])).await;
    assert_eq!(std::fs::read_to_string(w.grant.join("a2/b/c/deep.txt")).unwrap(), "deep");
    assert_eq!(w.err("files.copy", json!([w.p("a"), w.p("a/b/x")])).await, ("invalid".into(), "intoItself".into()));
    // Move = rename; with conflicts too.
    let r = w.ok("files.move", json!([w.p("r.txt"), w.p("renamed.txt")])).await;
    assert_eq!(r["skipped"], false);
    assert!(!w.grant.join("r.txt").exists() && w.grant.join("renamed.txt").exists());
    let r = w.ok("files.move", json!([w.p("renamed.txt"), w.p("docs/r.txt"), { "conflict": "keepBoth" }])).await;
    assert_eq!(r["path"], w.p("docs/r 4.txt"));
    assert_eq!(w.err("files.move", json!([w.p("docs"), w.p("docs/in")])).await, ("invalid".into(), "intoItself".into()));
    assert_eq!(w.err("files.copy", json!([w.p("x"), w.p("y"), { "conflict": "merge" }])).await.0, "invalidParams");
    // The granted folder itself cannot be moved; nothing outside is reachable.
    assert_eq!(w.err("files.move", json!([w.grant.display().to_string(), w.p("../elsewhere")])).await.0, "invalid");
    let outside = w.grant.parent().unwrap().join("outside.txt");
    write(&outside, "keep");
    assert_eq!(w.err("files.copy", json!([w.p("docs/r.txt"), outside.display().to_string(), { "conflict": "overwrite" }])).await.0, "denied");
    assert_eq!(w.err("files.move", json!([outside.display().to_string(), w.p("in.txt")])).await.0, "denied");
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
    // A link out of the grant is copied as a link, never followed.
    std::os::unix::fs::symlink(&outside, w.grant.join("link")).unwrap();
    w.ok("files.copy", json!([w.p("link"), w.p("link2")])).await;
    assert!(std::fs::symlink_metadata(w.grant.join("link2")).unwrap().file_type().is_symlink());
    // Audited; skipped ones are not.
    assert_eq!(w.audit("files.mkdir").len(), 2);
    assert_eq!(w.audit("files.copy").len(), 5);
    assert_eq!(w.audit("files.move").len(), 2);
    let keep = &w.audit("files.copy")[0];
    assert_eq!(keep, &(w.p("docs/r 2.txt"), json!({ "from": w.p("r.txt"), "conflict": "keepBoth" })));
    // Relative paths are the plugin's own folder, which can copy out to a grant.
    w.ok("files.writeText", json!(["own.txt", "mine"])).await;
    let r = w.ok("files.copy", json!(["own.txt", w.p("from-own.txt")])).await;
    assert_eq!(r["path"], w.p("from-own.txt"));
    assert_eq!(std::fs::read_to_string(w.grant.join("from-own.txt")).unwrap(), "mine");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn x18_trash_remove_open_reveal_and_find() {
    let w = world().await;
    write(&w.grant.join("old.txt"), "x");
    write(&w.trash.join("old.txt"), "already there");
    let r = w.ok("files.trash", json!([w.p("old.txt")])).await;
    assert_eq!(r["path"], w.trash.join("old 2.txt").display().to_string());
    assert!(!w.grant.join("old.txt").exists());
    assert_eq!(std::fs::read_to_string(w.trash.join("old.txt")).unwrap(), "already there");
    write(&w.grant.join("dir/inner.txt"), "x");
    w.ok("files.trash", json!([w.p("dir")])).await;
    assert!(w.trash.join("dir/inner.txt").exists());
    assert_eq!(w.err("files.trash", json!([w.grant.display().to_string()])).await, ("invalid".into(), "isRoot".into()));
    assert_eq!(w.err("files.trash", json!([w.p("nope")])).await, ("notFound".into(), "path".into()));

    write(&w.grant.join("gone/a.txt"), "x");
    assert_eq!(w.ok("files.remove", json!([w.p("gone")])).await, Value::Null);
    assert!(!w.grant.join("gone").exists());
    assert_eq!(w.err("files.remove", json!([w.grant.display().to_string()])).await, ("invalid".into(), "isRoot".into()));
    assert_eq!(w.audit("files.trash").len(), 2);
    assert_eq!(w.audit("files.remove").len(), 1);

    write(&w.grant.join("show.txt"), "x");
    w.ok("files.open", json!([w.p("show.txt")])).await;
    w.ok("files.reveal", json!([w.p("show.txt")])).await;
    assert_eq!(w.err("files.open", json!([w.p("missing.txt")])).await, ("notFound".into(), "path".into()));
    let log = std::fs::read_to_string(&w.open_log).unwrap();
    assert_eq!(log, format!("open {0}\nreveal {0}\n", w.p("show.txt")));

    for f in ["Report 2024.txt", "sub/report-final.md", "sub/deeper/REPORT.csv", "other.txt", ".hidden/report.txt"] {
        write(&w.grant.join(f), "x");
    }
    let r = w.ok("files.find", json!([w.grant.display().to_string(), "report"])).await;
    let names: Vec<&str> = r["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Report 2024.txt", "report-final.md", "REPORT.csv"], "hidden folders are skipped");
    let r = w.ok("files.find", json!([w.grant.display().to_string(), "REPORT final"])).await;
    assert_eq!(r["entries"].as_array().unwrap().len(), 1, "every word must match");
    let r = w.ok("files.find", json!([w.grant.display().to_string(), "report", { "limit": 2 }])).await;
    assert_eq!(r["next"], 2);
    let r = w.ok("files.find", json!([w.grant.display().to_string(), "report", { "offset": 2, "limit": 2 }])).await;
    assert_eq!(r["entries"][0]["name"], "REPORT.csv");
    assert!(r["next"].is_null());

    // Not from an event handler (it may still find).
    w.ok("resources.create", json!([{ "kind": "k", "name": "trigger" }])).await;
    let mut got = Value::Null;
    for _ in 0..200 {
        got = w.ok("storage.get", json!(["evt"])).await;
        if !got.is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(got, "denied/notInRun");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn x18_granted_folders_are_added_listed_replaced_and_removed_with_audit() {
    let w = world().await;
    let base = w.grant.parent().unwrap().to_path_buf();
    let (second, third) = (base.join("second"), base.join("third"));
    std::fs::create_dir_all(&second).unwrap();
    std::fs::create_dir_all(&third).unwrap();
    let s = |p: &Path| p.display().to_string();
    let g = w.c.ok("plugin.grantFolder", json!({ "plugin": "t.r17", "path": s(&second) })).await;
    assert_eq!(g["folders"], json!([s(&w.grant), s(&second)]));
    write(&second.join("keep.txt"), "x");
    w.ok("resources.create", json!([{ "kind": "k", "name": "stays" }])).await;

    // Replace keeps the place in the list.
    let g = w.c.ok("plugin.replaceFolder", json!({ "plugin": "t.r17", "path": s(&w.grant), "newPath": s(&third) })).await;
    assert_eq!(g["folders"], json!([s(&third), s(&second)]));
    let e = w.c.call("plugin.replaceFolder", json!({ "plugin": "t.r17", "path": "/not/granted", "newPath": s(&third) })).await.unwrap_err();
    assert_eq!(e.params["what"], "grant");
    let e = w.c.call("plugin.replaceFolder", json!({ "plugin": "t.r17", "path": s(&third), "newPath": "relative" })).await.unwrap_err();
    assert_eq!(e.params["reason"], "notAbsolute");
    // Replacing with one already listed only drops the old one.
    let g = w.c.ok("plugin.replaceFolder", json!({ "plugin": "t.r17", "path": s(&third), "newPath": s(&second) })).await;
    assert_eq!(g["folders"], json!([s(&second)]));

    // The plugin asks the shell to pick (no change yet), or removes one itself.
    assert_eq!(w.ok("files.addRoot", json!([])).await, Value::Null);
    assert_eq!(w.ok("files.replaceRoot", json!([s(&second)])).await, Value::Null);
    assert_eq!(w.err("files.replaceRoot", json!(["/not/granted"])).await, ("notFound".into(), "grant".into()));
    let r = w.ok("files.removeRoot", json!([s(&second)])).await;
    assert_eq!(r["folders"], json!([]));
    assert_eq!(w.err("files.removeRoot", json!([s(&second)])).await, ("notFound".into(), "grant".into()));
    // Removing a grant deletes neither files nor resources.
    assert!(second.join("keep.txt").exists());
    let n = w.c.ok("tree.children", json!({ "tree": "resources" })).await;
    assert!(n["nodes"].as_array().unwrap().iter().any(|n| n["label"] == "stays"));
    assert_eq!(w.err("files.list", json!([s(&second)])).await.0, "denied");

    let grants = w.audit("plugin.grantFolder");
    assert_eq!(grants.len(), 2, "{grants:?}");
    assert_eq!(grants[1], ("t.r17".to_string(), json!({ "folder": s(&second) })));
    let replaced = w.audit("plugin.replaceFolder");
    assert_eq!(replaced[0].1, json!({ "folder": s(&third), "from": s(&w.grant) }));
    assert_eq!(replaced.len(), 2);
    let revoked = w.audit("plugin.revokeFolder");
    assert_eq!(revoked, vec![("t.r17".to_string(), json!({ "folder": s(&second) }))]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn x18_pick_folder_effects_carry_replace() {
    let w = world().await;
    let c = Client::in_proc(w.env.kernel.clone());
    c.hello().await;
    let g = w.grant.display().to_string();
    w.ok("files.replaceRoot", json!([g])).await;
    let e = c.event(|e| e.topic == "ui").await;
    assert_eq!(e.payload.unwrap(), json!({ "type": "pick-folder", "plugin": "t.r17", "replace": g }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn x18_write_text_can_make_executables_and_handle_name_conflicts() {
    use std::os::unix::fs::PermissionsExt;
    let w = world().await;
    let mode = |p: &str| std::fs::metadata(w.grant.join(p)).unwrap().permissions().mode() & 0o777;
    let r = w.ok("files.writeText", json!([w.p("run.sh"), "#!/bin/sh\necho hi\n", { "executable": true }])).await;
    assert_eq!((r["path"].as_str().unwrap(), r["skipped"].as_bool().unwrap()), (w.p("run.sh").as_str(), false));
    assert_eq!(mode("run.sh"), 0o755);
    // Without options an existing file is replaced, as before (and keeps its mode).
    w.ok("files.writeText", json!([w.p("run.sh"), "#!/bin/sh\necho two\n"])).await;
    assert_eq!(mode("run.sh"), 0o755);
    assert_eq!(w.err("files.writeText", json!([w.p("run.sh"), "x", { "conflict": "fail" }])).await, ("conflict".into(), "exists".into()));
    assert_eq!(w.ok("files.writeText", json!([w.p("run.sh"), "x", { "conflict": "skip" }])).await, json!({ "skipped": true }));
    let r = w.ok("files.writeText", json!([w.p("run.sh"), "x", { "conflict": "keepBoth", "executable": true }])).await;
    assert_eq!(r["path"], w.p("run 2.sh"));
    assert_eq!(mode("run 2.sh"), 0o755);
    assert_eq!(std::fs::read_to_string(w.grant.join("run.sh")).unwrap(), "#!/bin/sh\necho two\n");
    w.ok("files.writeText", json!([w.p("plain.txt"), "x"])).await;
    assert_eq!(mode("plain.txt"), 0o644);
}

/* ------------------------------------------------------------------ X6 */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn x6_long_words_use_the_index_short_ones_match_fuzzily_all_must_hold() {
    let w = world().await;
    for (name, text) in [("alpha-xx-beta", "first"), ("Abacus", "second"), ("gamma", "has ab inside"), ("delta", "zzz")] {
        w.ok("resources.create", json!([{ "kind": "k", "name": name, "body": { "text": text } }])).await;
    }
    let names = |v: Value| -> Vec<String> {
        let mut n: Vec<String> = v.as_array().unwrap().iter().map(|h| h["title"].as_str().unwrap().to_string()).collect();
        n.sort();
        n
    };
    // Two characters, in order in the name (with others between), or as a substring elsewhere.
    assert_eq!(names(w.c.ok("search.query", json!({ "text": "ab" })).await), vec!["Abacus", "alpha-xx-beta", "gamma"]);
    // Not in order: no.
    assert_eq!(names(w.c.ok("search.query", json!({ "text": "ba" })).await), vec!["Abacus", "alpha-xx-beta"]);
    // Index for 3 characters and more, every word must hold.
    assert_eq!(names(w.c.ok("search.query", json!({ "text": "beta" })).await), vec!["alpha-xx-beta"]);
    assert_eq!(names(w.c.ok("search.query", json!({ "text": "alpha ab" })).await), vec!["alpha-xx-beta"]);
    assert_eq!(names(w.c.ok("search.query", json!({ "text": "alpha zzz" })).await), Vec::<String>::new());
    // `%` and `_` are plain characters.
    assert_eq!(names(w.c.ok("search.query", json!({ "text": "a%" })).await), Vec::<String>::new());
    // The plugin search answers the same way.
    let r = w.ok("resources.search", json!([{ "text": "ab" }])).await;
    assert_eq!(r["total"], 3);
}
