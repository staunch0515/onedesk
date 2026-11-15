//! The `files` host capability, limited to folders the user granted (D184, D261).
//! Every path is made absolute, normalized and has its symlinks resolved *before* it is compared
//! with the grants, component by component (so `/a/b` does not cover `/a/bc`).

use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use crate::util::{denied, err_p, internal, invalid, invalid_params, not_found, KResult};
use onedesk_protocol::ErrorCode;

pub const MAX_TEXT: u64 = 2 * 1024 * 1024;
pub const MAX_BATCH: usize = 1000;
pub const DEFAULT_BATCH: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
    pub modified_at: i64,
    pub hidden: bool,
}

/// Resolves `raw` to a real path inside one of `grants`; anything else is `denied`.
/// For a path that does not exist yet (`writeText` of a new file) the parent must exist.
pub fn resolve(grants: &[PathBuf], raw: &str) -> KResult<PathBuf> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(denied("notAbsolute"));
    }
    let real = match std::fs::canonicalize(p) {
        Ok(r) => r,
        Err(_) => {
            // New file: canonicalize the parent, keep a plain final name.
            let name = match p.components().next_back() {
                Some(Component::Normal(n)) => n.to_os_string(),
                _ => return Err(denied("outsideGrant")),
            };
            let parent = p.parent().ok_or_else(|| denied("outsideGrant"))?;
            let parent = std::fs::canonicalize(parent).map_err(|_| not_found("path"))?;
            parent.join(name)
        }
    };
    if grants.iter().any(|g| real.starts_with(g)) {
        Ok(real)
    } else {
        Err(denied("outsideGrant"))
    }
}

