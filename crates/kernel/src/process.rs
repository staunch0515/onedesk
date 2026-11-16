//! `ctx.host.process` (round 6 §4, D331–D334): runs a program the manifest declares by name.
//!
//! - Only inside a run; the arguments are an argument vector (no shell); the environment is only
//!   what the call gives plus four variables the kernel sets (nothing is inherited).
//! - Every program runs in its own process group; cancelling the run, a timeout, or the worker
//!   shutting down ends the whole group (SIGTERM, SIGKILL 2 s later). When the program exits,
//!   whatever it left behind in its group is killed too (a call runs to its end, no daemons).
//! - Output: stdout / stderr kept up to 8 MB each, decoded leniently as UTF-8; with `onOutput` the
//!   output is also handed out as it comes (whole lines, or every 100 ms) through a stream the
//!   plugin's side polls (`process.output`), see the sandbox bootstrap.
//! - `process.allow` narrows the names per configuration node and environment (D334).

use std::collections::{HashMap, HashSet, VecDeque};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use onedesk_protocol::*;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};

use crate::kernel::Inner;
use crate::manifest::{Plugin, PROGRAM_PLUGIN};
use crate::pipeline::Command;
use crate::sandbox::CallInfo;
use crate::store;
use crate::util::*;

/// D331: where system programs are looked for, in this order. PATH is never read.
pub const SYSTEM_DIRS: &[&str] = &["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/opt/homebrew/bin"];
/// D334: the allow list of program names (configuration and environment layers).
pub const ALLOW_PARAM: &str = "process.allow";
pub const MAX_ARGS: usize = 256;
pub const MAX_ARGS_BYTES: usize = 256 * 1024;
pub const MAX_STDIN: usize = 8 * 1024 * 1024;
pub const MAX_OUTPUT: usize = 8 * 1024 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
/// Programs running at the same time within one run.
pub const MAX_CONCURRENT: usize = 4;
/// SIGTERM, then SIGKILL this much later (D333).
pub const KILL_GRACE: Duration = Duration::from_secs(2);
/// Partial lines are handed out at least this often.
pub const FLUSH_EVERY: Duration = Duration::from_millis(100);
/// After the program exited, how long to wait for output still in the pipes (held open by
/// something it left running) before that is killed.
pub const EXIT_GRACE: Duration = Duration::from_millis(500);
/// The plugin's own folder inside the workspace (§7.5).
pub const PLUGIN_DATA: &str = "plugin-data";

/// Why a program is not ready (`ready()` and the matching refusals of `run()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotReady {
    UndeclaredProgram,
    NotFound,
    NotExecutable,
    BlockedByPolicy,
}

impl NotReady {
    pub fn reason(self) -> &'static str {
        match self {
            NotReady::UndeclaredProgram => "undeclaredProgram",
            NotReady::NotFound => "notFound",
            NotReady::NotExecutable => "notExecutable",
            NotReady::BlockedByPolicy => "blockedByPolicy",
        }
    }
}

/// Programs of one kernel: live process groups (for shutdown), counts per run, output streams.
#[derive(Default)]
pub struct Procs {
    live: Mutex<HashSet<i32>>,
    per_run: Mutex<HashMap<String, usize>>,
    streams: Mutex<HashMap<String, Arc<Stream>>>,
}

/// Output handed out while a program runs (polled by the plugin's `onOutput` pump).
#[derive(Default)]
pub struct Stream {
    queue: Mutex<VecDeque<Value>>,
    closed: AtomicBool,
    notify: Notify,
    stop: AtomicBool,
    stop_notify: Notify,
}

impl Stream {
    fn push(&self, v: Value) {
        self.queue.lock().unwrap().push_back(v);
        self.notify.notify_waiters();
    }
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    async fn stopped(&self) {
        loop {
            let n = self.stop_notify.notified();
            if self.stop.load(Ordering::SeqCst) {
                return;
            }
            n.await;
        }
    }
}

impl Procs {
    fn stream(&self, run: &str, sid: &str) -> Arc<Stream> {
        self.streams.lock().unwrap().entry(format!("{run}\n{sid}")).or_default().clone()
    }

    /// Forgets the streams of a run that ended.
    pub fn forget_run(&self, run: &str) {
        let prefix = format!("{run}\n");
        self.streams.lock().unwrap().retain(|k, _| !k.starts_with(&prefix));
        self.per_run.lock().unwrap().retain(|k, n| k != run || *n > 0);
    }

