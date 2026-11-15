//! One isolated QuickJS runtime per plugin. No ambient capabilities: the
//! context is built from a fixed list of language intrinsics, there is no
//! module loader for anything but the plugin's own files, and the only way out
//! is the `host` object whose methods end in one async Rust function.
use std::cell::Cell;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};
use std::time::{Duration, Instant};

use rquickjs::context::intrinsic;
use rquickjs::function::{Async, This};
use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::promise::MaybePromise;
use rquickjs::{
    AsyncContext, AsyncRuntime, CatchResultExt, Ctx, Function, JsLifetime, Module, Object,
};
use serde_json::Value;
use tokio::sync::Notify;

#[derive(Debug, Clone)]
pub struct SandboxConfig {
    pub memory_limit: usize,
    pub max_stack: usize,
    /// Total time allowed for module evaluation + `activate(host)`.
    pub activate_timeout: Duration,
    /// Total time allowed for one handler call (including awaited host calls).
    pub call_timeout: Duration,
    /// Longest uninterrupted synchronous stretch of JS (dead-loop watchdog).
    pub sync_slice: Duration,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            memory_limit: 64 * 1024 * 1024,
            max_stack: 512 * 1024,
            activate_timeout: Duration::from_secs(10),
            call_timeout: Duration::from_secs(30),
            sync_slice: Duration::from_secs(1),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxError {
    /// Exception thrown by plugin code (message + stack).
    Js(String),
    /// Activation or call exceeded its time budget, or the watchdog fired.
    Timeout,
    OutOfMemory,
    Cancelled,
    Engine(String),
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxError::Js(m) => write!(f, "plugin error: {m}"),
            SandboxError::Timeout => write!(f, "plugin timed out"),
            SandboxError::OutOfMemory => write!(f, "plugin out of memory"),
            SandboxError::Cancelled => write!(f, "cancelled"),
            SandboxError::Engine(m) => write!(f, "engine error: {m}"),
        }
    }
}

pub type HostFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;

/// The only capability a plugin has.
pub trait HostApi: Send + Sync + 'static {
    fn call(&self, plugin: &str, method: &str, args: Value) -> HostFuture;
}

/// Token for cancelling one handler invocation.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<CancelInner>);

#[derive(Default)]
struct CancelInner {
    flag: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.flag.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
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
    /// Fired by the watchdog. An interrupt inside a resumed continuation (a
    /// pending job) leaves the handler's promise unsettled forever, so waiting
    /// calls must be told directly.
    watchdog: Notify,
    /// Live invocations: call id → cancel token.
    calls: Mutex<HashMap<u64, CancelToken>>,
    next_call: AtomicU64,
}

thread_local! {
    /// When the current thread started polling sandbox code. JS only ever runs
    /// inside such a poll, and the interrupt handler runs on that same thread,
    /// so a thread-local is exact even when several tasks poll one runtime.
    static SLICE_START: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// Marks the start of every synchronous slice so the interrupt handler can
/// tell how long JS has been running without yielding.
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

/// Resolves only relative imports inside the plugin's own in-memory files.
struct PluginFiles(Arc<HashMap<String, String>>);

impl Resolver for PluginFiles {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        let target = name.strip_prefix("./").filter(|n| !n.contains(".."));
        match target {
            Some(n) if self.0.contains_key(n) => Ok(n.to_string()),
            _ => Err(rquickjs::Error::new_resolving(base, name)),
        }
    }
}

