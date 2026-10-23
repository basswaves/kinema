//! Trakt — continuing on one device where a film was stopped on another.
//!
//! **What the owner decided (2026-10-17):** on whenever Trakt is connected,
//! one switch in Settings → Keep track of what I watch → Trakt turns it off ([`SWITCH_KEY`]).
//! The newer position wins, never the older. Trakt is read when a title's
//! page opens and when Home's Continue Watching rail loads — one request for
//! the account's whole resume list, kept for [`KEEP_FOR`], never fetched in
//! bulk at start. When the player leaves a film or an episode part-way, Trakt
//! is told where. No "Watching now": `scrobble/start` is never sent. SIMKL
//! stays one way (`simkl.rs`).
//!
//! **Trakt's terms, read 2026-10-17** (its API blueprint, the source of
//! trakt.docs.apiary.io):
//!
//! - There is no separate pause call any more. `POST /scrobble/stop` with a
//!   progress between 1 % and 79 % "will be treated as a pause" and saved;
//!   **at 80 % or more it is scrobbled — a play in the history**. Kinema sends
//!   its own finished items through `/sync/history` (`trakt.rs`), and Trakt
//!   keeps every play it is sent, so a stop at 80 % or more is never sent
//!   ([`STOP_BELOW`]): it would put a second play in the history.
//! - Below 1 % Trakt answers 422 and ignores it; Kinema keeps nothing under
//!   30 seconds anyway (`playback.rs`).
//! - `GET /sync/playback` lists every paused item with its `progress` (a
//!   percentage), `paused_at` and an `id`; Trakt keeps them for six months.
//!   `DELETE /sync/playback/{id}` removes one: done when a film Trakt still
//!   holds a resume point for is finished here, so another device does not
//!   offer to continue something already watched.
//! - Writes: one a second per user. Reads: 1,000 in five minutes. This sends
//!   one write when the player leaves a file and reads once per [`KEEP_FOR`].
//!
//! **Precision.** Trakt keeps a percentage. Where this copy's length is known
//! (played here before, or read by ffprobe at scan time) the resume point is
//! that share of it, a few seconds early ([`RESUME_EARLY_SECS`]). Where it is
//! not — a copy never played on this device, often the whole point — the
//! share itself is kept (`playback_state.fraction`) and the player opens the
//! file at that share of its own length.
//!
//! **What never reaches Trakt:** videos (`videos.rs`) and anything not matched
//! to a title with an IMDb or TMDB id — they have nothing Trakt could name
//! them by; a file holding two episodes, whose position belongs to neither;
//! and anything from a self-test, which runs on a copy of the library with
//! the real sign-in in it (`tracking::allowed`).

use crate::library::Db;
use crate::settings::setting;
use crate::tracking::parse_iso8601;
use crate::util::to_string_err;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// The switch: `"0"` is off; anything else, or nothing, is on.
pub const SWITCH_KEY: &str = "trakt_resume";

/// How long one read of the account's resume list is used before asking again.
const KEEP_FOR: Duration = Duration::from_secs(120);
/// Trakt scrobbles a stop at this progress or above (a play in the history).
const STOP_BELOW: f64 = 80.0;
/// Trakt ignores a stop below this progress.
const STOP_FROM: f64 = 1.0;
/// Below this, there is nothing worth resuming (as `playback::MIN_RESUME_SECS`).
const MIN_RESUME_SECS: f64 = 30.0;
/// A resume point from a percentage starts this much earlier.
const RESUME_EARLY_SECS: f64 = 5.0;
/// Two positions this close are the same point: Kinema's own pause read back.
/// Or this share of the file, should Trakt keep fewer decimals than were sent.
const SAME_POINT_SECS: f64 = 10.0;
const SAME_POINT_SHARE: f64 = 0.006;

/// The account's resume list as last read, and when.
static LIST: Mutex<Option<(Instant, Vec<Value>)>> = Mutex::new(None);

fn switched_on(conn: &Connection) -> bool {
    setting(conn, SWITCH_KEY).as_deref() != Some("0")
}

fn forget_list() {
    if let Ok(mut list) = LIST.lock() {
        *list = None;
    }
}