    /// Kills every process group still running (the worker is shutting down).
    pub fn kill_all(&self) {
        for pg in self.live.lock().unwrap().drain() {
            // SAFETY: plain system call on a process group id we created.
            unsafe { libc::killpg(pg, libc::SIGKILL) };
        }
    }

    /// Process groups still alive (tests).
    pub fn live_count(&self) -> usize {
        self.live.lock().unwrap().len()
    }
}

/// A running program's process group; dropping it ends the group (cancel, timeout, error).
struct Group {
    pgid: i32,
    procs: Arc<Procs>,
    run: String,
    /// The program exited and its output was read: leftovers are killed at once.
    finished: bool,
}

impl Drop for Group {
    fn drop(&mut self) {
        if let Some(n) = self.procs.per_run.lock().unwrap().get_mut(&self.run) {
            *n = n.saturating_sub(1);
        }
        let pg = self.pgid;
        if self.finished {
            // SAFETY: plain system calls on a process group id we created.
            unsafe { libc::killpg(pg, libc::SIGKILL) };
            self.procs.live.lock().unwrap().remove(&pg);
            return;
        }
        // SAFETY: as above.
        unsafe { libc::killpg(pg, libc::SIGTERM) };
        let procs = self.procs.clone();
        std::thread::spawn(move || {
            std::thread::sleep(KILL_GRACE);
            // Only if nobody (shutdown) took care of it meanwhile.
            if procs.live.lock().unwrap().remove(&pg) {
                // SAFETY: as above.
                unsafe { libc::killpg(pg, libc::SIGKILL) };
            }
        });
    }
}

fn is_executable(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The first existing candidate, or why there is none.
fn pick(candidates: &[PathBuf]) -> Result<PathBuf, NotReady> {
    match candidates.iter().find(|c| c.is_file()) {
        Some(c) if is_executable(c) => Ok(c.clone()),
        Some(_) => Err(NotReady::NotExecutable),
        None => Err(NotReady::NotFound),
    }
}

/// Signal names for `signal` (others as `SIG<n>`).
fn signal_name(n: i32) -> String {
    let name = match n {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGABRT => "SIGABRT",
        libc::SIGKILL => "SIGKILL",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGBUS => "SIGBUS",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGUSR2 => "SIGUSR2",
        _ => return format!("SIG{n}"),
    };
    name.to_string()
}

/// What was read so far, and what is still to hand out.
struct Out {
    buf: [Vec<u8>; 2],
    truncated: bool,
    pending: [Vec<u8>; 2],
    streamed: [usize; 2],
    stream: Option<Arc<Stream>>,
    secrets: Vec<String>,
}

const STREAMS: [&str; 2] = ["stdout", "stderr"];

impl Out {
    fn push(&mut self, s: usize, bytes: &[u8]) {
        let room = MAX_OUTPUT - self.buf[s].len();
        if bytes.len() > room {
            self.buf[s].extend_from_slice(&bytes[..room]);
            self.truncated = true;
        } else {
            self.buf[s].extend_from_slice(bytes);
        }
        if self.stream.is_some() {
            self.pending[s].extend_from_slice(bytes);
            if let Some(i) = self.pending[s].iter().rposition(|b| *b == b'\n') {
                let line: Vec<u8> = self.pending[s].drain(..=i).collect();
                self.emit(s, &line);
            }
        }
    }

    /// Partial lines that waited a tick (cut at a whole UTF-8 character).
    fn flush(&mut self, all: bool) {
        for s in 0..2 {
            if self.pending[s].is_empty() {
                continue;
            }
            let upto = match std::str::from_utf8(&self.pending[s]) {
                Ok(_) => self.pending[s].len(),
                Err(e) if all || e.error_len().is_some() || e.valid_up_to() == 0 && self.pending[s].len() >= 4 => self.pending[s].len(),
                Err(e) => e.valid_up_to(),
            };
            if upto > 0 {
                let part: Vec<u8> = self.pending[s].drain(..upto).collect();
                self.emit(s, &part);
            }
        }
    }

    fn emit(&mut self, s: usize, bytes: &[u8]) {
        let Some(st) = &self.stream else { return };
        if self.streamed[s] >= MAX_OUTPUT {
            return;
        }
        let take = bytes.len().min(MAX_OUTPUT - self.streamed[s]);
        self.streamed[s] += take;
        let mut v = json!({ "stream": STREAMS[s], "text": String::from_utf8_lossy(&bytes[..take]) });
        crate::secrets::scrub(&mut v, &self.secrets);
        st.push(v);
    }
}

/// A call's options, checked.
struct Spec {
    program: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<String>,
    stdin: Option<String>,
    timeout: Duration,
}

fn parse_spec(o: &Value) -> KResult<Spec> {
    let o = o.as_object().ok_or_else(|| invalid_params("options must be an object"))?;
    let program = o.get("program").and_then(Value::as_str).ok_or_else(|| invalid_params("program"))?.to_string();
    let args: Vec<String> = match o.get("args") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(String::from).ok_or_else(|| invalid_params("args must be strings"))).collect::<KResult<_>>()?,
        Some(_) => return Err(invalid_params("args must be an array")),
    };
    if args.len() > MAX_ARGS || args.iter().map(|a| a.len()).sum::<usize>() > MAX_ARGS_BYTES || args.iter().any(|a| a.contains('\0')) {
        return Err(invalid("badArgs"));
    }
    let env: Vec<(String, String)> = match o.get("env") {
        None | Some(Value::Null) => vec![],
        Some(Value::Object(m)) => m
            .iter()
            .map(|(k, v)| {
                let v = v.as_str().map(String::from).ok_or_else(|| invalid_params("env values must be strings"))?;
                if k.is_empty() || k.contains('=') || k.contains('\0') || v.contains('\0') {
                    return Err(invalid("badEnv"));
                }
                Ok((k.clone(), v))
            })
            .collect::<KResult<_>>()?,
        Some(_) => return Err(invalid_params("env must be an object")),
    };
    let cwd = match o.get("cwd") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(invalid_params("cwd must be a string")),
    };
    let stdin = match o.get("stdin") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.len() <= MAX_STDIN => Some(s.clone()),
        Some(Value::String(_)) => return Err(invalid("tooLarge")),
        Some(_) => return Err(invalid_params("stdin must be a string")),
    };
    let timeout = match o.get("timeoutMs") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_MS,
        Some(v) => v.as_f64().ok_or_else(|| invalid_params("timeoutMs"))?.clamp(1.0, MAX_TIMEOUT_MS as f64) as u64,
    };
    Ok(Spec { program, args, env, cwd, stdin, timeout: Duration::from_millis(timeout) })
}

