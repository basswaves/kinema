//! Tauri commands exposing the library to the frontend.

use crate::util::{now_secs, to_string_err};
use crate::scanner::{self, ScanReport};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

/// The scanner's own connection to the same database file.
///
/// Separate from `Db` because a scan is the one operation here that can run for
/// minutes — a NAS share, asleep or over a slow link — and it used to hold the
/// single lock for all of it. Every other command blocked behind it: the rails
/// would not load, a detail page would not open, and a resume point could not be
/// saved. WAL was already enabled but with one connection there was nothing for
/// it to do.
pub struct ScanDb(pub Mutex<Connection>);

#[derive(Serialize)]
pub struct LibraryRoot {
    pub id: i64,
    pub path: String,
    pub kind: String,
    pub file_count: i64,
    /// What a Videos folder is called on its tile (`videos.rs`); `None` for
    /// films and shows, which need none.
    pub name: Option<String>,
}

/// The library folder kinds: films, shows, and Videos folders (`videos.rs`).
fn check_kind(kind: &str) -> Result<(), String> {
    if kind == "movies" || kind == "tv" || kind == crate::videos::KIND {
        Ok(())
    } else {
        Err(format!("unknown library kind: {kind}"))
    }
}

/// A Videos folder's name: the one given, else the folder's own.
fn root_name(kind: &str, path: &str, given: Option<String>) -> Option<String> {
    if kind != crate::videos::KIND {
        return None;
    }
    let given = given.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    Some(given.unwrap_or_else(|| crate::videos::folder_name(path)))
}

#[derive(Serialize)]
pub struct MediaFile {
    pub id: i64,
    pub path: String,
    pub parent_dir: String,
    pub file_name: String,
    pub size_bytes: i64,
    pub missing: bool,
    pub match_status: String,
    pub parsed_title: Option<String>,
    pub parsed_year: Option<i64>,
    pub parsed_season: Option<i64>,
    pub parsed_episode: Option<i64>,
    pub parsed_kind: Option<String>,
    pub parsed_from: Option<String>,
    pub title_id: Option<i64>,
    pub match_confidence: Option<f64>,
    pub match_reason: Option<String>,
    /// Canonical title from the metadata provider, once matched.
    pub matched_title: Option<String>,
    /// Episode name for this file's season/episode, once fetched.
    pub episode_name: Option<String>,
}

/// A parse result produced by guessit-js in the frontend and written back.
#[derive(Deserialize)]
pub struct ParseResult {
    pub id: i64,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    /// The last episode a multi-episode file covers (`S01E01E02` → 2), or
    /// `None` for a file holding one. Defaults so an older frontend still works.
    #[serde(default)]
    pub episode_last: Option<i64>,
    pub kind: Option<String>,
    pub from: Option<String>,
    pub raw_json: Option<String>,
}

#[derive(Serialize)]
pub struct LibraryStats {
    pub total: i64,
    pub unparsed: i64,
    pub parsed: i64,
    pub missing: i64,
    pub total_bytes: i64,
}

/// A path in the one form this app compares against, for overlap tests only.
///
/// Lower-cased, backslashes normalised, trailing separator removed. Windows
/// paths are case-insensitive and `library_roots.path` is a case-*sensitive*
/// `UNIQUE` column, so `D:\Media` and `D:\media` were two different roots as
/// far as SQLite was concerned and one library as far as the disk was: every
/// file got scanned twice, under two ids, and appeared twice on every shelf.
///
/// Deliberately not what gets stored. The path the user picked is the path they
/// see in Settings, and lower-casing a display string to win an argument with
/// SQLite is the wrong trade.
fn comparable(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

/// Whether `inner` is `outer` or sits beneath it.
fn is_within(inner: &str, outer: &str) -> bool {
    inner == outer || inner.starts_with(&format!("{outer}/"))
}

/// Async only for the folder check, which may be the first thing to wake a
/// sleeping NAS; the database work after it is as quick as ever.
#[tauri::command]
pub async fn add_library_root(
    db: tauri::State<'_, Db>,
    path: String,
    kind: String,
    name: Option<String>,
) -> Result<i64, String> {
    check_kind(&kind)?;
    let probe = path.clone();
    if !crate::jobs::off_main(move || Ok(crate::files::is_dir(std::path::Path::new(&probe)))).await? {
        return Err(format!("not a directory: {path}"));
    }

    let conn = db.0.lock().map_err(to_string_err)?;

    // Reject a root that overlaps one already here, in either direction. A
    // folder inside an existing root scans the same files a second time; a
    // folder *containing* one does the same from the other end. Neither fails
    // loudly — you just get every title twice — so it has to be refused here.
    let existing: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, path FROM library_roots")
            .map_err(to_string_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get::<_, String>(1)?)))
            .map_err(to_string_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(to_string_err)?
    };

    let candidate = comparable(&path);
    for (id, other) in &existing {
        let known = comparable(other);
        if known == candidate {
            // Already here, possibly spelled differently. Hand back the
            // existing row rather than erroring: pressing Add twice on the same
            // folder is not a mistake worth a message.
            return Ok(*id);
        }
        if is_within(&candidate, &known) {
            return Err(format!(
                "That folder is already inside a library folder:\n{other}\n\n\
                 Adding it again would scan everything in it twice."
            ));
        }
        if is_within(&known, &candidate) {
            return Err(format!(
                "That folder contains a library folder you have already added:\n{other}\n\n\
                 Remove that one first, or pick a folder that does not contain it."
            ));
        }
    }

    conn.execute(
        "INSERT OR IGNORE INTO library_roots (path, kind, added_at, name) VALUES (?1, ?2, ?3, ?4)",
        params![&path, &kind, now_secs(), root_name(&kind, &path, name)],
    )
    .map_err(to_string_err)?;

    conn.query_row(
        "SELECT id FROM library_roots WHERE path = ?1",
        params![&path],
        |r| r.get(0),
    )
    .map_err(to_string_err)
}

