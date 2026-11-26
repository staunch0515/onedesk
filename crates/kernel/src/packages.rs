//! D487 §21 (docs/redesign/book.md): publishing a subtree and read-only copies (K9), and withheld fields (K10). The
//! kernel knows subtrees, variants and fields here — no book, no answer.
//! - `host.packages.publish(root, { edition, printing, variant, exclude, reveal, path })`: the subtree as it is now is
//!   kept as edition `edition` (in `<workspace>/packages/<root>/`; never changed after), then written as `reprint` does.
//! - `host.packages.reprint(root, { … })`: that kept edition written to `path` (a granted folder) as a package file: the
//!   `teacher` variant whole, the `student` one without `exclude` (and what is below them) and without withheld fields —
//!   unless `reveal`ed, or, when the kind's `seal` gives accepted writings, as fingerprints with the original text to
//!   go to the keychain.
//! - `package.inspect` / `package.import` (the user's): a read-only copy, ids kept, `origin` = `subscribed`; a newer
//!   printing of the same publisher's root replaces it.
//! - `host.sealed.check(resource, field, text)` / `host.sealed.open(resource, field)`: fingerprints, and the keychain.
//!
//! A package is a zip file (stored entries only) holding `package.json` and `blobs/<hash>`.

use std::collections::{HashMap, HashSet};
use std::io::Write;

use onedesk_protocol::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::Plugin;
use crate::pipeline::{Actor, Command, Outcome, Tx};
use crate::sandbox::CallInfo;
use crate::store::{self, Row, TREE_RESOURCES};
use crate::util::*;