fn millis(t: std::io::Result<std::time::SystemTime>) -> i64 {
    t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn entry(path: &Path) -> KResult<Entry> {
    let md = std::fs::metadata(path).map_err(|_| not_found("path"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    Ok(Entry {
        hidden: name.starts_with('.'),
        name,
        path: path.display().to_string(),
        dir: md.is_dir(),
        size: if md.is_dir() { 0 } else { md.len() },
        modified_at: millis(md.modified()),
    })
}

fn entry_no_follow(path: &Path) -> KResult<Entry> {
    let md = std::fs::symlink_metadata(path).map_err(|_| not_found("path"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Entry {
        hidden: name.starts_with('.'),
        name,
        path: path.display().to_string(),
        dir: false,
        size: 0,
        modified_at: millis(md.modified()),
    })
}

pub fn roots(grants: &[PathBuf]) -> Value {
    Value::Array(
        grants
            .iter()
            .map(|g| {
                json!({ "path": g.display().to_string(),
                        "name": g.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| g.display().to_string()) })
            })
            .collect(),
    )
}

pub fn list(grants: &[PathBuf], raw: &str, opts: &Value) -> KResult<Value> {
    let dir = resolve(grants, raw)?;
    if !dir.is_dir() {
        return Err(invalid("notFolder"));
    }
    let offset = opts.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = (opts.get("limit").and_then(Value::as_u64).unwrap_or(DEFAULT_BATCH as u64) as usize).clamp(1, MAX_BATCH);
    let mut entries: Vec<Entry> = std::fs::read_dir(&dir)
        .map_err(internal)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            // A link that leads outside every grant is listed as itself, without following it.
            let follows = std::fs::canonicalize(&path).is_ok_and(|r| grants.iter().any(|g| r.starts_with(g)));
            if follows { entry(&path).ok() } else { entry_no_follow(&path).ok() }
        })
        .collect();
    // Folders first, then by name (case-insensitive).
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    let total = entries.len();
    let page: Vec<Entry> = entries.into_iter().skip(offset).take(limit).collect();
    let next = (offset + page.len() < total).then_some(offset + page.len());
    Ok(json!({ "entries": page, "next": next }))
}

pub fn stat(grants: &[PathBuf], raw: &str) -> KResult<Value> {
    let p = resolve(grants, raw)?;
    Ok(serde_json::to_value(entry(&p)?).expect("json"))
}

pub fn read_text(grants: &[PathBuf], raw: &str) -> KResult<Value> {
    let p = resolve(grants, raw)?;
    let md = std::fs::metadata(&p).map_err(|_| not_found("path"))?;
    if md.is_dir() {
        return Err(invalid("notFile"));
    }
    if md.len() > MAX_TEXT {
        return Err(invalid("tooLarge"));
    }
    let bytes = std::fs::read(&p).map_err(internal)?;
    let basis = crate::util::fingerprint(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| invalid("notText"))?;
    Ok(json!({ "text": text, "basis": basis }))
}

/// Writes through a temporary file in the same folder, then renames over the target.
/// Returns the resolved path (for the audit) and the new basis.
pub fn write_text(grants: &[PathBuf], raw: &str, text: &str, basis: Option<&str>) -> KResult<(PathBuf, String)> {
    let p = resolve(grants, raw)?;
    if p.is_dir() {
        return Err(invalid("notFile"));
    }
    if text.len() as u64 > MAX_TEXT {
        return Err(invalid("tooLarge"));
    }
    if let Some(b) = basis {
        let current = std::fs::read(&p).ok().map(|c| crate::util::fingerprint(&c));
        if current.as_deref() != Some(b) {
            return Err(err_p(ErrorCode::Conflict, &[("reason", "changedOnDisk")]));
        }
    }
    let dir = p.parent().ok_or_else(|| invalid_params("no parent"))?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.onedesk-{}.tmp", crate::util::new_id()));
    let res = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        if let Ok(md) = std::fs::metadata(&p) {
            let _ = std::fs::set_permissions(&tmp, md.permissions());
        }
        std::fs::rename(&tmp, &p)
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(internal(e));
    }
    Ok((p, crate::util::fingerprint(text.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Setup {
        _tmp: tempfile::TempDir,
        grant: PathBuf,
        outside: PathBuf,
    }

    fn setup() -> Setup {
        let tmp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(tmp.path()).unwrap();
        let grant = base.join("a").join("b");
        let sibling = base.join("a").join("bc");
        let outside = base.join("outside");
        for d in [&grant, &sibling, &outside] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(grant.join("in.txt"), "inside").unwrap();
        std::fs::write(sibling.join("secret.txt"), "sibling").unwrap();
        std::fs::write(outside.join("secret.txt"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), grant.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, grant.join("linkdir")).unwrap();
        Setup { _tmp: tmp, grant, outside }
    }

    fn code(r: KResult<impl std::fmt::Debug>) -> ErrorCode {
        r.unwrap_err().code
    }

    #[test]
    fn files_inside_the_grant_are_readable_and_writable() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let p = s.grant.join("in.txt").display().to_string();
        let r = read_text(&g, &p).unwrap();
        assert_eq!(r["text"], "inside");
        let (_, b2) = write_text(&g, &p, "changed", r["basis"].as_str()).unwrap();
        assert_eq!(read_text(&g, &p).unwrap()["basis"], b2.as_str());
        let new = s.grant.join("new.txt").display().to_string();
        write_text(&g, &new, "fresh", None).unwrap();
        let l = list(&g, &s.grant.display().to_string(), &json!({})).unwrap();
        assert!(l["entries"].as_array().unwrap().iter().any(|e| e["name"] == "new.txt"));
        // No temporary files left behind.
        assert!(!l["entries"].as_array().unwrap().iter().any(|e| e["name"].as_str().unwrap().ends_with(".tmp")));
    }

    #[test]
    fn files_outside_the_granted_folder_are_denied() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let p = s.outside.join("secret.txt").display().to_string();
        assert_eq!(code(read_text(&g, &p)), ErrorCode::Denied);
        assert_eq!(code(write_text(&g, &p, "x", None)), ErrorCode::Denied);
        assert_eq!(code(list(&g, &s.outside.display().to_string(), &json!({}))), ErrorCode::Denied);
        assert_eq!(std::fs::read_to_string(s.outside.join("secret.txt")).unwrap(), "outside");
    }

    #[test]
    fn files_dotdot_escape_is_denied() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let p = format!("{}/../../outside/secret.txt", s.grant.display());
        assert_eq!(code(read_text(&g, &p)), ErrorCode::Denied);
        let w = format!("{}/../../outside/new.txt", s.grant.display());
        assert_eq!(code(write_text(&g, &w, "x", None)), ErrorCode::Denied);
        assert!(!s.outside.join("new.txt").exists());
        assert_eq!(code(read_text(&g, "relative/in.txt")), ErrorCode::Denied);
    }

    #[test]
    fn files_symlink_pointing_outside_is_denied() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let link = s.grant.join("link.txt").display().to_string();
        assert_eq!(code(read_text(&g, &link)), ErrorCode::Denied);
        assert_eq!(code(write_text(&g, &link, "x", None)), ErrorCode::Denied);
        let through_dir = s.grant.join("linkdir").join("secret.txt").display().to_string();
        assert_eq!(code(read_text(&g, &through_dir)), ErrorCode::Denied);
        assert_eq!(code(write_text(&g, &s.grant.join("linkdir/new.txt").display().to_string(), "x", None)), ErrorCode::Denied);
        assert_eq!(std::fs::read_to_string(s.outside.join("secret.txt")).unwrap(), "outside");
    }

    #[test]
    fn files_same_name_prefix_of_grant_is_denied() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let p = format!("{}c/secret.txt", s.grant.display()); // …/a/bc/secret.txt
        assert_eq!(code(read_text(&g, &p)), ErrorCode::Denied);
        assert_eq!(code(stat(&g, &p)), ErrorCode::Denied);
    }

    #[test]
    fn files_too_large_or_binary_is_invalid_and_stale_basis_conflicts() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let big = s.grant.join("big.txt");
        std::fs::write(&big, vec![b'a'; (MAX_TEXT + 1) as usize]).unwrap();
        let e = read_text(&g, &big.display().to_string()).unwrap_err();
        assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::Invalid, "tooLarge"));
        let bin = s.grant.join("bin.dat");
        std::fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        let e = read_text(&g, &bin.display().to_string()).unwrap_err();
        assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::Invalid, "notText"));
        let p = s.grant.join("in.txt").display().to_string();
        let old = read_text(&g, &p).unwrap()["basis"].as_str().unwrap().to_string();
        std::fs::write(s.grant.join("in.txt"), "changed elsewhere").unwrap();
        assert_eq!(code(write_text(&g, &p, "mine", Some(&old))), ErrorCode::Conflict);
        assert_eq!(std::fs::read_to_string(s.grant.join("in.txt")).unwrap(), "changed elsewhere");
    }

    #[test]
    fn list_is_paged() {
        let s = setup();
        let g = vec![s.grant.clone()];
        for i in 0..5 {
            std::fs::write(s.grant.join(format!("f{i}.txt")), "").unwrap();
        }
        let first = list(&g, &s.grant.display().to_string(), &json!({ "limit": 3 })).unwrap();
        assert_eq!(first["entries"].as_array().unwrap().len(), 3);
        let next = first["next"].as_u64().unwrap();
        let rest = list(&g, &s.grant.display().to_string(), &json!({ "offset": next, "limit": 100 })).unwrap();
        assert!(rest["next"].is_null());
    }
}
