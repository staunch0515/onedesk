//! D487 §33 (docs/redesign/book.md, K18): a workspace's identity and its contacts. The identity is an Ed25519 key pair:
//! the private key is only in the keychain (rule 7), the public half and the name are in the `identity` table. Stamps
//! (K6) and published packages (K9) are signed with it; others verify them with the public key from an identity card
//! (`.odid`) kept in the contacts (`core:contact`, the kernel's tree `contacts`), checked by comparing fingerprints the
//! way one compares a signature with the specimen kept at the bank. The kernel knows no book, no document.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use onedesk_protocol::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::kernel::Inner;
use crate::pipeline::{Actor, Changes, Command, NewResource};
use crate::store::{self, Row};
use crate::util::*;

/// Longest name and organisation (characters).
pub const MAX_NAME: usize = 100;
/// The format of an identity card.
pub const CARD_FORMAT: u32 = 1;
/// Largest identity card file read.
const MAX_CARD_BYTES: u64 = 64 * 1024;

pub const METHODS: &[&str] = &[
    method5::IDENTITY_GET,
    method5::IDENTITY_CREATE,
    method5::IDENTITY_UPDATE,
    method5::IDENTITY_DELETE,
    method5::IDENTITY_EXPORT_CARD,
    method5::CONTACT_IMPORT_CARD,
    method5::CONTACT_SET_CHECKED,
    method5::CONTACT_EXPORT_CARD,
];

/* ------------------------------------------------------------------ keys */

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn key_of(public_key: &str) -> Option<VerifyingKey> {
    let b: [u8; 32] = unhex(public_key)?.try_into().ok()?;
    VerifyingKey::from_bytes(&b).ok()
}

/// A public key's fingerprint: the first 16 bytes of its SHA-256, in 8 groups of 4 upper-case hex digits.
pub fn fingerprint(public_key: &str) -> Option<String> {
    let b = unhex(public_key)?;
    if b.len() != 32 {
        return None;
    }
    let h = hex(&Sha256::digest(&b)[..16]).to_uppercase();
    Some(h.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" "))
}

/// Whether `signature` (hex) is `public_key`'s (hex) signature of `message`.
pub fn verify(public_key: &str, message: &[u8], signature: &str) -> bool {
    let (Some(k), Some(sig)) = (key_of(public_key), unhex(signature).and_then(|b| <[u8; 64]>::try_from(b).ok())) else { return false };
    k.verify(message, &Signature::from_bytes(&sig)).is_ok()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

/// What an identity card's signature covers.
fn card_message(name: &str, org: &str, public_key: &str, created_at: i64) -> String {
    format!("onedesk-card/1\n{name}\n{org}\n{public_key}\n{created_at}")
}

/// An identity card (`.odid`): who, their public key, signed by itself (so it was not changed on the way).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub format: u32,
    pub name: String,
    #[serde(default)]
    pub org: String,
    pub public_key: String,
    pub fingerprint: String,
    pub created_at: i64,
    pub signature: String,
}

fn clean(s: &str, what: &str, required: bool) -> KResult<String> {
    let t = s.trim().to_string();
    if required && t.is_empty() {
        return Err(invalid_params(what));
    }
    if t.chars().count() > MAX_NAME {
        return Err(invalid_params(format!("{what} is too long")));
    }
    Ok(t)
}

/* ------------------------------------------------------------------ the pipeline's checks */

fn contact_with(conn: &Connection, fp: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM resources WHERE kind = ?1 AND deleted_at IS NULL AND json_extract(body, '$.fingerprint') = ?2",
        params![store::KIND_CONTACT, fp],
        |r| r.get(0),
    )
    .optional()
}