/// `origin` of a read-only copy's rows (their `origin_ref` is the copy's root).
pub const ORIGIN_COPY: &str = "subscribed";
pub const FORMAT: u32 = 1;
/// The largest package file read (images included).
pub const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
/// Most resources one package holds.
pub const MAX_PACKAGE_RESOURCES: usize = 50_000;
const SEAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRow {
    pub id: String,
    pub kind: String,
    pub parent: Option<String>,
    pub pos: i64,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub body: JsonMap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedEntry {
    pub resource: String,
    pub field: String,
    pub salt: String,
    pub hashes: Vec<String>,
    /// The original text; on import it goes to the keychain, never to the database.
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageFile {
    pub format: u32,
    pub publisher: String,
    pub publisher_name: String,
    pub root: String,
    pub title: String,
    pub edition: u32,
    pub printing: u32,
    /// `archive` (kept by the publisher), `student`, `teacher`.
    pub variant: String,
    pub published_at: i64,
    pub resources: Vec<PackRow>,
    #[serde(default)]
    pub sealed: Vec<SealedEntry>,
    /// D487 §33 (K18): the publisher's public key and its signature of the package (`package_message`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// What a package's signature covers: its root, edition, printing and variant, the SHA-256 of `package.json` without the
/// signature, and the names (hashes) of its images in order.
pub fn package_message(pkg: &PackageFile, blobs: &[String]) -> String {
    let mut unsigned = pkg.clone();
    unsigned.signature = None;
    let json = serde_json::to_vec(&unsigned).unwrap_or_default();
    let mut names: Vec<&String> = blobs.iter().collect();
    names.sort();
    let names: Vec<&str> = names.into_iter().map(String::as_str).collect();
    format!(
        "onedesk-package/1\n{}\n{}\n{}\n{}\n{}\n{}",
        pkg.root,
        pkg.edition,
        pkg.printing,
        pkg.variant,
        crate::identity::sha256_hex(&json),
        names.join(",")
    )
}

/// Everything of one import, written in one transaction.
#[derive(Debug, Clone)]
pub struct PackagePlan {
    pub pkg: PackageFile,
    /// The active version of the plugin of each kind there is in this workspace.
    pub versions: HashMap<String, Option<String>>,
    pub blobs: Vec<BlobInfo>,
}

/// The fingerprint of an accepted writing.
pub fn fingerprint(salt: &str, resource: &str, field: &str, text: &str) -> String {
    sha256_hex(format!("{salt}\u{1f}{resource}\u{1f}{field}\u{1f}{text}").as_bytes())
}

/// The keychain name of a withheld field's original text.
pub fn sealed_secret(resource: &str, field: &str) -> String {
    format!("sealed.{resource}.{field}")
}

/* ------------------------------------------------------------------ zip (stored entries only) */

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, t) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *t = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for b in data {
        crc = table[((crc ^ u32::from(*b)) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// A zip file of `entries` (name, bytes), stored without compression.
pub fn zip_write(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let offset = out.len() as u32;
        let crc = crc32(data);
        let n = name.as_bytes();
        let mut h = Vec::new();
        h.extend(0x0403_4b50u32.to_le_bytes());
        h.extend(20u16.to_le_bytes());
        h.extend(0x0800u16.to_le_bytes()); // UTF-8 names
        h.extend(0u16.to_le_bytes()); // stored
        h.extend([0u8; 4]); // time, date
        h.extend(crc.to_le_bytes());
        h.extend((data.len() as u32).to_le_bytes());
        h.extend((data.len() as u32).to_le_bytes());
        h.extend((n.len() as u16).to_le_bytes());
        h.extend(0u16.to_le_bytes());
        out.extend(&h);
        out.extend(n);
        out.extend(data);
        central.extend(0x0201_4b50u32.to_le_bytes());
        central.extend(20u16.to_le_bytes());
        central.extend(20u16.to_le_bytes());
        central.extend(0x0800u16.to_le_bytes());
        central.extend(0u16.to_le_bytes());
        central.extend([0u8; 4]);
        central.extend(crc.to_le_bytes());
        central.extend((data.len() as u32).to_le_bytes());
        central.extend((data.len() as u32).to_le_bytes());
        central.extend((n.len() as u16).to_le_bytes());
        central.extend([0u8; 8]); // extra, comment, disk, internal attrs
        central.extend(0u32.to_le_bytes()); // external attrs
        central.extend(offset.to_le_bytes());
        central.extend(n);
    }
    let start = out.len() as u32;
    let count = entries.len() as u16;
    out.extend(&central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend([0u8; 4]);
    out.extend(count.to_le_bytes());
    out.extend(count.to_le_bytes());
    out.extend((central.len() as u32).to_le_bytes());
    out.extend(start.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out
}

/// The entries of a zip file written by `zip_write` (stored entries only; anything else is refused).
pub fn zip_read(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, &'static str> {
    let le16 = |b: &[u8], i: usize| -> Option<usize> {
        b.get(i..i + 2)
            .map(|x| u16::from_le_bytes([x[0], x[1]]) as usize)
    };
    let le32 = |b: &[u8], i: usize| -> Option<usize> {
        b.get(i..i + 4)
            .map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]) as usize)
    };
    let eocd = (0..bytes.len().saturating_sub(21))
        .rev()
        .find(|&i| bytes[i..].starts_with(&[0x50, 0x4b, 0x05, 0x06]))
        .ok_or("not a zip")?;
    let count = le16(bytes, eocd + 10).ok_or("short")?;
    let mut at = le32(bytes, eocd + 16).ok_or("short")?;
    let mut out = Vec::new();
    for _ in 0..count {
        if !bytes
            .get(at..)
            .is_some_and(|b| b.starts_with(&[0x50, 0x4b, 0x01, 0x02]))
        {
            return Err("bad central directory");
        }
        let method = le16(bytes, at + 10).ok_or("short")?;
        let size = le32(bytes, at + 20).ok_or("short")?;
        let name_len = le16(bytes, at + 28).ok_or("short")?;
        let extra = le16(bytes, at + 30).ok_or("short")?;
        let comment = le16(bytes, at + 32).ok_or("short")?;
        let local = le32(bytes, at + 42).ok_or("short")?;
        let name = std::str::from_utf8(bytes.get(at + 46..at + 46 + name_len).ok_or("short")?)
            .map_err(|_| "bad name")?
            .to_string();
        if method != 0 {
            return Err("compressed entry");
        }
        let lname = le16(bytes, local + 26).ok_or("short")?;
        let lextra = le16(bytes, local + 28).ok_or("short")?;
        let data_at = local + 30 + lname + lextra;
        let data = bytes.get(data_at..data_at + size).ok_or("short")?.to_vec();
        out.push((name, data));
        at += 46 + name_len + extra + comment;
    }
    Ok(out)
}

/// Named files with their bytes (a zip's entries; a package's blobs by hash).
pub type Entries = Vec<(String, Vec<u8>)>;

/// A package file's content: `package.json` and its blobs.
pub fn read_package(bytes: &[u8]) -> KResult<(PackageFile, Entries)> {
    let entries = zip_read(bytes).map_err(|_| invalid("badPackage"))?;
    let json = entries
        .iter()
        .find(|(n, _)| n == "package.json")
        .ok_or_else(|| invalid("badPackage"))?;
    let pkg: PackageFile = serde_json::from_slice(&json.1).map_err(|_| invalid("badPackage"))?;
    if pkg.format != FORMAT
        || pkg.resources.len() > MAX_PACKAGE_RESOURCES
        || pkg.resources.first().map(|r| r.id.as_str()) != Some(pkg.root.as_str())
    {
        return Err(invalid("badPackage"));
    }
    let blobs = entries
        .into_iter()
        .filter_map(|(n, b)| {
            n.strip_prefix("blobs/")
                .filter(|h| crate::blobs::is_blob(h))
                .map(|h| (h.to_string(), b))
        })
        .collect();
    Ok((pkg, blobs))
}

/* ------------------------------------------------------------------ publishing */

impl Inner {
    fn archive_path(&self, root: &str, edition: u32) -> std::path::PathBuf {
        self.ws
            .dir
            .join("packages")
            .join(root)
            .join(format!("e{edition}.odpack"))
    }

    /// Where a read-only copy came from.
    pub(crate) fn copy_info(&self, root: Option<&str>) -> KResult<Option<CopyInfo>> {
        let Some(root) = root else { return Ok(None) };
        self.read(|c| {
            c.query_row("SELECT title, publisher_name, edition, printing, variant FROM copies WHERE root_id = ?1", [root], |r| {
                Ok(CopyInfo { title: r.get(0)?, publisher_name: r.get(1)?, edition: r.get(2)?, printing: r.get(3)?, variant: r.get(4)? })
            })
            .optional()
        })
    }

    /// The subtree below (and with) `root` as it is now, with the blobs it uses.
    fn snapshot(&self, root: &Row) -> KResult<(Vec<PackRow>, Entries)> {
        let mut rows = vec![root.clone()];
        rows.extend(self.read(|c| store::descendants(c, &root.id))?);
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for r in &rows {
            if r.kind == store::KIND_TREE || !seen.insert(r.id.clone()) {
                continue;
            }
            out.push(PackRow {
                id: r.id.clone(),
                kind: r.kind.clone(),
                parent: if r.id == root.id {
                    None
                } else {
                    r.parent_id.clone()
                },
                pos: r.pos,
                name: r.name.clone(),
                description: r.description.clone(),
                tags: r.tags.clone(),
                body: r.body.clone(),
            });
        }
        let ids: Vec<String> = out.iter().map(|r| r.id.clone()).collect();
        let hashes: Vec<String> = self.read(|c| {
            let mut st = c.prepare("SELECT DISTINCT hash FROM blob_uses WHERE resource_id IN (SELECT value FROM json_each(?1))")?;
            let v = st.query_map([serde_json::to_string(&ids).unwrap_or_default()], |r| r.get(0))?;
            v.collect()
        })?;
        let mut blobs = Vec::new();
        for h in hashes {
            if let Ok(b) = std::fs::read(crate::blobs::path(&self.ws.dir, &h)) {
                blobs.push((h, b));
            }
        }
        Ok((out, blobs))
    }

    /// `host.packages.publish` / `host.packages.reprint`.
    pub(crate) async fn host_packages(
        &self,
        plugin: &'static Plugin,
        info: &CallInfo,
        op: &str,
        args: &Value,
    ) -> KResult<Value> {
        if op != "publish" && op != "reprint" {
            return Err(err_p(
                ErrorCode::UnknownMethod,
                &[("method", &format!("packages.{op}"))],
            ));
        }
        if info.event || info.pure {
            return Err(denied("notInRun"));
        }
        if !plugin.manifest.requires.files {
            return Err(denied("notRequested"));
        }
        // D487 §33 (K18): what is published says who published it.
        if self.identity()?.is_none() {
            return Err(invalid("noIdentity"));
        }
        let root_id = args
            .get(0)
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_params("root must be a string"))?;
        let o = args.get(1).cloned().unwrap_or(Value::Null);
        let edition = o
            .get("edition")
            .and_then(Value::as_u64)
            .filter(|e| *e >= 1)
            .ok_or_else(|| invalid_params("edition"))? as u32;
        let printing = o
            .get("printing")
            .and_then(Value::as_u64)
            .filter(|e| *e >= 1)
            .ok_or_else(|| invalid_params("printing"))? as u32;
        let variant = o
            .get("variant")
            .and_then(Value::as_str)
            .filter(|v| matches!(*v, "student" | "teacher"))
            .ok_or_else(|| invalid_params("variant"))?
            .to_string();
        let raw_path = o
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_params("path"))?
            .to_string();
        let exclude: HashSet<String> =
            serde_json::from_value(o.get("exclude").cloned().unwrap_or(json!([])))
                .map_err(|_| invalid_params("exclude"))?;
        let reveal: HashMap<String, Vec<String>> =
            serde_json::from_value(o.get("reveal").cloned().unwrap_or(json!({})))
                .map_err(|_| invalid_params("reveal"))?;
        let root = self
            .read(|c| store::get(c, root_id))?
            .ok_or_else(|| not_found("resource"))?;
        // A plugin publishes what it owns (the subtree below may hold anything).
        if crate::manifest::Registry::split(&root.kind).map(|(p, _)| p) != Some(plugin.id.as_str())
        {
            return Err(denied("foreignKind"));
        }
        if root.origin == ORIGIN_COPY {
            return Err(denied("readOnlyCopy"));
        }
        // The edition kept as it is now (once).
        let archive = self.archive_path(&root.id, edition);
        if op == "publish" {
            if archive.exists() {
                return Err(err_p(ErrorCode::Conflict, &[("reason", "exists")]));
            }
            let (resources, blobs) = self.snapshot(&root)?;
            let pkg = PackageFile {
                format: FORMAT,
                publisher: self.ws.id.clone(),
                publisher_name: self.ws.name.clone(),
                root: root.id.clone(),
                title: root.name.clone(),
                edition,
                printing: 0,
                variant: "archive".into(),
                published_at: now_ms(),
                resources,
                sealed: vec![],
                publisher_key: None,
                signature: None,
            };
            let mut entries = vec![(
                "package.json".to_string(),
                serde_json::to_vec(&pkg).map_err(internal)?,
            )];
            entries.extend(blobs.into_iter().map(|(h, b)| (format!("blobs/{h}"), b)));
            std::fs::create_dir_all(archive.parent().unwrap_or(&self.ws.dir)).map_err(internal)?;
            std::fs::write(&archive, zip_write(&entries)).map_err(internal)?;
        }
        let bytes = std::fs::read(&archive)
            .map_err(|_| err_p(ErrorCode::NotFound, &[("what", "edition")]))?;
        let (mut pkg, blobs) = read_package(&bytes)?;
        pkg.printing = printing;
        pkg.variant = variant.clone();
        pkg.published_at = now_ms();
        if variant == "student" {
            // Without what is excluded (and what is below it).
            let mut gone: HashSet<String> = exclude.clone();
            for r in &pkg.resources {
                if r.parent.as_ref().is_some_and(|p| gone.contains(p)) {
                    gone.insert(r.id.clone());
                }
            }
            pkg.resources.retain(|r| !gone.contains(&r.id));
            // Withheld fields: revealed ones stay; sealed ones go as fingerprints with their text; the rest go.
            let mut sealed = Vec::new();
            for r in pkg.resources.iter_mut() {
                let Some((owner, decl)) = self.registry.kind(&r.kind) else {
                    continue;
                };
                let withheld: Vec<String> = decl
                    .fields
                    .iter()
                    .filter(|(_, f)| f.withheld)
                    .map(|(k, _)| k.clone())
                    .collect();
                if withheld.is_empty() {
                    continue;
                }
                let open = reveal.get(&r.id).cloned().unwrap_or_default();
                let checks = self.seal_checks(owner, &decl.id, r).await;
                for field in withheld {
                    if open.contains(&field) {
                        continue;
                    }
                    let Some(v) = r.body.remove(&field) else {
                        continue;
                    };
                    // A field the kind names goes as fingerprints of its writings (none: only to be opened).
                    if let Some(list) = checks.get(&field) {
                        let salt = new_id();
                        let hashes = list
                            .iter()
                            .map(|t| fingerprint(&salt, &r.id, &field, t))
                            .collect();
                        let value = match v {
                            Value::String(s) => s,
                            other => other.to_string(),
                        };
                        sealed.push(SealedEntry {
                            resource: r.id.clone(),
                            field,
                            salt,
                            hashes,
                            value,
                        });
                    }
                }
            }
            pkg.sealed = sealed;
        }
        let keep: HashSet<String> = pkg.resources.iter().map(|r| r.id.clone()).collect();
        let used: HashSet<String> = self.read(|c| {
            let mut st = c.prepare("SELECT DISTINCT hash FROM blob_uses WHERE resource_id IN (SELECT value FROM json_each(?1))")?;
            let v = st.query_map([serde_json::to_string(&keep.iter().collect::<Vec<_>>()).unwrap_or_default()], |r| r.get(0))?;
            v.collect()
        })?;
        let blobs: Vec<(String, Vec<u8>)> = blobs.into_iter().filter(|(h, _)| used.contains(h) || variant == "teacher").collect();
        // D487 §33 (K18): signed by the publisher's identity.
        let who = self.identity()?.ok_or_else(|| invalid("noIdentity"))?;
        pkg.publisher_key = Some(who.public_key.clone());
        pkg.publisher_name = who.name.clone();
        pkg.signature = None;
        let names: Vec<String> = blobs.iter().map(|(h, _)| h.clone()).collect();
        let (_, sig) = self.sign(package_message(&pkg, &names).as_bytes())?.ok_or_else(|| invalid("noIdentity"))?;
        pkg.signature = Some(sig);
        let mut entries = vec![(
            "package.json".to_string(),
            serde_json::to_vec(&pkg).map_err(internal)?,
        )];
        entries.extend(blobs.into_iter().map(|(h, b)| (format!("blobs/{h}"), b)));
        let data = zip_write(&entries);
        let (grants, raw) = self.files_scope_pub(plugin, &raw_path)?;
        let me = self
            .me
            .upgrade()
            .ok_or_else(|| internal("kernel stopped"))?;
        let actor = plugin.actor();
        let count = pkg.resources.len();
        let (path, len) = tokio::task::spawn_blocking(move || -> KResult<(String, usize)> {
            let mut part = crate::files::part_file(&grants, &raw, false)?;
            let shown = crate::files::resolve(&grants, &raw)?.display().to_string();
            let mut f = part.take_file();
            f.write_all(&data).map_err(internal)?;
            f.sync_all().map_err(internal)?;
            drop(f);
            part.commit(false)?;
            Ok((shown, data.len()))
        })
        .await
        .map_err(internal)??;
        me.execute(actor, Command::Audit { op: "package.publish".into(), object: path.clone(), summary: json!({ "root": root.id, "edition": edition, "printing": printing, "variant": variant, "bytes": len }) })
            .await?;
        Ok(json!({ "path": path, "resources": count }))
    }

    /// What a kind's `seal` gives: the accepted writings of each withheld field (none when it has no `seal`).
    async fn seal_checks(
        &self,
        plugin: &'static Plugin,
        kind: &str,
        r: &PackRow,
    ) -> HashMap<String, Vec<String>> {
        let ctx = json!({ "resource": { "id": r.id, "kind": r.kind, "name": r.name, "tags": r.tags, "body": r.body, "parentId": r.parent }, "params": {} });
        let info = CallInfo {
            pure: true,
            resource_id: Some(r.id.clone()),
            ..Default::default()
        };
        let Ok(v) = self
            .call_version(
                plugin,
                "kinds",
                kind,
                "seal",
                json!([ctx, {}]),
                info,
                None,
                Some(SEAL_TIMEOUT),
            )
            .await
        else {
            return HashMap::new();
        };
        serde_json::from_value::<HashMap<String, Vec<String>>>(
            v.get("checks").cloned().unwrap_or(Value::Null),
        )
        .unwrap_or_default()
    }

    /* ------------------------------------------------------------------ copies */

    fn read_package_file(&self, path: &str) -> KResult<(PackageFile, Entries)> {
        let meta = std::fs::metadata(path).map_err(|_| not_found("file"))?;
        if !meta.is_file() || meta.len() > MAX_PACKAGE_BYTES {
            return Err(invalid("badPackage"));
        }
        read_package(&std::fs::read(path).map_err(|_| not_found("file"))?)
    }

    /// What importing `pkg` would do, or why not.
    fn package_info(&self, pkg: &PackageFile, blobs: &[String]) -> KResult<PackageInfo> {
        // A copy deleted (in the trash, or gone) counts as none: it may be imported again, any printing.
        let live = self
            .read(|c| store::get(c, &pkg.root))?
            .is_some_and(|r| r.origin == ORIGIN_COPY);
        let current = if live {
            self.copy_info(Some(&pkg.root))?
        } else {
            None
        };
        let earlier = self.read(|c| store::get_any(c, &pkg.root))?;
        let publisher: Option<String> = self.read(|c| {
            c.query_row(
                "SELECT publisher FROM copies WHERE root_id = ?1",
                [&pkg.root],
                |r| r.get(0),
            )
            .optional()
        })?;
        // D487 §33 (K18): signed, or published before there were signatures; a copy follows its publisher's key.
        let known_key: Option<String> = self.read(|c| c.query_row("SELECT publisher_key FROM copies WHERE root_id = ?1", [&pkg.root], |r| r.get(0)).optional().map(Option::flatten))?;
        let signature = match (&pkg.publisher_key, &pkg.signature) {
            (Some(k), Some(s)) => crate::identity::verify(k, package_message(pkg, blobs).as_bytes(), s),
            (None, None) => true,
            _ => false,
        };
        let mine = self.identity()?.map(|i| i.public_key);
        let refused = if !signature {
            Some("badSignature")
        } else if pkg.publisher == self.ws.id || (pkg.publisher_key.is_some() && pkg.publisher_key == mine) {
            Some("ownPackage")
        } else if match (&known_key, &pkg.publisher_key) {
            (Some(k), Some(p)) => k != p,
            (Some(_), None) => true,
            _ => publisher.as_ref().is_some_and(|p| p != &pkg.publisher),
        } {
            Some("otherPublisher")
        } else if current
            .as_ref()
            .is_some_and(|c| (pkg.edition, pkg.printing) <= (c.edition, c.printing))
        {
            Some("notNewer")
        } else if current.is_none()
            && earlier.is_some_and(|r| {
                r.origin != ORIGIN_COPY || r.origin_ref.as_deref() != Some(pkg.root.as_str())
            })
        {
            Some("taken")
        } else {
            None
        };
        Ok(PackageInfo {
            title: pkg.title.clone(),
            publisher_name: pkg.publisher_name.clone(),
            edition: pkg.edition,
            printing: pkg.printing,
            variant: pkg.variant.clone(),
            published_at: pkg.published_at,
            resources: pkg.resources.len() as u32,
            update: current.is_some(),
            current,
            refused: refused.map(String::from),
            signature: Some(if pkg.signature.is_none() { "unsigned" } else if signature { "valid" } else { "invalid" }.into()),
            publisher_identity: pkg.publisher_key.as_ref().filter(|_| signature).map(|k| self.signed_by(k, &pkg.publisher_name)),
        })
    }

    pub(crate) async fn handle_packages(&self, m: &str, params: Value) -> KResult<Value> {
        let p: PackagePathParams =
            serde_json::from_value(params).map_err(|e| invalid_params(e.to_string()))?;
        let path = p.path.clone();
        let (pkg, blobs) = tokio::task::spawn_blocking({
            let me = self
                .me
                .upgrade()
                .ok_or_else(|| internal("kernel stopped"))?;
            move || me.read_package_file(&path)
        })
        .await
        .map_err(internal)??;
        if pkg.variant == "archive" {
            return Err(invalid("badPackage"));
        }
        let names: Vec<String> = blobs.iter().map(|(h, _)| h.clone()).collect();
        let info = self.package_info(&pkg, &names)?;
        if m == method5::PACKAGE_INSPECT {
            return serde_json::to_value(info).map_err(internal);
        }
        if let Some(why) = &info.refused {
            return Err(err_p(ErrorCode::Invalid, &[("reason", why)]));
        }
        // The images first (their rows go in with the rest).
        let mut infos = Vec::new();
        for (h, b) in &blobs {
            let i = crate::blobs::prepare(&self.ws.dir, b)?;
            if &i.blob == h {
                infos.push(i);
            }
        }
        let mut versions = HashMap::new();
        for r in &pkg.resources {
            let v = self.registry.kind(&r.kind).map(|(p, _)| p.version.clone());
            versions.insert(r.kind.clone(), v);
        }
        let sealed = pkg.sealed.clone();
        let root = pkg.root.clone();
        let publisher = (pkg.publisher_key.clone(), pkg.publisher_name.clone());
        let out = self
            .execute(
                Actor::User,
                Command::ImportPackage(Box::new(PackagePlan {
                    pkg,
                    versions,
                    blobs: infos,
                })),
            )
            .await?;
        // The withheld originals go to the keychain (rule 7); the database holds only their fingerprints.
        for s in &sealed {
            self.secret_set(&sealed_secret(&s.resource, &s.field), &s.value, false)
                .await?;
        }
        // D487 §33 (K18): the publisher goes into the contacts (not checked yet).
        if let (Some(key), name) = &publisher {
            self.contact_put(key, name, "", "package", None).await?;
        }
        let r = &out.report;
        serde_json::to_value(PackageImportResult {
            root,
            created: r["created"].as_u64().unwrap_or(0) as u32,
            updated: r["updated"].as_u64().unwrap_or(0) as u32,
            removed: r["removed"].as_u64().unwrap_or(0) as u32,
        })
        .map_err(internal)
    }

    /* ------------------------------------------------------------------ sealed */

    /// `host.sealed.check` / `host.sealed.open`, for the plugin's own resources.
    pub(crate) fn host_sealed(&self, plugin: &Plugin, op: &str, args: &Value) -> KResult<Value> {
        let id = args
            .get(0)
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_params("resource must be a string"))?;
        let field = args
            .get(1)
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_params("field must be a string"))?;
        let row = self
            .read(|c| store::get(c, id))?
            .ok_or_else(|| not_found("resource"))?;
        if crate::manifest::Registry::split(&row.kind).map(|(p, _)| p) != Some(plugin.id.as_str()) {
            return Err(denied("foreignKind"));
        }
        match op {
            "check" => {
                let text = args
                    .get(2)
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid_params("text must be a string"))?;
                let found: Option<(String, String)> = self.read(|c| {
                    c.query_row(
                        "SELECT salt, hashes FROM sealed WHERE resource_id = ?1 AND field = ?2",
                        [id, field],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                })?;
                Ok(match found {
                    None => Value::Null,
                    Some((salt, hashes)) => {
                        let list: Vec<String> = serde_json::from_str(&hashes).unwrap_or_default();
                        Value::Bool(list.contains(&fingerprint(&salt, id, field, text)))
                    }
                })
            }
            "open" => Ok(self
                .secret_value(&sealed_secret(id, field))?
                .map(Value::String)
                .unwrap_or(Value::Null)),
            _ => Err(err_p(
                ErrorCode::UnknownMethod,
                &[("method", &format!("sealed.{op}"))],
            )),
        }
    }
}

