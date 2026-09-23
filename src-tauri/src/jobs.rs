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
