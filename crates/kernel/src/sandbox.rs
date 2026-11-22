//! One isolated QuickJS runtime per plugin version (kernel-design §7.4, stage-0 findings).
//! The context holds language built-ins only; modules load only from the package's own files;
//! the only way out is `ctx.host`, whose methods end in one async Rust function that knows which
//! invocation is calling (so a cancelled or timed-out invocation's later host calls are refused).
//!
//! D366 (round 9): a `ctx.host` is valid only on its own invocation's asynchronous chain. The
//! engine has no async-context hooks, so the kernel controls every entry into plugin code instead:
//! the synchronous start of a handler (`dispatch`) and the settling of every host call's promise
//! (`settle`). Each entry marks the invocation it belongs to (`Ctl::current`) and runs the job
//! queue empty before it leaves, so every promise job runs under the invocation whose entry (a
//! start, or a host call's answer) caused it. A host call is allowed only when the object it was
//! made with belongs to the invocation running it; otherwise `denied/staleContext`.
//! What this cannot tell apart: code of invocation B that awaits a promise invocation A settles
//! (a shared promise) continues as A — see round9-kernel-done.md.

use std::cell::Cell;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};
use std::time::{Duration, Instant};

use onedesk_protocol::{ErrorCode, Label, ProtocolError};
use rquickjs::context::intrinsic;
use rquickjs::function::This;
use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::promise::MaybePromise;
use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt, Ctx, Function, JsLifetime, Module, Object};
use serde_json::{json, Value};
use tokio::sync::Notify;

#[derive(Debug, Clone)]
pub struct SandboxConfig {
    pub memory_limit: usize,
    pub max_stack: usize,
    /// Module evaluation + `activate(host)`.
    pub activate_timeout: Duration,
    /// One handler invocation, host calls included.
    pub call_timeout: Duration,
    /// Longest synchronous stretch of JS (dead-loop watchdog).
    pub sync_slice: Duration,
    /// D361: the most one invocation's budget is paused while it waits for `transfer.*` /
    /// `process.run` (1 hour; tests set it lower).
    pub max_wait_pause: Duration,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            memory_limit: 32 * 1024 * 1024,
            max_stack: 512 * 1024,
            activate_timeout: Duration::from_secs(10),
            call_timeout: Duration::from_secs(15),
            sync_slice: Duration::from_secs(1),
            max_wait_pause: crate::install::MAX_WAIT_PAUSE,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SandboxError {
    /// Thrown by plugin code (message + stack).
    Js(String),
    /// Time budget exceeded or watchdog fired. The runtime must be discarded.
    Timeout,
    /// The runtime must be discarded.
    OutOfMemory,
    Cancelled,
    Engine(String),
    /// A host-call error the handler let through (e.g. `conflict` from `files.writeText`).
    Host(ProtocolError),
}

impl SandboxError {
    /// Whether the runtime is no longer trustworthy (§7.4: discard it, re-activate on next use).
    pub fn poisons(&self) -> bool {
        matches!(self, SandboxError::Timeout | SandboxError::OutOfMemory)
    }

    pub fn to_protocol(&self) -> ProtocolError {
        if let SandboxError::Host(e) = self {
            return e.clone();
        }
        let (code, reason) = match self {
            SandboxError::Host(_) => unreachable!(),
            SandboxError::Timeout => (ErrorCode::PluginTimeout, "timeout"),
            SandboxError::OutOfMemory => (ErrorCode::PluginError, "outOfMemory"),
            SandboxError::Cancelled => (ErrorCode::PluginError, "cancelled"),
            SandboxError::Js(_) => (ErrorCode::PluginError, "threw"),
            SandboxError::Engine(_) => (ErrorCode::PluginError, "engine"),
        };
        ProtocolError {
            code,
            params: BTreeMap::from([("reason".to_string(), reason.to_string())]),
            detail: Some(self.to_string()),
        }
    }
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxError::Js(m) => write!(f, "plugin error: {m}"),
            SandboxError::Timeout => write!(f, "plugin timed out"),
            SandboxError::OutOfMemory => write!(f, "plugin out of memory"),
            SandboxError::Cancelled => write!(f, "cancelled"),
            SandboxError::Engine(m) => write!(f, "engine error: {m}"),
            SandboxError::Host(e) => write!(f, "host error: {:?}", e.code),
        }
    }
}

pub type HostFuture = Pin<Box<dyn Future<Output = Result<Value, ProtocolError>> + Send>>;

