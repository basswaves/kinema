//! Resume points, Continue Watching, next-episode lookup and track memory.

use crate::artwork::path_prefix;
use crate::library::Db;
use rusqlite::{named_params, params};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

fn to_string_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Below this many seconds in, there is nothing worth resuming.
const MIN_RESUME_SECS: f64 = 30.0;
/// Past this fraction, treat the file as finished rather than resumable.
const COMPLETE_FRACTION: f64 = 0.94;

#[derive(Serialize)]
pub struct Progress {
    pub position_secs: f64,
    pub duration_secs: Option<f64>,
    pub completed: bool,
}

#[derive(Serialize)]
pub struct ContinueItem {
    pub file_id: i64,
    pub path: String,
    pub title_id: i64,
    pub title: String,
    pub kind: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub episode_name: Option<String>,
    pub position_secs: f64,
    pub duration_secs: Option<f64>,
    pub image_url: Option<String>,
    pub image_path: Option<String>,
    pub updated_at: i64,
    /// True when this is the *next* episode to start rather than one already
    /// part-watched. The card has no progress to draw and must not claim any:
    /// a bar sitting at 0% reads as "something went wrong", not as "not started".
    pub is_next_up: bool,
}

/// Enough to play a neighbouring episode and label it. Used in both directions
/// — the up-next card and the player's previous/next buttons.
#[derive(Serialize)]
pub struct EpisodeRef {
    pub file_id: i64,
    pub path: String,
    pub season: i64,
    pub episode: i64,
    pub name: Option<String>,
    pub title: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct TitlePrefs {
    pub audio_lang: Option<String>,
    pub sub_lang: Option<String>,
    pub sub_enabled: bool,
}

/// Whether a position counts as having finished the file.
///
/// Past [`COMPLETE_FRACTION`], or past the start of the credits when the player
/// knows where they are. The second half is the one that matters: on an
/// episode whose credits run longer than 6% of it — anime, most half-hour
/// comedy — skipping them or pressing "Play next" in them left the position
/// short of 94%, and the episode sat in Continue Watching as "2 min left".
///
/// A credits start in the first half of the file is not believed: that is a
/// marker problem, and trusting it would mark an episode watched halfway in.
pub fn is_complete(position: f64, duration: Option<f64>, credits_start: Option<f64>) -> bool {
    let Some(duration) = duration.filter(|d| *d > 0.0) else {
        return false;
    };
    if position / duration >= COMPLETE_FRACTION {
        return true;
    }
    credits_start
        .filter(|start| start.is_finite() && *start >= duration * 0.5 && *start < duration)
        .is_some_and(|start| position >= start)
}

/// Store a resume point. Completion is decided here rather than by the caller
/// so the rule stays in one place.
///
/// `credits_start` is where the player believes the credits begin, from a
/// measured marker or a named chapter — never from the `duration − N` guess,
/// which is inference and must not decide what counts as seen.
#[tauri::command]
pub fn save_progress(
    db: tauri::State<Db>,
    file_id: i64,
    position_secs: f64,
    duration_secs: Option<f64>,
    credits_start: Option<f64>,
) -> Result<(), String> {
    let completed = is_complete(position_secs, duration_secs, credits_start);

    let conn = db.0.lock().map_err(to_string_err)?;
    conn.execute(
        "INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(file_id) DO UPDATE SET
            position_secs = excluded.position_secs,
            duration_secs = excluded.duration_secs,
            completed     = excluded.completed,
            updated_at    = excluded.updated_at",
        params![
            file_id,
            position_secs,
            duration_secs,
            completed as i64,
            now_secs()
        ],
    )
    .map_err(to_string_err)?;
    Ok(())
}

/// Mark a file watched, or clear it, by hand.
///
/// "Watched" is deliberately the *same* `completed` flag that playback sets when
/// a file reaches the end, not a second column beside it. Two notions of "seen"
/// would disagree the first time one was written without the other, and the
/// disagreement would be invisible — the row would show a tick while Continue
/// Watching still offered it.
///
/// Un-watching **deletes** the row rather than clearing the flag. "Not watched"
/// and "no history" are the same state, and leaving the position behind would
/// resume a file the user has just declared unseen.
#[tauri::command]
pub fn set_watched(db: tauri::State<Db>, file_id: i64, watched: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;

    if watched {
        conn.execute(
            "INSERT INTO playback_state
                (file_id, position_secs, duration_secs, completed, updated_at)
             VALUES (?1, 0, NULL, 1, ?2)
             ON CONFLICT(file_id) DO UPDATE SET
                completed  = 1,
                updated_at = excluded.updated_at",
            params![file_id, now_secs()],
        )
    } else {
        conn.execute(
            "DELETE FROM playback_state WHERE file_id = ?1",
            params![file_id],
        )
    }
    .map_err(to_string_err)?;

    Ok(())
}

#[tauri::command]
pub fn get_progress(db: tauri::State<Db>, file_id: i64) -> Result<Option<Progress>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.query_row(
        "SELECT position_secs, duration_secs, completed FROM playback_state WHERE file_id = ?1",
        params![file_id],
        |r| {
            Ok(Progress {
                position_secs: r.get(0)?,
                duration_secs: r.get(1)?,
                completed: r.get::<_, i64>(2)? != 0,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(to_string_err(other)),
    })
}

/// Shared projection for a Continue Watching card, so the two sources — a
/// part-watched file and the next episode to start — cannot drift into
/// describing the same card differently.
///
/// It starts at `media_files` and *left* joins `playback_state`, because a
/// next-up episode has no playback row at all. The cached image is looked up for
/// the same URL the COALESCE picked, not by a second COALESCE over the cache:
/// those could disagree and show the backdrop where the episode still belongs.
const CONTINUE_SELECT: &str = "
    SELECT m.id, m.path, t.id, t.title, t.kind,
           m.parsed_season, m.parsed_episode, e.name,
           COALESCE(p.position_secs, 0), p.duration_secs,
           COALESCE(e.still_url, t.backdrop_url, t.poster_url),
           COALESCE(p.updated_at, 0),
           (SELECT :art || a.local_path FROM artwork_cache a
             WHERE a.url = COALESCE(e.still_url, t.backdrop_url, t.poster_url)
               AND a.local_path <> '')
      FROM media_files m
      JOIN titles t ON t.id = m.title_id
      LEFT JOIN playback_state p ON p.file_id = m.id
      LEFT JOIN episodes e ON e.title_id = m.title_id
                          AND e.season  = m.parsed_season
                          AND e.episode = m.parsed_episode";

fn map_continue(r: &rusqlite::Row) -> rusqlite::Result<ContinueItem> {
    Ok(ContinueItem {
        file_id: r.get(0)?,
        path: r.get(1)?,
        title_id: r.get(2)?,
        title: r.get(3)?,
        kind: r.get(4)?,
        season: r.get(5)?,
        episode: r.get(6)?,
        episode_name: r.get(7)?,
        position_secs: r.get(8)?,
        duration_secs: r.get(9)?,
        image_url: r.get(10)?,
        updated_at: r.get(11)?,
        image_path: r.get(12)?,
        // Set by the caller: the projection cannot tell which branch asked.
        is_next_up: false,
    })
}

/// Season and episode packed into one sortable integer.
///
/// SQLite has no lexicographic comparison over two columns, and the alternative
/// — `season > ? OR (season = ? AND episode > ?)` — cannot be wrapped in `MAX()`.
/// One encoder and one decoder, so the two halves cannot disagree about the
/// multiplier. No episode numbering comes anywhere near five digits.
const EPISODE_KEY_BASE: i64 = 100_000;

fn decode_episode_key(key: i64) -> (i64, i64) {
    (key / EPISODE_KEY_BASE, key % EPISODE_KEY_BASE)
}

#[cfg(test)]
fn encode_episode_key(season: i64, episode: i64) -> i64 {
    season * EPISODE_KEY_BASE + episode
}

/// The furthest-watched episode of every series with any watch history, and
/// when that series was last touched.
///
/// `MAX(updated_at)` is deliberately the most recent activity on the *show*
/// rather than the timestamp of the furthest episode. It is only used to order
/// the rail, and "what did I last watch" is the question the rail answers.
fn last_watched_per_series(conn: &rusqlite::Connection) -> Result<Vec<(i64, i64, i64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.title_id,
                    MAX(m.parsed_season * :base + m.parsed_episode),
                    MAX(p.updated_at)
               FROM playback_state p
               JOIN media_files m ON m.id = p.file_id
              WHERE p.completed = 1
                AND m.missing = 0
                AND m.parsed_season  IS NOT NULL
                AND m.parsed_episode IS NOT NULL
              GROUP BY m.title_id",
        )
        .map_err(to_string_err)?;

    let rows = stmt
        .query_map(named_params! { ":base": EPISODE_KEY_BASE }, |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(to_string_err)?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_string_err)
}

/// What to watch next, most recent activity first.
///
/// Two sources, one card per show:
///
///  1. A file you are part-way through. Unchanged behaviour.
///  2. For a series you have finished an episode of and started nothing since,
///     the next episode the library actually holds.
///
/// Without (2) a show vanishes from Home the moment an episode finishes, which
/// is exactly the point at which you want it offered. The merge happens here
/// rather than in SQL: a single query covering both would be unreadable, and
/// (1) is the tested one.
#[tauri::command]
pub fn continue_watching(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    limit: i64,
) -> Result<Vec<ContinueItem>, String> {
    let art = path_prefix(&app)?;
    let conn = db.0.lock().map_err(to_string_err)?;

    // ---- 1. part-watched files ------------------------------------------
    let mut items: Vec<ContinueItem> = {
        let sql = format!(
            "{CONTINUE_SELECT}
              WHERE p.completed = 0
                AND p.position_secs >= :min
                AND m.missing = 0
              ORDER BY p.updated_at DESC"
        );
        let mut stmt = conn.prepare(&sql).map_err(to_string_err)?;
        let rows = stmt
            .query_map(
                named_params! { ":art": &art, ":min": MIN_RESUME_SECS },
                map_continue,
            )
            .map_err(to_string_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(to_string_err)?
    };

    // One card per show. Starting three episodes of the same series produced
    // three cards for it, which pushed everything else off the rail.
    let mut seen: HashSet<i64> = HashSet::new();
    items.retain(|item| seen.insert(item.title_id));

    // ---- 2. the next episode of a show with nothing in progress ----------
    let mut hydrate = conn
        .prepare(&format!("{CONTINUE_SELECT} WHERE m.id = :file_id"))
        .map_err(to_string_err)?;

    for (title_id, last_key, last_at) in last_watched_per_series(&conn)? {
        // A show already offering a part-watched file does not also need its
        // next episode — that is the same show twice.
        if seen.contains(&title_id) {
            continue;
        }

        let (season, episode) = decode_episode_key(last_key);
        // Anything already in progress belongs to branch 1 and was skipped
        // above, so in practice this returns an episode not yet started — but
        // the "not finished" rule also picks up one abandoned inside the first
        // 30 seconds, which branch 1 filters out and which is genuinely next.
        let Some(next) = adjacent_from(&conn, title_id, season, episode, true, true)? else {
            continue;
        };

        let mut item = hydrate
            .query_row(
                named_params! { ":art": &art, ":file_id": next.file_id },
                map_continue,
            )
            .map_err(to_string_err)?;

        item.is_next_up = true;
        // The file itself has never been played, so its own timestamp is zero.
        // The show's last activity is what this card should be ordered by.
        item.updated_at = last_at;
        seen.insert(title_id);
        items.push(item);
    }

    hide_dismissed(&conn, &mut items)?;
    items.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    items.truncate(limit.max(0) as usize);
    Ok(items)
}

/// Drop the cards for titles taken out of Continue Watching by hand, unless
/// something has been watched since.
///
/// Compared against the card's own activity time, which for a "Next episode"
/// card is the show's latest activity — so playing any episode of the show
/// again brings it back, and nothing else does.
fn hide_dismissed(
    conn: &rusqlite::Connection,
    items: &mut Vec<ContinueItem>,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT dismissed_at FROM continue_dismissed WHERE title_id = ?1")
        .map_err(to_string_err)?;
    let mut keep = Vec::with_capacity(items.len());
    for item in items.drain(..) {
        let dismissed: Option<i64> = stmt
            .query_row(params![item.title_id], |r| r.get(0))
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(to_string_err(other)),
            })?;
        if dismissed.is_none_or(|at| item.updated_at > at) {
            keep.push(item);
        }
    }
    *items = keep;
    Ok(())
}

