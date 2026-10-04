//! OpenSubtitles — subtitles for a file that has none in the language wanted.
//!
//! Decided 2026-09-30 (notes, WORKLOG):
//!
//! - **Only when asked**, from the player's Audio & subtitles panel — one press
//!   takes the best match, and the rest are offered — **plus one automatic
//!   case, off by default: forced subtitles**, the few lines for what is said
//!   in another language, fetched when a file has none. OpenSubtitles marks
//!   those (`foreign_parts_only`), so they can be asked for directly.
//! - **The best match is one timed for this exact file.** OpenSubtitles'
//!   file hash — the size and the first and last 64 KiB — finds subtitles
//!   made from the same release. That reads file bytes, which the scanner never
//!   does; this happens only when a subtitle is asked for.
//! - **An account is optional.** Without one, 5 downloads a day per network;
//!   signed in, 20. A sign-in lasts about a day, so the password is kept to
//!   sign in again: encrypted to the Windows user with DPAPI on Windows, and in
//!   Kinema's own settings elsewhere, as Kodi and Jellyfin keep theirs.
//! - **Subtitles are saved in Kinema's app data**, never beside the video:
//!   media folders are read, never written. Each is fetched once per file, so a
//!   rewatch costs no download.
//!
//! The app key (`Api-Key`) is Kinema's own, built into releases from a
//! repository secret like the TMDB key.

use crate::library::Db;
use crate::settings::setting;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

const BUILTIN_API_KEY: Option<&str> = option_env!("KINEMA_OPENSUBTITLES_API_KEY");
/// Setting key: an app key of one's own, for a build without one.
pub const API_KEY_KEY: &str = "opensubtitles_api_key";

const USERNAME_KEY: &str = "opensubtitles_username";
const PASSWORD_KEY: &str = "opensubtitles_password";
const TOKEN_KEY: &str = "opensubtitles_token";
const TOKEN_AT_KEY: &str = "opensubtitles_token_at";
/// The host a sign-in says to use (VIP accounts get their own).
const HOST_KEY: &str = "opensubtitles_host";
const REMAINING_KEY: &str = "opensubtitles_remaining";
const RESET_KEY: &str = "opensubtitles_reset";
/// Setting key: `'on'` fetches forced subtitles by itself. Off by default.
pub const AUTO_FORCED_KEY: &str = "opensubtitles_forced";

const DEFAULT_HOST: &str = "api.opensubtitles.com";
/// A sign-in lasts about a day; renewed a little before.
const TOKEN_LIFETIME_SECS: i64 = 20 * 60 * 60;
/// How long "no forced subtitles exist for this file" is believed before
/// asking again — someone may have uploaded some since.
const NONE_FOUND_SECS: i64 = 30 * 24 * 60 * 60;
const TIMEOUT: Duration = Duration::from_secs(20);

fn user_agent() -> String {
    // The form OpenSubtitles asks for: an app name and version.
    format!("Kinema v{}", env!("CARGO_PKG_VERSION"))
}

fn api_key(conn: &Connection) -> Option<String> {
    setting(conn, API_KEY_KEY)
        .map(|k| k.trim().to_string())
        .or_else(|| BUILTIN_API_KEY.map(str::trim).filter(|k| !k.is_empty()).map(String::from))
}


fn store(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    crate::settings::store(conn, key, value)
}

fn clear(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])
        .map(|_| ())
        .map_err(to_string_err)
}

// ---- the password -------------------------------------------------------------

/// Kept so Kinema can sign in again when the day's sign-in runs out.
///
/// On Windows it is encrypted with DPAPI to the Windows user — only that user
/// on that PC can read it back, so the weekly safety copies of the library
/// carry only the encrypted form. Elsewhere it is kept as it is, in Kinema's
/// own settings, which is how Kodi and Jellyfin keep theirs; a port needs no
/// secret store to work.
fn protect(password: &str) -> String {
    #[cfg(windows)]
    if let Some(sealed) = dpapi::seal(password.as_bytes()) {
        return format!("dpapi:{}", hex(&sealed));
    }
    format!("plain:{password}")
}

