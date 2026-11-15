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
