//! Trakt — telling the user's Trakt account what they finished watching.
//!
//! **The same promises as SIMKL** (`simkl.rs`), decided for both on
//! 2026-09-30: one way, only additions, what was already watched sent once at
//! connect, no live "Watching now". Finished items wait in the shared queue
//! (`tracking.rs`) until Trakt has them.
//!
//! **Where Trakt differs from SIMKL, and what that changes:**
//!
//! - **Trakt keeps every play it is sent.** Its documentation: "We don't
//!   verify the item + watched_at to ensure it's unique, it is up to your app
//!   to verify this and not send duplicate plays." SIMKL ignores a repeat; Trakt
//!   would show a rewatch. So the history sent at connect is only what Trakt
//!   does not already have — Kinema asks for the account's watched films and
//!   episodes first, and sends the difference. That is done by the sender, not
//!   at the moment of connecting, so being offline then only delays it.
//! - **Refresh tokens are single-use.** Each refresh returns a new refresh
//!   token and ends the old one, so the new pair is stored before anything
//!   else happens. A refresh refused because another Kinema on the same library
//!   refreshed first is recognised by the stored token having changed.
//! - **The device sign-in needs the app's client secret**, by Trakt's
//!   documentation. A desktop program cannot keep a secret; like the TMDB key,
//!   it is built into releases from a repository secret, and is readable by
//!   anyone holding the app.
//! - **Trakt says so when someone declines** (`418`), where SIMKL cannot.
//! - **A free Trakt account may connect only one outside app** (since July
//!   2026). Settings says so; the refusal itself happens on Trakt's page.
//!
//! **A self-test never talks to Trakt**, for the same reason as SIMKL: its
//! copy of the library carries the tokens.

use crate::library::Db;
use crate::settings::setting;
use crate::tracking::{self, iso8601, qr_svg, DeviceCode, PollOutcome, Status, Waiting, TRAKT};
use crate::util::{now_secs, to_string_err};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// Kinema's Trakt app, set when a release is built (repository secrets, like
/// the TMDB key). A build without them has no Trakt unless an app is entered
/// by hand under Developer tools ([`CLIENT_ID_KEY`], [`CLIENT_SECRET_KEY`]).
const BUILTIN_CLIENT_ID: Option<&str> = option_env!("KINEMA_TRAKT_CLIENT_ID");
const BUILTIN_CLIENT_SECRET: Option<&str> = option_env!("KINEMA_TRAKT_CLIENT_SECRET");

pub const CLIENT_ID_KEY: &str = "trakt_client_id";
pub const CLIENT_SECRET_KEY: &str = "trakt_client_secret";

const ACCESS_KEY: &str = "trakt_access_token";
const REFRESH_KEY: &str = "trakt_refresh_token";
const EXPIRES_KEY: &str = "trakt_access_expires_at";
const USER_KEY: &str = "trakt_user";
const RECONNECT_KEY: &str = "trakt_needs_reconnect";
const LAST_SENT_KEY: &str = "trakt_last_sent_at";
/// Set at connect: the history is still to be compared with Trakt's and sent.
const HISTORY_DUE_KEY: &str = "trakt_history_due";

const API: &str = "https://api.trakt.tv";
/// What the QR code opens, per Trakt's documentation: its own activation page.
const ACTIVATE_URL: &str = "https://auth.trakt.tv/activate";
/// The redirect URI registered for an app that signs in on a device.
const DEVICE_REDIRECT: &str = "urn:ietf:wg:oauth:2.0:oob";

/// The most items in one request, as for SIMKL.
const BATCH: usize = 100;
const SEND_DELAY: Duration = Duration::from_secs(10);
/// Trakt allows one write a second per user.
const WRITE_GAP: Duration = Duration::from_millis(1500);
const REFRESH_MARGIN_SECS: i64 = 24 * 60 * 60;
const TIMEOUT: Duration = Duration::from_secs(20);

fn user_agent() -> String {
    format!("kinema/{}", env!("CARGO_PKG_VERSION"))
}

