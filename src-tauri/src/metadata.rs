//! Persistence for matched titles and episodes.
//!
//! Fetching happens in the frontend (where the provider clients live); this
//! module only stores results. Keeping them separate means matching rules can
//! be re-run against cached titles without re-hitting any API.

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

#[derive(Deserialize)]
pub struct TitleInput {
    pub kind: String,
    pub provider: String,
    pub provider_id: String,
    pub imdb_id: Option<String>,
    pub tmdb_id: Option<String>,
    pub title: String,
    pub year: Option<i64>,
    pub overview: Option<String>,
    pub genres: Option<String>,
    pub runtime_mins: Option<i64>,
    pub rating: Option<f64>,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
}

#[derive(Deserialize)]
pub struct EpisodeInput {
    pub season: i64,
    pub episode: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub air_date: Option<String>,
    pub runtime_mins: Option<i64>,
    pub still_url: Option<String>,
}

#[derive(Serialize)]
pub struct Title {
    pub id: i64,
    pub kind: String,
    pub provider: String,
    pub title: String,
    pub year: Option<i64>,
    pub overview: Option<String>,
    pub genres: Option<String>,
    pub runtime_mins: Option<i64>,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub rating: Option<f64>,
    pub file_count: i64,
    /// When this title's first file appeared, for the "recently added" rail.
    pub added_at: Option<i64>,
}

#[derive(Serialize)]
pub struct Episode {
    pub id: i64,
    pub season: i64,
    pub episode: i64,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub air_date: Option<String>,
    pub runtime_mins: Option<i64>,
    pub still_url: Option<String>,
    /// Path of the file backing this episode, if the library actually has it.
    pub file_path: Option<String>,
    pub file_id: Option<i64>,
}

#[derive(Serialize)]
pub struct TitleDetail {
    pub title: Title,
    pub episodes: Vec<Episode>,
    /// For movies: the playable file.
    pub movie_path: Option<String>,
    pub movie_file_id: Option<i64>,
}

/// Upsert by (provider, provider_id) so re-matching never duplicates a title.
#[tauri::command]
pub fn save_title(db: tauri::State<Db>, title: TitleInput) -> Result<i64, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.execute(
        "INSERT INTO titles
            (kind, provider, provider_id, imdb_id, tmdb_id, title, year, overview,
             genres, runtime_mins, rating, poster_url, backdrop_url, fetched_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
         ON CONFLICT(provider, provider_id) DO UPDATE SET
            imdb_id = excluded.imdb_id, tmdb_id = excluded.tmdb_id,
            title = excluded.title, year = excluded.year, overview = excluded.overview,
            genres = excluded.genres, runtime_mins = excluded.runtime_mins,
            rating = excluded.rating, poster_url = excluded.poster_url,
            backdrop_url = excluded.backdrop_url, fetched_at = excluded.fetched_at",
        params![
            title.kind, title.provider, title.provider_id, title.imdb_id, title.tmdb_id,
            title.title, title.year, title.overview, title.genres, title.runtime_mins,
            title.rating, title.poster_url, title.backdrop_url, now_secs()
        ],
    )
    .map_err(to_string_err)?;

    conn.query_row(
        "SELECT id FROM titles WHERE provider = ?1 AND provider_id = ?2",
        params![title.provider, title.provider_id],
        |r| r.get(0),
    )
    .map_err(to_string_err)
}

#[tauri::command]
pub fn save_episodes(
    db: tauri::State<Db>,
    title_id: i64,
    episodes: Vec<EpisodeInput>,
) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    let tx = conn.transaction().map_err(to_string_err)?;
    let mut n = 0;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO episodes
                    (title_id, season, episode, name, overview, air_date, runtime_mins, still_url)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(title_id, season, episode) DO UPDATE SET
                    name = excluded.name, overview = excluded.overview,
                    air_date = excluded.air_date, runtime_mins = excluded.runtime_mins,
                    still_url = excluded.still_url",
            )
            .map_err(to_string_err)?;

        for e in episodes {
            stmt.execute(params![
                title_id, e.season, e.episode, e.name, e.overview, e.air_date, e.runtime_mins,
                e.still_url
            ])
            .map_err(to_string_err)?;
            n += 1;
        }
    }
    tx.commit().map_err(to_string_err)?;
    Ok(n)
}

/// Attach a file to a title. `status` is 'matched' or 'unmatched' — the caller
/// decides based on confidence, because the threshold is a matching-policy
/// decision, not a storage one.
#[tauri::command]
pub fn link_file_to_title(
    db: tauri::State<Db>,
    file_id: i64,
    title_id: Option<i64>,
    confidence: Option<f64>,
    reason: Option<String>,
    status: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.execute(
        "UPDATE media_files
            SET title_id = ?2, match_confidence = ?3, match_reason = ?4, match_status = ?5
          WHERE id = ?1",
        params![file_id, title_id, confidence, reason, status],
    )
    .map_err(to_string_err)?;
    Ok(())
}