/// Method names this module answers.
pub const METHODS: &[&str] = &[method5::PACKAGE_INSPECT, method5::PACKAGE_IMPORT];

/// Whether `id` is a row of a read-only copy (and not its root).
fn in_copy(conn: &Connection, id: &str) -> KResult<Option<Row>> {
    Ok(store::get(conn, id)
        .map_err(crate::pipeline::db_err)?
        .filter(|r| r.origin == ORIGIN_COPY))
}

/// D487 §21 (K9): nothing writes inside a read-only copy but its import; the whole copy may be deleted (its root).
pub fn guard_copy(conn: &Connection, cmd: &Command) -> KResult<()> {
    let refuse = || Err(err_p(ErrorCode::Denied, &[("reason", "readOnlyCopy")]));
    let is_root = |r: &Row| r.origin_ref.as_deref() == Some(r.id.as_str());
    match cmd {
        Command::Update { id, .. } | Command::Params { id, .. } | Command::Restore { id, .. } => {
            if in_copy(conn, id)?.is_some() {
                return refuse();
            }
        }
        Command::Create(n) => {
            if let Some(p) = &n.parent {
                if in_copy(conn, p)?.is_some() {
                    return refuse();
                }
            }
        }
        Command::Move { id, dest } => {
            if in_copy(conn, id)?.is_some_and(|r| !is_root(&r)) {
                return refuse();
            }
            let target = match dest {
                crate::pipeline::MoveDest::Inside(Some(p)) => in_copy(conn, p)?,
                crate::pipeline::MoveDest::Before(t) | crate::pipeline::MoveDest::After(t) => {
                    in_copy(conn, t)?.filter(|r| !is_root(r))
                }
                _ => None,
            };
            if target.is_some() {
                return refuse();
            }
        }
        Command::Delete { id } if in_copy(conn, id)?.is_some_and(|r| !is_root(&r)) => return refuse(),
        _ => {}
    }
    Ok(())
}

