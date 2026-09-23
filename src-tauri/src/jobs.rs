//! Keeping slow work away from the window.
//!
//! **A Tauri command without `async` runs on the main thread** — the thread
//! that owns the window. While it runs, the window cannot repaint, move or
//! answer a key, and every other command waits behind it. For a database read
//! that is microseconds and does not matter. For anything that touches a disk
//! the app does not own, it does: a NAS that has spun down takes seconds to
//! answer its first `stat`, and until it does the whole app is frozen, looking
//! exactly like a crash.
//!
//! The rule, then: **a command that touches the file system outside app data,
//! or starts a program, is `async` and does that work through [`off_main`].**
//! Quick database commands stay synchronous on purpose — the main thread also
//! gives them a guaranteed order, and a `save_progress` overtaken by the
//! `continue_watching` that follows it would be a silently stale Home screen.

/// Run blocking work on the blocking pool and wait for it without holding the
/// main thread.
pub async fn off_main<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

// ---- one of each at a time ---------------------------------------------------

use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The long jobs, and which of them are running.
///
/// Each one used to be startable any number of times at once, and something
/// usually did start it twice: the launch scan ends by caching artwork while
/// Home caches artwork on mount; the scan ends by detecting while the Detect
/// button in Settings detects. Nothing failed. Two Skiptros scanned the same
/// folder, two ffmpegs read the same season, the same posters downloaded
/// twice — minutes of doubled work that looked like a slow machine.
///
/// What a second request gets depends on the job:
///
/// * **Scan** — refused. Both walks would find the same thing.
/// * **Detect** — refused, with a sentence saying so. Whichever pass is
///   running covers what the other would have done; the automatic one skips,
///   and the button says detection is already running rather than queueing
///   minutes of work behind it.
/// * **Artwork** — waits its turn, then runs. Not refused: the second caller
///   may know URLs the first did not (the details pass finds logos and cast
///   photos), and a refusal would leave those to the next launch. A run after
///   another finds almost nothing left to do, so waiting costs little.
///
/// **Detection can be stopped** ([`Jobs::stop_detection`]): it is minutes of
/// subprocess work, started by itself after a scan. The analysis checks
/// between files, and a running Skiptro is killed outright — which is also
/// what happens when the app closes, because Windows does not end a child
/// process with its parent and a Skiptro left scanning after the window has
/// gone is invisible to everyone.
#[derive(Default)]
pub struct Jobs {
    scan: Arc<AtomicBool>,
    detect: Arc<AtomicBool>,
    pub artwork: tauri::async_runtime::Mutex<()>,
    stop_detect: AtomicBool,
    /// The Skiptro process running right now, so Stop can end it.
    child: Mutex<Option<Arc<Mutex<Child>>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Job {
    Scan,
    Detect,
}

/// Proof that a job is running. The job is finished when this is dropped —
/// including by an early return or a panic, so a failed run cannot leave the
/// job marked busy for the rest of the session.
#[must_use]
pub struct Running(Arc<AtomicBool>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Jobs {
    fn flag(&self, job: Job) -> &Arc<AtomicBool> {
        match job {
            Job::Scan => &self.scan,
            Job::Detect => &self.detect,
        }
    }

    /// Start `job` unless it is already running.
    pub fn try_start(&self, job: Job) -> Option<Running> {
        let flag = self.flag(job);
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        if job == Job::Detect {
            // A Stop pressed for the previous run must not end this one.
            self.stop_detect.store(false, Ordering::SeqCst);
        }
        Some(Running(flag.clone()))
    }

    /// Ask the running detection to stop: the analysis at its next file, and a
    /// running Skiptro now. Does nothing when no detection is running, so a
    /// late press cannot stop the next one before it starts.
    pub fn stop_detection(&self) {
        if !self.detect.load(Ordering::SeqCst) {
            return;
        }
        self.stop_detect.store(true, Ordering::SeqCst);
        self.kill_child();
    }

    /// Whether the running detection has been asked to stop.
    pub fn detection_stopped(&self) -> bool {
        self.stop_detect.load(Ordering::SeqCst)
    }

    /// The flag itself, for work that checks it without knowing about jobs.
    pub fn detection_stop_flag(&self) -> &AtomicBool {
        &self.stop_detect
    }

    /// Register the Skiptro process now running, so Stop can end it. A Stop
    /// that arrived just before this is honoured here.
    pub fn watch_child(&self, child: Arc<Mutex<Child>>) {
        *self.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
        if self.detection_stopped() {
            self.kill_child();
        }
    }

    pub fn forget_child(&self) {
        *self.child.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn kill_child(&self) {
        let slot = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = slot.as_ref() {
            let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
        }
    }
}

/// Tauri command: stop the detection that is running, if any.
#[tauri::command]
pub fn stop_detection(jobs: tauri::State<Jobs>) {
    jobs.stop_detection();
}

#[cfg(test)]
mod tests {
    use super::{Job, Jobs};

    #[test]
    fn a_job_cannot_start_twice() {
        let jobs = Jobs::default();
        let first = jobs.try_start(Job::Detect);
        assert!(first.is_some());
        assert!(jobs.try_start(Job::Detect).is_none());
    }

    #[test]
    fn finishing_frees_the_job() {
        let jobs = Jobs::default();
        drop(jobs.try_start(Job::Detect));
        assert!(jobs.try_start(Job::Detect).is_some());
    }

    #[test]
    fn different_jobs_do_not_block_each_other() {
        let jobs = Jobs::default();
        let _scan = jobs.try_start(Job::Scan);
        assert!(jobs.try_start(Job::Detect).is_some());
    }

    #[test]
    fn stop_reaches_the_running_detection_only() {
        let jobs = Jobs::default();
        // Nothing running: a press is ignored...
        jobs.stop_detection();
        assert!(!jobs.detection_stopped());

        let running = jobs.try_start(Job::Detect);
        jobs.stop_detection();
        assert!(jobs.detection_stopped());
        drop(running);

        // ...and a stopped run does not stop the next one.
        let _next = jobs.try_start(Job::Detect);
        assert!(!jobs.detection_stopped());
    }

    /// The whole point for Skiptro: a process that is killed, not waited for.
    #[cfg(windows)]
    #[test]
    fn stop_kills_the_watched_process() {
        use std::sync::{Arc, Mutex};
        let jobs = Jobs::default();
        let _running = jobs.try_start(Job::Detect);
        let child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("ping");
        let child = Arc::new(Mutex::new(child));
        jobs.watch_child(child.clone());

        let started = std::time::Instant::now();
        jobs.stop_detection();
        let status = child.lock().unwrap().wait().expect("wait");
        assert!(!status.success());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    /// A job that fails part-way must not stay busy until the next launch.
    #[test]
    fn a_panicking_job_still_finishes() {
        let jobs = std::sync::Arc::new(Jobs::default());
        let inner = jobs.clone();
        let _ = std::thread::spawn(move || {
            let _running = inner.try_start(Job::Scan);
            panic!("the walk failed");
        })
        .join();
        assert!(jobs.try_start(Job::Scan).is_some());
    }
}