/// Library folders already added that sit inside `path`. When there are some,
/// adding `path` is refused ([`add_library_root`]); the app then offers to
/// merge them into it ([`merge_library_roots`]) rather than leaving the person
/// to remove them one by one.
#[tauri::command]
pub fn library_roots_inside(db: tauri::State<Db>, path: String) -> Result<Vec<LibraryRoot>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    roots_inside(&conn, &path)
}

fn roots_inside(conn: &rusqlite::Connection, path: &str) -> Result<Vec<LibraryRoot>, String> {
    let candidate = comparable(path);
    Ok(list_roots(conn)?
        .into_iter()
        .filter(|root| {
            let known = comparable(&root.path);
            known != candidate && is_within(&known, &candidate)
        })
        .collect())
}

/// Add `path` as a library folder and take over the folders already inside it.
///
/// Their files move to the new folder **as they are** - same rows, so matches,
/// watch history and resume points stay. Removing the folders and adding the
/// new one would not do that: a removed folder takes its files, and everything
/// recorded about them, with it. Only folders of the same kind merge (a movies
/// folder holding a TV folder is a different question), and the next scan picks
/// up whatever else the new folder holds.
#[tauri::command]
pub async fn merge_library_roots(
    db: tauri::State<'_, Db>,
    path: String,
    kind: String,
    name: Option<String>,
) -> Result<i64, String> {
    check_kind(&kind)?;
    let probe = path.clone();
    if !crate::jobs::off_main(move || Ok(crate::files::is_dir(std::path::Path::new(&probe)))).await? {
        return Err(format!("not a directory: {path}"));
    }
    let mut conn = db.0.lock().map_err(to_string_err)?;
    merge_roots(&mut conn, &path, &kind, name.as_deref())
}

fn merge_roots(conn: &mut rusqlite::Connection, path: &str, kind: &str, name: Option<&str>) -> Result<i64, String> {
    let candidate = comparable(path);
    let roots = list_roots(conn)?;
    for root in &roots {
        let known = comparable(&root.path);
        if known == candidate || is_within(&candidate, &known) {
            return Err(format!(
                "That folder is already in a library folder:\n{}",
                root.path
            ));
        }
    }
    let inside = roots_inside(conn, path)?;
    if inside.is_empty() {
        return Err("There is no library folder inside that folder to merge.".into());
    }
    if let Some(other) = inside.iter().find(|root| root.kind != kind) {
        return Err(format!(
            "That folder holds a {} library folder, so it cannot be merged into a {} one:\n{}",
            other.kind, kind, other.path
        ));
    }

    let tx = conn.transaction().map_err(to_string_err)?;
    tx.execute(
        "INSERT INTO library_roots (path, kind, added_at, name) VALUES (?1, ?2, ?3, ?4)",
        // A Videos folder keeps the name typed for it, else the first merged one's.
        params![
            path,
            kind,
            now_secs(),
            name.map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_string)
                .or_else(|| inside.iter().find_map(|r| r.name.clone()))
        ],
    )
    .map_err(to_string_err)?;
    let new_id = tx.last_insert_rowid();
    for root in &inside {
        tx.execute(
            "UPDATE media_files SET root_id = ?1 WHERE root_id = ?2",
            params![new_id, root.id],
        )
        .map_err(to_string_err)?;
        tx.execute("DELETE FROM library_roots WHERE id = ?1", params![root.id])
            .map_err(to_string_err)?;
    }
    tx.commit().map_err(to_string_err)?;
    Ok(new_id)
}

