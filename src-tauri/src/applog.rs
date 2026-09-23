//! The app's own log, `app.log`, and where `mpv.log` goes.
//!
//! One file for both halves of the app. The frontend's `console.*` arrives
//! through [`append_log`](crate::settings::append_log); the Rust side writes
//! through [`log!`](crate::log). Before this, Rust used `eprintln!`, which in a
//! release build — no console, `windows_subsystem = "windows"` — went nowhere
//! at all, including the lines the ROADMAP relies on for calibration.
//!
//! Both logs live in `<app data>/logs`, beside the library, not in whatever the
//! current directory happens to be. They used to be opened relative to it, so
//! launching the exe any way but the desktop shortcut wrote them somewhere
//! else, or nowhere if that directory was not writable.
//!
//! Each launch starts fresh and keeps exactly one previous session, as
//! `app.previous.log` and `mpv.previous.log`. The app is meant to run untended
//! for years, and a log that only ever grows is a slow disk leak.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Subdirectory of app data.
pub const DIR: &str = "logs";
pub const APP_LOG: &str = "app.log";
pub const MPV_LOG: &str = "mpv.log";

/// A session that writes more than this rotates mid-session, so one runaway
/// loop cannot fill the disk before the next launch gets a chance to trim.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

static STATE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn state() -> &'static Mutex<Option<PathBuf>> {
    STATE.get_or_init(|| Mutex::new(None))
}

/// `name.log` → `name.previous.log`.
fn previous_of(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!("{stem}.previous.log"))
}

/// Move `path` to its `.previous` name, replacing an older one.
fn rotate(path: &Path) {
    if path.exists() {
        let previous = previous_of(path);
        let _ = std::fs::remove_file(&previous);
        let _ = std::fs::rename(path, previous);
    }
}

/// Start a fresh session of both logs in `dir`. Called once, at startup,
/// before mpv exists — so `mpv.log` is rotated here too rather than being left
/// for mpv to append to or overwrite as its build happens to do.
pub fn init(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let app = dir.join(APP_LOG);
    rotate(&app);
    rotate(&dir.join(MPV_LOG));
    *state().lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
    Ok(())
}

fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Append one line. Never fails the caller: a log that cannot be written must
/// not take down whatever was trying to report something.
pub fn write(level: &str, message: &str) {
    let line = format!("[{}][{}] {}\n", stamp(), level.to_uppercase(), message);

    // Still printed in development, where there is a console to read it in.
    #[cfg(debug_assertions)]
    eprint!("{line}");

    let guard = state().lock().unwrap_or_else(|e| e.into_inner());
    let Some(path) = guard.as_ref() else { return };

    if std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_BYTES) {
        rotate(path);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// `log!("skiptro: …")` — the Rust side's way into `app.log`.
#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => {
        $crate::applog::write("rust", &format!($($arg)*))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pn-applog-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_new_session_keeps_exactly_one_previous_one() {
        let dir = fresh("rotate");
        std::fs::write(dir.join(APP_LOG), "session 2").unwrap();
        std::fs::write(dir.join("app.previous.log"), "session 1").unwrap();
        std::fs::write(dir.join(MPV_LOG), "mpv 2").unwrap();

        rotate(&dir.join(APP_LOG));
        rotate(&dir.join(MPV_LOG));

        assert!(!dir.join(APP_LOG).exists());
        assert_eq!(std::fs::read_to_string(dir.join("app.previous.log")).unwrap(), "session 2");
        assert_eq!(std::fs::read_to_string(dir.join("mpv.previous.log")).unwrap(), "mpv 2");
    }

    /// The bug this module exists for: a Rust-side line must end up in the
    /// file, not on a console that a release build does not have.
    #[test]
    fn a_rust_line_reaches_the_file() {
        let dir = fresh("write");
        init(&dir).unwrap();
        crate::log!("skiptro: confidence {:.2} for {}", 0.61, "x.mkv");
        let written = std::fs::read_to_string(dir.join(APP_LOG)).unwrap();
        assert!(
            written.contains("[RUST] skiptro: confidence 0.61 for x.mkv"),
            "got {written}"
        );
    }

    #[test]
    fn rotating_a_log_that_is_not_there_is_harmless() {
        let dir = fresh("absent");
        rotate(&dir.join(APP_LOG));
        assert!(!dir.join("app.previous.log").exists());
    }

    #[test]
    fn the_previous_name_is_derived_from_the_log() {
        assert_eq!(previous_of(Path::new(r"C:\x\mpv.log")), PathBuf::from(r"C:\x\mpv.previous.log"));
    }
}
