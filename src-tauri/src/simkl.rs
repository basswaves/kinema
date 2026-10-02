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
//! `watch_outbox` until SIMKL has them: a failure to reach SIMKL keeps them,
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
use crate::tracking::{
    self, http, qr_svg, read_tokens, save_tokens, user_agent, DeviceCode, PollOutcome, Sent, Status,
    Tokens, Waiting, SIMKL,
};
use crate::util::{now_secs, to_string_err};
use rusqlite::Connection;
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

// ---- the request ------------------------------------------------------------

/// SIMKL's ids: IMDb and TMDB, both as text.
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

/// The body for `POST /sync/history` (`tracking::history_body`), with
/// `use_tvdb_anime_seasons` on every show.
///
/// A TMDB id means different things for films and shows; the list it sits in
/// (`movies` or `shows`) is what tells SIMKL which. `use_tvdb_anime_seasons`
/// says the season numbers are per season, as TMDB counts them — SIMKL
/// otherwise counts anime as one long season, and it changes nothing else.
fn history_body(rows: &[Waiting]) -> Value {
    let mut body = tracking::history_body(rows, ids);
    for show in body["shows"].as_array_mut().into_iter().flatten() {
        show["use_tvdb_anime_seasons"] = json!(true);
    }
    body
}

// ---- tokens -----------------------------------------------------------------

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
    if !tracking::allowed() || SEND_SCHEDULED.swap(true, Ordering::SeqCst) {
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
    if !tracking::allowed() || SENDING.swap(true, Ordering::SeqCst) {
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
            if !tracking::connected(&conn, SIMKL) {
                return Ok(());
            }
            let Some(client_id) = client_id(&conn) else { return Ok(()) };
            let Some(tokens) = read_tokens(&conn, SIMKL) else { return Ok(()) };
            let batch = tracking::waiting(&conn, SIMKL, BATCH).map_err(to_string_err)?;
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
                read_tokens(&conn, SIMKL)
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
        if !tracking::settle(&conn, SIMKL, outcome, &batch, &body)? {
            return Ok(());
        }
    }
}

/// An access token worth sending: the stored one, or a fresh one when it is
/// due. `None` when SIMKL is out of reach or the person must connect again.
async fn usable_access(
    app: &tauri::AppHandle,
    client_id: &str,
    tokens: Tokens,
) -> Result<Option<String>, String> {
    if !tokens.due_for_refresh(now_secs()) {
        return Ok(Some(tokens.access));
    }
    match refresh(client_id, &tokens.refresh).await {
        Refreshed::Tokens(fresh) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            save_tokens(&conn, SIMKL, &fresh)?;
            Ok(Some(fresh.access))
        }
        Refreshed::Refused => {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            tracking::mark_needs_reconnect(&conn, SIMKL, "SIMKL refused the refresh token")?;
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

#[tauri::command]
pub fn simkl_status(db: tauri::State<Db>) -> Result<Status, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    Ok(tracking::status(&conn, SIMKL, client_id(&conn).is_some()))
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
    if !tracking::allowed() {
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
            save_tokens(&conn, SIMKL, &tokens)?;
            tracking::save_user(&conn, SIMKL, user.as_deref())?;
            // Everything already watched, once — decided 2026-09-30. SIMKL
            // ignores a watch it already has, so connecting again is harmless.
            let history = tracking::finished_history(&conn).map_err(to_string_err)?;
            let queued = tracking::queue_all(&conn, SIMKL, &history).map_err(to_string_err)?;
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
        (client_id(&conn), read_tokens(&conn, SIMKL).map(|t| t.refresh))
    };
    if let (Some(client_id), Some(token), Some(http)) = (client_id, refresh_token, http()) {
        if tracking::allowed() {
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
    tracking::forget_sign_in(&conn, SIMKL)?;
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
            SIMKL,
            &Tokens {
                access: "a".into(),
                refresh: "r".into(),
                expires_at: now_secs() + 7 * 86_400,
            },
        )
        .unwrap();
    }

    /// A refused refresh token means connecting again; until then nothing
    /// new is queued, but what was queued stays.
    #[test]
    fn needing_to_reconnect_stops_new_items_and_keeps_old_ones() {
        let conn = db();
        connect(&conn);
        tracking::queue_finished(&conn, "movie", Some("tt0000001"), None, None, None, 1).unwrap();
        tracking::mark_needs_reconnect(&conn, SIMKL, "test").unwrap();
        assert!(!tracking::connected(&conn, SIMKL));
        tracking::queue_finished(&conn, "movie", Some("tt0000003"), None, None, None, 1).unwrap();
        assert_eq!(tracking::waiting_count(&conn, SIMKL), 1);
        // Connecting again clears it.
        connect(&conn);
        assert!(tracking::connected(&conn, SIMKL));
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
    fn urls_carry_the_app_id_name_and_version() {
        let u = url("/sync/history", "abc 123");
        assert!(u.starts_with("https://api.simkl.com/sync/history?client_id=abc%20123&app-name=kinema&app-version="));
    }
}