#[tauri::command]
pub fn remove_library_root(db: tauri::State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.execute("DELETE FROM library_roots WHERE id = ?1", params![id])
        .map_err(to_string_err)?;
    Ok(())
}

#[tauri::command]
pub fn list_library_roots(db: tauri::State<Db>) -> Result<Vec<LibraryRoot>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    list_roots(&conn)
}

fn list_roots(conn: &rusqlite::Connection) -> Result<Vec<LibraryRoot>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT r.id, r.path, r.kind,
                    (SELECT COUNT(*) FROM media_files m WHERE m.root_id = r.id), r.name
             FROM library_roots r ORDER BY r.id",
        )
        .map_err(to_string_err)?;

    let rows = stmt
        .query_map([], |r| {
            Ok(LibraryRoot {
                id: r.get(0)?,
                path: r.get(1)?,
                kind: r.get(2)?,
                file_count: r.get(3)?,
                name: r.get(4)?,
            })
        })
        .map_err(to_string_err)?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_string_err)
}

/// Walk every configured root. Uses `ScanDb`, never `Db` — see the note there.
///
/// **Async, and the walk itself on a blocking thread.** A Tauri command that is
/// not `async` runs on the main thread, the one that also serves every other
/// request from the UI. This was such a command, and it runs at every launch:
/// over a sleeping NAS the whole app waited behind it — the rails, a detail
/// page, and the player, which asks for the resume point before it can load
/// anything, with the window see-through the whole time.
#[tauri::command]
pub async fn scan_library(app: tauri::AppHandle) -> Result<ScanReport, String> {
    use tauri::Manager;
    // A second walk would wait for the first on `ScanDb` and then find the
    // same thing again. See `jobs::Jobs`.
    let running = app
        .state::<crate::jobs::Jobs>()
        .try_start(crate::jobs::Job::Scan)
        .ok_or("A scan is already running.")?;

    tauri::async_runtime::spawn_blocking(move || {
        let _running = running;
        let db = app.state::<ScanDb>();
        let mut conn = db.0.lock().map_err(to_string_err)?;
        let report = scanner::scan_all(&mut conn).map_err(to_string_err)?;
        // Lets SQLite refresh the statistics its query planner chooses
        // indexes by, for the tables this scan has just changed. Cheap (it
        // looks only at what is stale) and best effort: the library works
        // the same without it.
        let _ = conn.execute_batch("PRAGMA optimize");
        Ok(report)
    })
    .await
    .map_err(to_string_err)?
}

/// Files awaiting a parse pass. The frontend runs guessit-js over these and
/// writes the results back via `save_parse_results`.
#[tauri::command]
pub fn list_unparsed(db: tauri::State<Db>, limit: i64) -> Result<Vec<MediaFile>, String> {
    query_files(
        db,
        "WHERE m.match_status = 'unparsed' AND m.missing = 0 ORDER BY m.id LIMIT ?1",
        limit,
    )
}

#[tauri::command]
pub fn list_media_files(db: tauri::State<Db>, limit: i64) -> Result<Vec<MediaFile>, String> {
    query_files(
        db,
        "WHERE m.missing = 0 ORDER BY m.parsed_title, m.parsed_season, m.parsed_episode LIMIT ?1",
        limit,
    )
}

/// Same as `query_files`, exposed for the metadata module's own queries.
pub fn query_files_public(
    db: tauri::State<Db>,
    where_clause: &str,
    limit: i64,
) -> Result<Vec<MediaFile>, String> {
    query_files(db, where_clause, limit)
}