impl Inner {
    /// `plugin-data/<id>/` (created on first use, with `bin/` and `tmp/`).
    pub fn plugin_data_dir(&self, plugin: &str) -> KResult<PathBuf> {
        let d = self.ws.dir.join(PLUGIN_DATA).join(plugin);
        for sub in ["bin", "tmp"] {
            std::fs::create_dir_all(d.join(sub)).map_err(internal)?;
        }
        Ok(d)
    }

    /// Where a declared program is (D331).
    fn locate(&self, p: &Plugin, name: &str) -> Result<PathBuf, NotReady> {
        let decl = p.program(name).ok_or(NotReady::UndeclaredProgram)?;
        if decl.source == PROGRAM_PLUGIN {
            let own = self.ws.dir.join(PLUGIN_DATA).join(&p.id).join("bin").join(name);
            let mut c = vec![own];
            if let Some(pkg) = decl.path.as_deref().and_then(|rel| crate::manifest::package_program(&p.dir, rel)) {
                c.push(pkg);
            }
            pick(&c)
        } else {
            pick(&SYSTEM_DIRS.iter().map(|d| Path::new(d).join(name)).collect::<Vec<_>>())
        }
    }

    /// D334: the first `process.allow` layer that does not list `name` (an empty list lists nothing).
    fn process_blocked(&self, env: Option<&str>, name: &str) -> KResult<Option<String>> {
        let mut layers: Vec<store::Row> = self.read(|c| store::of_kind(c, store::KIND_CONFIG))?;
        layers.sort_by_key(|r| r.parent_id.is_some());
        if let Some(e) = env.and_then(|e| self.read(|c| store::get(c, e)).ok().flatten()).filter(|r| r.kind == store::KIND_ENV) {
            let mut chain = self.read(|c| store::ancestors(c, &e))?;
            chain.push(e);
            layers.extend(chain.into_iter().filter(|r| r.deleted_at.is_none()));
        }
        for r in layers {
            if let Some(p) = crate::params::get(&r, ALLOW_PARAM) {
                if !crate::network::allow_list(&p.value).iter().any(|n| n == name) {
                    return Ok(Some(r.id.clone()));
                }
            }
        }
        Ok(None)
    }

