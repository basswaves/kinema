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

use crate::util::{now_secs, to_string_err};
use crate::library::Db;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tokio::sync::{mpsc, Semaphore};

/// Sub-directory of app data holding the cached images.
const DIR: &str = "artwork";

/// How many downloads run at once on a machine with `cores` threads: two per
/// thread, since they mostly wait on the network, but never fewer than four
/// (a 2-core box would crawl through a season of stills) nor more than twelve
/// (more only hammers the CDN and the disk).
fn window_for(cores: usize) -> usize {
    cores.saturating_mul(2).clamp(4, 12)
}

/// How many finished downloads are marked in the database in one transaction.
const COMMIT_EVERY: usize = 16;

/// Ceiling on a single image. Artwork is well under a megabyte; anything far
/// larger is not the picture we asked for.
const MAX_BYTES: usize = 16 * 1024 * 1024;

/// How many out-of-date TMDB images one pass downloads again. Past TMDB's age
/// limit (`metadata::TMDB_MAX_AGE_SECS`) the whole library would otherwise
/// fall due on the same day it was first cached.
const REFRESH_PER_PASS: usize = 300;

/// A cached image TMDB's terms say must be fetched again.
fn past_tmdb_age(url: &str, fetched_at: i64, now: i64) -> bool {
    url.starts_with("https://image.tmdb.org/")
        && fetched_at < now - crate::metadata::TMDB_MAX_AGE_SECS
}

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

/// What a picture is for, which decides how large a copy a small screen needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Poster,
    Backdrop,
    Still,
    /// A title's own lettering (TMDB keeps them at full size: a few MB each).
    Logo,
    /// Faces and studio logos, already fetched small, or one-off: never resized here.
    Other,
}