/// The resume list, from the copy kept for [`KEEP_FOR`] or from Trakt.
async fn playback_list(client_id: &str, access: &str) -> Result<Vec<Value>, String> {
    if let Some((at, items)) = LIST.lock().map_err(to_string_err)?.as_ref() {
        if at.elapsed() < KEEP_FOR {
            return Ok(items.clone());
        }
    }
    let (status, body) = crate::trakt::get(client_id, "/sync/playback", access).await?;
    if status != 200 {
        return Err(format!("/sync/playback answered {status}"));
    }
    let items = body.as_array().cloned().unwrap_or_default();
    *LIST.lock().map_err(to_string_err)? = Some((Instant::now(), items.clone()));
    Ok(items)
}

// ---- reading: Trakt's resume points onto this library's files ---------------

/// One of Trakt's resume points, as far as Kinema uses it.
#[derive(Debug, Clone, PartialEq)]
struct Paused {
    id: Option<i64>,
    /// 0–1.
    fraction: f64,
    paused_at: i64,
    film: bool,
    imdb: Option<String>,
    tmdb: Option<String>,
    season: Option<i64>,
    episode: Option<i64>,
}

fn read_paused(item: &Value) -> Option<Paused> {
    let progress = item["progress"].as_f64().filter(|p| p.is_finite() && *p > 0.0 && *p < 100.0)?;
    let paused_at = parse_iso8601(item["paused_at"].as_str()?)?;
    let film = match item["type"].as_str()? {
        "movie" => true,
        "episode" => false,
        _ => return None,
    };
    // An episode is named by its show's ids and its number, as Kinema names it.
    let ids = if film { &item["movie"]["ids"] } else { &item["show"]["ids"] };
    let imdb = ids["imdb"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let tmdb = ids["tmdb"].as_i64().map(|n| n.to_string());
    if imdb.is_none() && tmdb.is_none() {
        return None;
    }
    let (season, episode) = if film {
        (None, None)
    } else {
        (Some(item["episode"]["season"].as_i64()?), Some(item["episode"]["number"].as_i64()?))
    };
    Some(Paused { id: item["id"].as_i64(), fraction: progress / 100.0, paused_at, film, imdb, tmdb, season, episode })
}

/// A copy in the library of what a resume point names, with its own state.
struct Copy {
    file_id: i64,
    /// This copy's length: played here, or else read at scan time.
    duration: Option<f64>,
    position: Option<f64>,
    updated_at: Option<i64>,
}

/// Every present copy of a film, or of one episode, recognised by either id.
/// Only titles matched to a provider: a video or a title kept without a match
/// has no ids, and a file holding two episodes is left out.
fn copies(conn: &Connection, p: &Paused) -> rusqlite::Result<Vec<Copy>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, p.duration_secs, p.position_secs, p.updated_at,
                (SELECT q.details FROM media_probe q WHERE q.file_id = m.id)
           FROM media_files m
           JOIN titles t ON t.id = m.title_id
           LEFT JOIN playback_state p ON p.file_id = m.id
          WHERE m.missing = 0
            AND t.kind = ?1
            AND ((?2 IS NOT NULL AND t.imdb_id = ?2) OR (?3 IS NOT NULL AND t.tmdb_id = ?3))
            AND (?1 = 'movie'
                 OR (m.parsed_season = ?4 AND m.parsed_episode = ?5
                     AND COALESCE(m.parsed_episode_last, m.parsed_episode) = m.parsed_episode))",
    )?;
    let kind = if p.film { "movie" } else { "series" };
    let rows = stmt.query_map(params![kind, p.imdb, p.tmdb, p.season, p.episode], |r| {
        let played: Option<f64> = r.get(1)?;
        let probed = r
            .get::<_, Option<String>>(4)?
            .and_then(|d| serde_json::from_str::<Value>(&d).ok())
            .and_then(|d| d["duration_secs"].as_f64());
        Ok(Copy {
            file_id: r.get(0)?,
            duration: played.or(probed).filter(|d| *d > 0.0),
            position: r.get(2)?,
            updated_at: r.get(3)?,
        })
    })?;
    rows.collect()
}

