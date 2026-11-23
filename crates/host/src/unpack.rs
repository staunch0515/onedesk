//! Unpacking a plugin package file (`<id>-<version>.odplugin`, a zip; D456). Only the main process does
//! this, before the usual folder checks (install.rs): the result is an ordinary package folder that the
//! worker inspects and the installer copies as before. Knows no plugin.
//!
//! Deliberately small and strict (fails closed): stored or deflate entries only; no encryption, no zip64,
//! no multi-disk; no links; every name a plain relative path; sizes and CRCs must match; the total is
//! bounded before anything is inflated. `._*`, `.DS_Store` and `__MACOSX/` are skipped.

use std::io::Read;
use std::path::{Path, PathBuf};

/// The extension of a package file.
pub const EXTENSION: &str = "odplugin";
/// At most this many entries in one package.
pub const MAX_ENTRIES: usize = 10_000;

/// Why a package file is refused (the `reason` of an `invalid` error, like install::Problem).
#[derive(Debug, PartialEq, Eq)]
pub enum Problem {
    NotPackage,
    TooBig,
    Symlink,
    UnsafePath,
    Unsupported,
    Corrupt,
    NoManifest,
    NameMismatch,
}

impl Problem {
    pub fn reason(&self) -> &'static str {
        match self {
            Problem::NotPackage => "notPackage",
            Problem::TooBig => "tooBig",
            Problem::Symlink => "symlink",
            Problem::UnsafePath => "unsafePath",
            Problem::Unsupported => "unsupported",
            Problem::Corrupt => "corrupt",
            Problem::NoManifest => "noManifest",
            Problem::NameMismatch => "nameMismatch",
        }
    }
}

/// Whether `path` names a package file (by extension; `.zip` is accepted too).
pub fn is_package_file(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    matches!(ext.as_deref(), Some(EXTENSION) | Some("zip")) && std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}

fn u16_at(b: &[u8], i: usize) -> Result<u16, Problem> {
    b.get(i..i + 2).map(|s| u16::from_le_bytes([s[0], s[1]])).ok_or(Problem::Corrupt)
}

fn u32_at(b: &[u8], i: usize) -> Result<u32, Problem> {
    b.get(i..i + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or(Problem::Corrupt)
}

fn is_junk(segment: &str) -> bool {
    segment.starts_with("._") || segment == ".DS_Store" || segment == "__MACOSX"
}

/// A name inside the archive as safe relative segments, or None for a skipped (junk) entry.
fn safe_name(name: &str) -> Result<Option<Vec<String>>, Problem> {
    if name.is_empty() || name.starts_with('/') || name.contains('\\') || name.contains('\0') || name.contains(':') {
        return Err(Problem::UnsafePath);
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    let mut out = Vec::new();
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(Problem::UnsafePath);
        }
        if is_junk(seg) {
            return Ok(None);
        }
        out.push(seg.to_string());
    }
    Ok(Some(out))
}

/// Unpacks `file` into the NEW folder `dest` (must not exist) and returns the package root inside it:
/// `dest` itself when `manifest.json` is at the top, or the single top-level folder that holds it (what
/// “Compress” in Finder makes). `limit` bounds the file and the unpacked total.
pub fn unpack(file: &Path, dest: &Path, limit: u64) -> Result<PathBuf, Problem> {
    let meta = std::fs::symlink_metadata(file).map_err(|_| Problem::NotPackage)?;
    if !meta.is_file() {
        return Err(Problem::NotPackage);
    }
    if meta.len() > limit {
        return Err(Problem::TooBig);
    }
    let bytes = std::fs::read(file).map_err(|_| Problem::NotPackage)?;
    let entries = read_directory(&bytes)?;
    let declared: u64 = entries.iter().map(|e| e.size as u64).sum();
    if declared > limit {
        return Err(Problem::TooBig);
    }
    std::fs::create_dir(dest).map_err(|_| Problem::NotPackage)?;
    let result = write_entries(&bytes, &entries, dest);
    if let Err(p) = result {
        let _ = std::fs::remove_dir_all(dest);
        return Err(p);
    }
    let root = package_root(dest).ok_or_else(|| {
        let _ = std::fs::remove_dir_all(dest);
        Problem::NoManifest
    })?;
    if let Err(p) = check_file_name(file, &root) {
        let _ = std::fs::remove_dir_all(dest);
        return Err(p);
    }
    Ok(root)
}

