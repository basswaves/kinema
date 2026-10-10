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
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| {
        // A panic is already in app.log with its backtrace (applog.rs);
        // "task 113 panicked with message …" means nothing to a person.
        crate::log!("work off the main thread failed: {e}");
        "Something went wrong inside Kinema. What happened is in its log (Settings → Advanced)."
            .to_string()
    })?
}

// ---- a film is playing -------------------------------------------------------

use std::time::Duration;

/// Whether a film is playing right now. One flag for the whole process: the
/// background loops (artwork, reading and measuring files, IMDb, the walk of a
/// share) look at it between two units of work and wait while it is set.
static PLAYING: AtomicBool = AtomicBool::new(false);

/// How often a waiting loop looks again. Short enough that work resumes
/// promptly when the film is closed, long enough to cost nothing.
const PLAYING_POLL: Duration = Duration::from_millis(500);

/// When the flag was last set, in seconds since the epoch.
static PLAYING_SINCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// No film is this long: a flag older than this was left set by a page that
/// went away mid-film (a reload, a crash), and background work goes on.
const PLAYING_AT_MOST: u64 = 6 * 60 * 60;

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Whether a film is playing (see [`set_playing`]).
pub fn playing() -> bool {
    PLAYING.load(Ordering::Relaxed)
        && now_secs().saturating_sub(PLAYING_SINCE.load(Ordering::Relaxed)) < PLAYING_AT_MOST
}

/// Tell the background work whether a film is playing: `true` when the player
/// opens, `false` when it closes. Also the Tauri command `set_playing`, with
/// one argument, `on`; the page calls it, and nothing here depends on it
/// being called (never called, nothing ever waits).
///
/// Why: a 2-core TV box cannot decode a film and download posters, read files
/// and walk a share at the same time, and the film is the one thing nobody
/// forgives. Work that waits is only late; a film that stutters is wrong.
///
/// A unit of work already started is finished: the loops look at the flag
/// between files and downloads, never in the middle of one.
#[tauri::command]
pub fn set_playing(on: bool) {
    PLAYING_SINCE.store(now_secs(), Ordering::Relaxed);
    PLAYING.store(on, Ordering::Relaxed);
}

/// Block this thread while a film plays. Call between two units of work, and
/// **never while holding the database lock** — the page's own commands need it.
pub fn wait_while_playing() {
    while playing() {
        std::thread::sleep(PLAYING_POLL);
    }
}

/// [`wait_while_playing`] for async code: waits without holding a thread.
pub async fn wait_while_playing_async() {
    while playing() {
        tokio::time::sleep(PLAYING_POLL).await;
    }
}

// ---- below the film in priority ---------------------------------------------

/// Proof that this thread is running at background priority; dropping it puts
/// the priority back where it was.
///
/// **Linux and Android: new threads inherit the creator's priority.** A thread
/// lowered here that then creates another (a connection to a share starts its
/// own worker threads, the first time one is opened) hands that thread the low
/// priority for good — and if a film later reads through that connection, the
/// film is the one that runs slowly. So hold this only around work that does
/// not open a connection to a share, and never in the walk of one.
///
/// **Linux and Android: priority can be lowered but, for an ordinary program,
/// not raised again** (the kernel refuses without a privilege Kinema does not
/// have), so dropping this cannot undo it there. Use it on a thread that ends
/// soon after — [`off_main_background`] makes one — never on one of the shared
/// pool's, which would stay low for whatever runs on it next. Windows gives it
/// back exactly.
#[must_use]
pub struct Background {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    before: Option<(libc::id_t, libc::c_int)>,
    #[cfg(windows)]
    lowered: bool,
}

/// Nice value for background work on Linux and Android: clearly behind the
/// film's threads, still given time when nothing else wants the CPU.
#[cfg(any(target_os = "linux", target_os = "android"))]
const BACKGROUND_NICE: libc::c_int = 10;

