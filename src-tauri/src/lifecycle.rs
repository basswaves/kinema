//! The life of a media file in the library — every status it can have, and
//! every way it moves between them. **The only place `match_status` and
//! `match_hold` are written.**
//!
//! ```text
//!   unparsed ──parse──▶ parsed ──match──▶ matched
//!                         │  ▲               │
//!              refuse ◀───┘  │ key changes   │ unlink (held)
//!                 │          │               ▼
//!                 ▼          │           unmatched + hold
//!             unmatched ─────┘
//!   parsed/failed ──provider did not answer──▶ failed (asked again next scan)
//!   any ──ignore──▶ ignored ──return to review──▶ parsed
//! ```
//!
//! This used to be split across the seam. The webview picked the status word
//! and passed it to a generic "link these files" command, which wrote whatever
//! it was given; the hold was a side rule inside that SQL; re-opening refusals
//! lived in the settings code; what counted as "needs attention" was spelled
//! out in two queries here and a `Set` in the review screen. Every Phase 3 bug
//! in matching — the unlink undone at the next launch, the refused groups
//! re-asked forever, the file on no screen at all — lived in the gaps between
//! those copies.
//!
//! Now the webview says **what happened** ("this group matched that title",
//! "the scorer refused it", "the provider did not answer", "ignore these") and
//! this module decides what that means for the file.
//!
//! **The hold** (`match_hold`, schema v12) is a decision made by hand: a file
//! unlinked from a wrong match must not be matched straight back by the next
//! scan. Only choosing a title clears it. Everything else leaves it alone, so a
//! held file that is ignored and later returned to review is still held — it
//! waits in Needs attention rather than going back to the matcher that got it
//! wrong.

use rusqlite::Connection;

// The statuses, as stored:
//
//   unparsed   found by the scanner; the parser has not seen it
//   parsed     waiting for the matcher (or, if held, for a person)
//   matched    linked to a title
//   unmatched  the scorer looked and refused — not asked again until a
//              provider key changes
//   failed     the provider did not answer; nothing was decided, so the next
//              scan asks again
//   ignored    taken out of the queue by hand (a trailer, a sample, an extra)

/// What the automatic matcher works on.
///
/// Freshly parsed files, and files whose last attempt `failed`. **Not** files
/// the scorer refused: the same question gets the same answer, and asking it at
/// every launch cost a provider search per refused group per start-up. Never
/// files held by hand, and never a file with no title to search for.
pub const MATCHABLE_WHERE: &str = "
    WHERE m.match_status IN ('parsed', 'failed')
      AND m.missing = 0
      AND m.parsed_title IS NOT NULL
      AND m.match_hold = 0";

/// What Needs attention counts as work: everything not yet resolved and still
/// on disk. Untitled files are included on purpose — this queue is the one
/// place such a file can be named by hand. Ignored files are not work, and are
/// listed separately so they can be put back.
pub const NEEDS_ATTENTION: &str =
    "m.match_status IN ('parsed', 'unmatched', 'failed') AND m.missing = 0";

/// One statement over many files, in one transaction.
fn update(conn: &mut Connection, sql: &str, ids: &[i64], bind: impl Fn(i64) -> Vec<Box<dyn rusqlite::ToSql>>) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut n = 0;
    {
        let mut stmt = tx.prepare(sql)?;
        for &id in ids {
            let values = bind(id);
            n += stmt.execute(rusqlite::params_from_iter(values.iter()))?;
        }
    }
    tx.commit()?;
    Ok(n)
}

/// The matcher (or a person in Fix match) chose a title. Ends any hold.
pub fn matched(
    conn: &mut Connection,
    ids: &[i64],
    title_id: i64,
    confidence: Option<f64>,
    reason: Option<&str>,
) -> rusqlite::Result<usize> {
    let reason = reason.map(str::to_string);
    update(
        conn,
        "UPDATE media_files
            SET title_id = ?2, match_confidence = ?3, match_reason = ?4,
                match_status = 'matched', match_hold = 0
          WHERE id = ?1",
        ids,
        |id| vec![Box::new(id), Box::new(title_id), Box::new(confidence), Box::new(reason.clone())],
    )
}