struct Entry {
    segments: Vec<String>,
    dir: bool,
    method: u16,
    crc: u32,
    csize: u32,
    size: u32,
    local: usize,
}

fn read_directory(b: &[u8]) -> Result<Vec<Entry>, Problem> {
    // End of central directory: the last signature within the final 64 KiB + 22 bytes.
    if b.len() < 22 {
        return Err(Problem::NotPackage);
    }
    let from = b.len().saturating_sub(22 + 0xFFFF);
    let eocd = (from..=b.len() - 22).rev().find(|&i| b[i..i + 4] == [0x50, 0x4b, 0x05, 0x06]).ok_or(Problem::NotPackage)?;
    let (disk, cd_disk) = (u16_at(b, eocd + 4)?, u16_at(b, eocd + 6)?);
    let (here, total) = (u16_at(b, eocd + 8)?, u16_at(b, eocd + 10)?);
    let (cd_size, cd_off) = (u32_at(b, eocd + 12)?, u32_at(b, eocd + 16)?);
    if disk != 0 || cd_disk != 0 || here != total || total == 0xFFFF || cd_off == 0xFFFF_FFFF || cd_size == 0xFFFF_FFFF {
        return Err(Problem::Unsupported);
    }
    if total as usize > MAX_ENTRIES {
        return Err(Problem::TooBig);
    }
    let mut at = cd_off as usize;
    if at.checked_add(cd_size as usize).is_none_or(|end| end > eocd) {
        return Err(Problem::Corrupt);
    }
    let mut out = Vec::new();
    for _ in 0..total {
        if u32_at(b, at)? != 0x0201_4b50 {
            return Err(Problem::Corrupt);
        }
        let made_by = u16_at(b, at + 4)?;
        let flags = u16_at(b, at + 8)?;
        let method = u16_at(b, at + 10)?;
        let crc = u32_at(b, at + 16)?;
        let csize = u32_at(b, at + 20)?;
        let size = u32_at(b, at + 24)?;
        let (nlen, xlen, clen) = (u16_at(b, at + 28)? as usize, u16_at(b, at + 30)? as usize, u16_at(b, at + 32)? as usize);
        let external = u32_at(b, at + 38)?;
        let local = u32_at(b, at + 42)? as usize;
        let name_bytes = b.get(at + 46..at + 46 + nlen).ok_or(Problem::Corrupt)?;
        at += 46 + nlen + xlen + clen;
        if flags & 0x0001 != 0 || flags & 0x0040 != 0 {
            return Err(Problem::Unsupported); // encrypted
        }
        if csize == 0xFFFF_FFFF || size == 0xFFFF_FFFF || local == 0xFFFF_FFFF {
            return Err(Problem::Unsupported); // zip64
        }
        // Unix file type in the high half of the external attributes: a link is refused outright.
        if made_by >> 8 == 3 && (external >> 16) & 0o170000 == 0o120000 {
            return Err(Problem::Symlink);
        }
        let name = std::str::from_utf8(name_bytes).map_err(|_| Problem::UnsafePath)?;
        let Some(segments) = safe_name(name)? else { continue };
        let dir = name.ends_with('/');
        if !dir && method != 0 && method != 8 {
            return Err(Problem::Unsupported);
        }
        out.push(Entry { segments, dir, method, crc, csize, size, local });
    }
    Ok(out)
}

fn write_entries(b: &[u8], entries: &[Entry], dest: &Path) -> Result<(), Problem> {
    let mut seen = std::collections::HashSet::new();
    for e in entries {
        let path = e.segments.iter().fold(dest.to_path_buf(), |p, s| p.join(s));
        if !seen.insert(e.segments.join("/").to_lowercase()) && !e.dir {
            return Err(Problem::UnsafePath); // the same file twice (or differing only in case)
        }
        if e.dir {
            std::fs::create_dir_all(&path).map_err(|_| Problem::Corrupt)?;
            continue;
        }
        if u32_at(b, e.local)? != 0x0403_4b50 {
            return Err(Problem::Corrupt);
        }
        let (nlen, xlen) = (u16_at(b, e.local + 26)? as usize, u16_at(b, e.local + 28)? as usize);
        let start = e.local + 30 + nlen + xlen;
        let raw = b.get(start..start + e.csize as usize).ok_or(Problem::Corrupt)?;
        let data = if e.method == 0 {
            raw.to_vec()
        } else {
            let mut out = Vec::with_capacity(e.size as usize);
            flate2::read::DeflateDecoder::new(raw).take(e.size as u64 + 1).read_to_end(&mut out).map_err(|_| Problem::Corrupt)?;
            out
        };
        if data.len() != e.size as usize || crc32fast::hash(&data) != e.crc {
            return Err(Problem::Corrupt);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| Problem::Corrupt)?;
        }
        std::fs::write(&path, &data).map_err(|_| Problem::Corrupt)?;
    }
    Ok(())
}

