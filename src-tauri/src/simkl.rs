//! SIMKL — telling the user's SIMKL account what they finished watching.
//!
//! **One way, and only additions.** When a film or an episode becomes watched
//! in Kinema — played past the end, or marked by hand — it is queued and sent
//! to SIMKL's history. Nothing ever comes back, and un-watching in Kinema
//! removes nothing from SIMKL: SIMKL may have that watch from another app, and
//! a one-way link has no business deleting what it did not write (decided
//! 2026-09-30). What was already watched before connecting is sent once, at
//! connect, with the dates it was watched. There is no live "Watching now".
//!
//! **Signing in is SIMKL's AUTH V2 device flow**, the one built for a TV: the
//! screen shows a short code and a QR code, the person approves on their
//! phone, and Kinema asks every few seconds whether they have. No password or
//! secret passes through Kinema — a desktop program cannot keep a
//! `client_secret`, and this flow needs none. AUTH V1 (the old PIN flow)
//! retires around April 2027, which is why it is not used.
//!
//! **SIMKL's rules shape the sending**, and they are firm: one write a second
//! per app and per user, with a `client_id` suspended "without warning, no
//! appeal" for sustained overage. So writes are batched — everything waiting,
//! up to [`BATCH`] items, in one request — sent a little after something is
//! finished rather than the instant it is, never polled, and paced. Re-sending
//! something already in SIMKL's history does nothing there, so a batch that
//! was sent but not acknowledged is simply sent again.
//!
//! **The queue survives being offline.** Finished items wait in
//! `simkl_outbox` until SIMKL has them: a failure to reach SIMKL keeps them,
//! and they go at the next launch or the next thing finished.
//!
//! **Tokens.** An access token lasts 7 days and is refreshed a day before it
//! runs out; the refresh token lasts 180 days, extended by every refresh, so
//! only a Kinema left unused for six months has to be connected again. Both
//! live in the settings table beside the TMDB and OMDb keys, in the user's own
//! app data. SIMKL suggests the operating system's secret store; the settings
//! table was chosen because it works the same on every platform Kinema may
//! reach, and a library folder is already private to its user.
//!
//! **A self-test never talks to SIMKL.** It runs on a copy of the library,
//! tokens included, and a second process refreshing the same grant would cut
//! the real Kinema's token off (SIMKL's "one grant, one live access token").

use crate::library::Db;
use crate::settings::setting;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// Kinema's own SIMKL app ID, set when a release is built (a repository
/// secret, like the TMDB key). Not a secret — SIMKL puts it in every URL — but
/// kept out of the source so the repository says nothing about whose SIMKL
/// account registered it. A build without one has no SIMKL unless an ID is
/// entered by hand ([`CLIENT_ID_KEY`]).
const BUILTIN_CLIENT_ID: Option<&str> = option_env!("KINEMA_SIMKL_CLIENT_ID");

/// Setting key: an app ID of the user's own, which wins over the built-in one.
/// Entered under Developer tools, for source builds.
pub const CLIENT_ID_KEY: &str = "simkl_client_id";

const ACCESS_KEY: &str = "simkl_access_token";
const REFRESH_KEY: &str = "simkl_refresh_token";
/// When the access token runs out, in Unix seconds.
const EXPIRES_KEY: &str = "simkl_access_expires_at";
/// The account's name, to say who Kinema is connected as.
const USER_KEY: &str = "simkl_user";
/// Set when SIMKL refused the refresh token: the person has to connect again.
const RECONNECT_KEY: &str = "simkl_needs_reconnect";
/// When SIMKL last accepted a batch, in Unix seconds.
const LAST_SENT_KEY: &str = "simkl_last_sent_at";

const API: &str = "https://api.simkl.com";
const APP_NAME: &str = "kinema";

/// The most items in one request. SIMKL asks for arrays rather than one call
/// per item; a hundred keeps a first-connect history of a big library to a
/// handful of requests without making any one of them huge.
const BATCH: usize = 100;

/// How long after something is finished before the batch goes. Marking a
/// whole season watched finishes a dozen episodes in a moment; they should be
/// one request, not twelve.
const SEND_DELAY: Duration = Duration::from_secs(10);

/// Between two requests that write. SIMKL allows one a second.
const WRITE_GAP: Duration = Duration::from_millis(1500);

/// Refresh the access token when it has less than this left.
const REFRESH_MARGIN_SECS: i64 = 24 * 60 * 60;

const TIMEOUT: Duration = Duration::from_secs(20);

fn user_agent() -> String {
    format!("{APP_NAME}/{}", env!("CARGO_PKG_VERSION"))
}

/// The app ID in effect: one entered by hand, else the built-in one.
fn client_id(conn: &Connection) -> Option<String> {
    setting(conn, CLIENT_ID_KEY)
        .map(|id| id.trim().to_string())
        .or_else(|| BUILTIN_CLIENT_ID.map(str::trim).filter(|id| !id.is_empty()).map(String::from))
}

/// Percent-encode a query value. App IDs are plain letters and digits today;
/// this is so a pasted one with a stray character cannot break the URL.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Every SIMKL URL carries the app ID, the app's name and its version.
fn url(path: &str, client_id: &str) -> String {
    format!(
        "{API}{path}?client_id={}&app-name={APP_NAME}&app-version={}",
        encode(client_id),
        env!("CARGO_PKG_VERSION")
    )
}