/// The scorer refused. The confidence and reason are kept so Needs attention
/// can say why.
pub fn refused(
    conn: &mut Connection,
    ids: &[i64],
    confidence: Option<f64>,
    reason: &str,
) -> rusqlite::Result<usize> {
    let reason = reason.to_string();
    update(
        conn,
        "UPDATE media_files
            SET title_id = NULL, match_confidence = ?2, match_reason = ?3,
                match_status = 'unmatched'
          WHERE id = ?1",
        ids,
        |id| vec![Box::new(id), Box::new(confidence), Box::new(reason.clone())],
    )
}

/// The provider did not answer — asked again by the next scan.
pub fn failed(conn: &mut Connection, ids: &[i64], reason: &str) -> rusqlite::Result<usize> {
    let reason = reason.to_string();
    update(
        conn,
        "UPDATE media_files
            SET title_id = NULL, match_confidence = 0, match_reason = ?2,
                match_status = 'failed'
          WHERE id = ?1",
        ids,
        |id| vec![Box::new(id), Box::new(reason.clone())],
    )
}

/// Out of the queue by hand. Reversible: the parse data stays.
pub fn ignored(conn: &mut Connection, ids: &[i64]) -> rusqlite::Result<usize> {
    update(
        conn,
        "UPDATE media_files
            SET title_id = NULL, match_confidence = NULL, match_reason = 'ignored by hand',
                match_status = 'ignored'
          WHERE id = ?1",
        ids,
        |id| vec![Box::new(id)],
    )
}

/// Back into the queue: un-ignoring. The matcher takes it up again unless it
/// is held.
pub fn returned_to_review(conn: &mut Connection, ids: &[i64]) -> rusqlite::Result<usize> {
    update(
        conn,
        "UPDATE media_files
            SET title_id = NULL, match_confidence = NULL, match_reason = NULL,
                match_status = 'parsed'
          WHERE id = ?1",
        ids,
        |id| vec![Box::new(id)],
    )
}

/// A wrong match taken off by hand, and held for a person to decide. Held,
/// not merely returned: returned files are what the matcher picks up, and it
/// made the same wrong choice at the next launch, undoing the unlink.
pub fn unlinked(conn: &mut Connection, ids: &[i64], reason: &str) -> rusqlite::Result<usize> {
    let reason = reason.to_string();
    update(
        conn,
        "UPDATE media_files
            SET title_id = NULL, match_confidence = NULL, match_reason = ?2,
                match_status = 'unmatched', match_hold = 1
          WHERE id = ?1",
        ids,
        |id| vec![Box::new(id), Box::new(reason.clone())],
    )
}

/// A provider key was added or changed — the one thing that can change a
/// refusal's answer. Refused files go back to the matcher; held ones stay held.
pub fn reopen_refusals(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE media_files SET match_status = 'parsed'
          WHERE match_status = 'unmatched' AND match_hold = 0",
        [],
    )
}

/// Developer tools: match everything again from scratch. Files that were
/// matched or refused go back to the matcher; ignored, failed and held
/// decisions are kept.
pub fn reset_matches(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE media_files
            SET title_id = NULL, match_confidence = NULL, match_reason = NULL,
                match_status = 'parsed'
          WHERE match_status IN ('matched', 'unmatched') AND match_hold = 0",
        [],
    )
}

/// Developer tools: parse everything again. Match links go too — a file that
/// claims to be unparsed while pointing at a title is an inconsistent state.
pub fn reset_parses(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE media_files
            SET match_status = 'unparsed', parsed_at = NULL, parsed_title = NULL,
                parsed_year = NULL, parsed_season = NULL, parsed_episode = NULL,
                parsed_kind = NULL, parsed_from = NULL, parsed_json = NULL,
                parsed_episode_last = NULL,
                title_id = NULL, match_confidence = NULL, match_reason = NULL",
        [],
    )
}

// ---- commands ----------------------------------------------------------------
//
// One per thing that can happen, named for it. The webview never names a
// status.

use crate::library::Db;

fn to_string_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn record_match(
    db: tauri::State<Db>,
    file_ids: Vec<i64>,
    title_id: i64,
    confidence: Option<f64>,
    reason: Option<String>,
) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    let n = matched(&mut conn, &file_ids, title_id, confidence, reason.as_deref())
        .map_err(to_string_err)?;
    // Now that they are known, a moved, renamed, upgraded or re-added copy
    // picks up what was watched on the old one. See `history`.
    crate::history::restore(&conn, &file_ids).map_err(to_string_err)?;
    Ok(n)
}

