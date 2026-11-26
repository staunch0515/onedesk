//! D487 §37 (docs/redesign/book.md, K21): running a set of files in an empty sandbox. A fresh, throwaway QuickJS
//! runtime holds only the given files (they import each other as `./<path>`, as a plugin's files do), has the language
//! built-ins and nothing else — no host interface at all —, at most 32 MB and 10 seconds; the named export of the entry
//! file is called with the input and its result (JSON) comes back, or the error with the file and line it came from.
//! Pure computation: what a program book's tests need, and safe in an AI's run too. The kernel knows no test framework:
//! the harness is one of the files it is given.
//! - `host.code.run({ files, entry, call, input })` (`requires.code`).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use onedesk_protocol::*;
use rquickjs::context::intrinsic;
use rquickjs::promise::MaybePromise;
use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt, CaughtError, Function, Module};
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::Plugin;
use crate::sandbox::CallInfo;
use crate::util::*;

pub const MAX_FILES: usize = 200;
pub const MAX_BYTES: usize = 4 * 1024 * 1024;
pub const MEMORY: usize = 32 * 1024 * 1024;
pub const TIME: Duration = Duration::from_secs(10);
const STACK: usize = 512 * 1024;

/// A file path as a package has it: relative, `/`-separated, no `..`, ending in `.js`.
fn good_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 200
        && p.ends_with(".js")
        && !p.starts_with('/')
        && p.split('/').all(|s| !s.is_empty() && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
}

/// What went wrong, and where (the first frame in one of the files).
fn caught(e: CaughtError<'_>, files: &HashMap<String, String>) -> Value {
    let (message, stack) = match &e {
        CaughtError::Exception(x) => (x.message().unwrap_or_default(), x.stack().unwrap_or_default()),
        other => (other.to_string(), String::new()),
    };
    let mut at = json!({ "message": message });
    for line in stack.lines() {
        // `    at name (file.js:12:3)` or `    at file.js:12:3`
        let inner = line.trim().trim_start_matches("at ").rsplit('(').next().unwrap_or("").trim_end_matches(')');
        let mut parts = inner.split(':');
        if let (Some(f), Some(l)) = (parts.next(), parts.next()) {
            if files.contains_key(f) {
                at["file"] = json!(f);
                at["line"] = json!(l.parse::<u32>().ok());
                break;
            }
        }
    }
    at
}

/// Runs `call` of `entry` with `input`: `{ ok: true, value }` or `{ ok: false, error: { message, file?, line? } }`.
pub async fn run_files(files: HashMap<String, String>, entry: String, call: String, input: Value) -> Value {
    let fail = |m: &str| json!({ "ok": false, "error": { "message": m } });
    let Ok(rt) = AsyncRuntime::new() else { return fail("engine") };
    rt.set_memory_limit(MEMORY).await;
    rt.set_max_stack_size(STACK).await;
    let deadline = Instant::now() + TIME;
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline))).await;
    let files = Arc::new(files);
    rt.set_loader(crate::sandbox::PackageFiles(files.clone()), crate::sandbox::PackageFiles(files.clone())).await;
    // The language's built-ins only: no std/os modules, console, timers or fetch.
    let ctx = match AsyncContext::custom::<(
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
    {
        Ok(c) => c,
        Err(_) => return fail("engine"),
    };
    let drive = tokio::spawn(rt.drive());
    let Some(src) = files.get(&entry).cloned() else { return fail("noEntry") };
    let fs = files.clone();
    let input = input.to_string();
    let work = ctx.async_with(async move |ctx| -> Value {
        let run = async {
            let m = Module::declare(ctx.clone(), entry.as_str(), src).catch(&ctx)?;
            let (m, p) = m.eval().catch(&ctx)?;
            p.into_future::<()>().await.catch(&ctx)?;
            let f: Function = m.get(call.as_str()).catch(&ctx)?;
            let arg = ctx.json_parse(input).catch(&ctx)?;
            let r: MaybePromise = f.call((arg,)).catch(&ctx)?;
            let v: rquickjs::Value = r.into_future().await.catch(&ctx)?;
            let s = ctx.json_stringify(v).catch(&ctx)?;
            Ok::<String, CaughtError<'_>>(s.and_then(|s| s.to_string().ok()).unwrap_or_else(|| "null".into()))
        };
        match run.await {
            Ok(s) => json!({ "ok": true, "value": serde_json::from_str::<Value>(&s).unwrap_or(Value::Null) }),
            Err(e) => json!({ "ok": false, "error": caught(e, &fs) }),
        }
    });
    let out = match tokio::time::timeout(TIME + Duration::from_secs(1), work).await {
        Ok(v) => v,
        Err(_) => fail("timeout"),
    };
    drive.abort();
    out
}

