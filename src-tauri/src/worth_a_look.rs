//! "Worth a look" (round 8 L3): matches the scorer made under older rules that
//! the current rules would read differently, listed once in Needs attention for
//! a person to decide. **Read-only towards the matches**: nothing here links,
//! unlinks or re-parses a file; only "Keep as it is" writes, and then only the
//! reason, so the match becomes a hand decision.
//!
//! A rule change reaches refused files by itself (`lifecycle::reask_after_new_rules`)
//! but never a matched one: a file matched wrongly before stays matched, with
//! nothing saying so (GOTCHAS "A rule change does not reach a file that is
//! already matched"). Re-matching them would need the network and would move
//! matches a person may have looked at and accepted. So this only asks.
//!
//! How it runs once per [`MATCHER_RULES`] and survives a crash:
//!
//! 1. At start-up, in the same breath as the migration ([`snapshot_after_new_rules`]),
//!    the ids of every file matched *by score* go into `worth_a_look_todo` and the
//!    rules version is stored, in one transaction. Taken before any scan of this
//!    version can match anything, so every id in it was matched by the old rules.
//! 2. The page parses those files again with the current parser, a batch at a
//!    time, in the background (`worthALook.ts`), and hands back what differs.
//! 3. [`save`] stores those entries and removes the batch from the to-do list,
//!    in one transaction. A crash between batches leaves the rest of the list;
//!    the next start goes on from there. An entry is stored at most once
//!    (the file id is its key).
//!
//! "By score" is a reason that starts with the scorer's own `title NN%`, and was
//! not searched under an NFO's title (`· searched as`): a hand match says
//! `manual:`, an NFO `nfo:`, an id in the name `name:`, an ignored file is not
//! matched at all, and a held file is never matched by the scorer.

use crate::library::Db;
use crate::util::to_string_err;
use crate::lifecycle::MATCHER_RULES;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

const RULES_KEY: &str = "worth_a_look_rules";

/// A file the scorer linked, which no person has decided about since.
pub const BY_SCORE: &str = "m.match_status = 'matched'
      AND m.title_id IS NOT NULL
      AND m.match_hold = 0
      AND m.match_reason LIKE 'title %'
      AND m.match_reason NOT LIKE '%· searched as %'";

/// An entry still worth showing: its file is on disk and still as the scorer
/// left it. Linked by hand, kept, unlinked or ignored since, it drops out.
const LIVE: &str = "FROM worth_a_look w
      JOIN media_files m ON m.id = w.file_id
     WHERE m.missing = 0 AND ";

/// Step 1: once per rules version, write down which files to read again.
/// Returns how many.
pub fn snapshot_after_new_rules(conn: &mut Connection) -> rusqlite::Result<usize> {
    let stored: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [RULES_KEY], |r| r.get(0))
        .ok();
    if stored.as_deref() == Some(MATCHER_RULES) {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    let n = tx.execute(
        &format!(
            "INSERT OR IGNORE INTO worth_a_look_todo (file_id)
             SELECT m.id FROM media_files m WHERE {BY_SCORE}"
        ),
        [],
    )?;
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [RULES_KEY, MATCHER_RULES],
    )?;
    tx.commit()?;
    Ok(n)
}

/// What the page found for one file: why it is worth a look, as a small JSON
/// object the page turns into words (`worthALook.ts`).
#[derive(Deserialize)]
pub struct Found {
    pub file_id: i64,
    pub why: String,
}

/// Step 3: store what a batch found and take the batch off the list, together.
/// A file no longer matched by score since the list was made is not stored.
pub fn save(conn: &mut Connection, done: &[i64], found: &[Found]) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut stored = 0;
    {
        let mut insert = tx.prepare(&format!(
            "INSERT OR IGNORE INTO worth_a_look (file_id, why)
             SELECT m.id, ?2 FROM media_files m WHERE m.id = ?1 AND {BY_SCORE}"
        ))?;
        for f in found {
            stored += insert.execute(params![f.file_id, f.why])?;
        }
        let mut remove = tx.prepare("DELETE FROM worth_a_look_todo WHERE file_id = ?1")?;
        for id in done {
            remove.execute([id])?;
        }
    }
    tx.commit()?;
    Ok(stored)
}

