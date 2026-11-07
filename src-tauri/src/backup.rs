//! Putting a safety copy of the library back.
//!
//! The copies themselves are made in `db.rs`, before an upgrade and once a
//! week. This is the way back, written so that nobody has to swap database
//! files by hand: swapping `library.db` while its write-ahead log
//! (`library.db-wal`) is still beside it can apply the old file's last writes to
//! the new one and damage it, and the only symptom is a library that behaves
//! strangely afterwards.
//!
//! Restoring is two steps, because the running app holds the library open and
//! cannot replace it under itself. [`request_restore`] writes a note and Kinema
//! closes; [`apply_pending_restore`] runs at the next start, before anything
//! opens the library, and does the swap.
//!
//! [`swap_in`] changes nothing until it can change everything: the copy is made
//! under a temporary name first, and the old file's logs are moved aside and
//! not deleted, so that a refusal half way can be undone. Something holding a
//! log open (a backup tool, an antivirus) refuses at that point on Windows, and
//! the library is left as it was.

use crate::db::{self, BACKUP_DIR, SCHEMA_VERSION};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::Path;

/// The note left for the next start: the name of the copy to put back.
const MARKER: &str = "restore-pending.txt";

/// The library as it was just before a restore replaced it, kept so that a
/// restore is never a one-way door.
const BEFORE_RESTORE_PREFIX: &str = "library-before-restore-";

/// The copy being put back, until it takes the library's name.
const INCOMING: &str = "library.db.restoring";

/// The library's write-ahead log and shared-memory file, and where each waits
/// during a swap. Left beside the restored file they would be replayed onto it.
const LOGS: [(&str, &str); 2] = [
    ("library.db-wal", "library.db-wal.restoring"),
    ("library.db-shm", "library.db-shm.restoring"),
];

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct BackupCopy {
    /// The file name, which is also what [`request_restore`] takes.
    pub name: String,
    /// `weekly`, `before_upgrade` or `before_restore`.
    pub kind: String,
    /// When it was made, seconds since the epoch.
    pub made_at: u64,
    pub bytes: u64,
}

/// Which kind of copy a file is, and when it was made, from its name alone.
fn read_name(name: &str) -> Option<(&'static str, u64)> {
    if let Some(stamp) = db::auto_copy_stamp(name) {
        return Some(("weekly", stamp));
    }
    let stamp_after = |prefix: &str| -> Option<u64> {
        name.strip_prefix(prefix)?.strip_suffix(".db")?.rsplit('-').next()?.parse().ok()
    };
    if let Some(stamp) = stamp_after(BEFORE_RESTORE_PREFIX) {
        return Some(("before_restore", stamp));
    }
    // `library-v9-1790198863.db`: the number after the v is the schema the
    // copy was taken from, which nothing here needs.
    if name.starts_with("library-v") {
        return stamp_after("library-v").map(|stamp| ("before_upgrade", stamp));
    }
    None
}

/// Every copy in the folder, newest first.
pub fn list(data_dir: &Path) -> Vec<BackupCopy> {
    let Ok(entries) = std::fs::read_dir(data_dir.join(BACKUP_DIR)) else {
        return Vec::new();
    };
    let mut copies: Vec<BackupCopy> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let (kind, made_at) = read_name(&name)?;
            Some(BackupCopy {
                bytes: entry.metadata().ok()?.len(),
                name,
                kind: kind.to_string(),
                made_at,
            })
        })
        .collect();
    copies.sort_by_key(|copy| std::cmp::Reverse(copy.made_at));
    copies
}

/// Ask for a copy to be put back at the next start.
///
/// Only a name that [`list`] would show is accepted, so nothing here can be
/// pointed at a path outside the folder of copies.
pub fn request_restore(data_dir: &Path, name: &str) -> Result<(), String> {
    if !list(data_dir).iter().any(|copy| copy.name == name) {
        return Err(format!("There is no safety copy called {name}."));
    }
    std::fs::write(data_dir.join(MARKER), name)
        .map_err(|e| format!("Kinema could not note the restore: {e}"))
}

