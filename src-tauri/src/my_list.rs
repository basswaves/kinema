//! My list: titles kept handy, to watch or loved (owner, 2026-10-24: one list,
//! not separate favourites and a watchlist).
//!
//! Local only. Nothing here is ever queued for SIMKL or Trakt — both are one
//! way and only receive history (CLAUDE.md), and a list is not history. The
//! weekly safety copy is the whole database (`VACUUM INTO`), so it keeps this
//! table without being told.
//!
//! An entry names the title by the provider's ids, not by `titles.id`, the
//! way watch_history does: matching again makes new title rows, and the list
//! must come through that. A title not in the library just now (its folder
//! offline) keeps its entry and comes back with it.

use crate::library::Db;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct ListEntry {
    pub title_id: i64,
    pub added_at: i64,
}

/// An entry is this title when its kind matches and any of its ids do.
const SAME_TITLE: &str = "e.kind = t.kind
     AND ((e.provider = t.provider AND e.provider_id = t.provider_id)
          OR (e.tmdb_id IS NOT NULL AND e.tmdb_id = t.tmdb_id)
          OR (e.imdb_id IS NOT NULL AND e.imdb_id = t.imdb_id))";

fn read(conn: &Connection) -> rusqlite::Result<Vec<ListEntry>> {
    // Newest first: the rail starts with what was added last.
    let mut stmt = conn.prepare(&format!(
        "SELECT t.id, MIN(e.added_at) AS added FROM titles t JOIN my_list e ON {SAME_TITLE}
          GROUP BY t.id ORDER BY added DESC, t.id DESC"
    ))?;
    let rows = stmt.query_map([], |row| {
        Ok(ListEntry {
            title_id: row.get(0)?,
            added_at: row.get(1)?,
        })
    })?;
    rows.collect()
}

fn set(conn: &Connection, title_id: i64, on: bool, now: i64) -> rusqlite::Result<()> {
    if on {
        // Adding again keeps the first date: the place on the rail is when it
        // was first put there.
        conn.execute(
            &format!(
                "INSERT OR IGNORE INTO my_list (kind, provider, provider_id, imdb_id, tmdb_id, added_at)
                 SELECT t.kind, t.provider, t.provider_id, t.imdb_id, t.tmdb_id, ?2 FROM titles t
                  WHERE t.id = ?1
                    AND NOT EXISTS (SELECT 1 FROM my_list e WHERE {SAME_TITLE})"
            ),
            params![title_id, now],
        )?;
    } else {
        conn.execute(
            &format!(
                "DELETE FROM my_list WHERE id IN
                   (SELECT e.id FROM my_list e JOIN titles t ON {SAME_TITLE} WHERE t.id = ?1)"
            ),
            params![title_id],
        )?;
    }
    Ok(())
}

/// Everything on My list, newest first.
#[tauri::command]
pub fn my_list(db: tauri::State<Db>) -> Result<Vec<ListEntry>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    read(&conn).map_err(to_string_err)
}

/// Put a title on My list, or take it off.
#[tauri::command]
pub fn set_in_my_list(db: tauri::State<Db>, title_id: i64, on: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    set(&conn, title_id, on, now_secs()).map_err(to_string_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at) VALUES
               (10, 'movie', 'tmdb', '1', 'A Film', 0), (20, 'series', 'tmdb', '2', 'A Show', 0);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn adds_newest_first_and_removes() {
        let conn = library();
        set(&conn, 10, true, 100).unwrap();
        set(&conn, 20, true, 200).unwrap();
        let ids: Vec<i64> = read(&conn).unwrap().iter().map(|e| e.title_id).collect();
        assert_eq!(ids, vec![20, 10]);
        set(&conn, 20, false, 300).unwrap();
        assert_eq!(read(&conn).unwrap(), vec![ListEntry { title_id: 10, added_at: 100 }]);
    }

    #[test]
    fn adding_twice_keeps_the_first_date() {
        let conn = library();
        set(&conn, 10, true, 100).unwrap();
        set(&conn, 10, true, 500).unwrap();
        assert_eq!(read(&conn).unwrap(), vec![ListEntry { title_id: 10, added_at: 100 }]);
    }

    #[test]
    fn the_entry_outlives_matching_again() {
        let conn = library();
        set(&conn, 10, true, 100).unwrap();
        conn.execute("DELETE FROM titles WHERE id = 10", []).unwrap();
        assert!(read(&conn).unwrap().is_empty());
        // Matched again: a new row for the same film.
        conn.execute(
            "INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at)
             VALUES (11, 'movie', 'tmdb', '1', 'A Film', 0)",
            [],
        )
        .unwrap();
        assert_eq!(read(&conn).unwrap(), vec![ListEntry { title_id: 11, added_at: 100 }]);
    }

    #[test]
    fn another_provider_is_the_same_title_by_its_imdb_id() {
        let conn = library();
        conn.execute("UPDATE titles SET imdb_id = 'tt1' WHERE id = 10", []).unwrap();
        set(&conn, 10, true, 100).unwrap();
        conn.execute(
            "INSERT INTO titles (id, kind, provider, provider_id, imdb_id, title, fetched_at)
             VALUES (12, 'movie', 'wikidata', 'Q1', 'tt1', 'A Film', 0)",
            [],
        )
        .unwrap();
        // Already on the list as 12 too, so adding 12 adds nothing; removing it removes the one entry.
        set(&conn, 12, true, 200).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM my_list", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        set(&conn, 12, false, 300).unwrap();
        assert!(read(&conn).unwrap().is_empty());
    }

    #[test]
    fn removing_what_is_not_there_is_fine() {
        let conn = library();
        set(&conn, 10, false, 100).unwrap();
        assert!(read(&conn).unwrap().is_empty());
    }
}
