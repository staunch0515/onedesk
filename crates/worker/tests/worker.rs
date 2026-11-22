//! The worker as a real process: lock, crash safety, exit when the main process goes away.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../kernel/tests/fixtures/plugins")
}

fn spawn(ws: &Path, sock: &Path) -> Child {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_onedesk-worker"));
    // The fixture packages play the built-in ones the main process names (D313).
    for id in std::fs::read_dir(fixtures()).unwrap().flatten() {
        for v in std::fs::read_dir(id.path()).unwrap().flatten() {
            cmd.arg("--builtin").arg(format!("{}@{}", id.file_name().to_string_lossy(), v.file_name().to_string_lossy()));
        }
    }
    cmd
        .arg("--workspace")
        .arg(ws)
        .arg("--plugins")
        .arg(fixtures())
        .arg("--socket")
        .arg(sock)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        // Never the real keychain in tests.
        .env("ONEDESK_SECRET_STORE", "memory")
        .spawn()
        .unwrap()
}

struct Conn {
    write: UnixStream,
    read: BufReader<UnixStream>,
    next: u64,
}

impl Conn {
    fn open(sock: &Path, child: &mut Child) -> Conn {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(s) = UnixStream::connect(sock) {
                s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                let mut c = Conn { read: BufReader::new(s.try_clone().unwrap()), write: s, next: 1 };
                c.call("hello", json!({ "protocol": onedesk_protocol::PROTOCOL_VERSION })).unwrap();
                return c;
            }
            assert!(child.try_wait().unwrap().is_none(), "worker exited early");
            assert!(Instant::now() < deadline, "worker did not listen in time");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let id = self.next;
        self.next += 1;
        writeln!(self.write, "{}", json!({ "id": id, "method": method, "params": params })).unwrap();
        loop {
            let mut line = String::new();
            assert!(self.read.read_line(&mut line).unwrap() > 0, "connection closed");
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["id"] == id {
                return match v.get("error") {
                    Some(e) => Err(e.clone()),
                    None => Ok(v["result"].clone()),
                };
            }
        }
    }
}

fn wait_exit(child: &mut Child, within: Duration) -> std::process::ExitStatus {
    let deadline = Instant::now() + within;
    loop {
        if let Some(s) = child.try_wait().unwrap() {
            return s;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("worker did not exit in time");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn second_worker_on_the_same_workspace_exits_with_code_3() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    let mut first = spawn(&ws, &tmp.path().join("1.sock"));
    let _c = Conn::open(&tmp.path().join("1.sock"), &mut first);
    let mut second = spawn(&ws, &tmp.path().join("2.sock"));
    let status = wait_exit(&mut second, Duration::from_secs(10));
    assert_eq!(status.code(), Some(3));
    first.kill().unwrap();
    first.wait().unwrap();
}

#[test]
fn killed_worker_restarts_with_all_committed_data() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    let sock = tmp.path().join("w.sock");
    let mut w = spawn(&ws, &sock);
    let mut c = Conn::open(&sock, &mut w);
    let info = c.call("workspace.info", Value::Null).unwrap();
    let g = c.call("tree.createGroup", json!({ "tree": "resources", "name": "Kept" })).unwrap();
    let saved = c
        .call("page.save", json!({ "target": format!("new:test.alpha:item?parent={}", g["key"].as_str().unwrap()),
                                    "changes": { "body.text": "survives" } }))
        .unwrap();
    let rid = saved["page"]["resourceId"].as_str().unwrap().to_string();
    w.kill().unwrap(); // SIGKILL: no clean shutdown
    w.wait().unwrap();

    let mut w2 = spawn(&ws, &sock);
    let mut c2 = Conn::open(&sock, &mut w2);
    assert_eq!(c2.call("workspace.info", Value::Null).unwrap(), info);
    let top = c2.call("tree.children", json!({ "tree": "resources" })).unwrap();
    assert_eq!(top["nodes"][0]["label"], "Kept");
    let r = c2.call("resource.get", json!({ "id": rid })).unwrap();
    assert_eq!(r["body"]["text"], "survives");
    w2.kill().unwrap();
    w2.wait().unwrap();
}

#[test]
fn worker_exits_with_0_when_the_main_connection_closes() {
    let tmp = tempfile::tempdir().unwrap();
    let sock = tmp.path().join("w.sock");
    let mut w = spawn(&tmp.path().join("ws"), &sock);
    let mut c = Conn::open(&sock, &mut w);
    c.call("tree.createGroup", json!({ "tree": "resources", "name": "G" })).unwrap();
    drop(c);
    let status = wait_exit(&mut w, Duration::from_secs(10));
    assert_eq!(status.code(), Some(0));
    // The lock is released: a new worker opens the workspace.
    let mut w2 = spawn(&tmp.path().join("ws"), &sock);
    let mut c2 = Conn::open(&sock, &mut w2);
    assert_eq!(c2.call("tree.children", json!({ "tree": "resources" })).unwrap()["nodes"][0]["label"], "G");
    w2.kill().unwrap();
    w2.wait().unwrap();
}

#[test]
fn worker_with_bad_arguments_exits_with_1() {
    let out = Command::new(env!("CARGO_BIN_EXE_onedesk-worker")).arg("--workspace").output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(!out.stderr.is_empty());
}

/* ---------------------------------------------------------------- D340: no orphaned programs */

/// A plugins folder with one package that runs `sh` in an action.
fn program_plugins(root: &Path) -> PathBuf {
    let dir = root.join("plugins/test.prog/0.1.0");
    std::fs::create_dir_all(&dir).unwrap();
    let m = json!({ "id": "test.prog", "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js",
                    "requires": { "programs": [{ "name": "sh", "source": "system" }] },
                    "contributes": { "actions": [{ "id": "go", "label": "a", "output": "text" }] } });
    std::fs::write(dir.join("manifest.json"), m.to_string()).unwrap();
    std::fs::write(
        dir.join("main.js"),
        r#"export default { activate(host) { host.actions.handle("go", async (ctx, input) => {
             await ctx.host.process.run({ program: "sh", args: ["-c", input.script], timeoutMs: 600000 });
             return { output: { type: "text", text: "" } }; }); } };"#,
    )
    .unwrap();
    root.join("plugins")
}

