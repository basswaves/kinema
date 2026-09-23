//! Filesystem scanner.
//!
//! Design constraints that matter here:
//!
//!  * Media may live on SMB/NAS shares. Never read file *contents* during a
//!    scan — identity is (path, size, mtime), which costs one stat call. A
//!    content hash over a 60GB remux on a gigabit link is not an option.
//!  * A rescan must be cheap. Files whose size and mtime are unchanged keep
//!    their existing parse/match results and are only touched to update
//!    `last_seen_at`.
//!  * Deletions are soft. A share that is offline should not wipe the library,
//!    so vanished files are flagged `missing` rather than deleted.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

/// Container formats worth indexing. Deliberately excludes subtitle and image
/// sidecars — those are discovered relative to a media file, not scanned for.
const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "m4v", "avi", "mov", "wmv", "flv", "webm", "mpg", "mpeg", "m2ts", "ts", "vob",
    "iso", "divx", "ogm", "rmvb", "3gp", "mts",
];

/// Directories that never contain primary media. Skipping them saves a lot of
/// stat calls on a big library and avoids indexing disc-structure noise.
const SKIP_DIRS: &[&str] = &[
    "extras",
    "featurettes",
    "behind the scenes",
    "deleted scenes",
    "interviews",
    "scenes",
    "shorts",
    "trailers",
    "other",
    "sample",
    "samples",
    "bdmv",
    "certificate",
    "video_ts",
    "audio_ts",
    "$recycle.bin",
    "#recycle",
    "system volume information",
    ".git",
];

#[derive(Debug, Serialize, Default)]
pub struct ScanReport {
    pub roots_scanned: usize,
    pub files_seen: usize,
    pub files_added: usize,
    pub files_updated: usize,
    pub files_unchanged: usize,
    pub files_missing: usize,
    pub errors: Vec<String>,
    pub duration_ms: u128,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_video(path: &Path) -> bool {
    let is_container = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false);

    if !is_container {
        return false;
    }

    // A `-trailer` file sitting beside the feature is not a title. The
    // `trailers/` *directory* is already skipped above; this covers the suffix
    // convention, which would otherwise add a junk entry to the library — and
    // a group in the review queue — for every film that has one.
    !path
        .file_name()
        .and_then(|n| n.to_str())
        .map(crate::trailer::is_trailer_file_name)
        .unwrap_or(false)
}

fn is_skipped_dir(name: &str) -> bool {
    let lower = name.to_lowercase();
    SKIP_DIRS.contains(&lower.as_str()) || lower.starts_with('.')
}

/// Scan every configured root, updating `media_files` in place.
pub fn scan_all(conn: &mut Connection) -> rusqlite::Result<ScanReport> {
    let started = std::time::Instant::now();
    let mut report = ScanReport::default();

    let roots: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, path FROM library_roots ORDER BY id")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for (root_id, root_path) in roots {
        report.roots_scanned += 1;
        scan_root(conn, root_id, &root_path, &mut report)?;
    }

    report.duration_ms = started.elapsed().as_millis();
    Ok(report)
}

/// One file the walk found, with everything the database needs about it.
///
/// Collected outside any transaction on purpose. Stat calls are the slow part
/// of a scan over SMB, and the whole walk used to happen *inside* a transaction
/// — so the write lock was held for the network round trips as well as for the
/// writes. Now the lock is only taken to flush a batch of already-gathered rows.
struct SeenFile {
    path: String,
    parent_dir: String,
    file_name: String,
    extension: String,
    size: i64,
    modified: i64,
}

/// Rows written per transaction.
///
/// Bounds how long the scanner can hold the single writer lock, which is what
/// decides whether `save_progress` — firing every five seconds while something
/// is playing — has to wait or sails through. Large enough that a big library
/// is not thousands of transactions.
const WRITE_BATCH: usize = 500;

