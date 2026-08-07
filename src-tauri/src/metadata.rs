//! Persistence for matched titles and episodes.
//!
//! Fetching happens in the frontend (where the provider clients live); this
//! module only stores results. Keeping them separate means matching rules can
//! be re-run against cached titles without re-hitting any API.

use crate::artwork::path_prefix;
use crate::library::Db;
use rusqlite::{named_params, params};
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
    pub logo_url: Option<String>,
    pub trailer_key: Option<String>,
    pub trailer_site: Option<String>,
    /// Billed cast, already capped and ordered by the provider client.
    #[serde(default)]
    pub cast: Vec<CastInput>,
}

#[derive(Deserialize)]
pub struct CastInput {
    pub name: String,
    pub character: Option<String>,
    pub profile_url: Option<String>,
}

#[derive(Serialize)]
pub struct CastMember {
    pub name: String,
    pub character: Option<String>,
    pub profile_url: Option<String>,
    pub profile_path: Option<String>,
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
    /// Absolute path to the cached copy, when there is one. The URL is kept
    /// alongside it so the UI can fall back rather than showing nothing.
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub logo_url: Option<String>,
    pub logo_path: Option<String>,
    pub trailer_key: Option<String>,
    pub trailer_site: Option<String>,
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
    pub still_path: Option<String>,
    /// Path of the file backing this episode, if the library actually has it.
    pub file_path: Option<String>,
    pub file_id: Option<i64>,
    /// Watched to the end, or marked watched by hand — the same flag either way.
    pub watched: bool,
    /// Resume point, so a part-watched episode can show how far in it is.
    /// Both are `None` until the file has actually been played.
    pub position_secs: Option<f64>,
    pub duration_secs: Option<f64>,
}

#[derive(Serialize)]
pub struct TitleDetail {
    pub title: Title,
    pub episodes: Vec<Episode>,
    pub cast: Vec<CastMember>,
    /// For movies: the playable file.
    pub movie_path: Option<String>,
    pub movie_file_id: Option<i64>,
    pub movie_watched: bool,
}

/// Upsert by (provider, provider_id) so re-matching never duplicates a title.
#[tauri::command]
pub fn save_title(db: tauri::State<Db>, title: TitleInput) -> Result<i64, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    let tx = conn.transaction().map_err(to_string_err)?;

    tx.execute(
        "INSERT INTO titles
            (kind, provider, provider_id, imdb_id, tmdb_id, title, year, overview,
             genres, runtime_mins, rating, poster_url, backdrop_url, fetched_at,
             trailer_key, trailer_site, logo_url)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
         ON CONFLICT(provider, provider_id) DO UPDATE SET
            imdb_id = excluded.imdb_id, tmdb_id = excluded.tmdb_id,
            title = excluded.title, year = excluded.year, overview = excluded.overview,
            genres = excluded.genres, runtime_mins = excluded.runtime_mins,
            rating = excluded.rating, poster_url = excluded.poster_url,
            backdrop_url = excluded.backdrop_url, fetched_at = excluded.fetched_at,
            -- A provider that supplies no trailer must not wipe one that an
            -- earlier fetch found: re-matching a title through TVmaze would
            -- otherwise silently lose the TMDB trailer. The logo is the same
            -- story — only TMDB has one, so any other provider must leave it.
            trailer_key  = COALESCE(excluded.trailer_key,  titles.trailer_key),
            trailer_site = COALESCE(excluded.trailer_site, titles.trailer_site),
            logo_url     = COALESCE(excluded.logo_url,     titles.logo_url)",
        params![
            title.kind, title.provider, title.provider_id, title.imdb_id, title.tmdb_id,
            title.title, title.year, title.overview, title.genres, title.runtime_mins,
            title.rating, title.poster_url, title.backdrop_url, now_secs(),
            title.trailer_key, title.trailer_site, title.logo_url
        ],
    )
    .map_err(to_string_err)?;

    let title_id: i64 = tx
        .query_row(
            "SELECT id FROM titles WHERE provider = ?1 AND provider_id = ?2",
            params![title.provider, title.provider_id],
            |r| r.get(0),
        )
        .map_err(to_string_err)?;

    // Cast is replaced wholesale, but only when the provider actually supplied
    // some. An empty list means "this provider does not do cast" — TVmaze and
    // OMDb both send one — and deleting on that would wipe what TMDB found the
    // last time the title was matched.
    if !title.cast.is_empty() {
        tx.execute("DELETE FROM people WHERE title_id = ?1", params![title_id])
            .map_err(to_string_err)?;

        let mut stmt = tx
            .prepare(
                "INSERT INTO people (title_id, name, character, profile_url, ord)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(to_string_err)?;

        for (index, person) in title.cast.iter().enumerate() {
            stmt.execute(params![
                title_id,
                person.name,
                person.character,
                person.profile_url,
                index as i64
            ])
            .map_err(to_string_err)?;
        }
    }

    tx.commit().map_err(to_string_err)?;
    Ok(title_id)
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

/// Attach files to a title. `status` is 'matched' or 'unmatched' — the caller
/// decides based on confidence, because the threshold is a matching-policy
/// decision, not a storage one.
///
/// Takes a **list**, because every caller has one. Matching resolves a whole
/// group at a time and a season is twelve files; ignoring, un-ignoring and
/// unlinking are all group operations too. Done one file at a time this was a
/// separate IPC round trip and a separate transaction each, so a twelve-episode
/// season cost twelve of both and a first run over a large library cost
/// thousands.
#[tauri::command]
pub fn link_files_to_title(
    db: tauri::State<Db>,
    file_ids: Vec<i64>,
    title_id: Option<i64>,
    confidence: Option<f64>,
    reason: Option<String>,
    status: String,
) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(to_string_err)?;
    let tx = conn.transaction().map_err(to_string_err)?;
    let mut n = 0;
    {
        let mut stmt = tx
            .prepare(
                "UPDATE media_files
                    SET title_id = ?2, match_confidence = ?3, match_reason = ?4, match_status = ?5
                  WHERE id = ?1",
            )
            .map_err(to_string_err)?;

        for file_id in file_ids {
            stmt.execute(params![file_id, title_id, confidence, reason, status])
                .map_err(to_string_err)?;
            n += 1;
        }
    }
    tx.commit().map_err(to_string_err)?;
    Ok(n)
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
///
/// `:art` is the absolute prefix for cached artwork. Prepending it here rather
/// than storing absolute paths keeps the database portable — the cache lives
/// beside it in app data, and both move together.
const TITLE_SELECT: &str = "
    SELECT t.id, t.kind, t.provider, t.title, t.year, t.overview, t.genres,
           t.runtime_mins, t.poster_url, t.backdrop_url, t.rating,
           (SELECT COUNT(*) FROM media_files m WHERE m.title_id = t.id),
           (SELECT MIN(m.first_seen_at) FROM media_files m WHERE m.title_id = t.id),
           (SELECT :art || a.local_path FROM artwork_cache a
             WHERE a.url = t.poster_url   AND a.local_path <> ''),
           (SELECT :art || a.local_path FROM artwork_cache a
             WHERE a.url = t.backdrop_url AND a.local_path <> ''),
           t.trailer_key, t.trailer_site,
           t.logo_url,
           (SELECT :art || a.local_path FROM artwork_cache a
             WHERE a.url = t.logo_url     AND a.local_path <> '')
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
        poster_path: r.get(13)?,
        backdrop_path: r.get(14)?,
        trailer_key: r.get(15)?,
        trailer_site: r.get(16)?,
        logo_url: r.get(17)?,
        logo_path: r.get(18)?,
    })
}