/// Every artwork URL the library knows about, with what each one is.
///
/// Keying the cache by URL is what makes adding a kind a one-line change here
/// rather than a new table and a new download path each time. The kind comes
/// from the column a URL is read from; a URL found in two columns is `Other`,
/// which is left as it is — a copy too large costs space, one too small costs
/// the picture.
fn all_urls(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<(String, Kind)>> {
    let mut stmt = conn.prepare(
        "SELECT poster_url,   1 FROM titles   WHERE poster_url   IS NOT NULL AND poster_url   <> ''
         UNION ALL
         SELECT backdrop_url, 2 FROM titles   WHERE backdrop_url IS NOT NULL AND backdrop_url <> ''
         UNION ALL
         SELECT logo_url,     4 FROM titles   WHERE logo_url     IS NOT NULL AND logo_url     <> ''
         UNION ALL
         SELECT still_url,    3 FROM episodes WHERE still_url    IS NOT NULL AND still_url    <> ''
         UNION ALL
         SELECT profile_url,  0 FROM people   WHERE profile_url  IS NOT NULL AND profile_url  <> ''
         UNION ALL
         SELECT logo_url,     0 FROM studios  WHERE logo_url     IS NOT NULL AND logo_url     <> ''",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut kinds: Vec<(String, Kind)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let (url, code) = row?;
        let url = url.trim().to_string();
        let kind = match code {
            1 => Kind::Poster,
            2 => Kind::Backdrop,
            3 => Kind::Still,
            4 => Kind::Logo,
            _ => Kind::Other,
        };
        match at.get(&url) {
            Some(&i) if kinds[i].1 != kind => kinds[i].1 = Kind::Other,
            Some(_) => {}
            None => {
                at.insert(url.clone(), kinds.len());
                kinds.push((url, kind));
            }
        }
    }
    Ok(kinds)
}

const TMDB_ORIGINAL: &str = "https://image.tmdb.org/t/p/original/";

/// Whether this device takes smaller copies: a TV, not a monitor.
const SMALL_COPIES: bool = cfg!(target_os = "android");

/// The address to download a picture from. The library keeps the original's
/// address (it is the cache's key, and what a desktop fetches); on a TV a
/// smaller copy of a TMDB picture is enough, so the size in its path is
/// swapped. Sizes are what a 1080p to 4K screen shows a card at, not the
/// picture's own: posters 500 wide, backdrops 1280, episode stills 780,
/// title logos 500 (TMDB keeps those at full size, 0.8 MB on average for
/// 400 films — more than every other picture together).
/// TVmaze's are kept as they are: its smaller copies are 210–250 wide, soft
/// on a TV, and its originals are small already. A picture that is not one
/// of those kinds (a logo, a face) is returned as it is.
fn rendition(url: &str, kind: Kind, small: bool) -> String {
    if !small {
        return url.to_string();
    }
    if let Some(file) = url.strip_prefix(TMDB_ORIGINAL) {
        let size = match kind {
            Kind::Poster => "w500",
            Kind::Backdrop => "w1280",
            Kind::Still => "w780",
            Kind::Logo => "w500",
            Kind::Other => return url.to_string(),
        };
        return format!("https://image.tmdb.org/t/p/{size}/{file}");
    }
    url.to_string()
}

/// Claim a row — and therefore a unique id — for every URL that still needs
/// downloading. Naming the file after the row id makes collisions impossible,
/// which a hash of the URL could not promise.
///
/// A URL already in the cache is skipped only if its file is genuinely still on
/// disk, so a manually emptied `artwork/` directory heals itself — and, for a
/// TMDB image, only while it is younger than TMDB allows. An old one is
/// downloaded again under its own row id, so the new file replaces the old
/// under the same name, and the old one is shown until it does.
///
/// This runs at every launch over every image the library has, so it is kept
/// to three short steps rather than one long one: the cache is read in one
/// query, the folder is listed once (instead of asking the disk about each
/// file in turn, which on a slow SD card or a spun-down drive is thousands of
/// round trips), and the rows to claim are written in one transaction. The
/// database lock is held only for the first and the last; the page's own
/// commands, which share it, no longer wait behind a stat per image.
fn reserve(app: &tauri::AppHandle, urls: &[String]) -> Result<Vec<(i64, String)>, String> {
    let base = app_data(app)?;
    let db = app.state::<Db>();
    reserve_in(&db.0, &base, urls, now_secs())
}

/// What a cached row says: its id, where the file should be, when it was got.
type Cached = (i64, String, i64);

/// A decision about one URL, kept in order so the answer comes back in the
/// order the URLs were given.
enum Plan {
    /// Cached but too old: fetch again under the row it has.
    Refresh(i64, String),
    /// Not cached, or the file is gone: claim a row, then fetch.
    Claim(String),
}

fn reserve_in(
    db: &Mutex<Connection>,
    base: &Path,
    urls: &[String],
    now: i64,
) -> Result<Vec<(i64, String)>, String> {
    // 1. Everything the cache holds, in one query.
    let cached: HashMap<String, Cached> = {
        let conn = db.lock().map_err(to_string_err)?;
        let mut stmt = conn
            .prepare("SELECT url, rowid, local_path, fetched_at FROM artwork_cache WHERE local_path <> ''")
            .map_err(to_string_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))))
            .map_err(to_string_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(to_string_err)?
    };

    // 2. The folder, listed once. No lock is held.
    let on_disk = file_names(&base.join(DIR));

    // 3. Decide, still without the lock.
    let mut plans = Vec::new();
    let mut seen = HashSet::new();
    let mut refresh_budget = REFRESH_PER_PASS;
    for url in urls {
        let url = url.trim();
        if url.is_empty() || !seen.insert(url.to_string()) {
            continue;
        }
        if let Some((id, relative, fetched_at)) = cached.get(url) {
            if file_exists(base, &on_disk, relative) {
                if refresh_budget > 0 && past_tmdb_age(url, *fetched_at, now) {
                    refresh_budget -= 1;
                    plans.push(Plan::Refresh(*id, url.to_string()));
                }
                continue;
            }
        }
        plans.push(Plan::Claim(url.to_string()));
    }

    // 4. Claim the rows that need claiming, all in one transaction.
    if !plans.iter().any(|p| matches!(p, Plan::Claim(_))) {
        return Ok(plans
            .into_iter()
            .filter_map(|p| match p {
                Plan::Refresh(id, url) => Some((id, url)),
                Plan::Claim(_) => None,
            })
            .collect());
    }
    let mut conn = db.lock().map_err(to_string_err)?;
    let tx = conn.transaction().map_err(to_string_err)?;
    let mut pending = Vec::with_capacity(plans.len());
    {
        let mut claim = tx
            .prepare(
                "INSERT INTO artwork_cache (url, local_path, bytes, fetched_at)
                 VALUES (?1, '', 0, ?2)
                 ON CONFLICT(url) DO UPDATE SET local_path = '', bytes = 0,
                                                fetched_at = excluded.fetched_at
                 RETURNING rowid",
            )
            .map_err(to_string_err)?;
        for plan in plans {
            match plan {
                Plan::Refresh(id, url) => pending.push((id, url)),
                Plan::Claim(url) => {
                    let id: i64 = claim
                        .query_row(params![url, now], |r| r.get(0))
                        .map_err(to_string_err)?;
                    pending.push((id, url));
                }
            }
        }
    }
    tx.commit().map_err(to_string_err)?;
    Ok(pending)
}