fn query_files(
    db: tauri::State<Db>,
    where_clause: &str,
    limit: i64,
) -> Result<Vec<MediaFile>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    // Episodes join on the *parsed* season/episode, so a file shows the real
    // episode name only when its numbering actually exists in the fetched data
    // — a mismatch stays visible instead of being papered over.
    let sql = format!(
        "SELECT m.id, m.path, m.parent_dir, m.file_name, m.size_bytes, m.missing, m.match_status,
                m.parsed_title, m.parsed_year, m.parsed_season, m.parsed_episode, m.parsed_kind,
                m.parsed_from, m.title_id, m.match_confidence, m.match_reason,
                t.title AS matched_title, e.name AS episode_name
         FROM media_files m
         LEFT JOIN titles t ON t.id = m.title_id
         LEFT JOIN episodes e ON e.title_id = m.title_id
                             AND e.season  = m.parsed_season
                             AND e.episode = m.parsed_episode
         {where_clause}"
    );

    let mut stmt = conn.prepare(&sql).map_err(to_string_err)?;
    let rows = stmt
        .query_map(params![limit], |r| {
            Ok(MediaFile {
                id: r.get(0)?,
                path: r.get(1)?,
                parent_dir: r.get(2)?,
                file_name: r.get(3)?,
                size_bytes: r.get(4)?,
                missing: r.get::<_, i64>(5)? != 0,
                match_status: r.get(6)?,
                parsed_title: r.get(7)?,
                parsed_year: r.get(8)?,
                parsed_season: r.get(9)?,
                parsed_episode: r.get(10)?,
                parsed_kind: r.get(11)?,
                parsed_from: r.get(12)?,
                title_id: r.get(13)?,
                match_confidence: r.get(14)?,
                match_reason: r.get(15)?,
                matched_title: r.get(16)?,
                episode_name: r.get(17)?,
            })
        })
        .map_err(to_string_err)?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_string_err)
}

#[tauri::command]
pub fn save_parse_results(
    db: tauri::State<Db>,
    results: Vec<ParseResult>,
) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    let tx = conn.transaction().map_err(to_string_err)?;
    let now = now_secs();
    let mut written = 0usize;

    {
        let mut stmt = tx
            .prepare(
                "UPDATE media_files
                    SET parsed_at = ?2, parsed_title = ?3, parsed_year = ?4,
                        parsed_season = ?5, parsed_episode = ?6, parsed_kind = ?7,
                        parsed_from = ?8, parsed_json = ?9, parsed_episode_last = ?10,
                        match_status = 'parsed'
                  WHERE id = ?1",
            )
            .map_err(to_string_err)?;

        for r in results {
            stmt.execute(params![
                r.id, now, r.title, r.year, r.season, r.episode, r.kind, r.from, r.raw_json,
                r.episode_last
            ])
            .map_err(to_string_err)?;
            written += 1;
        }
    }

    tx.commit().map_err(to_string_err)?;
    Ok(written)
}

/// Clears every parse result so the parser can be re-run after a change to the
/// parsing rules. Scan data is untouched — this never re-reads the filesystem.
#[tauri::command]
pub fn reset_parse(db: tauri::State<Db>) -> Result<usize, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    // Match links must go too. Leaving title_id set while the file claims to
    // be unparsed is an inconsistent state, and it strands titles that nothing
    // points at any more.
    let n = crate::lifecycle::reset_parses(&conn).map_err(to_string_err)?;

    conn.execute(
        "DELETE FROM titles
          WHERE id NOT IN (SELECT title_id FROM media_files WHERE title_id IS NOT NULL)",
        [],
    )
    .map_err(to_string_err)?;

    Ok(n)
}

#[tauri::command]
pub fn library_stats(db: tauri::State<Db>) -> Result<LibraryStats, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.query_row(
        "SELECT COUNT(*),
                SUM(CASE WHEN match_status = 'unparsed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN match_status = 'parsed'   THEN 1 ELSE 0 END),
                SUM(CASE WHEN missing = 1 THEN 1 ELSE 0 END),
                COALESCE(SUM(size_bytes), 0)
         FROM media_files",
        [],
        |r| {
            Ok(LibraryStats {
                total: r.get(0)?,
                unparsed: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                parsed: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                missing: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                total_bytes: r.get(4)?,
            })
        },
    )
    .map_err(to_string_err)
}

#[cfg(test)]
mod tests {
    use super::{comparable, is_within, merge_roots, roots_inside};

