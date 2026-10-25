//! Versions: the same film or episode in more than one file — a 4K and a
//! 1080p copy, a Director's Cut beside the cinema cut (owner, 2026-10-24: one
//! title with versions, not separate cards).
//!
//! The library already holds them as one title with several `media_files`
//! rows; what this adds is the list of those files per film or episode, the
//! version picked last time for a title, and the duplicates list in
//! Settings → Library. Which version fits the screen is decided in
//! `src/library/versions.ts`, where the file's facts and the screen are known.
//!
//! Resume points and watched ticks need nothing here: `history.rs` already
//! keeps every copy of a film or episode in step.
//!
//! The choice names the title by the provider's ids, as `my_list` does, so it
//! comes through matching again. It keeps the file's path (a film's own pick)
//! and the version's words without the size (`key`), which is how a show's
//! choice carries over to its other episodes: "4K HDR10" picked once means
//! the 4K HDR10 copy of the next episode too, where there is one.

use crate::library::Db;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// One file of a title, with what it shows.
#[derive(Debug, Serialize, PartialEq)]
pub struct VersionFile {
    pub file_id: i64,
    pub path: String,
    pub size_bytes: i64,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub episode_last: Option<i64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct VersionChoice {
    pub path: String,
    pub key: String,
}

/// A film or episode that is here more than once.
#[derive(Debug, Serialize, PartialEq)]
pub struct Duplicate {
    pub title_id: i64,
    pub title: String,
    pub year: Option<i64>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub file_ids: Vec<i64>,
    pub size_bytes: i64,
}

/// A choice is this title when its kind matches and any of its ids do.
const SAME_TITLE: &str = "c.kind = t.kind
     AND ((c.provider = t.provider AND c.provider_id = t.provider_id)
          OR (c.tmdb_id IS NOT NULL AND c.tmdb_id = t.tmdb_id)
          OR (c.imdb_id IS NOT NULL AND c.imdb_id = t.imdb_id))";

fn files_of(conn: &Connection, title_id: i64) -> rusqlite::Result<Vec<VersionFile>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, size_bytes, parsed_season, parsed_episode, parsed_episode_last
           FROM media_files WHERE title_id = ?1 AND missing = 0
          ORDER BY parsed_season, parsed_episode, size_bytes DESC, id",
    )?;
    let rows = stmt.query_map([title_id], |r| {
        Ok(VersionFile {
            file_id: r.get(0)?,
            path: r.get(1)?,
            size_bytes: r.get(2)?,
            season: r.get(3)?,
            episode: r.get(4)?,
            episode_last: r.get(5)?,
        })
    })?;
    rows.collect()
}

fn choice_of(conn: &Connection, title_id: i64) -> rusqlite::Result<Option<VersionChoice>> {
    conn.query_row(
        &format!(
            "SELECT c.path, c.key FROM version_choice c JOIN titles t ON {SAME_TITLE}
              WHERE t.id = ?1 ORDER BY c.updated_at DESC LIMIT 1"
        ),
        [title_id],
        |r| Ok(VersionChoice { path: r.get(0)?, key: r.get(1)? }),
    )
    .optional()
}

fn choose(conn: &Connection, title_id: i64, path: &str, key: &str, now: i64) -> rusqlite::Result<()> {
    // One choice per title: whatever an earlier match left under other ids goes.
    conn.execute(
        &format!(
            "DELETE FROM version_choice WHERE id IN
               (SELECT c.id FROM version_choice c JOIN titles t ON {SAME_TITLE} WHERE t.id = ?1)"
        ),
        [title_id],
    )?;
    conn.execute(
        "INSERT INTO version_choice (kind, provider, provider_id, imdb_id, tmdb_id, path, key, updated_at)
         SELECT kind, provider, provider_id, imdb_id, tmdb_id, ?2, ?3, ?4 FROM titles WHERE id = ?1",
        params![title_id, path, key, now],
    )?;
    Ok(())
}

fn duplicates(conn: &Connection) -> rusqlite::Result<Vec<Duplicate>> {
    // A film is one group; an episode is its season and number. A file with no
    // episode number in a series is left out: there is nothing to say it is the
    // same as another.
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.year,
                CASE WHEN t.kind = 'series' THEN m.parsed_season END AS s,
                CASE WHEN t.kind = 'series' THEN m.parsed_episode END AS e,
                GROUP_CONCAT(m.id), SUM(m.size_bytes), COUNT(*)
           FROM media_files m JOIN titles t ON t.id = m.title_id
          WHERE m.missing = 0 AND (t.kind <> 'series' OR m.parsed_episode IS NOT NULL)
          GROUP BY t.id, s, e HAVING COUNT(*) > 1
          ORDER BY t.title COLLATE NOCASE, t.id, s, e",
    )?;
    let rows = stmt.query_map([], |r| {
        let ids: String = r.get(5)?;
        Ok(Duplicate {
            title_id: r.get(0)?,
            title: r.get(1)?,
            year: r.get(2)?,
            season: r.get(3)?,
            episode: r.get(4)?,
            file_ids: ids.split(',').filter_map(|id| id.parse().ok()).collect(),
            size_bytes: r.get(6)?,
        })
    })?;
    rows.collect()
}