/// Everything the detail page needs in one round trip: the title, its episodes
/// (each flagged with whether the library actually holds the file), and for a
/// movie the playable path.
#[tauri::command]
pub fn get_title_detail(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    title_id: i64,
) -> Result<TitleDetail, String> {
    let art = path_prefix(&app)?;
    let conn = db.0.lock().map_err(to_string_err)?;

    let title = conn
        .query_row(
            &format!("{TITLE_SELECT} WHERE t.id = :id"),
            named_params! { ":art": &art, ":id": title_id },
            map_title,
        )
        .map_err(to_string_err)?;

    // LEFT JOIN: episodes the provider knows about but we do not own still
    // appear, greyed out. Hiding them would misrepresent the season.
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.season, e.episode, e.name, e.overview, e.air_date,
                    e.runtime_mins, e.still_url, m.path, m.id,
                    (SELECT :art || a.local_path FROM artwork_cache a
                      WHERE a.url = e.still_url AND a.local_path <> ''),
                    COALESCE(p.completed, 0), p.position_secs, p.duration_secs
               FROM episodes e
               LEFT JOIN media_files m ON m.title_id = e.title_id
                                      AND m.parsed_season = e.season
                                      AND m.parsed_episode = e.episode
                                      AND m.missing = 0
               -- Joined through the file, so an episode the library does not
               -- hold can never inherit another file's progress.
               LEFT JOIN playback_state p ON p.file_id = m.id
              WHERE e.title_id = :id
              ORDER BY e.season, e.episode",
        )
        .map_err(to_string_err)?;

    let episodes = stmt
        .query_map(named_params! { ":art": &art, ":id": title_id }, |r| {
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
                still_path: r.get(10)?,
                watched: r.get::<_, i64>(11)? != 0,
                position_secs: r.get(12)?,
                duration_secs: r.get(13)?,
            })
        })
        .map_err(to_string_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_string_err)?;

    let movie: Option<(String, i64, bool)> = conn
        .query_row(
            "SELECT m.path, m.id, COALESCE(p.completed, 0)
               FROM media_files m
               LEFT JOIN playback_state p ON p.file_id = m.id
              WHERE m.title_id = ?1 AND m.missing = 0
              ORDER BY m.size_bytes DESC LIMIT 1",
            params![title_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
        )
        .ok();

    let cast = {
        let mut stmt = conn
            .prepare(
                "SELECT p.name, p.character, p.profile_url,
                        (SELECT :art || a.local_path FROM artwork_cache a
                          WHERE a.url = p.profile_url AND a.local_path <> '')
                   FROM people p
                  WHERE p.title_id = :id
                  ORDER BY p.ord",
            )
            .map_err(to_string_err)?;

        // Bound to a local before the block ends: returning the collected rows
        // as the block's tail expression keeps a temporary alive past `stmt`.
        let rows = stmt
            .query_map(named_params! { ":art": &art, ":id": title_id }, |r| {
                Ok(CastMember {
                    name: r.get(0)?,
                    character: r.get(1)?,
                    profile_url: r.get(2)?,
                    profile_path: r.get(3)?,
                })
            })
            .map_err(to_string_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(to_string_err)?;
        rows
    };

    Ok(TitleDetail {
        title,
        episodes,
        cast,
        movie_path: movie.as_ref().map(|m| m.0.clone()),
        movie_file_id: movie.as_ref().map(|m| m.1),
        movie_watched: movie.map(|m| m.2).unwrap_or(false),
    })
}

#[tauri::command]
pub fn list_titles(app: tauri::AppHandle, db: tauri::State<Db>) -> Result<Vec<Title>, String> {
    let art = path_prefix(&app)?;
    let conn = db.0.lock().map_err(to_string_err)?;
    let mut stmt = conn.prepare(TITLE_SELECT).map_err(to_string_err)?;
    let rows = stmt
        .query_map(named_params! { ":art": &art }, map_title)
        .map_err(to_string_err)?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_string_err)
}

