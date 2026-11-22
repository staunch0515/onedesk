//! `ctx.host.transfer` (round 8 §3, D353–D355): moving large data without it entering the sandbox.
//! (`transfer.rs` is the workspace export / import of round 5; this module is the host capability.)
//!
//! - `download`: an HTTP response body into a file; `upload`: a file as an HTTP request body;
//!   `capture`: a program's standard output into a file.
//! - Each end is checked by the rules that already exist: the network end exactly like
//!   `network.request` (`Inner::http_open`), the file end like `files` (`writeText` for `to`,
//!   `readText` for `from`), the program end exactly like `process.run` (`Inner::process_run`).
//! - The host moves the content in chunks of at most 64 KB; nothing is kept in memory and nothing
//!   reaches the plugin, so there is no 8 MB limit.
//! - Files are written to `.<name>.part-<random>` next to the target and renamed into place only
//!   when complete (download: a 2xx response read to its end; capture: the program ended, whatever
//!   its exit code). Failure, timeout, cancellation: the partial file is removed (`files::PartFile`).
//! - Only in a run. The time the action waits for a transfer is not counted against its budget
//!   (D355); the transfer has its own timeout (default 10 minutes, at most 1 hour).
//! - `onProgress({ bytes, total? })`: at most every 100 ms, through the same polled stream as
//!   `process.run`'s `onOutput` (see the sandbox bootstrap).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use onedesk_protocol::*;
use serde_json::{json, Map, Value};
use tokio::io::AsyncWriteExt;

use crate::kernel::Inner;
use crate::manifest::Plugin;
use crate::network::{FileBody, Request, CHUNK, METHODS};
use crate::pipeline::Command;
use crate::process::Stream;
use crate::sandbox::CallInfo;
use crate::util::*;

pub const DEFAULT_TIMEOUT_MS: u64 = 600_000;
/// Round 17: two hours, as `process.run`.
pub const MAX_TIMEOUT_MS: u64 = 7_200_000;
/// `onProgress` is called at most this often.
pub const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// Methods that send a body (`upload`).
pub const UPLOAD_METHODS: &[&str] = &["POST", "PUT", "PATCH"];

/// Progress reports to the plugin's `onProgress` pump (if it gave one).
pub(crate) struct Progress {
    stream: Option<Arc<Stream>>,
    last: Option<Instant>,
    total: Option<u64>,
}

impl Progress {
    fn new(stream: Option<Arc<Stream>>, total: Option<u64>) -> Progress {
        Progress { stream, last: None, total }
    }

    fn tick(&mut self, bytes: u64) {
        let Some(st) = &self.stream else { return };
        if self.last.is_some_and(|l| l.elapsed() < PROGRESS_EVERY) {
            return;
        }
        self.last = Some(Instant::now());
        let mut v = json!({ "bytes": bytes });
        if let Some(t) = self.total {
            v["total"] = json!(t);
        }
        st.push(v);
    }

    /// Ends when the plugin's `onProgress` failed (it asked to stop).
    async fn stopped(stream: Option<Arc<Stream>>) {
        match stream {
            Some(s) => s.stopped().await,
            None => std::future::pending().await,
        }
    }
}

/// Where `capture` puts the program's standard output (see `Inner::process_run`).
pub struct Sink {
    file: tokio::fs::File,
    bytes: u64,
    progress: Progress,
}

impl Sink {
    pub(crate) async fn write(&mut self, b: &[u8]) -> KResult<()> {
        for c in b.chunks(CHUNK) {
            self.file.write_all(c).await.map_err(internal)?;
        }
        self.bytes += b.len() as u64;
        self.progress.tick(self.bytes);
        Ok(())
    }

    pub(crate) fn stop_stream(&self) -> Option<Arc<Stream>> {
        self.progress.stream.clone()
    }
}

/// Closes the progress stream however the call ends, so the plugin's pump finishes.
struct CloseOnDrop(Option<Arc<Stream>>);

impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        if let Some(s) = &self.0 {
            s.close();
        }
    }
}

/// D368: a transfer dropped before it finished (the run was cancelled, or the worker gave up on
/// the call) still leaves an audit row, result `cancelled`.
struct Unfinished<'a> {
    inner: &'a Inner,
    actor: crate::pipeline::Actor,
    op: String,
    object: String,
    started: Instant,
    armed: bool,
}

