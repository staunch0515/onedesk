//! External plugin scan: `<dataDir>/plugins/<dir>/manifest.json` + entry module (D01, D52, D55).
//! Only `main` is read from the manifest; all other validation happens in TypeScript.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// Mirrors `ScannedPlugin` in src/kernel/contracts.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedPlugin {
    pub dir: String,
    pub manifest_text: Option<String>,
    pub entry_source: Option<String>,
    pub error: Option<String>,
}

const DEFAULT_MAIN: &str = "index.js";

/// Scans every non-hidden sub-folder of `plugins_dir`, sorted by folder name. A missing `plugins_dir` yields [].
pub fn scan(plugins_dir: &Path) -> Result<Vec<ScannedPlugin>, String> {
    let entries = match fs::read_dir(plugins_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("无法读取插件文件夹：{e}")),
    };
    let mut dirs: Vec<_> = entries
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    Ok(dirs.iter().map(|d| scan_one(d)).collect())
}

fn scan_one(dir: &Path) -> ScannedPlugin {
    let mut out = ScannedPlugin {
        dir: dir.to_string_lossy().into_owned(),
        manifest_text: None,
        entry_source: None,
        error: None,
    };
    let manifest_path = match canonical_inside(dir, &dir.join("manifest.json")) {
        Ok(Some(p)) => p,
        Ok(None) => {
            out.error = Some("manifest.json 指向插件文件夹之外，已拒绝加载。".into());
            return out;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            out.error = Some("缺少 manifest.json。".into());
            return out;
        }
        Err(e) => {
            out.error = Some(format!("无法读取 manifest.json：{e}"));
            return out;
        }
    };
    let text = match fs::read_to_string(&manifest_path) {
        Ok(t) => t,
        Err(e) => {
            out.error = Some(format!("无法读取 manifest.json：{e}"));
            return out;
        }
    };
    out.manifest_text = Some(text.clone());
    let manifest: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            out.error = Some(format!("manifest.json 不是有效的 JSON：{e}"));
            return out;
        }
    };
    let main = match manifest.get("main") {
        None | Some(Value::Null) => DEFAULT_MAIN,
        Some(Value::String(s)) => s.as_str(),
        Some(_) => {
            out.error = Some("manifest.json 的 main 必须是字符串。".into());
            return out;
        }
    };
    match read_entry(dir, main) {
        Ok(src) => out.entry_source = Some(src),
        Err(e) => out.error = Some(e),
    }
    out
}

/// Resolves `path` (following symlinks) and returns it only if it lies strictly inside `dir`.
/// `Ok(None)` means it resolves outside the plugin folder.
fn canonical_inside(dir: &Path, path: &Path) -> std::io::Result<Option<PathBuf>> {
    let canon_dir = fs::canonicalize(dir)?;
    let canon = fs::canonicalize(path)?;
    Ok((canon.starts_with(&canon_dir) && canon != canon_dir).then_some(canon))
}