/// What a restore did, for saying so.
#[derive(Debug, PartialEq)]
pub struct Restored {
    pub made_at: u64,
}

/// Carry out a requested restore, if there is one. Runs before the library is
/// opened.
///
/// The note is removed first: a restore that fails once must not fail again at
/// every start.
///
/// An error is the whole message for the person, and says what became of the
/// library.
pub fn apply_pending_restore(data_dir: &Path) -> Result<Option<Restored>, String> {
    finish_interrupted_swap(data_dir);

    let marker = data_dir.join(MARKER);
    let Ok(name) = std::fs::read_to_string(&marker) else {
        return Ok(None);
    };
    let _ = std::fs::remove_file(&marker);
    put_back(data_dir, name.trim()).map(Some)
}

/// Put one copy back, now. The library is not open.
///
/// The library that was there is copied into the folder of copies before
/// anything is replaced, and the copy being restored is checked first, so a bad
/// file changes nothing.
pub fn put_back(data_dir: &Path, name: &str) -> Result<Restored, String> {
    let not_changed = |reason: String| format!("Your library was not changed.\n\n{reason}");

    let (_, made_at) =
        read_name(name).ok_or_else(|| not_changed(format!("{name} is not a safety copy.")))?;
    let backups = data_dir.join(BACKUP_DIR);
    let source = backups.join(name);
    if !source.is_file() {
        return Err(not_changed(format!("The safety copy {name} is no longer there.")));
    }
    check_copy(&source).map_err(not_changed)?;

    let library = data_dir.join("library.db");
    let aside = backups.join(format!("{BEFORE_RESTORE_PREFIX}{}.db", crate::util::now_secs()));
    if library.exists() {
        set_aside(&library, &aside).map_err(not_changed)?;
    }
    match swap_in(data_dir, &source) {
        Ok(()) => Ok(Restored { made_at }),
        Err(SwapFailed::Undone(reason)) => {
            // Nothing was replaced, so nothing needs keeping.
            let _ = std::fs::remove_file(&aside);
            Err(not_changed(reason))
        }
        Err(SwapFailed::LogsLeftAside(reason)) => Err(format!(
            "The safety copy could not be put back, and Kinema could not put everything \
             back as it was. The library's latest changes may be missing from it now. A \
             complete copy of it is kept with the safety copies, under Settings, Advanced.\n\n\
             {reason}"
        )),
    }
}

/// How a swap failed, for saying so truthfully.
#[derive(Debug)]
enum SwapFailed {
    /// Everything is where it was.
    Undone(String),
    /// A log could not be moved back: the library is there, without it.
    LogsLeftAside(String),
}

/// Replace `library.db` with `source`, or leave things as they were.
fn swap_in(data_dir: &Path, source: &Path) -> Result<(), SwapFailed> {
    let incoming = data_dir.join(INCOMING);
    let fail = |reason: String| {
        let _ = std::fs::remove_file(&incoming);
        SwapFailed::Undone(reason)
    };
    std::fs::copy(source, &incoming)
        .map_err(|e| fail(format!("The safety copy could not be copied: {e}")))?;
    // On disk before the old library is given up for it.
    std::fs::OpenOptions::new()
        .write(true)
        .open(&incoming)
        .and_then(|file| file.sync_all())
        .map_err(|e| fail(format!("The safety copy could not be copied: {e}")))?;

    let mut moved = Vec::new();
    for (log, waiting) in LOGS {
        let path = data_dir.join(log);
        if !path.exists() {
            continue;
        }
        if let Err(e) = std::fs::rename(&path, data_dir.join(waiting)) {
            let reason =
                format!("Another program is using {log}. Close it and try again.\n({e})");
            return Err(undo_logs(data_dir, &moved, &incoming, reason));
        }
        moved.push((log, waiting));
    }
    if let Err(e) = std::fs::rename(&incoming, data_dir.join("library.db")) {
        let reason =
            format!("Another program is using library.db. Close it and try again.\n({e})");
        return Err(undo_logs(data_dir, &moved, &incoming, reason));
    }

    // The swap is done. A log that will not go away now is harmless where it
    // is, under a name nothing reads, and goes at the next start.
    for (_, waiting) in moved {
        let _ = std::fs::remove_file(data_dir.join(waiting));
    }
    Ok(())
}

