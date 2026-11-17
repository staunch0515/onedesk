//! Opening a link in the system browser (round 11, D380). The kernel and the interface both check the
//! protocol; the main process checks once more, because this is where the system is actually asked.

use std::process::{Command, Stdio};

/// Longest address the shell passes on (same bound as the kernel's `ui.openExternal`).
pub const MAX_URL_LEN: usize = 2048;

/// Only these protocols leave the application.
const ALLOWED_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// Why an address is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadUrl {
    TooLong,
    Empty,
    /// Control characters or spaces, which no command line should receive as part of an address.
    Unclean,
    Scheme,
}

/// The address as it may be handed to the system, or the reason it may not.
pub fn validate_external_url(url: &str) -> Result<&str, BadUrl> {
    if url.is_empty() {
        return Err(BadUrl::Empty);
    }
    if url.len() > MAX_URL_LEN {
        return Err(BadUrl::TooLong);
    }
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(BadUrl::Unclean);
    }
    let Some((scheme, rest)) = url.split_once(':') else { return Err(BadUrl::Scheme) };
    let scheme = scheme.to_ascii_lowercase();
    if !ALLOWED_SCHEMES.contains(&scheme.as_str()) || rest.is_empty() {
        return Err(BadUrl::Scheme);
    }
    // `http:` and `https:` need a host.
    if scheme != "mailto" && !rest.starts_with("//") {
        return Err(BadUrl::Scheme);
    }
    Ok(url)
}

/// Asks the system to open the address with its default application. Returns at once.
pub fn open_external(url: &str) -> Result<(), BadUrl> {
    let url = validate_external_url(url)?;
    // `--` keeps an address that starts with `-` from being read as an option (it cannot, after the check above, but cheap).
    let _ = Command::new("/usr/bin/open").arg("--").arg(url).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_web_and_mail() {
        assert!(validate_external_url("https://example.com/a?b=1").is_ok());
        assert!(validate_external_url("HTTP://example.com").is_ok());
        assert!(validate_external_url("mailto:a@b.c").is_ok());
    }

    #[test]
    fn refuses_other_protocols_and_shapes() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ftp://x", "onedesk://x", "example.com", "", "http:", "http:example.com", "https://a b", "https://a\nb", "-a"] {
            assert!(validate_external_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn refuses_long_addresses() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(validate_external_url(&long), Err(BadUrl::TooLong));
        let ok = format!("https://e.com/{}", "a".repeat(MAX_URL_LEN - 14));
        assert_eq!(ok.len(), MAX_URL_LEN);
        assert!(validate_external_url(&ok).is_ok());
    }
}
