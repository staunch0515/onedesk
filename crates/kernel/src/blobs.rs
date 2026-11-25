//! D484 §16 (K1): files kept by their content. A file is stored once under its SHA-256 ("blob") in
//! `<workspace>/blobs/<first two>/<blob>`; resources refer to blobs from attachment fields (`{ "blob": … }`) and from
//! `![…](blob:…)` in their reference text fields. `blob_uses` remembers every resource that has ever used a blob (its
//! history included), so an old revision can be restored with its image; rows go when the resource is purged. A blob
//! nobody uses is removed a day after it came. Only images (png, jpeg, gif, webp), judged by their first bytes.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use onedesk_protocol::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::pipeline::{db_err, KindRule};
use crate::store::Row;
use crate::util::*;

pub const MAX_BYTES: usize = 20 * 1024 * 1024;
/// Blobs one resource may refer to.
pub const MAX_PER_RESOURCE: usize = 200;
/// A blob no resource uses goes this long after it came.
pub const UNUSED_MS: i64 = 24 * 60 * 60 * 1000;

/// What the first bytes say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sniffed {
    pub ty: &'static str,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

fn be16(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from(*b.get(i)?) << 8 | u32::from(*b.get(i + 1)?))
}
fn be32(b: &[u8], i: usize) -> Option<u32> {
    Some(be16(b, i)? << 16 | be16(b, i + 2)?)
}
fn le16(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from(*b.get(i)?) | u32::from(*b.get(i + 1)?) << 8)
}
fn le24(b: &[u8], i: usize) -> Option<u32> {
    Some(le16(b, i)? | u32::from(*b.get(i + 2)?) << 16)
}

/// The image type and size, from the header only (nothing is decoded). `None`: not an image this accepts.
pub fn sniff(b: &[u8]) -> Option<Sniffed> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        // IHDR right after the signature: width and height, big-endian.
        let ok = b.get(12..16) == Some(b"IHDR");
        return Some(Sniffed { ty: "image/png", width: ok.then(|| be32(b, 16)).flatten(), height: ok.then(|| be32(b, 20)).flatten() });
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some(Sniffed { ty: "image/gif", width: le16(b, 6), height: le16(b, 8) });
    }
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        let (w, h) = match b.get(12..16) {
            Some(b"VP8 ") => (le16(b, 26).map(|v| v & 0x3fff), le16(b, 28).map(|v| v & 0x3fff)),
            Some(b"VP8L") => match (b.get(21), b.get(22), b.get(23), b.get(24)) {
                (Some(&b0), Some(&b1), Some(&b2), Some(&b3)) => {
                    let bits = u32::from(b0) | u32::from(b1) << 8 | u32::from(b2) << 16 | u32::from(b3) << 24;
                    (Some((bits & 0x3fff) + 1), Some(((bits >> 14) & 0x3fff) + 1))
                }
                _ => (None, None),
            },
            Some(b"VP8X") => (le24(b, 24).map(|v| v + 1), le24(b, 27).map(|v| v + 1)),
            _ => (None, None),
        };
        return Some(Sniffed { ty: "image/webp", width: w, height: h });
    }
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        // Walk the markers to the first start-of-frame.
        let mut i = 2;
        let (mut w, mut h) = (None, None);
        while i + 9 < b.len() {
            if b[i] != 0xFF {
                break;
            }
            let marker = b[i + 1];
            if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
                i += 2;
                continue;
            }
            let Some(len) = be16(b, i + 2) else { break };
            if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
                h = be16(b, i + 5);
                w = be16(b, i + 7);
                break;
            }
            i += 2 + len as usize;
        }
        return Some(Sniffed { ty: "image/jpeg", width: w, height: h });
    }
    None
}

