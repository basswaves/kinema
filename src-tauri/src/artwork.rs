//! Local artwork cache.
//!
//! Posters, backdrops and episode stills are downloaded once into app data and
//! served from there through Tauri's asset protocol. Without this, browsing
//! needs a live connection to TMDB and every scroll re-fetches the same images.
//!
//! The remote URL stays the source of truth in `titles` and `episodes`; the
//! cache is purely an accelerator. Every query returns *both* the URL and the
//! local path, and the UI falls back to the URL whenever the local copy is
//! missing — so a half-populated cache degrades to exactly the old behaviour
//! rather than to blank posters.

use crate::library::Db;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

fn to_string_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Sub-directory of app data holding the cached images.
const DIR: &str = "artwork";

/// How many downloads run at once. Six keeps a season of stills quick without
/// hammering the CDN.
const CONCURRENCY: usize = 6;

/// Ceiling on a single image. Artwork is well under a megabyte; anything far
/// larger is not the picture we asked for.
const MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize)]
pub struct CacheResult {
    /// Images downloaded and written on this pass.
    pub stored: usize,
    /// URLs that failed. Kept visible rather than swallowed — a cache that
    /// quietly gives up looks identical to one with nothing left to do.
    pub failed: usize,
}

#[derive(Serialize)]
pub struct ArtworkStats {
    pub files: i64,
    pub bytes: i64,
    pub failed: i64,
}

/// Absolute prefix that turns a stored relative `local_path` into a real path.
/// Ends with the platform separator so SQL can simply concatenate it.
pub fn path_prefix(app: &tauri::AppHandle) -> Result<String, String> {
    let dir = crate::data_dir(app)?;
    Ok(format!(
        "{}{}",
        dir.to_string_lossy(),
        std::path::MAIN_SEPARATOR
    ))
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::data_dir(app)
}

/// Extension for the cached file, taken from the URL and restricted to formats
/// a webview will actually render. Anything unrecognised is stored as `.jpg` —
/// the browser sniffs content anyway, and this only decides a filename.
fn extension(url: &str) -> String {
    let without_query = url.split(['?', '#']).next().unwrap_or("");
    let ext = without_query
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif" => ext,
        _ => "jpg".to_string(),
    }
}

/// Every artwork URL the library knows about, in one list.
///
/// Keying the cache by URL is what makes adding a kind a one-line change here
/// rather than a new table and a new download path each time.
fn all_urls(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT poster_url   FROM titles   WHERE poster_url   IS NOT NULL AND poster_url   <> ''
         UNION
         SELECT backdrop_url FROM titles   WHERE backdrop_url IS NOT NULL AND backdrop_url <> ''
         UNION
         SELECT logo_url     FROM titles   WHERE logo_url     IS NOT NULL AND logo_url     <> ''
         UNION
         SELECT still_url    FROM episodes WHERE still_url    IS NOT NULL AND still_url    <> ''
         UNION
         SELECT profile_url  FROM people   WHERE profile_url  IS NOT NULL AND profile_url  <> ''",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// Claim a row — and therefore a unique id — for every URL that still needs
/// downloading. Naming the file after the row id makes collisions impossible,
/// which a hash of the URL could not promise.
///
/// A URL already in the cache is skipped only if its file is genuinely still on
/// disk, so a manually emptied `artwork/` directory heals itself.
fn reserve(app: &tauri::AppHandle, urls: &[String]) -> Result<Vec<(i64, String)>, String> {
    let base = app_data(app)?;
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(to_string_err)?;

    let mut pending = Vec::new();
    let mut seen = HashSet::new();

    for url in urls {
        let url = url.trim();
        if url.is_empty() || !seen.insert(url.to_string()) {
            continue;
        }

        let cached: Option<String> = conn
            .query_row(
                "SELECT local_path FROM artwork_cache WHERE url = ?1 AND local_path <> ''",
                params![url],
                |r| r.get(0),
            )
            .ok();

        if let Some(relative) = cached {
            if base.join(&relative).exists() {
                continue;
            }
        }

        conn.execute(
            "INSERT INTO artwork_cache (url, local_path, bytes, fetched_at)
             VALUES (?1, '', 0, ?2)
             ON CONFLICT(url) DO UPDATE SET local_path = '', bytes = 0,
                                            fetched_at = excluded.fetched_at",
            params![url, now_secs()],
        )
        .map_err(to_string_err)?;

        let id: i64 = conn
            .query_row(
                "SELECT rowid FROM artwork_cache WHERE url = ?1",
                params![url],
                |r| r.get(0),
            )
            .map_err(to_string_err)?;

        pending.push((id, url.to_string()));
    }

    Ok(pending)
}

/// Mark a URL as cached. Written only after the file is on disk, so a row with
/// a non-empty `local_path` always has a file behind it.
fn commit(app: &tauri::AppHandle, url: &str, relative: &str, bytes: i64) -> Result<(), String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.execute(
        "UPDATE artwork_cache SET local_path = ?2, bytes = ?3, fetched_at = ?4 WHERE url = ?1",
        params![url, relative, bytes, now_secs()],
    )
    .map_err(to_string_err)?;
    Ok(())
}