fn nonblank(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// The app in effect: one entered by hand wins over the built-in one, and the
/// two halves always come from the same place.
fn app(conn: &Connection) -> Option<(String, String)> {
    if let (Some(id), Some(secret)) = (setting(conn, CLIENT_ID_KEY), setting(conn, CLIENT_SECRET_KEY)) {
        return Some((id.trim().to_string(), secret.trim().to_string()));
    }
    Some((nonblank(BUILTIN_CLIENT_ID)?, nonblank(BUILTIN_CLIENT_SECRET)?))
}

fn allowed() -> bool {
    crate::selftest::plan_path().is_none()
}

pub(crate) fn connected(conn: &Connection) -> bool {
    setting(conn, REFRESH_KEY).is_some() && setting(conn, RECONNECT_KEY).is_none()
}

fn store(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    crate::settings::store(conn, key, value)
}

fn clear(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])
        .map(|_| ())
        .map_err(to_string_err)
}

fn http() -> Option<tauri_plugin_http::reqwest::Client> {
    tauri_plugin_http::reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .ok()
}

/// A request with the headers Trakt requires on every call.
fn request(
    http: &tauri_plugin_http::reqwest::Client,
    method: tauri_plugin_http::reqwest::Method,
    path: &str,
    client_id: &str,
    access: Option<&str>,
) -> tauri_plugin_http::reqwest::RequestBuilder {
    let mut r = http
        .request(method, format!("{API}{path}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", user_agent())
        .header("trakt-api-key", client_id)
        .header("trakt-api-version", "2");
    if let Some(token) = access {
        r = r.header("Authorization", format!("Bearer {token}"));
    }
    r
}

async fn post(client_id: &str, path: &str, access: Option<&str>, body: &Value) -> Result<(u16, Value), String> {
    let http = http().ok_or("could not start a web request")?;
    let response = request(&http, tauri_plugin_http::reqwest::Method::POST, path, client_id, access)
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

async fn get(client_id: &str, path: &str, access: &str) -> Result<(u16, Value), String> {
    let http = http().ok_or("could not start a web request")?;
    let response = request(&http, tauri_plugin_http::reqwest::Method::GET, path, client_id, Some(access))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

// ---- tokens -------------------------------------------------------------------

#[derive(Debug, PartialEq, Clone)]
struct Tokens {
    access: String,
    refresh: String,
    expires_at: i64,
}

/// Read a token answer. Both tokens must be there: Trakt's refresh tokens are
/// single-use, so a missing new one would leave nothing to refresh with.
fn parse_tokens(body: &Value) -> Result<Tokens, String> {
    let text = |k: &str| body.get(k).and_then(Value::as_str).map(String::from);
    let access = text("access_token").ok_or("no access token in Trakt's answer")?;
    let refresh = text("refresh_token").ok_or("no refresh token in Trakt's answer")?;
    let lifetime = body.get("expires_in").and_then(Value::as_i64).unwrap_or(7 * 86_400);
    Ok(Tokens {
        access,
        refresh,
        expires_at: now_secs() + lifetime,
    })
}

fn save_tokens(conn: &Connection, tokens: &Tokens) -> Result<(), String> {
    store(conn, ACCESS_KEY, &tokens.access)?;
    store(conn, REFRESH_KEY, &tokens.refresh)?;
    store(conn, EXPIRES_KEY, &tokens.expires_at.to_string())?;
    clear(conn, RECONNECT_KEY)
}

fn read_tokens(conn: &Connection) -> Option<Tokens> {
    Some(Tokens {
        access: setting(conn, ACCESS_KEY)?,
        refresh: setting(conn, REFRESH_KEY)?,
        expires_at: setting(conn, EXPIRES_KEY).and_then(|s| s.parse().ok()).unwrap_or(0),
    })
}

fn mark_needs_reconnect(conn: &Connection, why: &str) -> Result<(), String> {
    crate::log!("trakt: needs connecting again — {why}; watched items stay queued");
    store(conn, RECONNECT_KEY, "1")
}

/// An access token worth sending: the stored one, or a fresh one when it is
/// due. `None` when Trakt is out of reach or the person must connect again.
async fn usable_access(
    app: &tauri::AppHandle,
    (client_id, secret): &(String, String),
    tokens: Tokens,
) -> Result<Option<String>, String> {
    if tokens.expires_at - now_secs() >= REFRESH_MARGIN_SECS {
        return Ok(Some(tokens.access));
    }
    let answer = post(
        client_id,
        "/oauth/token",
        None,
        &json!({
            "refresh_token": tokens.refresh,
            "client_id": client_id,
            "client_secret": secret,
            "redirect_uri": DEVICE_REDIRECT,
            "grant_type": "refresh_token",
        }),
    )
    .await;

    let db = app.state::<Db>();
    match answer {
        Ok((200, body)) => match parse_tokens(&body) {
            Ok(fresh) => {
                let conn = db.0.lock().map_err(to_string_err)?;
                // Stored at once: the refresh token just used is dead.
                save_tokens(&conn, &fresh)?;
                Ok(Some(fresh.access))
            }
            Err(e) => {
                crate::log!("trakt: refresh answered, but {e}");
                Ok(None)
            }
        },
        Ok((400 | 401, body)) => {
            let conn = db.0.lock().map_err(to_string_err)?;
            // Another Kinema on this library may have refreshed first, which
            // ends the token this one used. Then the stored pair is newer.
            match read_tokens(&conn) {
                Some(stored) if stored.refresh != tokens.refresh => Ok(Some(stored.access)),
                _ => {
                    crate::log!("trakt: Trakt refused the refresh token: {body}");
                    mark_needs_reconnect(&conn, "Trakt refused the refresh token")?;
                    Ok(None)
                }
            }
        }
        Ok((status, body)) => {
            crate::log!("trakt: refresh returned {status} {body}");
            Ok(None)
        }
        Err(e) => {
            crate::log!("trakt: could not refresh the token: {e}");
            Ok(None)
        }
    }
}

// ---- what to send ---------------------------------------------------------------

/// Trakt's ids: IMDb as text, TMDB as a number.
fn ids(imdb_id: &Option<String>, tmdb_id: &Option<String>) -> Value {
    let mut ids = serde_json::Map::new();
    if let Some(imdb) = imdb_id {
        ids.insert("imdb".into(), json!(imdb));
    }
    if let Some(tmdb) = tmdb_id.as_deref().and_then(|t| t.trim().parse::<i64>().ok()) {
        ids.insert("tmdb".into(), json!(tmdb));
    }
    Value::Object(ids)
}

type ShowIds = (Option<String>, Option<String>);
type Season = (i64, Vec<Value>);

/// The body for `POST /sync/history`: films as they are, episodes gathered
/// under their show and season, each with when it was watched.
fn history_body(rows: &[Waiting]) -> Value {
    let mut movies = Vec::new();
    let mut shows: Vec<(ShowIds, Vec<Season>)> = Vec::new();
    for row in rows {
        if row.is_film {
            movies.push(json!({
                "ids": ids(&row.imdb_id, &row.tmdb_id),
                "watched_at": iso8601(row.watched_at),
            }));
            continue;
        }
        let (Some(season), Some(episode)) = (row.season, row.episode) else { continue };
        let show_key = (row.imdb_id.clone(), row.tmdb_id.clone());
        let at = match shows.iter().position(|(k, _)| *k == show_key) {
            Some(i) => i,
            None => {
                shows.push((show_key, Vec::new()));
                shows.len() - 1
            }
        };
        let entry = json!({ "number": episode, "watched_at": iso8601(row.watched_at) });
        match shows[at].1.iter_mut().find(|(n, _)| *n == season) {
            Some((_, episodes)) => episodes.push(entry),
            None => shows[at].1.push((season, vec![entry])),
        }
    }
    let shows: Vec<Value> = shows
        .into_iter()
        .map(|((imdb, tmdb), seasons)| {
            json!({
                "ids": ids(&imdb, &tmdb),
                "seasons": seasons
                    .into_iter()
                    .map(|(number, episodes)| json!({ "number": number, "episodes": episodes }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({ "movies": movies, "shows": shows })
}

/// What Trakt could not place, as a line for the log. Not retried — it would
/// not know them next time either.
fn not_found_summary(response: &Value) -> Option<String> {
    let nf = response.get("not_found")?;
    let count = |k: &str| nf.get(k).and_then(Value::as_array).map_or(0, Vec::len);
    let total = count("movies") + count("shows") + count("seasons") + count("episodes");
    (total > 0).then(|| format!("{total} item(s) not found: {nf}"))
}

/// What the account has already watched, as keys comparable with Kinema's
/// own: `movie|imdb|tmdb` and `episode|imdb|tmdb|season|episode`, one for each
/// id Trakt knows, so a match on either id counts.
fn already_watched(movies: &Value, shows: &Value) -> HashSet<String> {
    let mut seen = HashSet::new();
    let id_forms = |ids: &Value| -> Vec<String> {
        let mut forms = Vec::new();
        if let Some(imdb) = ids.get("imdb").and_then(Value::as_str) {
            forms.push(format!("imdb:{imdb}"));
        }
        if let Some(tmdb) = ids.get("tmdb").and_then(Value::as_i64) {
            forms.push(format!("tmdb:{tmdb}"));
        }
        forms
    };
    for m in movies.as_array().into_iter().flatten() {
        for id in id_forms(&m["movie"]["ids"]) {
            seen.insert(format!("movie|{id}"));
        }
    }
    for s in shows.as_array().into_iter().flatten() {
        let show_ids = id_forms(&s["show"]["ids"]);
        for season in s["seasons"].as_array().into_iter().flatten() {
            let Some(sn) = season["number"].as_i64() else { continue };
            for ep in season["episodes"].as_array().into_iter().flatten() {
                let Some(en) = ep["number"].as_i64() else { continue };
                for id in &show_ids {
                    seen.insert(format!("episode|{id}|{sn}|{en}"));
                }
            }
        }
    }
    seen
}

/// Whether Trakt already has this — by either id.
fn has(seen: &HashSet<String>, f: &tracking::Finished) -> bool {
    let is_film = f.kind == "movie";
    let mut forms = Vec::new();
    if let Some(imdb) = f.imdb_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        forms.push(format!("imdb:{imdb}"));
    }
    if let Some(tmdb) = f.tmdb_id.as_deref().and_then(|t| t.trim().parse::<i64>().ok()) {
        forms.push(format!("tmdb:{tmdb}"));
    }
    forms.iter().any(|id| {
        if is_film {
            seen.contains(&format!("movie|{id}"))
        } else {
            match (f.season, f.episode) {
                (Some(s), Some(e)) => seen.contains(&format!("episode|{id}|{s}|{e}")),
                _ => false,
            }
        }
    })
}

// ---- sending ----------------------------------------------------------------------

static SENDING: AtomicBool = AtomicBool::new(false);
static SEND_SCHEDULED: AtomicBool = AtomicBool::new(false);

pub fn send_soon(app: &tauri::AppHandle) {
    if !allowed() || SEND_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SEND_DELAY).await;
        SEND_SCHEDULED.store(false, Ordering::SeqCst);
        send_waiting(&app).await;
    });
}

pub async fn send_waiting(app: &tauri::AppHandle) {
    if !allowed() || SENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let result = send_all(app).await;
    SENDING.store(false, Ordering::SeqCst);
    if let Err(e) = result {
        crate::log!("trakt: {e}");
    }
}

enum Sent {
    Accepted(Value),
    Unauthorised,
    Later(String),
    Rejected(String),
}

fn classify(result: Result<(u16, Value), String>) -> Sent {
    match result {
        Ok((200 | 201, body)) => Sent::Accepted(body),
        Ok((401, _)) => Sent::Unauthorised,
        // Busy, down, rate limited, or the app itself not (yet) accepted:
        // none of these is the batch's fault, so it waits.
        Ok((status @ (403 | 423 | 429 | 500..=599), body)) => Sent::Later(format!("{status} {body}")),
        Ok((status, body)) => Sent::Rejected(format!("{status} {body}")),
        Err(e) => Sent::Later(e),
    }
}

async fn send_all(app: &tauri::AppHandle) -> Result<(), String> {
    let mut first = true;
    loop {
        let (keys, tokens, history_due, batch) = {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            if !connected(&conn) {
                return Ok(());
            }
            let Some(keys) = self::app(&conn) else { return Ok(()) };
            let Some(tokens) = read_tokens(&conn) else { return Ok(()) };
            let history_due = setting(&conn, HISTORY_DUE_KEY).is_some();
            let batch = tracking::waiting(&conn, TRAKT, BATCH).map_err(to_string_err)?;
            (keys, tokens, history_due, batch)
        };
        if batch.is_empty() && !history_due {
            return Ok(());
        }
        if !first {
            tokio::time::sleep(WRITE_GAP).await;
        }
        first = false;

        let Some(access) = usable_access(app, &keys, tokens).await? else { return Ok(()) };

        if history_due {
            match queue_missing_history(app, &keys.0, &access).await {
                Ok(()) => continue,
                // Tried again at the next send; meanwhile what was finished
                // since connecting still goes.
                Err(e) if !batch.is_empty() => crate::log!("trakt: {e}"),
                Err(e) => return Err(e),
            }
        }

        let body = history_body(&batch);
        let mut outcome = classify(post(&keys.0, "/sync/history", Some(&access), &body).await);

        // A 401: see whether another Kinema on this library already refreshed,
        // and refresh only if not.
        if matches!(outcome, Sent::Unauthorised) {
            let stored = {
                let db = app.state::<Db>();
                let conn = db.0.lock().map_err(to_string_err)?;
                read_tokens(&conn)
            };
            let retry_with = match stored {
                Some(t) if t.access != access => Some(t.access),
                Some(t) => usable_access(app, &keys, Tokens { expires_at: 0, ..t }).await?,
                None => None,
            };
            let Some(retry_with) = retry_with else { return Ok(()) };
            tokio::time::sleep(WRITE_GAP).await;
            outcome = classify(post(&keys.0, "/sync/history", Some(&retry_with), &body).await);
        }

        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        match outcome {
            Sent::Accepted(response) => {
                if let Some(missing) = not_found_summary(&response) {
                    crate::log!("trakt: {missing}");
                }
                tracking::forget_sent(&conn, &batch).map_err(to_string_err)?;
                store(&conn, LAST_SENT_KEY, &now_secs().to_string())?;
                crate::log!("trakt: sent {} watched item(s)", batch.len());
            }
            Sent::Unauthorised => {
                mark_needs_reconnect(&conn, "the access token was refused twice")?;
                return Ok(());
            }
            Sent::Later(why) => {
                return Err(format!("could not send {} item(s), kept for later: {why}", batch.len()));
            }
            Sent::Rejected(why) => {
                crate::log!("trakt: Trakt rejected a batch ({why}); it was {body}");
                tracking::forget_sent(&conn, &batch).map_err(to_string_err)?;
            }
        }
    }
}

/// The history sent once at connect: everything finished in Kinema that the
/// account does not already have. Trakt would count a repeat as a second play.
///
/// If the account cannot be read, nothing is queued and it is tried again at
/// the next send — sending the whole history blind would be the one way to
/// put duplicates into someone's Trakt.
async fn queue_missing_history(app: &tauri::AppHandle, client_id: &str, access: &str) -> Result<(), String> {
    let movies = get(client_id, "/sync/watched/movies", access).await;
    tokio::time::sleep(WRITE_GAP).await;
    let shows = get(client_id, "/sync/watched/shows", access).await;
    let (movies, shows) = match (movies, shows) {
        (Ok((200, m)), Ok((200, s))) => (m, s),
        (m, s) => {
            let status = |r: &Result<(u16, Value), String>| match r {
                Ok((code, _)) => code.to_string(),
                Err(e) => e.clone(),
            };
            return Err(format!(
                "could not read what the account has watched ({} / {}); the history waits",
                status(&m),
                status(&s)
            ));
        }
    };
    let seen = already_watched(&movies, &shows);
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(to_string_err)?;
    let history = tracking::finished_history(&conn).map_err(to_string_err)?;
    let missing: Vec<_> = history.into_iter().filter(|f| !has(&seen, f)).collect();
    let queued = tracking::queue_all(&conn, TRAKT, &missing).map_err(to_string_err)?;
    clear(&conn, HISTORY_DUE_KEY)?;
    crate::log!(
        "trakt: the account already has {} watched item(s); {queued} more from Kinema queued",
        seen.len()
    );
    Ok(())
}

// ---- connecting -------------------------------------------------------------------

struct Pending {
    client_id: String,
    secret: String,
    device_code: String,
    interval: Duration,
    next_poll: Instant,
    expires: Instant,
}

#[derive(Default)]
pub struct TraktState(Mutex<Option<Pending>>);

#[tauri::command]
pub fn trakt_status(db: tauri::State<Db>) -> Result<Status, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    Ok(Status {
        available: allowed() && app(&conn).is_some(),
        connected: connected(&conn),
        needs_reconnect: setting(&conn, RECONNECT_KEY).is_some(),
        user: setting(&conn, USER_KEY),
        waiting: tracking::waiting_count(&conn, TRAKT),
        last_sent_at: setting(&conn, LAST_SENT_KEY).and_then(|s| s.parse().ok()),
    })
}

fn parse_device(body: &Value) -> Option<(String, DeviceCode, u64)> {
    let text = |k: &str| body.get(k).and_then(Value::as_str).map(String::from);
    let device_code = text("device_code")?;
    let user_code = text("user_code")?;
    let verification_uri = text("verification_url").unwrap_or_else(|| "https://trakt.tv/activate".into());
    let expires_in = body.get("expires_in").and_then(Value::as_i64).unwrap_or(600);
    let interval = body.get("interval").and_then(Value::as_u64).unwrap_or(5).max(1);
    Some((
        device_code,
        DeviceCode {
            qr_svg: qr_svg(ACTIVATE_URL),
            user_code,
            verification_uri_complete: verification_uri.clone(),
            verification_uri,
            expires_in,
        },
        interval,
    ))
}

#[tauri::command]
pub async fn trakt_start_connect(app: tauri::AppHandle) -> Result<DeviceCode, String> {
    if !allowed() {
        return Err("Trakt is not used during a self-test".into());
    }
    let (client_id, secret) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        self::app(&conn).ok_or("This copy of Kinema has no Trakt app.")?
    };
    let (status, body) = post(&client_id, "/oauth/device/code", None, &json!({ "client_id": client_id }))
        .await
        .map_err(|e| format!("Trakt could not be reached: {e}"))?;
    if status == 401 || status == 403 {
        crate::log!("trakt: Trakt does not accept this app ({status}): {body}");
        return Err("Trakt does not recognise this copy of Kinema's app.".into());
    }
    let Some((device_code, shown, interval)) = parse_device(&body) else {
        crate::log!("trakt: unexpected answer to the sign-in request ({status}): {body}");
        return Err("Trakt gave an answer Kinema does not understand.".into());
    };
    let now = Instant::now();
    *app.state::<TraktState>().0.lock().map_err(to_string_err)? = Some(Pending {
        client_id,
        secret,
        device_code,
        interval: Duration::from_secs(interval),
        next_poll: now + Duration::from_secs(interval),
        expires: now + Duration::from_secs(shown.expires_in.max(1) as u64),
    });
    Ok(shown)
}

#[tauri::command]
pub fn trakt_cancel_connect(state: tauri::State<TraktState>) -> Result<(), String> {
    *state.0.lock().map_err(to_string_err)? = None;
    Ok(())
}

/// What a poll's answer means. Kept apart from the request so it can be tested.
fn poll_outcome(status: u16) -> PollOutcome {
    match status {
        200 => PollOutcome::Connected,
        400 | 429 => PollOutcome::Waiting,
        410 => PollOutcome::Expired,
        418 => PollOutcome::Denied,
        401 | 403 => PollOutcome::Refused,
        // 404: an unknown code; 409: already used. Either way, start again.
        _ => PollOutcome::Failed,
    }
}

/// Ask once whether the person has approved — only when Trakt's interval has
/// passed, so a fast page timer never polls Trakt too early.
#[tauri::command]
pub async fn trakt_poll_connect(app: tauri::AppHandle) -> Result<PollOutcome, String> {
    let (client_id, secret, device_code) = {
        let state = app.state::<TraktState>();
        let guard = state.0.lock().map_err(to_string_err)?;
        let Some(p) = guard.as_ref() else { return Ok(PollOutcome::Expired) };
        let now = Instant::now();
        if now >= p.expires {
            return Ok(PollOutcome::Expired);
        }
        if now < p.next_poll {
            return Ok(PollOutcome::Waiting);
        }
        (p.client_id.clone(), p.secret.clone(), p.device_code.clone())
    };

    let answer = post(
        &client_id,
        "/oauth/device/token",
        None,
        &json!({ "code": device_code, "client_id": client_id, "client_secret": secret }),
    )
    .await;

    let finish = |outcome: PollOutcome, slow: bool| -> Result<PollOutcome, String> {
        let state = app.state::<TraktState>();
        let mut guard = state.0.lock().map_err(to_string_err)?;
        if outcome == PollOutcome::Waiting || outcome == PollOutcome::Failed {
            if let Some(p) = guard.as_mut() {
                if slow {
                    p.interval += Duration::from_secs(5);
                }
                p.next_poll = Instant::now() + p.interval;
            }
        } else {
            *guard = None;
        }
        Ok(outcome)
    };

    let (status, body) = match answer {
        Ok(a) => a,
        Err(e) => {
            crate::log!("trakt: sign-in poll failed: {e}");
            return finish(PollOutcome::Failed, false);
        }
    };
    let outcome = poll_outcome(status);
    if outcome != PollOutcome::Connected {
        if !matches!(outcome, PollOutcome::Waiting) {
            crate::log!("trakt: sign-in poll returned {status} {body}");
        }
        return finish(outcome, status == 429);
    }

    let tokens = match parse_tokens(&body) {
        Ok(t) => t,
        Err(e) => {
            crate::log!("trakt: {e}");
            return finish(PollOutcome::Failed, false).map(|_| PollOutcome::Failed);
        }
    };
    *app.state::<TraktState>().0.lock().map_err(to_string_err)? = None;
    let user = account_name(&client_id, &tokens.access).await;
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        save_tokens(&conn, &tokens)?;
        match &user {
            Some(name) => store(&conn, USER_KEY, name)?,
            None => clear(&conn, USER_KEY)?,
        }
        // Compared with the account and sent by the sender, not here: see
        // `queue_missing_history`.
        store(&conn, HISTORY_DUE_KEY, "1")?;
        crate::log!("trakt: connected; the history is due to be compared and sent");
    }
    send_soon(&app);
    Ok(PollOutcome::Connected)
}

async fn account_name(client_id: &str, access: &str) -> Option<String> {
    let (status, body) = get(client_id, "/users/settings", access).await.ok()?;
    if status != 200 {
        return None;
    }
    body.pointer("/user/username")
        .or_else(|| body.pointer("/user/name"))
        .and_then(Value::as_str)
        .map(String::from)
}

/// Disconnect: ask Trakt to end the sign-in (it frees the account's one
/// outside-app slot), and forget it here with everything still waiting.
#[tauri::command]
pub async fn trakt_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    let (keys, access) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        (self::app(&conn), setting(&conn, ACCESS_KEY))
    };
    if let (Some((id, secret)), Some(token), true) = (keys, access, allowed()) {
        let body = json!({ "token": token, "client_id": id, "client_secret": secret });
        if let Err(e) = post(&id, "/oauth/revoke", None, &body).await {
            crate::log!("trakt: could not reach Trakt to end the sign-in: {e}");
        }
    }
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(to_string_err)?;
    for key in [ACCESS_KEY, REFRESH_KEY, EXPIRES_KEY, USER_KEY, RECONNECT_KEY, LAST_SENT_KEY, HISTORY_DUE_KEY] {
        clear(&conn, key)?;
    }
    tracking::forget_all(&conn, TRAKT).map_err(to_string_err)?;
    crate::log!("trakt: disconnected");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finished(kind: &str, imdb: Option<&str>, tmdb: Option<&str>, s: Option<i64>, e: Option<i64>) -> tracking::Finished {
        tracking::Finished {
            kind: kind.into(),
            imdb_id: imdb.map(String::from),
            tmdb_id: tmdb.map(String::from),
            season: s,
            episode: e,
            watched_at: 1,
        }
    }

    /// The whole point of reading the account first: what Trakt has, by
    /// either id, is not sent again.
    #[test]
    fn what_the_account_already_has_is_recognised_by_either_id() {
        let movies = json!([{ "plays": 1, "movie": { "ids": { "trakt": 1, "imdb": "tt0000001", "tmdb": 11 } } }]);
        let shows = json!([{
            "plays": 3,
            "show": { "ids": { "trakt": 2, "imdb": "tt0000002", "tmdb": 105 } },
            "seasons": [{ "number": 1, "episodes": [{ "number": 1, "plays": 1 }, { "number": 2, "plays": 2 }] }]
        }]);
        let seen = already_watched(&movies, &shows);
        assert!(has(&seen, &finished("movie", None, Some("11"), None, None)));
        assert!(has(&seen, &finished("movie", Some("tt0000001"), None, None, None)));
        assert!(has(&seen, &finished("series", None, Some("105"), Some(1), Some(2))));
        assert!(has(&seen, &finished("series", Some("tt0000002"), None, Some(1), Some(1))));
        assert!(!has(&seen, &finished("series", None, Some("105"), Some(1), Some(3))));
        assert!(!has(&seen, &finished("series", None, Some("105"), Some(2), Some(1))));
        assert!(!has(&seen, &finished("movie", None, Some("12"), None, None)));
    }

    #[test]
    fn an_empty_account_has_nothing() {
        let seen = already_watched(&json!([]), &json!([]));
        assert!(seen.is_empty());
        assert!(!has(&seen, &finished("movie", None, Some("11"), None, None)));
    }

    #[test]
    fn the_body_uses_numbers_for_tmdb_and_groups_episodes() {
        let row = |id, film: bool, imdb: Option<&str>, tmdb: &str, s: Option<i64>, e: Option<i64>| Waiting {
            id,
            is_film: film,
            imdb_id: imdb.map(String::from),
            tmdb_id: Some(tmdb.into()),
            season: s,
            episode: e,
            watched_at: 1_790_000_000,
        };
        let body = history_body(&[
            row(1, false, None, "105", Some(1), Some(1)),
            row(2, true, Some("tt0000001"), "11", None, None),
            row(3, false, None, "105", Some(1), Some(2)),
        ]);
        assert_eq!(body["movies"][0]["ids"]["tmdb"], 11);
        assert_eq!(body["movies"][0]["ids"]["imdb"], "tt0000001");
        assert_eq!(body["movies"][0]["watched_at"], "2026-09-21T14:13:20Z");
        assert_eq!(body["shows"][0]["ids"]["tmdb"], 105);
        assert!(body["shows"][0].get("use_tvdb_anime_seasons").is_none());
        assert_eq!(body["shows"][0]["seasons"][0]["episodes"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_tmdb_id_that_is_not_a_number_is_left_out() {
        assert_eq!(ids(&None, &Some("abc".into())), json!({}));
    }

    /// Single-use refresh tokens: an answer without a new one is refused.
    #[test]
    fn a_token_answer_needs_both_tokens() {
        assert!(parse_tokens(&json!({ "access_token": "a", "refresh_token": "r", "expires_in": 604800 })).is_ok());
        assert!(parse_tokens(&json!({ "access_token": "a" })).is_err());
    }

    #[test]
    fn poll_answers_mean_what_trakt_documents() {
        assert_eq!(poll_outcome(200), PollOutcome::Connected);
        assert_eq!(poll_outcome(400), PollOutcome::Waiting);
        assert_eq!(poll_outcome(429), PollOutcome::Waiting);
        assert_eq!(poll_outcome(410), PollOutcome::Expired);
        assert_eq!(poll_outcome(418), PollOutcome::Denied);
        assert_eq!(poll_outcome(403), PollOutcome::Refused);
        assert_eq!(poll_outcome(404), PollOutcome::Failed);
        assert_eq!(poll_outcome(409), PollOutcome::Failed);
    }

    /// Trakt's rate limit, the app not yet approved, or a locked account are
    /// not the batch's fault: it waits. A malformed batch does not.
    #[test]
    fn send_answers_are_sorted_into_wait_and_give_up() {
        assert!(matches!(classify(Ok((201, json!({})))), Sent::Accepted(_)));
        assert!(matches!(classify(Ok((401, Value::Null))), Sent::Unauthorised));
        for status in [403, 423, 429, 500, 503, 522] {
            assert!(matches!(classify(Ok((status, Value::Null))), Sent::Later(_)), "{status}");
        }
        assert!(matches!(classify(Ok((422, Value::Null))), Sent::Rejected(_)));
        assert!(matches!(classify(Err("offline".into())), Sent::Later(_)));
    }

    #[test]
    fn the_sign_in_answer_is_read_and_the_qr_code_opens_trakts_page() {
        let body = json!({ "device_code": "dc", "user_code": "5055CC52", "verification_url": "https://trakt.tv/activate",
                           "expires_in": 600, "interval": 5 });
        let (device_code, shown, interval) = parse_device(&body).unwrap();
        assert_eq!(device_code, "dc");
        assert_eq!(shown.user_code, "5055CC52");
        assert_eq!(interval, 5);
        assert!(shown.qr_svg.unwrap().starts_with("<?xml"));
    }

    #[test]
    fn not_found_items_are_summarised() {
        assert_eq!(not_found_summary(&json!({ "not_found": { "movies": [], "shows": [], "episodes": [] } })), None);
        assert!(not_found_summary(&json!({ "not_found": { "episodes": [{}] } })).unwrap().starts_with("1 item"));
    }
}