fn spawn_with(ws: &Path, plugins: &Path, sock: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_onedesk-worker"))
        .arg("--builtin")
        .arg("test.prog@0.1.0")
        .arg("--workspace")
        .arg(ws)
        .arg("--plugins")
        .arg(plugins)
        .arg("--socket")
        .arg(sock)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .env("ONEDESK_SECRET_STORE", "memory")
        .spawn()
        .unwrap()
}

fn alive(pid: i32) -> bool {
    let out = Command::new("/bin/ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
    let stat = String::from_utf8_lossy(&out.stdout).trim().to_string();
    !stat.is_empty() && !stat.starts_with('Z')
}

fn eventually_dead(pid: i32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

/// Starts a run whose program leaves `sleep 100` (pid written to `pidfile`); returns its pid.
fn start_sleeper(c: &mut Conn, pidfile: &Path) -> i32 {
    let script = format!("sleep 100 & echo $! > {}; wait", pidfile.display());
    c.call("run.start", json!({ "action": "test.prog:go", "target": "core:none", "tabId": "t", "input": { "script": script } })).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(p) = std::fs::read_to_string(pidfile).unwrap_or_default().trim().parse::<i32>() {
            return p;
        }
        assert!(Instant::now() < deadline, "program did not start");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn sigterm_ends_the_programs_and_a_killed_workers_programs_end_at_the_next_start() {
    let tmp = tempfile::tempdir().unwrap();
    let plugins = program_plugins(tmp.path());
    let ws = tmp.path().join("ws");
    let sock = tmp.path().join("w.sock");
    let groups = ws.join(onedesk_kernel::process::PROCESS_GROUPS_FILE);

    // SIGTERM: the worker ends its programs and exits.
    let mut w = spawn_with(&ws, &plugins, &sock);
    let mut c = Conn::open(&sock, &mut w);
    let pid = start_sleeper(&mut c, &tmp.path().join("p1"));
    let text = std::fs::read_to_string(&groups).unwrap();
    let line: Vec<i64> = text.lines().next().unwrap().split(' ').map(|x| x.parse().unwrap()).collect();
    assert_eq!(line.len(), 3, "<pgid> <start_sec> <start_usec>: {text:?}");
    assert_eq!(Some((line[1], line[2])), onedesk_kernel::process::start_time(line[0] as i32));
    Command::new("/bin/kill").args(["-TERM", &w.id().to_string()]).status().unwrap();
    assert_eq!(wait_exit(&mut w, Duration::from_secs(10)).code(), Some(0));
    assert!(eventually_dead(pid), "the program ended with the worker");
    assert!(std::fs::read_to_string(&groups).unwrap_or_default().trim().is_empty());

    // SIGKILL: nothing can clean up at once; the next worker on this workspace does.
    let mut w = spawn_with(&ws, &plugins, &sock);
    let mut c = Conn::open(&sock, &mut w);
    let pid = start_sleeper(&mut c, &tmp.path().join("p2"));
    w.kill().unwrap();
    w.wait().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(alive(pid), "an orphan until someone cleans up");
    let mut w2 = spawn_with(&ws, &plugins, &sock);
    let _c2 = Conn::open(&sock, &mut w2);
    assert!(eventually_dead(pid), "the next worker ended it");
    w2.kill().unwrap();
    w2.wait().unwrap();
}

/// Round 19: the headless way `onedesk-mcp` uses when the application is closed — no window, one
/// socket, every request the AI client's.
#[test]
fn worker_started_for_an_ai_client_takes_every_request_as_the_ais() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, sock) = (tmp.path().join("ws"), tmp.path().join("w.sock"));
    let mut child = {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_onedesk-worker"));
        cmd.arg("--workspace").arg(&ws).arg("--plugins").arg(fixtures()).arg("--socket").arg(&sock).arg("--ai-client").arg("claude desktop")
            .stdin(Stdio::null())
            .stderr(Stdio::piped())
            .env("ONEDESK_SECRET_STORE", "memory");
        cmd.spawn().unwrap()
    };
    let mut c = Conn::open(&sock, &mut child);
    let st = c.call("mcp.status", json!({})).unwrap();
    assert_eq!(st["enabled"], false, "off until the workspace says so");
    let e = c.call("page.save", json!({ "target": "new:test.alpha:note", "changes": { "name": "x" } })).unwrap_err();
    assert_eq!(e["params"]["reason"], "aiNotAllowed", "{e}");
    let e = c.call("workspace.setConfig", json!({ "name": "mcp.enabled", "value": "true" })).unwrap_err();
    assert_eq!(e["params"]["reason"], "aiNotAllowed", "{e}");
    let e = c.call("mcp.tools", json!({})).unwrap_err();
    assert_eq!(e["params"]["reason"], "aiOff", "{e}");
    drop(c);
    assert!(wait_exit(&mut child, Duration::from_secs(10)).success(), "exits when the connection closes");
    // The audit of its refusals names who asked.
    let conn = rusqlite::Connection::open(ws.join("workspace.db")).unwrap();
    let n: i64 = conn.query_row("SELECT count(*) FROM audit WHERE actor = 'ai:claude desktop' AND op = 'mcp.refused'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1, "two refusals of one kind within a second are one row (D450)");
}
