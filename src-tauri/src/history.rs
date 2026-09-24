//! Watch history that belongs to the **episode**, not to the file.
//!
//! `playback_state` is keyed by `media_files.id`, and a file row is a path. So
//! everything that gives an episode a new path gave it a blank history: moving
//! or renaming a file, replacing it with a better release, removing a library
//! folder and adding it back (the rows go with the folder), and resetting
//! matches (the titles go, and with them anything keyed on a title id). A
//! media library should remember "you watched S04E05"; the file is just the
//! copy you watched it on.
//!
//! `watch_history` is that memory. A row names what was watched by the ids the
//! providers use — IMDb, TMDB, and the provider it was matched through — plus
//! season and episode, and **references no file and no title row**, so nothing
//! the library does to its own rows can delete it.
//!
//! `playback_state` stays exactly as it was, and every screen still reads it:
//! it is now the per-copy working state, kept in step with the history at the
//! three moments that matter —
//!
//! * **something is saved** (progress, marked watched or unwatched) — the
//!   history takes it, and every other copy of the same episode follows;
//! * **a file is matched** — a moved, renamed, upgraded or re-added copy picks
//!   up the episode's history, if the history is newer than its own;
//! * **a file grows** — a partial download marked watched against a duration
//!   that was never real forgets it, in the history too, so the next match
//!   does not bring the false tick back.
//!
//! A copy's own `duration_secs` is never overwritten from another copy: it is
//! what TheIntroDB is asked with to tell releases apart, and another release's
//! length would fetch the wrong markers. A copy that has never been played
//! gets its position and its tick, and learns its length when it plays.
//!
//! Files that are not matched have no identity beyond their path, and keep
//! only their own `playback_state`, as before.

use rusqlite::{params, Connection, OptionalExtension};

/// What one file shows: a film, or one episode of a series. A file holding
/// `S01E01E02` shows two.
#[derive(Debug, Clone)]
struct Item {
    kind: String,
    provider: String,
    provider_id: String,
    imdb_id: Option<String>,
    tmdb_id: Option<String>,
    season: Option<i64>,
    episode: Option<i64>,
    label: String,
}

/// A copy's watch state, as stored in either table.
#[derive(Debug, Clone, Copy, PartialEq)]
struct State {
    position_secs: f64,
    completed: bool,
    updated_at: i64,
}

/// The items a file shows, or none when it is not matched well enough to say.
fn items_of(conn: &Connection, file_id: i64) -> rusqlite::Result<Vec<Item>> {
    let row = conn
        .query_row(
            "SELECT t.kind, t.provider, t.provider_id, t.imdb_id, t.tmdb_id, t.title,
                    m.parsed_season, m.parsed_episode,
                    COALESCE(m.parsed_episode_last, m.parsed_episode)
               FROM media_files m
               JOIN titles t ON t.id = m.title_id
              WHERE m.id = ?1",
            [file_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                ))
            },
        )
        .optional()?;

    let Some((kind, provider, provider_id, imdb_id, tmdb_id, title, season, first, last)) = row
    else {
        return Ok(Vec::new());
    };
    let blank = |s: Option<String>| s.filter(|v| !v.trim().is_empty());
    let base = Item {
        kind: kind.clone(),
        provider,
        provider_id,
        imdb_id: blank(imdb_id),
        tmdb_id: blank(tmdb_id),
        season: None,
        episode: None,
        label: title.clone(),
    };

    if kind != "series" {
        return Ok(vec![base]);
    }
    // An episode with no season or number cannot be told from its neighbours.
    let (Some(season), Some(first), Some(last)) = (season, first, last) else {
        return Ok(Vec::new());
    };
    Ok((first..=last.max(first))
        .map(|episode| Item {
            season: Some(season),
            episode: Some(episode),
            label: format!("{title} S{season:02}E{episode:02}"),
            ..base.clone()
        })
        .collect())
}