/// Take a title out of Continue Watching until it is watched again.
///
/// Deliberately not the same as forgetting progress, which is what "Remove"
/// used to do: that could not remove a "Next episode" card at all, and turned a
/// part-watched card into one. The resume point is kept, so opening the episode
/// later still continues where it was.
#[tauri::command]
pub fn dismiss_continue(db: tauri::State<Db>, title_id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    dismiss(&conn, title_id, now_secs())
}

fn dismiss(conn: &rusqlite::Connection, title_id: i64, at: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO continue_dismissed (title_id, dismissed_at) VALUES (?1, ?2)
         ON CONFLICT(title_id) DO UPDATE SET dismissed_at = excluded.dismissed_at",
        params![title_id, at],
    )
    .map_err(to_string_err)?;
    Ok(())
}

/// The episode either side of a given (season, episode) within one title.
///
/// Gaps in the library are skipped rather than stopping: if you own E01 and E03,
/// E03 is what follows E01. The two directions are one query with the comparison
/// and the sort flipped, so they can never disagree about the ordering — a
/// separate "previous" query would be the obvious place for them to drift.
///
/// This is the shared core: the player's previous/next buttons reach it through
/// `adjacent_episode` with a file id, and Continue Watching reaches it directly
/// with the furthest-watched position of a show. One ordering, three callers.
///
/// `unwatched_only` restricts the answer to an episode that has not been
/// finished. Deliberately "not completed" rather than "never started": an
/// episode you are ten minutes into is the next one to watch, and testing for
/// the absence of a playback row would skip straight past it to the one after.
fn adjacent_from(
    conn: &rusqlite::Connection,
    title_id: i64,
    season: i64,
    episode: i64,
    forward: bool,
    unwatched_only: bool,
) -> Result<Option<EpisodeRef>, String> {
    // Interpolated rather than bound because they are operators and sort
    // keywords, not values — all three come from the arguments, never from input.
    let (cmp, order) = if forward { (">", "ASC") } else { ("<", "DESC") };
    let unwatched = if unwatched_only {
        "AND NOT EXISTS (SELECT 1 FROM playback_state ps
                          WHERE ps.file_id = m.id AND ps.completed = 1)"
    } else {
        ""
    };

    conn.query_row(
        &format!(
            "SELECT m.id, m.path, m.parsed_season, m.parsed_episode, e.name, t.title
               FROM media_files m
               JOIN titles t ON t.id = m.title_id
               LEFT JOIN episodes e ON e.title_id = m.title_id
                                   AND e.season  = m.parsed_season
                                   AND e.episode = m.parsed_episode
              WHERE m.title_id = ?1
                AND m.missing = 0
                AND (m.parsed_season {cmp} ?2
                     OR (m.parsed_season = ?2 AND m.parsed_episode {cmp} ?3))
                {unwatched}
              ORDER BY m.parsed_season {order}, m.parsed_episode {order}
              LIMIT 1"
        ),
        params![title_id, season, episode],
        |r| {
            Ok(EpisodeRef {
                file_id: r.get(0)?,
                path: r.get(1)?,
                season: r.get(2)?,
                episode: r.get(3)?,
                name: r.get(4)?,
                title: r.get(5)?,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(to_string_err(other)),
    })
}

/// The episode either side of the one backing `file_id`.
fn adjacent_episode(
    conn: &rusqlite::Connection,
    file_id: i64,
    forward: bool,
) -> Result<Option<EpisodeRef>, String> {
    let current: Option<(i64, i64, i64)> = conn
        .query_row(
            "SELECT title_id, parsed_season, parsed_episode FROM media_files WHERE id = ?1",
            params![file_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();

    let Some((title_id, season, episode)) = current else {
        return Ok(None);
    };

    adjacent_from(conn, title_id, season, episode, forward, false)
}

/// The first episode of a series worth playing: where you left off, else the
/// earliest one not yet seen, else the very first the library holds.
///
/// Pressing Play on a show is a different question from opening it, and the
/// answer must never be "whichever file happens to be biggest" — which is what
/// falling through to the movie path used to give.
#[tauri::command]
pub fn first_unwatched_episode(
    db: tauri::State<Db>,
    title_id: i64,
) -> Result<Option<EpisodeRef>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;

    // Season 0 is Specials and sorts first, so anchor below every real value
    // rather than at zero — otherwise a show whose only unseen episode is a
    // special would look finished.
    if let Some(unwatched) = adjacent_from(&conn, title_id, -1, -1, true, true)? {
        return Ok(Some(unwatched));
    }

    // Everything has been seen. Offering the first episode is a better answer
    // than offering nothing: re-watching from the start is a real intention,
    // and it is the one the Play button can serve without guessing.
    adjacent_from(&conn, title_id, -1, -1, true, false)
}

#[tauri::command]
pub fn next_episode(db: tauri::State<Db>, file_id: i64) -> Result<Option<EpisodeRef>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    adjacent_episode(&conn, file_id, true)
}

#[tauri::command]
pub fn previous_episode(db: tauri::State<Db>, file_id: i64) -> Result<Option<EpisodeRef>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    adjacent_episode(&conn, file_id, false)
}