impl Loader for PluginFiles {
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

/// Builds `host` (what the plugin sees) and `dispatch` (what the kernel calls).
/// Runs as a plain script; nothing is left on the global object.
const BOOTSTRAP: &str = r#"
(function (hostCall) {
  "use strict";
  const reg = { pages: {}, kinds: {}, actions: {}, trees: {} };
  const call = async (callId, method, args) => {
    const r = JSON.parse(await hostCall(callId, method, JSON.stringify(args === undefined ? null : args)));
    if (r.err !== undefined) throw new Error(r.err);
    return r.ok;
  };
  const makeHost = (callId) => ({
    storage: {
      get: (key) => call(callId, "storage.get", { key }),
      set: (key, value) => call(callId, "storage.set", { key, value }),
    },
    params: { get: (name) => call(callId, "params.get", { name }) },
    test: {
      sleep: (ms) => call(callId, "test.sleep", { ms }),
      echo: (v) => call(callId, "test.echo", v),
    },
  });
  const host = makeHost(0);
  for (const kind of Object.keys(reg)) {
    host[kind] = { handle(name, h) { reg[kind][String(name)] = h; } };
  }
  const dispatch = async (callId, kind, name, fn, argsJson) => {
    const h = reg[kind] && reg[kind][name];
    const f = typeof h === "function" && fn === "" ? h : h && h[fn];
    if (typeof f !== "function") throw new Error("no handler: " + kind + "/" + name + "." + fn);
    const args = JSON.parse(argsJson);
    const ctx = Object.assign({}, args[0], { host: makeHost(callId) });
    const out = await f.call(h, ctx, ...args.slice(1));
    return JSON.stringify(out === undefined ? null : out);
  };
  return { host: Object.freeze(host), dispatch };
})
"#;

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
        self.drive.abort();
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
    /// Creates the runtime, evaluates the plugin's `index.js` as an ES module
    /// and calls `default.activate(host)`.
    pub async fn activate(
        id: &str,
        files: HashMap<String, String>,
        host: Arc<dyn HostApi>,
        cfg: SandboxConfig,
    ) -> Result<Self, SandboxError> {
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
        let files = Arc::new(files);
        rt.set_loader(PluginFiles(files.clone()), PluginFiles(files.clone())).await;

        // Language built-ins only. No `std`/`os` modules, no console, no timers,
        // no fetch: QuickJS itself has none and we add none.
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
        let sb = Sandbox { id: id.to_string(), rt, ctx, ctl, cfg, drive };

        let source = files
            .get("index.js")
            .cloned()
            .ok_or_else(|| SandboxError::Engine("plugin has no index.js".into()))?;
        let plugin_id = sb.id.clone();
        let hctl = sb.ctl.clone();
        let fut = sb.ctx.async_with(async move |ctx| -> Result<(), String> {
            let js = |ctx: &Ctx<'_>, e: rquickjs::Error| Err::<(), _>(e).catch(ctx).unwrap_err().to_string();
            let host_call = Function::new(
                ctx.clone(),
                Async(move |call_id: f64, method: String, args: String| {
                    let host = host.clone();
                    let plugin_id = plugin_id.clone();
                    let token = hctl.calls.lock().unwrap().get(&(call_id as u64)).cloned();
                    async move {
                        let env = match host_call_inner(host, &plugin_id, call_id as u64, token, method, args).await {
                            Ok(v) => serde_json::json!({ "ok": v }),
                            Err(e) => serde_json::json!({ "err": e }),
                        };
                        Ok::<String, rquickjs::Error>(env.to_string())
                    }
                }),
            )
            .map_err(|e| js(&ctx, e))?;
            let boot: Function = ctx.eval(BOOTSTRAP).map_err(|e| js(&ctx, e))?;
            let obj: Object = boot.call((host_call,)).map_err(|e| js(&ctx, e))?;
            let host_obj: Object = obj.get("host").map_err(|e| js(&ctx, e))?;
            let dispatch: Function = obj.get("dispatch").map_err(|e| js(&ctx, e))?;
            let _ = ctx.store_userdata(Dispatch(dispatch));

            let module = Module::declare(ctx.clone(), "index.js", source).map_err(|e| js(&ctx, e))?;
            let (module, promise) = module.eval().map_err(|e| js(&ctx, e))?;
            promise.into_future::<()>().await.map_err(|e| js(&ctx, e))?;
            let def: Object = module.get("default").map_err(|e| js(&ctx, e))?;
            let activate: Function = def.get("activate").map_err(|e| js(&ctx, e))?;
            let ret: MaybePromise = activate.call((This(def), host_obj)).map_err(|e| js(&ctx, e))?;
            ret.into_future::<rquickjs::Value>().await.map_err(|e| js(&ctx, e))?;
            Ok(())
        });
        match tokio::time::timeout(sb.cfg.activate_timeout, watched(fut)).await {
            Err(_) => Err(SandboxError::Timeout),
            Ok(Err(msg)) => Err(classify(&sb.ctl, msg)),
            Ok(Ok(())) => Ok(sb),
        }
    }