fn http() -> Option<tauri_plugin_http::reqwest::Client> {
    tauri_plugin_http::reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .ok()
}

fn store(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    crate::settings::store(conn, key, value)
}

fn clear(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

/// Whether SIMKL may be used at all in this process.
fn allowed() -> bool {
    crate::selftest::plan_path().is_none()
}

/// Connected means holding a refresh token that SIMKL has not refused.
fn connected(conn: &Connection) -> bool {
    setting(conn, REFRESH_KEY).is_some() && setting(conn, RECONNECT_KEY).is_none()
}

// ---- the queue --------------------------------------------------------------

/// Queue one finished film or episode, if SIMKL is connected.
///
/// Called by `history::remember` at the moment something becomes watched —
/// the one place that happens, whether by playing or by hand. Returns whether
/// anything was queued, so the caller knows to schedule a send.
///
/// Needs an IMDb or TMDB id: SIMKL finds a title by its ids, and without one
/// there is nothing to tell it that it could act on. An episode also needs its
/// numbers.
pub fn queue_finished(
    conn: &Connection,
    kind: &str,
    imdb_id: Option<&str>,
    tmdb_id: Option<&str>,
    season: Option<i64>,
    episode: Option<i64>,
    watched_at: i64,
) -> rusqlite::Result<bool> {
    if !connected(conn) {
        return Ok(false);
    }
    queue(conn, kind, imdb_id, tmdb_id, season, episode, watched_at)
}

/// Queue without asking whether SIMKL is connected — for the first-connect
/// history, which is queued the moment the tokens are stored.
fn queue(
    conn: &Connection,
    kind: &str,
    imdb_id: Option<&str>,
    tmdb_id: Option<&str>,
    season: Option<i64>,
    episode: Option<i64>,
    watched_at: i64,
) -> rusqlite::Result<bool> {
    let imdb_id = imdb_id.map(str::trim).filter(|s| !s.is_empty());
    let tmdb_id = tmdb_id.map(str::trim).filter(|s| !s.is_empty());
    if imdb_id.is_none() && tmdb_id.is_none() {
        return Ok(false);
    }
    let is_film = kind == "movie";
    if !is_film && (season.is_none() || episode.is_none()) {
        return Ok(false);
    }
    // One row per thing watched: the same episode finished twice before a
    // send is one watch as far as SIMKL's history goes, and the first time is
    // the one kept.
    let key = format!(
        "{}|{}|{}|{}|{}",
        if is_film { "movie" } else { "episode" },
        imdb_id.unwrap_or(""),
        tmdb_id.unwrap_or(""),
        season.map(|s| s.to_string()).unwrap_or_default(),
        episode.map(|e| e.to_string()).unwrap_or_default()
    );
    let added = conn.execute(
        "INSERT OR IGNORE INTO simkl_outbox
            (key, kind, imdb_id, tmdb_id, season, episode, watched_at, queued_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            key,
            if is_film { "movie" } else { "episode" },
            imdb_id,
            tmdb_id,
            if is_film { None } else { season },
            if is_film { None } else { episode },
            watched_at,
            now_secs()
        ],
    )?;
    Ok(added > 0)
}

/// Everything already watched, for the first send after connecting.
fn queue_history(conn: &Connection) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT kind, imdb_id, tmdb_id, season, episode, updated_at
           FROM watch_history
          WHERE completed = 1",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<i64>>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut queued = 0;
    for (kind, imdb, tmdb, season, episode, at) in rows {
        if queue(conn, &kind, imdb.as_deref(), tmdb.as_deref(), season, episode, at)? {
            queued += 1;
        }
    }
    Ok(queued)
}

#[derive(Debug, Clone, PartialEq)]
struct Waiting {
    id: i64,
    is_film: bool,
    imdb_id: Option<String>,
    tmdb_id: Option<String>,
    season: Option<i64>,
    episode: Option<i64>,
    watched_at: i64,
}

fn waiting(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<Waiting>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, imdb_id, tmdb_id, season, episode, watched_at
           FROM simkl_outbox ORDER BY id LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64], |r| {
        Ok(Waiting {
            id: r.get(0)?,
            is_film: r.get::<_, String>(1)? == "movie",
            imdb_id: r.get(2)?,
            tmdb_id: r.get(3)?,
            season: r.get(4)?,
            episode: r.get(5)?,
            watched_at: r.get(6)?,
        })
    })?;
    rows.collect()
}

fn waiting_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM simkl_outbox", [], |r| r.get(0))
        .unwrap_or(0)
}

fn forget_sent(conn: &Connection, sent: &[Waiting]) -> rusqlite::Result<()> {
    for row in sent {
        conn.execute("DELETE FROM simkl_outbox WHERE id = ?1", params![row.id])?;
    }
    Ok(())
}

// ---- the request ------------------------------------------------------------

