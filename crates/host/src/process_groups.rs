//! Leftover external programs (D340). The worker records the process group of every program it starts in
//! `<workspace>/process-groups` (one line `<pgid> <start_sec> <start_usec>`; written by the kernel, format fixed in
//! `docs/handoff/round6-kernel-done.md`). When the worker is gone — however it went — the main process ends the groups
//! that are still ours, so a killed worker never leaves orphans. The host does not link the kernel, so the few lines
//! of the kernel's `cleanup_recorded` are repeated here.

use std::path::Path;

/// File name inside the workspace folder.
pub const PROCESS_GROUPS_FILE: &str = "process-groups";

/// Start time of a process as the system reports it; `None` when there is no such process.
pub fn start_time(pid: i32) -> Option<(i64, i64)> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    // SAFETY: the buffer is a properly sized, zeroed `proc_bsdinfo`.
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    (n == size).then_some((info.pbi_start_tvsec as i64, info.pbi_start_tvusec as i64))
}

fn group_exists(pg: i32) -> bool {
    // SAFETY: signal 0 only checks.
    unsafe { libc::killpg(pg, 0) == 0 || *libc::__error() == libc::EPERM }
}

/// Ends the recorded groups that are still ours with SIGKILL, then removes the file. Returns how many were ended.
/// A group is ours when it exists and its leader is gone (a group id cannot be reused while the group exists) or the
/// leader's start time is the recorded one; with another start time the number was reused and is left alone.
pub fn cleanup_recorded(workspace: &Path) -> usize {
    let path = workspace.join(PROCESS_GROUPS_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else { return 0 };
    let mut ended = 0;
    for line in text.lines() {
        let f: Vec<i64> = line.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        let [pg, sec, usec] = f[..] else { continue };
        let Ok(pg) = i32::try_from(pg) else { continue };
        if pg <= 1 || !group_exists(pg) {
            continue;
        }
        let ours = match start_time(pg) {
            None => true,
            Some(t) => t == (sec, usec),
        };
        if ours {
            // SAFETY: plain system call; the group is the recorded one (checked above).
            unsafe { libc::killpg(pg, libc::SIGKILL) };
            ended += 1;
        }
    }
    let _ = std::fs::remove_file(&path);
    ended
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};

    fn sleeper() -> Child {
        // Its own process group, like a program the worker starts.
        Command::new("/bin/sleep").arg("100").process_group(0).spawn().expect("sleep")
    }

    fn record(dir: &Path, child: &Child, shift: i64) {
        let pid = child.id() as i32;
        let (s, u) = start_time(pid).expect("start time");
        std::fs::write(dir.join(PROCESS_GROUPS_FILE), format!("{pid} {} {u}\n", s + shift)).unwrap();
    }

    #[test]
    fn ends_a_recorded_group_and_empties_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = sleeper();
        record(dir.path(), &child, 0);
        assert_eq!(cleanup_recorded(dir.path()), 1);
        let status = child.wait().unwrap();
        assert!(!status.success());
        assert!(!dir.path().join(PROCESS_GROUPS_FILE).exists());
    }

    #[test]
    fn leaves_a_reused_number_alone() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = sleeper();
        record(dir.path(), &child, 5);
        assert_eq!(cleanup_recorded(dir.path()), 0);
        assert!(child.try_wait().unwrap().is_none(), "another process with that number must survive");
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!dir.path().join(PROCESS_GROUPS_FILE).exists());
    }

    #[test]
    fn ends_a_group_whose_leader_is_gone_but_members_remain() {
        let dir = tempfile::tempdir().unwrap();
        // The leader starts a background member and exits at once.
        let mut leader = Command::new("/bin/sh").args(["-c", "/bin/sleep 100 >/dev/null 2>&1 & echo $!"]).process_group(0).stdout(std::process::Stdio::piped()).spawn().unwrap();
        let pg = leader.id() as i32;
        let mut out = String::new();
        std::io::Read::read_to_string(leader.stdout.as_mut().unwrap(), &mut out).unwrap();
        let member: i32 = out.trim().parse().unwrap();
        leader.wait().unwrap();
        std::fs::write(dir.path().join(PROCESS_GROUPS_FILE), format!("{pg} 1 1\n")).unwrap();
        assert_eq!(cleanup_recorded(dir.path()), 1);
        std::thread::sleep(std::time::Duration::from_millis(200));
        // SAFETY: signal 0 only checks that the member is gone.
        assert_ne!(unsafe { libc::kill(member, 0) }, 0, "the member must have been ended");
    }

    #[test]
    fn missing_file_or_garbage_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(cleanup_recorded(dir.path()), 0);
        std::fs::write(dir.path().join(PROCESS_GROUPS_FILE), "x y z\n0 0 0\n1 1 1\n").unwrap();
        assert_eq!(cleanup_recorded(dir.path()), 0);
    }
}