/// Who started the invocation a host call belongs to.
#[derive(Debug, Clone, Default)]
pub struct CallInfo {
    pub client: Option<String>,
    /// The tab's environment (for `host.params`).
    pub env_id: Option<String>,
    /// Set for action invocations: progress goes to this run.
    pub run_id: Option<String>,
    /// D301: a pure computation (`migrate`): writing host calls are refused.
    pub pure: bool,
    /// The resource the call is about (its saved secret references are usable, D318).
    pub resource_id: Option<String>,
    /// Round 6 (D336): an event handler — no programs, no network; its writes raise no events
    /// for the same plugin.
    pub event: bool,
    /// Round 7: a page event handler (the user acted on the page) — may ask to install plugins.
    pub page_event: bool,
    /// Round 11 (D386): `ui.openExternal` calls made so far in this invocation.
    pub external_opens: Arc<std::sync::atomic::AtomicUsize>,
    /// Round 7 (D345): held while a host call waits for the user; that time is not counted.
    pub hold: Arc<crate::install::Hold>,
    /// Round 12 (D394): set while a kind's `drop` runs — its `resources.update` calls are kept
    /// here and written together after it answers `handled: true`; other writes are refused.
    pub drop_writes: Option<Arc<std::sync::Mutex<Vec<crate::pipeline::Command>>>>,
    /// Round 15 (D413): plugins whose `host.actions.call` led to this invocation, outermost first.
    pub callers: Vec<String>,
}

/// The only capability a plugin has. One instance per plugin version.
pub trait HostApi: Send + Sync + 'static {
    fn call(&self, info: Arc<CallInfo>, method: String, args: Value) -> HostFuture;
}

/// Cancels one handler invocation.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<CancelInner>);

#[derive(Default)]
struct CancelInner {
    flag: AtomicBool,
    notify: Notify,
    /// Why: `cancelled` (asked to) or `timeout`; reported to later host calls.
    reason: Mutex<Option<&'static str>>,
}

impl CancelToken {
    pub fn cancel(&self) {
        self.cancel_with("cancelled");
    }
    /// Cancels with a reason (the first reason wins).
    pub fn cancel_with(&self, reason: &'static str) {
        self.0.reason.lock().unwrap().get_or_insert(reason);
        self.0.flag.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }
    pub fn reason(&self) -> &'static str {
        self.0.reason.lock().unwrap().unwrap_or("cancelled")
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.flag.load(Ordering::SeqCst)
    }
    pub async fn cancelled(&self) {
        loop {
            let n = self.0.notify.notified();
            if self.is_cancelled() {
                return;
            }
            n.await;
        }
    }
}

struct Ctl {
    slice: Duration,
    interrupted: AtomicBool,
    /// An interrupt inside a resumed continuation leaves the handler's promise unsettled forever,
    /// so waiting invocations are told directly.
    watchdog: Notify,
    calls: Mutex<HashMap<u64, (CancelToken, Arc<CallInfo>)>>,
    next_call: AtomicU64,
    /// D366: the invocation whose code is running now (0 = none known). Set only while the
    /// runtime lock is held: around a handler's synchronous start and a host call's settling.
    current: AtomicU64,
    next_ticket: AtomicU64,
    /// The context host-call answers are delivered through; cleared when the sandbox is dropped
    /// (the runtime holds `Ctl`, so keeping it would be a cycle).
    actx: Mutex<Option<AsyncContext>>,
}

impl Ctl {
    /// Runs every pending promise job, as part of the invocation marked current.
    fn drain(ctx: &Ctx<'_>) {
        while ctx.execute_pending_job() {}
    }
}

thread_local! {
    /// When the current thread started polling sandbox code (JS only runs inside such a poll,
    /// and the interrupt handler runs on that same thread).
    static SLICE_START: Cell<Option<Instant>> = const { Cell::new(None) };
}

struct Watched<F> {
    inner: Pin<Box<F>>,
}

impl<F: Future> Future for Watched<F> {
    type Output = F::Output;
    fn poll(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        SLICE_START.set(Some(Instant::now()));
        let r = self.inner.as_mut().poll(cx);
        SLICE_START.set(None);
        r
    }
}

fn watched<F: Future>(f: F) -> Watched<F> {
    Watched { inner: Box::pin(f) }
}

struct Dispatch<'js>(Function<'js>);
unsafe impl<'js> JsLifetime<'js> for Dispatch<'js> {
    type Changed<'to> = Dispatch<'to>;
}

/// The bootstrap's `settle(ticket, envelope)`: resolves one host call's promise.
struct Settle<'js>(Function<'js>);
unsafe impl<'js> JsLifetime<'js> for Settle<'js> {
    type Changed<'to> = Settle<'to>;
}