pub fn hash(b: &[u8]) -> String {
    let d = Sha256::digest(b);
    d.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn is_blob(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn path(dir: &Path, blob: &str) -> PathBuf {
    dir.join("blobs").join(&blob[..2]).join(blob)
}

/// Standard base64 (padding optional, whitespace ignored). `None` when it is not base64.
pub fn unbase64(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let clean: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let body: &[u8] = match clean.iter().position(|&c| c == b'=') {
        Some(p) if clean[p..].iter().all(|&c| c == b'=') && clean.len() - p <= 2 => &clean[..p],
        Some(_) => return None,
        None => &clean,
    };
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.chunks(4) {
        if chunk.len() == 1 {
            return None;
        }
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// The blobs written in a text as `](blob:<blob>)` (Markdown images and links), each once, in order.
pub fn in_text(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("](blob:") {
        let tail = &rest[i + 7..];
        let cand: String = tail.chars().take(64).collect();
        if is_blob(&cand) && tail[64.min(tail.len())..].starts_with(')') && !out.contains(&cand) {
            out.push(cand);
        }
        rest = &rest[i + 7..];
    }
    out
}

/// The blobs a resource's body refers to: its attachment fields (`{ "blob": … }`) and the `blob:` images of its
/// reference text fields.
pub fn uses_of(rule: &KindRule, row: &Row) -> (Vec<String>, Vec<String>) {
    let mut fields = Vec::new();
    for k in &rule.attachment_fields {
        if let Some(b) = row.body.get(k).and_then(|v| v.get("blob")).and_then(Value::as_str) {
            fields.push(b.to_string());
        }
    }
    let mut texts = Vec::new();
    for k in &rule.text_refs {
        if let Some(t) = row.body.get(k).and_then(Value::as_str) {
            for b in in_text(t) {
                if !texts.contains(&b) {
                    texts.push(b);
                }
            }
        }
    }
    (fields, texts)
}

pub fn exists(conn: &Connection, blob: &str) -> rusqlite::Result<bool> {
    Ok(conn.query_row("SELECT 1 FROM blobs WHERE hash = ?1", [blob], |_| Ok(())).optional()?.is_some())
}

/// Records what `row` refers to now. An attachment field must name a stored image blob (else `invalid/unknownBlob`);
/// a `blob:` in text that is not stored is only text. At most `MAX_PER_RESOURCE`.
pub fn record(conn: &Connection, rule: &KindRule, row: &Row) -> KResult<()> {
    let (fields, texts) = uses_of(rule, row);
    let mut all: BTreeSet<String> = BTreeSet::new();
    for b in fields {
        if !is_blob(&b) || !exists(conn, &b).map_err(db_err)? {
            return Err(err_p(ErrorCode::Invalid, &[("reason", "unknownBlob")]));
        }
        all.insert(b);
    }
    for b in texts {
        if exists(conn, &b).map_err(db_err)? {
            all.insert(b);
        }
    }
    if all.len() > MAX_PER_RESOURCE {
        return Err(err_p(ErrorCode::Invalid, &[("reason", "tooManyBlobs")]));
    }
    let mut st = conn.prepare_cached("INSERT OR IGNORE INTO blob_uses (resource_id, hash) VALUES (?1, ?2)").map_err(db_err)?;
    for b in all {
        st.execute(params![row.id, b]).map_err(db_err)?;
    }
    Ok(())
}

pub fn used_by(conn: &Connection, resource: &str, blob: &str) -> rusqlite::Result<bool> {
    Ok(conn.query_row("SELECT 1 FROM blob_uses WHERE resource_id = ?1 AND hash = ?2", [resource, blob], |_| Ok(())).optional()?.is_some())
}

/// Blobs nobody uses that came before `cutoff`: their rows go; returns them (the caller removes the files).
pub fn unused_before(conn: &Connection, cutoff: i64) -> rusqlite::Result<Vec<String>> {
    let mut st = conn.prepare("SELECT hash FROM blobs WHERE created_at < ?1 AND hash NOT IN (SELECT hash FROM blob_uses)")?;
    let gone: Vec<String> = st.query_map([cutoff], |r| r.get(0))?.collect::<Result<_, _>>()?;
    drop(st);
    for h in &gone {
        conn.execute("DELETE FROM blobs WHERE hash = ?1", [h])?;
    }
    Ok(gone)
}

/// Writes a blob's file if it is not there yet (through a temporary file and a rename).
pub fn write_file(dir: &Path, blob: &str, bytes: &[u8]) -> std::io::Result<()> {
    let p = path(dir, blob);
    if p.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(p.parent().unwrap())?;
    let tmp = p.with_extension(format!("tmp-{}", new_id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &p)
}

/// Checks `bytes` (an accepted image of at most `MAX_BYTES`) and writes its file; the row is the caller's (a pipeline
/// command).
pub fn prepare(dir: &Path, bytes: &[u8]) -> KResult<BlobInfo> {
    if bytes.len() > MAX_BYTES {
        return Err(err_p(ErrorCode::Invalid, &[("reason", "tooLarge"), ("max", &MAX_BYTES.to_string())]));
    }
    let s = sniff(bytes).ok_or_else(|| err_p(ErrorCode::Invalid, &[("reason", "notAnImage")]))?;
    let blob = hash(bytes);
    write_file(dir, &blob, bytes).map_err(internal)?;
    Ok(BlobInfo { blob, r#type: s.ty.to_string(), size: bytes.len() as u64, width: s.width, height: s.height })
}

pub fn info(conn: &Connection, blob: &str) -> rusqlite::Result<Option<BlobInfo>> {
    conn.query_row("SELECT type, size, width, height FROM blobs WHERE hash = ?1", [blob], |r| {
        Ok(BlobInfo { blob: blob.to_string(), r#type: r.get(0)?, size: r.get::<_, i64>(1)? as u64, width: r.get(2)?, height: r.get(3)? })
    })
    .optional()
}

/// Method names this module answers.
pub const METHODS: &[&str] = &[onedesk_protocol::method5::BLOB_PUT, onedesk_protocol::method5::BLOB_READ];

impl crate::kernel::Inner {
    pub(crate) async fn handle_blobs(&self, client: Option<String>, m: &str, params: Value) -> KResult<Value> {
        let who = client.unwrap_or_default();
        match m {
            onedesk_protocol::method5::BLOB_PUT => {
                let p: BlobPutParams = crate::kernel::parse(params)?;
                serde_json::to_value(self.blob_put(&who, p).await?).map_err(internal)
            }
            _ => {
                let p: BlobReadParams = crate::kernel::parse(params)?;
                serde_json::to_value(self.blob_read(&who, p)?).map_err(internal)
            }
        }
    }

    /// `blob.put`: content (base64) or a file the user chose. Also removes blobs nobody has used for a day.
    pub(crate) async fn blob_put(&self, client: &str, p: BlobPutParams) -> KResult<BlobInfo> {
        let bytes = match (p.data, p.path) {
            (Some(d), None) => {
                // Base64 is 4/3 of the content: refuse what is too large before decoding it.
                if d.len() > MAX_BYTES / 3 * 4 + 8 {
                    return Err(err_p(ErrorCode::Invalid, &[("reason", "tooLarge"), ("max", &MAX_BYTES.to_string())]));
                }
                unbase64(&d).ok_or_else(|| invalid_params("data must be base64"))?
            }
            (None, Some(path)) => {
                let meta = std::fs::metadata(&path).map_err(|_| err_p(ErrorCode::NotFound, &[("what", "file")]))?;
                if !meta.is_file() {
                    return Err(err_p(ErrorCode::NotFound, &[("what", "file")]));
                }
                if meta.len() as usize > MAX_BYTES {
                    return Err(err_p(ErrorCode::Invalid, &[("reason", "tooLarge"), ("max", &MAX_BYTES.to_string())]));
                }
                std::fs::read(&path).map_err(|_| err_p(ErrorCode::NotFound, &[("what", "file")]))?
            }
            _ => return Err(invalid_params("give data or path")),
        };
        let info = prepare(&self.ws.dir, &bytes)?;
        let out = self
            .pipeline
            .execute(crate::pipeline::Actor::User, crate::pipeline::Command::BlobPut { info: info.clone(), cutoff: now_ms() - UNUSED_MS })
            .await?;
        for gone in out.report.get("gone").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            let _ = std::fs::remove_file(path(&self.ws.dir, gone));
        }
        self.blob_pending.lock().unwrap().entry(client.to_string()).or_default().insert(info.blob.clone());
        Ok(info)
    }

    /// `blob.read`: only for a resource that uses (or has used) it, or a blob this client put.
    pub(crate) fn blob_read(&self, client: &str, p: BlobReadParams) -> KResult<BlobData> {
        if !is_blob(&p.blob) {
            return Err(not_found("blob"));
        }
        let allowed = match &p.resource {
            Some(r) => self.read(|c| used_by(c, r, &p.blob))?,
            None => false,
        } || self.blob_pending.lock().unwrap().get(client).is_some_and(|s| s.contains(&p.blob));
        if !allowed {
            return Err(not_found("blob"));
        }
        let info = self.read(|c| info(c, &p.blob))?.ok_or_else(|| not_found("blob"))?;
        let bytes = std::fs::read(path(&self.ws.dir, &p.blob)).map_err(|_| not_found("blob"))?;
        Ok(BlobData { r#type: info.r#type, data: crate::secrets::base64(&bytes) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b.extend([8, 6, 0, 0, 0]);
        b
    }

    #[test]
    fn images_are_known_by_their_first_bytes_with_their_size() {
        assert_eq!(sniff(&png(640, 480)), Some(Sniffed { ty: "image/png", width: Some(640), height: Some(480) }));
        let gif = [b"GIF89a".as_slice(), &[0x20, 0x03, 0x58, 0x02]].concat();
        assert_eq!(sniff(&gif).map(|s| (s.ty, s.width, s.height)), Some(("image/gif", Some(800), Some(600))));
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0, 0];
        jpeg.extend([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x01, 0xE0, 0x02, 0x80, 0x03]);
        jpeg.extend([0u8; 16]);
        assert_eq!(sniff(&jpeg).map(|s| (s.ty, s.width, s.height)), Some(("image/jpeg", Some(640), Some(480))));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        webp.extend([0u8; 8]);
        webp.extend([0x7F, 0x02, 0x00, 0xDF, 0x01, 0x00]);
        assert_eq!(sniff(&webp).map(|s| (s.ty, s.width, s.height)), Some(("image/webp", Some(640), Some(480))));
        assert_eq!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
        assert_eq!(sniff(b"just text"), None);
    }

    #[test]
    fn base64_round_trips_and_rejects_garbage() {
        let data: Vec<u8> = (0..=255).collect();
        assert_eq!(unbase64(&crate::secrets::base64(&data)), Some(data.clone()));
        assert_eq!(unbase64("aGk="), Some(b"hi".to_vec()));
        assert_eq!(unbase64("aGk"), Some(b"hi".to_vec()));
        assert_eq!(unbase64("a"), None);
        assert_eq!(unbase64("a$=="), None);
    }

    #[test]
    fn blobs_in_text_are_markdown_images_or_links_to_blob() {
        let h = "a".repeat(64);
        let t = format!("x ![shot](blob:{h}) y [file](blob:{h}) ![bad](blob:{}) ![x](blob:{h}x)", "g".repeat(64));
        assert_eq!(in_text(&t), vec![h]);
    }
}