#[tauri::command]
pub fn get_title_prefs(db: tauri::State<Db>, title_id: i64) -> Result<TitlePrefs, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.query_row(
        "SELECT audio_lang, sub_lang, sub_enabled FROM title_prefs WHERE title_id = ?1",
        params![title_id],
        |r| {
            Ok(TitlePrefs {
                audio_lang: r.get(0)?,
                sub_lang: r.get(1)?,
                sub_enabled: r.get::<_, i64>(2)? != 0,
            })
        },
    )
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(TitlePrefs {
            audio_lang: None,
            sub_lang: None,
            sub_enabled: true,
        }),
        other => Err(to_string_err(other)),
    })
}

#[tauri::command]
pub fn set_title_prefs(
    db: tauri::State<Db>,
    title_id: i64,
    prefs: TitlePrefs,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.execute(
        "INSERT INTO title_prefs (title_id, audio_lang, sub_lang, sub_enabled, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(title_id) DO UPDATE SET
            audio_lang  = excluded.audio_lang,
            sub_lang    = excluded.sub_lang,
            sub_enabled = excluded.sub_enabled,
            updated_at  = excluded.updated_at",
        params![
            title_id,
            prefs.audio_lang,
            prefs.sub_lang,
            prefs.sub_enabled as i64,
            now_secs()
        ],
    )
    .map_err(to_string_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{decode_episode_key, dismiss, encode_episode_key, hide_dismissed, is_complete};
    use super::ContinueItem;

    fn card(title_id: i64, updated_at: i64, next_up: bool) -> ContinueItem {
        ContinueItem {
            file_id: title_id * 10,
            path: String::new(),
            title_id,
            title: String::new(),
            kind: "series".into(),
            season: Some(1),
            episode: Some(1),
            episode_name: None,
            position_secs: 0.0,
            duration_secs: None,
            image_url: None,
            image_path: None,
            updated_at,
            is_next_up: next_up,
        }
    }

    fn library() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE continue_dismissed (title_id INTEGER PRIMARY KEY, dismissed_at INTEGER NOT NULL);",
        )
        .unwrap();
        conn
    }

    /// The bug: Remove on a "Next episode" card came straight back, because
    /// there was no resume row for it to delete.
    #[test]
    fn a_removed_next_episode_card_stays_removed() {
        let conn = library();
        dismiss(&conn, 1, 500).unwrap();
        let mut items = vec![card(1, 400, true), card(2, 450, false)];
        hide_dismissed(&conn, &mut items).unwrap();
        assert_eq!(items.iter().map(|i| i.title_id).collect::<Vec<_>>(), vec![2]);
    }

    /// Watching the show again is what brings it back — and only that.
    #[test]
    fn watching_again_brings_it_back() {
        let conn = library();
        dismiss(&conn, 1, 500).unwrap();
        let mut items = vec![card(1, 501, false)];
        hide_dismissed(&conn, &mut items).unwrap();
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn other_titles_are_untouched() {
        let conn = library();
        let mut items = vec![card(3, 10, false)];
        hide_dismissed(&conn, &mut items).unwrap();
        assert_eq!(items.len(), 1);
    }

    /// The case that was broken, with the mock fixture's numbers: a 24-minute
    /// episode whose credits start at 22:10 (92.4%). "Play next" at 22:15 used
    /// to leave it unwatched.
    #[test]
    fn inside_the_credits_counts_as_finished() {
        assert!(is_complete(1335.0, Some(1440.0), Some(1330.0)));
        assert!(!is_complete(1335.0, Some(1440.0), None), "without credits, 94% still rules");
    }

    #[test]
    fn before_the_credits_does_not() {
        assert!(!is_complete(1300.0, Some(1440.0), Some(1330.0)));
    }

    #[test]
    fn ninety_four_percent_still_counts_on_its_own() {
        assert!(is_complete(1360.0, Some(1440.0), None));
    }

    /// A credits marker in the first half is a bad marker, not a short episode.
    #[test]
    fn an_implausibly_early_credits_start_is_ignored() {
        assert!(!is_complete(500.0, Some(1440.0), Some(400.0)));
    }

    #[test]
    fn nothing_counts_without_a_duration() {
        assert!(!is_complete(1335.0, None, Some(1330.0)));
        assert!(!is_complete(1335.0, Some(0.0), Some(1330.0)));
    }

    /// The encoder lives in SQL and the decoder in Rust, so the multiplier is
    /// written down twice and nothing but this test would notice them diverging.
    #[test]
    fn the_episode_key_survives_a_round_trip() {
        for (season, episode) in [(0, 1), (1, 1), (1, 24), (7, 9), (12, 100)] {
            assert_eq!(
                decode_episode_key(encode_episode_key(season, episode)),
                (season, episode)
            );
        }
    }

    /// Specials are season 0 and must sort before season 1, or a show whose
    /// only unseen episode is a special would look finished.
    #[test]
    fn specials_sort_before_the_first_season() {
        assert!(encode_episode_key(0, 99) < encode_episode_key(1, 1));
    }

    /// The whole point of packing: a later season always outranks an earlier
    /// one, however high the earlier season's episode numbers ran.
    #[test]
    fn a_later_season_always_outranks_a_high_episode_number() {
        assert!(encode_episode_key(2, 1) > encode_episode_key(1, 99));
    }
}