    /// Calls a registered handler with JSON in and JSON out.
    /// `args_json` is a JSON array; its first element is the handler's `ctx`.
    pub async fn call(
        &self,
        kind: &str,
        name: &str,
        func: &str,
        args_json: String,
        cancel: Option<CancelToken>,
    ) -> Result<String, SandboxError> {
        let token = cancel.unwrap_or_default();
        let call_id = self.ctl.next_call.fetch_add(1, Ordering::SeqCst);
        self.ctl.calls.lock().unwrap().insert(call_id, token.clone());
        let (kind, name, func) = (kind.to_string(), name.to_string(), func.to_string());
        let fut = self.ctx.async_with(async move |ctx| -> Result<String, String> {
            let js = |ctx: &Ctx<'_>, e: rquickjs::Error| Err::<(), _>(e).catch(ctx).unwrap_err().to_string();
            // A watchdog interrupt inside a pending job leaves its exception set on
            // the context (rquickjs drops job errors); without this the next call
            // would report that stale "interrupted" as its own failure.
            let _ = ctx.catch();
            let dispatch = ctx.userdata::<Dispatch>().ok_or("no dispatcher")?.0.clone();
            let ret: MaybePromise = dispatch
                .call((call_id as f64, kind, name, func, args_json))
                .map_err(|e| js(&ctx, e))?;
            ret.into_future::<String>().await.map_err(|e| js(&ctx, e))
        });
        let res = tokio::select! {
            r = tokio::time::timeout(self.cfg.call_timeout, watched(fut)) => match r {
                Err(_) => { token.cancel(); Err(SandboxError::Timeout) }
                // Cancelling rejects the pending host call, so the handler often
                // settles (failing, or swallowing the rejection) before the branch
                // below is polled: a cancelled invocation is always reported as such.
                Ok(_) if token.is_cancelled() => Err(SandboxError::Cancelled),
                Ok(Err(msg)) => Err(classify(&self.ctl, msg)),
                Ok(Ok(s)) => Ok(s),
            },
            _ = token.cancelled() => Err(SandboxError::Cancelled),
            // We cannot tell which invocation was spinning; every in-flight call of this plugin fails.
            _ = self.ctl.watchdog.notified() => { token.cancel(); Err(SandboxError::Timeout) }
        };
        if res.is_err() {
            self.ctl.interrupted.store(false, Ordering::SeqCst);
        }
        // Once the invocation is over (any outcome) its id is forgotten, so late
        // host calls from an orphaned JS continuation are refused.
        self.ctl.calls.lock().unwrap().remove(&call_id);
        res
    }

    /// Test helper: evaluate a script in the plugin's global scope and return
    /// the JSON of its value.
    pub async fn eval_json(&self, code: &str) -> Result<String, SandboxError> {
        let code = code.to_string();
        let fut = self.ctx.async_with(async move |ctx| -> Result<String, String> {
            let v: rquickjs::Value = ctx.eval(code).catch(&ctx).map_err(|e| e.to_string())?;
            let s = ctx.json_stringify(v).catch(&ctx).map_err(|e| e.to_string())?;
            Ok(s.map(|s| s.to_string().unwrap_or_default()).unwrap_or_else(|| "null".into()))
        });
        watched(fut).await.map_err(|m| classify(&self.ctl, m))
    }

    pub async fn gc(&self) {
        self.rt.run_gc().await;
    }

    /// Bytes currently allocated by this runtime (QuickJS accounting).
    pub async fn heap_bytes(&self) -> i64 {
        self.rt.memory_usage().await.malloc_size
    }
}

async fn host_call_inner(
    host: Arc<dyn HostApi>,
    plugin: &str,
    call_id: u64,
    token: Option<CancelToken>,
    method: String,
    args: String,
) -> Result<Value, String> {
    let args: Value = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    match (call_id, token) {
        // Calls made through the activation-time `host` are not tied to an invocation.
        (0, _) => host.call(plugin, &method, args).await,
        (_, None) => Err("cancelled".into()),
        (_, Some(t)) => {
            if t.is_cancelled() {
                return Err("cancelled".into());
            }
            tokio::select! {
                r = host.call(plugin, &method, args) => r,
                _ = t.cancelled() => Err("cancelled".into()),
            }
        }
    }
}
