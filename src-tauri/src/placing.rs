//! Files and title (GitHub #14, option A piece 1): which files a title holds,
//! folder by folder and season by season, and a person's choice of where some
//! of them go — another season, other episode numbers, a title of their own,
//! or back to Needs attention.
//!
//! Every change of status goes through `lifecycle.rs` (`placed`, `unplaced`,
//! `matched`, `unlinked`); this module only reads, and adds the one rule for a
//! new file in a folder whose others were placed by hand: it waits for one
//! press instead of landing on whatever its name says.
//!
//! **No file is opened, renamed, moved or written beside.** Only rows in the
//! library database change, so a file that is being seeded stays exactly as
//! it was.

use crate::library::Db;
use crate::lifecycle::{self, Placement};
use crate::util::to_string_err;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

/// The reason a new file beside hand-placed ones waits with.
pub const BESIDE_REASON: &str = "beside files placed by hand";

/// One file of a title, with both its numbers: where it is now, and what its
/// name says. They differ only when a person placed it.
#[derive(Debug, Serialize, PartialEq)]
pub struct TitleFile {
    pub file_id: i64,
    pub path: String,
    pub parent_dir: String,
    pub file_name: String,
    /// The library folder it was found in.
    pub root_path: Option<String>,
    /// Not found at the last scan (a drive not plugged in, a share asleep).
    pub missing: bool,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub episode_last: Option<i64>,
    pub name_season: Option<i64>,
    pub name_episode: Option<i64>,
    pub name_episode_last: Option<i64>,
    pub placed: bool,
    pub parsed_title: Option<String>,
}

pub fn files_of(conn: &Connection, title_id: i64) -> rusqlite::Result<Vec<TitleFile>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.path, m.parent_dir, m.file_name, r.path, m.missing,
                m.parsed_season, m.parsed_episode, m.parsed_episode_last,
                CASE WHEN m.placed_from IS NULL THEN m.parsed_season
                     ELSE json_extract(m.placed_from, '$.season') END,
                CASE WHEN m.placed_from IS NULL THEN m.parsed_episode
                     ELSE json_extract(m.placed_from, '$.episode') END,
                CASE WHEN m.placed_from IS NULL THEN m.parsed_episode_last
                     ELSE json_extract(m.placed_from, '$.episode_last') END,
                m.placed_from IS NOT NULL, m.parsed_title
           FROM media_files m LEFT JOIN library_roots r ON r.id = m.root_id
          WHERE m.title_id = ?1
          ORDER BY m.parent_dir, m.parsed_season, m.parsed_episode, m.file_name",
    )?;
    let rows = stmt.query_map([title_id], |r| {
        Ok(TitleFile {
            file_id: r.get(0)?,
            path: r.get(1)?,
            parent_dir: r.get(2)?,
            file_name: r.get(3)?,
            root_path: r.get(4)?,
            missing: r.get::<_, i64>(5)? != 0,
            season: r.get(6)?,
            episode: r.get(7)?,
            episode_last: r.get(8)?,
            name_season: r.get(9)?,
            name_episode: r.get(10)?,
            name_episode_last: r.get(11)?,
            placed: r.get(12)?,
            parsed_title: r.get(13)?,
        })
    })?;
    rows.collect()
}

/// Files just read from their names that sit in a folder where a person
/// placed the others by hand: they wait in Needs attention for one press
/// ("Same again?") instead of landing where their names say. Without this a
/// seventh file named S01E07 beside six placed on Specials would quietly
/// stack on season 1. Folders nobody placed by hand are untouched.
pub fn hold_beside_placed(conn: &Connection, ids: &[i64]) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare_cached(
        "SELECT 1 FROM media_files m
          WHERE m.id = ?1 AND m.placed_from IS NULL AND m.title_id IS NULL
            AND m.match_hold = 0 AND m.match_status = 'parsed'
            AND EXISTS (SELECT 1 FROM media_files p
                         WHERE p.parent_dir = m.parent_dir AND p.id <> m.id
                           AND p.placed_from IS NOT NULL AND p.title_id IS NOT NULL)",
    )?;
    let mut held = Vec::new();
    for &id in ids {
        if stmt.exists([id])? {
            held.push(id);
        }
    }
    if held.is_empty() {
        return Ok(0);
    }
    lifecycle::held_beside(conn, &held, BESIDE_REASON)
}