/// Resolves only `./x.js` imports among the package's own files.
struct PackageFiles(Arc<HashMap<String, String>>);

impl Resolver for PackageFiles {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        let target = name.strip_prefix("./").filter(|n| !n.contains("..") && !n.starts_with('/'));
        match target {
            Some(n) if self.0.contains_key(n) => Ok(n.to_string()),
            _ => Err(rquickjs::Error::new_resolving(base, name)),
        }
    }
}

impl Loader for PackageFiles {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, Declared>> {
        match self.0.get(name) {
            Some(src) => Module::declare(ctx.clone(), name, src.as_str()),
            None => Err(rquickjs::Error::new_loading(name)),
        }
    }
}

/// Builds the registration-only `host` for `activate`, the per-invocation `ctx.host`, and
/// `dispatch` (what the kernel calls). Plain script; nothing is left on the global object.
const BOOTSTRAP: &str = r#"
(function (hostCall, isCancelled, declaredJson, labelsJson) {
  "use strict";
  const declared = JSON.parse(declaredJson);
  const labels = JSON.parse(labelsJson);
  const reg = { pages: {}, trees: {}, commands: {}, actions: {}, kinds: {}, events: {} };
  const reg_host = {};
  for (const kind of ["pages", "trees", "commands", "actions", "kinds"]) {
    reg_host[kind] = Object.freeze({
      handle(name, h) {
        name = String(name);
        if (!declared[kind].includes(name)) {
          const e = new Error("undeclared " + kind + " handler: " + name);
          e.code = "denied";
          throw e;
        }
        if (kind === "kinds" && h && h.children !== undefined && !declared.kind_children.includes(name)) {
          const e = new Error("undeclared children of kind: " + name);
          e.code = "denied";
          throw e;
        }
        if (kind === "kinds" && h && h.drop !== undefined && !declared.kind_drop.includes(name)) {
          const e = new Error("undeclared drop of kind: " + name);
          e.code = "denied";
          throw e;
        }
        reg[kind][name] = h;
      },
    });
  }
  // Round 6 (D335): only events the manifest subscribes to.
  const events = Object.freeze({
    on(name, h) {
      name = String(name);
      if (!declared.events.includes(name)) {
        const e = new Error("undeclared event: " + name);
        e.code = "denied";
        throw e;
      }
      reg.events[name] = h;
    },
  });
  reg_host.events = events;
  // A host call returns a ticket at once; the kernel settles it later (see `settle`), entering
  // the engine as the invocation that made the call (D366).
  const pending = new Map();
  const settle = (ticket, s) => {
    const r = pending.get(ticket);
    pending.delete(ticket);
    if (r) r(s);
  };
  const call = async (callId, method, args) => {
    const ticket = hostCall(callId, method, JSON.stringify(args === undefined ? null : args));
    const r = JSON.parse(await new Promise((res) => pending.set(ticket, res)));
    if (r.err !== undefined) {
      // Round 16: a called plugin's failure says what it said (scrubbed by the kernel).
      const callee = r.err.code === "pluginError" && r.err.params && r.err.params.reason === "calleeFailed";
      const e = new Error(callee && typeof r.err.detail === "string" && r.err.detail ? r.err.detail : r.err.code);
      e.code = r.err.code;
      e.params = r.err.params || {};
      if (r.err.detail !== undefined) e.detail = r.err.detail;
      throw e;
    }
    return r.ok;
  };
  let streamSeq = 0;
  // `process.run` with `onOutput`: the run and a pump that polls the output stream go side by
  // side; the result comes after every chunk was handed to `onOutput`.
  const runProcess = async (callId, opts) => {
    const o = Object.assign({}, opts || {});
    const on = o.onOutput;
    delete o.onOutput;
    if (typeof on !== "function") return call(callId, "process.run", [o]);
    const sid = "s" + (++streamSeq);
    o.stream = sid;
    let failure;
    const pump = (async () => {
      for (;;) {
        const batch = await call(callId, "process.output", [sid]);
        if (batch === null) return;
        for (const chunk of batch) {
          if (failure !== undefined) continue;
          try {
            await on(chunk);
          } catch (e) {
            failure = { e };
            call(callId, "process.stop", [sid]).catch(() => {});
          }
        }
      }
    })();
    let res, err;
    try {
      res = await call(callId, "process.run", [o]);
    } catch (e) {
      err = { e };
    }
    await pump.catch(() => {});
    if (failure) throw failure.e;
    if (err) throw err.e;
    return res;
  };
  // `transfer.*` with `onProgress`: like `onOutput`, a pump polls the progress stream; only the
  // latest report of a batch is handed over.
  const runTransfer = async (callId, method, opts) => {
    const o = Object.assign({}, opts || {});
    const on = o.onProgress;
    delete o.onProgress;
    delete o.progress;
    if (typeof on !== "function") return call(callId, method, [o]);
    const sid = "t" + (++streamSeq);
    o.progress = sid;
    let failure;
    const pump = (async () => {
      for (;;) {
        const batch = await call(callId, "transfer.progress", [sid]);
        if (batch === null) return;
        if (failure !== undefined || batch.length === 0) continue;
        try {
          await on(batch[batch.length - 1]);
        } catch (e) {
          failure = { e };
          call(callId, "transfer.stop", [sid]).catch(() => {});
        }
      }
    })();
    let res, err;
    try {
      res = await call(callId, method, [o]);
    } catch (e) {
      err = { e };
    }
    await pump.catch(() => {});
    if (failure) throw failure.e;
    if (err) throw err.e;
    return res;
  };
  // `network.request` with `onChunk` (round 18, X16): like `onOutput`, a pump polls the blocks
  // of the response and hands them over one by one, in order; the answer comes after the last.
  const runNetwork = async (callId, opts) => {
    const o = Object.assign({}, opts || {});
    const on = o.onChunk;
    delete o.onChunk;
    delete o.streamId;
    if (typeof on !== "function") return call(callId, "network.request", [o]);
    if (o.stream !== true) {
      const e = new Error("onChunk needs stream: true");
      e.code = "invalidParams";
      throw e;
    }
    const sid = "n" + (++streamSeq);
    o.streamId = sid;
    let failure;
    const pump = (async () => {
      for (;;) {
        const batch = await call(callId, "network.output", [sid]);
        if (batch === null) return;
        for (const chunk of batch) {
          if (failure !== undefined) continue;
          try {
            await on(chunk);
          } catch (e) {
            failure = { e };
            call(callId, "network.stop", [sid]).catch(() => {});
          }
        }
      }
    })();
    let res, err;
    try {
      res = await call(callId, "network.request", [o]);
    } catch (e) {
      err = { e };
    }
    await pump.catch(() => {});
    if (failure) throw failure.e;
    if (err) throw err.e;
    return res;
  };
  const makeHost = (callId) => {
    const c = (m) => (...a) => call(callId, m, a);
    return Object.freeze({
      resources: Object.freeze({
        get: c("resources.get"), list: c("resources.list"), create: c("resources.create"),
        update: c("resources.update"), move: c("resources.move"), remove: c("resources.remove"),
        search: c("resources.search"), upsertByKey: c("resources.upsertByKey"),
      }),
      files: Object.freeze({
        roots: c("files.roots"), list: c("files.list"), stat: c("files.stat"),
        readText: c("files.readText"), writeText: c("files.writeText"),
        mkdir: c("files.mkdir"), copy: c("files.copy"), move: c("files.move"), trash: c("files.trash"),
        remove: c("files.remove"), open: c("files.open"), reveal: c("files.reveal"), find: c("files.find"),
        addRoot: c("files.addRoot"), replaceRoot: c("files.replaceRoot"), removeRoot: c("files.removeRoot"),
      }),
      runs: Object.freeze({ partial: c("runs.partial"), read: c("runs.read") }),
      interfaces: Object.freeze({ call: c("interfaces.call"), list: c("interfaces.list") }),
      ui: Object.freeze({ open: c("ui.open"), notify: c("ui.notify"), copy: c("ui.copy"), openExternal: c("ui.openExternal") }),
      params: Object.freeze({ get: c("params.get"), config: c("params.config") }),
      storage: Object.freeze({
        get: c("storage.get"), set: c("storage.set"), remove: c("storage.remove"), keys: c("storage.keys"),
        readFrom: c("storage.readFrom"),
      }),
      settings: Object.freeze({ get: c("settings.get") }),
      util: Object.freeze({ sleep: c("util.sleep") }),
      network: Object.freeze({ request: (opts) => runNetwork(callId, opts) }),
      secrets: Object.freeze({ get: c("secrets.get") }),
      plugins: Object.freeze({ requestInstall: c("plugins.requestInstall"), list: c("plugins.list") }),
      process: Object.freeze({ run: (opts) => runProcess(callId, opts), ready: c("process.ready") }),
      transfer: Object.freeze({
        download: (opts) => runTransfer(callId, "transfer.download", opts),
        upload: (opts) => runTransfer(callId, "transfer.upload", opts),
        capture: (opts) => runTransfer(callId, "transfer.capture", opts),
      }),
      actions: Object.freeze({ call: c("actions.call") }),
      events,
    });
  };
  const hostCodes = ["conflict", "denied", "invalid", "notFound", "invalidParams"];
  const t = (key) => (Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : String(key));
  const dispatch = async (callId, kind, name, fn, argsJson) => {
    const h = reg[kind] && reg[kind][name];
    const f = fn === "" ? h : h && h[fn];
    // A kind without `migrate` keeps its body as it is (§7.6): answered as `null`.
    if (typeof f !== "function" && kind === "kinds") return JSON.stringify({ ok: null });
    // An event the plugin subscribed to but registered no handler for: nothing to do.
    if (typeof f !== "function" && kind === "events") return JSON.stringify({ ok: null });
    if (typeof f !== "function") throw new Error("no handler: " + kind + "/" + name + (fn ? "." + fn : ""));
    const args = JSON.parse(argsJson);
    // D375: the resource a kind's `children` is asked about is read-only.
    const freeze = (v) => {
      if (v && typeof v === "object") {
        Object.values(v).forEach(freeze);
        Object.freeze(v);
      }
      return v;
    };
    // Round 12 (D390): a kind's `drop` gets the target resource to change (through ctx.host).
    if (args[0] && args[0].resource && !(kind === "kinds" && fn === "drop")) freeze(args[0].resource);
    const ctx = Object.assign({}, args[0], {
      host: makeHost(callId),
      t,
      // Not host calls: progress after cancellation is dropped silently; cancelled() is synchronous.
      progress: (fraction, message) => {
        call(callId, "runs.progress", [fraction === undefined ? null : fraction, message === undefined ? null : String(message)]).catch(() => {});
      },
      cancelled: () => isCancelled(callId),
    });
    try {
      // `kinds.migrate` takes (body, fromVersion, ctx), as the manifest documentation writes it;
      // everything else, `kinds.children` and `kinds.drop` included, takes ctx first.
      const out = kind === "kinds" && fn !== "children" && fn !== "drop" ? await f.call(h, ...args.slice(1), ctx) : await f.call(h, ctx, ...args.slice(1));
      return JSON.stringify({ ok: out === undefined ? null : out });
    } catch (e) {
      // A host error the handler did not catch keeps its code.
      if (e && hostCodes.includes(e.code)) {
        // Round 16: without a `detail`, the message the plugin wrote (if it is not just the code).
        const m = typeof e.message === "string" && e.message && e.message !== e.code ? e.message : undefined;
        const d = typeof e.detail === "string" ? e.detail : m;
        return JSON.stringify({ hostError: { code: e.code, params: e.params || {}, detail: d } });
      }
      throw e;
    }
  };
  return { host: Object.freeze(reg_host), dispatch, settle };
})
"#;

