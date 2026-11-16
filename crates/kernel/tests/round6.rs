//! Round 6 (docs/handoff/round6-plan.md §8): external programs, events, and the small items.
//! External programs: only the system's `/bin/echo`, `/bin/sh`, `/bin/sleep`, `/bin/cat` and
//! scripts written here. Every test checks that no program is left running.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use onedesk_kernel::secrets::{MemoryStore, SecretStoreHandle};
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
"#;

const CMD_MAIN: &str = r#"
const show = (r) => {
  const o = Object.assign({}, r);
  for (const k of ["stdout", "stderr"]) if (typeof o[k] === "string") { o[k + "Len"] = o[k].length; o[k] = o[k].slice(0, 4000); }
  return o;
};
const fail = (e) => ({ error: e.code || String(e), params: e.params || {} });
async function log(ctx, entry) {
  const l = (await ctx.host.storage.get("log")) || [];
  l.push(entry);
  await ctx.host.storage.set("log", l);
}
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.pages.handle("p", { async render() { return { view: [] }; } });
  host.actions.handle("run", async (ctx, input) => {
    const opts = Object.assign({}, input.opts);
    const chunks = [];
    if (input.stream) opts.onOutput = (c) => { chunks.push(c); if (input.progress) ctx.progress(0.5, c.text); };
    let out;
    try { out = { ok: show(await ctx.host.process.run(opts)) }; } catch (e) { out = fail(e); }
    out.chunks = chunks;
    return { output: { type: "text", text: JSON.stringify(out) } };
  });
  host.actions.handle("repeat", async (ctx) => {
    for (let i = 0; i < 3; i++) await ctx.host.process.run({ program: "echo", args: ["x"] });
    return { output: { type: "text", text: "done" } };
  });
  host.actions.handle("many", async (ctx) => {
    const rs = await Promise.allSettled([1, 2, 3, 4, 5].map(() => ctx.host.process.run({ program: "sleep", args: ["1"] })));
    return { output: { type: "text", text: JSON.stringify(rs.map((r) => r.status === "fulfilled" ? "ok" : (r.reason.params || {}).reason)) } };
  });
  const onEvent = async (ctx, e) => {
    const mode = (await ctx.host.storage.get("mode")) || "log";
    if (mode === "slowwrite") {
      await ctx.host.util.sleep(800);
      await ctx.host.resources.create({ kind: "cmd", name: "late" });
      return;
    }
    if (mode === "hang") { await ctx.host.util.sleep(8000); return; }
    if (mode === "throw") throw new Error("boom");
    await log(ctx, { event: ctx.event, e, count: (await ctx.host.resources.list({ kind: "cmd" })).length });
    if (mode === "write" && e.change === "created") await ctx.host.resources.create({ kind: "cmd", name: "fromHandler" });
    if (mode === "proc") {
      let r;
      try { await ctx.host.process.run({ program: "echo" }); r = "ran"; } catch (x) { r = x.code + "/" + (x.params || {}).reason; }
      let n;
      try { await ctx.host.network.request({ url: "http://127.0.0.1:9/" }); n = "ran"; } catch (x) { n = x.code + "/" + (x.params || {}).reason; }
      await log(ctx, { proc: r, net: n });
    }
  };
  host.events.on("resource.changed", onEvent);
  host.events.on("run.ended", onEvent);
} };
"#;

fn cmd_manifest() -> Value {
    json!({
        "requires": {
            "files": true,
            "secrets": { "names": ["tok"] },
            "programs": [
                { "name": "echo", "source": "system" },
                { "name": "sh", "source": "system" },
                { "name": "sleep", "source": "system" },
                { "name": "cat", "source": "system" },
                { "name": "onedesk-no-such-program", "source": "system" },
                { "name": "mine", "source": "plugin", "path": "bin/mine.sh" },
                { "name": "noexec", "source": "plugin", "path": "bin/noexec.sh" }
            ]
        },
        "contributes": {
            "kinds": [{ "id": "cmd", "label": "k", "icon": "terminal", "tree": "resources", "page": "p", "newName": "k",
                        "fields": { "text": { "type": "longtext", "refs": true, "label": "field.text" },
                                    "other": { "type": "text", "refs": true } } }],
            "pages": [{ "id": "p" }],
            "actions": [{ "id": "run", "label": "a", "output": "text" },
                        { "id": "repeat", "label": "a", "output": "text" },
                        { "id": "many", "label": "a", "output": "text" }],
            "commands": [{ "id": "probe", "label": "c" }],
            "events": ["resource.changed", "run.ended"],
            "locales": { "en-US": "locales/en-US.json" }
        }
    })
}

const OTHER_MAIN: &str = r#"
export default { activate(host) {
  host.commands.handle("probe", probe);
  host.pages.handle("p", { async render() { return { view: [] }; } });
  host.events.on("resource.changed", async (ctx, e) => {
    const l = (await ctx.host.storage.get("log")) || [];
    l.push(e);
    await ctx.host.storage.set("log", l);
  });
} };
"#;

fn other_manifest() -> Value {
    json!({ "contributes": {
        "kinds": [{ "id": "thing", "label": "k", "icon": "box", "tree": "resources", "page": "p", "newName": "k" }],
        "pages": [{ "id": "p" }],
        "commands": [{ "id": "probe", "label": "c" }],
        "events": ["resource.changed"]
    } })
}

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