/// Where the hand-placed files beside these went: the title, the season most
/// of them went to, and by how much their numbers were moved.
#[derive(Debug, Serialize, PartialEq)]
pub struct Beside {
    pub title_id: i64,
    pub title: String,
    pub season: Option<i64>,
    pub shift: i64,
}

pub fn beside(conn: &Connection, file_ids: &[i64]) -> rusqlite::Result<Option<Beside>> {
    let Some(&first) = file_ids.first() else { return Ok(None) };
    let mut stmt = conn.prepare(
        "SELECT p.title_id, t.title, p.parsed_season,
                p.parsed_episode - json_extract(p.placed_from, '$.episode')
           FROM media_files m
           JOIN media_files p ON p.parent_dir = m.parent_dir AND p.id <> m.id
           JOIN titles t ON t.id = p.title_id
          WHERE m.id = ?1 AND p.placed_from IS NOT NULL",
    )?;
    let rows = stmt
        .query_map([first], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, Option<i64>>(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // The most common choice wins; ties go to the first file's.
    let mut votes: HashMap<(i64, Option<i64>, i64), usize> = HashMap::new();
    let mut order = Vec::new();
    for (title_id, _, season, shift) in &rows {
        let key = (*title_id, *season, shift.unwrap_or(0));
        if !votes.contains_key(&key) {
            order.push(key);
        }
        *votes.entry(key).or_default() += 1;
    }
    let mut best = None;
    for k in order {
        if best.is_none_or(|b| votes[&k] > votes[&b]) {
            best = Some(k);
        }
    }
    let Some(best) = best else { return Ok(None) };
    let title = rows.iter().find(|r| r.0 == best.0).map(|r| r.1.clone()).unwrap_or_default();
    Ok(Some(Beside { title_id: best.0, title, season: best.1, shift: best.2 }))
}

/// "Same again": these files go where their placed neighbours went.
pub fn place_beside(conn: &mut Connection, file_ids: &[i64]) -> Result<Beside, String> {
    let to = beside(conn, file_ids).map_err(to_string_err)?.ok_or("The files beside these are no longer placed.")?;
    let reason = format!("manual: same as the files beside it, “{}”", to.title);
    let mut places = Vec::new();
    for &id in file_ids {
        let (episode, last): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT parsed_episode, parsed_episode_last FROM media_files WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(to_string_err)?
            .unwrap_or((None, None));
        places.push(Placement {
            file_id: id,
            season: to.season,
            episode: episode.map(|e| e + to.shift),
            episode_last: last.map(|e| e + to.shift),
        });
    }
    lifecycle::matched(conn, file_ids, to.title_id, None, Some(&reason)).map_err(to_string_err)?;
    lifecycle::placed(conn, &places, Some(&reason)).map_err(to_string_err)?;
    crate::history::restore(conn, file_ids).map_err(to_string_err)?;
    Ok(to)
}

// ---- commands -------------------------------------------------------------------

#[tauri::command]
pub fn title_files(db: tauri::State<Db>, title_id: i64) -> Result<Vec<TitleFile>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    files_of(&conn, title_id).map_err(to_string_err)
}

/// Another season or other numbers for files already on a title.
#[tauri::command]
pub fn place_files(db: tauri::State<Db>, placements: Vec<Placement>, reason: String) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    let n = lifecycle::placed(&mut conn, &placements, Some(&reason)).map_err(to_string_err)?;
    let ids: Vec<i64> = placements.iter().map(|p| p.file_id).collect();
    // What it is now may have been watched before, under another file.
    crate::history::restore(&conn, &ids).map_err(to_string_err)?;
    Ok(n)
}

#[tauri::command]
pub fn unplace_files(db: tauri::State<Db>, file_ids: Vec<i64>) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    let n = lifecycle::unplaced(&mut conn, &file_ids).map_err(to_string_err)?;
    crate::history::restore(&conn, &file_ids).map_err(to_string_err)?;
    Ok(n)
}

#[tauri::command]
pub fn placed_beside(db: tauri::State<Db>, file_ids: Vec<i64>) -> Result<Option<Beside>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    beside(&conn, &file_ids).map_err(to_string_err)
}