/// A Unix time as the ISO-8601 SIMKL asks for, `2026-09-30T20:15:00Z`.
///
/// Written out rather than pulled in from a date crate for the one format:
/// days since 1970 to a civil date is a few lines of well-known arithmetic
/// (Howard Hinnant's `civil_from_days`).
fn iso8601(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// A show's IMDb and TMDB ids, which together say which show an episode is of.
type ShowIds = (Option<String>, Option<String>);
/// A season's number and its episodes, as they will be sent.
type Season = (i64, Vec<Value>);

fn ids(imdb_id: &Option<String>, tmdb_id: &Option<String>) -> Value {
    let mut ids = serde_json::Map::new();
    if let Some(imdb) = imdb_id {
        ids.insert("imdb".into(), json!(imdb));
    }
    if let Some(tmdb) = tmdb_id {
        ids.insert("tmdb".into(), json!(tmdb));
    }
    Value::Object(ids)
}

/// The body for `POST /sync/history`: films as they are, episodes gathered
/// under their show and season, each with the time it was watched.
///
/// A TMDB id means different things for films and shows; the list it sits in
/// (`movies` or `shows`) is what tells SIMKL which. `use_tvdb_anime_seasons`
/// says the season numbers are per season, as TMDB counts them — SIMKL
/// otherwise counts anime as one long season, and it changes nothing else.
fn history_body(rows: &[Waiting]) -> Value {
    let mut movies = Vec::new();
    // Shows in the order first seen, each with its seasons in the order seen.
    let mut shows: Vec<(ShowIds, Vec<Season>)> = Vec::new();

    for row in rows {
        if row.is_film {
            movies.push(json!({
                "ids": ids(&row.imdb_id, &row.tmdb_id),
                "watched_at": iso8601(row.watched_at),
            }));
            continue;
        }
        let (Some(season), Some(episode)) = (row.season, row.episode) else {
            continue;
        };
        let show_key = (row.imdb_id.clone(), row.tmdb_id.clone());
        let at = match shows.iter().position(|(k, _)| *k == show_key) {
            Some(i) => i,
            None => {
                shows.push((show_key, Vec::new()));
                shows.len() - 1
            }
        };
        let seasons = &mut shows[at].1;
        let entry = json!({ "number": episode, "watched_at": iso8601(row.watched_at) });
        match seasons.iter_mut().find(|(n, _)| *n == season) {
            Some((_, episodes)) => episodes.push(entry),
            None => seasons.push((season, vec![entry])),
        }
    }

    let shows: Vec<Value> = shows
        .into_iter()
        .map(|((imdb, tmdb), seasons)| {
            json!({
                "ids": ids(&imdb, &tmdb),
                "use_tvdb_anime_seasons": true,
                "seasons": seasons
                    .into_iter()
                    .map(|(number, episodes)| json!({ "number": number, "episodes": episodes }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();

    json!({ "movies": movies, "shows": shows })
}

/// What SIMKL could not place, as a line for the log. A title SIMKL does not
/// know is not a failure worth retrying — it would not know it next time
/// either — so these are logged and let go.
fn not_found_summary(response: &Value) -> Option<String> {
    let nf = response.get("not_found")?;
    let count = |k: &str| nf.get(k).and_then(Value::as_array).map_or(0, Vec::len);
    let (movies, shows, episodes) = (count("movies"), count("shows"), count("episodes"));
    if movies + shows + episodes == 0 {
        return None;
    }
    Some(format!(
        "{movies} film(s), {shows} show(s) and {episodes} episode(s) not found: {nf}"
    ))
}

// ---- tokens -----------------------------------------------------------------

#[derive(Debug, PartialEq)]
struct Tokens {
    access: String,
    refresh: String,
    expires_at: i64,
}

/// Read a token response. Refuses one without the right to write: SIMKL turns
/// an unrecognised scope into read-only access without saying so, and a
/// read-only token would work until the first send and then fail every time.
fn parse_tokens(body: &Value, previous_refresh: Option<&str>) -> Result<Tokens, String> {
    let access = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("no access token in SIMKL's answer")?;
    // Non-rotating: the same refresh token comes back. Keep ours if it is
    // missing rather than losing it.
    let refresh = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .or(previous_refresh)
        .ok_or("no refresh token in SIMKL's answer")?;
    let scope = body.get("scope").and_then(Value::as_str).unwrap_or("");
    if !scope.split_whitespace().any(|s| s == "media:write") {
        return Err(format!("SIMKL granted only \"{scope}\", not the right to write"));
    }
    let lifetime = body.get("expires_in").and_then(Value::as_i64).unwrap_or(7 * 86_400);
    Ok(Tokens {
        access: access.to_string(),
        refresh: refresh.to_string(),
        expires_at: now_secs() + lifetime,
    })
}

fn save_tokens(conn: &Connection, tokens: &Tokens) -> Result<(), String> {
    store(conn, ACCESS_KEY, &tokens.access)?;
    store(conn, REFRESH_KEY, &tokens.refresh)?;
    store(conn, EXPIRES_KEY, &tokens.expires_at.to_string())?;
    clear(conn, RECONNECT_KEY).map_err(to_string_err)
}

fn read_tokens(conn: &Connection) -> Option<Tokens> {
    Some(Tokens {
        access: setting(conn, ACCESS_KEY)?,
        refresh: setting(conn, REFRESH_KEY)?,
        expires_at: setting(conn, EXPIRES_KEY)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
    })
}

fn due_for_refresh(tokens: &Tokens, now: i64) -> bool {
    tokens.expires_at - now < REFRESH_MARGIN_SECS
}

/// How a refresh ended.
enum Refreshed {
    Tokens(Tokens),
    /// SIMKL no longer accepts the refresh token: revoked, or six months unused.
    Refused,
    /// SIMKL could not be asked. Try again later.
    Unreachable,
}

async fn refresh(client_id: &str, refresh_token: &str) -> Refreshed {
    let Some(http) = http() else { return Refreshed::Unreachable };
    let sent = http
        .post(url("/oauth2/token", client_id))
        .header("User-Agent", user_agent())
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await;
    let response = match sent {
        Ok(r) => r,
        Err(e) => {
            crate::log!("simkl: could not refresh the token: {e}");
            return Refreshed::Unreachable;
        }
    };
    let status = response.status().as_u16();
    let body: Value = response
        .text()
        .await
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    match status {
        200 => match parse_tokens(&body, Some(refresh_token)) {
            Ok(tokens) => Refreshed::Tokens(tokens),
            Err(e) => {
                crate::log!("simkl: refresh answered, but {e}");
                Refreshed::Refused
            }
        },
        400 | 401 => {
            crate::log!("simkl: SIMKL refused the refresh token ({status} {body})");
            Refreshed::Refused
        }
        _ => {
            crate::log!("simkl: refresh returned {status} {body}");
            Refreshed::Unreachable
        }
    }
}

// ---- sending ------------------------------------------------------------------

/// Only one send at a time, and only one waiting to start.
static SENDING: AtomicBool = AtomicBool::new(false);
static SEND_SCHEDULED: AtomicBool = AtomicBool::new(false);

/// Send what is waiting, a little later — see [`SEND_DELAY`].
pub fn send_soon(app: &tauri::AppHandle) {
    if !allowed() || SEND_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(SEND_DELAY).await;
        SEND_SCHEDULED.store(false, Ordering::SeqCst);
        send_waiting(&app).await;
    });
}

async fn tokio_sleep(d: Duration) {
    tokio::time::sleep(d).await;
}

enum Sent {
    Accepted(Value),
    /// The access token is not accepted.
    Unauthorised,
    /// Try again later: SIMKL is busy, down or out of reach.
    Later(String),
    /// SIMKL refused the request itself. Retrying the same bytes will not help.
    Rejected(String),
}

async fn post_history(client_id: &str, access: &str, body: &Value) -> Sent {
    let Some(http) = http() else { return Sent::Later("no HTTP client".into()) };
    let sent = http
        .post(url("/sync/history", client_id))
        .header("User-Agent", user_agent())
        .header("Authorization", format!("Bearer {access}"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await;
    let response = match sent {
        Ok(r) => r,
        Err(e) => return Sent::Later(e.to_string()),
    };
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    match status {
        200 | 201 => Sent::Accepted(serde_json::from_str(&text).unwrap_or(Value::Null)),
        401 => Sent::Unauthorised,
        429 | 500..=599 => Sent::Later(format!("{status} {text}")),
        _ => Sent::Rejected(format!("{status} {text}")),
    }
}

/// Send everything waiting, batch by batch, until the queue is empty or SIMKL
/// cannot be reached. Every failure is logged and leaves the queue as it was,
/// except a request SIMKL rejects outright, which would be rejected again.
pub async fn send_waiting(app: &tauri::AppHandle) {
    if !allowed() || SENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let result = send_all(app).await;
    SENDING.store(false, Ordering::SeqCst);
    if let Err(e) = result {
        crate::log!("simkl: {e}");
    }
}

async fn send_all(app: &tauri::AppHandle) -> Result<(), String> {
    let mut first = true;
    loop {
        let (client_id, tokens, batch) = {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            if !connected(&conn) {
                return Ok(());
            }
            let Some(client_id) = client_id(&conn) else { return Ok(()) };
            let Some(tokens) = read_tokens(&conn) else { return Ok(()) };
            let batch = waiting(&conn, BATCH).map_err(to_string_err)?;
            (client_id, tokens, batch)
        };
        if batch.is_empty() {
            return Ok(());
        }
        if !first {
            tokio_sleep(WRITE_GAP).await;
        }
        first = false;

        let Some(access) = usable_access(app, &client_id, tokens).await? else {
            return Ok(());
        };
        let body = history_body(&batch);
        let mut outcome = post_history(&client_id, &access, &body).await;

        // A 401 most often means the token ran out early — or another Kinema
        // on this library (a development build beside the release) refreshed
        // it, which replaces it. So first see whether the stored token has
        // changed, and only refresh if it has not: refreshing on top of the
        // other process would cut that one off in turn.
        if matches!(outcome, Sent::Unauthorised) {
            let stored = {
                let db = app.state::<Db>();
                let conn = db.0.lock().map_err(to_string_err)?;
                read_tokens(&conn)
            };
            let retry_with = match stored {
                Some(t) if t.access != access => Some(t.access),
                Some(t) => {
                    let forced = Tokens { expires_at: 0, ..t };
                    usable_access(app, &client_id, forced).await?
                }
                None => None,
            };
            let Some(retry_with) = retry_with else { return Ok(()) };
            tokio_sleep(WRITE_GAP).await;
            outcome = post_history(&client_id, &retry_with, &body).await;
        }

        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        match outcome {
            Sent::Accepted(response) => {
                if let Some(missing) = not_found_summary(&response) {
                    crate::log!("simkl: {missing}");
                }
                forget_sent(&conn, &batch).map_err(to_string_err)?;
                store(&conn, LAST_SENT_KEY, &now_secs().to_string())?;
                crate::log!("simkl: sent {} watched item(s)", batch.len());
            }
            Sent::Unauthorised => {
                mark_needs_reconnect(&conn, "the access token was refused twice")?;
                return Ok(());
            }
            Sent::Later(why) => {
                return Err(format!("could not send {} item(s), kept for later: {why}", batch.len()));
            }
            Sent::Rejected(why) => {
                // Logged whole, with what was sent, so the reason can be read
                // and fixed; the rows go, or the same refusal would block
                // everything queued behind them for good.
                crate::log!("simkl: SIMKL rejected a batch ({why}); it was {body}");
                forget_sent(&conn, &batch).map_err(to_string_err)?;
            }
        }
    }
}

fn mark_needs_reconnect(conn: &Connection, why: &str) -> Result<(), String> {
    crate::log!("simkl: needs connecting again — {why}; watched items stay queued");
    store(conn, RECONNECT_KEY, "1")
}

/// An access token worth sending: the stored one, or a fresh one when it is
/// due. `None` when SIMKL is out of reach or the person must connect again.
async fn usable_access(
    app: &tauri::AppHandle,
    client_id: &str,
    tokens: Tokens,
) -> Result<Option<String>, String> {
    if !due_for_refresh(&tokens, now_secs()) {
        return Ok(Some(tokens.access));
    }
    match refresh(client_id, &tokens.refresh).await {
        Refreshed::Tokens(fresh) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            save_tokens(&conn, &fresh)?;
            Ok(Some(fresh.access))
        }
        Refreshed::Refused => {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            mark_needs_reconnect(&conn, "SIMKL refused the refresh token")?;
            Ok(None)
        }
        Refreshed::Unreachable => Ok(None),
    }
}

// ---- connecting ---------------------------------------------------------------

/// A sign-in in progress. The device code is the credential Kinema polls with,
/// so it stays here and never reaches the page (SIMKL: "never display it").
struct Pending {
    client_id: String,
    device_code: String,
    interval: Duration,
    next_poll: Instant,
    expires: Instant,
}

#[derive(Default)]
pub struct SimklState(Mutex<Option<Pending>>);

/// What the page shows while waiting for approval.
#[derive(Serialize)]
pub struct DeviceCode {
    /// `XXXX-YYYY`, shown exactly as SIMKL gave it.
    pub user_code: String,
    /// `https://simkl.com/pin`, for typing the code by hand.
    pub verification_uri: String,
    /// The same page with the code filled in — what the QR code holds.
    pub verification_uri_complete: String,
    pub expires_in: i64,
    /// The QR code as an SVG, to scan with a phone from the sofa.
    pub qr_svg: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PollOutcome {
    /// Not approved yet. Ask again later.
    Waiting,
    Connected,
    /// The code ran out. Start again.
    Expired,
    /// SIMKL does not accept this app ID — a configuration problem, not
    /// something waiting will fix.
    Refused,
    /// Anything else, including being offline. Worth trying again.
    Failed,
}

#[derive(Serialize)]
pub struct Status {
    /// There is an app ID, so connecting is possible at all.
    pub available: bool,
    pub connected: bool,
    pub needs_reconnect: bool,
    pub user: Option<String>,
    /// Finished items not yet accepted by SIMKL.
    pub waiting: i64,
    pub last_sent_at: Option<i64>,
}

#[tauri::command]
pub fn simkl_status(db: tauri::State<Db>) -> Result<Status, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    Ok(Status {
        available: allowed() && client_id(&conn).is_some(),
        connected: connected(&conn),
        needs_reconnect: setting(&conn, RECONNECT_KEY).is_some(),
        user: setting(&conn, USER_KEY),
        waiting: waiting_count(&conn),
        last_sent_at: setting(&conn, LAST_SENT_KEY).and_then(|s| s.parse().ok()),
    })
}

fn qr_svg(text: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    Some(
        code.render::<svg::Color>()
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
    )
}

/// Parse SIMKL's answer to the first step of signing in.
fn parse_device(body: &Value) -> Option<(String, DeviceCode, u64)> {
    let text = |k: &str| body.get(k).and_then(Value::as_str).map(String::from);
    let device_code = text("device_code")?;
    let user_code = text("user_code")?;
    let verification_uri = text("verification_uri").unwrap_or_else(|| "https://simkl.com/pin".into());
    let complete = text("verification_uri_complete")
        .unwrap_or_else(|| format!("{verification_uri}?user_code={user_code}"));
    let expires_in = body.get("expires_in").and_then(Value::as_i64).unwrap_or(900);
    let interval = body.get("interval").and_then(Value::as_u64).unwrap_or(5).max(1);
    Some((
        device_code,
        DeviceCode {
            qr_svg: qr_svg(&complete),
            user_code,
            verification_uri,
            verification_uri_complete: complete,
            expires_in,
        },
        interval,
    ))
}

#[tauri::command]
pub async fn simkl_start_connect(app: tauri::AppHandle) -> Result<DeviceCode, String> {
    if !allowed() {
        return Err("SIMKL is not used during a self-test".into());
    }
    let client_id = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        client_id(&conn).ok_or("This copy of Kinema has no SIMKL app ID.")?
    };
    let http = http().ok_or("could not start a web request")?;
    let response = http
        .post(url("/oauth2/device", &client_id))
        .header("User-Agent", user_agent())
        .form(&[("client_id", client_id.as_str()), ("scope", "media:read media:write")])
        .send()
        .await
        .map_err(|e| format!("SIMKL could not be reached: {e}"))?;
    let status = response.status().as_u16();
    let body: Value = serde_json::from_str(&response.text().await.unwrap_or_default())
        .unwrap_or(Value::Null);
    if status == 401 {
        crate::log!("simkl: SIMKL does not accept this app ID: {body}");
        return Err("SIMKL does not recognise this copy of Kinema's app ID.".into());
    }
    let Some((device_code, shown, interval)) = parse_device(&body) else {
        crate::log!("simkl: unexpected answer to the sign-in request ({status}): {body}");
        return Err("SIMKL gave an answer Kinema does not understand.".into());
    };
    let now = Instant::now();
    let state = app.state::<SimklState>();
    *state.0.lock().map_err(to_string_err)? = Some(Pending {
        client_id,
        device_code,
        interval: Duration::from_secs(interval),
        next_poll: now + Duration::from_secs(interval),
        expires: now + Duration::from_secs(shown.expires_in.max(1) as u64),
    });
    Ok(shown)
}

#[tauri::command]
pub fn simkl_cancel_connect(state: tauri::State<SimklState>) -> Result<(), String> {
    *state.0.lock().map_err(to_string_err)? = None;
    Ok(())
}

/// Ask once whether the person has approved.
///
/// The page calls this on a timer; this side decides whether it is actually
/// time to ask SIMKL. A poll that comes too early is answered `Waiting` without
/// asking, because SIMKL counts a too-early poll against the next one and a
/// client that keeps doing it can lock itself out until the code expires.
#[tauri::command]
pub async fn simkl_poll_connect(app: tauri::AppHandle) -> Result<PollOutcome, String> {
    let (client_id, device_code) = {
        let state = app.state::<SimklState>();
        let guard = state.0.lock().map_err(to_string_err)?;
        let Some(pending) = guard.as_ref() else { return Ok(PollOutcome::Expired) };
        let now = Instant::now();
        if now >= pending.expires {
            return Ok(PollOutcome::Expired);
        }
        if now < pending.next_poll {
            return Ok(PollOutcome::Waiting);
        }
        (pending.client_id.clone(), pending.device_code.clone())
    };

    let http = http().ok_or("could not start a web request")?;
    let sent = http
        .post(url("/oauth2/token", &client_id))
        .header("User-Agent", user_agent())
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", client_id.as_str()),
            ("device_code", device_code.as_str()),
        ])
        .send()
        .await;

    // Whatever happens next, the next poll waits a full interval from now:
    // the attempt itself resets SIMKL's timer.
    let set_next = |extra: Duration| -> Result<(), String> {
        let state = app.state::<SimklState>();
        let mut guard = state.0.lock().map_err(to_string_err)?;
        if let Some(p) = guard.as_mut() {
            p.interval += extra;
            p.next_poll = Instant::now() + p.interval;
        }
        Ok(())
    };

    let response = match sent {
        Ok(r) => r,
        Err(e) => {
            crate::log!("simkl: sign-in poll failed: {e}");
            set_next(Duration::ZERO)?;
            return Ok(PollOutcome::Failed);
        }
    };
    let status = response.status().as_u16();
    let body: Value = serde_json::from_str(&response.text().await.unwrap_or_default())
        .unwrap_or(Value::Null);

    if status == 200 {
        let tokens = match parse_tokens(&body, None) {
            Ok(t) => t,
            Err(e) => {
                crate::log!("simkl: {e}");
                *app.state::<SimklState>().0.lock().map_err(to_string_err)? = None;
                return Ok(PollOutcome::Failed);
            }
        };
        *app.state::<SimklState>().0.lock().map_err(to_string_err)? = None;
        let user = account_name(&client_id, &tokens.access).await;
        {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            save_tokens(&conn, &tokens)?;
            match &user {
                Some(name) => store(&conn, USER_KEY, name)?,
                None => clear(&conn, USER_KEY).map_err(to_string_err)?,
            }
            // Everything already watched, once — decided 2026-09-30. SIMKL
            // ignores a watch it already has, so connecting again is harmless.
            let queued = queue_history(&conn).map_err(to_string_err)?;
            crate::log!("simkl: connected; {queued} already-watched item(s) queued");
        }
        send_soon(&app);
        return Ok(PollOutcome::Connected);
    }

    let error = body.get("error").and_then(Value::as_str).unwrap_or("");
    Ok(match (status, error) {
        (400, "authorization_pending") => {
            set_next(Duration::ZERO)?;
            PollOutcome::Waiting
        }
        (400, "slow_down") => {
            // SIMKL's rule: add five seconds, and actually wait them.
            set_next(Duration::from_secs(5))?;
            PollOutcome::Waiting
        }
        (400, "expired_token") => {
            *app.state::<SimklState>().0.lock().map_err(to_string_err)? = None;
            PollOutcome::Expired
        }
        (401, _) => {
            crate::log!("simkl: SIMKL does not accept this app ID: {body}");
            *app.state::<SimklState>().0.lock().map_err(to_string_err)? = None;
            PollOutcome::Refused
        }
        _ => {
            crate::log!("simkl: sign-in poll returned {status} {body}");
            set_next(Duration::ZERO)?;
            PollOutcome::Failed
        }
    })
}

/// The account's name, to say who Kinema is connected as. Asked once, at
/// connect; without it the page just says "Connected".
async fn account_name(client_id: &str, access: &str) -> Option<String> {
    let response = http()?
        .get(url("/users/settings", client_id))
        .header("User-Agent", user_agent())
        .header("Authorization", format!("Bearer {access}"))
        .send()
        .await
        .ok()?;
    let body: Value = serde_json::from_str(&response.text().await.ok()?).ok()?;
    body.pointer("/user/name")
        .and_then(Value::as_str)
        .map(String::from)
}

/// Disconnect: tell SIMKL to end this sign-in, and forget it here.
///
/// SIMKL answers a revoke with 200 whatever happened, so there is nothing to
/// check; the tokens are forgotten here either way. What was waiting to be
/// sent goes too — it was to be sent to the account being disconnected.
#[tauri::command]
pub async fn simkl_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    let (client_id, refresh_token) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        (client_id(&conn), setting(&conn, REFRESH_KEY))
    };
    if let (Some(client_id), Some(token), Some(http)) = (client_id, refresh_token, http()) {
        if allowed() {
            let revoked = http
                .post(url("/oauth2/revoke", &client_id))
                .header("User-Agent", user_agent())
                .form(&[("client_id", client_id.as_str()), ("token", token.as_str())])
                .send()
                .await;
            if let Err(e) = revoked {
                crate::log!("simkl: could not reach SIMKL to end the sign-in: {e}");
            }
        }
    }
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(to_string_err)?;
    for key in [ACCESS_KEY, REFRESH_KEY, EXPIRES_KEY, USER_KEY, RECONNECT_KEY, LAST_SENT_KEY] {
        clear(&conn, key).map_err(to_string_err)?;
    }
    conn.execute("DELETE FROM simkl_outbox", []).map_err(to_string_err)?;
    crate::log!("simkl: disconnected");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn
    }

    fn connect(conn: &Connection) {
        save_tokens(
            conn,
            &Tokens {
                access: "a".into(),
                refresh: "r".into(),
                expires_at: now_secs() + 7 * 86_400,
            },
        )
        .unwrap();
    }

    #[test]
    fn nothing_is_queued_while_disconnected() {
        let conn = db();
        assert!(!queue_finished(&conn, "movie", Some("tt0000001"), None, None, None, 1).unwrap());
        assert_eq!(waiting_count(&conn), 0);
    }

    #[test]
    fn a_finished_film_and_episode_are_queued_once_each() {
        let conn = db();
        connect(&conn);
        assert!(queue_finished(&conn, "movie", Some("tt0000001"), Some("11"), None, None, 5).unwrap());
        assert!(queue_finished(&conn, "series", None, Some("105"), Some(1), Some(2), 6).unwrap());
        // Finished again before it went: still one watch, the first time kept.
        assert!(!queue_finished(&conn, "series", None, Some("105"), Some(1), Some(2), 9).unwrap());
        let rows = waiting(&conn, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].watched_at, 6);
    }

    /// SIMKL finds titles by id; without one there is nothing it could act on.
    #[test]
    fn a_title_with_no_ids_or_an_episode_with_no_numbers_is_not_queued() {
        let conn = db();
        connect(&conn);
        assert!(!queue_finished(&conn, "movie", None, Some("  "), None, None, 1).unwrap());
        assert!(!queue_finished(&conn, "series", Some("tt0000002"), None, Some(1), None, 1).unwrap());
    }

    /// A refused refresh token means connecting again; until then nothing
    /// new is queued, but what was queued stays.
    #[test]
    fn needing_to_reconnect_stops_new_items_and_keeps_old_ones() {
        let conn = db();
        connect(&conn);
        queue_finished(&conn, "movie", Some("tt0000001"), None, None, None, 1).unwrap();
        mark_needs_reconnect(&conn, "test").unwrap();
        assert!(!connected(&conn));
        assert!(!queue_finished(&conn, "movie", Some("tt0000003"), None, None, None, 1).unwrap());
        assert_eq!(waiting_count(&conn), 1);
        // Connecting again clears it.
        connect(&conn);
        assert!(connected(&conn));
    }

    #[test]
    fn the_body_groups_episodes_under_their_show_and_season() {
        let row = |id, film: bool, tmdb: &str, s: Option<i64>, e: Option<i64>| Waiting {
            id,
            is_film: film,
            imdb_id: None,
            tmdb_id: Some(tmdb.into()),
            season: s,
            episode: e,
            watched_at: 1_790_000_000,
        };
        let body = history_body(&[
            row(1, false, "105", Some(1), Some(1)),
            row(2, true, "11", None, None),
            row(3, false, "105", Some(1), Some(2)),
            row(4, false, "105", Some(2), Some(1)),
            row(5, false, "200", Some(1), Some(1)),
        ]);
        assert_eq!(body["movies"].as_array().unwrap().len(), 1);
        assert_eq!(body["movies"][0]["ids"]["tmdb"], "11");
        let shows = body["shows"].as_array().unwrap();
        assert_eq!(shows.len(), 2);
        assert_eq!(shows[0]["ids"]["tmdb"], "105");
        assert_eq!(shows[0]["use_tvdb_anime_seasons"], true);
        let seasons = shows[0]["seasons"].as_array().unwrap();
        assert_eq!(seasons.len(), 2);
        assert_eq!(seasons[0]["number"], 1);
        assert_eq!(seasons[0]["episodes"].as_array().unwrap().len(), 2);
        assert_eq!(seasons[0]["episodes"][1]["number"], 2);
        assert_eq!(seasons[0]["episodes"][1]["watched_at"], "2026-09-21T14:13:20Z");
    }

    #[test]
    fn times_are_written_as_iso_8601() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601(1_790_000_000), "2026-09-21T14:13:20Z");
        assert_eq!(iso8601(4_107_542_399), "2100-02-28T23:59:59Z");
    }

    /// Everything already watched is queued at connect; anything unfinished
    /// is not.
    #[test]
    fn connecting_queues_what_was_already_watched() {
        let conn = db();
        let insert = |kind: &str, tmdb: &str, s: Option<i64>, e: Option<i64>, done: bool| {
            conn.execute(
                "INSERT INTO watch_history
                    (kind, provider, provider_id, imdb_id, tmdb_id, season, episode, label,
                     position_secs, completed, updated_at)
                 VALUES (?1, 'tmdb', ?2, NULL, ?2, ?3, ?4, 'x', 0, ?5, 100)",
                params![kind, tmdb, s, e, done as i64],
            )
            .unwrap();
        };
        insert("movie", "11", None, None, true);
        insert("series", "105", Some(1), Some(1), true);
        insert("series", "105", Some(1), Some(2), false);
        assert_eq!(queue_history(&conn).unwrap(), 2);
    }

    #[test]
    fn a_token_answer_without_the_right_to_write_is_refused() {
        let ok = json!({"access_token": "a", "refresh_token": "r", "expires_in": 604800,
                        "scope": "media:read media:write"});
        assert!(parse_tokens(&ok, None).is_ok());
        let read_only = json!({"access_token": "a", "refresh_token": "r", "scope": "media:read"});
        assert!(parse_tokens(&read_only, None).is_err());
    }

    /// Refreshing gives the same refresh token back, or none; ours is kept.
    #[test]
    fn a_refresh_without_a_refresh_token_keeps_the_old_one() {
        let body = json!({"access_token": "new", "scope": "media:read media:write"});
        let tokens = parse_tokens(&body, Some("old-refresh")).unwrap();
        assert_eq!(tokens.refresh, "old-refresh");
        assert_eq!(tokens.access, "new");
    }

    #[test]
    fn a_token_is_refreshed_a_day_before_it_runs_out() {
        let t = |expires_at| Tokens { access: "a".into(), refresh: "r".into(), expires_at };
        assert!(!due_for_refresh(&t(1_000_000 + 2 * 86_400), 1_000_000));
        assert!(due_for_refresh(&t(1_000_000 + 3_600), 1_000_000));
        assert!(due_for_refresh(&t(0), 1_000_000));
    }

    #[test]
    fn the_sign_in_answer_is_read_and_a_qr_code_made() {
        let body = json!({"device_code": "dc", "user_code": "BDWP-HQPK",
                          "verification_uri": "https://simkl.com/pin",
                          "verification_uri_complete": "https://simkl.com/pin?user_code=BDWP-HQPK",
                          "expires_in": 900, "interval": 5});
        let (device_code, shown, interval) = parse_device(&body).unwrap();
        assert_eq!(device_code, "dc");
        assert_eq!(shown.user_code, "BDWP-HQPK");
        assert_eq!(interval, 5);
        assert!(shown.qr_svg.unwrap().starts_with("<?xml"));
    }

    #[test]
    fn not_found_items_are_summarised_and_an_empty_list_is_not() {
        let none = json!({"added": {"movies": 1}, "not_found": {"movies": [], "shows": [], "episodes": []}});
        assert_eq!(not_found_summary(&none), None);
        let some = json!({"not_found": {"movies": [{"ids": {"tmdb": "1"}}], "shows": [], "episodes": []}});
        assert!(not_found_summary(&some).unwrap().starts_with("1 film(s)"));
    }

    #[test]
    fn urls_carry_the_app_id_name_and_version() {
        let u = url("/sync/history", "abc 123");
        assert!(u.starts_with("https://api.simkl.com/sync/history?client_id=abc%20123&app-name=kinema&app-version="));
    }
}