fn undo_logs(
    data_dir: &Path,
    moved: &[(&str, &str)],
    incoming: &Path,
    reason: String,
) -> SwapFailed {
    let _ = std::fs::remove_file(incoming);
    for (log, waiting) in moved {
        if let Err(e) = std::fs::rename(data_dir.join(waiting), data_dir.join(log)) {
            crate::log!("backup: could not put {log} back: {e}");
            return SwapFailed::LogsLeftAside(format!("{reason}\n({log}: {e})"));
        }
    }
    SwapFailed::Undone(reason)
}

/// A swap cut short by a power cut. With the incoming copy still under its
/// temporary name the library was never replaced, and its logs go back; without
/// it the swap had finished, and they are left-overs.
fn finish_interrupted_swap(data_dir: &Path) {
    let incoming = data_dir.join(INCOMING);
    let unfinished = incoming.exists();
    for (log, waiting) in LOGS {
        let waiting = data_dir.join(waiting);
        if !waiting.exists() {
            continue;
        }
        let tidied = if unfinished {
            std::fs::rename(&waiting, data_dir.join(log))
        } else {
            std::fs::remove_file(&waiting)
        };
        if let Err(e) = tidied {
            crate::log!("backup: could not tidy {}: {e}", waiting.display());
        }
    }
    if unfinished {
        let _ = std::fs::remove_file(&incoming);
    }
}

/// The newest copy that is whole and that this Kinema can read, for offering
/// when the library itself will not open.
pub fn newest_good_copy(data_dir: &Path) -> Option<BackupCopy> {
    let backups = data_dir.join(BACKUP_DIR);
    list(data_dir).into_iter().find(|copy| check_copy(&backups.join(&copy.name)).is_ok())
}

/// A copy's date, for saying which one is meant.
pub fn date_of(copy: &BackupCopy) -> String {
    let (year, month, day) = crate::report::civil((copy.made_at / 86_400) as i64);
    format!("{year}-{month:02}-{day:02}")
}

/// Refuse a copy that is damaged or too new for this Kinema, before it
/// replaces anything.
fn check_copy(path: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("The safety copy could not be opened: {e}"))?;
    let verdict: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| format!("The safety copy could not be checked: {e}"))?;
    if verdict != "ok" {
        return Err(format!("The safety copy is damaged ({verdict})."));
    }
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| format!("The safety copy could not be read: {e}"))?;
    if version > SCHEMA_VERSION {
        return Err("The safety copy is from a newer Kinema than this one.".to_string());
    }
    Ok(())
}

/// Copy the current library to `aside`, the way the weekly copy is made. If the
/// library is too damaged for that, the bare file is better than nothing.
fn set_aside(library: &Path, aside: &Path) -> Result<(), String> {
    let snapshot = Connection::open(library)
        .and_then(|conn| conn.execute("VACUUM INTO ?1", [aside.to_string_lossy()]).map(|_| ()));
    if snapshot.is_ok() {
        return Ok(());
    }
    let _ = std::fs::remove_file(aside);
    std::fs::copy(library, aside)
        .map(|_| ())
        .map_err(|e| format!("Could not keep the current library before replacing it: {e}"))
}

// ---- Tauri commands --------------------------------------------------------

#[tauri::command]
pub fn list_backups(app: tauri::AppHandle) -> Result<Vec<BackupCopy>, String> {
    Ok(list(&crate::data_dir(&app)?))
}