/// Names the manifest declares; registering anything else fails activation (§7.5).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Declarations {
    pub pages: Vec<String>,
    pub trees: Vec<String>,
    pub commands: Vec<String>,
    pub actions: Vec<String>,
    pub kinds: Vec<String>,
    /// D375: kinds whose manifest declares `children`; only they may register a `children` handler.
    pub kind_children: Vec<String>,
    /// Round 12 (D390): kinds whose manifest declares `drop`; only they may register a `drop` handler.
    pub kind_drop: Vec<String>,
    pub events: Vec<String>,
}

pub struct Package {
    pub id: String,
    pub main: String,
    /// Relative path → source of every `.js` file in the package.
    pub files: HashMap<String, String>,
    pub declared: Declarations,
    pub labels: BTreeMap<String, Label>,
}

pub struct Sandbox {
    pub id: String,
    rt: AsyncRuntime,
    ctx: AsyncContext,
    ctl: Arc<Ctl>,
    cfg: SandboxConfig,
    drive: tokio::task::JoinHandle<()>,
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        self.ctl.actx.lock().unwrap().take();
        self.drive.abort();
        // Fail whatever is still waiting on this runtime.
        for (t, _) in self.ctl.calls.lock().unwrap().values() {
            t.cancel();
        }
    }
}