/// The names of the files in a folder; empty if it cannot be listed (then
/// nothing counts as cached, and everything is fetched, as it should be).
fn file_names(dir: &Path) -> HashSet<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether the file a row names is there. `local_path` is `artwork`, a
/// separator and the file's name, so the listing of that folder answers it; a
/// path of any other shape (never written by this module) is asked of the disk.
fn file_exists(base: &Path, listed: &HashSet<String>, relative: &str) -> bool {
    match relative.rsplit_once(['/', '\\']) {
        Some((DIR, name)) => listed.contains(name),
        _ => base.join(relative).exists(),
    }
}

/// Mark downloaded URLs as cached, all in one transaction. Written only after
/// the files are on disk, so a row with a non-empty `local_path` always has a
/// file behind it. (A crash between the two costs one download again.)
fn commit_batch(app: &tauri::AppHandle, stored: &[Stored]) -> Result<(), String> {
    let db = app.state::<Db>();
    let mut conn = db.0.lock().map_err(to_string_err)?;
    let tx = conn.transaction().map_err(to_string_err)?;
    {
        let mut update = tx
            .prepare("UPDATE artwork_cache SET local_path = ?2, bytes = ?3, fetched_at = ?4 WHERE url = ?1")
            .map_err(to_string_err)?;
        let now = now_secs();
        for s in stored {
            update
                .execute(params![s.url, s.relative, s.bytes, now])
                .map_err(to_string_err)?;
        }
    }
    tx.commit().map_err(to_string_err)
}

