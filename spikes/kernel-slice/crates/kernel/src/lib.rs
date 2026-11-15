pub mod kernel;
pub mod sandbox;
pub mod transport;

use std::fs::File;
use std::path::Path;
use std::time::Duration;

/// Takes the exclusive advisory lock (flock) on `<workspace>/workspace.lock`.
/// `Ok(None)` means another process holds it.
pub fn lock_workspace(workspace: &Path) -> std::io::Result<Option<File>> {
    let f = File::options().create(true).truncate(false).write(true).open(workspace.join("workspace.lock"))?;
    match f.try_lock() {
        Ok(()) => Ok(Some(f)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

/// Spike-only knobs so tests can use short limits in both transports.
pub fn config_from_env() -> sandbox::SandboxConfig {
    let ms = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<u64>().ok()).map(Duration::from_millis);
    let mut c = sandbox::SandboxConfig::default();
    if let Some(d) = ms("KS_SYNC_SLICE_MS") {
        c.sync_slice = d;
    }
    if let Some(d) = ms("KS_CALL_TIMEOUT_MS") {
        c.call_timeout = d;
    }
    c
}