fn script(path: &Path, body: &str, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn cmd_package(root: &Path, version: &str, manifest: Value) -> PathBuf {
    let dir = package(root, "test.cmd", version, manifest, &format!("{PROBE}{CMD_MAIN}"));
    std::fs::create_dir_all(dir.join("locales")).unwrap();
    std::fs::write(dir.join("locales/en-US.json"), r#"{ "field.text": "Text" }"#).unwrap();
    script(&dir.join("bin/mine.sh"), "#!/bin/sh\necho \"mine $1 $HELLO\"\n", 0o755);
    script(&dir.join("bin/noexec.sh"), "#!/bin/sh\necho no\n", 0o644);
    dir
}

struct World {
    env: Env,
    c: Client,
    plugins: PathBuf,
    secrets: Arc<MemoryStore>,
}

async fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let plugins = tmp.path().join("plugins");
    std::fs::create_dir_all(&plugins).unwrap();
    cmd_package(&plugins, "0.1.0", cmd_manifest());
    package(&plugins, "test.other", "0.1.0", other_manifest(), &format!("{PROBE}{OTHER_MAIN}"));
    let (handle, secrets) = SecretStoreHandle::memory();
    let mut cfg = test_config();
    cfg.secrets = handle;
    // 8 MB of output goes through the plugin (host answer → JSON → string).
    cfg.sandbox.memory_limit = 128 * 1024 * 1024;
    cfg.action_timeout = Duration::from_secs(20);
    let env = open_with(tmp, &plugins, cfg);
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    World { env, c, plugins, secrets }
}

impl World {
    fn ws(&self) -> PathBuf {
        self.env.kernel.db_path().parent().unwrap().to_path_buf()
    }

    /// Waits until no program started by this kernel is running any more.
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

fn db(env: &Env) -> Connection {
    Connection::open(env.kernel.db_path()).unwrap()
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

async fn start(c: &Client, action: &str, input: Value, env: Option<&str>) -> String {
    let mut p = json!({ "action": format!("test.cmd:{action}"), "target": "core:none", "tabId": "t", "input": input });
    if let Some(e) = env {
        p["envId"] = json!(e);
    }
    c.ok("run.start", p).await.as_str().unwrap().to_string()
}

/// Runs `process.run(opts)` inside an action; returns `{ok}` / `{error, params}` plus `chunks`.
async fn proc_in(c: &Client, opts: Value, env: Option<&str>) -> Value {
    let id = start(c, "run", json!({ "opts": opts }), env).await;
    let r = wait_run(c, &id).await;
    assert_eq!(r["status"], "success", "{r}");
    serde_json::from_str(r["output"]["text"].as_str().unwrap()).unwrap()
}

async fn proc(c: &Client, opts: Value) -> Value {
    proc_in(c, opts, None).await
}

fn reason(v: &Value) -> (&str, &str) {
    (v["error"].as_str().unwrap_or("ok"), v["params"]["reason"].as_str().unwrap_or(""))
}

async fn root(c: &Client, tree: &str) -> String {
    c.ok("tree.children", json!({ "tree": tree })).await["nodes"][0]["key"].as_str().unwrap().to_string()
}

async fn new_env(c: &Client, parent: &str, name: &str) -> String {
    let eff = c.ok("command.execute", json!({ "id": "env.newChild", "context": { "tree": "env", "nodeKey": parent, "args": { "name": name } } })).await;
    eff[0]["key"].as_str().unwrap().to_string()
}

fn pid_alive(pid: i32) -> bool {
    // A zombie (already ended, not yet collected) counts as gone.
    let out = std::process::Command::new("/bin/ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
    let stat = String::from_utf8_lossy(&out.stdout).trim().to_string();
    !stat.is_empty() && !stat.starts_with('Z')
}

/* ------------------------------------------------------------------ process.run */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn declared_found_and_executable_programs_only() {
    let w = world().await;
    let c = &w.c;
    let r = proc(c, json!({ "program": "echo", "args": ["hi"] })).await;
    assert_eq!(r["ok"]["stdout"], "hi\n", "{r}");
    assert_eq!((r["ok"]["code"].clone(), r["ok"]["signal"].clone(), r["ok"]["truncated"].clone()), (json!(0), Value::Null, json!(false)));
    // Not declared / not found / not executable.
    let r = proc(c, json!({ "program": "ls" })).await;
    assert_eq!(reason(&r), ("denied", "undeclaredProgram"));
    let r = proc(c, json!({ "program": "onedesk-no-such-program" })).await;
    assert_eq!((r["error"].as_str(), r["params"]["what"].as_str(), r["params"]["program"].as_str()),
               (Some("notFound"), Some("program"), Some("onedesk-no-such-program")), "{r}");
    let r = proc(c, json!({ "program": "noexec" })).await;
    assert_eq!(reason(&r), ("invalid", "notExecutable"));
    // The plugin's own program: from the package, unless it put one into plugin-data/<id>/bin.
    let r = proc(c, json!({ "program": "mine", "args": ["a"], "env": { "HELLO": "there" } })).await;
    assert_eq!(r["ok"]["stdout"], "mine a there\n", "{r}");
    script(&w.ws().join("plugin-data/test.cmd/bin/mine"), "#!/bin/sh\necho own\n", 0o755);
    assert_eq!(proc(c, json!({ "program": "mine" })).await["ok"]["stdout"], "own\n");
    // A non-zero exit is not an error; a signal gives `code: null`.
    let r = proc(c, json!({ "program": "sh", "args": ["-c", "echo out; echo err >&2; exit 3"] })).await;
    assert_eq!((r["ok"]["code"].clone(), r["ok"]["stdout"].clone(), r["ok"]["stderr"].clone()), (json!(3), json!("out\n"), json!("err\n")));
    let r = proc(c, json!({ "program": "sh", "args": ["-c", "kill -TERM $$"] })).await;
    assert_eq!((r["ok"]["code"].clone(), r["ok"]["signal"].clone()), (Value::Null, json!("SIGTERM")), "{r}");
    // stdin, and none given = closed.
    assert_eq!(proc(c, json!({ "program": "cat", "stdin": "fed in" })).await["ok"]["stdout"], "fed in");
    assert_eq!(proc(c, json!({ "program": "cat" })).await["ok"]["stdout"], "");
    w.no_programs_left().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_shell_and_no_inherited_environment() {
    // Set in the process the kernel runs in (the worker); the child must not see it.
    std::env::set_var("ONEDESK_R6_INHERITED", "leak");
    let w = world().await;
    let c = &w.c;
    let args = ["a;b", "$(echo x)", "`id`", "*", "$HOME", "&& echo y"];
    let r = proc(c, json!({ "program": "echo", "args": args })).await;
    assert_eq!(r["ok"]["stdout"], format!("{}\n", args.join(" ")), "arguments arrive as they are");
    let r = proc(c, json!({ "program": "sh", "args": ["-c", "echo \"[$ONEDESK_R6_INHERITED]\"; echo \"$X\"; echo \"$PATH\"; echo \"$TMPDIR\"; echo \"$LANG\"; env | wc -l"],
                            "env": { "X": "given", "PATH": "/evil" } }))
        .await;
    let out: Vec<String> = r["ok"]["stdout"].as_str().unwrap().lines().map(String::from).collect();
    assert_eq!(out[0], "[]");
    assert_eq!(out[1], "given");
    let data = w.ws().join("plugin-data/test.cmd");
    assert!(out[2].starts_with("/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:"), "{}", out[2]);
    assert!(out[2].contains(&data.join("bin").display().to_string()) && !out[2].contains("/evil"), "{}", out[2]);
    assert_eq!(out[3], data.join("tmp").display().to_string());
    assert_eq!(out[4], "en_US.UTF-8");
    // X, PATH, HOME, LANG, TMPDIR (+ what sh itself adds: PWD, SHLVL, _).
    assert!(out[5].trim().parse::<u32>().unwrap() <= 8, "{}", out[5]);
    w.no_programs_left().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn secrets_in_the_environment_are_substituted_and_scrubbed() {
    let w = world().await;
    let c = &w.c;
    c.ok("secrets.set", json!({ "name": "tok", "value": "TopSecret-123" })).await;
    c.ok("secrets.set", json!({ "name": "other", "value": "OtherSecret-9" })).await;
    let id = start(c, "run", json!({ "opts": { "program": "sh", "args": ["-c", "echo \"t=$T\"; echo \"$T\" >&2"], "env": { "T": "{{secret:tok}}" } },
                                    "stream": true, "progress": true }), None).await;
    let run = wait_run(c, &id).await;
    let r: Value = serde_json::from_str(run["output"]["text"].as_str().unwrap()).unwrap();
    assert_eq!((r["ok"]["stdout"].as_str(), r["ok"]["stderr"].as_str()), (Some("t=***\n"), Some("***\n")), "{r}");
    assert!(!run.to_string().contains("TopSecret-123"), "{run}");
    let chunks: String = r["chunks"].as_array().unwrap().iter().map(|c| c["text"].as_str().unwrap()).collect();
    assert!(chunks.contains("t=***") && !chunks.contains("TopSecret"), "{chunks}");
    let r = proc(c, json!({ "program": "echo", "env": { "T": "{{secret:other}}" } })).await;
    assert_eq!(reason(&r), ("denied", "secretNotAllowed"));
    // The run's record (progress, summary, output) never holds the value.
    let conn = db(&w.env);
    let stored: String = conn.query_row("SELECT coalesce(progress, '') || coalesce(output, '') || coalesce(summary, '') FROM runs WHERE id = ?1", [&id], |r| r.get(0)).unwrap();
    assert!(!stored.contains("TopSecret"), "{stored}");
    assert_eq!(w.secrets.accounts().len(), 2);
    w.no_programs_left().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn working_folder_is_the_plugins_own_or_a_granted_one() {
    let w = world().await;
    let c = &w.c;
    let data = w.ws().join("plugin-data/test.cmd").canonicalize().unwrap_or_else(|_| w.ws().join("plugin-data/test.cmd"));
    let pwd = |r: &Value| r["ok"]["stdout"].as_str().unwrap_or_default().trim().to_string();
    let r = proc(c, json!({ "program": "sh", "args": ["-c", "pwd -P"] })).await;
    let data = data.canonicalize().unwrap();
    assert_eq!(pwd(&r), data.display().to_string());
    std::fs::create_dir_all(data.join("work")).unwrap();
    assert_eq!(pwd(&proc(c, json!({ "program": "sh", "args": ["-c", "pwd -P"], "cwd": "work" })).await), data.join("work").display().to_string());
    assert_eq!(reason(&proc(c, json!({ "program": "sh", "cwd": "missing" })).await).0, "notFound");
    for outside in ["..".to_string(), "/tmp".into(), w.env.path().display().to_string(), "../test.other".into()] {
        assert_eq!(reason(&proc(c, json!({ "program": "sh", "cwd": outside })).await), ("denied", "outsideGrant"), "{outside}");
    }
    // A link inside its folder that leads out is followed and refused.
    std::os::unix::fs::symlink(w.env.path(), data.join("out")).unwrap();
    assert_eq!(reason(&proc(c, json!({ "program": "sh", "cwd": "out" })).await), ("denied", "outsideGrant"));
    // A folder the user granted to the plugin.
    let granted = w.env.path().join("granted");
    std::fs::create_dir_all(&granted).unwrap();
    c.ok("plugin.grantFolder", json!({ "plugin": "test.cmd", "path": granted.display().to_string() })).await;
    let r = proc(c, json!({ "program": "sh", "args": ["-c", "pwd -P"], "cwd": granted.display().to_string() })).await;
    assert_eq!(pwd(&r), granted.canonicalize().unwrap().display().to_string());
    w.no_programs_left().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn output_is_truncated_and_streamed_in_order() {
    let w = world().await;
    let c = &w.c;
    let r = proc(c, json!({ "program": "sh", "args": ["-c", "head -c 9000000 /dev/zero | tr '\\0' a; echo done >&2"] })).await;
    assert_eq!((r["ok"]["stdoutLen"].as_u64(), r["ok"]["truncated"].as_bool(), r["ok"]["stderr"].as_str()),
               (Some(8 * 1024 * 1024), Some(true), Some("done\n")), "{}", r["ok"]["stderr"]);
    let id = start(c, "run", json!({ "opts": { "program": "sh", "args": ["-c", "for i in 1 2 3 4 5; do echo $i; sleep 0.15; done; printf tail"] },
                                    "stream": true, "progress": true }), None).await;
    // The progress follows the output while it runs.
    let mut seen = Vec::new();
    loop {
        let r = c.ok("run.get", json!({ "id": id })).await;
        if let Some(m) = r["progress"]["message"].as_str() {
            if seen.last().map(String::as_str) != Some(m) {
                seen.push(m.to_string());
            }
        }
        if r["status"] != "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(seen.len() >= 3, "progress while running: {seen:?}");
    let run = wait_run(c, &id).await;
    let r: Value = serde_json::from_str(run["output"]["text"].as_str().unwrap()).unwrap();
    let chunks = r["chunks"].as_array().unwrap();
    assert!(chunks.len() >= 5, "line by line: {chunks:?}");
    assert!(chunks.iter().all(|c| c["stream"] == "stdout"));
    let joined: String = chunks.iter().map(|c| c["text"].as_str().unwrap()).collect();
    assert_eq!(joined, "1\n2\n3\n4\n5\ntail");
    assert_eq!(r["ok"]["stdout"], "1\n2\n3\n4\n5\ntail", "every chunk was handed out before the result");
    w.no_programs_left().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn timeouts_and_cancellation_end_the_whole_process_group() {
    let w = world().await;
    let c = &w.c;
    let t = std::time::Instant::now();
    let r = proc(c, json!({ "program": "sleep", "args": ["30"], "timeoutMs": 300 })).await;
    assert_eq!(reason(&r), ("invalid", "timeout"));
    assert!(t.elapsed() < Duration::from_secs(5));
    w.no_programs_left().await;

    let pids = w.env.path().join("pids");
    let id = start(c, "run", json!({ "opts": { "program": "sh", "args": ["-c", format!("echo $$ > {0}; sleep 100 & echo $! >> {0}; wait", pids.display())] } }), None).await;
    let list: Vec<i32> = loop {
        let text = std::fs::read_to_string(&pids).unwrap_or_default();
        let l: Vec<i32> = text.lines().filter_map(|x| x.trim().parse().ok()).collect();
        if l.len() == 2 {
            break l;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(list.iter().all(|p| pid_alive(*p)));
    c.ok("run.cancel", json!({ "id": id })).await;
    assert_eq!(wait_run(c, &id).await["status"], "cancelled");
    for _ in 0..200 {
        if list.iter().all(|p| !pid_alive(*p)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(list.iter().all(|p| !pid_alive(*p)), "child and grandchild are gone: {list:?}");
    w.no_programs_left().await;

    // A program that exits leaves nothing behind in its group either.
    let r = proc(c, json!({ "program": "sh", "args": ["-c", format!("sleep 100 > /dev/null 2>&1 & echo $! > {}", pids.display())] })).await;
    assert_eq!(r["ok"]["code"], 0);
    let left: i32 = std::fs::read_to_string(&pids).unwrap().trim().parse().unwrap();
    for _ in 0..200 {
        if !pid_alive(left) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!pid_alive(left));
    w.no_programs_left().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn at_most_four_programs_at_once_and_only_inside_a_run() {
    let w = world().await;
    let c = &w.c;
    let id = start(c, "many", json!({}), None).await;
    let r = wait_run(c, &id).await;
    let mut got: Vec<String> = serde_json::from_str(r["output"]["text"].as_str().unwrap()).unwrap();
    got.sort();
    assert_eq!(got, vec!["ok", "ok", "ok", "ok", "tooManyProcesses"]);
    // Outside a run (a command here): refused; `ready` works anywhere.
    let r = c.probe("test.cmd", "process.run", json!([{ "program": "echo" }])).await;
    assert_eq!((r["error"].as_str(), r["params"]["reason"].as_str()), (Some("denied"), Some("notInRun")));
    assert_eq!(c.probe("test.cmd", "process.ready", json!(["echo"])).await["ok"], json!({ "ready": true }));
    w.no_programs_left().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ready_tells_the_four_reasons() {
    let w = world().await;
    let c = &w.c;
    let ready = |p: &'static str| async move { c.probe("test.cmd", "process.ready", json!([p])).await["ok"].clone() };
    assert_eq!(ready("ls").await, json!({ "ready": false, "reason": "undeclaredProgram" }));
    assert_eq!(ready("onedesk-no-such-program").await, json!({ "ready": false, "reason": "notFound" }));
    assert_eq!(ready("noexec").await, json!({ "ready": false, "reason": "notExecutable" }));
    assert_eq!(ready("mine").await, json!({ "ready": true }));
    let ws = root(c, "config").await;
    c.ok("params.set", json!({ "node": ws, "name": "process.allow", "value": "sh", "type": "list" })).await;
    assert_eq!(ready("echo").await, json!({ "ready": false, "reason": "blockedByPolicy" }));
    assert_eq!(ready("sh").await, json!({ "ready": true }));
    // Not audited.
    let n: i64 = db(&w.env).query_row("SELECT count(*) FROM audit WHERE op LIKE 'process.%'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn process_allow_layers_intersect() {
    let w = world().await;
    let c = &w.c;
    let ws = root(c, "config").await;
    let env_root = root(c, "env").await;
    let prod = new_env(c, &env_root, "Prod").await;
    let prod_eu = new_env(c, &prod, "Prod EU").await;
    let echo = json!({ "program": "echo", "args": ["x"] });
    let sh = json!({ "program": "sh", "args": ["-c", "true"] });
    // Not defined anywhere: no extra limit.
    assert_eq!(proc(c, echo.clone()).await["ok"]["code"], 0);
    // Configuration lists echo, sh.
    c.ok("params.set", json!({ "node": ws, "name": "process.allow", "value": "echo\nsh", "type": "list" })).await;
    assert_eq!(proc(c, echo.clone()).await["ok"]["code"], 0);
    let r = proc(c, json!({ "program": "cat" })).await;
    assert_eq!((reason(&r), r["params"]["layer"].as_str()), (("denied", "blockedByPolicy"), Some(ws.as_str())));
    // An environment narrows it to sh (inherited by its child).
    c.ok("params.set", json!({ "node": prod, "name": "process.allow", "value": "sh, cat", "type": "list" })).await;
    let r = proc_in(c, echo.clone(), Some(&prod_eu)).await;
    assert_eq!((reason(&r), r["params"]["layer"].as_str()), (("denied", "blockedByPolicy"), Some(prod.as_str())));
    assert_eq!(proc_in(c, sh.clone(), Some(&prod_eu)).await["ok"]["code"], 0);
    // cat is in the environment's list but not in the configuration's: the intersection refuses it.
    assert_eq!(reason(&proc_in(c, json!({ "program": "cat" }), Some(&prod)).await), ("denied", "blockedByPolicy"));
    assert_eq!(proc(c, echo.clone()).await["ok"]["code"], 0, "without that environment");
    // The environment page marks a name the configuration does not list.
    let page = c.ok("params.env", json!({ "envId": prod })).await;
    assert!(page.to_string().contains("restrictedByUpperLayer"), "cat is not in the configuration's list");
    // An empty list forbids every program.
    c.ok("params.set", json!({ "node": ws, "name": "process.allow", "value": "", "type": "list" })).await;
    assert_eq!(reason(&proc(c, echo.clone()).await), ("denied", "blockedByPolicy"));
    assert_eq!(reason(&proc(c, sh.clone()).await), ("denied", "blockedByPolicy"));
    w.no_programs_left().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_run_is_audited_and_repeats_are_counted() {
    let w = world().await;
    let c = &w.c;
    let id = start(c, "repeat", json!({}), None).await;
    assert_eq!(wait_run(c, &id).await["status"], "success");
    let conn = db(&w.env);
    let rows: Vec<(String, String, String)> = conn
        .prepare("SELECT object, summary, result FROM audit WHERE op = 'process.run' ORDER BY seq")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!((rows[0].0.as_str(), rows[0].2.as_str()), ("echo", "ok"));
    let summary: Value = serde_json::from_str(&rows[0].1).unwrap();
    assert_eq!((summary["args"].clone(), summary["code"].clone()), (json!(1), json!(0)));
    assert!(summary.get("ms").is_some() && !rows[0].1.contains("\"x\""), "no argument contents: {summary}");
    let count: i64 = conn.query_row("SELECT count FROM audit_counts WHERE run_id = ?1 AND op = 'process.run'", [&id], |r| r.get(0)).unwrap();
    assert_eq!(count, 3);
    // Refusals are audited too.
    proc(c, json!({ "program": "ls" })).await;
    let refused: String = conn
        .query_row("SELECT result FROM audit WHERE op = 'process.run' AND object = 'ls'", [], |r| r.get(0))
        .unwrap();
    assert!(refused.starts_with("failed"), "{refused}");
    w.no_programs_left().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn more_programs_in_a_new_version_need_a_new_confirmation() {
    let w = world().await;
    let c = &w.c;
    let fp1 = c.ok("plugin.get", json!({ "plugin": "test.cmd" })).await["versions"][0]["fingerprint"].clone();
    let mut m = cmd_manifest();
    m["requires"]["programs"].as_array_mut().unwrap().push(json!({ "name": "date", "source": "system" }));
    m["upgradesFrom"] = json!(">=0.1.0");
    cmd_package(&w.plugins, "0.2.0", m);
    c.ok("plugin.rescan", Value::Null).await;
    let d = c.ok("plugin.get", json!({ "plugin": "test.cmd" })).await;
    assert_eq!(d["unconfirmed"], json!(["0.2.0"]));
    let v2 = d["versions"].as_array().unwrap().iter().find(|v| v["version"] == "0.2.0").unwrap().clone();
    assert_ne!(v2["fingerprint"], fp1);
    let perms = d["permissions"].as_array().unwrap().iter().find(|p| p["id"] == "programs").unwrap().clone();
    assert!(perms["detail"].as_str().unwrap().contains("mine (plugin)"), "{perms}");
    assert_eq!(c.ok("plugin.get", json!({ "plugin": "test.cmd" })).await["versions"].as_array().unwrap().iter().find(|v| v["active"] == true).map(|v| v["version"].clone()), Some(json!("0.1.0")));
}

/* ------------------------------------------------------------------ events */

async fn storage(c: &Client, plugin: &str, key: &str) -> Value {
    c.probe(plugin, "storage.get", json!([key])).await["ok"].clone()
}

/// Waits until the plugin's `log` has at least `n` entries.
async fn log_len(c: &Client, plugin: &str, n: usize) -> Vec<Value> {
    for _ in 0..300 {
        let l = storage(c, plugin, "log").await;
        if l.as_array().is_some_and(|a| a.len() >= n) {
            return l.as_array().unwrap().clone();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{plugin}: log has not {n} entries: {}", storage(c, plugin, "log").await);
}

async fn new_cmd(c: &Client, name: &str, text: &str) -> String {
    let r = c.ok("page.save", json!({ "target": "new:test.cmd:cmd", "changes": { "name": name, "body.text": text } })).await;
    r["page"]["resourceId"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resource_changes_of_its_own_kinds_in_order_after_commit() {
    let w = world().await;
    let c = &w.c;
    let a = new_cmd(c, "A", "").await;
    let l = log_len(c, "test.cmd", 1).await;
    assert_eq!(l[0]["event"], "resource.changed");
    assert_eq!(l[0]["e"], json!({ "id": a, "kind": "test.cmd:cmd", "change": "created" }));
    assert_eq!(l[0]["count"], 1, "delivered after the commit: the handler sees the new resource");
    c.ok("page.save", json!({ "target": format!("resource:{a}"), "changes": { "body.text": "x" } })).await;
    c.ok("resource.delete", json!({ "id": a })).await;
    c.ok("resource.undelete", json!({ "id": a })).await;
    c.ok("resource.delete", json!({ "id": a })).await;
    c.ok("resource.purge", json!({ "id": a })).await;
    let l = log_len(c, "test.cmd", 6).await;
    let changes: Vec<&str> = l.iter().map(|e| e["e"]["change"].as_str().unwrap()).collect();
    assert_eq!(changes, ["created", "updated", "deleted", "restored", "deleted", "purged"]);
    // Another plugin's resources and kernel nodes are not delivered to it, nor its to the other.
    let t = c.ok("page.save", json!({ "target": "new:test.other:thing", "changes": { "name": "T" } })).await;
    let t = t["page"]["resourceId"].as_str().unwrap().to_string();
    c.ok("command.execute", json!({ "id": "node.newGroup", "context": { "tree": "resources", "args": { "name": "G" } } })).await;
    let other = log_len(c, "test.other", 1).await;
    assert_eq!(other, vec![json!({ "id": t, "kind": "test.other:thing", "change": "created" })]);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(storage(c, "test.cmd", "log").await.as_array().unwrap().len(), 6);
    assert_eq!(storage(c, "test.other", "log").await.as_array().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_ended_reaches_the_plugin_of_the_action() {
    let w = world().await;
    let c = &w.c;
    let id = start(c, "run", json!({ "opts": { "program": "echo" } }), None).await;
    wait_run(c, &id).await;
    let l = log_len(c, "test.cmd", 1).await;
    assert_eq!(l[0]["event"], "run.ended");
    assert_eq!(l[0]["e"], json!({ "run": id, "action": "run", "status": "success" }));
    // With a resource; a failed run.
    let a = new_cmd(c, "A", "").await;
    log_len(c, "test.cmd", 2).await;
    let id2 = c
        .ok("run.start", json!({ "action": "test.cmd:run", "resourceId": a, "target": format!("resource:{a}"), "tabId": "t", "input": {} }))
        .await;
    wait_run(c, id2.as_str().unwrap()).await;
    let l = log_len(c, "test.cmd", 3).await;
    assert_eq!(l[2]["e"]["resource"], json!(a));
    assert_eq!(l[2]["e"]["run"], id2);
    // The other plugin hears nothing about it.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(storage(c, "test.other", "log").await.is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_handlers_own_writes_are_not_delivered_back_and_programs_are_refused_there() {
    let w = world().await;
    let c = &w.c;
    c.probe("test.cmd", "storage.set", json!(["mode", "write"])).await;
    new_cmd(c, "A", "").await;
    log_len(c, "test.cmd", 1).await;
    // The handler created "fromHandler"; that is not delivered to test.cmd again.
    for _ in 0..100 {
        let names: Vec<String> = c.ok("tree.children", json!({ "tree": "resources" })).await["nodes"].as_array().unwrap().iter().map(|n| n["label"].as_str().unwrap().to_string()).collect();
        if names.contains(&"fromHandler".to_string()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
    let l = storage(c, "test.cmd", "log").await;
    assert_eq!(l.as_array().unwrap().len(), 1, "{l}");
    let n: i64 = db(&w.env).query_row("SELECT count(*) FROM resources WHERE name = 'fromHandler'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1, "no loop");
    // No programs, no network inside a handler.
    c.probe("test.cmd", "storage.set", json!(["mode", "proc"])).await;
    new_cmd(c, "B", "").await;
    let l = log_len(c, "test.cmd", 3).await;
    assert_eq!(l[2], json!({ "proc": "denied/notInRun", "net": "denied/notInRun" }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failing_or_slow_handlers_do_not_affect_the_write() {
    let w = world().await;
    let c = &w.c;
    c.probe("test.cmd", "storage.set", json!(["mode", "throw"])).await;
    let t = std::time::Instant::now();
    let a = new_cmd(c, "A", "").await;
    c.ok("resource.get", json!({ "id": a })).await;
    let failed = |w: &World| -> Vec<(String, String)> {
        db(&w.env)
            .prepare("SELECT object, result FROM audit WHERE op = 'events.failed' ORDER BY seq")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    for _ in 0..200 {
        if !failed(&w).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(failed(&w).len(), 1);
    assert_eq!(failed(&w)[0].0, "test.cmd");
    // A handler that takes longer than 5 s is stopped; the write had answered long before.
    c.probe("test.cmd", "storage.set", json!(["mode", "hang"])).await;
    let t2 = std::time::Instant::now();
    new_cmd(c, "B", "").await;
    assert!(t2.elapsed() < Duration::from_secs(2), "the write does not wait for the handler");
    for _ in 0..400 {
        if failed(&w).len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let f = failed(&w);
    assert_eq!(f.len(), 2, "{f:?}");
    let reason: String = db(&w.env)
        .query_row("SELECT result FROM audit WHERE op = 'events.failed' ORDER BY seq DESC LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert!(reason.contains("pluginTimeout") || reason.contains("timeout"), "{reason}");
    assert!(t.elapsed() >= Duration::from_secs(5));
    // The plugin works again afterwards.
    c.probe("test.cmd", "storage.set", json!(["mode", "log"])).await;
    new_cmd(c, "C", "").await;
    log_len(c, "test.cmd", 1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disabled_and_unconfirmed_get_nothing_and_readonly_refuses_handler_writes() {
    let w = world().await;
    let c = &w.c;
    c.ok("plugin.setEnabled", json!({ "plugin": "test.other", "enabled": false })).await;
    let t = c.ok("page.save", json!({ "target": "new:test.cmd:cmd", "changes": { "name": "A" } })).await;
    let a = t["page"]["resourceId"].as_str().unwrap().to_string();
    log_len(c, "test.cmd", 1).await;
    // test.other is disabled: it cannot even be asked; enabling it later delivers nothing old.
    c.ok("plugin.setEnabled", json!({ "plugin": "test.other", "enabled": true })).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(storage(c, "test.other", "log").await.is_null());

    // A newer version that is not confirmed does not receive events: the confirmed one still does.
    let mut m = cmd_manifest();
    m["requires"]["programs"].as_array_mut().unwrap().push(json!({ "name": "date", "source": "system" }));
    let dir = cmd_package(&w.plugins, "0.2.0", m);
    std::fs::write(dir.join("main.js"), format!("{PROBE}{}", CMD_MAIN.replace("event: ctx.event", "event: 'v2:' + ctx.event"))).unwrap();
    c.ok("plugin.rescan", Value::Null).await;
    c.ok("page.save", json!({ "target": format!("resource:{a}"), "changes": { "body.text": "y" } })).await;
    let l = log_len(c, "test.cmd", 2).await;
    assert_eq!(l[1]["event"], "resource.changed", "the confirmed 0.1.0 handled it");

    // Read-only: the handler is called, its write is refused.
    c.probe("test.cmd", "storage.set", json!(["mode", "slowwrite"])).await;
    new_cmd(c, "B", "").await;
    let ws = root(c, "config").await;
    c.ok("params.set", json!({ "node": ws, "name": "protection.readonly", "value": "true", "type": "boolean" })).await;
    let refused = || -> Option<String> {
        db(&w.env).query_row("SELECT result FROM audit WHERE op = 'events.failed'", [], |r| r.get(0)).ok()
    };
    for _ in 0..300 {
        if refused().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(refused().is_some_and(|r| r.contains("denied")), "{:?}", refused());
    let late: i64 = db(&w.env).query_row("SELECT count(*) FROM resources WHERE name = 'late'", [], |r| r.get(0)).unwrap();
    assert_eq!(late, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_event_activates_a_subscribed_plugin_and_announces_its_page() {
    let tmp = tempfile::tempdir().unwrap();
    let plugins = tmp.path().join("plugins");
    package(&plugins, "test.other", "0.1.0", other_manifest(), &format!("{PROBE}{OTHER_MAIN}"));
    let ws_dir = tmp.path().join("ws");
    let id = {
        let k = Arc::new(onedesk_kernel::Kernel::open(&ws_dir, &plugins, config_for(&plugins)).unwrap());
        let c = Client::in_proc(k.clone());
        c.hello().await;
        let t = c.ok("page.save", json!({ "target": "new:test.other:thing", "changes": { "name": "T" } })).await;
        log_len(&c, "test.other", 1).await;
        k.shutdown();
        t["page"]["resourceId"].as_str().unwrap().to_string()
    };
    let k = Arc::new(onedesk_kernel::Kernel::open(&ws_dir, &plugins, config_for(&plugins)).unwrap());
    let c = Client::in_proc(k.clone());
    c.hello().await;
    assert!(!k.active_plugins().contains(&"test.other".to_string()));
    c.ok("resource.delete", json!({ "id": id })).await;
    let e = c.event(|e| e.topic == "plugin:test.other").await;
    assert!(e.payload.is_none());
    assert!(k.active_plugins().contains(&"test.other".to_string()), "activated by the event");
    let l = log_len(&c, "test.other", 2).await;
    assert_eq!(l[1]["change"], "deleted");
    k.shutdown();
}

/* ------------------------------------------------------------------ small items */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_automatic_switch_is_recorded_until_resolved() {
    let w = world().await;
    let c = &w.c;
    new_cmd(c, "A", "").await;
    let mut m = cmd_manifest();
    m["upgradesFrom"] = json!(">=0.1.0");
    let dir = cmd_package(&w.plugins, "0.2.0", m);
    std::fs::write(
        dir.join("main.js"),
        format!("{PROBE}{}", CMD_MAIN.replace("host.actions.handle(\"run\"", "host.kinds.handle(\"cmd\", { migrate() { throw new Error(\"no\"); } });\n  host.actions.handle(\"run\"")),
    )
    .unwrap();
    // Same permissions as 0.1.0: confirmed already, so it tries to take over at once.
    c.ok("plugin.rescan", Value::Null).await;
    let d = c.ok("plugin.get", json!({ "plugin": "test.cmd" })).await;
    let f = &d["switchFailure"];
    assert_eq!((f["version"].as_str(), f["reason"].as_str()), (Some("0.2.0"), Some("migrateFailed")), "{d}");
    assert!(f["at"].as_i64().unwrap() > 0);
    let tree = c.ok("tree.children", json!({ "tree": "plugins" })).await;
    let node = tree["nodes"].as_array().unwrap().iter().find(|n| n["key"] == "test.cmd").unwrap().clone();
    assert_eq!(node["stateReason"], "switchFailed");
    // The user deals with it (pins the version in use): cleared.
    c.ok("plugin.setPinned", json!({ "plugin": "test.cmd", "version": "0.1.0", "pinned": true })).await;
    let d = c.ok("plugin.get", json!({ "plugin": "test.cmd" })).await;
    assert!(d.get("switchFailure").is_none(), "{d}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn references_carry_the_field_label_and_deleted_targets_list_theirs() {
    let w = world().await;
    let c = &w.c;
    let b = new_cmd(c, "B", "").await;
    let a = c.ok("page.save", json!({ "target": "new:test.cmd:cmd", "changes": { "name": "A", "body.text": "see [[B]]", "body.other": "[[B]]" } })).await;
    let a = a["page"]["resourceId"].as_str().unwrap().to_string();
    let inc = c.ok("refs.incoming", json!({ "id": b })).await;
    let by_field = |v: &Value, f: &str| v.as_array().unwrap().iter().find(|r| r["field"] == f).cloned().unwrap();
    assert_eq!(by_field(&inc, "body.text")["fieldLabel"], json!({ "en-US": "Text" }));
    assert!(by_field(&inc, "body.other").get("fieldLabel").is_none(), "no label declared: none given");
    assert_eq!(by_field(&c.ok("refs.outgoing", json!({ "id": a })).await, "body.text")["fieldLabel"], json!({ "en-US": "Text" }));
    // A deleted target still lists who points at it (for the purge confirmation).
    c.ok("resource.delete", json!({ "id": b })).await;
    let inc = c.ok("refs.incoming", json!({ "id": b })).await;
    assert_eq!(inc.as_array().unwrap().len(), 2);
    assert_eq!(inc[0]["source"]["id"], json!(a));
    assert_eq!(inc[0]["state"], "deleted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutting_down_ends_running_programs() {
    let w = world().await;
    let c = &w.c;
    let pids = w.env.path().join("pids");
    let id = start(c, "run", json!({ "opts": { "program": "sh", "args": ["-c", format!("sleep 100 & echo $! > {}; wait", pids.display())] } }), None).await;
    let pid: i32 = loop {
        if let Ok(p) = std::fs::read_to_string(&pids).unwrap_or_default().trim().parse() {
            break p;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(pid_alive(pid));
    let _ = id;
    w.env.kernel.shutdown();
    for _ in 0..200 {
        if !pid_alive(pid) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!pid_alive(pid), "the worker leaves no program behind");
    assert_eq!(w.env.kernel.live_programs(), 0);
}
