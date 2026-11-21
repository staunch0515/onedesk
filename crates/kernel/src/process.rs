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

use std::collections::{HashMap, VecDeque};
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
/// Round 17: two hours (large dumps and restores); the default stays one minute. Cancelling still ends it at once.
pub const MAX_TIMEOUT_MS: u64 = 7_200_000;
/// Programs running at the same time within one run.
pub const MAX_CONCURRENT: usize = 4;
/// SIGTERM, then SIGKILL this much later (D333).
pub const KILL_GRACE: Duration = Duration::from_secs(2);
/// Partial lines are handed out at least this often.
pub const FLUSH_EVERY: Duration = Duration::from_millis(100);
/// After the program exited, how long to wait for output still in the pipes (held open by
/// something it left running) before that is killed.
pub const EXIT_GRACE: Duration = Duration::from_millis(500);
/// Round 17 (X17): the most lines `lines: true` keeps (and the largest `maxLines`).
pub const MAX_LINES: usize = 100_000;
/// The plugin's own folder inside the workspace (§7.5).
pub const PLUGIN_DATA: &str = "plugin-data";

/// Why a program is not ready (`ready()` and the matching refusals of `run()`).
/// A policy layer that refused: (node id, node name).
type Layer = (String, String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotReady {
    UndeclaredProgram,
    NotFound,
    NotExecutable,
    BlockedByPolicy,
    /// Round 17 (round 15 review #15): a `searchPaths` program in a place other users can change.
    UnsafeLocation,
}

impl NotReady {
    pub fn reason(self) -> &'static str {
        match self {
            NotReady::UndeclaredProgram => "undeclaredProgram",
            NotReady::NotFound => "notFound",
            NotReady::NotExecutable => "notExecutable",
            NotReady::BlockedByPolicy => "blockedByPolicy",
            NotReady::UnsafeLocation => "unsafeLocation",
        }
    }
}

/// D340: the file in the workspace folder that lists the process groups of running programs, so
/// whoever finds the worker gone (the next worker, the main process) can end them.
///
/// One line per group: `<pgid> <start_sec> <start_usec>\n` — the group leader's start time as the
/// system reports it (`proc_pidinfo(PROC_PIDTBSDINFO)`: `pbi_start_tvsec`, `pbi_start_tvusec`).
/// Rewritten whole (temporary file + rename) whenever a group starts or ends; missing or empty =
/// nothing to clean. A group is ended (SIGKILL to the group) only when it still exists and either
/// its leader is gone (a group id cannot be reused while the group exists) or the leader's start
/// time is the recorded one (else the number was reused: left alone).
pub const PROCESS_GROUPS_FILE: &str = "process-groups";

/// The start time of a process (`None`: no such process).
pub fn start_time(pid: i32) -> Option<(i64, i64)> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    // SAFETY: the buffer is a properly sized, zeroed `proc_bsdinfo`.
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    (n == size).then_some((info.pbi_start_tvsec as i64, info.pbi_start_tvusec as i64))
}

fn group_exists(pg: i32) -> bool {
    // SAFETY: signal 0 only checks.
    unsafe { libc::killpg(pg, 0) == 0 || *libc::__error() == libc::EPERM }
}