/// An image that is on disk and waits for its row to be marked.
struct Stored {
    url: String,
    relative: String,
    bytes: i64,
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

/// Download one image and write it, on a blocking thread so a slow disk does
/// not hold up the network tasks beside it. `None` if either part failed.
async fn fetch_one(
    client: tauri_plugin_http::reqwest::Client,
    dir: PathBuf,
    id: i64,
    url: String,
    kind: Kind,
) -> Option<Stored> {
    // The smaller copy first; if it is not there, the picture as the library
    // has it. Stored under the library's address either way.
    let wanted = rendition(&url, kind, SMALL_COPIES);
    let body = match download(&client, &wanted).await {
        Some(body) => body,
        None if wanted != url => download(&client, &url).await?,
        None => return None,
    };
    let name = format!("{id}.{}", extension(&url));
    let path = dir.join(&name);
    let bytes = body.len() as i64;
    match tauri::async_runtime::spawn_blocking(move || std::fs::write(path, body)).await {
        Ok(Ok(())) => Some(Stored {
            url,
            relative: format!("{DIR}{}{name}", std::path::MAIN_SEPARATOR),
            bytes,
        }),
        Ok(Err(e)) => {
            crate::log!("artwork: writing {name} failed: {e}");
            None
        }
        Err(_) => None,
    }
}

/// Download every artwork URL that is not already cached.
///
/// Takes no arguments on purpose: the set of images the library needs is a
/// property of the database, not of whichever screen happens to call this. One
/// call after matching and one on startup keep the cache complete.
///
/// **A sliding window, not batches.** Downloads used to go six at a time, each
/// batch waiting for its slowest image before the next began; one slow
/// response idled five connections. Now a new download starts the moment any
/// one finishes, up to [`window_for`] at once. Each download writes its own
/// file, and the rows are marked [`COMMIT_EVERY`] at a time in one
/// transaction, so the database is touched a few times, not once per image.
///
/// While a film plays, no new download is started (`jobs::playing`); the ones
/// in flight finish. This runs on the shared async threads, so it cannot lower
/// its own priority the way the file-reading loops do — waiting is its way of
/// giving way.
#[tauri::command]
pub async fn cache_artwork(app: tauri::AppHandle) -> Result<CacheResult, String> {
    // One run at a time, the second after the first rather than refused — see
    // `jobs::Jobs`. Two at once used to reserve and download the same files.
    let jobs = app.state::<crate::jobs::Jobs>();
    let _turn = jobs.artwork.lock().await;

    let base = app_data(&app)?;
    let dir = base.join(DIR);
    std::fs::create_dir_all(&dir).map_err(to_string_err)?;

    // Both steps take the database lock and read the disk: not for the async
    // threads, which the downloads below need.
    let pending = {
        let app = app.clone();
        crate::jobs::off_main(move || {
            let known = {
                let db = app.state::<Db>();
                let conn = db.0.lock().map_err(to_string_err)?;
                all_urls(&conn).map_err(to_string_err)?
            };
            let urls: Vec<String> = known.iter().map(|(u, _)| u.clone()).collect();
            let pending = reserve(&app, &urls)?;
            Ok((pending, known.into_iter().collect::<HashMap<String, Kind>>()))
        })
        .await?
    };
    let (pending, kinds) = pending;
    let mut result = CacheResult {
        stored: 0,
        failed: 0,
    };
    if pending.is_empty() {
        return Ok(result);
    }

    let client = tauri_plugin_http::reqwest::Client::new();
    let window = std::thread::available_parallelism().map_or(2, |n| n.get());
    let slots = Arc::new(Semaphore::new(window_for(window)));
    let (finished, mut outcomes) = mpsc::unbounded_channel::<Option<Stored>>();

    // Starts the downloads, a slot at a time. Its own task, so that marking
    // rows below goes on while it waits for a slot.
    let starter = {
        let slots = slots.clone();
        tauri::async_runtime::spawn(async move {
            for (id, url) in pending {
                // Between two downloads, never inside one.
                crate::jobs::wait_while_playing_async().await;
                let Ok(slot) = slots.clone().acquire_owned().await else {
                    break; // closed: the run was given up
                };
                let (client, dir, finished) = (client.clone(), dir.clone(), finished.clone());
                let kind = kinds.get(&url).copied().unwrap_or(Kind::Other);
                tauri::async_runtime::spawn(async move {
                    let outcome = fetch_one(client, dir, id, url, kind).await;
                    drop(slot);
                    let _ = finished.send(outcome);
                });
            }
        })
    };

    let mut waiting: Vec<Stored> = Vec::with_capacity(COMMIT_EVERY);
    while let Some(outcome) = outcomes.recv().await {
        match outcome {
            None => result.failed += 1,
            Some(stored) => {
                waiting.push(stored);
                if waiting.len() >= COMMIT_EVERY {
                    if let Err(e) = mark_cached(&app, &mut waiting, &mut result).await {
                        slots.close(); // stop starting downloads nobody will mark
                        return Err(e);
                    }
                }
            }
        }
    }
    mark_cached(&app, &mut waiting, &mut result).await?;
    let _ = starter.await;

    Ok(result)
}

/// Mark the images waiting as cached, in one transaction on a blocking thread.
async fn mark_cached(
    app: &tauri::AppHandle,
    waiting: &mut Vec<Stored>,
    result: &mut CacheResult,
) -> Result<(), String> {
    if waiting.is_empty() {
        return Ok(());
    }
    let batch = std::mem::take(waiting);
    let count = batch.len();
    let app = app.clone();
    crate::jobs::off_main(move || commit_batch(&app, &batch)).await?;
    result.stored += count;
    Ok(())
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

/// Rewrite cached artwork paths written on another system to this one's
/// separator. Returns how many were rewritten.
///
/// `local_path` is stored as `artwork` + the system's separator + the file
/// name, and read by plain concatenation onto `path_prefix`. A library made on
/// Windows and opened on Linux — a safety copy restored on a new PC — says
/// `artwork\52.jpg`, which Linux takes as one file name: every cached picture
/// then "fails" and quietly comes from the network again. Found on the first
/// Linux run, on a copy of a Windows library. Cheap and idempotent, so it runs
/// at every start.
pub fn use_this_systems_separator(conn: &rusqlite::Connection) -> rusqlite::Result<usize> {
    let (other, here) = if cfg!(windows) { ("/", "\\") } else { ("\\", "/") };
    conn.execute(
        "UPDATE artwork_cache SET local_path = replace(local_path, ?1, ?2)
          WHERE instr(local_path, ?1) > 0",
        params![other, here],
    )
}

#[cfg(test)]
mod tests {
    use super::{extension, past_tmdb_age, rendition, use_this_systems_separator, Kind};
    use crate::metadata::TMDB_MAX_AGE_SECS;

    #[test]
    fn artwork_paths_from_another_system_are_rewritten() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE artwork_cache (url TEXT PRIMARY KEY, local_path TEXT NOT NULL);
             INSERT INTO artwork_cache VALUES ('w', 'artwork\\52.jpg'), ('l', 'artwork/53.jpg'), ('e', '');",
        )
        .unwrap();
        let rewritten = use_this_systems_separator(&conn).unwrap();
        assert_eq!(rewritten, 1, "only the other system's row changes");
        let path = |url: &str| -> String {
            conn.query_row("SELECT local_path FROM artwork_cache WHERE url = ?1", [url], |r| r.get(0))
                .unwrap()
        };
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(path("w"), format!("artwork{sep}52.jpg"));
        assert_eq!(path("l"), format!("artwork{sep}53.jpg"));
        assert_eq!(path("e"), "");
        assert_eq!(use_this_systems_separator(&conn).unwrap(), 0, "a second run does nothing");
    }

