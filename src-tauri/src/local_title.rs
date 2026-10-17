//! Films and shows kept **without a match** — "local titles" (LOCAL-MEDIA.md
//! phase 3).
//!
//! Needs attention holds what the matcher would not guess at. Some of it will
//! never be found — a home recording, a fan edit, a show no database lists —
//! and before this the only choices were to leave it waiting forever or ignore
//! it off every screen. *Add without a match* puts it in Movies or TV shows
//! under the name a person gives it (the file's, to start with), with no
//! picture, plot or ids.
//!
//! Nothing is guessed, so the 0.75 / 0.05 rule is untouched: a local title is
//! a person's decision, exactly like a title linked by hand in Fix match.
//!
//! A local title is an ordinary `titles` row with `provider = 'local'`, so
//! every screen, resume point and watched tick works as it does for any other
//! title and the schema did not change. What keeps it from going anywhere it
//! should not:
//!
//! * no `imdb_id` or `tmdb_id` — SIMKL and Trakt find titles by those, so
//!   nothing is queued for them (`tracking::queue`); TheIntroDB, IntroDB.app,
//!   IMDb ratings and Rotten Tomatoes have nothing to look up;
//! * not `provider = 'tmdb'` — the six-month refresh and the detail backfill
//!   never ask about it;
//! * no artwork URLs — nothing to download.
//!
//! The row's `provider_id` is the group's lowest file id, so the watch history
//! (keyed on provider ids, see `history`) comes back if the same files are
//! added without a match again after a trip through Find a match.

use crate::lifecycle;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection, OptionalExtension};

pub const PROVIDER: &str = "local";

/// What a file keeps as its reason, so the library tools can tell a local
/// title from one the scorer or a person linked.
const ADDED_REASON: &str = "added without a match";

/// What Needs attention shows for a local title sent back to be matched.
/// `FixMatch.tsx` matches on the start of it for its advice line.
pub const RETURNED_REASON: &str = "added without a match, then sent back to find one";

/// A name a person typed: trimmed, not empty, and not a page long.
fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A title needs a name.".into());
    }
    Ok(name.chars().take(200).collect())
}

/// A year a person typed, or none. Anything outside film history is a typo.
fn clean_year(year: Option<i64>) -> Result<Option<i64>, String> {
    match year {
        Some(y) if !(1870..=2200).contains(&y) => Err(format!("{y} does not look like a year.")),
        other => Ok(other),
    }
}

/// Whether these files can be shown as the kind asked for, or why not.
///
/// A series page lists a file only by its season and episode numbers
/// (`metadata::episodes_for`), and a film page plays one file. So a series
/// whose files have no numbers, or several episodes kept as one film, would
/// leave files on no screen at all — out of Needs attention and unreachable.
fn check_kind(conn: &Connection, file_ids: &[i64], is_series: bool) -> Result<(), String> {
    let mut unnumbered = 0;
    let mut numbered = 0;
    for &id in file_ids {
        let (season, episode): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT parsed_season, parsed_episode FROM media_files WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(to_string_err)?;
        if season.is_some() && episode.is_some() {
            numbered += 1;
        } else {
            unnumbered += 1;
        }
    }
    if is_series && unnumbered > 0 {
        return Err(
            "Kinema could not read a season and episode number from every file name              (S01E01), so it could not place them as episodes. Keep them as a movie,              or rename the files."
                .into(),
        );
    }
    if !is_series && file_ids.len() > 1 && numbered > 0 {
        return Err("These are episodes. Keep them as a TV series.".into());
    }
    Ok(())
}

/// Keep these files as one local title. Returns the title's id.
///
/// A local title of the same kind and name (and, for a film, year) is joined
/// rather than made twice: the next episode of a kept series arrives in Needs
/// attention on its own, and belongs with the ones kept before it.
pub fn add(
    conn: &mut Connection,
    file_ids: &[i64],
    is_series: bool,
    name: &str,
    year: Option<i64>,
) -> Result<i64, String> {
    let name = clean_name(name)?;
    let year = clean_year(year)?;
    let first = *file_ids.iter().min().ok_or("No files to add.")?;
    check_kind(conn, file_ids, is_series)?;
    let kind = if is_series { "series" } else { "movie" };

    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM titles
              WHERE provider = ?1 AND kind = ?2 AND lower(title) = lower(?3)
                AND (kind = 'series' OR year IS ?4)
              ORDER BY id LIMIT 1",
            params![PROVIDER, kind, name, year],
            |r| r.get(0),
        )
        .optional()
        .map_err(to_string_err)?;
    let (title_id, made) = match existing {
        Some(id) => (id, false),
        None => {
            let provider_id = format!("{kind}-{first}");
            conn.execute(
                "INSERT INTO titles (kind, provider, provider_id, title, year, fetched_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(provider, provider_id) DO UPDATE SET
                    title = excluded.title, year = excluded.year",
                params![kind, PROVIDER, provider_id, name, year, now_secs()],
            )
            .map_err(to_string_err)?;
            let id = conn
                .query_row(
                    "SELECT id FROM titles WHERE provider = ?1 AND provider_id = ?2",
                    params![PROVIDER, provider_id],
                    |r| r.get(0),
                )
                .map_err(to_string_err)?;
            (id, true)
        }
    };

    // A person's decision, like a link made in Fix match: no score to record.
    if let Err(e) = lifecycle::matched(conn, file_ids, title_id, None, Some(ADDED_REASON)) {
        // No row left behind with nothing in it.
        if made {
            let _ = conn.execute(
                "DELETE FROM titles WHERE id = ?1
                   AND NOT EXISTS (SELECT 1 FROM media_files WHERE title_id = ?1)",
                [title_id],
            );
        }
        return Err(to_string_err(e));
    }
    crate::history::restore(conn, file_ids).map_err(to_string_err)?;
    Ok(title_id)
}