fn unprotect(stored: &str) -> Option<String> {
    if let Some(plain) = stored.strip_prefix("plain:") {
        return Some(plain.to_string());
    }
    #[cfg(windows)]
    if let Some(sealed) = stored.strip_prefix("dpapi:") {
        let bytes = unhex(sealed)?;
        return dpapi::open(&bytes).and_then(|b| String::from_utf8(b).ok());
    }
    None
}

#[cfg_attr(not(windows), allow(dead_code))]
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(windows)]
mod dpapi {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn take(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: the blob was filled in by DPAPI, which owns `cbData` bytes at
        // `pbData` until LocalFree below.
        let out = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(blob.pbData as _)));
        }
        out
    }

    pub fn seal(data: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: input points at `data`, alive for the call; output is
        // allocated by DPAPI and freed in `take`.
        unsafe {
            CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
                .ok()?;
        }
        Some(take(&output))
    }

    pub fn open(data: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as in `seal`.
        unsafe {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
                .ok()?;
        }
        Some(take(&output))
    }
}

// ---- the file's fingerprint -----------------------------------------------------

/// OpenSubtitles' file hash: the size, plus the first and the last 64 KiB read
/// as little-endian 64-bit numbers, all added up with wrap-around; sixteen hex
/// digits. It is how subtitles timed for this very release are found.
pub fn movie_hash(path: &Path) -> Option<String> {
    const CHUNK: u64 = 64 * 1024;
    let size = crate::files::metadata(path).ok()?.len;
    if size < CHUNK * 2 {
        return None;
    }
    let mut sum = size;
    for offset in [0, size - CHUNK] {
        let buffer = crate::files::read_at(path, offset, CHUNK as usize).ok()?;
        if buffer.len() != CHUNK as usize {
            return None;
        }
        for word in buffer.as_chunks::<8>().0 {
            sum = sum.wrapping_add(u64::from_le_bytes(*word));
        }
    }
    Some(format!("{sum:016x}"))
}

// ---- asking ---------------------------------------------------------------------

/// A language as OpenSubtitles spells it. Kinema's codes are two letters;
/// OpenSubtitles splits Portuguese and Chinese, so both halves are asked for.
fn os_languages(code: &str) -> String {
    match code.trim().to_ascii_lowercase().as_str() {
        "pt" => "pt-br,pt-pt".into(),
        "zh" => "zh-cn,zh-tw".into(),
        "nb" | "nn" => "no".into(),
        other => other.into(),
    }
}

fn http() -> Option<tauri_plugin_http::reqwest::Client> {
    tauri_plugin_http::reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .ok()
}