/// Put Trakt's resume points on the copies they name, where Trakt's is the
/// newer. Returns how many copies changed. The copy's time becomes Trakt's
/// `paused_at`, so the same point is not taken twice and Continue Watching
/// orders it by when it was really paused.
fn apply(conn: &Connection, items: &[Value]) -> rusqlite::Result<usize> {
    let mut changed = 0;
    for p in items.iter().filter_map(read_paused) {
        let copies = copies(conn, &p)?;
        // Decided for the film or episode, not per copy: saving one copy
        // gives the others its position and time (`history::remember`).
        // Newer wins, never older — a finish here after the pause too.
        if copies.iter().any(|c| c.updated_at.is_some_and(|at| at >= p.paused_at)) {
            continue;
        }
        // Kinema's own pause, read back: a copy that knows its length is
        // already there.
        let own = copies.iter().any(|c| match (c.duration, c.position) {
            (Some(d), Some(at)) => (at - p.fraction * d).abs() < SAME_POINT_SECS.max(d * SAME_POINT_SHARE),
            _ => false,
        });
        if own {
            continue;
        }
        for copy in copies {
            let (position, fraction) = match copy.duration {
                Some(d) => ((p.fraction * d - RESUME_EARLY_SECS).max(0.0), None),
                None => (0.0, Some(p.fraction)),
            };
            if fraction.is_none() && position < MIN_RESUME_SECS {
                continue;
            }
            conn.execute(
                "INSERT INTO playback_state
                    (file_id, position_secs, duration_secs, completed, updated_at, fraction)
                 VALUES (?1, ?2, NULL, 0, ?3, ?4)
                 ON CONFLICT(file_id) DO UPDATE SET
                    position_secs = excluded.position_secs,
                    completed     = 0,
                    updated_at    = excluded.updated_at,
                    fraction      = excluded.fraction",
                params![copy.file_id, position, p.paused_at, fraction],
            )?;
            changed += 1;
        }
    }
    Ok(changed)
}

/// Read Trakt's resume points onto the library: on a title's page and on
/// Home's Continue Watching rail. Returns how many copies changed, so the
/// page knows to read them again. Quietly nothing when Trakt is not
/// connected, switched off, out of reach, or this is a self-test.
#[tauri::command]
pub async fn trakt_resume_sync(app: tauri::AppHandle) -> Result<usize, String> {
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        if !switched_on(&conn) {
            return Ok(0);
        }
    }
    let Some((client_id, access)) = crate::trakt::signed_in(&app).await? else { return Ok(0) };
    let items = match playback_list(&client_id, &access).await {
        Ok(items) => items,
        Err(e) => {
            crate::log!("trakt: resume points not read: {e}");
            return Ok(0);
        }
    };
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(to_string_err)?;
    let changed = apply(&conn, &items).map_err(to_string_err)?;
    if changed > 0 {
        crate::log!("trakt: {changed} resume point(s) taken from Trakt");
    }
    Ok(changed)
}

// ---- telling Trakt: where the player left a file ------------------------------

/// What leaving a file means for Trakt.
#[derive(Debug, PartialEq)]
enum Leave {
    /// `POST /scrobble/stop` with this body: a resume point.
    Pause(Value),
    /// Finished here: Trakt's resume points for it are no longer any.
    Finished(Paused),
    Nothing,
}

/// The file as it was left, by what Trakt names it with.
fn leave(conn: &Connection, file_id: i64) -> rusqlite::Result<Leave> {
    let row = conn
        .query_row(
            "SELECT t.kind, t.imdb_id, t.tmdb_id, m.parsed_season, m.parsed_episode,
                    COALESCE(m.parsed_episode_last, m.parsed_episode),
                    p.position_secs, p.duration_secs, p.completed
               FROM media_files m
               JOIN titles t ON t.id = m.title_id
               JOIN playback_state p ON p.file_id = m.id
              WHERE m.id = ?1",
            [file_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, f64>(6)?,
                    r.get::<_, Option<f64>>(7)?,
                    r.get::<_, i64>(8)? != 0,
                ))
            },
        )
        .optional()?;
    let Some((kind, imdb, tmdb, season, episode, last, position, duration, completed)) = row else {
        return Ok(Leave::Nothing);
    };
    let blank = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let (imdb, tmdb) = (blank(imdb), blank(tmdb));
    let film = match kind.as_str() {
        "movie" => true,
        "series" => false,
        _ => return Ok(Leave::Nothing),
    };
    if imdb.is_none() && tmdb.is_none() {
        return Ok(Leave::Nothing);
    }
    if !film && (season.is_none() || episode.is_none() || last != episode) {
        return Ok(Leave::Nothing);
    }
    if completed {
        return Ok(Leave::Finished(Paused {
            id: None,
            fraction: 1.0,
            paused_at: 0,
            film,
            imdb,
            tmdb,
            season,
            episode,
        }));
    }
    let Some(duration) = duration.filter(|d| *d > 0.0) else { return Ok(Leave::Nothing) };
    let progress = position / duration * 100.0;
    if position < MIN_RESUME_SECS || !(STOP_FROM..STOP_BELOW).contains(&progress) {
        return Ok(Leave::Nothing);
    }
    let ids = crate::trakt::ids(&imdb, &tmdb);
    // A TMDB id that is not a number and no IMDb id: nothing Trakt can name.
    if ids.as_object().is_none_or(|o| o.is_empty()) {
        return Ok(Leave::Nothing);
    }
    let progress = (progress * 100.0).round() / 100.0;
    let body = if film {
        json!({ "movie": { "ids": ids }, "progress": progress })
    } else {
        json!({ "show": { "ids": ids }, "episode": { "season": season, "number": episode }, "progress": progress })
    };
    Ok(Leave::Pause(body))
}

