//! Playback self-test: the real app, the real mpv, a scripted session, a report.
//!
//! Started by setting `KINEMA_SELFTEST` to a JSON plan file. The plan names a
//! file to play and what to do and when; the frontend (`src/selftest.ts`)
//! carries it out and records what the player did — when the file loaded, when
//! the first frame was shown, when the Skip button appeared, what position the
//! player reported — and this module writes that to `report.json` beside the
//! plan and quits the app.
//!
//! It exists because the author does not test by hand, and some things can
//! only be checked against the native player: mpv's idle surface, real load
//! times over SMB, the order mpv really sends its events in.
//!
//! **It never touches the real library.** In self-test mode the data directory
//! is `<plan folder>/data`, seeded on first use with a snapshot of the real
//! library taken by `VACUUM INTO` over a read-only connection. Resume points,
//! the marker cache and the logs are all written to the copy. The frontend also
//! skips the startup scan and automatic detection in this mode, so nothing runs
//! Skiptro or ffmpeg over the media.

use std::path::{Path, PathBuf};

/// Environment variable naming the plan file.
pub const ENV: &str = "KINEMA_SELFTEST";

/// The plan file, when running in self-test mode.
pub fn plan_path() -> Option<PathBuf> {
    std::env::var_os(ENV)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Where the copied library lives for this plan.
pub fn data_dir_for(plan: &Path) -> PathBuf {
    plan.parent().unwrap_or(Path::new(".")).join("data")
}

/// Seed `dir` with a snapshot of the real library, unless it already has one
/// (so a plan can be re-run against the state the previous run left).
pub fn seed(real_library: &Path, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let copy = dir.join("library.db");
    if copy.exists() || !real_library.exists() {
        return Ok(());
    }
    let source = rusqlite::Connection::open_with_flags(
        real_library,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("opening {} read-only: {e}", real_library.display()))?;
    source
        .execute("VACUUM INTO ?1", [copy.to_string_lossy()])
        .map_err(|e| format!("copying the library: {e}"))?;
    Ok(())
}

/// The plan, for the frontend. `None` outside self-test mode.
#[tauri::command]
pub fn selftest_plan() -> Result<Option<serde_json::Value>, String> {
    let Some(path) = plan_path() else { return Ok(None) };
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
}

/// Write the report beside the plan and quit.
#[tauri::command]
pub fn selftest_finish(app: tauri::AppHandle, report: serde_json::Value) -> Result<(), String> {
    let Some(plan) = plan_path() else {
        return Err("not in self-test mode".into());
    };
    let target = plan.with_file_name("report.json");
    let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(&target, text).map_err(|e| format!("{}: {e}", target.display()))?;
    crate::log!("selftest: report written to {}", target.display());
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one property that makes this safe to run on a real machine: the
    /// copy is made, and the original is left exactly as it was.
    #[test]
    fn seeding_copies_the_library_and_leaves_the_original_alone() {
        let root = std::env::temp_dir().join("pn-selftest-seed");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let real = root.join("real.db");
        let conn = rusqlite::Connection::open(&real).unwrap();
        conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42);")
            .unwrap();
        drop(conn);
        let before = std::fs::read(&real).unwrap();

        let dir = root.join("data");
        seed(&real, &dir).unwrap();

        let copy = rusqlite::Connection::open(dir.join("library.db")).unwrap();
        let x: i64 = copy.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 42);
        assert_eq!(std::fs::read(&real).unwrap(), before, "the original is untouched");
    }

    /// A second run keeps what the first run left, rather than re-copying.
    #[test]
    fn an_existing_copy_is_reused() {
        let root = std::env::temp_dir().join("pn-selftest-reuse");
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("data");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("library.db"), b"previous run").unwrap();
        seed(&root.join("absent.db"), &dir).unwrap();
        assert_eq!(std::fs::read(dir.join("library.db")).unwrap(), b"previous run");
    }

    #[test]
    fn the_copy_lives_beside_the_plan() {
        assert_eq!(
            data_dir_for(Path::new(r"C:\tmp\run1\plan.json")),
            PathBuf::from(r"C:\tmp\run1\data")
        );
    }
}