fn percent(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b',' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// A query string in the form OpenSubtitles asks for: names in alphabetical
/// order, values in lower case, and nothing that equals its default — or the
/// request is redirected first (checked against the live API, 2026-09-30).
fn query(pairs: &[(&str, String)]) -> String {
    let mut pairs: Vec<_> = pairs.iter().filter(|(_, v)| !v.is_empty()).collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", percent(&v.to_lowercase())))
        .collect::<Vec<_>>()
        .join("&")
}

/// What the library knows about a file, to ask by.
#[derive(Debug, Default, Clone)]
struct Wanted {
    is_film: bool,
    imdb_id: Option<String>,
    tmdb_id: Option<String>,
    season: Option<i64>,
    episode: Option<i64>,
}

fn wanted_for(conn: &Connection, media_file_id: i64) -> Option<Wanted> {
    conn.query_row(
        "SELECT t.kind, t.imdb_id, t.tmdb_id, m.parsed_season, m.parsed_episode
           FROM media_files m JOIN titles t ON t.id = m.title_id
          WHERE m.id = ?1",
        [media_file_id],
        |r| {
            Ok(Wanted {
                is_film: r.get::<_, String>(0)? == "movie",
                imdb_id: r.get(1)?,
                tmdb_id: r.get(2)?,
                season: r.get(3)?,
                episode: r.get(4)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// The search, as query pairs. Asked by the title's ids and this file's hash
/// together: the hash finds the same release, the ids everything else.
fn search_pairs(wanted: &Wanted, hash: Option<&str>, languages: &str, forced_only: bool) -> Vec<(&'static str, String)> {
    let digits = |id: &Option<String>| {
        id.as_deref()
            .map(|s| s.trim().trim_start_matches("tt").trim_start_matches('0').to_string())
            .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .unwrap_or_default()
    };
    let mut pairs = vec![
        ("languages", os_languages(languages)),
        // Forced-only files are what the automatic case wants, and never what
        // someone asking for subtitles wants.
        ("foreign_parts_only", if forced_only { "only" } else { "exclude" }.into()),
        // Machine translations are left out by OpenSubtitles' own default.
        // Saying so anyway is not harmless: a value equal to the default is
        // answered with a redirect to the address without it.
        ("moviehash", hash.unwrap_or_default().into()),
    ];
    if wanted.is_film {
        pairs.push(("type", "movie".into()));
        pairs.push(("imdb_id", digits(&wanted.imdb_id)));
        if wanted.imdb_id.is_none() {
            pairs.push(("tmdb_id", digits(&wanted.tmdb_id)));
        }
    } else {
        pairs.push(("type", "episode".into()));
        pairs.push(("parent_imdb_id", digits(&wanted.imdb_id)));
        if wanted.imdb_id.is_none() {
            pairs.push(("parent_tmdb_id", digits(&wanted.tmdb_id)));
        }
        pairs.push(("season_number", wanted.season.map(|n| n.to_string()).unwrap_or_default()));
        pairs.push(("episode_number", wanted.episode.map(|n| n.to_string()).unwrap_or_default()));
    }
    pairs
}

/// One subtitle OpenSubtitles offers, as the panel shows it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Offer {
    /// The id to download it by.
    pub file_id: i64,
    pub language: String,
    /// The release it was made for, as its uploader named it.
    pub release: String,
    pub downloads: i64,
    /// Timed for this exact file (the hash matched).
    pub matches_file: bool,
    pub hearing_impaired: bool,
    pub forced: bool,
    /// Translated by a machine or an AI rather than a person.
    pub translated: bool,
    pub trusted: bool,
}

/// `file_name` is this file's name, for `rank`.
fn parse_offers(body: &Value, file_name: &str) -> Vec<Offer> {
    let mut offers: Vec<Offer> = body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let a = &item["attributes"];
            let file_id = a["files"].as_array()?.first()?["file_id"].as_i64()?;
            let flag = |k: &str| a[k].as_bool().unwrap_or(false);
            Some(Offer {
                file_id,
                language: a["language"].as_str().unwrap_or_default().to_string(),
                release: a["release"].as_str().unwrap_or_default().to_string(),
                downloads: a["download_count"].as_i64().unwrap_or(0),
                matches_file: flag("moviehash_match"),
                hearing_impaired: flag("hearing_impaired"),
                forced: flag("foreign_parts_only"),
                translated: flag("ai_translated") || flag("machine_translated"),
                trusted: flag("from_trusted"),
            })
        })
        .collect();
    rank(&mut offers, file_name);
    offers
}

/// The words of a release or file name, lower case: `Show.S01E01.1080p.BluRay.x265-GRP`
/// is `show s01e01 1080p bluray x265 grp`.
fn words(name: &str) -> std::collections::HashSet<String> {
    name.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| w.len() > 1)
        .map(String::from)
        .collect()
}

/// How many words a release name shares with this file's name. Subtitles
/// made from the same kind of release — the same source, resolution, group —
/// are far likelier to be in step with it.
fn likeness(release: &str, file: &std::collections::HashSet<String>) -> usize {
    words(release).intersection(file).count()
}

/// Best first: timed for this very file; then made by a person; then the
/// release most like this file's; then a trusted uploader; then the most
/// downloaded.
///
/// Likeness comes before trust after a real search (2026-09-30) put a
/// trusted uploader's whole-season subtitle for another source above one
/// named for exactly this kind of file.
fn rank(offers: &mut [Offer], file_name: &str) {
    let file = words(file_name);
    offers.sort_by(|a, b| {
        b.matches_file
            .cmp(&a.matches_file)
            .then(a.translated.cmp(&b.translated))
            .then(likeness(&b.release, &file).cmp(&likeness(&a.release, &file)))
            .then(b.trusted.cmp(&a.trusted))
            .then(b.downloads.cmp(&a.downloads))
    });
}

fn base(conn: &Connection) -> String {
    format!("https://{}/api/v1", setting(conn, HOST_KEY).unwrap_or_else(|| DEFAULT_HOST.into()))
}

fn request(
    method: tauri_plugin_http::reqwest::Method,
    url: &str,
    key: &str,
    token: Option<&str>,
) -> Option<tauri_plugin_http::reqwest::RequestBuilder> {
    let mut r = http()?
        .request(method, url)
        .header("Api-Key", key)
        .header("User-Agent", user_agent())
        .header("Content-Type", "application/json")
        .header("Accept", "application/json");
    if let Some(t) = token {
        r = r.header("Authorization", format!("Bearer {t}"));
    }
    Some(r)
}

async fn send(
    builder: Option<tauri_plugin_http::reqwest::RequestBuilder>,
) -> Result<(u16, Value), String> {
    let response = builder
        .ok_or("could not start a web request")?
        .send()
        .await
        .map_err(|e| format!("OpenSubtitles could not be reached: {e}"))?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

/// What a sign-in or a download needs: the app key, the host, and a sign-in
/// token if there is (or can be made) one.
struct Session {
    key: String,
    base: String,
    token: Option<String>,
}

/// The app key and, when an account is set, a current sign-in — renewed with
/// the kept password when the day's one has run out.
async fn session(app: &tauri::AppHandle) -> Result<Session, String> {
    let (key, base, token, token_at, username, password) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        let key = api_key(&conn).ok_or("This copy of Kinema has no OpenSubtitles app key.")?;
        (
            key,
            base(&conn),
            setting(&conn, TOKEN_KEY),
            setting(&conn, TOKEN_AT_KEY).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0),
            setting(&conn, USERNAME_KEY),
            setting(&conn, PASSWORD_KEY).and_then(|p| unprotect(&p)),
        )
    };
    if token.is_some() && now_secs() - token_at < TOKEN_LIFETIME_SECS {
        return Ok(Session { key, base, token });
    }
    let (Some(username), Some(password)) = (username, password) else {
        return Ok(Session { key, base, token: None });
    };
    match log_in(app, &key, &username, &password).await {
        Ok(()) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            Ok(Session { key, base: self::base(&conn), token: setting(&conn, TOKEN_KEY) })
        }
        // Signed out rather than stuck: the free allowance still works.
        Err(e) => {
            crate::log!("opensubtitles: could not sign in again ({e}); downloading without an account");
            Ok(Session { key, base, token: None })
        }
    }
}