    /// `EnvParam.restricted` for `process.allow`: a name an upper layer does not list.
    pub fn process_allow_restricted(&self, env: &store::Row, ancestors: &[store::Row]) -> bool {
        let Some(own) = crate::params::get(env, ALLOW_PARAM) else { return false };
        let mut uppers: Vec<store::Row> = self.read(|c| store::of_kind(c, store::KIND_CONFIG)).unwrap_or_default();
        uppers.extend(ancestors.iter().cloned());
        let lists: Vec<Vec<String>> =
            uppers.iter().filter_map(|r| crate::params::get(r, ALLOW_PARAM)).map(|p| crate::network::allow_list(&p.value)).collect();
        crate::network::allow_list(&own.value).iter().any(|n| lists.iter().any(|l| !l.contains(n)))
    }

    fn check_program(&self, p: &Plugin, env: Option<&str>, name: &str) -> KResult<Result<PathBuf, (NotReady, Option<String>)>> {
        if p.program(name).is_none() {
            return Ok(Err((NotReady::UndeclaredProgram, None)));
        }
        if let Some(layer) = self.process_blocked(env, name)? {
            return Ok(Err((NotReady::BlockedByPolicy, Some(layer))));
        }
        Ok(self.locate(p, name).map_err(|r| (r, None)))
    }

    fn not_ready_error(name: &str, r: NotReady, layer: Option<String>) -> ProtocolError {
        match r {
            NotReady::UndeclaredProgram => err_p(ErrorCode::Denied, &[("reason", "undeclaredProgram"), ("program", name)]),
            NotReady::BlockedByPolicy => {
                err_p(ErrorCode::Denied, &[("reason", "blockedByPolicy"), ("program", name), ("layer", layer.as_deref().unwrap_or_default())])
            }
            NotReady::NotFound => err_p(ErrorCode::NotFound, &[("what", "program"), ("program", name)]),
            NotReady::NotExecutable => err_p(ErrorCode::Invalid, &[("reason", "notExecutable"), ("program", name)]),
        }
    }

