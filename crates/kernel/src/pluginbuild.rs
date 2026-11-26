//! D487 §37 (docs/redesign/book.md, K20): a set of files checked as a plugin and built into a package. The check is the
//! one installing does (the kernel's strict manifest check), plus what only a set of files can say: is the main file
//! there, are the language files JSON objects of texts with the same keys. The package is the `.odplugin` an author's
//! `pnpm plugin:pack` makes (a zip, entries in order, no times: the same files give the same bytes), signed with the
//! workspace's identity (K18; `signature.json`), so a plugin market can tell who published it. The kernel knows no
//! program book: whoever has the files asks.
//! - `host.plugins.check(files)` → `{ ok, id?, version?, problems: [{ file, field, code }] }`.
//! - `host.plugins.build(files, { path })` → `{ path, id, version, bytes }` (`requires.files`; an identity).

use std::collections::BTreeMap;

use onedesk_protocol::*;
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::Plugin;
use crate::sandbox::CallInfo;
use crate::util::*;

pub const MAX_FILES: usize = 200;
pub const MAX_BYTES: usize = 4 * 1024 * 1024;

fn good_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 200
        && !p.starts_with('/')
        && p.split('/').all(|s| !s.is_empty() && s != "." && s != ".." && !s.starts_with("._") && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
}

fn problem(file: &str, field: &str, code: &str) -> Value {
    json!({ "file": file, "field": field, "code": code })
}

/// What `signature.json` signs: the id, the version, and each file's SHA-256, in order.
pub fn plugin_message(id: &str, version: &str, files: &BTreeMap<String, String>) -> String {
    let mut s = format!("onedesk-plugin/1\n{id}\n{version}");
    for (p, t) in files {
        s.push_str(&format!("\n{p} {}", crate::identity::sha256_hex(t.as_bytes())));
    }
    s
}

/// The checks: paths, sizes, the manifest as installing reads it, the main file, the language files.
pub fn check_files(files: &BTreeMap<String, String>) -> (Option<(String, String)>, Vec<Value>) {
    let mut problems = Vec::new();
    if files.len() > MAX_FILES || files.values().map(String::len).sum::<usize>() > MAX_BYTES {
        problems.push(problem("", "", "tooLarge"));
        return (None, problems);
    }
    for p in files.keys().filter(|p| !good_path(p)) {
        problems.push(problem(p, "", "badPath"));
    }
    let Some(manifest) = files.get("manifest.json") else {
        problems.push(problem("manifest.json", "", "noManifest"));
        return (None, problems);
    };
    let raw: Value = match serde_json::from_str(manifest) {
        Ok(v) => v,
        Err(e) => {
            problems.push(problem("manifest.json", &format!("line {}", e.line()), "badJson"));
            return (None, problems);
        }
    };
    // The manifest as installing reads it, from a folder of the files.
    let dir = std::env::temp_dir().join(format!("onedesk-build-{}", new_id()));
    let write = || -> std::io::Result<()> {
        for (p, t) in files.iter().filter(|(p, _)| good_path(p)) {
            let f = dir.join(p);
            if let Some(parent) = f.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(f, t)?;
        }
        Ok(())
    };
    let parsed = match write() {
        Ok(()) => crate::manifest::load_package_opts(&dir, false),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            problems.push(problem("", &e.to_string(), "internal"));
            return (None, problems);
        }
    };
    let _ = std::fs::remove_dir_all(&dir);
    let plugin = match parsed {
        Ok(p) => p,
        Err(r) => {
            problems.push(problem("manifest.json", &r.detail, &r.reason));
            return (None, problems);
        }
    };
    let main = raw.get("main").and_then(Value::as_str).unwrap_or("main.js");
    if !files.contains_key(main) {
        problems.push(problem(main, "main", "mainMissing"));
    }
    // Language files: JSON objects of texts, all with the same keys.
    let mut keys: Vec<(String, std::collections::BTreeSet<String>)> = Vec::new();
    for (lang, path) in raw.pointer("/contributes/locales").and_then(Value::as_object).into_iter().flatten() {
        let Some(path) = path.as_str() else { continue };
        match files.get(path).map(|t| serde_json::from_str::<BTreeMap<String, Value>>(t)) {
            None => problems.push(problem(path, lang, "localeMissing")),
            Some(Err(_)) => problems.push(problem(path, lang, "badLocale")),
            Some(Ok(m)) => {
                if let Some((k, _)) = m.iter().find(|(_, v)| !v.is_string()) {
                    problems.push(problem(path, k, "badLocale"));
                }
                keys.push((path.to_string(), m.into_keys().collect()));
            }
        }
    }
    let all: std::collections::BTreeSet<String> = keys.iter().flat_map(|(_, k)| k.iter().cloned()).collect();
    for (path, k) in &keys {
        for missing in all.difference(k).take(50) {
            problems.push(problem(path, missing, "missingKey"));
        }
    }
    (Some((plugin.id.clone(), plugin.version.clone())), problems)
}