fn classify(ctl: &Ctl, msg: String) -> SandboxError {
    if ctl.interrupted.swap(false, Ordering::SeqCst) || msg.contains("interrupted") {
        SandboxError::Timeout
    } else if msg.contains("out of memory") {
        SandboxError::OutOfMemory
    } else {
        SandboxError::Js(msg)
    }
}

impl Sandbox {
    /// Creates the runtime, evaluates `main` as an ES module and calls `default.activate(host)`.
    pub async fn activate(pkg: Package, host: Arc<dyn HostApi>, cfg: SandboxConfig) -> Result<Self, SandboxError> {
        let engine = |e: rquickjs::Error| SandboxError::Engine(e.to_string());
        let rt = AsyncRuntime::new().map_err(engine)?;
        rt.set_memory_limit(cfg.memory_limit).await;
        rt.set_max_stack_size(cfg.max_stack).await;
        let ctl = Arc::new(Ctl {
            slice: cfg.sync_slice,
            interrupted: AtomicBool::new(false),
            watchdog: Notify::new(),
            calls: Mutex::new(HashMap::new()),
            next_call: AtomicU64::new(1),
            current: AtomicU64::new(0),
            next_ticket: AtomicU64::new(1),
            actx: Mutex::new(None),
        });
        let ictl = ctl.clone();
        rt.set_interrupt_handler(Some(Box::new(move || {
            let over = SLICE_START.get().is_some_and(|t| t.elapsed() > ictl.slice);
            if over {
                ictl.interrupted.store(true, Ordering::SeqCst);
                ictl.watchdog.notify_waiters();
            }
            over
        })))
        .await;
        let files = Arc::new(pkg.files);
        rt.set_loader(PackageFiles(files.clone()), PackageFiles(files.clone())).await;

        // Language built-ins only: no std/os modules, console, timers or fetch.
        let ctx = AsyncContext::custom::<(
            intrinsic::Date,
            intrinsic::Eval,
            intrinsic::RegExpCompiler,
            intrinsic::RegExp,
            intrinsic::Json,
            intrinsic::MapSet,
            intrinsic::TypedArrays,
            intrinsic::Promise,
        )>(&rt)
        .await
        .map_err(engine)?;

        let drive = tokio::spawn(watched(rt.drive()));
        *ctl.actx.lock().unwrap() = Some(ctx.clone());
        let sb = Sandbox { id: pkg.id.clone(), rt, ctx, ctl, cfg, drive };

        let source = files.get(&pkg.main).cloned().ok_or_else(|| SandboxError::Engine("main missing".into()))?;
        let main = pkg.main.clone();
        let declared = serde_json::to_string(&pkg.declared).expect("json");
        let labels = serde_json::to_string(&pkg.labels).expect("json");
        let hctl = sb.ctl.clone();
        let cancel_ctl = sb.ctl.clone();
        let fut = sb.ctx.async_with(async move |ctx| -> Result<(), String> {
            let js = |ctx: &Ctx<'_>, e: rquickjs::Error| Err::<(), _>(e).catch(ctx).unwrap_err().to_string();
            let host_call = Function::new(ctx.clone(), move |call_id: f64, method: String, args: String| -> f64 {
                let call_id = call_id as u64;
                let ticket = hctl.next_ticket.fetch_add(1, Ordering::SeqCst);
                // D366: who is running this code, and whose `ctx.host` it used.
                let running = hctl.current.load(Ordering::SeqCst);
                let entry = hctl.calls.lock().unwrap().get(&call_id).cloned();
                let (host, ctl) = (host.clone(), hctl.clone());
                tokio::spawn(async move {
                    let res = if running != call_id {
                        Err(refusal("staleContext"))
                    } else {
                        host_call_inner(host, entry, method, args).await
                    };
                    let env = match res {
                        Ok(v) => json!({ "ok": v }),
                        // D368: the detail goes as far as `RunError.detail` (it names a host at most).
                        Err(e) => json!({ "err": { "code": e.code, "params": e.params, "detail": e.detail } }),
                    };
                    settle(&ctl, running, ticket, env.to_string()).await;
                });
                ticket as f64
            })
            .map_err(|e| js(&ctx, e))?;
            let cctl = cancel_ctl.clone();
            let is_cancelled = Function::new(ctx.clone(), move |call_id: f64| -> bool {
                cctl.calls.lock().unwrap().get(&(call_id as u64)).is_none_or(|(t, _)| t.is_cancelled())
            })
            .map_err(|e| js(&ctx, e))?;
            let boot: Function = ctx.eval(BOOTSTRAP).map_err(|e| js(&ctx, e))?;
            let obj: Object = boot.call((host_call, is_cancelled, declared, labels)).map_err(|e| js(&ctx, e))?;
            let host_obj: Object = obj.get("host").map_err(|e| js(&ctx, e))?;
            let dispatch: Function = obj.get("dispatch").map_err(|e| js(&ctx, e))?;
            let _ = ctx.store_userdata(Dispatch(dispatch));
            let settle_fn: Function = obj.get("settle").map_err(|e| js(&ctx, e))?;
            let _ = ctx.store_userdata(Settle(settle_fn));

            let module = Module::declare(ctx.clone(), main, source).map_err(|e| js(&ctx, e))?;
            let (module, promise) = module.eval().map_err(|e| js(&ctx, e))?;
            promise.into_future::<()>().await.map_err(|e| js(&ctx, e))?;
            let def: Object = module.get("default").map_err(|e| js(&ctx, e))?;
            let activate: Function = def.get("activate").map_err(|e| js(&ctx, e))?;
            let ret: MaybePromise = activate.call((This(def), host_obj)).map_err(|e| js(&ctx, e))?;
            ret.into_future::<rquickjs::Value>().await.map_err(|e| js(&ctx, e))?;
            Ok(())
        });
        let watchdog = sb.ctl.watchdog.notified();
        tokio::select! {
            r = tokio::time::timeout(sb.cfg.activate_timeout, watched(fut)) => match r {
                Err(_) => Err(SandboxError::Timeout),
                Ok(Err(msg)) => Err(classify(&sb.ctl, msg)),
                Ok(Ok(())) => {
                sb.rearm().await;
                Ok(sb)
            }
            },
            _ = watchdog => Err(SandboxError::Timeout),
        }
    }

