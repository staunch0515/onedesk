//! D487 §37 (docs/redesign/book.md, K20, K21): a set of files checked as a plugin and built into a signed package, and a
//! set of files run in an empty sandbox — through the host interface, by a generic test plugin (the kernel knows no
//! program book). Temporary folders and an in-memory keychain only.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use common::*;
use onedesk_kernel::{identity, packages, pluginbuild};
use serde_json::{json, Value};

const MAIN: &str = r#"
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
export default { activate(host) { host.commands.handle("probe", probe); } };
"#;

/// Two plugins: `test.prog` may run code and write files; `test.plain` asked for neither.
fn plugins(dir: &Path) -> PathBuf {
    let root = plugins_with(dir, &[]);
    for (id, requires) in [("test.prog", json!({ "files": true, "code": true })), ("test.plain", json!({}))] {
        let pkg = root.join(id).join("0.1.0");
        std::fs::create_dir_all(&pkg).unwrap();
        let m = json!({ "id": id, "version": "0.1.0", "apiVersion": "2", "name": "n", "icon": "box", "main": "main.js", "requires": requires,
            "contributes": { "commands": [{ "id": "probe", "label": "probe", "icon": "box" }] } });
        std::fs::write(pkg.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
        std::fs::write(pkg.join("main.js"), MAIN).unwrap();
    }
    root
}

fn files() -> Value {
    json!({
        "manifest.json": serde_json::to_string_pretty(&json!({ "id": "org.example.convert", "version": "0.1.0", "apiVersion": "2", "name": "plugin.name", "icon": "ruler", "main": "main.js",
            "contributes": { "locales": { "en-US": "locales/en-US.json", "zh-CN": "locales/zh-CN.json" } } })).unwrap(),
        "main.js": "import { convert } from './lib/convert.js';\nexport default { activate() {} };\nexport const cm = (m) => convert(m);\n",
        "lib/convert.js": "export const convert = (m) => m * 100;\n",
        "locales/en-US.json": "{\"plugin.name\":\"Convert\"}",
        "locales/zh-CN.json": "{\"plugin.name\":\"单位换算\"}",
    })
}

#[tokio::test]
async fn files_checked_as_a_plugin_and_built_into_a_signed_reproducible_package() {
    let tmp = tempfile::tempdir().unwrap();
    let root = plugins(tmp.path());
    let env = open_with(tempfile::tempdir().unwrap(), &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let out = env.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    c.ok("plugin.grantFolder", json!({ "plugin": "test.prog", "path": out.display().to_string() })).await;

    // The check: what installing says, plus the files' own (anyone may ask; it only computes).
    let r = c.probe("test.plain", "plugins.check", json!([files()])).await;
    assert_eq!(r["ok"], json!({ "ok": true, "id": "org.example.convert", "version": "0.1.0", "problems": [] }), "{r}");
    let mut bad = files();
    bad["manifest.json"] = json!(bad["manifest.json"].as_str().unwrap().replace("\"0.1.0\"", "\"one\""));
    bad.as_object_mut().unwrap().remove("main.js");
    let r = c.probe("test.plain", "plugins.check", json!([bad])).await;
    assert_eq!(r["ok"]["problems"][0]["code"], "badVersion", "the same reason code as installing: {r}");
    let mut missing = files();
    missing["locales/zh-CN.json"] = json!("{}");
    let r = c.probe("test.plain", "plugins.check", json!([missing])).await;
    assert_eq!(r["ok"]["problems"], json!([{ "file": "locales/zh-CN.json", "field": "plugin.name", "code": "missingKey" }]));

    // Building: not without an identity; not for a plugin that did not ask for files; not outside its folders.
    let path = out.join("org.example.convert-0.1.0.odplugin").display().to_string();
    let r = c.probe("test.prog", "plugins.build", json!([files(), { "path": path }])).await;
    assert_eq!(r["params"]["reason"], "noIdentity", "{r}");
    c.ok("identity.create", json!({ "name": "Zhang" })).await;
    let r = c.probe("test.plain", "plugins.build", json!([files(), { "path": path }])).await;
    assert_eq!(r["params"]["reason"], "notRequested", "{r}");
    let elsewhere = env.path().join("x.odplugin").display().to_string();
    let r = c.probe("test.prog", "plugins.build", json!([files(), { "path": elsewhere }])).await;
    assert!(r["error"].is_string(), "outside the granted folders: {r}");
    let r = c.probe("test.prog", "plugins.build", json!([missing, { "path": path }])).await;
    assert_eq!(r["params"]["reason"], "badPlugin", "{r}");

    let r = c.probe("test.prog", "plugins.build", json!([files(), { "path": path }])).await;
    assert_eq!(r["ok"]["id"], "org.example.convert", "{r}");
    let first = std::fs::read(&path).unwrap();
    assert_eq!(r["ok"]["bytes"], first.len());
    // The same files give the same bytes.
    let again = out.join("again.odplugin").display().to_string();
    c.probe("test.prog", "plugins.build", json!([files(), { "path": again }])).await;
    assert_eq!(std::fs::read(&again).unwrap(), first);

    // Inside: the files in order and the signature, which checks against the publisher's key.
    let entries = packages::zip_read(&first).unwrap();
    let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["lib/convert.js", "locales/en-US.json", "locales/zh-CN.json", "main.js", "manifest.json", "signature.json"]);
    let sig: Value = serde_json::from_slice(&entries[5].1).unwrap();
    assert_eq!(sig["publisher"], "Zhang");
    let mut map = BTreeMap::new();
    for (n, b) in &entries[..5] {
        map.insert(n.clone(), String::from_utf8(b.clone()).unwrap());
    }
    let msg = pluginbuild::plugin_message("org.example.convert", "0.1.0", &map);
    assert!(identity::verify(sig["publicKey"].as_str().unwrap(), msg.as_bytes(), sig["signature"].as_str().unwrap()));
    map.insert("main.js".into(), "changed".into());
    let msg = pluginbuild::plugin_message("org.example.convert", "0.1.0", &map);
    assert!(!identity::verify(sig["publicKey"].as_str().unwrap(), msg.as_bytes(), sig["signature"].as_str().unwrap()));

    // The package installs like any (the main process unpacks it; here: the same check on its files).
    let (idv, problems) = pluginbuild::check_files(&entries.iter().map(|(n, b)| (n.clone(), String::from_utf8(b.clone()).unwrap())).collect());
    assert_eq!((idv.unwrap().0, problems), ("org.example.convert".to_string(), vec![]));
}

#[tokio::test]
async fn files_run_in_an_empty_sandbox_only_for_a_plugin_that_asked() {
    let tmp = tempfile::tempdir().unwrap();
    let root = plugins(tmp.path());
    let env = open_with(tempfile::tempdir().unwrap(), &root, config_for(&root));
    let c = Client::in_proc(env.kernel.clone());
    c.hello().await;
    let mut f = files();
    f.as_object_mut().unwrap().retain(|k, _| k.ends_with(".js"));
    f["entry.js"] = json!("import { cm } from './main.js';\nexport function run(x) { return { cm: cm(x.m), host: typeof host, console: typeof console }; }\nexport function bad() {\n  null.x;\n}\n");
    let r = c.probe("test.prog", "code.run", json!([{ "files": f, "entry": "entry.js", "call": "run", "input": { "m": 3 } }])).await;
    assert_eq!(r["ok"], json!({ "ok": true, "value": { "cm": 300, "host": "undefined", "console": "undefined" } }), "{r}");
    let r = c.probe("test.prog", "code.run", json!([{ "files": f, "entry": "entry.js", "call": "bad" }])).await;
    assert_eq!((r["ok"]["ok"].clone(), r["ok"]["error"]["file"].clone(), r["ok"]["error"]["line"].clone()), (json!(false), json!("entry.js"), json!(4)), "{r}");
    let r = c.probe("test.plain", "code.run", json!([{ "files": f, "entry": "entry.js", "call": "run" }])).await;
    assert_eq!(r["params"]["reason"], "notRequested", "{r}");
    let r = c.probe("test.prog", "code.run", json!([{ "files": { "../x.js": "" }, "entry": "../x.js", "call": "run" }])).await;
    assert_eq!(r["error"], "invalidParams", "{r}");
    // The permission is listed for the user.
    let d = c.ok("plugin.get", json!({ "plugin": "test.prog" })).await;
    assert!(d["permissions"].as_array().unwrap().iter().any(|p| p["id"] == "code"), "{d}");
}