#[tauri::command]
pub fn record_refusal(
    db: tauri::State<Db>,
    file_ids: Vec<i64>,
    confidence: Option<f64>,
    reason: String,
) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    refused(&mut conn, &file_ids, confidence, &reason).map_err(to_string_err)
}

#[tauri::command]
pub fn record_provider_failure(
    db: tauri::State<Db>,
    file_ids: Vec<i64>,
    reason: String,
) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    failed(&mut conn, &file_ids, &reason).map_err(to_string_err)
}

#[tauri::command]
pub fn ignore_files(db: tauri::State<Db>, file_ids: Vec<i64>) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    ignored(&mut conn, &file_ids).map_err(to_string_err)
}

#[tauri::command]
pub fn return_to_review(db: tauri::State<Db>, file_ids: Vec<i64>) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    returned_to_review(&mut conn, &file_ids).map_err(to_string_err)
}

#[tauri::command]
pub fn unlink_files(
    db: tauri::State<Db>,
    file_ids: Vec<i64>,
    reason: String,
) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    unlinked(&mut conn, &file_ids, &reason).map_err(to_string_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// One file per id, parsed and matchable, plus a title to point at.
    fn library(ids: &[i64]) -> Connection {
        // A real, migrated schema — the statuses are only meaningful against
        // the columns and defaults the app actually has.
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pn-lifecycle-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let conn = crate::db::open(&dir.join("library.db")).expect("open");
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:/tv', 'tv', 0);
             INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at)
                  VALUES (7, 'series', 'tmdb', '1', 'Show', 0);",
        )
        .expect("root and title");
        for id in ids {
            conn.execute(
                "INSERT INTO media_files
                    (id, root_id, path, parent_dir, file_name, extension, size_bytes,
                     modified_at, first_seen_at, last_seen_at, missing, match_status,
                     parsed_title)
                 VALUES (?1, 1, ?2, 'C:/tv', ?2, 'mkv', 1, 0, 0, 0, 0, 'parsed', 'Show')",
                params![id, format!("e{id}.mkv")],
            )
            .expect("file");
        }
        conn
    }

    fn state(conn: &Connection, id: i64) -> (String, Option<i64>, i64) {
        conn.query_row(
            "SELECT match_status, title_id, match_hold FROM media_files WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("row")
    }

    fn matchable(conn: &Connection) -> Vec<i64> {
        let sql = format!("SELECT m.id FROM media_files m {MATCHABLE_WHERE} ORDER BY m.id");
        let mut stmt = conn.prepare(&sql).expect("prepare");
        stmt.query_map([], |r| r.get(0)).expect("query").flatten().collect()
    }

    fn needing_attention(conn: &Connection) -> Vec<i64> {
        let sql = format!("SELECT m.id FROM media_files m WHERE {NEEDS_ATTENTION} ORDER BY m.id");
        let mut stmt = conn.prepare(&sql).expect("prepare");
        stmt.query_map([], |r| r.get(0)).expect("query").flatten().collect()
    }

    #[test]
    fn a_match_links_the_title_and_leaves_both_queues() {
        let mut conn = library(&[1, 2]);
        assert_eq!(matched(&mut conn, &[1, 2], 7, Some(0.9), Some("title match")).unwrap(), 2);
        assert_eq!(state(&conn, 1), ("matched".into(), Some(7), 0));
        assert!(matchable(&conn).is_empty());
        assert!(needing_attention(&conn).is_empty());
    }

    #[test]
    fn a_refusal_waits_for_a_person_not_the_next_scan() {
        let mut conn = library(&[1]);
        refused(&mut conn, &[1], Some(0.6), "below threshold").unwrap();
        assert_eq!(state(&conn, 1), ("unmatched".into(), None, 0));
        assert!(matchable(&conn).is_empty());
        assert_eq!(needing_attention(&conn), vec![1]);
    }

    #[test]
    fn a_provider_failure_is_asked_again() {
        let mut conn = library(&[1]);
        failed(&mut conn, &[1], "HTTP 503").unwrap();
        assert_eq!(state(&conn, 1).0, "failed");
        assert_eq!(matchable(&conn), vec![1]);
        assert_eq!(needing_attention(&conn), vec![1]);
    }

    #[test]
    fn an_unlinked_file_is_held_until_a_title_is_chosen() {
        let mut conn = library(&[1]);
        matched(&mut conn, &[1], 7, Some(0.9), None).unwrap();
        unlinked(&mut conn, &[1], "wrong show").unwrap();
        assert_eq!(state(&conn, 1), ("unmatched".into(), None, 1));
        assert!(matchable(&conn).is_empty());
        assert_eq!(needing_attention(&conn), vec![1]);

        // A key change re-opens refusals — but not this one.
        assert_eq!(reopen_refusals(&conn).unwrap(), 0);
        assert!(matchable(&conn).is_empty());

        // Choosing a title by hand is the one thing that ends the hold.
        matched(&mut conn, &[1], 7, None, Some("chosen by hand")).unwrap();
        assert_eq!(state(&conn, 1), ("matched".into(), Some(7), 0));
    }

    #[test]
    fn a_key_change_reopens_refusals() {
        let mut conn = library(&[1, 2]);
        refused(&mut conn, &[1], None, "no provider for movies").unwrap();
        matched(&mut conn, &[2], 7, None, None).unwrap();
        assert_eq!(reopen_refusals(&conn).unwrap(), 1);
        assert_eq!(matchable(&conn), vec![1]);
        assert_eq!(state(&conn, 2).0, "matched");
    }

    #[test]
    fn ignoring_and_returning_round_trip() {
        let mut conn = library(&[1]);
        ignored(&mut conn, &[1]).unwrap();
        assert_eq!(state(&conn, 1).0, "ignored");
        assert!(matchable(&conn).is_empty());
        assert!(needing_attention(&conn).is_empty());

        returned_to_review(&mut conn, &[1]).unwrap();
        assert_eq!(state(&conn, 1), ("parsed".into(), None, 0));
        assert_eq!(matchable(&conn), vec![1]);
    }

    /// Ignoring is not a way round a hold: a held file that is ignored and put
    /// back is still waiting for a person.
    #[test]
    fn a_held_file_stays_held_through_ignore_and_return() {
        let mut conn = library(&[1]);
        unlinked(&mut conn, &[1], "wrong show").unwrap();
        ignored(&mut conn, &[1]).unwrap();
        returned_to_review(&mut conn, &[1]).unwrap();
        assert_eq!(state(&conn, 1), ("parsed".into(), None, 1));
        assert!(matchable(&conn).is_empty());
        assert_eq!(needing_attention(&conn), vec![1]);
    }

    #[test]
    fn a_file_with_no_title_needs_attention_but_is_not_searched_for() {
        let conn = library(&[1]);
        conn.execute("UPDATE media_files SET parsed_title = NULL", []).unwrap();
        assert!(matchable(&conn).is_empty());
        assert_eq!(needing_attention(&conn), vec![1]);
    }

    #[test]
    fn missing_files_are_nobodys_work() {
        let mut conn = library(&[1]);
        failed(&mut conn, &[1], "HTTP 503").unwrap();
        conn.execute("UPDATE media_files SET missing = 1", []).unwrap();
        assert!(matchable(&conn).is_empty());
        assert!(needing_attention(&conn).is_empty());
    }

    #[test]
    fn resetting_matches_keeps_decisions_made_by_hand() {
        let mut conn = library(&[1, 2, 3, 4]);
        matched(&mut conn, &[1], 7, None, None).unwrap();
        refused(&mut conn, &[2], None, "close call").unwrap();
        ignored(&mut conn, &[3]).unwrap();
        unlinked(&mut conn, &[4], "wrong show").unwrap();

        assert_eq!(reset_matches(&conn).unwrap(), 2);
        assert_eq!(state(&conn, 1), ("parsed".into(), None, 0));
        assert_eq!(state(&conn, 2).0, "parsed");
        assert_eq!(state(&conn, 3).0, "ignored");
        assert_eq!(state(&conn, 4), ("unmatched".into(), None, 1));
    }

    #[test]
    fn resetting_parses_starts_every_file_over() {
        let mut conn = library(&[1]);
        matched(&mut conn, &[1], 7, None, None).unwrap();
        reset_parses(&conn).unwrap();
        assert_eq!(state(&conn, 1), ("unparsed".into(), None, 0));
    }
}
