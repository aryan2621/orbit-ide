//! Every long-lived child process (builds, language servers, emulators…) runs in its own process
//! group and is recorded here, so cancelling kills its whole tree and quitting Orbit leaves nothing
//! behind.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

fn groups() -> &'static Mutex<HashSet<i32>> {
    static GROUPS: OnceLock<Mutex<HashSet<i32>>> = OnceLock::new();
    GROUPS.get_or_init(Default::default)
}

/// Makes the command start a new process group (its pid becomes the group id).
pub fn own_group(cmd: &mut tokio::process::Command) {
    #[cfg(unix)]
    cmd.process_group(0);
}

/// Same as [`own_group`] for std commands.
pub fn own_group_std(cmd: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}

/// Records a process group leader so it's killed when Orbit quits.
pub fn track(pid: Option<u32>) {
    if let Some(pid) = pid {
        crate::process::lock(groups()).insert(pid as i32);
    }
}

pub fn untrack(pid: Option<u32>) {
    if let Some(pid) = pid {
        crate::process::lock(groups()).remove(&(pid as i32));
    }
}

/// Sends `signal` to the whole process group led by `pid`.
pub fn signal_group(pid: u32, signal: i32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

/// Kills every tracked process group. Called once, on exit; blocks briefly for a clean shutdown.
pub fn kill_all() {
    let pids: Vec<i32> = crate::process::lock(groups()).drain().collect();
    if pids.is_empty() {
        return;
    }
    for &pid in &pids {
        signal_group(pid as u32, libc::SIGTERM);
    }
    std::thread::sleep(Duration::from_millis(300));
    for &pid in &pids {
        signal_group(pid as u32, libc::SIGKILL);
    }
}