async fn download(client: &tauri_plugin_http::reqwest::Client, url: &str) -> Option<Vec<u8>> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.bytes().await.ok()?;
    if body.is_empty() || body.len() > MAX_BYTES {
        return None;
    }
    Some(body.to_vec())
}

/// Download every artwork URL that is not already cached.
///
/// Takes no arguments on purpose: the set of images the library needs is a
/// property of the database, not of whichever screen happens to call this. One
/// call after matching and one on startup keep the cache complete.
#[tauri::command]
pub async fn cache_artwork(app: tauri::AppHandle) -> Result<CacheResult, String> {
    // One run at a time, the second after the first rather than refused — see
    // `jobs::Jobs`. Two at once used to reserve and download the same files.
    let jobs = app.state::<crate::jobs::Jobs>();
    let _turn = jobs.artwork.lock().await;

    let base = app_data(&app)?;
    let dir = base.join(DIR);
    std::fs::create_dir_all(&dir).map_err(to_string_err)?;

    let urls = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        all_urls(&conn).map_err(to_string_err)?
    };

    let pending = reserve(&app, &urls)?;
    let mut result = CacheResult {
        stored: 0,
        failed: 0,
    };
    if pending.is_empty() {
        return Ok(result);
    }

    let client = tauri_plugin_http::reqwest::Client::new();

    for chunk in pending.chunks(CONCURRENCY) {
        let mut tasks = Vec::with_capacity(chunk.len());
        for (id, url) in chunk {
            let client = client.clone();
            let url = url.clone();
            let id = *id;
            // Downloads run concurrently but touch no database state; the rows
            // are written back here, on one thread, after each batch lands.
            tasks.push(tauri::async_runtime::spawn(async move {
                let body = download(&client, &url).await;
                (id, url, body)
            }));
        }

        for task in tasks {
            let Ok((id, url, body)) = task.await else {
                result.failed += 1;
                continue;
            };
            let Some(body) = body else {
                result.failed += 1;
                continue;
            };

            let name = format!("{id}.{}", extension(&url));
            if let Err(e) = std::fs::write(dir.join(&name), &body) {
                crate::log!("artwork: writing {name} failed: {e}");
                result.failed += 1;
                continue;
            }

            let relative = format!("{DIR}{}{name}", std::path::MAIN_SEPARATOR);
            commit(&app, &url, &relative, body.len() as i64)?;
            result.stored += 1;
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn artwork_stats(db: tauri::State<Db>) -> Result<ArtworkStats, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.query_row(
        "SELECT COUNT(*) FILTER (WHERE local_path <> ''),
                COALESCE(SUM(bytes), 0),
                COUNT(*) FILTER (WHERE local_path = '')
           FROM artwork_cache",
        [],
        |r| {
            Ok(ArtworkStats {
                files: r.get(0)?,
                bytes: r.get(1)?,
                failed: r.get(2)?,
            })
        },
    )
    .map_err(to_string_err)
}

/// Drop the cache entirely. Browsing keeps working from the remote URLs, and
/// the next `cache_artwork` rebuilds it.
#[tauri::command]
pub async fn clear_artwork_cache(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
) -> Result<usize, String> {
    let dir = app_data(&app)?.join(DIR);

    {
        let conn = db.0.lock().map_err(to_string_err)?;
        conn.execute("DELETE FROM artwork_cache", [])
            .map_err(to_string_err)?;
    }

    // Thousands of deletes, off the main thread.
    crate::jobs::off_main(move || {
        let mut removed = 0;
        if dir.exists() {
            for entry in std::fs::read_dir(&dir).map_err(to_string_err)? {
                let entry = entry.map_err(to_string_err)?;
                if entry.path().is_file() && std::fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        Ok(removed)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::extension;

    #[test]
    fn extension_comes_from_the_url() {
        assert_eq!(extension("https://image.tmdb.org/t/p/original/abc.jpg"), "jpg");
        assert_eq!(extension("https://example.com/a/b.PNG"), "png");
        assert_eq!(extension("https://example.com/a/b.webp?size=2"), "webp");
    }

    #[test]
    fn unknown_extensions_fall_back_to_jpg() {
        assert_eq!(extension("https://example.com/image"), "jpg");
        assert_eq!(extension("https://example.com/a/b.svgz"), "jpg");
    }
}
