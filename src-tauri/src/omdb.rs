//! Rotten Tomatoes scores, looked up through OMDb with the user's own key.
//!
//! OMDb returns a title's Tomatometer beside its IMDb rating. Its free keys
//! allow 1,000 lookups a day, which is why there is no key of Kinema's own
//! here (HISTORY.md, "Picture and sound badges"): one key shared by every copy
//! would run out within hours. With a key of the user's own, the lookups are
//! theirs to spend — and this is spent carefully: one lookup per title, again
//! only after a month, and a daily budget kept on the frontend
//! (`src/metadata/scores.ts`) that leaves half the day's lookups for anything
//! else the key is used for.
//!
//! The fetching is on the frontend, where the OMDb client and its pacing
//! live; this module only says what is due and stores the answers, by IMDb id
//! so a title matched again keeps its score.

use crate::library::Db;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection};
use serde::Deserialize;

/// Critics' scores move while reviews come in; a month is fresh enough.
pub const MAX_AGE_SECS: i64 = 30 * 24 * 60 * 60;

/// IMDb ids whose score has never been looked up, or not for a month. Never
/// asked first, then oldest first; films before series, since OMDb rarely
/// has a Tomatometer for a series.
fn due(conn: &Connection, now: i64, limit: i64) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT t.imdb_id
           FROM titles t
           LEFT JOIN omdb_scores s ON s.imdb_id = t.imdb_id
          WHERE t.imdb_id LIKE 'tt%'
            AND (s.imdb_id IS NULL OR s.fetched_at <= ?1)
          GROUP BY t.imdb_id
          ORDER BY MAX(s.fetched_at IS NOT NULL), MIN(s.fetched_at),
                   MIN(t.kind = 'series'), t.imdb_id
          LIMIT ?2",
    )?;
    let rows = statement.query_map(params![now - MAX_AGE_SECS, limit], |r| r.get(0))?;
    rows.collect()
}

#[derive(Deserialize)]
pub struct ScoreInput {
    pub imdb_id: String,
    /// The Tomatometer, 0–100; `None` when OMDb has none for the title.
    pub tomatometer: Option<i64>,
}

fn save(conn: &mut Connection, scores: &[ScoreInput], now: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut upsert = tx.prepare(
            "INSERT INTO omdb_scores (imdb_id, tomatometer, fetched_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(imdb_id) DO UPDATE SET
                 tomatometer = excluded.tomatometer, fetched_at = excluded.fetched_at",
        )?;
        for s in scores {
            let score = s.tomatometer.filter(|v| (0..=100).contains(v));
            upsert.execute(params![s.imdb_id, score, now])?;
        }
    }
    tx.commit()
}

/// Tauri command: up to `limit` IMDb ids due a score lookup.
#[tauri::command]
pub fn list_titles_needing_scores(db: tauri::State<Db>, limit: i64) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    due(&conn, now_secs(), limit).map_err(to_string_err)
}

/// Tauri command: store what OMDb answered.
#[tauri::command]
pub fn save_omdb_scores(db: tauri::State<Db>, scores: Vec<ScoreInput>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    save(&mut conn, &scores, now_secs()).map_err(to_string_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 24 * 60 * 60;

    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).map_err(|e| e.to_string()).unwrap();
        conn.execute_batch(
            "INSERT INTO titles (id, kind, provider, provider_id, imdb_id, title, fetched_at) VALUES
                 (1, 'series', 'tmdb', '1', 'tt0000003', 'A show',   0),
                 (2, 'movie',  'tmdb', '2', 'tt0000001', 'A film',   0),
                 (3, 'movie',  'tmdb', '3', 'tt0000002', 'Another',  0),
                 (4, 'movie',  'tmdb', '4', NULL,        'No id',    0);",
        )
        .unwrap();
        conn
    }

    fn score(id: &str, tomatometer: Option<i64>) -> ScoreInput {
        ScoreInput { imdb_id: id.into(), tomatometer }
    }

    #[test]
    fn films_are_looked_up_before_series_and_titles_without_an_id_never() {
        let conn = library();
        assert_eq!(
            due(&conn, 1_000 * DAY, 10).unwrap(),
            vec!["tt0000001", "tt0000002", "tt0000003"]
        );
        assert_eq!(due(&conn, 1_000 * DAY, 1).unwrap(), vec!["tt0000001"]);
    }

    /// Looked up means looked up, score or not: a title OMDb has no
    /// Tomatometer for waits its month like any other.
    #[test]
    fn a_title_is_looked_up_again_after_a_month_and_not_before() {
        let mut conn = library();
        save(&mut conn, &[score("tt0000001", Some(88)), score("tt0000003", None)], 1_000 * DAY)
            .unwrap();
        assert_eq!(due(&conn, 1_010 * DAY, 10).unwrap(), vec!["tt0000002"]);
        assert_eq!(
            due(&conn, 1_030 * DAY, 10).unwrap(),
            vec!["tt0000002", "tt0000001", "tt0000003"],
            "never asked first, then the oldest"
        );
    }

    #[test]
    fn a_score_out_of_range_is_not_kept() {
        let mut conn = library();
        save(&mut conn, &[score("tt0000001", Some(140))], 1).unwrap();
        let kept: Option<i64> = conn
            .query_row("SELECT tomatometer FROM omdb_scores WHERE imdb_id = 'tt0000001'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept, None);
    }
}
