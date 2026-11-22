//! Copies built-in plugin packages into `<data_dir>/plugins/<id>/<version>/` (week1-protocol §2).

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

fn safe_segment(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\', '\0'])
}

fn collect(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) -> io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ty = entry.file_type()?;
        if ty.is_dir() {
            collect(root, &path, out)?;
        } else if ty.is_file() {
            out.insert(path.strip_prefix(root).expect("inside root").to_path_buf(), std::fs::read(&path)?);
        }
    }
    Ok(())
}

fn tree_of(dir: &Path) -> io::Result<BTreeMap<PathBuf, Vec<u8>>> {
    let mut out = BTreeMap::new();
    collect(dir, dir, &mut out)?;
    Ok(out)
}

/// What copying the built-in packages did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Builtin {
    /// `<id>@<version>` of every built-in package now in place (copied now or already there, not removed by the user).
    pub present: Vec<String>,
    /// The ones written this time.
    pub copied: Vec<String>,
}

/// Where the built-in packages are: `ONEDESK_BUILTIN_PLUGINS`, else `Resources/plugins` of the `.app` the running program is in
/// (`Contents/MacOS/<exe>` → `Contents/Resources/plugins`).
pub fn bundled_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ONEDESK_BUILTIN_PLUGINS").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?.join("Resources").join("plugins");
    dir.is_dir().then_some(dir)
}

pub fn install_builtin(src_root: &Path, plugin_root: &Path) -> io::Result<Builtin> {
    let mut out = Builtin::default();
    if !src_root.is_dir() {
        return Ok(out);
    }
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(src_root)?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    for dir in dirs {
        let Ok(text) = std::fs::read_to_string(dir.join("manifest.json")) else { continue };
        let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let (Some(id), Some(version)) = (manifest["id"].as_str(), manifest["version"].as_str()) else { continue };
        if !safe_segment(id) || !safe_segment(version) {
            continue;
        }
        let dest = plugin_root.join(id).join(version);
        // The user removed this built-in version: do not put it back (a version they installed again is kept up to date).
        if !dest.exists() && crate::install::was_removed(plugin_root, id, version) {
            continue;
        }
        let wanted = tree_of(&dir)?;
        if dest.is_dir() && tree_of(&dest)? == wanted {
            out.present.push(format!("{id}@{version}"));
            continue;
        }
        let tmp = crate::install::tmp_dir(plugin_root).join(format!("{id}-{version}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        for (rel, bytes) in &wanted {
            let to = tmp.join(rel);
            std::fs::create_dir_all(to.parent().expect("has parent"))?;
            std::fs::write(to, bytes)?;
        }
        if dest.exists() {
            std::fs::remove_dir_all(&dest)?;
        }
        std::fs::create_dir_all(dest.parent().expect("has parent"))?;
        std::fs::rename(&tmp, &dest)?;
        out.present.push(format!("{id}@{version}"));
        out.copied.push(format!("{id}@{version}"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(root: &Path, id: &str, version: &str, main: &str) {
        let dir = root.join(id);
        std::fs::create_dir_all(dir.join("locales")).unwrap();
        std::fs::write(dir.join("manifest.json"), format!(r#"{{"id":"{id}","version":"{version}"}}"#)).unwrap();
        std::fs::write(dir.join("main.js"), main).unwrap();
        std::fs::write(dir.join("locales/en-US.json"), "{}").unwrap();
    }

    #[test]
    fn copies_each_package_once_and_replaces_changed_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        package(&src, "org.x.alpha", "0.1.0", "a");
        let first = install_builtin(&src, &dst).unwrap();
        assert_eq!(first.copied, vec!["org.x.alpha@0.1.0"]);
        assert_eq!(first.present, vec!["org.x.alpha@0.1.0"]);
        assert_eq!(std::fs::read_to_string(dst.join("org.x.alpha/0.1.0/main.js")).unwrap(), "a");
        assert!(dst.join("org.x.alpha/0.1.0/locales/en-US.json").is_file());
        let again = install_builtin(&src, &dst).unwrap();
        assert!(again.copied.is_empty());
        assert_eq!(again.present, vec!["org.x.alpha@0.1.0"]);
        package(&src, "org.x.alpha", "0.1.0", "b");
        assert_eq!(install_builtin(&src, &dst).unwrap().copied.len(), 1);
        assert_eq!(std::fs::read_to_string(dst.join("org.x.alpha/0.1.0/main.js")).unwrap(), "b");
    }

    #[test]
    fn ignores_unsafe_ids_and_missing_source() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        package(&src, "evil", "../../x", "a");
        assert!(install_builtin(&src, &dst).unwrap().present.is_empty());
        assert!(install_builtin(&tmp.path().join("none"), &dst).unwrap().present.is_empty());
    }
}