impl Drop for Unfinished<'_> {
    fn drop(&mut self) {
        if self.armed {
            let summary = json!({ "ms": self.started.elapsed().as_millis() as u64 });
            let cmd = Command::Stopped { op: std::mem::take(&mut self.op), object: std::mem::take(&mut self.object), summary, result: "cancelled".into() };
            self.inner.pipeline.submit(self.actor.clone(), cmd);
            self.inner.emit(topic2::AUDIT, None, None);
        }
    }
}

/// A finished transfer: the answer, the audit object (host or program) and the audit summary.
struct Done {
    out: Value,
    object: String,
    summary: Value,
}

fn options(o: &Value) -> KResult<&Map<String, Value>> {
    o.as_object().ok_or_else(|| invalid_params("options must be an object"))
}

fn timeout_of(o: &Map<String, Value>) -> KResult<Duration> {
    let ms = match o.get("timeoutMs") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_MS,
        Some(v) => v.as_f64().ok_or_else(|| invalid_params("timeoutMs"))?.clamp(1.0, MAX_TIMEOUT_MS as f64) as u64,
    };
    Ok(Duration::from_millis(ms))
}

fn path_arg(o: &Map<String, Value>, key: &str) -> KResult<String> {
    o.get(key).and_then(Value::as_str).map(String::from).ok_or_else(|| invalid_params(key.to_string()))
}

fn timed_out() -> ProtocolError {
    err_p(ErrorCode::Invalid, &[("reason", "timeout")])
}