/// Ends the groups listed in a workspace's process-group file that are still ours, then empties
/// it. Returns how many groups were ended. (The worker calls it at start-up; the main process
/// does the same after the worker went away.)
pub fn cleanup_recorded(workspace: &Path) -> usize {
    let path = workspace.join(PROCESS_GROUPS_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else { return 0 };
    let mut ended = 0;
    for line in text.lines() {
        let f: Vec<i64> = line.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        let [pg, sec, usec] = f[..] else { continue };
        let pg = pg as i32;
        if pg <= 1 || !group_exists(pg) {
            continue;
        }
        let ours = match start_time(pg) {
            None => true,
            Some(t) => t == (sec, usec),
        };
        if ours {
            // SAFETY: plain system call; checked above that the group is the recorded one.
            unsafe { libc::killpg(pg, libc::SIGKILL) };
            ended += 1;
        }
    }
    let _ = std::fs::remove_file(&path);
    ended
}

/// A running group: which run it belongs to, and its leader's start time (for the file).
struct LiveGroup {
    run: String,
    start: (i64, i64),
}

/// Programs of one kernel: live process groups (for shutdown), counts per run, output streams.
#[derive(Default)]
pub struct Procs {
    live: Mutex<HashMap<i32, LiveGroup>>,
    per_run: Mutex<HashMap<String, usize>>,
    streams: Mutex<HashMap<String, Arc<Stream>>>,
    /// The process-group file (D340); `None` keeps nothing on disk.
    file: Option<PathBuf>,
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
    pub(crate) fn push(&self, v: Value) {
        self.queue.lock().unwrap().push_back(v);
        self.notify.notify_waiters();
    }
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub(crate) async fn stopped(&self) {
        loop {
            let n = self.stop_notify.notified();
            if self.stop.load(Ordering::SeqCst) {
                return;
            }
            n.await;
        }
    }
}

/// SIGTERM now, SIGKILL after the grace period if the group is still listed.
fn terminate(procs: &Arc<Procs>, pg: i32) {
    // SAFETY: plain system call on a process group id we created and still list.
    unsafe { libc::killpg(pg, libc::SIGTERM) };
    let procs = procs.clone();
    std::thread::spawn(move || {
        std::thread::sleep(KILL_GRACE);
        // Only if nobody (shutdown) took care of it meanwhile.
        if procs.forget_group(pg) {
            // SAFETY: as above.
            unsafe { libc::killpg(pg, libc::SIGKILL) };
        }
    });
}

impl Procs {
    pub fn new(workspace: &Path) -> Procs {
        Procs { file: Some(workspace.join(PROCESS_GROUPS_FILE)), ..Default::default() }
    }

    /// Rewrites the process-group file from `live` (called with the lock held).
    fn persist(&self, live: &HashMap<i32, LiveGroup>) {
        let Some(path) = &self.file else { return };
        let mut text = String::new();
        let mut list: Vec<(&i32, &LiveGroup)> = live.iter().collect();
        list.sort_by_key(|(pg, _)| **pg);
        for (pg, g) in list {
            text.push_str(&format!("{pg} {} {}\n", g.start.0, g.start.1));
        }
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }

    fn add_group(&self, pg: i32, run: &str) {
        let start = start_time(pg).unwrap_or((0, 0));
        let mut live = self.live.lock().unwrap();
        live.insert(pg, LiveGroup { run: run.to_string(), start });
        self.persist(&live);
    }

    /// Removes a group from the list; whether it was listed.
    fn forget_group(&self, pg: i32) -> bool {
        let mut live = self.live.lock().unwrap();
        let had = live.remove(&pg).is_some();
        if had {
            self.persist(&live);
        }
        had
    }

    pub(crate) fn stream(&self, run: &str, sid: &str) -> Arc<Stream> {
        self.streams.lock().unwrap().entry(format!("{run}\n{sid}")).or_default().clone()
    }

    /// A run ended: its streams are forgotten and programs it left running are ended (review #2).
    pub fn end_run(self: &Arc<Self>, run: &str) {
        let prefix = format!("{run}\n");
        self.streams.lock().unwrap().retain(|k, _| !k.starts_with(&prefix));
        self.per_run.lock().unwrap().retain(|k, n| k != run || *n > 0);
        let groups: Vec<i32> = self.live.lock().unwrap().iter().filter(|(_, g)| g.run == run).map(|(pg, _)| *pg).collect();
        for pg in groups {
            terminate(self, pg);
        }
    }

    /// Kills every process group still running (the worker is shutting down).
    pub fn kill_all(&self) {
        let mut live = self.live.lock().unwrap();
        for pg in live.keys() {
            // SAFETY: plain system call on a process group id we created.
            unsafe { libc::killpg(*pg, libc::SIGKILL) };
        }
        live.clear();
        self.persist(&live);
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
            if self.procs.forget_group(pg) {
                // SAFETY: plain system call on a process group id we created.
                unsafe { libc::killpg(pg, libc::SIGKILL) };
            }
            return;
        }
        if self.procs.live.lock().unwrap().contains_key(&pg) {
            terminate(&self.procs, pg);
        }
    }
}

