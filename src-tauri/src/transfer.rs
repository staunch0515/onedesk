//! Export / import folders: `onedesk-export-YYYYMMDD-HHMMSS/` with JSON files and an empty `attachments/`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::time::UtcTime;

#[derive(Debug, Clone, Deserialize)]
pub struct ExportFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportData {
    pub resources: String,
    pub collections: String,
    pub manifest: String,
}

/// Only plain file names inside the export folder are allowed.
fn check_file_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name == "attachments"
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0');
    if bad {
        return Err(format!("导出文件名无效：{name}"));
    }
    Ok(())
}

/// Creates the export folder under `parent_dir`, writes `files` and an empty `attachments/`.
/// On any failure the half-written folder is removed. Returns the folder path.
pub fn export_write(
    parent_dir: &Path,
    files: &[ExportFile],
    now: UtcTime,
) -> Result<String, String> {
    if !parent_dir.is_dir() {
        return Err(format!(
            "导出位置不存在或不是文件夹：{}",
            parent_dir.display()
        ));
    }
    for f in files {
        check_file_name(&f.name)?;
    }
    let base = format!("onedesk-export-{}", now.compact());
    let mut dir: PathBuf = parent_dir.join(&base);
    let mut n = 2;
    while dir.exists() {
        dir = parent_dir.join(format!("{base}-{n}"));
        n += 1;
    }
    fs::create_dir(&dir).map_err(|e| format!("无法创建导出文件夹：{e}"))?;
    let write_all = || -> std::io::Result<()> {
        fs::create_dir(dir.join("attachments"))?;
        for f in files {
            fs::write(dir.join(&f.name), &f.content)?;
        }
        Ok(())
    };
    if let Err(e) = write_all() {
        let _ = fs::remove_dir_all(&dir);
        return Err(format!("写入导出文件失败：{e}"));
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Reads resources.json, collections.json and manifest.json from an export folder.
pub fn import_read(dir: &Path) -> Result<ImportData, String> {
    if !dir.is_dir() {
        return Err(format!("导入位置不存在或不是文件夹：{}", dir.display()));
    }
    let read = |name: &str| -> Result<String, String> {
        let p = dir.join(name);
        fs::read_to_string(&p).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("导出文件夹中缺少 {name}。")
            } else {
                format!("无法读取 {name}：{e}")
            }
        })
    };
    Ok(ImportData {
        resources: read("resources.json")?,
        collections: read("collections.json")?,
        manifest: read("manifest.json")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files() -> Vec<ExportFile> {
        [
            ("resources.json", r#"[{"id":"r1","name":"中文"}]"#),
            ("collections.json", "[]"),
            ("plugins.json", "[]"),
            ("manifest.json", r#"{"format":1}"#),
        ]
        .iter()
        .map(|(n, c)| ExportFile {
            name: n.to_string(),
            content: c.to_string(),
        })
        .collect()
    }

    #[test]
    fn roundtrip() {
        let t = tempfile::tempdir().unwrap();
        let now = UtcTime::from_unix_millis(1_700_000_000_000);
        let out = export_write(t.path(), &files(), now).unwrap();
        assert!(out.ends_with("onedesk-export-20231114-221320"));
        let out = Path::new(&out);
        assert!(out.join("attachments").is_dir());
        assert_eq!(fs::read_dir(out.join("attachments")).unwrap().count(), 0);
        assert!(out.join("plugins.json").is_file());
        let back = import_read(out).unwrap();
        assert_eq!(back.resources, r#"[{"id":"r1","name":"中文"}]"#);
        assert_eq!(back.collections, "[]");
        assert_eq!(back.manifest, r#"{"format":1}"#);
        // Same second again → a distinct folder.
        let again = export_write(t.path(), &files(), now).unwrap();
        assert!(again.ends_with("onedesk-export-20231114-221320-2"));
    }

    #[test]
    fn rejects_bad_input() {
        let t = tempfile::tempdir().unwrap();
        let now = UtcTime::now();
        assert!(export_write(&t.path().join("missing"), &files(), now).is_err());
        let bad = vec![ExportFile {
            name: "../evil.json".into(),
            content: String::new(),
        }];
        assert!(export_write(t.path(), &bad, now).is_err());
        assert_eq!(fs::read_dir(t.path()).unwrap().count(), 0);

        let out = export_write(t.path(), &files(), now).unwrap();
        fs::remove_file(Path::new(&out).join("collections.json")).unwrap();
        let err = import_read(Path::new(&out)).unwrap_err();
        assert!(err.contains("collections.json"), "{err}");
        assert!(import_read(&t.path().join("missing")).is_err());
    }
}