    /// TMDB's images have an age limit; images from elsewhere do not.
    #[test]
    fn only_old_tmdb_images_are_fetched_again() {
        let now = TMDB_MAX_AGE_SECS * 2;
        let old = now - TMDB_MAX_AGE_SECS - 1;
        assert!(past_tmdb_age("https://image.tmdb.org/t/p/original/a.jpg", old, now));
        assert!(!past_tmdb_age("https://image.tmdb.org/t/p/original/a.jpg", now - 60, now));
        assert!(!past_tmdb_age("https://static.tvmaze.com/a.jpg", old, now));
    }

    /// A TV gets a smaller copy by what the picture is; a desktop, the original.
    #[test]
    fn a_tv_asks_for_a_smaller_copy_by_kind() {
        let tmdb = "https://image.tmdb.org/t/p/original/abc.jpg";
        let sized = |size: &str| format!("https://image.tmdb.org/t/p/{size}/abc.jpg");
        assert_eq!(rendition(tmdb, Kind::Poster, true), sized("w500"));
        assert_eq!(rendition(tmdb, Kind::Backdrop, true), sized("w1280"));
        assert_eq!(rendition(tmdb, Kind::Still, true), sized("w780"));
        assert_eq!(rendition(tmdb, Kind::Logo, true), sized("w500"));
        assert_eq!(rendition(tmdb, Kind::Other, true), tmdb, "a logo keeps its size");
        // Already sized, or from elsewhere: left alone.
        let w300 = "https://image.tmdb.org/t/p/w300/s.png";
        assert_eq!(rendition(w300, Kind::Poster, true), w300);
        assert_eq!(rendition("https://a/b.jpg", Kind::Poster, true), "https://a/b.jpg");

        // TVmaze's smaller copies are too small for a TV: its originals stay.
        let maze = "https://static.tvmaze.com/uploads/images/original_untouched/1/4388.jpg";
        for kind in [Kind::Poster, Kind::Backdrop, Kind::Still] {
            assert_eq!(rendition(maze, kind, true), maze);
        }
    }

    #[test]
    fn a_desktop_keeps_the_original() {
        for kind in [Kind::Poster, Kind::Backdrop, Kind::Still, Kind::Logo, Kind::Other] {
            for url in [
                "https://image.tmdb.org/t/p/original/abc.jpg",
                "https://static.tvmaze.com/uploads/images/original_untouched/1/2.jpg",
            ] {
                assert_eq!(rendition(url, kind, false), url);
            }
        }
        assert_eq!(super::SMALL_COPIES, cfg!(target_os = "android"));
    }