/// The history row for an item: the same film or episode, recognised by any
/// id they share. IMDb first in spirit — it is the one all three providers
/// carry — but any match will do, so a show matched through TVmaze and later
/// through TMDB is still one show.
const FIND: &str = "
    SELECT id, position_secs, completed, updated_at FROM watch_history
     WHERE kind = :kind AND season IS :season AND episode IS :episode
       AND ((:imdb IS NOT NULL AND imdb_id = :imdb)
         OR (:tmdb IS NOT NULL AND tmdb_id = :tmdb)
         OR (provider = :provider AND provider_id = :provider_id))
     ORDER BY updated_at DESC
     LIMIT 1";

fn find(conn: &Connection, item: &Item) -> rusqlite::Result<Option<(i64, State)>> {
    conn.query_row(
        FIND,
        rusqlite::named_params! {
            ":kind": item.kind, ":season": item.season, ":episode": item.episode,
            ":imdb": item.imdb_id, ":tmdb": item.tmdb_id,
            ":provider": item.provider, ":provider_id": item.provider_id,
        },
        |r| {
            Ok((
                r.get(0)?,
                State {
                    position_secs: r.get(1)?,
                    completed: r.get::<_, i64>(2)? != 0,
                    updated_at: r.get(3)?,
                },
            ))
        },
    )
    .optional()
}

fn own_state(conn: &Connection, file_id: i64) -> rusqlite::Result<Option<State>> {
    conn.query_row(
        "SELECT position_secs, completed, updated_at FROM playback_state WHERE file_id = ?1",
        [file_id],
        |r| {
            Ok(State {
                position_secs: r.get(0)?,
                completed: r.get::<_, i64>(1)? != 0,
                updated_at: r.get(2)?,
            })
        },
    )
    .optional()
}

/// Write a copy's state, keeping its own duration.
fn set_own_state(conn: &Connection, file_id: i64, state: State) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4)
         ON CONFLICT(file_id) DO UPDATE SET
            position_secs = excluded.position_secs,
            completed     = excluded.completed,
            updated_at    = excluded.updated_at",
        params![file_id, state.position_secs, state.completed as i64, state.updated_at],
    )?;
    Ok(())
}

/// Other present or missing files showing any of the same items — the other
/// copies of this episode or film.
fn copies_of(conn: &Connection, file_id: i64, items: &[Item]) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT m.id FROM media_files m
           JOIN titles t ON t.id = m.title_id
          WHERE m.id <> :file AND t.kind = :kind
            AND ((:imdb IS NOT NULL AND t.imdb_id = :imdb)
              OR (:tmdb IS NOT NULL AND t.tmdb_id = :tmdb)
              OR (t.provider = :provider AND t.provider_id = :provider_id))
            AND (:season IS NULL
              OR (m.parsed_season = :season
                  AND :episode BETWEEN m.parsed_episode
                                   AND COALESCE(m.parsed_episode_last, m.parsed_episode)))",
    )?;
    let mut found = Vec::new();
    for item in items {
        let ids = stmt.query_map(
            rusqlite::named_params! {
                ":file": file_id, ":kind": item.kind,
                ":imdb": item.imdb_id, ":tmdb": item.tmdb_id,
                ":provider": item.provider, ":provider_id": item.provider_id,
                ":season": item.season, ":episode": item.episode,
            },
            |r| r.get::<_, i64>(0),
        )?;
        for id in ids {
            let id = id?;
            if !found.contains(&id) {
                found.push(id);
            }
        }
    }
    Ok(found)
}