impl Inner {
    /// `host.code.run`: checked, then run off the plugin's own runtime.
    pub(crate) async fn host_code(&self, plugin: &'static Plugin, _info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        if !plugin.manifest.requires.code {
            return Err(denied("notRequested"));
        }
        if op != "run" {
            return Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("code.{op}"))]));
        }
        let o = args.get(0).cloned().unwrap_or(Value::Null);
        let files: HashMap<String, String> = serde_json::from_value(o.get("files").cloned().unwrap_or(json!({}))).map_err(|_| invalid_params("files"))?;
        if files.len() > MAX_FILES || files.values().map(String::len).sum::<usize>() > MAX_BYTES {
            return Err(err_p(ErrorCode::Invalid, &[("reason", "tooLarge")]));
        }
        if let Some(bad) = files.keys().find(|p| !good_path(p)) {
            return Err(invalid_params(format!("bad path {bad}")));
        }
        let entry = o.get("entry").and_then(Value::as_str).filter(|e| files.contains_key(*e)).ok_or_else(|| invalid_params("entry"))?.to_string();
        let call = o.get("call").and_then(Value::as_str).filter(|c| !c.is_empty() && c.len() <= 64).ok_or_else(|| invalid_params("call"))?.to_string();
        let input = o.get("input").cloned().unwrap_or(Value::Null);
        // Its own thread: a runaway script stops no one else's.
        let out = tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
            rt.block_on(run_files(files, entry, call, input))
        })
        .await
        .map_err(internal)?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(list: &[(&str, &str)]) -> HashMap<String, String> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[tokio::test]
    async fn files_import_each_other_and_the_export_answers() {
        let f = files(&[("lib/convert.js", "export const convert = (n, f, t) => (f === 'm' && t === 'cm' ? n * 100 : n);"), ("entry.js", "import { convert } from './lib/convert.js';\nexport async function run(x) { return { cm: convert(x.n, 'm', 'cm') }; }")]);
        let v = run_files(f, "entry.js".into(), "run".into(), json!({ "n": 2 })).await;
        assert_eq!(v, json!({ "ok": true, "value": { "cm": 200 } }));
    }

    #[tokio::test]
    async fn an_error_says_what_and_where() {
        let f = files(&[("entry.js", "export function run() {\n  const x = 1;\n  throw new Error('boom');\n}")]);
        let v = run_files(f, "entry.js".into(), "run".into(), Value::Null).await;
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["message"], "boom");
        assert_eq!(v["error"]["file"], "entry.js");
        assert_eq!(v["error"]["line"], 3);
    }

    #[tokio::test]
    async fn nothing_of_the_host_and_limits_hold() {
        let f = files(&[("entry.js", "export function run() { return [typeof console, typeof setTimeout, typeof fetch, typeof globalThis.host]; }")]);
        let v = run_files(f, "entry.js".into(), "run".into(), Value::Null).await;
        assert_eq!(v["value"], json!(["undefined", "undefined", "undefined", "undefined"]));
        let f = files(&[("entry.js", "export function run() { for (;;) {} }")]);
        let t = Instant::now();
        let v = run_files(f, "entry.js".into(), "run".into(), Value::Null).await;
        assert_eq!(v["ok"], false);
        assert!(t.elapsed() < Duration::from_secs(15));
        let f = files(&[("entry.js", "export function run() { const a = []; for (;;) a.push('x'.repeat(1000)); }")]);
        assert_eq!(run_files(f, "entry.js".into(), "run".into(), Value::Null).await["ok"], false);
        // Only the given files.
        let f = files(&[("entry.js", "import x from './nope.js'; export function run() { return 1; }")]);
        assert_eq!(run_files(f, "entry.js".into(), "run".into(), Value::Null).await["ok"], false);
        assert!(good_path("lib/a.js") && !good_path("../a.js") && !good_path("/a.js") && !good_path("a.ts"));
    }
}