fn is_local(conn: &Connection, title_id: i64) -> Result<bool, String> {
    let provider: Option<String> = conn
        .query_row("SELECT provider FROM titles WHERE id = ?1", [title_id], |r| r.get(0))
        .optional()
        .map_err(to_string_err)?;
    Ok(provider.as_deref() == Some(PROVIDER))
}

/// Give a local title another name or year. A provider's title is not
/// renamed here: its name is the provider's, and the next refresh would put
/// it back.
pub fn rename(conn: &Connection, title_id: i64, name: &str, year: Option<i64>) -> Result<(), String> {
    let name = clean_name(name)?;
    let year = clean_year(year)?;
    if !is_local(conn, title_id)? {
        return Err("Only a title added without a match can be renamed.".into());
    }
    conn.execute(
        "UPDATE titles SET title = ?2, year = ?3 WHERE id = ?1",
        params![title_id, name, year],
    )
    .map_err(to_string_err)?;
    Ok(())
}

/// Send a local title's files back to Needs attention to be matched after
/// all, and drop the title. Held, like an unlinked match, so the automatic
/// matcher does not take them up and refuse them all over again. Returns how
/// many files went back.
pub fn release(conn: &mut Connection, title_id: i64) -> Result<usize, String> {
    if !is_local(conn, title_id)? {
        return Err("Only a title added without a match can be sent back.".into());
    }
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM media_files WHERE title_id = ?1")
            .map_err(to_string_err)?;
        let rows = stmt.query_map([title_id], |r| r.get(0)).map_err(to_string_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(to_string_err)?
    };
    let n = lifecycle::unlinked(conn, &ids, RETURNED_REASON).map_err(to_string_err)?;
    conn.execute("DELETE FROM titles WHERE id = ?1", [title_id])
        .map_err(to_string_err)?;
    Ok(n)
}

// ---- commands ----------------------------------------------------------------

use crate::library::Db;

#[tauri::command]
pub fn add_without_match(
    db: tauri::State<Db>,
    file_ids: Vec<i64>,
    is_series: bool,
    name: String,
    year: Option<i64>,
) -> Result<i64, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    add(&mut conn, &file_ids, is_series, &name, year)
}

#[tauri::command]
pub fn rename_local_title(
    db: tauri::State<Db>,
    title_id: i64,
    name: String,
    year: Option<i64>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    rename(&conn, title_id, &name, year)
}