/// Lower the priority of the calling thread until the result is dropped. Best
/// effort: where the system refuses, or the system is another one, work simply
/// runs at normal priority, as it did before.
pub fn background() -> Background {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        // SAFETY: gettid, getpriority and setpriority take and return plain
        // integers and touch only this thread's own scheduling.
        unsafe {
            let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
            let was = libc::getpriority(libc::PRIO_PROCESS, tid);
            let lowered = libc::setpriority(libc::PRIO_PROCESS, tid, BACKGROUND_NICE) == 0;
            Background { before: lowered.then_some((tid, was)) }
        }
    }
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN,
        };
        // Background mode lowers the thread's CPU, disk and memory priority
        // together, which is what a library scan wants beside a film.
        // SAFETY: the pseudo handle of the calling thread is always valid.
        let lowered =
            unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) }.is_ok();
        Background { lowered }
    }
    #[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
    Background {}
}

impl Drop for Background {
    fn drop(&mut self) {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        if let Some((tid, was)) = self.before {
            // Refused for an ordinary program (see the type's note); the
            // thread this runs on is then one that is about to end.
            // SAFETY: as in `background`.
            unsafe {
                libc::setpriority(libc::PRIO_PROCESS, tid, was);
            }
        }
        #[cfg(windows)]
        if self.lowered {
            use windows::Win32::System::Threading::{
                GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_END,
            };
            // SAFETY: as in `background`; END must come from the same thread.
            unsafe {
                let _ = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_END);
            }
        }
    }
}

/// [`off_main`] for work that should stay out of a film's way: it runs on a
/// thread of its own, at background priority, that ends with the work.
///
/// A thread of its own rather than the blocking pool's, because a lowered
/// priority cannot be put back on Linux and Android (see [`Background`]): a
/// pool thread left low would slow whatever was handed to it next, perhaps a
/// film's file reading. Only for long loops, where the cost of starting a
/// thread is nothing; and not for anything that opens a connection to a
/// share, whose threads would inherit the low priority.
pub async fn off_main_background<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (done, result) = tokio::sync::oneshot::channel();
    let started = std::thread::Builder::new().name("kinema-background".into()).spawn(move || {
        let _low = background();
        let _ = done.send(work());
    });
    let failed = |what: String| {
        crate::log!("background work failed: {what}");
        "Something went wrong inside Kinema. What happened is in its log (Settings → Advanced)."
            .to_string()
    };
    if let Err(e) = started {
        return Err(failed(e.to_string()));
    }
    // A closed channel means the thread panicked before it answered.
    result.await.map_err(|e| failed(e.to_string()))?
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
/// * **Probe** — refused, silently. Reading files, and measuring pictures
///   (`aspect.rs`), are the scan's own steps; a second pass would look at
///   nothing the first did not.
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
    probe: Arc<AtomicBool>,
    pub artwork: tauri::async_runtime::Mutex<()>,
    stop_detect: AtomicBool,
    /// The Skiptro process running right now, so Stop can end it.
    child: Mutex<Option<Arc<Mutex<Child>>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Job {
    Scan,
    Detect,
    Probe,
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
            Job::Probe => &self.probe,
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

    /// The film's flag, and a waiting loop that is let go when it clears.
    #[test]
    fn work_waits_while_a_film_plays_and_goes_on_after() {
        super::set_playing(true);
        assert!(super::playing());
        let waiter = std::thread::spawn(super::wait_while_playing);
        std::thread::sleep(std::time::Duration::from_millis(700));
        assert!(!waiter.is_finished(), "should still be waiting");
        super::set_playing(false);
        waiter.join().unwrap();
        assert!(!super::playing());
    }

    /// Background work runs, hands back what it made, and a panic in it
    /// becomes an error rather than a hang.
    #[test]
    fn background_work_returns_its_result_or_an_error() {
        let ok = tauri::async_runtime::block_on(super::off_main_background(|| Ok(7)));
        assert_eq!(ok, Ok(7));
        let failed: Result<(), String> =
            tauri::async_runtime::block_on(super::off_main_background(|| panic!("the work failed")));
        assert!(failed.is_err());
    }

    /// Lowering and restoring is harmless to the thread that does it.
    #[test]
    fn the_background_guard_comes_and_goes() {
        drop(super::background());
        let _held = super::background();
    }
}