/// Aborts the output readers however the call ends (review #11: a grandchild that left the group
/// and holds the pipes would keep them waiting forever).
struct Readers(Vec<tokio::task::JoinHandle<()>>);

impl Drop for Readers {
    fn drop(&mut self) {
        for h in &self.0 {
            h.abort();
        }
    }
}

fn is_executable(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Round 15 (X1): the candidates of a system program's `searchPaths`, in order. The component
/// holding a `*` stands for each folder there whose name matches (`*` = any; `pg@*` = names
/// starting `pg@`), highest name first.
pub fn search_candidates(paths: &[String], name: &str) -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut out = Vec::new();
    for p in paths {
        // Round 17: `~/…` in the current user's home folder (none known: skipped).
        let expanded;
        let p = match p.strip_prefix("~/") {
            Some(rest) if home.starts_with('/') => {
                expanded = format!("{}/{rest}", home.trim_end_matches('/'));
                &expanded
            }
            Some(_) => continue,
            None => p,
        };
        let parts: Vec<&str> = p.split('/').collect();
        let Some(i) = parts.iter().position(|c| c.contains('*')) else {
            out.push(Path::new(p).join(name));
            continue;
        };
        let head = parts[..i].join("/");
        let tail = parts[i + 1..].join("/");
        let (pre, post) = parts[i].split_once('*').unwrap_or_default();
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(if head.is_empty() { "/" } else { head.as_str() })
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.len() >= pre.len() + post.len() && n.starts_with(pre) && n.ends_with(post) && e.path().is_dir()
            })
            .map(|e| e.path())
            .collect();
        dirs.sort_by_key(|d| std::cmp::Reverse(natural(d)));
        out.extend(dirs.into_iter().map(|d| d.join(&tail).join(name)));
    }
    out
}

/// Sort key comparing digit runs as numbers (`16` after `9`).
fn natural(p: &Path) -> Vec<(u64, String)> {
    let s = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if ch.is_ascii_digit() == cur.chars().next().is_some_and(|c| c.is_ascii_digit()) || cur.is_empty() {
            cur.push(ch);
        } else {
            out.push(std::mem::take(&mut cur));
            cur.push(ch);
        }
    }
    out.push(cur);
    out.into_iter().map(|c| (c.parse::<u64>().unwrap_or(0), c)).collect()
}

/// Round 17 (round 15 review #15): the program and every folder above it are owned by root or the
/// current user and not writable by others (a sticky folder like `/tmp` does not count as safe
/// either). Links are followed: what counts is where the file really is.
pub fn safe_location(p: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(real) = std::fs::canonicalize(p) else { return false };
    // SAFETY: plain system call without arguments.
    let me = unsafe { libc::getuid() };
    real.ancestors().all(|a| {
        std::fs::metadata(a).is_ok_and(|m| (m.uid() == 0 || m.uid() == me) && m.mode() & 0o002 == 0)
    })
}