    /// Calls a registered handler: `kind` is `pages`/`trees`/`commands`, `func` the method
    /// (`""` for command functions). `args` is a JSON array whose first element becomes `ctx`.
    pub async fn call(
        &self,
        kind: &str,
        name: &str,
        func: &str,
        args: &Value,
        info: CallInfo,
        cancel: Option<CancelToken>,
    ) -> Result<Value, SandboxError> {
        self.call_with(kind, name, func, args, info, cancel, self.cfg.call_timeout).await
    }

    /// `call` with its own time budget (actions get longer than renders, D288).
    #[allow(clippy::too_many_arguments)]
    pub async fn call_with(
        &self,
        kind: &str,
        name: &str,
        func: &str,
        args: &Value,
        info: CallInfo,
        cancel: Option<CancelToken>,
        timeout: Duration,
    ) -> Result<Value, SandboxError> {
        let token = cancel.unwrap_or_default();
        let hold = info.hold.clone();
        hold.set_cap(self.cfg.max_wait_pause);
        let call_id = self.ctl.next_call.fetch_add(1, Ordering::SeqCst);
        self.ctl.calls.lock().unwrap().insert(call_id, (token.clone(), Arc::new(info)));
        let (kind, name, func) = (kind.to_string(), name.to_string(), func.to_string());
        let args_json = args.to_string();
        let ctl = self.ctl.clone();
        let fut = self.ctx.async_with(async move |ctx| -> Result<String, String> {
            let js = |ctx: &Ctx<'_>, e: rquickjs::Error| Err::<(), _>(e).catch(ctx).unwrap_err().to_string();
            // A stale exception left by an interrupted pending job must not be reported as ours.
            let _ = ctx.catch();
            let dispatch = ctx.userdata::<Dispatch>().ok_or("no dispatcher")?.0.clone();
            // D366: the handler's synchronous start, and every job it queues, run as this call.
            ctl.current.store(call_id, Ordering::SeqCst);
            let ret = dispatch.call::<_, MaybePromise>((call_id as f64, kind, name, func, args_json));
            if ret.is_ok() {
                Ctl::drain(&ctx);
            }
            ctl.current.store(0, Ordering::SeqCst);
            let ret = ret.map_err(|e| js(&ctx, e))?;
            ret.into_future::<String>().await.map_err(|e| js(&ctx, e))
        });
        let watchdog = self.ctl.watchdog.notified();
        // The time budget; time spent waiting for the user does not count (D345).
        let started = tokio::time::Instant::now();
        let budget = async {
            loop {
                if hold.held() {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
                let until = tokio::time::Instant::from_std(hold.deadline(started.into_std(), timeout));
                if tokio::time::Instant::now() >= until {
                    break;
                }
                tokio::time::sleep_until(until).await;
            }
        };
        let res = tokio::select! {
            r = watched(fut) => match r {
                _ if token.is_cancelled() => Err(SandboxError::Cancelled),
                Err(msg) => Err(classify(&self.ctl, msg)),
                Ok(s) => unwrap_envelope(&s),
            },
            _ = budget => { token.cancel_with("timeout"); Err(SandboxError::Timeout) }
            _ = token.cancelled() => Err(SandboxError::Cancelled),
            // We cannot tell which invocation was spinning; every in-flight call fails.
            _ = watchdog => { token.cancel_with("timeout"); Err(SandboxError::Timeout) }
        };
        // Forgotten after any outcome: late host calls from an orphaned continuation are refused.
        self.ctl.calls.lock().unwrap().remove(&call_id);
        // Review #2: host calls the handler left running (not awaited) end with it — e.g. a
        // `process.run` it did not wait for is dropped, which ends the program.
        token.cancel_with("callEnded");
        self.rearm().await;
        res
    }

    /// The engine's scheduler remembers one waker: the last one that polled it. When a call that
    /// polled it ends, wake-ups of futures still pending for *other* invocations (a timer, a
    /// database reply) would go to that finished task and be lost. Pushing an empty job wakes
    /// the runtime's own driver, which polls again and registers itself (found in round 6:
    /// an event handler waiting on `util.sleep` while a page rendered never resumed).
    async fn rearm(&self) {
        self.ctx.with(|ctx| ctx.spawn(async {})).await;
    }

    /// Test helper: evaluates a script in the plugin's global scope, returning its JSON.
    pub async fn eval_json(&self, code: &str) -> Result<Value, SandboxError> {
        let code = code.to_string();
        let fut = self.ctx.async_with(async move |ctx| -> Result<String, String> {
            let v: rquickjs::Value = ctx.eval(code).catch(&ctx).map_err(|e| e.to_string())?;
            let s = ctx.json_stringify(v).catch(&ctx).map_err(|e| e.to_string())?;
            Ok(s.map(|s| s.to_string().unwrap_or_default()).unwrap_or_else(|| "null".into()))
        });
        let s = watched(fut).await.map_err(|m| classify(&self.ctl, m))?;
        serde_json::from_str(&s).map_err(|e| SandboxError::Js(e.to_string()))
    }

    pub async fn heap_bytes(&self) -> i64 {
        self.rt.memory_usage().await.malloc_size
    }
}

fn unwrap_envelope(s: &str) -> Result<Value, SandboxError> {
    let mut v: Value = serde_json::from_str(s).map_err(|e| SandboxError::Js(e.to_string()))?;
    if let Some(e) = v.get("hostError") {
        return Err(serde_json::from_value::<ProtocolError>(e.clone())
            .map(SandboxError::Host)
            .unwrap_or_else(|e| SandboxError::Js(e.to_string())));
    }
    Ok(v.get_mut("ok").map(Value::take).unwrap_or(Value::Null))
}

fn refusal(reason: &str) -> ProtocolError {
    ProtocolError { code: ErrorCode::Denied, params: BTreeMap::from([("reason".into(), reason.to_string())]), detail: None }
}

/// Delivers a host call's answer: enters the engine as the invocation that made the call, settles
/// its promise and runs the job queue empty (D366). Under the dead-loop watchdog like any entry.
async fn settle(ctl: &Arc<Ctl>, running: u64, ticket: u64, envelope: String) {
    let Some(actx) = ctl.actx.lock().unwrap().clone() else { return };
    let c = ctl.clone();
    watched(actx.with(move |ctx| {
        let Some(f) = ctx.userdata::<Settle>().map(|s| s.0.clone()) else { return };
        c.current.store(running, Ordering::SeqCst);
        if f.call::<_, ()>((ticket as f64, envelope)).is_err() {
            let _ = ctx.catch();
        }
        Ctl::drain(&ctx);
        c.current.store(0, Ordering::SeqCst);
    }))
    .await;
}

async fn host_call_inner(
    host: Arc<dyn HostApi>,
    entry: Option<(CancelToken, Arc<CallInfo>)>,
    method: String,
    args: String,
) -> Result<Value, ProtocolError> {
    let refused = refusal;
    // No live invocation (activation-time code, or one already over): `callEnded`;
    // a cancelled or timed-out one: `cancelled` / `timeout`.
    let Some((token, info)) = entry else { return Err(refused("callEnded")) };
    if token.is_cancelled() {
        return Err(refused(token.reason()));
    }
    let args: Value = serde_json::from_str(&args).map_err(|e| crate::util::invalid_params(e.to_string()))?;
    tokio::select! {
        r = host.call(info, method, args) => r,
        _ = token.cancelled() => Err(refused(token.reason())),
    }
}
