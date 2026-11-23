//! Small shared helpers: errors, ids, time.

use std::collections::BTreeMap;
use std::hash::{BuildHasher, Hasher};

use onedesk_protocol::{ErrorCode, ProtocolError};

pub type KResult<T> = Result<T, ProtocolError>;

pub fn err(code: ErrorCode) -> ProtocolError {
    ProtocolError { code, params: BTreeMap::new(), detail: None }
}

pub fn err_p(code: ErrorCode, params: &[(&str, &str)]) -> ProtocolError {
    ProtocolError {
        code,
        params: params.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        detail: None,
    }
}

pub fn err_d(code: ErrorCode, detail: impl Into<String>) -> ProtocolError {
    ProtocolError { code, params: BTreeMap::new(), detail: Some(detail.into()) }
}

/// Files a file system adds beside a package's own (AppleDouble `._*` from copying to exFAT/FAT or
/// a zip, Finder's `.DS_Store`): never part of a package, never read or copied.
pub fn is_junk_name(name: &std::ffi::OsStr) -> bool {
    let n = name.to_string_lossy();
    n.starts_with("._") || n == ".DS_Store"
}

pub fn internal(e: impl std::fmt::Display) -> ProtocolError {
    err_d(ErrorCode::Internal, e.to_string())
}

pub fn invalid(reason: &str) -> ProtocolError {
    err_p(ErrorCode::Invalid, &[("reason", reason)])
}

pub fn invalid_params(detail: impl Into<String>) -> ProtocolError {
    err_d(ErrorCode::InvalidParams, detail)
}

pub fn not_found(what: &str) -> ProtocolError {
    err_p(ErrorCode::NotFound, &[("what", what)])
}

pub fn denied(reason: &str) -> ProtocolError {
    err_p(ErrorCode::Denied, &[("reason", reason)])
}

/// D368: `denied/outsideGrant` names the path the call gave (as given, at most 200 characters).
pub fn outside_grant(path: &str) -> ProtocolError {
    let shown: String = path.chars().take(200).collect();
    err_p(ErrorCode::Denied, &[("reason", "outsideGrant"), ("path", &shown)])
}

/// Milliseconds since the epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 64 random bits from the standard library's randomly keyed hasher (no extra dependency).
fn random_u64() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.write_u32(std::process::id());
    h.finish()
}

/// 128-bit random id as 32 lowercase hex digits.
pub fn new_id() -> String {
    format!("{:016x}{:016x}", random_u64(), random_u64())
}

/// Content fingerprint used as an opaque `basis` (not cryptographic; detects changes).
pub fn fingerprint(bytes: &[u8]) -> String {
    // FNV-1a 64, stable across processes (unlike the std hasher).
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:016x}-{}", h, bytes.len())
}

/// D359: the fingerprint the user confirms (install and import): SHA-256, lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_hex() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn fingerprint_changes_with_content() {
        assert_eq!(fingerprint(b"abc"), fingerprint(b"abc"));
        assert_ne!(fingerprint(b"abc"), fingerprint(b"abd"));
    }

    #[test]
    fn sha256_known_vector() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