#[derive(Serialize)]
pub struct TrailerTarget {
    pub id: i64,
    pub tmdb_id: String,
    pub kind: String,
}

/// Titles matched before some part of the TMDB detail response was being used.
///
/// Restricted to titles with a TMDB id, because it is the only provider here
/// carrying trailers, logos or cast at all — asking about the others would be
/// querying for something that cannot exist.
///
/// `NULL` means never asked; an **empty string** means asked and there is none.
/// Without that distinction a title genuinely lacking a logo would be re-fetched
/// on every single pass, forever.
#[tauri::command]
pub fn list_titles_needing_detail(db: tauri::State<Db>) -> Result<Vec<TrailerTarget>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, tmdb_id, kind FROM titles
              WHERE tmdb_id IS NOT NULL AND tmdb_id <> ''
                AND (trailer_key IS NULL OR logo_url IS NULL)
              ORDER BY id",
        )
        .map_err(to_string_err)?;

    let rows = stmt
        .query_map([], |r| {
            Ok(TrailerTarget {
                id: r.get(0)?,
                tmdb_id: r.get(1)?,
                kind: r.get(2)?,
            })
        })
        .map_err(to_string_err)?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_string_err)
}

/// Record a trailer found by the backfill pass.
#[tauri::command]
pub fn set_title_trailer(
    db: tauri::State<Db>,
    title_id: i64,
    trailer_key: Option<String>,
    trailer_site: Option<String>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.execute(
        "UPDATE titles SET trailer_key = ?2, trailer_site = ?3 WHERE id = ?1",
        params![title_id, trailer_key, trailer_site],
    )
    .map_err(to_string_err)?;
    Ok(())
}

/// Which files the review queue works on: everything the matcher declined, plus
/// everything taken out of the queue by hand so it can be put back.
///
/// Its own query rather than a filter over the whole file table. Settings used
/// to fetch 2,000 rows of eighteen columns and count them in the webview, which
/// was both the largest payload in the app and quietly wrong past 2,000 files —
/// the count and the queue would silently stop growing.
const NEEDS_REVIEW_WHERE: &str = "
    WHERE (m.match_status IN ('parsed', 'unmatched')
           AND m.missing = 0
           AND m.parsed_title IS NOT NULL)
       OR m.match_status = 'ignored'
     ORDER BY m.parsed_title, m.parsed_season, m.parsed_episode
     LIMIT ?1";

#[tauri::command]
pub fn list_needs_review(
    db: tauri::State<Db>,
    limit: i64,
) -> Result<Vec<crate::library::MediaFile>, String> {
    crate::library::query_files_public(db, NEEDS_REVIEW_WHERE, limit)
}

/// How many files are waiting, for the button that opens the queue.
///
/// Counts files rather than groups, which is what the label has always said.
/// Ignored files are excluded here — they are not work.
#[tauri::command]
pub fn count_needs_review(db: tauri::State<Db>) -> Result<i64, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.query_row(
        "SELECT COUNT(*) FROM media_files
          WHERE match_status IN ('parsed', 'unmatched')
            AND missing = 0
            AND parsed_title IS NOT NULL",
        [],
        |r| r.get(0),
    )
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