/// How many files are still waiting for an answer (live entries only).
pub fn count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(&format!("SELECT COUNT(*) {LIVE}{BY_SCORE}"), [], |r| r.get(0))
}

#[derive(Serialize, Debug)]
pub struct Entry {
    pub file_id: i64,
    pub path: String,
    pub file_name: String,
    pub title_id: i64,
    pub title: String,
    pub year: Option<i64>,
    pub kind: String,
    pub why: String,
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Entry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT m.id, m.path, m.file_name, t.id, t.title, t.year, t.kind, w.why
           FROM worth_a_look w
           JOIN media_files m ON m.id = w.file_id
           JOIN titles t ON t.id = m.title_id
          WHERE m.missing = 0 AND {BY_SCORE}
          ORDER BY t.title, m.path"
    ))?;
    let rows = stmt.query_map([], |r| {
        Ok(Entry {
            file_id: r.get(0)?,
            path: r.get(1)?,
            file_name: r.get(2)?,
            title_id: r.get(3)?,
            title: r.get(4)?,
            year: r.get(5)?,
            kind: r.get(6)?,
            why: r.get(7)?,
        })
    })?;
    rows.collect()
}

/// "Keep as it is": the match stays and becomes a hand decision — the reason
/// says so in the words every other hand match uses (`manual:`), so Move to a
/// new computer carries it and no later check asks about it again.
pub fn keep(conn: &mut Connection, file_ids: &[i64]) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut n = 0;
    {
        let mut mark = tx.prepare(&format!(
            "UPDATE media_files AS m
                SET match_reason = 'manual: kept “' || t.title || '”'
                                   || COALESCE(' (' || t.year || ')', '')
                                   || ', after a look'
               FROM titles t
              WHERE m.id = ?1 AND t.id = m.title_id AND {BY_SCORE}"
        ))?;
        let mut drop = tx.prepare("DELETE FROM worth_a_look WHERE file_id = ?1")?;
        for id in file_ids {
            n += mark.execute([id])?;
            drop.execute([id])?;
        }
    }
    tx.commit()?;
    Ok(n)
}

// ---- commands ----------------------------------------------------------------

/// A file to read again, with the year of the title it is linked to: the page
/// asks whether today's reading would still take that title.
#[derive(Serialize)]
pub struct Todo {
    #[serde(flatten)]
    pub file: crate::library::MediaFile,
    pub title_year: Option<i64>,
}

pub fn next(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<Todo>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.path, m.parent_dir, m.file_name, m.size_bytes, m.missing, m.match_status,
                m.parsed_title, m.parsed_year, m.parsed_season, m.parsed_episode, m.parsed_kind,
                m.parsed_from, m.title_id, m.match_confidence, m.match_reason, t.title, t.year
           FROM worth_a_look_todo w
           JOIN media_files m ON m.id = w.file_id
           LEFT JOIN titles t ON t.id = m.title_id
          ORDER BY w.file_id LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        Ok(Todo {
            file: crate::library::MediaFile {
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
                episode_name: None,
            },
            title_year: r.get(17)?,
        })
    })?;
    rows.collect()
}

/// The next files to read again, oldest id first.
#[tauri::command]
pub fn worth_a_look_next(db: tauri::State<Db>, limit: i64) -> Result<Vec<Todo>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    next(&conn, limit).map_err(to_string_err)
}

#[tauri::command]
pub fn worth_a_look_save(
    db: tauri::State<Db>,
    done: Vec<i64>,
    found: Vec<Found>,
) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    save(&mut conn, &done, &found).map_err(to_string_err)
}

#[tauri::command]
pub fn worth_a_look_list(db: tauri::State<Db>) -> Result<Vec<Entry>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    list(&conn).map_err(to_string_err)
}