    pub async fn host_process(&self, p: &'static Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        match op {
            // Any context; a pure query, not audited.
            "ready" => {
                let name = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("program"))?;
                Ok(match self.check_program(p, info.env_id.as_deref(), name)? {
                    Ok(_) => json!({ "ready": true }),
                    Err((r, _)) => json!({ "ready": false, "reason": r.reason() }),
                })
            }
            "run" => {
                let o = args.get(0).cloned().unwrap_or(Value::Null);
                let program = o.get("program").and_then(Value::as_str).unwrap_or_default().to_string();
                let started = Instant::now();
                let res = self.process_run(p, info, &o).await;
                // One audit row per run and program, repeats counted (D309's table); refusals and
                // failures each get their own row.
                match &res {
                    Ok(v) => {
                        let mut summary = json!({ "args": o.get("args").and_then(Value::as_array).map_or(0, |a| a.len()),
                                                  "ms": started.elapsed().as_millis() as u64 });
                        if let Some(s) = v.get("signal").filter(|s| !s.is_null()) {
                            summary["signal"] = s.clone();
                        } else {
                            summary["code"] = v.get("code").cloned().unwrap_or(Value::Null);
                        }
                        let cmd = Command::CountedAudit { run: info.run_id.clone(), op: "process.run".into(), object: program, summary };
                        let _ = self.pipeline.execute(p.actor(), cmd).await;
                    }
                    Err(e) => {
                        let cmd = Command::Refused { op: "process.run".into(), object: program, error: e.clone() };
                        let _ = self.pipeline.execute(p.actor(), cmd).await;
                    }
                }
                self.emit(topic2::AUDIT, None, None);
                res
            }
            "output" => {
                let run = info.run_id.as_deref().ok_or_else(|| denied("notInRun"))?;
                let sid = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("stream"))?;
                let st = self.procs.stream(run, sid);
                loop {
                    let n = st.notify.notified();
                    let batch: Vec<Value> = st.queue.lock().unwrap().drain(..).collect();
                    if !batch.is_empty() {
                        return Ok(Value::Array(batch));
                    }
                    if st.closed.load(Ordering::SeqCst) {
                        self.procs.streams.lock().unwrap().remove(&format!("{run}\n{sid}"));
                        return Ok(Value::Null);
                    }
                    n.await;
                }
            }
            "stop" => {
                let run = info.run_id.as_deref().ok_or_else(|| denied("notInRun"))?;
                let sid = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("stream"))?;
                let st = self.procs.stream(run, sid);
                st.stop.store(true, Ordering::SeqCst);
                st.stop_notify.notify_waiters();
                Ok(Value::Null)
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("process.{op}"))])),
        }
    }

    async fn process_run(&self, p: &'static Plugin, info: &CallInfo, o: &Value) -> KResult<Value> {
        // The stream (if any) is closed however the call ends, so the plugin's pump finishes.
        struct CloseOnDrop(Option<Arc<Stream>>);
        impl Drop for CloseOnDrop {
            fn drop(&mut self) {
                if let Some(s) = &self.0 {
                    s.close();
                }
            }
        }
        let sid = o.get("stream").and_then(Value::as_str);
        let stream = match (&info.run_id, sid) {
            (Some(run), Some(sid)) => Some(self.procs.stream(run, sid)),
            _ => None,
        };
        let _close = CloseOnDrop(stream.clone());
        // D332: only in a run (an action's execution), never in renders, migrate, events, commands.
        let Some(run) = info.run_id.clone() else { return Err(denied("notInRun")) };
        let spec = parse_spec(o)?;
        let path = match self.check_program(p, info.env_id.as_deref(), &spec.program)? {
            Ok(path) => path,
            Err((r, layer)) => return Err(Self::not_ready_error(&spec.program, r, layer)),
        };
        // Environment: only what the call gives (secrets substituted), plus the kernel's four.
        let allowed = self.plugin_secret_names(p, info.resource_id.as_deref())?;
        let mut used = Vec::new();
        let mut env: Vec<(String, String)> = Vec::new();
        for (k, v) in &spec.env {
            env.push((k.clone(), self.substitute(p, v, &allowed, &mut used)?));
        }
        let data = self.plugin_data_dir(&p.id)?;
        let mut path_dirs: Vec<String> = SYSTEM_DIRS.iter().map(|s| s.to_string()).collect();
        path_dirs.push(data.join("bin").display().to_string());
        if let Some(pkg_bin) = p.manifest.requires.programs.iter().filter(|d| d.source == PROGRAM_PLUGIN).find_map(|d| {
            d.path.as_deref().and_then(|rel| p.dir.join(rel).parent().map(Path::to_path_buf))
        }) {
            path_dirs.push(pkg_bin.display().to_string());
        }
        let fixed = [
            ("PATH".to_string(), path_dirs.join(":")),
            ("HOME".to_string(), std::env::var("HOME").unwrap_or_else(|_| data.display().to_string())),
            ("LANG".to_string(), "en_US.UTF-8".to_string()),
            ("TMPDIR".to_string(), data.join("tmp").display().to_string()),
        ];
        env.retain(|(k, _)| !fixed.iter().any(|(f, _)| f == k));
        env.extend(fixed);
        let cwd = self.process_cwd(p, &data, spec.cwd.as_deref())?;
        // Values the program got are scrubbed from what it says, the progress and the summary.
        if !used.is_empty() {
            if let Some(a) = self.runs_active.lock().unwrap().get_mut(&run) {
                a.secrets.extend(used.iter().cloned());
            }
        }
        {
            let mut per = self.procs.per_run.lock().unwrap();
            let n = per.entry(run.clone()).or_default();
            if *n >= MAX_CONCURRENT {
                return Err(invalid("tooManyProcesses"));
            }
            *n += 1;
        }
        // From here the count is the group's to give back.
        let mut cmd = tokio::process::Command::new(&path);
        cmd.args(&spec.args)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .current_dir(&cwd)
            .stdin(if spec.stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .process_group(0);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                if let Some(n) = self.procs.per_run.lock().unwrap().get_mut(&run) {
                    *n = n.saturating_sub(1);
                }
                let r = match e.raw_os_error() {
                    Some(libc::ENOENT) => NotReady::NotFound,
                    _ => NotReady::NotExecutable,
                };
                let mut pe = Self::not_ready_error(&spec.program, r, None);
                pe.detail = Some(e.to_string());
                return Err(pe);
            }
        };
        let pgid = child.id().unwrap_or_default() as i32;
        self.procs.live.lock().unwrap().insert(pgid);
        let mut group = Group { pgid, procs: self.procs.clone(), run: run.clone(), finished: false };

        if let (Some(text), Some(mut w)) = (spec.stdin, child.stdin.take()) {
            tokio::spawn(async move {
                let _ = w.write_all(text.as_bytes()).await;
            });
        }
        let (tx, mut rx) = mpsc::channel::<(usize, Option<Vec<u8>>)>(16);
        for (s, r) in [(0usize, child.stdout.take().map(|r| Box::new(r) as Box<dyn tokio::io::AsyncRead + Send + Unpin>)),
                       (1, child.stderr.take().map(|r| Box::new(r) as Box<dyn tokio::io::AsyncRead + Send + Unpin>))] {
            let Some(mut r) = r else { continue };
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match r.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send((s, Some(buf[..n].to_vec()))).await.is_err() {
                                return;
                            }
                        }
                    }
                }
                let _ = tx.send((s, None)).await;
            });
        }
        drop(tx);
        let mut out = Out { buf: [vec![], vec![]], truncated: false, pending: [vec![], vec![]], streamed: [0, 0], stream: stream.clone(), secrets: used.clone() };
        let deadline = tokio::time::sleep(spec.timeout);
        tokio::pin!(deadline);
        let mut tick = tokio::time::interval(FLUSH_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut open = 2;
        let mut status: Option<std::process::ExitStatus> = None;
        let grace = tokio::time::sleep(Duration::from_secs(86_400));
        tokio::pin!(grace);
        let stop = stream.clone();
        let stopped = async move {
            match stop {
                Some(s) => s.stopped().await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(stopped);
        loop {
            if status.is_some() && open == 0 {
                break;
            }
            tokio::select! {
                _ = &mut deadline => return Err(invalid("timeout")),
                _ = &mut stopped => return Err(denied("cancelled")),
                m = rx.recv(), if open > 0 => match m {
                    Some((s, Some(b))) => out.push(s, &b),
                    Some((_, None)) => open -= 1,
                    None => open = 0,
                },
                st = child.wait(), if status.is_none() => {
                    status = Some(st.map_err(internal)?);
                    grace.as_mut().reset(tokio::time::Instant::now() + EXIT_GRACE);
                }
                _ = &mut grace, if status.is_some() => break,
                _ = tick.tick() => out.flush(false),
            }
        }
        out.flush(true);
        group.finished = true;
        drop(group);
        let status = status.unwrap_or_else(|| unreachable!());
        use std::os::unix::process::ExitStatusExt;
        let (code, signal) = match (status.code(), status.signal()) {
            (Some(c), _) => (json!(c), Value::Null),
            (None, Some(s)) => (Value::Null, json!(signal_name(s))),
            (None, None) => (Value::Null, Value::Null),
        };
        let [so, se] = std::mem::take(&mut out.buf);
        let mut v = json!({
            "code": code,
            "signal": signal,
            "stdout": String::from_utf8_lossy(&so),
            "stderr": String::from_utf8_lossy(&se),
            "truncated": out.truncated,
        });
        crate::secrets::scrub(&mut v, &used);
        Ok(v)
    }

    /// `cwd`: inside `plugin-data/<id>/` (relative paths are taken from there) or inside a folder
    /// the user granted to the plugin; anywhere else `denied/outsideGrant`.
    fn process_cwd(&self, p: &Plugin, data: &Path, cwd: Option<&str>) -> KResult<PathBuf> {
        let Some(c) = cwd else { return Ok(data.to_path_buf()) };
        let want = if Path::new(c).is_absolute() { PathBuf::from(c) } else { data.join(c) };
        let real = match want.canonicalize() {
            Ok(r) => r,
            Err(_) => {
                // Says nothing about places it may not look at.
                let inside_lexically = want.starts_with(data) && !c.split('/').any(|s| s == "..");
                return Err(if inside_lexically { err_p(ErrorCode::NotFound, &[("what", "folder")]) } else { denied("outsideGrant") });
            }
        };
        let mut roots = vec![data.canonicalize().map_err(internal)?];
        if p.manifest.requires.files {
            roots.extend(self.folder_grants(&p.id)?.into_iter().filter_map(|g| Path::new(&g).canonicalize().ok()));
        }
        if !roots.iter().any(|r| real.starts_with(r)) {
            return Err(denied("outsideGrant"));
        }
        if !real.is_dir() {
            return Err(err_p(ErrorCode::NotFound, &[("what", "folder")]));
        }
        Ok(real)
    }
}