/// Note the restore and close Kinema, which puts the copy back as it starts
/// again.
#[tauri::command]
pub fn restore_backup(app: tauri::AppHandle, name: String) -> Result<(), String> {
    request_restore(&crate::data_dir(&app)?, &name)?;
    crate::log!("backup: restoring {name}; closing");
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pn-restore-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(BACKUP_DIR)).unwrap();
        dir
    }

    /// A real library file holding one resume point at `position`.
    fn library_at(path: &Path, position: f64) {
        let conn = Connection::open(path).unwrap();
        for (index, sql) in db::MIGRATIONS.iter().enumerate() {
            conn.execute_batch(sql).unwrap();
            conn.execute_batch(&format!("PRAGMA user_version={};", index + 1)).unwrap();
        }
        conn.execute_batch(&format!(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:\\m', 'tv', 0);
             INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                 size_bytes, modified_at, first_seen_at, last_seen_at)
                 VALUES (1, 1, 'C:\\m\\a.mkv', 'C:\\m', 'a.mkv', 'mkv', 1, 1, 1, 1);
             INSERT INTO playback_state (file_id, position_secs, completed, updated_at)
                 VALUES (1, {position}, 0, 1);"
        ))
        .unwrap();
    }

    fn position_in(path: &Path) -> f64 {
        Connection::open(path)
            .unwrap()
            .query_row("SELECT position_secs FROM playback_state WHERE file_id = 1", [], |r| {
                r.get(0)
            })
            .unwrap()
    }

    #[test]
    fn copies_are_named_and_listed_newest_first() {
        let dir = folder("list");
        for name in [
            "library-v9-100.db",
            "library-auto-v18-300.db",
            "library-before-restore-200.db",
            "notes.txt",
            "library-auto-v18-soon.db",
        ] {
            std::fs::write(dir.join(BACKUP_DIR).join(name), b"x").unwrap();
        }
        let listed: Vec<(String, String)> =
            list(&dir).into_iter().map(|c| (c.name, c.kind)).collect();
        assert_eq!(
            listed,
            vec![
                ("library-auto-v18-300.db".to_string(), "weekly".to_string()),
                ("library-before-restore-200.db".to_string(), "before_restore".to_string()),
                ("library-v9-100.db".to_string(), "before_upgrade".to_string()),
            ]
        );
    }

    /// A restore puts the copy in place, keeps what it replaced, and leaves no
    /// write-ahead log behind to be replayed onto the restored file.
    #[test]
    fn a_requested_restore_swaps_the_library_and_keeps_the_old_one() {
        let dir = folder("swap");
        library_at(&dir.join("library.db"), 900.0);
        library_at(&dir.join(BACKUP_DIR).join("library-auto-v18-500.db"), 10.0);
        std::fs::write(dir.join("library.db-wal"), b"stale log").unwrap();
        std::fs::write(dir.join("library.db-shm"), b"stale memory").unwrap();

        request_restore(&dir, "library-auto-v18-500.db").unwrap();
        let done = apply_pending_restore(&dir).unwrap();

        assert_eq!(done, Some(Restored { made_at: 500 }));
        assert_eq!(position_in(&dir.join("library.db")), 10.0);
        assert!(!dir.join("library.db-wal").exists());
        assert!(!dir.join("library.db-shm").exists());
        assert!(!dir.join(MARKER).exists(), "the note is used up");

        let kept: Vec<_> = list(&dir).into_iter().filter(|c| c.kind == "before_restore").collect();
        assert_eq!(kept.len(), 1, "what was replaced is kept");
        assert_eq!(position_in(&dir.join(BACKUP_DIR).join(&kept[0].name)), 900.0);
    }

    /// A file held open with no sharing, as a backup tool or antivirus holds
    /// one: Windows refuses to move or delete it.
    #[cfg(windows)]
    fn hold(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).write(true).share_mode(0).open(path).unwrap()
    }

    /// Review 2026-11, finding 3: the library used to be deleted first, and the
    /// refusal on its log then reported "not changed" over an empty folder.
    #[cfg(windows)]
    #[test]
    fn a_log_held_by_another_program_changes_nothing_and_says_so() {
        for log in ["library.db-wal", "library.db-shm"] {
            let dir = folder(&format!("held-{log}"));
            library_at(&dir.join("library.db"), 900.0);
            library_at(&dir.join(BACKUP_DIR).join("library-auto-v18-500.db"), 10.0);
            std::fs::write(dir.join("library.db-wal"), b"").unwrap();
            std::fs::write(dir.join("library.db-shm"), b"").unwrap();
            let held = hold(&dir.join(log));

            request_restore(&dir, "library-auto-v18-500.db").unwrap();
            let refused = apply_pending_restore(&dir).unwrap_err();
            drop(held);

            assert!(refused.starts_with("Your library was not changed."), "{refused}");
            assert!(refused.contains(log), "{refused}");
            assert_eq!(position_in(&dir.join("library.db")), 900.0);
            for (log, waiting) in LOGS {
                assert!(dir.join(log).exists(), "{log} is back where it was");
                assert!(!dir.join(waiting).exists());
            }
            assert!(!dir.join(INCOMING).exists());
            assert!(
                list(&dir).iter().all(|copy| copy.kind != "before_restore"),
                "nothing was replaced, so nothing is kept for it"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_library_held_by_another_program_changes_nothing_and_says_so() {
        let dir = folder("held-library");
        library_at(&dir.join("library.db"), 900.0);
        library_at(&dir.join(BACKUP_DIR).join("library-auto-v18-500.db"), 10.0);
        std::fs::write(dir.join("library.db-wal"), b"").unwrap();
        // Shared for reading only: the copy aside can still read it, and a
        // rename over it is refused.
        use std::os::windows::fs::OpenOptionsExt;
        let held =
            std::fs::OpenOptions::new().read(true).share_mode(1).open(dir.join("library.db")).unwrap();

        request_restore(&dir, "library-auto-v18-500.db").unwrap();
        let refused = apply_pending_restore(&dir).unwrap_err();
        drop(held);

        assert!(refused.starts_with("Your library was not changed."), "{refused}");
        assert_eq!(position_in(&dir.join("library.db")), 900.0);
        assert!(dir.join("library.db-wal").exists());
    }

    /// The copy cannot be made at all (a full disk): same thing.
    #[test]
    fn a_copy_that_cannot_be_made_changes_nothing() {
        let dir = folder("full");
        library_at(&dir.join("library.db"), 900.0);
        library_at(&dir.join(BACKUP_DIR).join("library-auto-v18-500.db"), 10.0);
        std::fs::write(dir.join("library.db-wal"), b"").unwrap();
        // A folder under the temporary name stands in for the failure.
        std::fs::create_dir(dir.join(INCOMING)).unwrap();

        request_restore(&dir, "library-auto-v18-500.db").unwrap();
        let refused = apply_pending_restore(&dir).unwrap_err();

        assert!(refused.starts_with("Your library was not changed."), "{refused}");
        assert_eq!(position_in(&dir.join("library.db")), 900.0);
        assert!(dir.join("library.db-wal").exists());
    }

    /// A power cut between the renames: the next start puts things back.
    #[test]
    fn a_swap_cut_short_is_undone_at_the_next_start() {
        let dir = folder("cut-short");
        library_at(&dir.join("library.db"), 900.0);
        std::fs::write(dir.join(INCOMING), b"half a copy").unwrap();
        std::fs::write(dir.join("library.db-wal.restoring"), b"the log").unwrap();

        assert_eq!(apply_pending_restore(&dir), Ok(None));

        assert_eq!(std::fs::read(dir.join("library.db-wal")).unwrap(), b"the log");
        assert!(!dir.join("library.db-wal.restoring").exists());
        assert!(!dir.join(INCOMING).exists());
    }

    /// A power cut just after the last rename: only left-overs to clear, and
    /// they must not be replayed onto the restored file.
    #[test]
    fn a_swap_that_had_finished_only_tidies_up() {
        let dir = folder("cut-after");
        library_at(&dir.join("library.db"), 10.0);
        std::fs::write(dir.join("library.db-wal.restoring"), b"the old log").unwrap();

        assert_eq!(apply_pending_restore(&dir), Ok(None));

        assert!(!dir.join("library.db-wal").exists());
        assert!(!dir.join("library.db-wal.restoring").exists());
    }

    /// The copy offered at start-up: the newest whole one this Kinema can read.
    #[test]
    fn the_newest_good_copy_skips_damaged_and_too_new_ones() {
        let dir = folder("newest");
        let backups = dir.join(BACKUP_DIR);
        assert_eq!(newest_good_copy(&dir), None);
        library_at(&backups.join("library-auto-v18-100.db"), 1.0);
        library_at(&backups.join("library-v17-200.db"), 2.0);
        std::fs::write(backups.join("library-auto-v18-300.db"), vec![7u8; 5000]).unwrap();
        library_at(&backups.join("library-auto-v99-400.db"), 4.0);
        Connection::open(backups.join("library-auto-v99-400.db"))
            .unwrap()
            .execute_batch(&format!("PRAGMA user_version={};", SCHEMA_VERSION + 1))
            .unwrap();

        let found = newest_good_copy(&dir).unwrap();
        assert_eq!(found.name, "library-v17-200.db");
        assert_eq!(date_of(&BackupCopy { made_at: 1_790_198_863, ..found }), "2026-09-23");
    }

    /// The way back a dialog offers: a damaged library with a crash's log beside
    /// it comes back as the copy, undamaged, with the damaged file kept.
    #[test]
    fn putting_back_over_a_damaged_library_and_a_crash_s_log_is_clean() {
        let dir = folder("damaged-library");
        std::fs::write(dir.join("library.db"), vec![9u8; 8192]).unwrap();
        std::fs::write(dir.join("library.db-wal"), vec![3u8; 4096]).unwrap();
        library_at(&dir.join(BACKUP_DIR).join("library-auto-v18-500.db"), 10.0);

        assert_eq!(put_back(&dir, "library-auto-v18-500.db"), Ok(Restored { made_at: 500 }));

        assert!(!dir.join("library.db-wal").exists());
        let conn = crate::db::open(&dir.join("library.db")).unwrap();
        let verdict: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).unwrap();
        assert_eq!(verdict, "ok");
        drop(conn);
        assert_eq!(position_in(&dir.join("library.db")), 10.0);
        assert!(list(&dir).iter().any(|copy| copy.kind == "before_restore"), "what was there is kept");
    }

    #[test]
    fn nothing_pending_changes_nothing() {
        let dir = folder("none");
        library_at(&dir.join("library.db"), 900.0);
        assert_eq!(apply_pending_restore(&dir), Ok(None));
        assert_eq!(position_in(&dir.join("library.db")), 900.0);
    }

    /// A name that is not in the folder of copies is refused, whatever it is
    /// made to look like.
    #[test]
    fn only_a_listed_copy_can_be_requested() {
        let dir = folder("names");
        assert!(request_restore(&dir, "library-auto-v18-1.db").is_err());
        assert!(request_restore(&dir, "..\\library.db").is_err());
        assert!(!dir.join(MARKER).exists());
    }

    /// A damaged copy is refused, the library is left alone, and the note is
    /// gone so the next start does not try again.
    #[test]
    fn a_damaged_copy_changes_nothing() {
        let dir = folder("damaged");
        library_at(&dir.join("library.db"), 900.0);
        std::fs::write(dir.join(BACKUP_DIR).join("library-auto-v18-500.db"), vec![7u8; 5000])
            .unwrap();

        request_restore(&dir, "library-auto-v18-500.db").unwrap();
        assert!(apply_pending_restore(&dir).is_err());

        assert_eq!(position_in(&dir.join("library.db")), 900.0);
        assert!(!dir.join(MARKER).exists());
    }

    #[test]
    fn a_copy_from_a_newer_kinema_is_refused() {
        let dir = folder("newer");
        library_at(&dir.join("library.db"), 900.0);
        let copy = dir.join(BACKUP_DIR).join("library-auto-v99-500.db");
        library_at(&copy, 10.0);
        Connection::open(&copy)
            .unwrap()
            .execute_batch(&format!("PRAGMA user_version={};", SCHEMA_VERSION + 1))
            .unwrap();

        request_restore(&dir, "library-auto-v99-500.db").unwrap();
        let refused = apply_pending_restore(&dir).unwrap_err();

        assert!(refused.contains("newer Kinema"), "{refused}");
        assert_eq!(position_in(&dir.join("library.db")), 900.0);
    }
}