#[tauri::command]
pub fn find_match_for_local(db: tauri::State<Db>, title_id: i64) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    release(&mut conn, title_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real, migrated library with three refused files and one TMDB title.
    fn library() -> Connection {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pn-local-title-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let conn = crate::db::open(&dir.join("library.db")).expect("open");
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:/v', 'tv', 0);
             INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at)
                  VALUES (7, 'movie', 'tmdb', '1', 'Film', 0);",
        )
        .expect("root and title");
        for id in [11_i64, 12, 13] {
            conn.execute(
                "INSERT INTO media_files
                    (id, root_id, path, parent_dir, file_name, extension, size_bytes,
                     modified_at, first_seen_at, last_seen_at, missing, match_status,
                     match_reason, parsed_title, parsed_season, parsed_episode)
                 VALUES (?1, 1, ?2, 'C:/v', ?2, 'mkv', 1, 0, 0, 0, 0, 'unmatched',
                         'no candidates returned', 'Our Holiday', 1, ?3)",
                params![id, format!("e{id}.mkv"), id - 10],
            )
            .expect("file");
        }
        conn
    }

    fn file(conn: &Connection, id: i64) -> (String, Option<i64>, i64, Option<String>) {
        conn.query_row(
            "SELECT match_status, title_id, match_hold, match_reason FROM media_files WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("row")
    }

    fn needing_attention(conn: &Connection) -> i64 {
        let sql = format!("SELECT COUNT(*) FROM media_files m WHERE {}", lifecycle::NEEDS_ATTENTION);
        conn.query_row(&sql, [], |r| r.get(0)).expect("count")
    }

    #[test]
    fn added_files_leave_the_queue_as_one_local_title_with_no_ids() {
        let mut conn = library();
        assert_eq!(needing_attention(&conn), 3);
        let id = add(&mut conn, &[12, 11, 13], true, "  Our Holiday ", Some(2019)).unwrap();
        assert_eq!(needing_attention(&conn), 0);
        for f in [11, 12, 13] {
            let (status, title, hold, reason) = file(&conn, f);
            assert_eq!((status.as_str(), title, hold), ("matched", Some(id), 0));
            assert_eq!(reason.as_deref(), Some(ADDED_REASON));
        }
        let row: (String, String, String, Option<i64>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT kind, provider, title, year, imdb_id, tmdb_id FROM titles WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            ("series".into(), "local".into(), "Our Holiday".into(), Some(2019), None, None)
        );
        // Nothing a provider refresh or a tracking service would pick up.
        let stale = crate::metadata::stale_titles(&conn, i64::MAX / 2, 100).unwrap();
        assert!(stale.iter().all(|t| t.id != id));
    }

    #[test]
    fn files_are_only_kept_as_a_kind_that_can_show_them() {
        let mut conn = library();
        conn.execute("UPDATE media_files SET parsed_season = NULL WHERE id = 13", [])
            .unwrap();
        // A series page lists files by season and episode: 13 has no season.
        assert!(add(&mut conn, &[11, 13], true, "Our Holiday", None).is_err());
        // Two episodes as one film: one of them would be on no screen.
        assert!(add(&mut conn, &[11, 12], false, "Our Holiday", None).is_err());
        assert_eq!(needing_attention(&conn), 3, "nothing changed");
        // One numbered file as a film is fine: the film page plays it.
        assert!(add(&mut conn, &[11], false, "Our Holiday", None).is_ok());
    }

    #[test]
    fn a_later_episode_joins_the_series_kept_before_it() {
        let mut conn = library();
        let first = add(&mut conn, &[11, 12], true, "Our Holiday", None).unwrap();
        let later = add(&mut conn, &[13], true, "our holiday", None).unwrap();
        assert_eq!(first, later);
        let (count, name): (i64, String) = conn
            .query_row(
                "SELECT COUNT(*), MAX(title) FROM titles WHERE provider = 'local'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((count, name.as_str()), (1, "Our Holiday"), "the first name stays");
    }

    #[test]
    fn reset_matches_keeps_titles_kept_without_a_match() {
        let mut conn = library();
        let id = add(&mut conn, &[11, 12], true, "Our Holiday", None).unwrap();
        lifecycle::reset_matches(&conn).unwrap();
        let (status, title, _, _) = file(&conn, 11);
        assert_eq!((status.as_str(), title), ("matched", Some(id)));
    }

    #[test]
    fn a_local_title_can_be_renamed_and_a_provider_title_cannot() {
        let mut conn = library();
        let id = add(&mut conn, &[11], false, "e11", None).unwrap();
        rename(&conn, id, "The Wedding", Some(2021)).unwrap();
        let (title, year): (String, Option<i64>) = conn
            .query_row("SELECT title, year FROM titles WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((title.as_str(), year), ("The Wedding", Some(2021)));

        assert!(rename(&conn, 7, "Not yours", None).is_err());
        assert!(rename(&conn, id, "   ", None).is_err());
        assert!(rename(&conn, id, "Fine", Some(20)).is_err());
    }

    #[test]
    fn find_a_match_sends_the_files_back_held_and_drops_the_title() {
        let mut conn = library();
        let id = add(&mut conn, &[11, 12], true, "Our Holiday", None).unwrap();
        assert_eq!(release(&mut conn, id).unwrap(), 2);
        for f in [11, 12] {
            let (status, title, hold, reason) = file(&conn, f);
            assert_eq!((status.as_str(), title, hold), ("unmatched", None, 1));
            assert_eq!(reason.as_deref(), Some(RETURNED_REASON));
        }
        assert_eq!(needing_attention(&conn), 3);
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM titles WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
        // A provider's title is never dropped this way.
        assert!(release(&mut conn, 7).is_err());

        // Added again, it is the same title row key, so its history returns.
        let again = add(&mut conn, &[11, 12], true, "Our Holiday", None).unwrap();
        let key: String = conn
            .query_row("SELECT provider_id FROM titles WHERE id = ?1", [again], |r| r.get(0))
            .unwrap();
        assert_eq!(key, "series-11");
    }
}
