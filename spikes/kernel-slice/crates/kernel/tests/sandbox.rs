//! Questions 1–3: ES module plugins in isolated runtimes, limits, isolation.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ks_kernel::sandbox::*;
use serde_json::{json, Value};

#[derive(Default)]
struct TestHost {
    store: Mutex<HashMap<String, Value>>,
}

impl HostApi for TestHost {
    fn call(&self, plugin: &str, method: &str, args: Value) -> HostFuture {
        let key = |a: &Value| format!("{plugin}/{}", a["key"].as_str().unwrap_or(""));
        match method {
            "storage.get" => {
                let v = self.store.lock().unwrap().get(&key(&args)).cloned().unwrap_or(Value::Null);
                Box::pin(async move { Ok(v) })
            }
            "storage.set" => {
                self.store.lock().unwrap().insert(key(&args), args["value"].clone());
                Box::pin(async { Ok(Value::Null) })
            }
            "test.sleep" => {
                let ms = args["ms"].as_u64().unwrap_or(0);
                Box::pin(async move {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    Ok(Value::Null)
                })
            }
            "test.echo" => Box::pin(async move { Ok(args) }),
            other => {
                let m = format!("host method not allowed: {other}");
                Box::pin(async move { Err(m) })
            }
        }
    }
}

fn files(index: &str) -> HashMap<String, String> {
    HashMap::from([("index.js".to_string(), index.to_string())])
}

fn cfg() -> SandboxConfig {
    SandboxConfig {
        memory_limit: 16 * 1024 * 1024,
        activate_timeout: Duration::from_millis(500),
        call_timeout: Duration::from_millis(1500),
        sync_slice: Duration::from_millis(200),
        ..Default::default()
    }
}

const PLUGIN: &str = r#"
import { double } from "./util.js";
let activated = 0;
export default {
  async activate(host) {
    activated += 1;
    await host.storage.set("boot", { n: activated });
    host.actions.handle("double", async (ctx, input) => {
      const echoed = await ctx.host.test.echo({ v: double(input.v) });
      const boot = await ctx.host.storage.get("boot");
      return { out: echoed.v, boot, env: ctx.env };
    });
    host.actions.handle("spin", () => { while (true) {} });
    host.actions.handle("spinAfterAwait", async (ctx) => { await ctx.host.test.sleep(10); while (true) {} });
    host.actions.handle("hog", () => { const a = []; while (true) a.push(new Array(10000).fill(7)); });
    host.actions.handle("recurse", () => { const f = (n) => f(n + 1) + 1; return f(0); });
    host.actions.handle("slow", async (ctx) => {
      try { await ctx.host.test.sleep(5000); } catch (e) { globalThis.sawCancel = String(e.message); }
      try { await ctx.host.storage.set("after", 1); } catch (e) { globalThis.sawLate = String(e.message); }
      return "done";
    });
    host.actions.handle("never", () => new Promise(() => {}));
    host.actions.handle("forbidden", async (ctx) => ctx.host.params.get("x"));
    host.actions.handle("throws", () => { throw new TypeError("boom"); });
    host.pages.handle("editor", { render(ctx) { return { type: "text", text: "id=" + ctx.id }; } });
  },
};
"#;