/// A contact is made with a public key and its own fingerprint, one per fingerprint; neither ever changes.
pub fn guard(conn: &Connection, cmd: &crate::pipeline::Command) -> KResult<()> {
    use crate::pipeline::Command as C;
    let bad = || Err(err_p(ErrorCode::Invalid, &[("reason", "badContact")]));
    match cmd {
        C::Create(n) if n.kind == store::KIND_CONTACT => {
            let pk = n.body.get("publicKey").and_then(Value::as_str).unwrap_or_default();
            let fp = n.body.get("fingerprint").and_then(Value::as_str).unwrap_or_default();
            if key_of(pk).is_none() || fingerprint(pk).as_deref() != Some(fp) {
                return bad();
            }
            if contact_with(conn, fp).map_err(crate::pipeline::db_err)?.is_some() {
                return Err(err_p(ErrorCode::Conflict, &[("reason", "exists")]));
            }
            Ok(())
        }
        C::Update { id, changes, .. } if changes.body.contains_key("publicKey") || changes.body.contains_key("fingerprint") => {
            let kind: Option<String> = conn.query_row("SELECT kind FROM resources WHERE id = ?1", [id], |r| r.get(0)).optional().map_err(crate::pipeline::db_err)?;
            if kind.as_deref() == Some(store::KIND_CONTACT) {
                return bad();
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// The identity row (`None`: removes it).
pub fn write_identity(conn: &Connection, id: Option<&IdentityInfo>) -> rusqlite::Result<()> {
    match id {
        Some(i) => conn.execute(
            "INSERT INTO identity (id, name, org, public_key, created_at) VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, org = excluded.org, public_key = excluded.public_key, created_at = excluded.created_at",
            params![i.name, i.org, i.public_key, i.created_at],
        )?,
        None => conn.execute("DELETE FROM identity", [])?,
    };
    Ok(())
}

pub fn read_identity(conn: &Connection) -> rusqlite::Result<Option<IdentityInfo>> {
    conn.query_row("SELECT name, org, public_key, created_at FROM identity WHERE id = 1", [], |r| {
        let pk: String = r.get(2)?;
        Ok(IdentityInfo { name: r.get(0)?, org: r.get(1)?, fingerprint: fingerprint(&pk).unwrap_or_default(), public_key: pk, created_at: r.get(3)? })
    })
    .optional()
}

impl Inner {
    /// The keychain account of the private key: no secret name can make it (names have no `#`), so no plugin reaches it.
    fn key_account(&self) -> String {
        format!("{}/#identity", self.ws.id)
    }

    pub(crate) fn identity(&self) -> KResult<Option<IdentityInfo>> {
        self.read(read_identity)
    }

    fn signing_key(&self) -> KResult<Option<(IdentityInfo, SigningKey)>> {
        let Some(id) = self.identity()? else { return Ok(None) };
        let Some(seed) = self.cfg.secrets.0.get(&self.key_account()).map_err(|e| err_d(ErrorCode::Internal, e))? else { return Ok(None) };
        let Some(b) = unhex(&seed).and_then(|b| <[u8; 32]>::try_from(b).ok()) else { return Ok(None) };
        let key = SigningKey::from_bytes(&b);
        if hex(key.verifying_key().as_bytes()) != id.public_key {
            return Ok(None);
        }
        Ok(Some((id, key)))
    }

    /// Signs `message` with this workspace's identity: `(identity, signature hex)`; `None` without one.
    pub(crate) fn sign(&self, message: &[u8]) -> KResult<Option<(IdentityInfo, String)>> {
        Ok(self.signing_key()?.map(|(id, k)| (id, hex(&k.sign(message).to_bytes()))))
    }

    /// Who a public key is, as this workspace knows it.
    pub(crate) fn signed_by(&self, public_key: &str, name: &str) -> SignedBy {
        let fp = fingerprint(public_key).unwrap_or_default();
        let mine = self.identity().ok().flatten().is_some_and(|i| i.public_key == public_key);
        let known = if mine {
            "self".to_string()
        } else {
            match self.read(|c| contact_with(c, &fp)).ok().flatten().and_then(|id| self.read(|c| store::get(c, &id)).ok().flatten()) {
                Some(r) if r.body.get("checked").and_then(Value::as_bool) == Some(true) => "checked".into(),
                Some(_) => "unchecked".into(),
                None => "unknown".into(),
            }
        };
        SignedBy { name: name.to_string(), fingerprint: fp, known }
    }

    /* ------------------------------------------------------------------ RPCs */

    pub(crate) async fn handle_identity(&self, m: &str, params: Value) -> KResult<Value> {
        fn to<T: Serialize>(v: T) -> KResult<Value> {
            serde_json::to_value(v).map_err(internal)
        }
        match m {
            method5::IDENTITY_GET => to(self.identity()?),
            method5::IDENTITY_CREATE => {
                let p: IdentityParams = crate::kernel::parse(params)?;
                to(Some(self.identity_create(p).await?))
            }
            method5::IDENTITY_UPDATE => {
                let p: IdentityParams = crate::kernel::parse(params)?;
                to(Some(self.identity_update(p).await?))
            }
            method5::IDENTITY_DELETE => {
                self.identity_delete().await?;
                Ok(Value::Null)
            }
            method5::IDENTITY_EXPORT_CARD => {
                let p: CardPathParams = crate::kernel::parse(params)?;
                let card = self.own_card()?.ok_or_else(|| invalid("noIdentity"))?;
                write_card(&p.path, &card)?;
                Ok(Value::Null)
            }
            method5::CONTACT_IMPORT_CARD => {
                let p: CardPathParams = crate::kernel::parse(params)?;
                to(self.contact_import(&p.path).await?)
            }
            method5::CONTACT_SET_CHECKED => {
                let p: ContactCheckedParams = crate::kernel::parse(params)?;
                let row = self.contact_row(&p.id)?;
                let changes = Changes { body: [("checked".to_string(), json!(p.checked))].into_iter().collect(), ..Default::default() };
                self.execute(Actor::User, Command::Update { id: row.id, changes, basis: None, overwrite: vec![] }).await?;
                Ok(Value::Null)
            }
            method5::CONTACT_EXPORT_CARD => {
                let p: ContactCardParams = crate::kernel::parse(params)?;
                let row = self.contact_row(&p.id)?;
                let card = row.body.get("card").cloned().and_then(|c| serde_json::from_value::<Card>(c).ok()).ok_or_else(|| invalid("noCard"))?;
                write_card(&p.path, &card)?;
                Ok(Value::Null)
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", m)])),
        }
    }

    async fn identity_create(&self, p: IdentityParams) -> KResult<IdentityInfo> {
        if self.identity()?.is_some() {
            return Err(err_p(ErrorCode::Conflict, &[("reason", "exists")]));
        }
        let name = clean(p.name.as_deref().unwrap_or(""), "name", true)?;
        let org = clean(p.org.as_deref().unwrap_or(""), "org", false)?;
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| err_d(ErrorCode::Internal, e.to_string()))?;
        let key = SigningKey::from_bytes(&seed);
        let public_key = hex(key.verifying_key().as_bytes());
        // The private key first: a row without its key would sign nothing.
        self.cfg.secrets.0.set(&self.key_account(), &hex(&seed)).map_err(|e| err_d(ErrorCode::Internal, e))?;
        let info = IdentityInfo { name, org, fingerprint: fingerprint(&public_key).unwrap_or_default(), public_key, created_at: now_ms() };
        self.execute(Actor::User, Command::Identity { info: Some(info.clone()), op: "identity.create".into() }).await?;
        Ok(info)
    }

    async fn identity_update(&self, p: IdentityParams) -> KResult<IdentityInfo> {
        let mut info = self.identity()?.ok_or_else(|| invalid("noIdentity"))?;
        if let Some(n) = &p.name {
            info.name = clean(n, "name", true)?;
        }
        if let Some(o) = &p.org {
            info.org = clean(o, "org", false)?;
        }
        self.execute(Actor::User, Command::Identity { info: Some(info.clone()), op: "identity.update".into() }).await?;
        Ok(info)
    }

    async fn identity_delete(&self) -> KResult<()> {
        if self.identity()?.is_none() {
            return Ok(());
        }
        self.execute(Actor::User, Command::Identity { info: None, op: "identity.delete".into() }).await?;
        self.cfg.secrets.0.delete(&self.key_account()).map_err(|e| err_d(ErrorCode::Internal, e))?;
        Ok(())
    }

    /// This workspace's card, signed by itself.
    fn own_card(&self) -> KResult<Option<Card>> {
        let Some((id, key)) = self.signing_key()? else { return Ok(None) };
        let sig = hex(&key.sign(card_message(&id.name, &id.org, &id.public_key, id.created_at).as_bytes()).to_bytes());
        Ok(Some(Card { format: CARD_FORMAT, name: id.name, org: id.org, fingerprint: id.fingerprint, public_key: id.public_key, created_at: id.created_at, signature: sig }))
    }

    fn contact_row(&self, id: &str) -> KResult<Row> {
        self.read(|c| store::get(c, id))?.filter(|r| r.kind == store::KIND_CONTACT).ok_or_else(|| not_found("contact"))
    }

    /// An identity card into the contacts: checked against its own signature; one contact per fingerprint (a newer card
    /// of the same key brings its name; whether it was checked stays).
    async fn contact_import(&self, path: &str) -> KResult<ContactImportResult> {
        let meta = std::fs::metadata(path).map_err(|_| not_found("file"))?;
        if !meta.is_file() || meta.len() > MAX_CARD_BYTES {
            return Err(invalid("badCard"));
        }
        let card: Card = serde_json::from_slice(&std::fs::read(path).map_err(|_| not_found("file"))?).map_err(|_| invalid("badCard"))?;
        let ok = card.format == CARD_FORMAT
            && fingerprint(&card.public_key).as_deref() == Some(card.fingerprint.as_str())
            && verify(&card.public_key, card_message(&card.name, &card.org, &card.public_key, card.created_at).as_bytes(), &card.signature)
            && !card.name.trim().is_empty()
            && card.name.chars().count() <= MAX_NAME
            && card.org.chars().count() <= MAX_NAME;
        if !ok {
            return Err(invalid("badCard"));
        }
        if self.identity()?.is_some_and(|i| i.public_key == card.public_key) {
            return Err(invalid("ownCard"));
        }
        self.contact_put(&card.public_key, &card.name, &card.org, "card", Some(&card)).await
    }

    /// Adds (or updates) the contact of a public key; `source`: `card`, `package`.
    pub(crate) async fn contact_put(&self, public_key: &str, name: &str, org: &str, source: &str, card: Option<&Card>) -> KResult<ContactImportResult> {
        let fp = fingerprint(public_key).ok_or_else(|| invalid("badCard"))?;
        if let Some(id) = self.read(|c| contact_with(c, &fp))? {
            // Only a card brings a new name (a package says only who published it).
            if let Some(card) = card {
                let mut body: JsonMap = Default::default();
                body.insert("org".into(), json!(card.org));
                body.insert("card".into(), serde_json::to_value(card).map_err(internal)?);
                let changes = Changes { name: Some(card.name.clone()), body, ..Default::default() };
                self.execute(Actor::User, Command::Update { id: id.clone(), changes, basis: None, overwrite: vec![] }).await?;
            }
            return Ok(ContactImportResult { id, created: false });
        }
        let mut body = JsonMap::new();
        body.insert("publicKey".into(), json!(public_key));
        body.insert("fingerprint".into(), json!(fp));
        body.insert("org".into(), json!(org));
        body.insert("checked".into(), json!(false));
        body.insert("source".into(), json!(source));
        if let Some(c) = card {
            body.insert("card".into(), serde_json::to_value(c).map_err(internal)?);
        }
        let n = NewResource { kind: store::KIND_CONTACT.into(), tree: None, parent: None, name: name.trim().chars().take(MAX_NAME).collect(), description: String::new(), tags: vec![], body, plugin_version: None };
        let out = self.execute(Actor::User, Command::Create(n)).await?;
        Ok(ContactImportResult { id: out.id.ok_or_else(|| internal("no id"))?, created: true })
    }
}

fn write_card(path: &str, card: &Card) -> KResult<()> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err(invalid_params("path"));
    }
    std::fs::write(p, serde_json::to_vec_pretty(card).map_err(internal)?).map_err(|e| err_d(ErrorCode::Internal, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_fingerprints_and_signatures() {
        let k = SigningKey::from_bytes(&[7u8; 32]);
        let pk = hex(k.verifying_key().as_bytes());
        let fp = fingerprint(&pk).unwrap();
        assert_eq!(fp.split(' ').count(), 8);
        assert!(fp.split(' ').all(|g| g.len() == 4 && g.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase())));
        let sig = hex(&k.sign(b"hello").to_bytes());
        assert!(verify(&pk, b"hello", &sig));
        assert!(!verify(&pk, b"hellO", &sig));
        assert!(!verify(&pk, b"hello", "00"));
        assert!(!verify("zz", b"hello", &sig));
        assert_eq!(unhex(&hex(&[1, 2, 255])), Some(vec![1, 2, 255]));
        assert_eq!(fingerprint("abc"), None);
    }
}
