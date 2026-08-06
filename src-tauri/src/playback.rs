//! Resume points, Continue Watching, next-episode lookup and track memory.

use crate::library::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};
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
    pub updated_at: i64,
}

#[derive(Serialize)]
pub struct NextEpisode {
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

/// Store a resume point. Completion is decided here rather than by the caller
/// so the rule stays in one place.
#[tauri::command]
pub fn save_progress(
    db: tauri::State<Db>,
    file_id: i64,
    position_secs: f64,
    duration_secs: Option<f64>,
) -> Result<(), String> {
    let completed = match duration_secs {
        Some(d) if d > 0.0 => position_secs / d >= COMPLETE_FRACTION,
        _ => false,
    };

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

/// Partly-watched items, most recent first. Finished items are excluded, and
/// so are ones barely started — neither is something you want to resume.
#[tauri::command]
pub fn continue_watching(db: tauri::State<Db>, limit: i64) -> Result<Vec<ContinueItem>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT p.file_id, m.path, t.id, t.title, t.kind,
                    m.parsed_season, m.parsed_episode, e.name,
                    p.position_secs, p.duration_secs,
                    COALESCE(e.still_url, t.backdrop_url, t.poster_url),
                    p.updated_at
               FROM playback_state p
               JOIN media_files m ON m.id = p.file_id
               JOIN titles t      ON t.id = m.title_id
               LEFT JOIN episodes e ON e.title_id = m.title_id
                                   AND e.season  = m.parsed_season
                                   AND e.episode = m.parsed_episode
              WHERE p.completed = 0
                AND p.position_secs >= ?2
                AND m.missing = 0
              ORDER BY p.updated_at DESC
              LIMIT ?1",
        )
        .map_err(to_string_err)?;

    let rows = stmt
        .query_map(params![limit, MIN_RESUME_SECS], |r| {
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
            })
        })
        .map_err(to_string_err)?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_string_err)
}

/// The next episode we actually hold, in (season, episode) order. Gaps in the
/// library are skipped rather than stopping playback — if you own E01 and E03,
/// E03 is next.
#[tauri::command]
pub fn next_episode(db: tauri::State<Db>, file_id: i64) -> Result<Option<NextEpisode>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;

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

    conn.query_row(
        "SELECT m.id, m.path, m.parsed_season, m.parsed_episode, e.name, t.title
           FROM media_files m
           JOIN titles t ON t.id = m.title_id
           LEFT JOIN episodes e ON e.title_id = m.title_id
                               AND e.season  = m.parsed_season
                               AND e.episode = m.parsed_episode
          WHERE m.title_id = ?1
            AND m.missing = 0
            AND (m.parsed_season > ?2
                 OR (m.parsed_season = ?2 AND m.parsed_episode > ?3))
          ORDER BY m.parsed_season, m.parsed_episode
          LIMIT 1",
        params![title_id, season, episode],
        |r| {
            Ok(NextEpisode {
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