fn scan_root(
    conn: &mut Connection,
    root_id: i64,
    root_path: &str,
    report: &mut ScanReport,
) -> rusqlite::Result<()> {
    let root = Path::new(root_path);
    if !root.exists() {
        // Offline share: leave everything under this root untouched rather
        // than marking a whole library missing because a NAS is asleep.
        report
            .errors
            .push(format!("root unavailable, skipped: {root_path}"));
        return Ok(());
    }

    let now = now_secs();
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut pending: Vec<SeenFile> = Vec::with_capacity(WRITE_BATCH);

    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_dir() {
                return !e
                    .file_name()
                    .to_str()
                    .map(is_skipped_dir)
                    .unwrap_or(false);
            }
            true
        });

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                report.errors.push(e.to_string());
                continue;
            }
        };

        if !entry.file_type().is_file() || !is_video(entry.path()) {
            continue;
        }

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(e) => {
                report.errors.push(format!("{}: {e}", entry.path().display()));
                continue;
            }
        };

        let path = entry.path().to_string_lossy().to_string();

        report.files_seen += 1;
        seen_paths.insert(path.clone());

        pending.push(SeenFile {
            parent_dir: entry
                .path()
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            file_name: entry.file_name().to_string_lossy().to_string(),
            extension: entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase(),
            path,
            size: meta.len() as i64,
            modified: mtime_secs(&meta),
        });

        if pending.len() >= WRITE_BATCH {
            write_batch(conn, root_id, now, &pending, report)?;
            pending.clear();
        }
    }

    if !pending.is_empty() {
        write_batch(conn, root_id, now, &pending, report)?;
    }

    mark_missing(conn, root_id, &seen_paths, report)?;
    Ok(())
}

/// Write one batch of gathered files. Their contents are already known, so this
/// touches nothing but the database and returns quickly.
///
/// A scan interrupted between batches leaves the rows it had already written,
/// which is fine: every statement here is keyed on the path and re-running the
/// scan converges. Losing a whole root's worth of work to keep one transaction
/// atomic would be the worse trade.
fn write_batch(
    conn: &mut Connection,
    root_id: i64,
    now: i64,
    batch: &[SeenFile],
    report: &mut ScanReport,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut select =
            tx.prepare("SELECT id, size_bytes, modified_at FROM media_files WHERE path = ?1")?;
        let mut insert = tx.prepare(
            "INSERT INTO media_files
                (root_id, path, parent_dir, file_name, extension, size_bytes,
                 modified_at, first_seen_at, last_seen_at, missing, match_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 0, 'unparsed')",
        )?;
        let mut touch =
            tx.prepare("UPDATE media_files SET last_seen_at = ?2, missing = 0 WHERE id = ?1")?;
        // Content changed: reset the parse so it gets re-evaluated.
        let mut update = tx.prepare(
            "UPDATE media_files
                SET size_bytes = ?2, modified_at = ?3, last_seen_at = ?4, missing = 0,
                    parsed_at = NULL, parsed_title = NULL, parsed_year = NULL,
                    parsed_season = NULL, parsed_episode = NULL, parsed_kind = NULL,
                    parsed_episode_last = NULL,
                    parsed_from = NULL, parsed_json = NULL, match_status = 'unparsed'
              WHERE id = ?1",
        )?;
        // …and forget that the old bytes were watched. See `resize_forgets_progress`
        // below for why this is keyed on the size alone.
        let mut resize = tx.prepare(
            "UPDATE playback_state
                SET completed = 0, duration_secs = NULL
              WHERE file_id = ?1",
        )?;

        for file in batch {
            let existing: Option<(i64, i64, i64)> = select
                .query_row(params![&file.path], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .ok();

            match existing {
                Some((id, old_size, old_mtime))
                    if old_size == file.size && old_mtime == file.modified =>
                {
                    touch.execute(params![id, now])?;
                    report.files_unchanged += 1;
                }
                Some((id, old_size, _)) => {
                    update.execute(params![id, file.size, file.modified, now])?;
                    // A file that changed *size* is different content, and
                    // "watched" is a claim about content. The commonest way this
                    // happens is a download or a copy that was scanned before it
                    // finished: the partial file plays — MKV streams happily from
                    // an incomplete file — reaches its short end, and
                    // `save_progress` marks it complete at 94% of a duration that
                    // was never the real one. The flag then survives the full file
                    // arriving, and the episode is silently never offered again.
                    //
                    // **Size only, never mtime.** An mtime moves for reasons that
                    // are not content: another tool writing metadata, a copy
                    // between drives, a NAS touching a file. Clearing watch state
                    // on mtime would let moving a library wipe every tick in it.
                    if old_size != file.size {
                        resize.execute(params![id])?;
                    }
                    report.files_updated += 1;
                }
                None => {
                    insert.execute(params![
                        root_id,
                        &file.path,
                        &file.parent_dir,
                        &file.file_name,
                        &file.extension,
                        file.size,
                        file.modified,
                        now
                    ])?;
                    report.files_added += 1;
                }
            }
        }
    }
    tx.commit()
}