/// `pick` for `searchPaths` candidates: the first existing one, refused in an unsafe place.
fn pick_searched(candidates: &[PathBuf]) -> Result<PathBuf, NotReady> {
    let p = pick(candidates)?;
    if safe_location(&p) {
        Ok(p)
    } else {
        Err(NotReady::UnsafeLocation)
    }
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

/// The largest index `<= i` on a character boundary.
fn floor_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// What was read so far, and what is still to hand out.
struct Out {
    /// Raw output, kept up to `MAX_OUTPUT + hold` bytes (scrubbed before it is cut, review #3).
    buf: [Vec<u8>; 2],
    received: [usize; 2],
    pending: [Vec<u8>; 2],
    /// Scrubbed text held back from the stream: the end of a secret may come with the next chunk.
    carry: [String; 2],
    streamed: [usize; 2],
    stream: Option<Arc<Stream>>,
    secrets: Vec<String>,
    /// Longest secret − 1 (0 without secrets): how much text is held back.
    hold: usize,
    /// Round 17 (X17): `lines: true` — whole lines in arrival order, at most `max_lines`.
    lines: Option<Lines>,
}

/// Round 17 (X17): output split into lines as it comes.
struct Lines {
    max: usize,
    out: Vec<Value>,
    pending: [Vec<u8>; 2],
    /// Bytes of each stream taken into lines (cut at `MAX_OUTPUT`).
    bytes: [usize; 2],
    /// `max` lines were reached: the program is ended.
    full: bool,
}

const STREAMS: [&str; 2] = ["stdout", "stderr"];

impl Out {
    fn new(stream: Option<Arc<Stream>>, secrets: Vec<String>, max_lines: Option<usize>) -> Out {
        // `scrub` ignores values shorter than 3.
        let hold = secrets.iter().filter(|v| v.len() >= 3).map(|v| v.len() - 1).max().unwrap_or(0);
        let lines = max_lines.map(|max| Lines { max, out: vec![], pending: [vec![], vec![]], bytes: [0, 0], full: false });
        Out { buf: [vec![], vec![]], received: [0, 0], pending: [vec![], vec![]], carry: [String::new(), String::new()], streamed: [0, 0], stream, secrets, hold, lines }
    }

    /// Round 17 (X17): one whole line (without its newline) of stream `s`.
    fn line(&mut self, s: usize, raw: &[u8]) {
        let Some(l) = self.lines.as_mut() else { return };
        if l.full || l.bytes[s] >= MAX_OUTPUT {
            return;
        }
        let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
        let raw = &raw[..raw.len().min(MAX_OUTPUT - l.bytes[s])];
        l.bytes[s] += raw.len() + 1;
        let mut v = Value::String(String::from_utf8_lossy(raw).into_owned());
        crate::secrets::scrub(&mut v, &self.secrets);
        let item = json!({ "stream": STREAMS[s], "text": v });
        l.out.push(item.clone());
        if l.out.len() >= l.max {
            l.full = true;
        }
        if let Some(st) = &self.stream {
            st.push(item);
        }
    }

    /// Round 17 (X17): `maxLines` was reached.
    fn full(&self) -> bool {
        self.lines.as_ref().is_some_and(|l| l.full)
    }

    fn push(&mut self, s: usize, bytes: &[u8]) {
        self.received[s] += bytes.len();
        let room = (MAX_OUTPUT + self.hold).saturating_sub(self.buf[s].len());
        self.buf[s].extend_from_slice(&bytes[..bytes.len().min(room)]);
        if self.lines.is_some() {
            let mut rest = std::mem::take(&mut self.lines.as_mut().expect("checked").pending[s]);
            rest.extend_from_slice(bytes);
            let mut start = 0;
            while let Some(i) = rest[start..].iter().position(|b| *b == b'\n') {
                let line = rest[start..start + i].to_vec();
                self.line(s, &line);
                start += i + 1;
            }
            rest.drain(..start);
            if let Some(l) = self.lines.as_mut() {
                l.pending[s] = rest;
            }
            return;
        }
        if self.stream.is_some() {
            self.pending[s].extend_from_slice(bytes);
            if let Some(i) = self.pending[s].iter().rposition(|b| *b == b'\n') {
                let line: Vec<u8> = self.pending[s].drain(..=i).collect();
                self.emit(s, &line, false);
            }
        }
    }

    /// Partial lines that waited a tick (cut at a whole UTF-8 character); `all` at the end.
    /// With `lines`, only at the end: the last line without a newline.
    fn flush(&mut self, all: bool) {
        if self.lines.is_some() {
            if all {
                for s in 0..2 {
                    let rest = std::mem::take(&mut self.lines.as_mut().expect("checked").pending[s]);
                    if !rest.is_empty() {
                        self.line(s, &rest);
                    }
                }
            }
            return;
        }
        for s in 0..2 {
            if !self.pending[s].is_empty() {
                let upto = match std::str::from_utf8(&self.pending[s]) {
                    Ok(_) => self.pending[s].len(),
                    Err(e) if all || e.error_len().is_some() || e.valid_up_to() == 0 && self.pending[s].len() >= 4 => self.pending[s].len(),
                    Err(e) => e.valid_up_to(),
                };
                if upto > 0 {
                    let part: Vec<u8> = self.pending[s].drain(..upto).collect();
                    self.emit(s, &part, all);
                }
            } else if all {
                self.emit(s, &[], true);
            }
        }
    }

    /// Scrubs (with what was held back), keeps the last `hold` bytes back unless `last`, then
    /// cuts at the streaming limit.
    fn emit(&mut self, s: usize, bytes: &[u8], last: bool) {
        let Some(st) = self.stream.clone() else { return };
        let mut text = std::mem::take(&mut self.carry[s]);
        text.push_str(&String::from_utf8_lossy(bytes));
        let mut v = Value::String(text);
        crate::secrets::scrub(&mut v, &self.secrets);
        let Value::String(mut text) = v else { return };
        if !last && self.hold > 0 {
            let cut = floor_boundary(&text, text.len().saturating_sub(self.hold));
            self.carry[s] = text.split_off(cut);
        }
        if text.is_empty() || self.streamed[s] >= MAX_OUTPUT {
            return;
        }
        text.truncate(floor_boundary(&text, MAX_OUTPUT - self.streamed[s]));
        self.streamed[s] += text.len();
        st.push(json!({ "stream": STREAMS[s], "text": text }));
    }

    /// The whole output of a stream: scrubbed first, then cut to the limit.
    fn take(&mut self, s: usize) -> (String, bool) {
        let mut v = Value::String(String::from_utf8_lossy(&std::mem::take(&mut self.buf[s])).into_owned());
        crate::secrets::scrub(&mut v, &self.secrets);
        let Value::String(mut text) = v else { return (String::new(), false) };
        let over = self.received[s] > MAX_OUTPUT;
        if over {
            // What was kept beyond the limit may end in the first part of a secret.
            let keep = MAX_OUTPUT.min(text.len().saturating_sub(self.hold));
            text.truncate(floor_boundary(&text, keep));
        }
        (text, over)
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
    /// Round 17 (X17): `lines: true` → the line limit (`maxLines`, default `MAX_LINES`).
    lines: Option<usize>,
}

fn parse_spec(o: &Value, default_timeout: u64, max_timeout: u64) -> KResult<Spec> {
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
                // D338: no dynamic-loader variables (they would run any code inside an allowed program).
                let upper = k.to_ascii_uppercase();
                if k.is_empty() || k.contains('=') || k.contains('\0') || v.contains('\0') || upper.starts_with("DYLD_") || upper.starts_with("LD_") {
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
        None | Some(Value::Null) => default_timeout,
        Some(v) => v.as_f64().ok_or_else(|| invalid_params("timeoutMs"))?.clamp(1.0, max_timeout as f64) as u64,
    };
    let lines = match o.get("lines") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => None,
        Some(Value::Bool(true)) => Some(MAX_LINES),
        Some(_) => return Err(invalid_params("lines must be true or false")),
    };
    let lines = match o.get("maxLines") {
        None | Some(Value::Null) => lines,
        Some(v) => {
            let n = v.as_f64().filter(|n| n.fract() == 0.0 && *n >= 1.0).ok_or_else(|| invalid_params("maxLines must be a positive integer"))?;
            if lines.is_none() {
                return Err(invalid_params("maxLines needs lines: true"));
            }
            Some((n as usize).min(MAX_LINES))
        }
    };
    Ok(Spec { program, args, env, cwd, stdin, timeout: Duration::from_millis(timeout), lines })
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
            let fixed = pick(&SYSTEM_DIRS.iter().map(|d| Path::new(d).join(name)).collect::<Vec<_>>());
            match (fixed, &decl.search_paths) {
                (Err(NotReady::NotFound), Some(more)) => pick_searched(&search_candidates(more, name)),
                (r, _) => r,
            }
        }
    }

    /// D334: the first `process.allow` layer that does not list `name` (an empty list lists nothing).
    /// Returns that layer's id and name (D368: the error names the layer).
    fn process_blocked(&self, env: Option<&str>, name: &str) -> KResult<Option<Layer>> {
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
                    return Ok(Some((r.id.clone(), r.name.clone())));
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

    fn check_program(&self, p: &Plugin, env: Option<&str>, name: &str) -> KResult<Result<PathBuf, (NotReady, Option<Layer>)>> {
        if p.program(name).is_none() {
            return Ok(Err((NotReady::UndeclaredProgram, None)));
        }
        if let Some(layer) = self.process_blocked(env, name)? {
            return Ok(Err((NotReady::BlockedByPolicy, Some(layer))));
        }
        Ok(self.locate(p, name).map_err(|r| (r, None)))
    }

    fn not_ready_error(name: &str, r: NotReady, layer: Option<Layer>) -> ProtocolError {
        match r {
            NotReady::UndeclaredProgram => err_p(ErrorCode::Denied, &[("reason", "undeclaredProgram"), ("program", name)]),
            NotReady::BlockedByPolicy => {
                let (id, lname) = layer.unwrap_or_default();
                err_p(ErrorCode::Denied, &[("reason", "blockedByPolicy"), ("program", name), ("layer", &id), ("layerName", &lname)])
            }
            NotReady::NotFound => err_p(ErrorCode::NotFound, &[("what", "program"), ("program", name)]),
            NotReady::NotExecutable => err_p(ErrorCode::Invalid, &[("reason", "notExecutable"), ("program", name)]),
            NotReady::UnsafeLocation => err_p(ErrorCode::Denied, &[("reason", "unsafeLocation"), ("program", name)]),
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
                // Review #8: what the plugin passed is recorded only when it is a valid name.
                let program = o.get("program").and_then(Value::as_str).filter(|n| crate::manifest::valid_program_name(n)).unwrap_or_default().to_string();
                let started = Instant::now();
                // D355: the action's time budget does not run while it waits for the program.
        let res = {
            let _hold = info.hold.enter_wait();
            self.process_run(p, info, &o, None).await
        };
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
                        if let Some(s) = v.get("stopped").filter(|s| !s.is_null()) {
                            summary["stopped"] = s.clone();
                        }
                        let failed = v.get("code").is_none_or(|c| c != &json!(0));
                        let cmd = Command::CountedAudit { run: info.run_id.clone(), op: "process.run".into(), object: program, summary, failed, error: None };
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
            "output" => self.stream_poll(info, args).await,
            "stop" => self.stream_stop(info, args),
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("process.{op}"))])),
        }
    }

    /// The next batch of a stream of this run (`null` once it is closed): `process.output`,
    /// `transfer.progress`.
    pub(crate) async fn stream_poll(&self, info: &CallInfo, args: &Value) -> KResult<Value> {
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

    /// The plugin's callback failed: the call the stream belongs to stops (`process.stop`, `transfer.stop`).
    pub(crate) fn stream_stop(&self, info: &CallInfo, args: &Value) -> KResult<Value> {
        let run = info.run_id.as_deref().ok_or_else(|| denied("notInRun"))?;
        let sid = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("stream"))?;
        let st = self.procs.stream(run, sid);
        st.stop.store(true, Ordering::SeqCst);
        st.stop_notify.notify_waiters();
        Ok(Value::Null)
    }

    pub(crate) async fn process_run(
        &self,
        p: &'static Plugin,
        info: &CallInfo,
        o: &Value,
        mut sink: Option<&mut crate::carry::Sink>,
    ) -> KResult<Value> {
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
        let spec = if sink.is_some() {
            parse_spec(o, crate::carry::DEFAULT_TIMEOUT_MS, crate::carry::MAX_TIMEOUT_MS)?
        } else {
            parse_spec(o, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)?
        };
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
        // Review #10: with every value this run read so far, not only this call's.
        let scrub_values: Vec<String> = {
            let mut active = self.runs_active.lock().unwrap();
            match active.get_mut(&run) {
                Some(a) => {
                    a.secrets.extend(used.iter().cloned());
                    a.secrets.clone()
                }
                None => used.clone(),
            }
        };
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
        self.procs.add_group(pgid, &run);
        let mut group = Group { pgid, procs: self.procs.clone(), run: run.clone(), finished: false };

        if let (Some(text), Some(mut w)) = (spec.stdin, child.stdin.take()) {
            tokio::spawn(async move {
                let _ = w.write_all(text.as_bytes()).await;
            });
        }
        let (tx, mut rx) = mpsc::channel::<(usize, Option<Vec<u8>>)>(16);
        let mut readers = Readers(Vec::new());
        for (s, r) in [(0usize, child.stdout.take().map(|r| Box::new(r) as Box<dyn tokio::io::AsyncRead + Send + Unpin>)),
                       (1, child.stderr.take().map(|r| Box::new(r) as Box<dyn tokio::io::AsyncRead + Send + Unpin>))] {
            let Some(mut r) = r else { continue };
            let tx = tx.clone();
            readers.0.push(tokio::spawn(async move {
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
            }));
        }
        drop(tx);
        let mut out = Out::new(stream.clone(), scrub_values, spec.lines);
        // Round 17 (X17): with `lines`, a timeout or the line limit ends the program and the call
        // returns what came so far.
        let mut ended_by: Option<&'static str> = None;
        let deadline = tokio::time::sleep(spec.timeout);
        tokio::pin!(deadline);
        let mut tick = tokio::time::interval(FLUSH_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut open = 2;
        let mut status: Option<std::process::ExitStatus> = None;
        let grace = tokio::time::sleep(Duration::from_secs(86_400));
        tokio::pin!(grace);
        // `transfer.capture`: its progress stream carries the stop of a failed `onProgress`.
        let stop = stream.clone().or_else(|| sink.as_ref().and_then(|k| k.stop_stream()));
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
            if out.full() {
                ended_by = Some("maxLines");
                break;
            }
            tokio::select! {
                _ = &mut deadline => {
                    if out.lines.is_none() {
                        return Err(invalid("timeout"));
                    }
                    ended_by = Some("timeout");
                    break;
                }
                _ = &mut stopped => return Err(denied("cancelled")),
                m = rx.recv(), if open > 0 => match m {
                    // `transfer.capture`: standard output goes to the file, never into memory.
                    Some((0, Some(b))) if sink.is_some() => sink.as_deref_mut().expect("checked").write(&b).await?,
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
        if ended_by.is_none() {
            out.flush(true);
        }
        drop(readers);
        // Stopped early: dropping the group ends it at once (SIGTERM, SIGKILL after the grace).
        group.finished = ended_by.is_none();
        drop(group);
        use std::os::unix::process::ExitStatusExt;
        let (code, signal) = match (ended_by, status) {
            (Some(_), _) | (None, None) => (Value::Null, Value::Null),
            (None, Some(st)) => match (st.code(), st.signal()) {
                (Some(c), _) => (json!(c), Value::Null),
                (None, Some(s)) => (Value::Null, json!(signal_name(s))),
                (None, None) => (Value::Null, Value::Null),
            },
        };
        let (stdout, t1) = out.take(0);
        let (stderr, t2) = out.take(1);
        let mut res = json!({ "code": code, "signal": signal, "stdout": stdout, "stderr": stderr, "truncated": t1 || t2 || ended_by == Some("maxLines") });
        if let Some(l) = out.lines.take() {
            res["lines"] = Value::Array(l.out);
            res["stopped"] = json!(ended_by);
        }
        Ok(res)
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
                return Err(if inside_lexically { err_p(ErrorCode::NotFound, &[("what", "folder")]) } else { outside_grant(c) });
            }
        };
        let mut roots = vec![data.canonicalize().map_err(internal)?];
        if p.manifest.requires.files {
            roots.extend(self.folder_grants(&p.id)?.into_iter().filter_map(|g| Path::new(&g).canonicalize().ok()));
        }
        if !roots.iter().any(|r| real.starts_with(r)) {
            return Err(outside_grant(c));
        }
        if !real.is_dir() {
            return Err(err_p(ErrorCode::NotFound, &[("what", "folder")]));
        }
        Ok(real)
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn search_paths_try_the_highest_version_first_then_in_order() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("Vendor");
        for v in ["9", "15", "16"] {
            std::fs::create_dir_all(root.join(v).join("bin")).unwrap();
        }
        let exe = |p: PathBuf| {
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        exe(root.join("15/bin/tool"));
        exe(root.join("9/bin/tool"));
        std::fs::write(root.join("16/bin/tool"), "not executable").unwrap();
        let star = format!("{}/*/bin", root.display());
        let c = search_candidates(std::slice::from_ref(&star), "tool");
        assert_eq!(c[0], root.join("16/bin/tool"));
        assert_eq!(c[1], root.join("15/bin/tool"));
        assert_eq!(c[2], root.join("9/bin/tool"));
        // The first existing file decides: 16's is not executable.
        assert!(matches!(pick(&c), Err(NotReady::NotExecutable)));
        std::fs::remove_file(root.join("16/bin/tool")).unwrap();
        assert_eq!(pick(&search_candidates(&[star], "tool")).unwrap(), root.join("15/bin/tool"));
        let plain = root.join("9/bin").display().to_string();
        assert_eq!(pick(&search_candidates(&["/nonexistent/x".into(), plain], "tool")).unwrap(), root.join("9/bin/tool"));
        assert!(matches!(pick(&search_candidates(&["/nonexistent/*/bin".into()], "tool")), Err(NotReady::NotFound)));
        // Review #5: a `*` inside a component matches by prefix and suffix.
        for v in ["pg@14", "pg@16", "other@17"] {
            std::fs::create_dir_all(d.path().join("opt").join(v).join("bin")).unwrap();
        }
        exe(d.path().join("opt/pg@14/bin/tool"));
        exe(d.path().join("opt/other@17/bin/tool"));
        let pat = format!("{}/opt/pg@*/bin", d.path().display());
        let c = search_candidates(&[pat], "tool");
        assert_eq!(c, vec![d.path().join("opt/pg@16/bin/tool"), d.path().join("opt/pg@14/bin/tool")]);
        assert_eq!(pick(&c).unwrap(), d.path().join("opt/pg@14/bin/tool"));
    }

    #[test]
    fn round17_programs_may_run_up_to_two_hours() {
        let s = parse_spec(&json!({ "program": "x", "timeoutMs": 7_200_000 }), DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS).unwrap();
        assert_eq!(s.timeout, Duration::from_secs(7200));
        let s = parse_spec(&json!({ "program": "x", "timeoutMs": 9_000_000 }), DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS).unwrap();
        assert_eq!(s.timeout, Duration::from_secs(7200));
        let s = parse_spec(&json!({ "program": "x" }), DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS).unwrap();
        assert_eq!(s.timeout, Duration::from_secs(60));
    }

    #[test]
    fn round17_home_paths_expand_and_unsafe_places_are_refused() {
        let home = std::env::var("HOME").unwrap();
        let c = search_candidates(&["~/.tool/bin".into()], "tool");
        assert_eq!(c, vec![Path::new(&home).join(".tool/bin/tool")]);
        assert!(crate::manifest::valid_search_path("~/.docker/bin"));
        assert!(!crate::manifest::valid_search_path("~user/bin"));
        assert!(!crate::manifest::valid_search_path("~/../x"));
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("bin");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("tool");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        // The temporary folder may sit under a world-writable sticky folder; judge only the change.
        let base_safe = safe_location(&exe);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(!safe_location(&exe));
        assert!(matches!(pick_searched(std::slice::from_ref(&exe)), Err(NotReady::UnsafeLocation)));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(safe_location(&exe), base_safe);
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o757)).unwrap();
        assert!(!safe_location(&exe));
        assert!(safe_location(Path::new("/bin/sh")));
    }
}