async fn log_in(app: &tauri::AppHandle, key: &str, username: &str, password: &str) -> Result<(), String> {
    let url = format!("https://{DEFAULT_HOST}/api/v1/login");
    let body = json!({ "username": username, "password": password });
    let (status, answer) = send(
        request(tauri_plugin_http::reqwest::Method::POST, &url, key, None).map(|r| r.body(body.to_string())),
    )
    .await?;
    match status {
        200 => {
            let token = answer["token"].as_str().ok_or("no sign-in token in the answer")?;
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            store(&conn, TOKEN_KEY, token)?;
            store(&conn, TOKEN_AT_KEY, &now_secs().to_string())?;
            match answer["base_url"].as_str().map(str::trim).filter(|h| !h.is_empty()) {
                Some(host) => store(&conn, HOST_KEY, host.trim_start_matches("https://"))?,
                None => clear(&conn, HOST_KEY)?,
            }
            if let Some(n) = answer.pointer("/user/allowed_downloads").and_then(Value::as_i64) {
                store(&conn, REMAINING_KEY, &n.to_string())?;
            }
            Ok(())
        }
        400 => Err("OpenSubtitles wants the username here, not the email address.".into()),
        401 => Err("The OpenSubtitles username or password is wrong.".into()),
        429 => Err("OpenSubtitles is busy; try again in a moment.".into()),
        other => Err(format!("OpenSubtitles answered {other} to signing in.")),
    }
}

// ---- remembering what was fetched --------------------------------------------------

fn subtitles_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::data_dir(app)?.join("subtitles");
    std::fs::create_dir_all(&dir).map_err(to_string_err)?;
    Ok(dir)
}

/// A subtitle already fetched for this file, still on disk: where it is, and
/// which of OpenSubtitles' files it was.
fn fetched_row(conn: &Connection, media_file_id: i64, language: &str, forced: bool) -> Option<(String, i64)> {
    conn.query_row(
        "SELECT path, os_file_id FROM subtitle_files
          WHERE media_file_id = ?1 AND language = ?2 AND forced = ?3 AND path IS NOT NULL
          ORDER BY fetched_at DESC LIMIT 1",
        params![media_file_id, language, forced as i64],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
    )
    .optional()
    .ok()
    .flatten()
    .filter(|(p, _)| Path::new(p).is_file())
}

