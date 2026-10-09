//! What this process holds, for the self-test's leak runs (`leakSample` in
//! src/selftest.ts): memory, threads, open files, and Kinema's own counts of
//! things it opens and should close again. A number that only ever climbs
//! across repeated plays is a leak; one that comes back down is not.
//!
//! Read-only and cheap. Fields the system cannot answer are null, never zero:
//! a zero would read as a measurement.

use serde::Serialize;

/// Kinema's own counts, from the parts that hold something open.
#[derive(Serialize, Default, Debug)]
pub struct Counts {
    /// Requests being answered on the film link (stream.rs).
    pub stream_connections: usize,
    /// Threads reading ahead from a share for one of those.
    pub stream_readers: usize,
    /// Films the link has an address for.
    pub stream_films: usize,
    /// Network servers held signed in (netshare.rs).
    pub netshare_servers: usize,
}

#[derive(Serialize, Default, Debug)]
pub struct Stats {
    pub rss_mb: Option<f64>,
    pub peak_rss_mb: Option<f64>,
    pub threads: Option<u64>,
    pub open_fds: Option<u64>,
    pub platform: &'static str,
    pub kinema: Counts,
}

/// What `/proc/<pid>/status` says about memory and threads.
#[derive(Debug, PartialEq, Default)]
#[cfg_attr(not(any(target_os = "linux", target_os = "android", test)), allow(dead_code))]
struct Status {
    rss_kb: Option<u64>,
    peak_kb: Option<u64>,
    threads: Option<u64>,
}

/// Pick `VmRSS`, `VmHWM` (the peak) and `Threads` out of a status file. The
/// lines are `Name:\t  1234 kB` (the threads line has no unit); anything
/// missing is None.
#[cfg_attr(not(any(target_os = "linux", target_os = "android", test)), allow(dead_code))]
fn parse_status(text: &str) -> Status {
    let mut out = Status::default();
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else { continue };
        let number = rest.split_whitespace().next().and_then(|n| n.parse::<u64>().ok());
        match key {
            "VmRSS" => out.rss_kb = number,
            "VmHWM" => out.peak_kb = number,
            "Threads" => out.threads = number,
            _ => {}
        }
    }
    out
}

fn mb(kb: u64) -> f64 {
    (kb as f64 / 1024.0 * 10.0).round() / 10.0
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_system(stats: &mut Stats) {
    if let Ok(text) = std::fs::read_to_string("/proc/self/status") {
        let s = parse_status(&text);
        stats.rss_mb = s.rss_kb.map(mb);
        stats.peak_rss_mb = s.peak_kb.map(mb);
        stats.threads = s.threads;
    }
    stats.open_fds = std::fs::read_dir("/proc/self/fd").ok().map(|d| d.count() as u64);
}

#[cfg(windows)]
fn read_system(stats: &mut Stats) {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, GetProcessHandleCount};
    use windows::Win32::Foundation::CloseHandle;

    // SAFETY: the calls only read about this process; each out-parameter is a
    // local of the size the call is told it has.
    unsafe {
        let me = GetCurrentProcess();
        let mut c = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        if GetProcessMemoryInfo(me, &mut c, c.cb).is_ok() {
            stats.rss_mb = Some(mb(c.WorkingSetSize as u64 / 1024));
            stats.peak_rss_mb = Some(mb(c.PeakWorkingSetSize as u64 / 1024));
        }
        let mut handles = 0u32;
        if GetProcessHandleCount(me, &mut handles).is_ok() {
            stats.open_fds = Some(handles as u64);
        }
        // Windows has no per-process thread count; count the system's threads
        // that belong to this process.
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) {
            let pid = GetCurrentProcessId();
            let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
            let mut n = 0u64;
            let mut more = Thread32First(snap, &mut entry).is_ok();
            while more {
                if entry.th32OwnerProcessID == pid {
                    n += 1;
                }
                more = Thread32Next(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
            stats.threads = Some(n);
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
fn read_system(_stats: &mut Stats) {}

pub fn read() -> Stats {
    let mut stats = Stats { platform: std::env::consts::OS, ..Default::default() };
    read_system(&mut stats);
    stats.kinema = Counts {
        netshare_servers: crate::netshare::server_count(),
        ..crate::stream::counts()
    };
    stats
}

/// Memory, threads and open files of this process, and Kinema's own counts.
#[tauri::command]
pub async fn process_stats() -> Result<Stats, String> {
    crate::jobs::off_main(|| Ok(read())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_is_read_as_the_kernel_writes_it() {
        let text = "Name:\tkinema\nVmPeak:\t  900000 kB\nVmHWM:\t  204800 kB\nVmRSS:\t  153600 kB\nThreads:\t42\nVoluntary_ctxt_switches:\t7\n";
        let s = parse_status(text);
        assert_eq!(s, Status { rss_kb: Some(153600), peak_kb: Some(204800), threads: Some(42) });
        assert_eq!(s.rss_kb.map(mb), Some(150.0));
    }

    #[test]
    fn a_status_without_the_lines_is_null_not_zero() {
        assert_eq!(parse_status("Name:\tkinema\nVmRSS: junk\n"), Status::default());
        assert_eq!(parse_status(""), Status::default());
    }

    #[test]
    fn this_process_reports_something_where_it_can() {
        let s = read();
        assert!(!s.platform.is_empty());
        if cfg!(any(target_os = "linux", target_os = "android", windows)) {
            assert!(s.rss_mb.is_some_and(|m| m > 0.0));
            assert!(s.threads.is_some_and(|t| t > 0));
        }
    }
}