impl Inner {
    pub async fn host_transfer(&self, p: &'static Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        match op {
            "progress" => self.stream_poll(p, info, args).await,
            "stop" => self.stream_stop(p, info, args),
            "download" | "upload" | "capture" => {
                let o = args.get(0).cloned().unwrap_or(Value::Null);
                let stream = match (&info.run_id, o.get("progress").and_then(Value::as_str)) {
                    (Some(run), Some(sid)) => Some(self.procs.stream(run, &p.id, sid)),
                    _ => None,
                };
                let _close = CloseOnDrop(stream.clone());
                // Refusals are recorded under the host / program the plugin named (never the
                // address's path or the arguments).
                let named = if op == "capture" {
                    o.get("program").and_then(Value::as_str).filter(|n| crate::manifest::valid_program_name(n)).unwrap_or_default().to_string()
                } else {
                    o.get("url").and_then(Value::as_str).and_then(crate::network::host_of).unwrap_or_default()
                };
                let started = Instant::now();
                let method = format!("transfer.{op}");
                let mut guard =
                    Unfinished { inner: self, actor: p.actor(), op: method.clone(), object: named.clone(), started, armed: info.run_id.is_some() };
                let res = if info.run_id.is_none() {
                    // D353: only in a run (an action's execution).
                    Err(denied("notInRun"))
                } else {
                    // D355: the action's time budget does not run while it waits for the transfer.
                    let _hold = info.hold.enter_wait();
                    match op {
                        "download" => self.download(p, info, &o, stream).await,
                        "upload" => self.upload(p, info, &o, stream).await,
                        _ => self.capture(p, info, &o, stream).await,
                    }
                };
                guard.armed = false;
                let res = match res {
                    Ok(mut d) => {
                        d.summary["ms"] = json!(started.elapsed().as_millis() as u64);
                        let cmd = Command::Audit { op: method, object: d.object, summary: d.summary };
                        let _ = self.pipeline.execute(p.actor(), cmd).await;
                        Ok(d.out)
                    }
                    Err(e) if e.code == ErrorCode::Invalid && e.params.get("reason").map(String::as_str) == Some("timeout") => {
                        // D368: a timed-out transfer is recorded as `timeout`, not as a refusal.
                        let summary = json!({ "ms": started.elapsed().as_millis() as u64 });
                        let cmd = Command::Stopped { op: method, object: named, summary, result: "timeout".into() };
                        let _ = self.pipeline.execute(p.actor(), cmd).await;
                        Err(e)
                    }
                    Err(e) => {
                        let cmd = Command::Refused { op: method, object: named, error: e.clone() };
                        let _ = self.pipeline.execute(p.actor(), cmd).await;
                        Err(e)
                    }
                };
                self.emit(topic2::AUDIT, None, None);
                res
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("transfer.{op}"))])),
        }
    }

    /// A transfer's file end and the folders it may be in (round 15, X2): a relative path is in
    /// the plugin's own folder (`plugin-data/<id>/`, §7.5: no grant needed, nobody else's); an
    /// absolute path is either there too or follows exactly `files`' rules (the capability asked
    /// for, folders granted, nothing inside the data folder). Never the own `bin/` (review #13).
    /// Returns the absolute path to use.
    pub(crate) fn transfer_end(&self, p: &Plugin, raw: &str) -> KResult<(Vec<PathBuf>, String)> {
        let own = self.plugin_data_dir(&p.id)?.canonicalize().map_err(internal)?;
        let abs = if std::path::Path::new(raw).is_absolute() { raw.to_string() } else { own.join(raw).display().to_string() };
        let own_dir = own.clone();
        let mine = vec![own];
        match crate::files::resolve(&mine, &abs) {
            // Review #13: never the plugin's own programs (`bin/`).
            Ok(real) if in_own_bin(&own_dir, &real) => return Err(denied("ownPrograms")),
            Ok(_) => return Ok((mine, abs)),
            // Relative paths never leave the own folder.
            Err(e) if !std::path::Path::new(raw).is_absolute() => return Err(e),
            Err(_) => {}
        }
        if !p.manifest.requires.files {
            return Err(denied("notRequested"));
        }
        let grants: Vec<PathBuf> = self.folder_grants(&p.id)?.into_iter().map(PathBuf::from).collect();
        if let Ok(real) = crate::files::resolve(&grants, &abs) {
            if self.data_roots().iter().any(|d| real.starts_with(d)) {
                return Err(denied("insideDataDir"));
            }
        }
        Ok((grants, abs))
    }

    async fn download(&self, p: &'static Plugin, info: &CallInfo, o: &Value, stream: Option<Arc<Stream>>) -> KResult<Done> {
        let m = options(o)?;
        let to = path_arg(m, "to")?;
        let overwrite = m.get("overwrite").and_then(Value::as_bool) == Some(true);
        let deadline = tokio::time::Instant::now() + timeout_of(m)?;
        let (grants, to) = self.transfer_end(p, &to)?;
        // Checked (and the partial file opened) before anything is sent.
        let mut part = crate::files::part_file(&grants, &to, overwrite)?;
        let sent = self.http_open(p, info, m, Request { default_method: "GET", methods: METHODS, deadline, file: None }).await?;
        let status = sent.resp.status().as_u16();
        let headers = sent.headers();
        let path = part.path.display().to_string();
        let mut summary = json!({ "method": sent.method, "status": status, "path": path });
        let mut out = if !(200..300).contains(&status) {
            // D354: only a 2xx answer is written; the partial file goes with `part`.
            summary["bytes"] = json!(0);
            json!({ "status": status, "headers": headers, "bytes": 0 })
        } else {
            let total = sent.resp.content_length();
            let mut resp = sent.resp;
            let mut file = tokio::fs::File::from_std(part.take_file());
            let mut progress = Progress::new(stream.clone(), total);
            let stop = Progress::stopped(stream);
            tokio::pin!(stop);
            let mut n: u64 = 0;
            loop {
                let chunk = tokio::select! {
                    c = tokio::time::timeout_at(deadline, resp.chunk()) => c.map_err(|_| timed_out())?.map_err(crate::network::read_error)?,
                    _ = &mut stop => return Err(denied("cancelled")),
                };
                let Some(c) = chunk else { break };
                for part in c.chunks(CHUNK) {
                    file.write_all(part).await.map_err(internal)?;
                }
                n += c.len() as u64;
                progress.tick(n);
            }
            file.flush().await.map_err(internal)?;
            file.sync_all().await.map_err(internal)?;
            drop(file);
            part.commit(overwrite)?;
            summary["bytes"] = json!(n);
            json!({ "status": status, "headers": headers, "bytes": n, "path": path })
        };
        // §7.5: a substituted secret never comes back (e.g. echoed in a header).
        crate::secrets::scrub(&mut out, &sent.used);
        Ok(Done { out, object: sent.host, summary })
    }

    async fn upload(&self, p: &'static Plugin, info: &CallInfo, o: &Value, stream: Option<Arc<Stream>>) -> KResult<Done> {
        let m = options(o)?;
        let from = path_arg(m, "from")?;
        let deadline = tokio::time::Instant::now() + timeout_of(m)?;
        let (grants, from) = self.transfer_end(p, &from)?;
        let (path, file, size) = crate::files::open_source(&grants, &from)?;
        let counter = Arc::new(AtomicU64::new(0));
        let file = FileBody { file, size, sent: counter.clone() };
        let req = Request { default_method: "PUT", methods: UPLOAD_METHODS, deadline, file: Some(file) };
        let call = async {
            let sent = self.http_open(p, info, m, req).await?;
            let status = sent.resp.status().as_u16();
            let headers = sent.headers();
            let (host, method, used) = (sent.host, sent.method, sent.used);
            let (body, truncated) = crate::network::read_text_body(sent.resp, deadline).await?;
            Ok::<_, ProtocolError>((status, headers, body, truncated, host, method, used))
        };
        tokio::pin!(call);
        let mut progress = Progress::new(stream.clone(), Some(size));
        let stop = Progress::stopped(stream);
        tokio::pin!(stop);
        let mut tick = tokio::time::interval(PROGRESS_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let (status, headers, body, truncated, host, method, used) = loop {
            tokio::select! {
                r = &mut call => break r?,
                _ = &mut stop => return Err(denied("cancelled")),
                _ = tick.tick() => {
                    let n = counter.load(Ordering::SeqCst);
                    if n > 0 {
                        progress.tick(n);
                    }
                }
            }
        };
        let mut out = json!({ "status": status, "headers": headers, "body": String::from_utf8_lossy(&body), "truncated": truncated });
        crate::secrets::scrub(&mut out, &used);
        let summary = json!({ "method": method, "status": status, "bytes": size, "path": path.display().to_string() });
        Ok(Done { out, object: host, summary })
    }

    async fn capture(&self, p: &'static Plugin, info: &CallInfo, o: &Value, stream: Option<Arc<Stream>>) -> KResult<Done> {
        let m = options(o)?;
        let to = path_arg(m, "to")?;
        let overwrite = m.get("overwrite").and_then(Value::as_bool) == Some(true);
        let program = m.get("program").and_then(Value::as_str).unwrap_or_default().to_string();
        let (grants, to) = self.transfer_end(p, &to)?;
        let mut part = crate::files::part_file(&grants, &to, overwrite)?;
        let path = part.path.display().to_string();
        let mut sink = Sink { file: tokio::fs::File::from_std(part.take_file()), bytes: 0, progress: Progress::new(stream, None) };
        // What `process.run` takes; this call's own keys are not passed on.
        let mut opts = m.clone();
        for k in ["to", "overwrite", "progress", "stream"] {
            opts.remove(k);
        }
        let opts = Value::Object(opts);
        let r = self.process_run(p, info, &opts, Some(&mut sink)).await?;
        sink.file.flush().await.map_err(internal)?;
        sink.file.sync_all().await.map_err(internal)?;
        let bytes = sink.bytes;
        drop(sink);
        // D354: in place whatever the exit code.
        part.commit(overwrite)?;
        let mut summary = json!({ "args": opts.get("args").and_then(Value::as_array).map_or(0, |a| a.len()), "bytes": bytes, "path": path });
        if r.get("signal").is_some_and(|s| !s.is_null()) {
            summary["signal"] = r["signal"].clone();
        } else {
            summary["code"] = r.get("code").cloned().unwrap_or(Value::Null);
        }
        let out = json!({ "code": r["code"], "signal": r["signal"], "stderr": r["stderr"], "truncated": r["truncated"],
                          "bytes": bytes, "path": path });
        Ok(Done { out, object: program, summary })
    }
}

/// Whether `real` (resolved) is inside the plugin folder's `bin/`, whatever the letter case: the
/// file system is case-insensitive, so `BIN/x` is the same file (round 16 review #16).
pub(crate) fn in_own_bin(own: &std::path::Path, real: &std::path::Path) -> bool {
    real.strip_prefix(own)
        .ok()
        .and_then(|rest| rest.components().next())
        .is_some_and(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("bin"))
}
