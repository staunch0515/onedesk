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

/// Why an address was not opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    /// The address itself is not allowed.
    Refused(BadUrl),
    /// The system's `open` could not be started or said no (the message is for the user's eyes and the log).
    System(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Refused(why) => write!(f, "badUrl:{why:?}"),
            OpenError::System(message) => write!(f, "openFailed:{message}"),
        }
    }
}

/// Runs `program` with the address as its one argument and waits for it (`open` returns as soon as it has handed the
/// address over). A program that cannot start, or exits with a failure, is an error the interface can show.
fn run_opener(program: &str, url: &str) -> Result<(), OpenError> {
    let status = Command::new(program)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| OpenError::System(e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(OpenError::System(format!("exit status {}", status.code().map_or_else(|| "signal".to_string(), |c| c.to_string()))))
    }
}

/// Asks the system to open the address with its default application. The address is checked here once more; it cannot
/// start with `-` (it must begin with `http`/`https`/`mailto`), so it is never read as an option.
pub fn open_external(url: &str) -> Result<(), OpenError> {
    let url = validate_external_url(url).map_err(OpenError::Refused)?;
    run_opener("/usr/bin/open", url)
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

    #[test]
    fn a_program_that_is_missing_or_fails_gives_an_error() {
        assert!(matches!(run_opener("/nonexistent/opener", "https://e.com"), Err(OpenError::System(_))));
        assert!(matches!(run_opener("/usr/bin/false", "https://e.com"), Err(OpenError::System(m)) if m.contains("exit status")));
        assert_eq!(run_opener("/usr/bin/true", "https://e.com"), Ok(()));
    }

    #[test]
    fn a_refused_address_never_reaches_the_system() {
        assert_eq!(open_external("javascript:alert(1)"), Err(OpenError::Refused(BadUrl::Scheme)));
        assert_eq!(open_external("-a"), Err(OpenError::Refused(BadUrl::Scheme)));
    }
}