/// A copy's state was just saved (or cleared): make it the episode's, and
/// every other copy's.
///
/// Called after every write to `playback_state` that a person caused —
/// progress, marked watched, marked unwatched. No state means unwatched, and
/// unwatched is forgotten everywhere: "not seen" and "no history" are the
/// same thing, as `set_watched` has always said.
pub fn remember(conn: &Connection, file_id: i64) -> rusqlite::Result<()> {
    let items = items_of(conn, file_id)?;
    if items.is_empty() {
        return Ok(());
    }
    let state = own_state(conn, file_id)?;

    for item in &items {
        let existing = find(conn, item)?;
        match (state, existing) {
            (Some(s), Some((id, _))) => {
                conn.execute(
                    "UPDATE watch_history
                        SET position_secs = ?2, completed = ?3, updated_at = ?4,
                            duration_secs = (SELECT duration_secs FROM playback_state
                                              WHERE file_id = ?5),
                            imdb_id = COALESCE(imdb_id, ?6), tmdb_id = COALESCE(tmdb_id, ?7),
                            label = ?8
                      WHERE id = ?1",
                    params![
                        id, s.position_secs, s.completed as i64, s.updated_at, file_id,
                        item.imdb_id, item.tmdb_id, item.label
                    ],
                )?;
            }
            (Some(s), None) => {
                conn.execute(
                    "INSERT INTO watch_history
                        (kind, provider, provider_id, imdb_id, tmdb_id, season, episode, label,
                         position_secs, duration_secs, completed, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                             (SELECT duration_secs FROM playback_state WHERE file_id = ?12),
                             ?10, ?11)",
                    params![
                        item.kind, item.provider, item.provider_id, item.imdb_id, item.tmdb_id,
                        item.season, item.episode, item.label, s.position_secs,
                        s.completed as i64, s.updated_at, file_id
                    ],
                )?;
            }
            (None, Some((id, _))) => {
                conn.execute("DELETE FROM watch_history WHERE id = ?1", [id])?;
            }
            (None, None) => {}
        }
    }

    for copy in copies_of(conn, file_id, &items)? {
        match state {
            Some(s) => set_own_state(conn, copy, s)?,
            None => {
                conn.execute("DELETE FROM playback_state WHERE file_id = ?1", [copy])?;
            }
        }
    }
    Ok(())
}

/// Files were just matched: give each the history of what it shows, when
/// that history is newer than anything the file remembers itself.
///
/// Newer, not merely present: a file re-linked to the title it already had
/// must not have a fresher resume point of its own overwritten by an older
/// one.
pub fn restore(conn: &Connection, file_ids: &[i64]) -> rusqlite::Result<usize> {
    let mut restored = 0;
    for &file_id in file_ids {
        let items = items_of(conn, file_id)?;
        // The newest record among the items a file shows. For a double
        // episode that is whichever half was touched last.
        let mut newest: Option<State> = None;
        for item in &items {
            if let Some((_, s)) = find(conn, item)? {
                if newest.is_none_or(|n| s.updated_at > n.updated_at) {
                    newest = Some(s);
                }
            }
        }
        let Some(history) = newest else { continue };
        let own = own_state(conn, file_id)?;
        if own.is_none_or(|o| history.updated_at > o.updated_at) {
            set_own_state(conn, file_id, history)?;
            restored += 1;
        }
    }
    Ok(restored)
}