/// Unlink every file and drop cached titles so matching runs again from
/// scratch — needed when a provider key is added, since the provider choice is
/// made at match time. Parse results and scan data are untouched.
#[tauri::command]
pub fn reset_matches(db: tauri::State<Db>) -> Result<usize, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    let n = conn
        .execute(
            "UPDATE media_files
                SET title_id = NULL, match_confidence = NULL, match_reason = NULL,
                    match_status = 'parsed'
              WHERE match_status IN ('matched', 'unmatched')",
            [],
        )
        .map_err(to_string_err)?;

    // Episodes cascade via the foreign key.
    conn.execute("DELETE FROM titles", [])
        .map_err(to_string_err)?;
    Ok(n)
}

/// Shared projection so list and detail views cannot drift apart.
const TITLE_SELECT: &str = "
    SELECT t.id, t.kind, t.provider, t.title, t.year, t.overview, t.genres,
           t.runtime_mins, t.poster_url, t.backdrop_url, t.rating,
           (SELECT COUNT(*) FROM media_files m WHERE m.title_id = t.id),
           (SELECT MIN(m.first_seen_at) FROM media_files m WHERE m.title_id = t.id)
      FROM titles t";

fn map_title(r: &rusqlite::Row) -> rusqlite::Result<Title> {
    Ok(Title {
        id: r.get(0)?,
        kind: r.get(1)?,
        provider: r.get(2)?,
        title: r.get(3)?,
        year: r.get(4)?,
        overview: r.get(5)?,
        genres: r.get(6)?,
        runtime_mins: r.get(7)?,
        poster_url: r.get(8)?,
        backdrop_url: r.get(9)?,
        rating: r.get(10)?,
        file_count: r.get(11)?,
        added_at: r.get(12)?,
    })
}

/// Everything the detail page needs in one round trip: the title, its episodes
/// (each flagged with whether the library actually holds the file), and for a
/// movie the playable path.
#[tauri::command]
pub fn get_title_detail(db: tauri::State<Db>, title_id: i64) -> Result<TitleDetail, String> {
    let conn = db.0.lock().map_err(to_string_err)?;

    let title = conn
        .query_row(
            &format!("{TITLE_SELECT} WHERE t.id = ?1"),
            params![title_id],
            map_title,
        )
        .map_err(to_string_err)?;

    // LEFT JOIN: episodes the provider knows about but we do not own still
    // appear, greyed out. Hiding them would misrepresent the season.
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.season, e.episode, e.name, e.overview, e.air_date,
                    e.runtime_mins, e.still_url, m.path, m.id
               FROM episodes e
               LEFT JOIN media_files m ON m.title_id = e.title_id
                                      AND m.parsed_season = e.season
                                      AND m.parsed_episode = e.episode
                                      AND m.missing = 0
              WHERE e.title_id = ?1
              ORDER BY e.season, e.episode",
        )
        .map_err(to_string_err)?;

    let episodes = stmt
        .query_map(params![title_id], |r| {
            Ok(Episode {
                id: r.get(0)?,
                season: r.get(1)?,
                episode: r.get(2)?,
                name: r.get(3)?,
                overview: r.get(4)?,
                air_date: r.get(5)?,
                runtime_mins: r.get(6)?,
                still_url: r.get(7)?,
                file_path: r.get(8)?,
                file_id: r.get(9)?,
            })
        })
        .map_err(to_string_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_string_err)?;

    let movie: Option<(String, i64)> = conn
        .query_row(
            "SELECT path, id FROM media_files
              WHERE title_id = ?1 AND missing = 0
              ORDER BY size_bytes DESC LIMIT 1",
            params![title_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();

    Ok(TitleDetail {
        title,
        episodes,
        movie_path: movie.as_ref().map(|m| m.0.clone()),
        movie_file_id: movie.map(|m| m.1),
    })
}

#[tauri::command]
pub fn list_titles(db: tauri::State<Db>) -> Result<Vec<Title>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    let mut stmt = conn.prepare(TITLE_SELECT).map_err(to_string_err)?;
    let rows = stmt.query_map([], map_title).map_err(to_string_err)?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_string_err)
}

/// Files that have been parsed but not yet matched to a title.
#[tauri::command]
pub fn list_unmatched(
    db: tauri::State<Db>,
    limit: i64,
) -> Result<Vec<crate::library::MediaFile>, String> {
    crate::library::query_files_public(
        db,
        // 'unmatched' is included so a failed run can simply be retried — a
        // provider outage or a fixed key should not require re-parsing.
        "WHERE m.match_status IN ('parsed', 'unmatched') AND m.missing = 0
           AND m.parsed_title IS NOT NULL
         ORDER BY m.parsed_title, m.parsed_season, m.parsed_episode LIMIT ?1",
        limit,
    )
}