/// Flag anything under this root the walk did not see.
///
/// Flagged, never deleted — the user may have unplugged a drive, and their
/// watch history should survive that.
fn mark_missing(
    conn: &mut Connection,
    root_id: i64,
    seen_paths: &HashSet<String>,
    report: &mut ScanReport,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stale =
            tx.prepare("SELECT id, path FROM media_files WHERE root_id = ?1 AND missing = 0")?;
        let candidates: Vec<(i64, String)> = stale
            .query_map(params![root_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut mark = tx.prepare("UPDATE media_files SET missing = 1 WHERE id = ?1")?;
        for (id, path) in candidates {
            if !seen_paths.contains(&path) {
                mark.execute(params![id])?;
                report.files_missing += 1;
            }
        }
    }
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real database rather than a hand-written schema: the point of these
    /// tests is what happens to `playback_state` when `media_files` is updated,
    /// which is a question about the actual tables.
    fn database(name: &str) -> Connection {
        let dir = std::env::temp_dir().join(format!("pn-scanner-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let conn = crate::db::open(&dir.join("library.db")).unwrap();
        conn.execute(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, ?1, 'tv', 0)",
            params![dir.to_string_lossy()],
        )
        .unwrap();
        conn
    }

    fn seen(size: i64, modified: i64) -> SeenFile {
        SeenFile {
            path: r"C:\media\Show S01E01.mkv".into(),
            parent_dir: r"C:\media".into(),
            file_name: "Show S01E01.mkv".into(),
            extension: "mkv".into(),
            size,
            modified,
        }
    }

    /// Record the file, then say it was watched to the end.
    fn watched_file(conn: &mut Connection, size: i64, modified: i64) -> i64 {
        let mut report = ScanReport::default();
        write_batch(conn, 1, 0, &[seen(size, modified)], &mut report).unwrap();

        let id: i64 = conn
            .query_row("SELECT id FROM media_files", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at)
             VALUES (?1, 1400.0, 1450.0, 1, 0)",
            params![id],
        )
        .unwrap();
        id
    }

    fn completion(conn: &Connection, id: i64) -> (i64, Option<f64>) {
        conn.query_row(
            "SELECT completed, duration_secs FROM playback_state WHERE file_id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    /// The bug this exists for: a partial download plays, reaches its short
    /// end, and is marked complete against a duration that was never real. When
    /// the rest of the file arrives the episode must not still count as watched.
    #[test]
    fn a_file_that_grows_forgets_it_was_watched() {
        let mut conn = database("grew");
        let id = watched_file(&mut conn, 60_000_000, 100);

        let mut report = ScanReport::default();
        write_batch(&mut conn, 1, 1, &[seen(500_000_000, 200)], &mut report).unwrap();

        assert_eq!(report.files_updated, 1);
        // The duration goes with it: it is what gets sent to TheIntroDB to tell
        // releases apart, and a truncated one fetches the wrong release.
        assert_eq!(completion(&conn, id), (0, None));
    }

    /// **The other half, and the more dangerous one to get wrong.** An mtime
    /// moves for reasons that are not content — another tool writing metadata,
    /// a copy between drives, a NAS touching a file. If this cleared watch
    /// state, moving a library would wipe every tick in it.
    #[test]
    fn a_new_timestamp_alone_does_not() {
        let mut conn = database("touched");
        let id = watched_file(&mut conn, 500_000_000, 100);

        let mut report = ScanReport::default();
        write_batch(&mut conn, 1, 1, &[seen(500_000_000, 999)], &mut report).unwrap();

        assert_eq!(report.files_updated, 1, "the row should still be updated");
        assert_eq!(completion(&conn, id), (1, Some(1450.0)));
    }

    /// A file nothing has touched must not be rewritten at all — this is the
    /// path every unchanged file in the library takes on every scan.
    #[test]
    fn an_unchanged_file_is_left_alone() {
        let mut conn = database("same");
        let id = watched_file(&mut conn, 500_000_000, 100);

        let mut report = ScanReport::default();
        write_batch(&mut conn, 1, 1, &[seen(500_000_000, 100)], &mut report).unwrap();

        assert_eq!(report.files_unchanged, 1);
        assert_eq!(report.files_updated, 0);
        assert_eq!(completion(&conn, id), (1, Some(1450.0)));
    }

    /// A file with no history is ordinary, not an error.
    #[test]
    fn growing_a_file_that_was_never_played_is_harmless() {
        let mut conn = database("unplayed");
        let mut report = ScanReport::default();
        write_batch(&mut conn, 1, 0, &[seen(60_000_000, 100)], &mut report).unwrap();
        write_batch(&mut conn, 1, 1, &[seen(500_000_000, 200)], &mut report).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM playback_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }
}