async fn plugin(host: Arc<TestHost>) -> Sandbox {
    let mut f = files(PLUGIN);
    f.insert("util.js".into(), "export const double = (x) => x * 2;".into());
    Sandbox::activate("demo", f, host, cfg()).await.expect("activate")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn q1_module_activate_async_host_call_and_handler() {
    let host = Arc::new(TestHost::default());
    let sb = plugin(host.clone()).await;
    // activate(host) awaited an async host call
    assert_eq!(host.store.lock().unwrap().get("demo/boot"), Some(&json!({"n": 1})));
    // handler: JSON in → awaits two host Promises → JSON out
    let out = sb.call("actions", "double", "", json!([{"env": "prod"}, {"v": 21}]).to_string(), None).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), json!({"out": 42, "boot": {"n": 1}, "env": "prod"}));
    let out = sb.call("pages", "editor", "render", json!([{"id": 7}]).to_string(), None).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), json!({"type": "text", "text": "id=7"}));
    // JS exceptions and refused host methods come back as errors
    let e = sb.call("actions", "throws", "", "[{}]".into(), None).await.unwrap_err();
    assert!(matches!(&e, SandboxError::Js(m) if m.contains("boom")), "{e:?}");
    let e = sb.call("actions", "forbidden", "", "[{}]".into(), None).await.unwrap_err();
    assert!(matches!(&e, SandboxError::Js(m) if m.contains("not allowed")), "{e:?}");
    let e = sb.call("actions", "missing", "", "[{}]".into(), None).await.unwrap_err();
    assert!(matches!(&e, SandboxError::Js(m) if m.contains("no handler")), "{e:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn q1_no_ambient_capabilities() {
    let sb = plugin(Arc::new(TestHost::default())).await;
    let globals = sb.eval_json("Object.getOwnPropertyNames(globalThis).sort()").await.unwrap();
    let names: Vec<String> = serde_json::from_str(&globals).unwrap();
    println!("globals ({}): {}", names.len(), names.join(" "));
    for banned in [
        "require", "process", "fetch", "XMLHttpRequest", "WebSocket", "std", "os", "console", "setTimeout",
        "setInterval", "Deno", "Bun", "module", "print", "load", "read", "scriptArgs", "navigator", "performance",
        "WeakRef", "FinalizationRegistry",
    ] {
        assert!(!names.iter().any(|n| n == banned), "global `{banned}` must not exist");
    }
    // the host bridge function is not reachable from globals
    assert!(!names.iter().any(|n| n.to_lowercase().contains("host")));
    // importing anything but the plugin's own files fails
    for spec in ["fs", "node:fs", "std", "os", "qjs:std", "qjs:os", "../other/index.js", "/etc/passwd", "https://example.com/x.js"] {
        let src = format!("import * as m from {spec:?}; export default {{ activate() {{}} }};");
        let r = Sandbox::activate("x", files(&src), Arc::new(TestHost::default()), cfg()).await;
        assert!(r.is_err(), "import of {spec} must fail");
    }
    let dynamic = r#"export default { async activate(host) { await import("fs"); } };"#;
    assert!(Sandbox::activate("x", files(dynamic), Arc::new(TestHost::default()), cfg()).await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn q2_memory_cap_fails_cleanly_and_runtime_recovers() {
    let sb = plugin(Arc::new(TestHost::default())).await;
    let before = sb.heap_bytes().await;
    let e = sb.call("actions", "hog", "", "[{}]".into(), None).await.unwrap_err();
    assert_eq!(e, SandboxError::OutOfMemory);
    sb.gc().await;
    let after = sb.heap_bytes().await;
    println!("heap before={before} after failure+gc={after} limit={}", cfg().memory_limit);
    assert!(after < before * 2, "memory is given back after the failed call");
    // kernel alive, same runtime still usable
    let out = sb.call("actions", "double", "", json!([{}, {"v": 1}]).to_string(), None).await.unwrap();
    assert!(out.contains("\"out\":2"));
    // runaway recursion is also contained
    let e = sb.call("actions", "recurse", "", "[{}]".into(), None).await.unwrap_err();
    assert!(matches!(&e, SandboxError::Js(m) if m.to_lowercase().contains("stack")), "{e:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn q2_dead_loop_is_interrupted() {
    let sb = plugin(Arc::new(TestHost::default())).await;
    let t = Instant::now();
    let e = sb.call("actions", "spin", "", "[{}]".into(), None).await.unwrap_err();
    println!("sync dead loop interrupted after {:?}", t.elapsed());
    assert_eq!(e, SandboxError::Timeout);
    assert!(t.elapsed() < Duration::from_millis(1000));
    // dead loop that starts after an await (continuation driven by a later poll)
    let t = Instant::now();
    let e = sb.call("actions", "spinAfterAwait", "", "[{}]".into(), None).await.unwrap_err();
    println!("dead loop after await interrupted after {:?}", t.elapsed());
    assert_eq!(e, SandboxError::Timeout);
    assert!(t.elapsed() < Duration::from_millis(1000));
    // the runtime survives an interrupt
    let out = sb.call("actions", "double", "", json!([{}, {"v": 2}]).to_string(), None).await.unwrap();
    assert!(out.contains("\"out\":4"));
    // a handler whose promise never settles hits the per-call timeout
    let t = Instant::now();
    let e = sb.call("actions", "never", "", "[{}]".into(), None).await.unwrap_err();
    assert_eq!(e, SandboxError::Timeout);
    assert!(t.elapsed() >= Duration::from_millis(1400));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn q2_activate_timeout() {
    let host = Arc::new(TestHost::default());
    let t = Instant::now();
    let hang = "export default { activate() { return new Promise(() => {}); } };";
    let e = Sandbox::activate("hang", files(hang), host.clone(), cfg()).await.err().unwrap();
    println!("pending activate timed out after {:?}", t.elapsed());
    assert_eq!(e, SandboxError::Timeout);
    let t = Instant::now();
    let spin = "export default { activate() { while (true) {} } };";
    let e = Sandbox::activate("spin", files(spin), host.clone(), cfg()).await.err().unwrap();
    println!("spinning activate interrupted after {:?}", t.elapsed());
    assert_eq!(e, SandboxError::Timeout);
    let t = Instant::now();
    let top = "while (true) {}\nexport default { activate() {} };";
    let e = Sandbox::activate("top", files(top), host, cfg()).await.err().unwrap();
    println!("spinning module top level interrupted after {:?}", t.elapsed());
    assert_eq!(e, SandboxError::Timeout);
}

/// The real 10 s figure from the design. `cargo test -- --ignored q2_activate_timeout_10s`
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn q2_activate_timeout_10s() {
    let t = Instant::now();
    let hang = "export default { async activate(host) { await host.test.sleep(60000); } };";
    let e = Sandbox::activate("hang", files(hang), Arc::new(TestHost::default()), SandboxConfig::default()).await.err().unwrap();
    println!("default activate timeout fired after {:?}", t.elapsed());
    assert_eq!(e, SandboxError::Timeout);
    assert!(t.elapsed() >= Duration::from_secs(10) && t.elapsed() < Duration::from_secs(11));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn q2_cancel_in_flight_handler() {
    let host = Arc::new(TestHost::default());
    let sb = Arc::new(plugin(host.clone()).await);
    let token = CancelToken::new();
    let (sb2, token2) = (sb.clone(), token.clone());
    let t = Instant::now();
    let task = tokio::spawn(async move { sb2.call("actions", "slow", "", "[{}]".into(), Some(token2)).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    token.cancel();
    let e = task.await.unwrap().unwrap_err();
    println!("cancel returned after {:?}", t.elapsed());
    assert_eq!(e, SandboxError::Cancelled);
    assert!(t.elapsed() < Duration::from_millis(500));
    // The orphaned JS continuation: its pending host call rejected, and its
    // next host call was refused, so it could not write after being cancelled.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let seen = sb.eval_json("[globalThis.sawCancel, globalThis.sawLate]").await.unwrap();
    println!("plugin observed: {seen}");
    assert_eq!(seen, r#"["cancelled","cancelled"]"#);
    assert!(host.store.lock().unwrap().get("demo/after").is_none());
    // cancelling a synchronous dead loop is the watchdog's job, see q2_dead_loop_is_interrupted
    let out = sb.call("actions", "double", "", json!([{}, {"v": 3}]).to_string(), None).await.unwrap();
    assert!(out.contains("\"out\":6"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn q3_two_runtimes_do_not_share_globals() {
    let host = Arc::new(TestHost::default());
    let a = Sandbox::activate("a", files("globalThis.secret = 'A'; Array.prototype.tag = 'A'; export default { activate() {} };"), host.clone(), cfg()).await.unwrap();
    let b = Sandbox::activate("b", files("export default { activate() {} };"), host.clone(), cfg()).await.unwrap();
    assert_eq!(a.eval_json("[typeof secret, [].tag]").await.unwrap(), r#"["string","A"]"#);
    assert_eq!(b.eval_json("[typeof secret, [].tag === undefined]").await.unwrap(), r#"["undefined",true]"#);
    // storage is namespaced by the plugin id the kernel passes, not by anything the plugin says
    let w = "export default { async activate(host) { await host.storage.set('k', 1); } };";
    Sandbox::activate("p1", files(w), host.clone(), cfg()).await.unwrap();
    assert!(host.store.lock().unwrap().contains_key("p1/k"));
    assert!(!host.store.lock().unwrap().contains_key("a/k"));
}