#[tauri::command]
pub fn worth_a_look_keep(db: tauri::State<Db>, file_ids: Vec<i64>) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    keep(&mut conn, &file_ids).map_err(to_string_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A migrated library: the trilogy's three files matched by score to the
    /// first film, a `Dune.mkv` tie, a hand-linked film, an ignored file, an
    /// NFO-searched one and a held one.
    fn library() -> Connection {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pn-worth-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let conn = crate::db::open(&dir.join("library.db")).expect("open");
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'D:/Films', 'movies', 0);
             INSERT INTO titles (id, kind, provider, provider_id, title, year, fetched_at) VALUES
               (1, 'movie', 'tmdb', '105', 'Back to the Future', 1985, 0),
               (2, 'movie', 'tmdb', '438631', 'Dune', 2021, 0),
               (3, 'movie', 'tmdb', '9', 'Heat', 1995, 0);",
        )
        .expect("titles");
        /// id, path, status, title, reason, what was read.
        type Row<'a> = (i64, &'a str, &'a str, Option<i64>, &'a str, &'a str);
        let rows: [Row; 8] = [
            (1, "Back to the Future (1985)/Back to the Future.mkv", "matched", Some(1), "title 100%, year exact", "Back to the Future"),
            (2, "Back to the Future (1985)/Back to the Future Part II.mkv", "matched", Some(1), "title 100%, year exact", "Back to the Future"),
            (3, "Back to the Future (1985)/Back to the Future Part III.mkv", "matched", Some(1), "title 100%, year exact", "Back to the Future"),
            (4, "Dune.mkv", "matched", Some(2), "title 100%, no candidate year; tie vs \"Dune\" broken by popularity", "Dune"),
            (5, "Heat.mkv", "matched", Some(3), "manual: “Heat” (1995) via tmdb", "Heat"),
            (6, "Sample.mkv", "ignored", None, "ignored by hand", "Sample"),
            (7, "Heat 2.mkv", "matched", Some(3), "title 90%; · searched as “Heat” from movie.nfo", "Heat"),
            (8, "Heat 3.mkv", "matched", Some(3), "title 100%, year exact", "Heat"),
        ];
        for (id, path, status, title, reason, parsed) in rows {
            conn.execute(
                "INSERT INTO media_files
                    (id, root_id, path, parent_dir, file_name, extension, size_bytes, modified_at,
                     first_seen_at, last_seen_at, match_status, title_id, match_reason, parsed_title,
                     match_hold)
                 VALUES (?1, 1, ?2, 'D:/Films', ?2, 'mkv', 1, 0, 0, 0, ?3, ?4, ?5, ?6, ?7)",
                params![id, path, status, title, reason, parsed, i64::from(id == 8)],
            )
            .expect("file");
        }
        conn
    }

    fn todo(conn: &Connection) -> Vec<i64> {
        let mut stmt = conn.prepare("SELECT file_id FROM worth_a_look_todo ORDER BY file_id").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().flatten().collect()
    }

    fn found(id: i64) -> Found {
        Found { file_id: id, why: format!("{{\"n\":{id}}}") }
    }

    #[test]
    fn the_snapshot_takes_score_matches_only_once_per_rules() {
        let mut conn = library();
        // A fresh library: `open` took a snapshot of nothing and stored the rules.
        assert_eq!(snapshot_after_new_rules(&mut conn).unwrap(), 0);
        conn.execute("DELETE FROM settings WHERE key = ?1", [RULES_KEY]).unwrap();
        assert_eq!(snapshot_after_new_rules(&mut conn).unwrap(), 4);
        // Not the hand match (5), the ignored file (6), the NFO search (7), the held one (8).
        assert_eq!(todo(&conn), vec![1, 2, 3, 4]);
        assert_eq!(snapshot_after_new_rules(&mut conn).unwrap(), 0);
    }

    #[test]
    fn a_crash_between_batches_goes_on_and_never_lists_twice() {
        library_reopened();
    }

    /// A second open of the same file, as a restart does.
    fn library_reopened() -> Connection {
        let mut conn = library();
        conn.execute("DELETE FROM settings WHERE key = ?1", [RULES_KEY]).unwrap();
        snapshot_after_new_rules(&mut conn).unwrap();
        save(&mut conn, &[1, 2], &[found(2)]).unwrap();
        let path = conn.path().expect("path").to_string();
        drop(conn);
        let mut again = crate::db::open(std::path::Path::new(&path)).expect("reopen");
        assert_eq!(todo(&again), vec![3, 4], "the rest waits");
        let rest = next(&again, 10).unwrap();
        assert_eq!(rest.iter().map(|t| t.file.id).collect::<Vec<_>>(), vec![3, 4]);
        assert_eq!(rest[0].title_year, Some(1985));
        // The same batch again (the page died before it heard back): stored once.
        assert_eq!(save(&mut again, &[2, 3, 4], &[found(2), found(3), found(4)]).unwrap(), 2);
        assert!(todo(&again).is_empty());
        assert_eq!(count(&again).unwrap(), 3);
        again
    }

    #[test]
    fn a_hand_decision_takes_an_entry_off_the_list() {
        let mut conn = library_reopened();
        assert_eq!(list(&conn).unwrap().len(), 3);
        // Keep as it is: the match stays, now as a hand decision.
        assert_eq!(keep(&mut conn, &[2]).unwrap(), 1);
        let (title, reason): (Option<i64>, String) = conn
            .query_row("SELECT title_id, match_reason FROM media_files WHERE id = 2", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(title, Some(1));
        assert_eq!(reason, "manual: kept “Back to the Future” (1985), after a look");
        // Linked by hand elsewhere (Find the right match): gone from the list too.
        conn.execute("UPDATE media_files SET match_reason = 'manual: “Back to the Future Part III” (1990) via tmdb' WHERE id = 3", []).unwrap();
        let left: Vec<i64> = list(&conn).unwrap().iter().map(|e| e.file_id).collect();
        assert_eq!(left, vec![4]);
        assert_eq!(count(&conn).unwrap(), 1);
        // A file gone from disk is not shown.
        conn.execute("UPDATE media_files SET missing = 1 WHERE id = 4", []).unwrap();
        assert_eq!(count(&conn).unwrap(), 0);
    }

    #[test]
    fn a_file_decided_by_hand_before_its_batch_is_not_stored() {
        let mut conn = library();
        conn.execute("DELETE FROM settings WHERE key = ?1", [RULES_KEY]).unwrap();
        snapshot_after_new_rules(&mut conn).unwrap();
        conn.execute("UPDATE media_files SET match_reason = 'manual: picked' WHERE id = 2", []).unwrap();
        assert_eq!(save(&mut conn, &[1, 2, 3, 4], &[found(2)]).unwrap(), 0);
        assert_eq!(count(&conn).unwrap(), 0);
    }

    /// The start-up part's cost on 10,000 matched files (run by hand:
    /// `cargo test --lib worth_a_look -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn snapshot_of_ten_thousand() {
        let mut conn = library();
        conn.execute("DELETE FROM media_files", []).unwrap();
        let tx = conn.transaction().unwrap();
        for id in 1..=10_000_i64 {
            tx.execute(
                "INSERT INTO media_files
                    (id, root_id, path, parent_dir, file_name, extension, size_bytes, modified_at,
                     first_seen_at, last_seen_at, match_status, title_id, match_reason, parsed_title)
                 VALUES (?1, 1, ?2, 'D:/Films', ?2, 'mkv', 1, 0, 0, 0, 'matched', 1, 'title 100%, year exact', 'X')",
                params![id, format!("f{id}.mkv")],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        conn.execute("DELETE FROM settings WHERE key = ?1", [RULES_KEY]).unwrap();
        let t0 = std::time::Instant::now();
        assert_eq!(snapshot_after_new_rules(&mut conn).unwrap(), 10_000);
        let snap = t0.elapsed();
        let t1 = std::time::Instant::now();
        let mut read = 0;
        loop {
            let batch = next(&conn, 500).unwrap();
            if batch.is_empty() {
                break;
            }
            let done: Vec<i64> = batch.iter().map(|t| t.file.id).collect();
            read += done.len();
            save(&mut conn, &done, &[]).unwrap();
        }
        println!("10000 files: snapshot {snap:?}, read and save in batches of 500 {:?} ({read})", t1.elapsed());
    }
}
