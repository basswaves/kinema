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

use crate::db::{self, BACKUP_DIR, SCHEMA_VERSION};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::Path;

/// The note left for the next start: the name of the copy to put back.
const MARKER: &str = "restore-pending.txt";

/// The library as it was just before a restore replaced it, kept so that a
/// restore is never a one-way door.
const BEFORE_RESTORE_PREFIX: &str = "library-before-restore-";

#[derive(Serialize, Debug, PartialEq)]
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
/// every start. The library that was there is copied into the folder of copies
/// before anything is replaced, and the copy being restored is checked first,
/// so a bad file changes nothing.
pub fn apply_pending_restore(data_dir: &Path) -> Result<Option<Restored>, String> {
    let marker = data_dir.join(MARKER);
    let Ok(name) = std::fs::read_to_string(&marker) else {
        return Ok(None);
    };
    let _ = std::fs::remove_file(&marker);

    let name = name.trim();
    let (_, made_at) = read_name(name).ok_or_else(|| format!("{name} is not a safety copy."))?;
    let backups = data_dir.join(BACKUP_DIR);
    let source = backups.join(name);
    if !source.is_file() {
        return Err(format!("The safety copy {name} is no longer there."));
    }
    check_copy(&source)?;

    let library = data_dir.join("library.db");
    if library.exists() {
        let aside = backups.join(format!("{BEFORE_RESTORE_PREFIX}{}.db", crate::util::now_secs()));
        set_aside(&library, &aside)?;
    }

    // The old file's write-ahead log and shared-memory file go with it. Left
    // beside the restored one they would be replayed onto it.
    for file in ["library.db", "library.db-wal", "library.db-shm"] {
        let path = data_dir.join(file);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("Could not remove {file}: {e}"))?;
        }
    }
    std::fs::copy(&source, &library).map_err(|e| format!("Could not put {name} back: {e}"))?;
    Ok(Some(Restored { made_at }))
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
