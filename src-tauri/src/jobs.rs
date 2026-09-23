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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
#[derive(Default)]
pub struct Jobs {
    scan: Arc<AtomicBool>,
    detect: Arc<AtomicBool>,
    pub artwork: tauri::async_runtime::Mutex<()>,
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
            .ok()
            .map(|_| Running(flag.clone()))
    }
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