/// Every file of a title that is here, by episode, biggest first.
#[tauri::command]
pub fn title_versions(db: tauri::State<Db>, title_id: i64) -> Result<Vec<VersionFile>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    files_of(&conn, title_id).map_err(to_string_err)
}

/// The version picked last time for a title, if one was.
#[tauri::command]
pub fn version_choice(db: tauri::State<Db>, title_id: i64) -> Result<Option<VersionChoice>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    choice_of(&conn, title_id).map_err(to_string_err)
}

/// Remember the version picked for a title.
#[tauri::command]
pub fn choose_version(
    db: tauri::State<Db>,
    title_id: i64,
    path: String,
    key: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    choose(&conn, title_id, &path, &key, now_secs()).map_err(to_string_err)
}

/// Films and episodes that are here more than once, for Settings → Library.
#[tauri::command]
pub fn duplicate_titles(db: tauri::State<Db>) -> Result<Vec<Duplicate>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    duplicates(&conn).map_err(to_string_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO titles (id, kind, provider, provider_id, imdb_id, title, year, fetched_at) VALUES
               (10, 'movie', 'tmdb', '1', 'tt1', 'A Film', 1982, 0),
               (20, 'series', 'tmdb', '2', NULL, 'A Show', NULL, 0);
             INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'lib', 'movies', 0);",
        )
        .unwrap();
        for (id, path, title, size, s, e) in [
            (1, "a-2160p.mkv", 10, 900, None, None),
            (2, "a-1080p.mkv", 10, 300, None, None),
            (3, "s01e01-1080p.mkv", 20, 200, Some(1), Some(1)),
            (4, "s01e01-720p.mkv", 20, 100, Some(1), Some(1)),
            (5, "s01e02.mkv", 20, 200, Some(1), Some(2)),
        ] {
            conn.execute(
                "INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension, size_bytes,
                    modified_at, first_seen_at, last_seen_at, title_id, parsed_season, parsed_episode)
                 VALUES (?1, 1, ?2, 'lib', ?2, 'mkv', ?3, 0, 0, 0, ?4, ?5, ?6)",
                params![id, path, size, title, s, e],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn lists_a_titles_files_biggest_first() {
        let conn = library();
        let ids: Vec<i64> = files_of(&conn, 10).unwrap().iter().map(|f| f.file_id).collect();
        assert_eq!(ids, vec![1, 2]);
        conn.execute("UPDATE media_files SET missing = 1 WHERE id = 1", []).unwrap();
        let ids: Vec<i64> = files_of(&conn, 10).unwrap().iter().map(|f| f.file_id).collect();
        assert_eq!(ids, vec![2]);
    }

    #[test]
    fn remembers_one_choice_per_title() {
        let conn = library();
        assert_eq!(choice_of(&conn, 10).unwrap(), None);
        choose(&conn, 10, "a-1080p.mkv", "1080p", 100).unwrap();
        choose(&conn, 10, "a-2160p.mkv", "4K UHD · HDR10", 200).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM version_choice", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(
            choice_of(&conn, 10).unwrap(),
            Some(VersionChoice { path: "a-2160p.mkv".into(), key: "4K UHD · HDR10".into() })
        );
    }

    #[test]
    fn the_choice_outlives_matching_again() {
        let conn = library();
        choose(&conn, 10, "a-1080p.mkv", "1080p", 100).unwrap();
        conn.execute("UPDATE media_files SET title_id = NULL WHERE title_id = 10", []).unwrap();
        conn.execute("DELETE FROM titles WHERE id = 10", []).unwrap();
        // Matched again through another provider; the IMDb id is the same film.
        conn.execute(
            "INSERT INTO titles (id, kind, provider, provider_id, imdb_id, title, fetched_at)
             VALUES (11, 'movie', 'wikidata', 'Q1', 'tt1', 'A Film', 0)",
            [],
        )
        .unwrap();
        assert_eq!(choice_of(&conn, 11).unwrap().map(|c| c.path), Some("a-1080p.mkv".into()));
    }

    #[test]
    fn duplicates_are_films_and_episodes_held_twice() {
        let conn = library();
        let found = duplicates(&conn).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].title_id, found[0].season, found[0].size_bytes), (10, None, 1200));
        assert_eq!(found[0].file_ids.len(), 2);
        assert_eq!((found[1].title_id, found[1].season, found[1].episode), (20, Some(1), Some(1)));
        conn.execute("UPDATE media_files SET missing = 1 WHERE id = 4", []).unwrap();
        assert_eq!(duplicates(&conn).unwrap().len(), 1);
    }
}