impl Inner {
    /// `host.plugins.check` / `host.plugins.build`.
    pub(crate) async fn host_plugin_files(&self, plugin: &'static Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        let files: BTreeMap<String, String> = serde_json::from_value(args.get(0).cloned().unwrap_or(json!({}))).map_err(|_| invalid_params("files"))?;
        let (idv, problems) = check_files(&files);
        if op == "check" {
            return Ok(json!({ "ok": problems.is_empty(), "id": idv.as_ref().map(|x| &x.0), "version": idv.as_ref().map(|x| &x.1), "problems": problems }));
        }
        // build
        if info.event || info.pure {
            return Err(denied("notInRun"));
        }
        if !plugin.manifest.requires.files {
            return Err(denied("notRequested"));
        }
        let (Some((id, version)), true) = (idv, problems.is_empty()) else {
            return Err(err_p(ErrorCode::Invalid, &[("reason", "badPlugin")]));
        };
        let who = self.identity()?.ok_or_else(|| invalid("noIdentity"))?;
        let (_, sig) = self.sign(plugin_message(&id, &version, &files).as_bytes())?.ok_or_else(|| invalid("noIdentity"))?;
        let signature = json!({ "format": 1, "publisher": who.name, "publicKey": who.public_key, "fingerprint": who.fingerprint, "signature": sig });
        let mut entries: Vec<(String, Vec<u8>)> = files.iter().map(|(p, t)| (p.clone(), t.clone().into_bytes())).collect();
        entries.push(("signature.json".into(), serde_json::to_vec_pretty(&signature).map_err(internal)?));
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let data = crate::packages::zip_write(&entries);
        let raw = args.get(1).and_then(|o| o.get("path")).and_then(Value::as_str).ok_or_else(|| invalid_params("path"))?.to_string();
        let (grants, rawp) = self.files_scope_pub(plugin, &raw)?;
        let bytes = data.len();
        let path = tokio::task::spawn_blocking(move || -> KResult<String> {
            use std::io::Write;
            let mut part = crate::files::part_file(&grants, &rawp, false)?;
            let shown = crate::files::resolve(&grants, &rawp)?.display().to_string();
            let mut f = part.take_file();
            f.write_all(&data).map_err(internal)?;
            f.sync_all().map_err(internal)?;
            drop(f);
            part.commit(false)?;
            Ok(shown)
        })
        .await
        .map_err(internal)??;
        self.execute(plugin.actor(), crate::pipeline::Command::Audit { op: "plugin.build".into(), object: path.clone(), summary: json!({ "id": id, "version": version, "bytes": bytes }) }).await?;
        Ok(json!({ "path": path, "id": id, "version": version, "bytes": bytes }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(list: &[(&str, &str)]) -> BTreeMap<String, String> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }
    const MANIFEST: &str = r#"{ "id": "org.example.convert", "version": "0.1.0", "apiVersion": "2", "name": "plugin.name", "icon": "ruler", "main": "main.js",
        "contributes": { "locales": { "en-US": "locales/en-US.json", "zh-CN": "locales/zh-CN.json" } } }"#;

    #[test]
    fn a_good_set_and_what_is_wrong_with_others() {
        let good = files(&[("manifest.json", MANIFEST), ("main.js", "export default { activate() {} };"), ("locales/en-US.json", r#"{"plugin.name":"Convert"}"#), ("locales/zh-CN.json", r#"{"plugin.name":"换算"}"#)]);
        let (idv, p) = check_files(&good);
        assert_eq!((idv, p), (Some(("org.example.convert".into(), "0.1.0".into())), vec![]));
        let mut no_main = good.clone();
        no_main.remove("main.js");
        assert_eq!(check_files(&no_main).1[0]["code"], "mainMissing");
        let mut missing = good.clone();
        missing.insert("locales/zh-CN.json".into(), "{}".into());
        assert_eq!(check_files(&missing).1, vec![problem("locales/zh-CN.json", "plugin.name", "missingKey")]);
        let mut bad = good.clone();
        bad.insert("manifest.json".into(), MANIFEST.replace("\"2\"", "\"9\""));
        assert_eq!(check_files(&bad).1[0]["code"], "apiVersion");
        let mut broken = good.clone();
        broken.insert("manifest.json".into(), "{".into());
        assert_eq!(check_files(&broken).1[0]["code"], "badJson");
        let mut path = good.clone();
        path.insert("../x.js".into(), "".into());
        assert_eq!(check_files(&path).1[0]["code"], "badPath");
        assert_eq!(check_files(&files(&[("main.js", "")])).1[0]["code"], "noManifest");
    }
}