fn fetched(conn: &Connection, media_file_id: i64, language: &str, forced: bool) -> Option<String> {
    fetched_row(conn, media_file_id, language, forced).map(|(p, _)| p)
}

/// Whether a recent search found no forced subtitles for this file.
fn recently_none(conn: &Connection, media_file_id: i64, language: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM subtitle_files
          WHERE media_file_id = ?1 AND language = ?2 AND forced = 1 AND path IS NULL
            AND fetched_at > ?3",
        params![media_file_id, language, now_secs() - NONE_FOUND_SECS],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn remember(
    conn: &Connection,
    media_file_id: i64,
    language: &str,
    forced: bool,
    os_file_id: Option<i64>,
    path: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO subtitle_files (media_file_id, language, forced, os_file_id, path, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![media_file_id, language, forced as i64, os_file_id, path, now_secs()],
    )
    .map(|_| ())
    .map_err(to_string_err)
}

// ---- the commands ----------------------------------------------------------------

#[derive(Serialize)]
pub struct SubtitleStatus {
    /// There is an app key, so searching is possible at all.
    pub available: bool,
    /// The OpenSubtitles account, when one is set.
    pub user: Option<String>,
    /// Downloads left today, as OpenSubtitles last said.
    pub remaining: Option<i64>,
    /// When the allowance starts again, as OpenSubtitles last said.
    pub reset: Option<String>,
    /// Fetch forced subtitles by itself.
    pub auto_forced: bool,
}

#[tauri::command]
pub fn opensubtitles_status(db: tauri::State<Db>) -> Result<SubtitleStatus, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    Ok(SubtitleStatus {
        // Unlike SIMKL and Trakt, a self-test may use OpenSubtitles: there is
        // no grant to cut off (a second sign-in is simply a second token), and
        // a copy of the library keeps what it fetches in its own folder. It is
        // how the real search and download are tested end to end.
        available: api_key(&conn).is_some(),
        user: setting(&conn, USERNAME_KEY),
        remaining: setting(&conn, REMAINING_KEY).and_then(|s| s.parse().ok()),
        reset: setting(&conn, RESET_KEY),
        auto_forced: setting(&conn, AUTO_FORCED_KEY).as_deref() == Some("on"),
    })
}

/// Sign in with an OpenSubtitles account. The password is kept only if the
/// sign-in works — see `protect`.
#[tauri::command]
pub async fn opensubtitles_sign_in(
    app: tauri::AppHandle,
    username: String,
    password: String,
) -> Result<(), String> {
    let key = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        api_key(&conn).ok_or("This copy of Kinema has no OpenSubtitles app key.")?
    };
    let username = username.trim().to_string();
    log_in(&app, &key, &username, &password).await?;
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(to_string_err)?;
    store(&conn, USERNAME_KEY, &username)?;
    store(&conn, PASSWORD_KEY, &protect(&password))?;
    crate::log!("opensubtitles: signed in");
    Ok(())
}

#[tauri::command]
pub async fn opensubtitles_sign_out(app: tauri::AppHandle) -> Result<(), String> {
    let (key, base, token) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        (api_key(&conn), base(&conn), setting(&conn, TOKEN_KEY))
    };
    if let (Some(key), Some(token)) = (key, token) {
        let url = format!("{base}/logout");
        let _ = send(request(tauri_plugin_http::reqwest::Method::DELETE, &url, &key, Some(&token))).await;
    }
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(to_string_err)?;
    for k in [USERNAME_KEY, PASSWORD_KEY, TOKEN_KEY, TOKEN_AT_KEY, HOST_KEY, REMAINING_KEY, RESET_KEY] {
        clear(&conn, k)?;
    }
    crate::log!("opensubtitles: signed out");
    Ok(())
}