#[tauri::command]
pub fn place_as_beside(db: tauri::State<Db>, file_ids: Vec<i64>) -> Result<Beside, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    place_beside(&mut conn, &file_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::{matched, placed, unlinked, unplaced};
    use rusqlite::params;

    /// The reporter's library, as rows: a show with season 1 (13 files from
    /// one folder) and six files of a prequel named S01E01-06 in another.
    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'D:/Shows', 'tv', 0);
             INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at)
                  VALUES (7, 'series', 'tmdb', '46296', 'Spartacus', 0);",
        )
        .unwrap();
        for e in 1..=13 {
            insert(&conn, e, "D:/Shows/Spartacus S01", &format!("Spartacus.S01E{e:02}.mkv"), "Spartacus", 1, e);
        }
        for e in 1..=6 {
            insert(
                &conn,
                100 + e,
                "D:/Shows/Spartacus.Gods.Of.The.Arena.S01",
                &format!("Spartacus.Gods.Of.The.Arena.S01E{e:02}.mkv"),
                "Spartacus Gods of the Arena",
                1,
                e,
            );
        }
        let all: Vec<i64> = (1..=13).chain(101..=106).collect();
        let mut c = conn;
        matched(&mut c, &all, 7, None, Some("manual: “Spartacus” via tmdb")).unwrap();
        c
    }

    fn insert(conn: &Connection, id: i64, dir: &str, name: &str, title: &str, season: i64, episode: i64) {
        conn.execute(
            "INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension, size_bytes,
                    modified_at, first_seen_at, last_seen_at, missing, match_status, parsed_title,
                    parsed_season, parsed_episode, parsed_kind)
             VALUES (?1, 1, ?2, ?3, ?4, 'mkv', 1000, 0, 0, 0, 0, 'parsed', ?5, ?6, ?7, 'episode')",
            params![id, format!("{dir}/{name}"), dir, name, title, season, episode],
        )
        .unwrap();
    }

    fn numbers(conn: &Connection, id: i64) -> (Option<i64>, Option<i64>, bool) {
        conn.query_row(
            "SELECT parsed_season, parsed_episode, placed_from IS NOT NULL FROM media_files WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    fn to_specials(ids: std::ops::RangeInclusive<i64>, first: i64) -> Vec<Placement> {
        ids.enumerate()
            .map(|(i, id)| Placement { file_id: id, season: Some(0), episode: Some(first + i as i64), episode_last: None })
            .collect()
    }

    #[test]
    fn the_reporters_files_move_to_specials_and_leave_season_one_alone() {
        let mut conn = library();
        // Before: season 1 holds six episodes twice ("Here more than once").
        let dupes = crate::versions::duplicates(&conn).unwrap();
        assert_eq!(dupes.len(), 6);

        placed(&mut conn, &to_specials(101..=106, 1), Some("manual: placed")).unwrap();
        assert_eq!(numbers(&conn, 101), (Some(0), Some(1), true));
        assert_eq!(numbers(&conn, 106), (Some(0), Some(6), true));
        assert_eq!(numbers(&conn, 1), (Some(1), Some(1), false));
        assert!(crate::versions::duplicates(&conn).unwrap().is_empty());

        // The page lists them under Specials, with what the names said kept.
        let files = files_of(&conn, 7).unwrap();
        let arena: Vec<_> = files.iter().filter(|f| f.file_id > 100).collect();
        assert_eq!(arena.len(), 6);
        assert!(arena.iter().all(|f| f.season == Some(0) && f.name_season == Some(1) && f.placed));
        // The hand link's reason is kept, not replaced.
        let reason: String = conn.query_row("SELECT match_reason FROM media_files WHERE id = 101", [], |r| r.get(0)).unwrap();
        assert_eq!(reason, "manual: “Spartacus” via tmdb");
    }

    #[test]
    fn numbers_can_differ_from_the_names_and_a_second_move_keeps_the_names() {
        let mut conn = library();
        placed(&mut conn, &to_specials(101..=106, 14), None).unwrap();
        assert_eq!(numbers(&conn, 101), (Some(0), Some(14), true));
        placed(&mut conn, &to_specials(101..=106, 1), None).unwrap();
        unplaced(&mut conn, &[101, 102, 103, 104, 105, 106]).unwrap();
        assert_eq!(numbers(&conn, 101), (Some(1), Some(1), false));
    }

    #[test]
    fn placing_where_the_name_says_is_no_placement() {
        let mut conn = library();
        placed(&mut conn, &[Placement { file_id: 101, season: Some(1), episode: Some(1), episode_last: None }], None).unwrap();
        assert_eq!(numbers(&conn, 101), (Some(1), Some(1), false));
    }

    #[test]
    fn unlinking_one_folder_leaves_the_rest_of_the_show() {
        let mut conn = library();
        placed(&mut conn, &to_specials(101..=106, 1), None).unwrap();
        unlinked(&mut conn, &[101, 102, 103, 104, 105, 106], "unlinked by hand").unwrap();
        // The six wait in Needs attention, with their names' numbers back.
        assert_eq!(numbers(&conn, 101), (Some(1), Some(1), false));
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM media_files WHERE title_id = 7", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 13);
        let held: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_files WHERE id > 100 AND match_hold = 1 AND title_id IS NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(held, 6);
    }

    #[test]
    fn a_placed_files_resume_and_watch_are_kept() {
        let mut conn = library();
        conn.execute(
            "INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at)
             VALUES (101, 600.0, 3000.0, 0, 5), (102, 3000.0, 3000.0, 1, 6)",
            [],
        )
        .unwrap();
        placed(&mut conn, &to_specials(101..=106, 1), None).unwrap();
        crate::history::restore(&conn, &[101, 102]).unwrap();
        let (pos, done): (f64, i64) = conn
            .query_row("SELECT position_secs, completed FROM playback_state WHERE file_id = 101", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((pos, done), (600.0, 0));
        let done: i64 = conn.query_row("SELECT completed FROM playback_state WHERE file_id = 102", [], |r| r.get(0)).unwrap();
        assert_eq!(done, 1);
    }

    #[test]
    fn a_new_file_beside_placed_ones_waits_and_goes_the_same_way_on_one_press() {
        let mut conn = library();
        placed(&mut conn, &to_specials(101..=106, 1), Some("manual: placed")).unwrap();
        insert(&conn, 107, "D:/Shows/Spartacus.Gods.Of.The.Arena.S01", "Spartacus.Gods.Of.The.Arena.S01E07.mkv", "Spartacus Gods of the Arena", 1, 7);
        // And one in a folder nobody placed: untouched.
        insert(&conn, 14, "D:/Shows/Spartacus S01", "Spartacus.S01E14.mkv", "Spartacus", 1, 14);
        assert_eq!(hold_beside_placed(&conn, &[107, 14]).unwrap(), 1);
        let held: (i64, String) = conn
            .query_row("SELECT match_hold, match_reason FROM media_files WHERE id = 107", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(held, (1, BESIDE_REASON.to_string()));
        let free: i64 = conn.query_row("SELECT match_hold FROM media_files WHERE id = 14", [], |r| r.get(0)).unwrap();
        assert_eq!(free, 0);

        let b = beside(&conn, &[107]).unwrap().unwrap();
        assert_eq!(b, Beside { title_id: 7, title: "Spartacus".into(), season: Some(0), shift: 0 });
        place_beside(&mut conn, &[107]).unwrap();
        assert_eq!(numbers(&conn, 107), (Some(0), Some(7), true));
        let (title, hold): (i64, i64) = conn
            .query_row("SELECT title_id, match_hold FROM media_files WHERE id = 107", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((title, hold), (7, 0));
    }

    #[test]
    fn the_developer_resets_go_back_to_the_names() {
        let mut conn = library();
        placed(&mut conn, &to_specials(101..=106, 1), None).unwrap();
        // Hand matches are kept by reset_matches only when held; these are not.
        lifecycle::reset_matches(&conn).unwrap();
        assert_eq!(numbers(&conn, 101), (Some(1), Some(1), false));

        let mut conn = library();
        placed(&mut conn, &to_specials(101..=106, 1), None).unwrap();
        lifecycle::reset_parses(&conn).unwrap();
        let placed_left: i64 = conn.query_row("SELECT COUNT(*) FROM media_files WHERE placed_from IS NOT NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(placed_left, 0);
    }
}