    /// An in-memory library with two TV folders and a film folder, one file
    /// each, and a watch position on the first file.
    fn library() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             INSERT INTO library_roots (id, path, kind, added_at) VALUES
                 (1, 'D:\\Media\\Shows A', 'tv', 0),
                 (2, 'd:\\media\\Shows B\\', 'tv', 0),
                 (3, 'D:\\Media\\Films', 'movies', 0);
             INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                 size_bytes, modified_at, first_seen_at, last_seen_at) VALUES
                 (1, 1, 'D:\\Media\\Shows A\\a.mkv', 'D:\\Media\\Shows A', 'a.mkv', 'mkv', 1, 1, 1, 1),
                 (2, 2, 'D:\\Media\\Shows B\\b.mkv', 'D:\\Media\\Shows B', 'b.mkv', 'mkv', 1, 1, 1, 1),
                 (3, 3, 'D:\\Media\\Films\\c.mkv', 'D:\\Media\\Films', 'c.mkv', 'mkv', 1, 1, 1, 1);
             INSERT INTO playback_state (file_id, position_secs, completed, updated_at)
                 VALUES (1, 812.5, 0, 1);",
        )
        .unwrap();
        conn
    }

    fn root_ids_of_files(conn: &rusqlite::Connection) -> Vec<(i64, i64)> {
        let mut stmt = conn.prepare("SELECT id, root_id FROM media_files ORDER BY id").unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    /// The point of merging rather than remove-and-add: the files keep their
    /// ids, so what is recorded about them (a resume point here) survives.
    #[test]
    fn merging_keeps_the_files_and_their_history() {
        let mut conn = library();
        let inside = roots_inside(&conn, r"D:\Media").unwrap();
        assert_eq!(inside.len(), 3);

        // The film folder is a different kind, so the whole merge is refused
        // and nothing changes.
        let refused = merge_roots(&mut conn, r"D:\Media", "tv", None).unwrap_err();
        assert!(refused.contains("movies library folder"), "got {refused}");
        assert_eq!(root_ids_of_files(&conn), vec![(1, 1), (2, 2), (3, 3)]);

        conn.execute("DELETE FROM library_roots WHERE id = 3", []).unwrap();
        // A typed name is kept through the merge (S5: it was lost).
        let id = merge_roots(&mut conn, r"D:\Media", "tv", Some(" Home videos ")).unwrap();
        assert_eq!(root_ids_of_files(&conn), vec![(1, id), (2, id)]);
        let name: Option<String> =
            conn.query_row("SELECT name FROM library_roots WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(name.as_deref(), Some("Home videos"));
        let roots: i64 = conn.query_row("SELECT COUNT(*) FROM library_roots", [], |r| r.get(0)).unwrap();
        assert_eq!(roots, 1);
        let position: f64 = conn
            .query_row("SELECT position_secs FROM playback_state WHERE file_id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(position, 812.5);
    }

    /// Merging is for a folder that holds library folders, nothing else.
    #[test]
    fn merging_refuses_what_is_not_a_parent() {
        let mut conn = library();
        // Inside an existing folder, and the same folder: not parents.
        assert!(merge_roots(&mut conn, r"D:\Media\Shows A\Season 1", "tv", None).is_err());
        assert!(merge_roots(&mut conn, r"D:\Media\Shows A", "tv", None).is_err());
        // A sibling with a shared prefix holds nothing.
        assert!(merge_roots(&mut conn, r"D:\Media2", "tv", None).is_err());
        assert!(roots_inside(&conn, r"D:\Media2").unwrap().is_empty());
        assert_eq!(root_ids_of_files(&conn), vec![(1, 1), (2, 2), (3, 3)]);
    }

    #[test]
    fn windows_paths_compare_case_insensitively() {
        assert_eq!(comparable(r"D:\Media"), comparable(r"d:\media"));
        assert_eq!(comparable(r"D:\Media\"), comparable(r"D:\Media"));
        assert_eq!(comparable(r"D:\Media"), comparable("D:/Media"));
    }

    #[test]
    fn a_trailing_separator_does_not_make_a_different_root() {
        assert_eq!(comparable(r"\nas\share\tv\"), comparable(r"\nas\share\tv"));
    }

    #[test]
    fn nesting_is_detected_in_both_directions() {
        let outer = comparable(r"D:\Media");
        let inner = comparable(r"D:\Media\TV Shows");
        assert!(is_within(&inner, &outer));
        assert!(!is_within(&outer, &inner));
    }

    #[test]
    fn a_root_is_within_itself() {
        let one = comparable(r"D:\Media");
        assert!(is_within(&one, &one));
    }

    /// The bug a naive `starts_with` would introduce: these are siblings, and
    /// refusing the second would be worse than the duplicate it is preventing.
    #[test]
    fn a_sibling_with_a_shared_prefix_is_not_nested() {
        let media = comparable(r"D:\Media");
        let media2 = comparable(r"D:\Media2");
        assert!(!is_within(&media2, &media));
        assert!(!is_within(&media, &media2));
    }
}