async fn search(
    app: &tauri::AppHandle,
    media_file_id: i64,
    path: &str,
    language: &str,
    forced_only: bool,
) -> Result<Vec<Offer>, String> {
    let wanted = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        wanted_for(&conn, media_file_id)
    }
    .ok_or("This file is not matched to a film or episode, so there is nothing to search by.")?;
    let file = PathBuf::from(path);
    let hash = tauri::async_runtime::spawn_blocking(move || movie_hash(&file))
        .await
        .ok()
        .flatten();
    let session = session(app).await?;
    let url = format!("{}/subtitles?{}", session.base, query(&search_pairs(&wanted, hash.as_deref(), language, forced_only)));
    let (status, body) = send(request(
        tauri_plugin_http::reqwest::Method::GET,
        &url,
        &session.key,
        session.token.as_deref(),
    ))
    .await?;
    match status {
        200 => {
            let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned());
            Ok(parse_offers(&body, name.as_deref().unwrap_or_default()))
        }
        429 => Err("OpenSubtitles is busy; try again in a moment.".into()),
        other => {
            crate::log!("opensubtitles: search answered {other}: {body}");
            Err(format!("OpenSubtitles answered {other} to the search."))
        }
    }
}

/// Download one subtitle into Kinema's own folder, and remember it for this
/// file. Returns where it is.
async fn download(
    app: &tauri::AppHandle,
    media_file_id: i64,
    offer_file_id: i64,
    language: &str,
    forced: bool,
) -> Result<String, String> {
    let session = session(app).await?;
    let url = format!("{}/download", session.base);
    let body = json!({ "file_id": offer_file_id, "sub_format": "srt" });
    let (status, answer) = send(
        request(tauri_plugin_http::reqwest::Method::POST, &url, &session.key, session.token.as_deref())
            .map(|r| r.body(body.to_string())),
    )
    .await?;
    let note_allowance = |answer: &Value| -> Result<(), String> {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        if let Some(n) = answer["remaining"].as_i64() {
            store(&conn, REMAINING_KEY, &n.to_string())?;
        }
        // The UTC time, not `reset_time`, which is "13 hours and 16 minutes"
        // from whenever it was said.
        if let Some(r) = answer["reset_time_utc"].as_str() {
            store(&conn, RESET_KEY, r)?;
        }
        Ok(())
    };
    match status {
        200 => {}
        406 => {
            note_allowance(&answer)?;
            return Err("Today's OpenSubtitles downloads are used up. More are allowed tomorrow — or sign in, in Settings → Accounts, for 20 a day.".into());
        }
        401 => return Err("OpenSubtitles did not accept the sign-in. Sign in again in Settings → Accounts.".into()),
        429 => return Err("OpenSubtitles is busy; try again in a moment.".into()),
        other => {
            crate::log!("opensubtitles: download answered {other}: {answer}");
            return Err(format!("OpenSubtitles answered {other} to the download."));
        }
    }
    note_allowance(&answer)?;
    let link = answer["link"].as_str().ok_or("OpenSubtitles gave no download link")?;
    let text = http()
        .ok_or("could not start a web request")?
        .get(link)
        .header("User-Agent", user_agent())
        .send()
        .await
        .map_err(|e| format!("the subtitle could not be fetched: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("the subtitle could not be read: {e}"))?;
    let target = subtitles_dir(app)?.join(format!("{offer_file_id}.srt"));
    std::fs::write(&target, &text).map_err(to_string_err)?;
    let target = target.to_string_lossy().into_owned();
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(to_string_err)?;
    remember(&conn, media_file_id, language, forced, Some(offer_file_id), Some(&target))?;
    crate::log!("opensubtitles: fetched subtitle {offer_file_id} ({language}{}) for file {media_file_id}", if forced { ", forced" } else { "" });
    Ok(target)
}

/// What a search found, with the best one already fetched.
#[derive(Serialize)]
pub struct Found {
    /// Where the best subtitle is, to load into the player.
    pub path: String,
    /// The one fetched.
    pub chosen: Offer,
    /// Everything found, best first — "Choose another".
    pub offers: Vec<Offer>,
}

/// "Find subtitles online": search, fetch the best, and hand back the rest.
///
/// A subtitle already fetched for this file in this language is used again
/// rather than downloaded again — the search still runs, since searching is
/// free and "Choose another" needs the list.
#[tauri::command]
pub async fn find_subtitles(
    app: tauri::AppHandle,
    file_id: i64,
    path: String,
    language: String,
) -> Result<Option<Found>, String> {
    let offers = search(&app, file_id, &path, &language, false).await?;
    let earlier = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        fetched_row(&conn, file_id, &language, false)
    };
    if let Some((path, os_file_id)) = earlier {
        let chosen = offers.iter().find(|o| o.file_id == os_file_id).or(offers.first()).cloned();
        if let Some(chosen) = chosen {
            return Ok(Some(Found { path, chosen, offers }));
        }
    }
    let Some(best) = offers.first().cloned() else { return Ok(None) };
    let path = download(&app, file_id, best.file_id, &language, false).await?;
    Ok(Some(Found { path, chosen: best, offers }))
}

/// "Choose another": fetch one particular subtitle from the list.
#[tauri::command]
pub async fn fetch_subtitle(
    app: tauri::AppHandle,
    file_id: i64,
    offer_file_id: i64,
    language: String,
) -> Result<String, String> {
    download(&app, file_id, offer_file_id, &language, false).await
}

/// The automatic case: forced subtitles in the spoken language for a file
/// that has none. Uses a download only the first time, and asks again about a
/// file with none only after a month. `None` when there are none.
#[tauri::command]
pub async fn forced_subtitle(
    app: tauri::AppHandle,
    file_id: i64,
    path: String,
    language: String,
) -> Result<Option<String>, String> {
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        if let Some(found) = fetched(&conn, file_id, &language, true) {
            return Ok(Some(found));
        }
        if setting(&conn, AUTO_FORCED_KEY).as_deref() != Some("on")
            || api_key(&conn).is_none()
            || recently_none(&conn, file_id, &language)
        {
            return Ok(None);
        }
    }
    let offers = search(&app, file_id, &path, &language, true).await?;
    // Only files OpenSubtitles marks as forced: a full subtitle would put
    // every line on screen for someone who asked for none.
    let Some(best) = offers.into_iter().find(|o| o.forced) else {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        remember(&conn, file_id, &language, true, None, None)?;
        crate::log!("opensubtitles: no forced {language} subtitles for file {file_id}");
        return Ok(None);
    };
    download(&app, file_id, best.file_id, &language, true).await.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hash, worked by hand on a file of known bytes: the size plus the
    /// sum of every 8-byte word in the first and last 64 KiB.
    #[test]
    fn the_file_hash_is_opensubtitles_sum() {
        let dir = std::env::temp_dir().join("pn-os-hash");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.mkv");
        // 192 KiB: words of 1 in the first 64 KiB, 0 in the middle, 2 at the end.
        let mut bytes = Vec::new();
        for _ in 0..8192 {
            bytes.extend_from_slice(&1u64.to_le_bytes());
        }
        bytes.extend(std::iter::repeat_n(0u8, 64 * 1024));
        for _ in 0..8192 {
            bytes.extend_from_slice(&2u64.to_le_bytes());
        }
        std::fs::write(&path, &bytes).unwrap();
        let expected = (bytes.len() as u64) + 8192 + 8192 * 2;
        assert_eq!(movie_hash(&path), Some(format!("{expected:016x}")));
    }

    #[test]
    fn a_file_too_small_to_hash_has_none() {
        let dir = std::env::temp_dir().join("pn-os-hash-small");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.srt");
        std::fs::write(&path, b"tiny").unwrap();
        assert_eq!(movie_hash(&path), None);
    }

    /// Alphabetical, lower case, empty values left out.
    #[test]
    fn the_query_is_in_the_order_opensubtitles_wants() {
        let q = query(&[
            ("type", "Episode".into()),
            ("languages", "en".into()),
            ("moviehash", String::new()),
            ("episode_number", "3".into()),
        ]);
        assert_eq!(q, "episode_number=3&languages=en&type=episode");
    }

    #[test]
    fn an_episode_is_asked_by_its_show_and_numbers() {
        let wanted = Wanted {
            is_film: false,
            imdb_id: Some("tt0000206".into()),
            tmdb_id: Some("105".into()),
            season: Some(1),
            episode: Some(2),
        };
        let q = query(&search_pairs(&wanted, Some("8e245d9679d31e12"), "no", true));
        assert_eq!(
            q,
            "episode_number=2&foreign_parts_only=only&languages=no\
             &moviehash=8e245d9679d31e12&parent_imdb_id=206&season_number=1&type=episode"
        );
    }

    #[test]
    fn a_film_is_asked_by_its_tmdb_id_when_there_is_no_imdb_id() {
        let wanted = Wanted { is_film: true, tmdb_id: Some("1271".into()), ..Wanted::default() };
        let q = query(&search_pairs(&wanted, None, "pt", false));
        assert_eq!(
            q,
            "foreign_parts_only=exclude&languages=pt-br,pt-pt&tmdb_id=1271&type=movie"
        );
    }

    /// Timed for this file beats popular; a person beats a machine.
    #[test]
    fn offers_are_ranked_best_first() {
        let body = json!({ "data": [
            { "attributes": { "language": "en", "release": "popular", "download_count": 9000,
                "files": [{ "file_id": 1 }] } },
            { "attributes": { "language": "en", "release": "machine", "download_count": 99999,
                "moviehash_match": true, "ai_translated": true, "files": [{ "file_id": 2 }] } },
            { "attributes": { "language": "en", "release": "this file", "download_count": 3,
                "moviehash_match": true, "foreign_parts_only": true, "files": [{ "file_id": 3 }] } },
            { "attributes": { "language": "en", "release": "no files", "files": [] } }
        ]});
        let offers = parse_offers(&body, "");
        assert_eq!(offers.iter().map(|o| o.file_id).collect::<Vec<_>>(), vec![3, 2, 1]);
        assert!(offers[0].forced && offers[0].matches_file);
        assert!(offers[1].translated);
    }

    #[test]
    fn a_kept_password_reads_back() {
        let kept = protect("correct horse");
        // Elsewhere it is kept as given, in a folder only this account can
        // open (`util::keep_private`): the owner's "no extra work for the
        // ports".
        #[cfg(windows)]
        {
            assert!(kept.starts_with("dpapi:"), "encrypted on Windows");
            assert!(!kept.contains("correct horse"));
        }
        assert_eq!(unprotect(&kept).as_deref(), Some("correct horse"));
        assert_eq!(unprotect("plain:abc").as_deref(), Some("abc"));
        assert_eq!(unprotect("dpapi:zz"), None);
    }

    #[test]
    fn languages_are_spelled_as_opensubtitles_does() {
        assert_eq!(os_languages("en"), "en");
        assert_eq!(os_languages("nb"), "no");
        assert_eq!(os_languages("zh"), "zh-cn,zh-tw");
    }

    /// What was fetched is used again; a "none found" is believed for a month.
    #[test]
    fn fetched_subtitles_and_none_found_are_remembered() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        assert!(!recently_none(&conn, 7, "en"));
        remember(&conn, 7, "en", true, None, None).unwrap();
        assert!(recently_none(&conn, 7, "en"));
        assert!(!recently_none(&conn, 7, "no"));

        let file = std::env::temp_dir().join("pn-os-fetched.srt");
        std::fs::write(&file, b"1\n00:00:01,000 --> 00:00:02,000\nHi\n").unwrap();
        remember(&conn, 7, "en", false, Some(42), Some(&file.to_string_lossy())).unwrap();
        assert_eq!(fetched(&conn, 7, "en", false).as_deref(), Some(&*file.to_string_lossy()));
        assert_eq!(fetched(&conn, 7, "en", true), None, "a full subtitle is not a forced one");
        std::fs::remove_file(&file).unwrap();
        assert_eq!(fetched(&conn, 7, "en", false), None, "gone from disk, so not offered");
    }

    /// A release named like this file beats a more trusted, more downloaded
    /// one for another source — when neither is timed for the file itself.
    #[test]
    fn a_release_like_this_file_ranks_above_a_trusted_one_for_another() {
        let body = json!({ "data": [
            { "attributes": { "language": "en", "release": "Season 1 DVD pack", "download_count": 900,
                "from_trusted": true, "files": [{ "file_id": 1 }] } },
            { "attributes": { "language": "en", "release": "Show.S01E01.1080p.BluRay.x264-OTHER",
                "download_count": 17000, "files": [{ "file_id": 2 }] } },
            { "attributes": { "language": "en", "release": "Show.S01E01.720p.WEB", "download_count": 20000,
                "files": [{ "file_id": 3 }] } }
        ]});
        let offers = parse_offers(&body, "Show S01E01 1080p BluRay x265-GRP.mkv");
        assert_eq!(offers.iter().map(|o| o.file_id).collect::<Vec<_>>(), vec![2, 3, 1]);
    }
}