/// Reads the entry file, refusing anything that could leave the plugin folder (errs on the side of rejecting).
fn read_entry(dir: &Path, main: &str) -> Result<String, String> {
    let escape = || format!("入口文件 {main} 越出了插件文件夹，已拒绝加载。");
    let rel = Path::new(main);
    if main.trim().is_empty() {
        return Err("manifest.json 的 main 不能为空。".into());
    }
    if main.contains("..")
        || main.contains('\\')
        || main.contains('\0')
        || rel.is_absolute()
        || rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(escape());
    }
    // Symlinks pointing outside the folder are rejected too.
    let canon = match canonical_inside(dir, &dir.join(rel)) {
        Ok(Some(p)) => p,
        Ok(None) => return Err(escape()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("缺少入口文件 {main}。"))
        }
        Err(e) => return Err(format!("无法读取入口文件 {main}：{e}")),
    };
    if !canon.is_file() {
        return Err(format!("入口 {main} 不是文件。"));
    }
    fs::read_to_string(&canon).map_err(|e| format!("无法读取入口文件 {main}：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(root: &Path, name: &str, manifest: Option<&str>, files: &[(&str, &str)]) {
        let d = root.join(name);
        fs::create_dir_all(&d).unwrap();
        if let Some(m) = manifest {
            fs::write(d.join("manifest.json"), m).unwrap();
        }
        for (f, c) in files {
            let p = d.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, c).unwrap();
        }
    }

    fn by_name<'a>(list: &'a [ScannedPlugin], name: &str) -> &'a ScannedPlugin {
        list.iter()
            .find(|p| p.dir.ends_with(&format!("/{name}")))
            .unwrap()
    }

    #[test]
    fn missing_plugins_dir_is_empty() {
        let t = tempfile::tempdir().unwrap();
        assert!(scan(&t.path().join("nope")).unwrap().is_empty());
    }

    #[test]
    fn scans_all_cases() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        plugin(
            root,
            "ok",
            Some(r#"{"id":"a"}"#),
            &[("index.js", "export default 1;")],
        );
        plugin(
            root,
            "custom-main",
            Some(r#"{"main":"dist/./p.js"}"#),
            &[("dist/p.js", "x")],
        );
        plugin(root, "no-manifest", None, &[("index.js", "x")]);
        plugin(root, "bad-json", Some("{ not json"), &[("index.js", "x")]);
        plugin(
            root,
            "escape-dots",
            Some(r#"{"main":"../ok/index.js"}"#),
            &[],
        );
        plugin(root, "escape-abs", Some(r#"{"main":"/etc/hosts"}"#), &[]);
        plugin(root, "no-entry", Some(r#"{"main":"main.js"}"#), &[]);
        plugin(root, "main-not-string", Some(r#"{"main":3}"#), &[]);
        plugin(root, ".hidden", Some("{}"), &[("index.js", "x")]);
        fs::write(root.join("stray-file.txt"), "x").unwrap();
        plugin(root, "escape-link", Some(r#"{"main":"link.js"}"#), &[]);
        std::os::unix::fs::symlink(root.join("ok/index.js"), root.join("escape-link/link.js"))
            .unwrap();

        let outside = root
            .parent()
            .unwrap()
            .join(format!("outside-manifest-{}.json", std::process::id()));
        fs::write(&outside, r#"{"id":"outside"}"#).unwrap();
        plugin(root, "manifest-link", None, &[("index.js", "x")]);
        std::os::unix::fs::symlink(&outside, root.join("manifest-link/manifest.json")).unwrap();
        // A symlinked manifest that stays inside the folder is fine.
        plugin(
            root,
            "manifest-inner-link",
            None,
            &[("real.json", "{}"), ("index.js", "y")],
        );
        std::os::unix::fs::symlink(
            root.join("manifest-inner-link/real.json"),
            root.join("manifest-inner-link/manifest.json"),
        )
        .unwrap();

        let list = scan(root).unwrap();
        fs::remove_file(&outside).unwrap();
        assert_eq!(list.len(), 11);

        let ml = by_name(&list, "manifest-link");
        assert!(ml.manifest_text.is_none() && ml.entry_source.is_none());
        assert!(
            ml.error.as_deref().unwrap().contains("之外"),
            "{:?}",
            ml.error
        );
        let mi = by_name(&list, "manifest-inner-link");
        assert_eq!(mi.manifest_text.as_deref(), Some("{}"));
        assert_eq!(mi.entry_source.as_deref(), Some("y"));

        let ok = by_name(&list, "ok");
        assert_eq!(ok.manifest_text.as_deref(), Some(r#"{"id":"a"}"#));
        assert_eq!(ok.entry_source.as_deref(), Some("export default 1;"));
        assert!(ok.error.is_none());
        assert!(Path::new(&ok.dir).is_absolute());

        assert_eq!(
            by_name(&list, "custom-main").entry_source.as_deref(),
            Some("x")
        );

        let nm = by_name(&list, "no-manifest");
        assert!(nm.manifest_text.is_none() && nm.error.as_deref().unwrap().contains("manifest"));

        let bj = by_name(&list, "bad-json");
        assert_eq!(bj.manifest_text.as_deref(), Some("{ not json"));
        assert!(bj.entry_source.is_none() && bj.error.as_deref().unwrap().contains("JSON"));

        for name in ["escape-dots", "escape-abs", "escape-link"] {
            let p = by_name(&list, name);
            assert!(p.entry_source.is_none(), "{name}");
            assert!(
                p.error.as_deref().unwrap().contains("越出"),
                "{name}: {:?}",
                p.error
            );
        }

        let ne = by_name(&list, "no-entry");
        assert!(ne.error.as_deref().unwrap().contains("缺少入口"));
        assert!(by_name(&list, "main-not-string").error.is_some());
    }

    #[test]
    fn serializes_camel_case() {
        let p = ScannedPlugin {
            dir: "/d".into(),
            manifest_text: None,
            entry_source: Some("s".into()),
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({"dir":"/d","manifestText":null,"entrySource":"s","error":null})
        );
    }
}