impl Tx<'_> {
    /// D487 §21 (K9): a read-only copy made or brought up to date in one transaction — ids kept, everything below the
    /// root as the package says; what it no longer holds is deleted; the fingerprints of withheld fields replaced.
    pub(crate) fn import_package(&mut self, plan: PackagePlan) -> KResult<Outcome> {
        let pkg = plan.pkg;
        for b in &plan.blobs {
            self.tx
                .execute(
                    "INSERT INTO blobs (hash, type, size, width, height, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(hash) DO NOTHING",
                    params![b.blob, b.r#type, b.size as i64, b.width, b.height, self.at],
                )
                .map_err(crate::pipeline::db_err)?;
        }
        let before: Vec<Row> = {
            let mut st = self
                .tx
                .prepare(&format!(
                    "SELECT {} FROM resources WHERE origin = ?1 AND origin_ref = ?2",
                    store::COLUMNS
                ))
                .map_err(crate::pipeline::db_err)?;
            let v = st
                .query_map(params![ORIGIN_COPY, pkg.root], store::from_row)
                .map_err(crate::pipeline::db_err)?;
            v.collect::<Result<Vec<_>, _>>()
                .map_err(crate::pipeline::db_err)?
        };
        let old: HashMap<String, Row> = before.into_iter().map(|r| (r.id.clone(), r)).collect();
        let actor = self.actor.as_text();
        let (mut created, mut updated) = (0u32, 0u32);
        let mut rows = Vec::new();
        // Siblings in their order.
        let mut order: Vec<&PackRow> = pkg.resources.iter().collect();
        let index: HashMap<&str, usize> = pkg
            .resources
            .iter()
            .enumerate()
            .map(|(i, r)| (r.id.as_str(), i))
            .collect();
        order.sort_by_key(|r| {
            (
                r.parent
                    .as_ref()
                    .and_then(|p| index.get(p.as_str()).copied())
                    .map_or(0, |i| i + 1),
                r.pos,
            )
        });
        let mut placed: HashSet<String> = HashSet::new();
        let mut pending: Vec<&PackRow> = order;
        while !pending.is_empty() {
            let before_len = pending.len();
            let mut rest = Vec::new();
            for r in pending {
                if r.parent.as_ref().is_some_and(|p| !placed.contains(p)) {
                    rest.push(r);
                    continue;
                }
                let version = plan.versions.get(&r.kind).cloned().flatten();
                let tree = if r.kind == store::KIND_GROUP {
                    Some(TREE_RESOURCES.to_string())
                } else {
                    self.rules
                        .get(&r.kind)
                        .and_then(|k| k.tree.clone())
                        .or(Some(TREE_RESOURCES.to_string()))
                };
                match old.get(&r.id) {
                    Some(existing) => {
                        let mut row = existing.clone();
                        let mut changed = Vec::new();
                        if row.name != r.name {
                            row.name = r.name.clone();
                            changed.push("name".to_string());
                        }
                        if row.description != r.description {
                            row.description = r.description.clone();
                            changed.push("description".into());
                        }
                        if row.tags != r.tags {
                            row.tags = r.tags.clone();
                            changed.push("tags".into());
                        }
                        if row.body != r.body {
                            row.body = r.body.clone();
                            changed.push("body".into());
                        }
                        // The root stays where the reader put it (back at the end of the tree if it was deleted).
                        if row.deleted_at.is_some() {
                            row.deleted_at = None;
                            changed.push("deleted".into());
                            if r.parent.is_none() {
                                row.parent_id = None;
                                row.pos = self.next_pos(tree.as_deref(), None)?;
                            }
                        }
                        if r.parent.is_some() && (row.parent_id != r.parent || row.pos != r.pos) {
                            row.parent_id = r.parent.clone();
                            row.pos = r.pos;
                            changed.push("location".into());
                        }
                        placed.insert(r.id.clone());
                        updated += 1;
                        if changed.is_empty() {
                            continue;
                        }
                        row.rev += 1;
                        row.updated_at = self.at;
                        row.updated_by = actor.clone();
                        self.save(&row)?;
                        self.revision(&row, "import", &changed)?;
                        rows.push(row);
                    }
                    None => {
                        if store::get_any(self.tx, &r.id)
                            .map_err(crate::pipeline::db_err)?
                            .is_some()
                        {
                            return Err(invalid("taken"));
                        }
                        let pos = if r.parent.is_none() {
                            self.next_pos(tree.as_deref(), None)?
                        } else {
                            r.pos
                        };
                        let row = Row {
                            id: r.id.clone(),
                            kind: r.kind.clone(),
                            plugin_version: version,
                            tree,
                            parent_id: r.parent.clone(),
                            pos,
                            name: r.name.clone(),
                            description: r.description.clone(),
                            tags: r.tags.clone(),
                            body: r.body.clone(),
                            origin: ORIGIN_COPY.into(),
                            origin_ref: Some(pkg.root.clone()),
                            state: "ok".into(),
                            rev: 1,
                            created_at: self.at,
                            created_by: actor.clone(),
                            updated_at: self.at,
                            updated_by: actor.clone(),
                            deleted_at: None,
                            default_env: None,
                        };
                        self.insert(&row)?;
                        self.revision(&row, "import", &["*".to_string()])?;
                        placed.insert(r.id.clone());
                        created += 1;
                        rows.push(row);
                    }
                }
            }
            if rest.len() == before_len {
                return Err(invalid("badPackage"));
            }
            pending = rest;
        }
        // References and the files it uses, once every row is in.
        for row in &rows {
            self.refs_after(row, None)?;
            self.connect_name(row)?;
        }
        // What the new printing no longer holds goes (into the trash, as a deletion would).
        let keep: HashSet<&str> = pkg.resources.iter().map(|r| r.id.as_str()).collect();
        let mut removed = 0u32;
        for (id, r) in &old {
            if keep.contains(id.as_str()) || r.deleted_at.is_some() {
                continue;
            }
            let mut row = r.clone();
            row.deleted_at = Some(self.at);
            row.rev += 1;
            row.updated_at = self.at;
            row.updated_by = actor.clone();
            self.save(&row)?;
            self.revision(&row, "delete", &["deleted".to_string()])?;
            removed += 1;
        }
        let ids: Vec<&str> = pkg.resources.iter().map(|r| r.id.as_str()).collect();
        self.tx
            .execute(
                "DELETE FROM sealed WHERE resource_id IN (SELECT value FROM json_each(?1))",
                [serde_json::to_string(&ids).unwrap_or_default()],
            )
            .map_err(crate::pipeline::db_err)?;
        for s in &pkg.sealed {
            self.tx
                .execute(
                    "INSERT INTO sealed (resource_id, field, salt, hashes) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(resource_id, field) DO UPDATE SET salt = excluded.salt, hashes = excluded.hashes",
                    params![s.resource, s.field, s.salt, serde_json::to_string(&s.hashes).unwrap_or_default()],
                )
                .map_err(crate::pipeline::db_err)?;
        }
        self.tx
            .execute(
                "INSERT INTO copies (root_id, publisher, publisher_name, title, edition, printing, variant, published_at, imported_at, publisher_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                 ON CONFLICT(root_id) DO UPDATE SET publisher_name = excluded.publisher_name, title = excluded.title, edition = excluded.edition,
                 printing = excluded.printing, variant = excluded.variant, published_at = excluded.published_at, imported_at = excluded.imported_at,
                 publisher_key = COALESCE(excluded.publisher_key, copies.publisher_key)",
                params![pkg.root, pkg.publisher, pkg.publisher_name, pkg.title, pkg.edition, pkg.printing, pkg.variant, pkg.published_at, self.at, pkg.publisher_key],
            )
            .map_err(crate::pipeline::db_err)?;
        self.audit("package.import", &pkg.root, &json!({ "title": pkg.title, "edition": pkg.edition, "printing": pkg.printing, "variant": pkg.variant, "created": created, "updated": updated, "removed": removed }))?;
        Ok(Outcome {
            id: Some(pkg.root.clone()),
            changed: true,
            rows,
            report: json!({ "created": created, "updated": updated, "removed": removed }),
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zip_written_reads_back_and_others_are_refused() {
        let entries = vec![
            ("package.json".to_string(), b"{}".to_vec()),
            ("blobs/x".to_string(), vec![0, 1, 2, 255]),
        ];
        let z = zip_write(&entries);
        assert_eq!(zip_read(&z).unwrap(), entries);
        assert!(zip_read(b"not a zip at all, really not").is_err());
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn fingerprints_depend_on_salt_resource_field_and_text() {
        let a = fingerprint("s", "r", "f", "8");
        assert_eq!(a, fingerprint("s", "r", "f", "8"));
        assert_ne!(a, fingerprint("t", "r", "f", "8"));
        assert_ne!(a, fingerprint("s", "r", "f", "9"));
    }
}
