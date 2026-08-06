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
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
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

    // One transaction per root keeps a large scan fast without holding a
    // single lock across every share.
    let tx = conn.transaction()?;
    {
        let mut select = tx.prepare(
            "SELECT id, size_bytes, modified_at FROM media_files WHERE path = ?1",
        )?;
        let mut insert = tx.prepare(
            "INSERT INTO media_files
                (root_id, path, parent_dir, file_name, extension, size_bytes,
                 modified_at, first_seen_at, last_seen_at, missing, match_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 0, 'unparsed')",
        )?;
        let mut touch = tx.prepare(
            "UPDATE media_files SET last_seen_at = ?2, missing = 0 WHERE id = ?1",
        )?;
        // Content changed: reset the parse so it gets re-evaluated.
        let mut update = tx.prepare(
            "UPDATE media_files
                SET size_bytes = ?2, modified_at = ?3, last_seen_at = ?4, missing = 0,
                    parsed_at = NULL, parsed_title = NULL, parsed_year = NULL,
                    parsed_season = NULL, parsed_episode = NULL, parsed_kind = NULL,
                    parsed_from = NULL, parsed_json = NULL, match_status = 'unparsed'
              WHERE id = ?1",
        )?;

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
            let size = meta.len() as i64;
            let modified = mtime_secs(&meta);

            report.files_seen += 1;
            seen_paths.insert(path.clone());

            let existing: Option<(i64, i64, i64)> = select
                .query_row(params![&path], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .ok();

            match existing {
                Some((id, old_size, old_mtime)) if old_size == size && old_mtime == modified => {
                    touch.execute(params![id, now])?;
                    report.files_unchanged += 1;
                }
                Some((id, _, _)) => {
                    update.execute(params![id, size, modified, now])?;
                    report.files_updated += 1;
                }
                None => {
                    let parent_dir = entry
                        .path()
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    let extension = entry
                        .path()
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_lowercase();

                    insert.execute(params![
                        root_id, &path, &parent_dir, &file_name, &extension, size, modified, now
                    ])?;
                    report.files_added += 1;
                }
            }
        }

        // Anything under this root we did not see this pass is flagged, not
        // deleted — the user may have unplugged a drive, and their watch
        // history should survive that.
        let mut stale = tx.prepare(
            "SELECT id, path FROM media_files WHERE root_id = ?1 AND missing = 0",
        )?;
        let candidates: Vec<(i64, String)> = stale
            .query_map(params![root_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut mark_missing = tx.prepare("UPDATE media_files SET missing = 1 WHERE id = ?1")?;
        for (id, path) in candidates {
            if !seen_paths.contains(&path) {
                mark_missing.execute(params![id])?;
                report.files_missing += 1;
            }
        }
    }
    tx.commit()?;

    Ok(())
}