    #[test]
    fn each_url_is_known_by_the_column_it_came_from() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE titles (poster_url TEXT, backdrop_url TEXT, logo_url TEXT);
             CREATE TABLE episodes (still_url TEXT);
             CREATE TABLE people (profile_url TEXT);
             CREATE TABLE studios (logo_url TEXT);
             INSERT INTO titles VALUES ('p', 'b', 'l'), ('p', 'b', NULL), ('both', 'both', '');
             INSERT INTO episodes VALUES ('s'), ('s');
             INSERT INTO people VALUES ('f');
             INSERT INTO studios VALUES ('st');",
        )
        .unwrap();
        let mut found = super::all_urls(&conn).unwrap();
        found.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            found,
            vec![
                ("b".to_string(), Kind::Backdrop),
                ("both".to_string(), Kind::Other),
                ("f".to_string(), Kind::Other),
                ("l".to_string(), Kind::Logo),
                ("p".to_string(), Kind::Poster),
                ("s".to_string(), Kind::Still),
                ("st".to_string(), Kind::Other),
            ]
        );
    }

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

    /// A cache with a table and a folder on disk, as `reserve_in` sees them.
    fn cache(name: &str) -> (std::sync::Mutex<rusqlite::Connection>, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!("kinema-artwork-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join(super::DIR)).unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE artwork_cache (
                 url TEXT PRIMARY KEY, local_path TEXT NOT NULL,
                 bytes INTEGER NOT NULL, fetched_at INTEGER NOT NULL);",
        )
        .unwrap();
        (std::sync::Mutex::new(conn), base)
    }

    fn row(db: &std::sync::Mutex<rusqlite::Connection>, url: &str) -> (i64, String) {
        db.lock()
            .unwrap()
            .query_row(
                "SELECT rowid, local_path FROM artwork_cache WHERE url = ?1",
                [url],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
    }

    /// Every way a URL can stand, answered from one listing of the folder.
    #[test]
    fn reserve_keeps_what_is_on_disk_and_claims_the_rest() {
        let (db, base) = cache("reserve");
        let sep = std::path::MAIN_SEPARATOR;
        let tmdb = |n: &str| format!("https://image.tmdb.org/t/p/original/{n}.jpg");
        let now = TMDB_MAX_AGE_SECS * 3;
        let old = now - TMDB_MAX_AGE_SECS - 1;
        {
            let conn = db.lock().unwrap();
            for (url, path, at) in [
                ("https://a/ok.jpg", format!("artwork{sep}1.jpg"), now),       // cached, file there
                ("https://a/gone.jpg", format!("artwork{sep}2.jpg"), now),     // cached, file deleted
                (tmdb("old").as_str(), format!("artwork{sep}3.jpg"), old),     // old TMDB, file there
                ("https://a/failed.jpg", String::new(), now),                  // tried, never stored
            ] {
                conn.execute(
                    "INSERT INTO artwork_cache VALUES (?1, ?2, 10, ?3)",
                    rusqlite::params![url, path, at],
                )
                .unwrap();
            }
        }
        for file in ["1.jpg", "3.jpg"] {
            std::fs::write(base.join("artwork").join(file), b"x").unwrap();
        }
        let (gone_id, _) = row(&db, "https://a/gone.jpg");
        let (failed_id, _) = row(&db, "https://a/failed.jpg");
        let (old_id, _) = row(&db, &tmdb("old"));

        let urls: Vec<String> = [
            "https://a/ok.jpg",
            "https://a/gone.jpg",
            " https://a/new.jpg ",
            "",
            "https://a/new.jpg", // a duplicate once trimmed
            "https://a/failed.jpg",
            &tmdb("old"),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let pending = super::reserve_in(&db, &base, &urls, now).unwrap();
        let (new_id, _) = row(&db, "https://a/new.jpg");

        assert_eq!(
            pending,
            vec![
                (gone_id, "https://a/gone.jpg".to_string()),
                (new_id, "https://a/new.jpg".to_string()),
                (failed_id, "https://a/failed.jpg".to_string()),
                (old_id, tmdb("old")),
            ]
        );
        // The kept one is untouched; the claimed ones wait with no file.
        assert_eq!(row(&db, "https://a/ok.jpg").1, format!("artwork{sep}1.jpg"));
        assert_eq!(row(&db, "https://a/gone.jpg").1, "");
        assert_eq!(row(&db, "https://a/new.jpg").1, "");
        // The old TMDB image keeps showing until its new file replaces it.
        assert_eq!(row(&db, &tmdb("old")).1, format!("artwork{sep}3.jpg"));

        // A second pass finds the same work and claims nothing new.
        let again = super::reserve_in(&db, &base, &urls, now).unwrap();
        assert_eq!(again.len(), 4);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// No folder at all (wiped, or never made): everything is fetched.
    #[test]
    fn reserve_without_a_folder_fetches_everything() {
        let (db, base) = cache("nofolder");
        std::fs::remove_dir_all(base.join("artwork")).unwrap();
        db.lock()
            .unwrap()
            .execute("INSERT INTO artwork_cache VALUES ('https://a/x.jpg', 'artwork/9.jpg', 1, 1)", [])
            .unwrap();
        let pending = super::reserve_in(&db, &base, &["https://a/x.jpg".to_string()], 5).unwrap();
        assert_eq!(pending.len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_download_window_follows_the_cores_within_limits() {
        assert_eq!(super::window_for(1), 4);
        assert_eq!(super::window_for(2), 4);
        assert_eq!(super::window_for(4), 8);
        assert_eq!(super::window_for(32), 12);
    }
}