/// Whether one of Trakt's resume points names what was finished.
fn names(item: &Paused, finished: &Paused) -> bool {
    let same_id = (item.imdb.is_some() && item.imdb == finished.imdb)
        || (item.tmdb.is_some() && item.tmdb == finished.tmdb);
    same_id && item.film == finished.film && item.season == finished.season && item.episode == finished.episode
}

/// The player has left `file_id` (its last save, `playback::save_progress`).
/// In the background: the player is not held up by Trakt.
pub fn left(app: &tauri::AppHandle, file_id: i64) {
    if !crate::tracking::allowed() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = tell(&app, file_id).await {
            crate::log!("trakt: resume point not sent: {e}");
        }
    });
}

async fn tell(app: &tauri::AppHandle, file_id: i64) -> Result<(), String> {
    let what = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        if !switched_on(&conn) || !crate::tracking::connected(&conn, crate::tracking::TRAKT) {
            return Ok(());
        }
        leave(&conn, file_id).map_err(to_string_err)?
    };
    if what == Leave::Nothing {
        return Ok(());
    }
    let Some((client_id, access)) = crate::trakt::signed_in(app).await? else { return Ok(()) };
    match what {
        Leave::Pause(body) => {
            let (status, answer) = crate::trakt::post(&client_id, "/scrobble/stop", Some(&access), &body).await?;
            // Trakt says what it did; anything but a pause would be a play.
            let action = answer["action"].as_str().unwrap_or("");
            crate::log!("trakt: left part-way at {}%: {status} {action}", body["progress"]);
            forget_list();
        }
        Leave::Finished(finished) => {
            let items = playback_list(&client_id, &access).await?;
            let stale: Vec<i64> = items
                .iter()
                .filter_map(read_paused)
                .filter(|p| names(p, &finished))
                .filter_map(|p| p.id)
                .collect();
            for id in stale {
                let status = crate::trakt::delete(&client_id, &format!("/sync/playback/{id}"), &access).await?;
                crate::log!("trakt: finished here, Trakt's resume point removed: {status}");
                tokio::time::sleep(Duration::from_millis(1500)).await;
            }
            forget_list();
        }
        Leave::Nothing => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A library with one film (two copies: one played, one not), a show
    /// with a single and a double episode, and a video.
    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).map_err(|e| e.to_string()).unwrap();
        conn.execute_batch(
            r#"INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:/m', 'movies', 0);
               INSERT INTO titles (id, kind, provider, provider_id, imdb_id, tmdb_id, title, fetched_at)
               VALUES (1, 'movie',  'tmdb', '100', 'tt0000100', '100', 'Example Film', 0),
                      (2, 'series', 'tmdb', '200', '', '200', 'Example Show', 0);
               INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                   size_bytes, modified_at, first_seen_at, last_seen_at, title_id,
                   parsed_season, parsed_episode, parsed_episode_last)
               VALUES (1, 1, 'a', 'C:/m', 'a', 'mkv', 1, 0, 0, 0, 1, NULL, NULL, NULL),
                      (2, 1, 'b', 'C:/m', 'b', 'mkv', 1, 0, 0, 0, 1, NULL, NULL, NULL),
                      (3, 1, 'c', 'C:/m', 'c', 'mkv', 1, 0, 0, 0, 2, 1, 3, NULL),
                      (4, 1, 'd', 'C:/m', 'd', 'mkv', 1, 0, 0, 0, 2, 1, 1, 2),
                      (5, 1, 'e', 'C:/m', 'e', 'mkv', 1, 0, 0, 0, NULL, NULL, NULL, NULL);
               INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at)
               VALUES (1, 600, 7200, 0, 1000);"#,
        )
        .unwrap();
        conn
    }

    /// What a fake Trakt answers `GET /sync/playback` with, in its documented shape.
    fn film_paused(progress: f64, at: &str) -> Value {
        json!({ "progress": progress, "paused_at": at, "id": 13, "type": "movie",
                "movie": { "title": "Example Film", "year": 2000,
                           "ids": { "trakt": 1, "imdb": "tt0000100", "tmdb": 100 } } })
    }

    fn episode_paused(season: i64, number: i64, progress: f64) -> Value {
        json!({ "progress": progress, "paused_at": "2026-10-17T12:00:00.000Z", "id": 37, "type": "episode",
                "episode": { "season": season, "number": number, "ids": { "trakt": 9 } },
                "show": { "title": "Example Show", "ids": { "trakt": 2, "imdb": "", "tmdb": 200 } } })
    }

    fn state(conn: &Connection, file_id: i64) -> Option<(f64, Option<f64>, i64)> {
        conn.query_row(
            "SELECT position_secs, fraction, updated_at FROM playback_state WHERE file_id = ?1",
            [file_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn a_newer_pause_reaches_both_copies_seconds_where_known_a_share_where_not() {
        let conn = library();
        let at = "2026-10-17T12:00:00.000Z";
        assert_eq!(apply(&conn, &[film_paused(50.0, at)]).unwrap(), 2);
        let paused_at = parse_iso8601(at).unwrap();
        // Played here: half of its own length, a few seconds early.
        assert_eq!(state(&conn, 1), Some((3600.0 - RESUME_EARLY_SECS, None, paused_at)));
        // Never played here: the share itself, for the player.
        assert_eq!(state(&conn, 2), Some((0.0, Some(0.5), paused_at)));
        // Read again: nothing changes, it is no longer newer.
        assert_eq!(apply(&conn, &[film_paused(50.0, at)]).unwrap(), 0);
    }

    #[test]
    fn an_older_pause_never_wins() {
        let conn = library();
        conn.execute("UPDATE playback_state SET updated_at = ?1", [parse_iso8601("2026-10-18T00:00:00Z").unwrap()])
            .unwrap();
        // Copy 1's newer position decides for the film: copy 2 is left too.
        assert_eq!(apply(&conn, &[film_paused(50.0, "2026-10-17T12:00:00Z")]).unwrap(), 0);
        assert_eq!(state(&conn, 1).unwrap().0, 600.0, "the newer position here stays");
        assert_eq!(state(&conn, 2), None);
    }

    #[test]
    fn kinemas_own_pause_leaves_the_other_copy_its_seconds() {
        let conn = library();
        // Saving copy 1 gave copy 2 its position (history::remember), with no length.
        conn.execute(
            "INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at)
             VALUES (2, 600, NULL, 0, 1000)",
            [],
        )
        .unwrap();
        // Read back with fewer decimals than were sent: 8 % of 7200 is 576 s.
        assert_eq!(apply(&conn, &[film_paused(8.0, "2026-10-17T12:00:00Z")]).unwrap(), 0);
        assert_eq!(state(&conn, 2), Some((600.0, None, 1000)));
    }

    #[test]
    fn a_finish_here_after_the_pause_stays_finished() {
        let conn = library();
        conn.execute(
            "UPDATE playback_state SET completed = 1, updated_at = ?1",
            [parse_iso8601("2026-10-18T00:00:00Z").unwrap()],
        )
        .unwrap();
        apply(&conn, &[film_paused(50.0, "2026-10-17T12:00:00Z")]).unwrap();
        let completed: i64 = conn
            .query_row("SELECT completed FROM playback_state WHERE file_id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(completed, 1);
    }

    #[test]
    fn kinemas_own_pause_read_back_is_left_alone() {
        let conn = library();
        // Sent at 600 s of 7200 (8.33 %); Trakt's paused_at is a moment later.
        assert_eq!(apply(&conn, &[film_paused(8.33, "2026-10-17T12:00:00Z")]).unwrap(), 0);
        assert_eq!(state(&conn, 1).unwrap().0, 600.0);
        assert_eq!(state(&conn, 1).unwrap().2, 1000, "untouched");
    }

    #[test]
    fn an_episode_is_found_by_its_shows_ids_and_a_double_episode_file_never() {
        let conn = library();
        assert_eq!(apply(&conn, &[episode_paused(1, 3, 25.0)]).unwrap(), 1);
        assert_eq!(state(&conn, 3).unwrap().1, Some(0.25));
        assert_eq!(apply(&conn, &[episode_paused(1, 1, 25.0)]).unwrap(), 0);
        assert_eq!(state(&conn, 4), None);
    }

    #[test]
    fn what_trakt_cannot_name_or_did_not_mean_is_ignored() {
        let conn = library();
        let mut no_ids = film_paused(50.0, "2026-10-17T12:00:00Z");
        no_ids["movie"]["ids"] = json!({ "trakt": 1 });
        let mut no_time = film_paused(50.0, "2026-10-17T12:00:00Z");
        no_time["paused_at"] = json!(null);
        let other = json!({ "progress": 50.0, "paused_at": "2026-10-17T12:00:00Z", "type": "movie",
                            "movie": { "ids": { "tmdb": 999 } } });
        assert_eq!(apply(&conn, &[no_ids, no_time, other, film_paused(0.0, "2026-10-17T12:00:00Z")]).unwrap(), 0);
        assert_eq!(state(&conn, 5), None, "a video is never touched");
    }

    #[test]
    fn leaving_part_way_sends_a_pause_trakt_will_not_count_as_a_play() {
        let conn = library();
        let Leave::Pause(body) = leave(&conn, 1).unwrap() else { panic!("a pause") };
        assert_eq!(body, json!({ "movie": { "ids": { "imdb": "tt0000100", "tmdb": 100 } }, "progress": 8.33 }));

        // At 80 % or more Trakt would scrobble it: never sent.
        conn.execute("UPDATE playback_state SET position_secs = 5800 WHERE file_id = 1", []).unwrap();
        assert_eq!(leave(&conn, 1).unwrap(), Leave::Nothing);
        // Under 30 seconds there is nothing to resume.
        conn.execute("UPDATE playback_state SET position_secs = 20 WHERE file_id = 1", []).unwrap();
        assert_eq!(leave(&conn, 1).unwrap(), Leave::Nothing);
    }

    #[test]
    fn an_episode_pause_names_the_show_and_the_number() {
        let conn = library();
        conn.execute(
            "INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at)
             VALUES (3, 300, 1200, 0, 1), (4, 300, 2400, 0, 1), (5, 300, 1200, 0, 1)",
            [],
        )
        .unwrap();
        let Leave::Pause(body) = leave(&conn, 3).unwrap() else { panic!("a pause") };
        assert_eq!(
            body,
            json!({ "show": { "ids": { "tmdb": 200 } }, "episode": { "season": 1, "number": 3 }, "progress": 25.0 })
        );
        assert_eq!(leave(&conn, 4).unwrap(), Leave::Nothing, "a double episode");
        assert_eq!(leave(&conn, 5).unwrap(), Leave::Nothing, "a video");
    }

    /// An answer saved from the real `/sync/playback`:
    /// `KINEMA_TRAKT_PLAYBACK_JSON=<file> cargo test -- --ignored a_saved_trakt_answer`.
    #[test]
    #[ignore]
    fn a_saved_trakt_answer_is_read() {
        let Ok(path) = std::env::var("KINEMA_TRAKT_PLAYBACK_JSON") else { return };
        let body: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let items = body.as_array().unwrap();
        let read: Vec<Paused> = items.iter().filter_map(read_paused).collect();
        assert_eq!(read.len(), items.len(), "every resume point Trakt gave is understood");
        for p in &read {
            println!("film {} at {:.4} paused {} id {:?}", p.film, p.fraction, p.paused_at, p.id);
        }
        // And onto a copy of a real library (upgraded first), when given one.
        if let Ok(copy) = std::env::var("KINEMA_LIBRARY_COPY") {
            let conn = crate::db::open(std::path::Path::new(&copy)).unwrap();
            println!("copies changed: {}", apply(&conn, items).unwrap());
        }
    }

    #[test]
    fn finishing_here_clears_trakts_resume_point_for_it_only() {
        let conn = library();
        conn.execute("UPDATE playback_state SET completed = 1 WHERE file_id = 1", []).unwrap();
        let Leave::Finished(finished) = leave(&conn, 1).unwrap() else { panic!("finished") };
        let film = read_paused(&film_paused(50.0, "2026-10-17T12:00:00Z")).unwrap();
        let episode = read_paused(&episode_paused(1, 3, 25.0)).unwrap();
        assert!(names(&film, &finished));
        assert!(!names(&episode, &finished));
    }
}