fn package_root(dest: &Path) -> Option<PathBuf> {
    if dest.join("manifest.json").is_file() {
        return Some(dest.to_path_buf());
    }
    let dirs: Vec<PathBuf> = std::fs::read_dir(dest).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    match dirs.as_slice() {
        [only] if only.is_dir() && only.join("manifest.json").is_file() => Some(only.clone()),
        _ => None,
    }
}

/// A file named `<id>-<version>.odplugin` must hold exactly that id and version (other names are not checked:
/// the confirmation dialog shows what is inside).
fn check_file_name(file: &Path, root: &Path) -> Result<(), Problem> {
    let Some(stem) = file.file_stem().and_then(|s| s.to_str()) else { return Ok(()) };
    let text = std::fs::read_to_string(root.join("manifest.json")).map_err(|_| Problem::NoManifest)?;
    let m: serde_json::Value = serde_json::from_str(&text).map_err(|_| Problem::NoManifest)?;
    let (Some(id), Some(version)) = (m["id"].as_str(), m["version"].as_str()) else { return Ok(()) };
    let named_like_package = stem.split_once('-').is_some_and(|(_, rest)| rest.starts_with(|c: char| c.is_ascii_digit()));
    if file.extension().and_then(|e| e.to_str()) == Some(EXTENSION) && named_like_package && stem != format!("{id}-{version}") {
        return Err(Problem::NameMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A tiny zip writer for the tests (deflate or stored), matching what scripts/plugin-tool.mjs writes.
    fn zip(entries: &[(&str, &[u8], bool)], link: Option<&str>) -> Vec<u8> {
        let (mut body, mut cen) = (Vec::new(), Vec::new());
        let mut all: Vec<(&str, &[u8], bool, bool)> = entries.iter().map(|(n, d, z)| (*n, *d, *z, false)).collect();
        if let Some(l) = link {
            all.push((l, b"/etc/passwd", false, true));
        }
        for (name, data, deflate, is_link) in all {
            let packed = if deflate {
                let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                e.write_all(data).unwrap();
                e.finish().unwrap()
            } else {
                data.to_vec()
            };
            let crc = crc32fast::hash(data);
            let method: u16 = if deflate { 8 } else { 0 };
            let off = body.len() as u32;
            body.extend(0x0403_4b50u32.to_le_bytes());
            body.extend([20, 0, 0, 0]);
            body.extend(method.to_le_bytes());
            body.extend([0, 0, 0x21, 0]);
            body.extend(crc.to_le_bytes());
            body.extend((packed.len() as u32).to_le_bytes());
            body.extend((data.len() as u32).to_le_bytes());
            body.extend((name.len() as u16).to_le_bytes());
            body.extend([0, 0]);
            body.extend(name.as_bytes());
            body.extend(&packed);
            cen.extend(0x0201_4b50u32.to_le_bytes());
            cen.extend([0x14, 0x03, 20, 0, 0, 0]);
            cen.extend(method.to_le_bytes());
            cen.extend([0, 0, 0x21, 0]);
            cen.extend(crc.to_le_bytes());
            cen.extend((packed.len() as u32).to_le_bytes());
            cen.extend((data.len() as u32).to_le_bytes());
            cen.extend((name.len() as u16).to_le_bytes());
            cen.extend([0, 0, 0, 0, 0, 0, 0, 0]);
            let mode: u32 = if is_link { 0o120777 } else { 0o100644 };
            cen.extend((mode << 16).to_le_bytes());
            cen.extend(off.to_le_bytes());
            cen.extend(name.as_bytes());
        }
        let n = (entries.len() + usize::from(link.is_some())) as u16;
        let (cen_off, cen_len) = (body.len() as u32, cen.len() as u32);
        body.extend(cen);
        body.extend(0x0605_4b50u32.to_le_bytes());
        body.extend([0, 0, 0, 0]);
        body.extend(n.to_le_bytes());
        body.extend(n.to_le_bytes());
        body.extend(cen_len.to_le_bytes());
        body.extend(cen_off.to_le_bytes());
        body.extend([0, 0]);
        body
    }

    const MANIFEST: &[u8] = br#"{"id":"org.test.pkg","version":"1.2.0"}"#;

    fn put(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn unpacks_a_package_with_the_manifest_at_the_top_and_skips_junk() {
        let tmp = tempfile::tempdir().unwrap();
        let file = put(tmp.path(), "org.test.pkg-1.2.0.odplugin", &zip(&[("manifest.json", MANIFEST, true), ("main.js", b"export default {};", false), ("locales/en-US.json", b"{}", true), ("._main.js", b"x", false), ("__MACOSX/._x", b"x", false)], None));
        let root = unpack(&file, &tmp.path().join("out"), 1 << 20).unwrap();
        assert_eq!(root, tmp.path().join("out"));
        assert_eq!(std::fs::read(root.join("manifest.json")).unwrap(), MANIFEST);
        assert!(root.join("locales/en-US.json").is_file());
        assert!(!root.join("._main.js").exists() && !root.join("__MACOSX").exists());
    }

    #[test]
    fn a_single_top_folder_holding_the_manifest_is_the_root() {
        let tmp = tempfile::tempdir().unwrap();
        let file = put(tmp.path(), "anything.zip", &zip(&[("pkg/manifest.json", MANIFEST, true), ("pkg/main.js", b"x", true)], None));
        assert_eq!(unpack(&file, &tmp.path().join("out"), 1 << 20).unwrap(), tmp.path().join("out/pkg"));
    }

    #[test]
    fn refuses_unsafe_names_links_bad_crcs_size_and_mismatched_file_names() {
        let tmp = tempfile::tempdir().unwrap();
        let cases: Vec<(&str, Vec<u8>, Problem)> = vec![
            ("a.odplugin", zip(&[("manifest.json", MANIFEST, false), ("../evil.js", b"x", false)], None), Problem::UnsafePath),
            ("b.odplugin", zip(&[("manifest.json", MANIFEST, false), ("/abs.js", b"x", false)], None), Problem::UnsafePath),
            ("c.odplugin", zip(&[("manifest.json", MANIFEST, false)], Some("leak")), Problem::Symlink),
            ("d.odplugin", zip(&[("main.js", b"x", false)], None), Problem::NoManifest),
            ("org.test.pkg-9.9.9.odplugin", zip(&[("manifest.json", MANIFEST, false)], None), Problem::NameMismatch),
            ("e.odplugin", b"not a zip at all, just some text that is long enough".to_vec(), Problem::NotPackage),
        ];
        for (i, (name, bytes, want)) in cases.into_iter().enumerate() {
            let file = put(tmp.path(), name, &bytes);
            let dest = tmp.path().join(format!("out{i}"));
            assert_eq!(unpack(&file, &dest, 1 << 20).unwrap_err(), want, "{name}");
            assert!(!dest.exists(), "{name}: nothing is left behind");
        }
        let mut bad = zip(&[("manifest.json", MANIFEST, false)], None);
        let at = bad.windows(MANIFEST.len()).position(|w| w == MANIFEST).unwrap();
        bad[at + 2] ^= 0xFF; // data no longer matches its CRC
        let file = put(tmp.path(), "f.odplugin", &bad);
        assert_eq!(unpack(&file, &tmp.path().join("outf"), 1 << 20).unwrap_err(), Problem::Corrupt);
        let file = put(tmp.path(), "g.odplugin", &zip(&[("manifest.json", MANIFEST, false)], None));
        assert_eq!(unpack(&file, &tmp.path().join("outg"), 10).unwrap_err(), Problem::TooBig);
    }

    #[test]
    fn recognises_package_files_by_extension() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(is_package_file(&put(tmp.path(), "x-1.0.0.odplugin", b"")));
        assert!(is_package_file(&put(tmp.path(), "x.ZIP", b"")));
        assert!(!is_package_file(&put(tmp.path(), "x.json", b"")));
        assert!(!is_package_file(tmp.path()));
    }
}