/// The file's bytes changed size — a partial download that has grown. Whatever
/// was marked watched against the short version was never real, so the
/// episode forgets it too. The position is kept, as the scanner keeps it.
pub fn forget_completion(conn: &Connection, file_id: i64) -> rusqlite::Result<()> {
    for item in items_of(conn, file_id)? {
        if let Some((id, _)) = find(conn, &item)? {
            conn.execute(
                "UPDATE watch_history SET completed = 0, duration_secs = NULL WHERE id = ?1",
                [id],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A migrated library with one TV root, and one series matched
    /// through TMDB as title 4.
    fn library() -> Connection {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pn-history-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("library.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:/tv', 'tv', 0);
             INSERT INTO titles (id, kind, provider, provider_id, imdb_id, tmdb_id, title, fetched_at)
                  VALUES (4, 'series', 'tmdb', '9001', 'tt9000001', '9001', 'Example Show', 0);",
        )
        .unwrap();
        conn
    }

    fn file(conn: &Connection, id: i64, title: Option<i64>, season: i64, episode: i64) {
        conn.execute(
            "INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                 size_bytes, modified_at, first_seen_at, last_seen_at, match_status,
                 title_id, parsed_title, parsed_season, parsed_episode)
             VALUES (?1, 1, ?2, 'C:/tv', ?2, 'mkv', 1, 0, 0, 0,
                     CASE WHEN ?3 IS NULL THEN 'parsed' ELSE 'matched' END, ?3,
                     'Example Show', ?4, ?5)",
            params![id, format!("C:/tv/file{id}.mkv"), title, season, episode],
        )
        .unwrap();
    }

    /// What `save_progress` does: write the copy's own state, then remember.
    fn play(conn: &Connection, file_id: i64, position: f64, completed: bool, at: i64) {
        conn.execute(
            "INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at)
             VALUES (?1, ?2, 1800, ?3, ?4)
             ON CONFLICT(file_id) DO UPDATE SET position_secs = excluded.position_secs,
                 completed = excluded.completed, updated_at = excluded.updated_at",
            params![file_id, position, completed as i64, at],
        )
        .unwrap();
        remember(conn, file_id).unwrap();
    }

    fn state(conn: &Connection, file_id: i64) -> Option<(f64, bool, Option<f64>)> {
        conn.query_row(
            "SELECT position_secs, completed, duration_secs FROM playback_state WHERE file_id = ?1",
            [file_id],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0, r.get(2)?)),
        )
        .optional()
        .unwrap()
    }

    fn match_to(conn: &Connection, file_id: i64, title: i64) {
        conn.execute(
            "UPDATE media_files SET title_id = ?2, match_status = 'matched' WHERE id = ?1",
            params![file_id, title],
        )
        .unwrap();
        restore(conn, &[file_id]).unwrap();
    }

    /// Moved or renamed: the scanner sees a new path and a missing one. The
    /// new row is matched and picks the history up.
    #[test]
    fn a_moved_file_keeps_its_history() {
        let conn = library();
        file(&conn, 1, Some(4), 4, 5);
        play(&conn, 1, 1750.0, true, 100);
        conn.execute("UPDATE media_files SET missing = 1 WHERE id = 1", []).unwrap();

        file(&conn, 2, None, 4, 5);
        assert_eq!(state(&conn, 2), None, "not matched yet, so nobody knows what it is");
        match_to(&conn, 2, 4);
        assert_eq!(state(&conn, 2), Some((1750.0, true, None)));
    }

    /// Removing a folder deletes its rows, and playback_state with them.
    #[test]
    fn a_folder_removed_and_added_back_keeps_its_history() {
        let conn = library();
        file(&conn, 1, Some(4), 4, 5);
        play(&conn, 1, 600.0, false, 100);
        conn.execute("DELETE FROM library_roots WHERE id = 1", []).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM playback_state", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0,
            "the cascade really did take the per-file state"
        );

        // Added back: the same folder, found again by a fresh scan.
        conn.execute(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:/tv', 'tv', 1)",
            [],
        )
        .unwrap();
        file(&conn, 9, None, 4, 5);
        match_to(&conn, 9, 4);
        assert_eq!(state(&conn, 9), Some((600.0, false, None)));
    }

    /// Resetting matches deletes every title; the re-match creates new ones
    /// with new ids. The history is keyed on the provider's ids, not ours.
    #[test]
    fn history_survives_the_title_being_recreated() {
        let conn = library();
        file(&conn, 1, Some(4), 4, 5);
        play(&conn, 1, 1750.0, true, 100);
        conn.execute("UPDATE media_files SET title_id = NULL", []).unwrap();
        conn.execute("DELETE FROM playback_state", []).unwrap();
        conn.execute("DELETE FROM titles", []).unwrap();
        conn.execute(
            "INSERT INTO titles (id, kind, provider, provider_id, imdb_id, tmdb_id, title, fetched_at)
                  VALUES (40, 'series', 'tmdb', '9001', 'tt9000001', '9001', 'Example Show', 1)",
            [],
        )
        .unwrap();
        match_to(&conn, 1, 40);
        assert_eq!(state(&conn, 1), Some((1750.0, true, None)));
    }

    /// Matched through TVmaze first, TMDB later: different provider, same
    /// show, and the IMDb id says so.
    #[test]
    fn the_same_show_through_another_provider_is_the_same_show() {
        let conn = library();
        conn.execute(
            "INSERT INTO titles (id, kind, provider, provider_id, imdb_id, title, fetched_at)
                  VALUES (5, 'series', 'tvmaze', '9002', 'tt9000001', 'Example Show', 0)",
            [],
        )
        .unwrap();
        file(&conn, 1, Some(5), 4, 5);
        play(&conn, 1, 1750.0, true, 100);

        file(&conn, 2, None, 4, 5);
        match_to(&conn, 2, 4);
        assert_eq!(state(&conn, 2), Some((1750.0, true, None)));
    }

    /// Two copies of one episode: watching either is watching the episode,
    /// and so is un-watching it. Each keeps its own length.
    #[test]
    fn copies_of_an_episode_move_together() {
        let conn = library();
        file(&conn, 1, Some(4), 4, 5);
        file(&conn, 2, Some(4), 4, 5);
        file(&conn, 3, Some(4), 4, 6);

        play(&conn, 1, 1750.0, true, 100);
        assert_eq!(state(&conn, 2), Some((1750.0, true, None)), "the other copy is watched");
        assert_eq!(state(&conn, 3), None, "a different episode is not");

        conn.execute("DELETE FROM playback_state WHERE file_id = 2", []).unwrap();
        remember(&conn, 2).unwrap(); // marked unwatched on copy 2
        assert_eq!(state(&conn, 1), None, "un-watching is the episode's too");
        assert!(restore(&conn, &[1, 2]).unwrap() == 0, "and nothing brings it back");
    }

    /// S01E01E02 in one file is both episodes; a lone E02 found later is
    /// already watched.
    #[test]
    fn a_double_episode_file_records_both_episodes() {
        let conn = library();
        file(&conn, 1, Some(4), 1, 1);
        conn.execute("UPDATE media_files SET parsed_episode_last = 2 WHERE id = 1", []).unwrap();
        play(&conn, 1, 2900.0, true, 100);

        file(&conn, 2, None, 1, 2);
        match_to(&conn, 2, 4);
        assert_eq!(state(&conn, 2), Some((2900.0, true, None)));
    }

    /// A partial download marked watched, then completed: the tick was never
    /// real, and a later match must not bring it back from the history.
    #[test]
    fn a_grown_file_forgets_it_was_watched_everywhere() {
        let conn = library();
        file(&conn, 1, Some(4), 4, 5);
        play(&conn, 1, 300.0, true, 100);
        conn.execute("UPDATE playback_state SET completed = 0, duration_secs = NULL", []).unwrap();
        forget_completion(&conn, 1).unwrap();

        file(&conn, 2, None, 4, 5);
        match_to(&conn, 2, 4);
        assert_eq!(state(&conn, 2), Some((300.0, false, None)));
    }

    /// A file that remembers something newer keeps it.
    #[test]
    fn a_fresher_resume_point_is_not_overwritten() {
        let conn = library();
        file(&conn, 1, Some(4), 4, 5);
        play(&conn, 1, 600.0, false, 100);
        conn.execute(
            "UPDATE playback_state SET position_secs = 900, updated_at = 200 WHERE file_id = 1",
            [],
        )
        .unwrap();
        assert_eq!(restore(&conn, &[1]).unwrap(), 0);
        assert_eq!(state(&conn, 1).map(|s| s.0), Some(900.0));
    }

    /// A file nobody has identified keeps its own state and writes no history.
    #[test]
    fn an_unmatched_file_leaves_no_history() {
        let conn = library();
        file(&conn, 1, None, 4, 5);
        play(&conn, 1, 600.0, false, 100);
        assert_eq!(state(&conn, 1).map(|s| s.0), Some(600.0));
        let rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM watch_history", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn films_are_remembered_too() {
        let conn = library();
        conn.execute(
            "INSERT INTO titles (id, kind, provider, provider_id, imdb_id, tmdb_id, title, fetched_at)
                  VALUES (1, 'movie', 'tmdb', '1271', 'tt0416449', '1271', '300', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                 size_bytes, modified_at, first_seen_at, last_seen_at, match_status, title_id)
             VALUES (7, 1, 'C:/m/300.mkv', 'C:/m', '300.mkv', 'mkv', 1, 0, 0, 0, 'matched', 1),
                    (8, 1, 'C:/m/300.4k.mkv', 'C:/m', '300.4k.mkv', 'mkv', 1, 0, 0, 0, 'parsed', NULL)",
            [],
        )
        .unwrap();
        play(&conn, 7, 3000.0, false, 100);
        match_to(&conn, 8, 1);
        assert_eq!(state(&conn, 8), Some((3000.0, false, None)));
    }
}
