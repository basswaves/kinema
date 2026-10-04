//! What is shared by the watch-tracking services: the queue of finished films
//! and episodes waiting to be sent, the rule for what goes in it, how a
//! sign-in is kept, and what a service's answer to a batch means.
//!
//! Each service (`simkl.rs`, `trakt.rs`) talks to its own API — signing in,
//! refreshing, and Trakt's comparison with the account at connect — and
//! everything they do alike is here, written once: a finished episode is
//! queued once per connected service from the one place something becomes
//! watched (`history::remember`), and a service added later needs no new hook.
//!
//! **The queue survives being offline.** Rows leave `watch_outbox` only when
//! the service has accepted them. One row per service and thing watched: the
//! same episode finished twice before a send is one watch, the first kept.

use crate::settings::setting;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::time::Duration;

/// The services, as stored in `watch_outbox.service`, and the prefix of the
/// settings each keeps its sign-in in (`simkl_access_token`, …).
pub const SIMKL: &str = "simkl";
pub const TRAKT: &str = "trakt";

/// Every service, in the order a finished item is queued for them.
const SERVICES: [&str; 2] = [SIMKL, TRAKT];

/// Whether the services may be used at all in this process. A self-test runs
/// on a copy of the library, tokens included, and a second process refreshing
/// the same grant would cut the real Kinema's sign-in off.
pub fn allowed() -> bool {
    crate::selftest::plan_path().is_none()
}

pub fn user_agent() -> String {
    format!("kinema/{}", env!("CARGO_PKG_VERSION"))
}

pub fn http() -> Option<tauri_plugin_http::reqwest::Client> {
    tauri_plugin_http::reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .ok()
}

// ---- a service's sign-in, kept in the settings table --------------------------

/// The setting `what` of `service`: `simkl_access_token`, `trakt_user`, ….
fn key(service: &str, what: &str) -> String {
    format!("{service}_{what}")
}

const ACCESS: &str = "access_token";
const REFRESH: &str = "refresh_token";
/// When the access token runs out, in Unix seconds.
const EXPIRES: &str = "access_expires_at";
/// The account's name, to say who Kinema is connected as.
const USER: &str = "user";
/// Set when the service refused the refresh token: the person has to connect
/// again.
const RECONNECT: &str = "needs_reconnect";
/// When the service last accepted a batch, in Unix seconds.
const LAST_SENT: &str = "last_sent_at";

/// Refresh the access token when it has less than this left.
const REFRESH_MARGIN_SECS: i64 = 24 * 60 * 60;

#[derive(Debug, PartialEq, Clone)]
pub struct Tokens {
    pub access: String,
    pub refresh: String,
    pub expires_at: i64,
}

impl Tokens {
    /// Refreshed a day before it runs out.
    pub fn due_for_refresh(&self, now: i64) -> bool {
        self.expires_at - now < REFRESH_MARGIN_SECS
    }
}

/// Connected means holding a refresh token the service has not refused.
pub fn connected(conn: &Connection, service: &str) -> bool {
    setting(conn, &key(service, REFRESH)).is_some() && setting(conn, &key(service, RECONNECT)).is_none()
}

pub fn store(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    crate::settings::store(conn, key, value)
}

pub fn clear(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])
        .map(|_| ())
        .map_err(to_string_err)
}

/// Keep a sign-in, and with it forget any earlier refusal.
pub fn save_tokens(conn: &Connection, service: &str, tokens: &Tokens) -> Result<(), String> {
    store(conn, &key(service, ACCESS), &tokens.access)?;
    store(conn, &key(service, REFRESH), &tokens.refresh)?;
    store(conn, &key(service, EXPIRES), &tokens.expires_at.to_string())?;
    clear(conn, &key(service, RECONNECT))
}

pub fn read_tokens(conn: &Connection, service: &str) -> Option<Tokens> {
    Some(Tokens {
        access: setting(conn, &key(service, ACCESS))?,
        refresh: setting(conn, &key(service, REFRESH))?,
        expires_at: setting(conn, &key(service, EXPIRES))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
    })
}

pub fn mark_needs_reconnect(conn: &Connection, service: &str, why: &str) -> Result<(), String> {
    crate::log!("{service}: needs connecting again — {why}; watched items stay queued");
    store(conn, &key(service, RECONNECT), "1")
}

/// Who Kinema is connected as, when the service said.
pub fn save_user(conn: &Connection, service: &str, user: Option<&str>) -> Result<(), String> {
    match user {
        Some(name) => store(conn, &key(service, USER), name),
        None => clear(conn, &key(service, USER)),
    }
}

pub fn status(conn: &Connection, service: &str, available: bool) -> Status {
    Status {
        available: allowed() && available,
        connected: connected(conn, service),
        needs_reconnect: setting(conn, &key(service, RECONNECT)).is_some(),
        user: setting(conn, &key(service, USER)),
        waiting: waiting_count(conn, service),
        last_sent_at: setting(conn, &key(service, LAST_SENT)).and_then(|s| s.parse().ok()),
    }
}

/// Forget the sign-in, and everything waiting to be sent with it — it was to
/// go to the account being disconnected.
pub fn forget_sign_in(conn: &Connection, service: &str) -> Result<(), String> {
    for what in [ACCESS, REFRESH, EXPIRES, USER, RECONNECT, LAST_SENT] {
        clear(conn, &key(service, what))?;
    }
    forget_all(conn, service).map_err(to_string_err)
}

// ---- sending -----------------------------------------------------------------

/// The body for `POST /sync/history`, which both services take in the same
/// shape: films as they are, episodes gathered under their show and season,
/// each with when it was watched. `ids` writes a title's ids the way the
/// service wants them.
pub fn history_body(rows: &[Waiting], ids: fn(&Option<String>, &Option<String>) -> Value) -> Value {
    /// A show's IMDb and TMDB ids, which together say which show an episode is of.
    type ShowIds = (Option<String>, Option<String>);
    /// A season's number and its episodes, as they will be sent.
    type Season = (i64, Vec<Value>);

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

/// What the service could not place, as a line for the log. A title it does
/// not know is not a failure worth retrying — it would not know it next time
/// either — so these are logged and let go.
pub fn not_found_summary(response: &Value) -> Option<String> {
    let nf = response.get("not_found")?;
    let count = |k: &str| nf.get(k).and_then(Value::as_array).map_or(0, Vec::len);
    let total = count("movies") + count("shows") + count("seasons") + count("episodes");
    (total > 0).then(|| format!("{total} item(s) not found: {nf}"))
}

/// A service's answer to a batch.
pub enum Sent {
    Accepted(Value),
    /// The access token is not accepted.
    Unauthorised,
    /// Try again later: the service is busy, down or out of reach.
    Later(String),
    /// The service refused the request itself. Retrying the same bytes will not
    /// help.
    Rejected(String),
}

/// Settle the queue after the service answered `batch` (sent as `body`).
/// `Ok(true)`: go on to the next batch; `Ok(false)`: stop, the person has to
/// connect again; `Err`: the batch was kept and waits for a later send.
pub fn settle(conn: &Connection, service: &str, outcome: Sent, batch: &[Waiting], body: &Value) -> Result<bool, String> {
    match outcome {
        Sent::Accepted(response) => {
            if let Some(missing) = not_found_summary(&response) {
                crate::log!("{service}: {missing}");
            }
            forget_sent(conn, batch).map_err(to_string_err)?;
            store(conn, &key(service, LAST_SENT), &now_secs().to_string())?;
            crate::log!("{service}: sent {} watched item(s)", batch.len());
            Ok(true)
        }
        Sent::Unauthorised => {
            mark_needs_reconnect(conn, service, "the access token was refused twice")?;
            Ok(false)
        }
        Sent::Later(why) => Err(format!("could not send {} item(s), kept for later: {why}", batch.len())),
        Sent::Rejected(why) => {
            // Logged whole, with what was sent, so the reason can be read and
            // fixed; the rows go, or the same refusal would block everything
            // queued behind them for good.
            crate::log!("{service}: the service rejected a batch ({why}); it was {body}");
            forget_sent(conn, batch).map_err(to_string_err)?;
            Ok(true)
        }
    }
}

/// Queue one finished film or episode for every service that is connected.
///
/// Called by `history::remember` at the moment something becomes watched —
/// the one place that happens, whether by playing or by hand. Returns how many
/// rows were queued, so the caller knows to schedule a send.
///
/// Needs an IMDb or TMDB id: the services find a title by its ids, and without
/// one there is nothing to tell them that they could act on. An episode also
/// needs its numbers.
pub fn queue_finished(
    conn: &Connection,
    kind: &str,
    imdb_id: Option<&str>,
    tmdb_id: Option<&str>,
    season: Option<i64>,
    episode: Option<i64>,
    watched_at: i64,
) -> rusqlite::Result<usize> {
    let mut queued = 0;
    for service in SERVICES {
        if connected(conn, service)
            && queue(conn, service, kind, imdb_id, tmdb_id, season, episode, watched_at)?
        {
            queued += 1;
        }
    }
    Ok(queued)
}

/// Queue for one service without asking whether it is connected — for the
/// history sent at connect, queued the moment the tokens are stored.
#[allow(clippy::too_many_arguments)]
pub fn queue(
    conn: &Connection,
    service: &str,
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
    let kind = if is_film { "movie" } else { "episode" };
    let key = item_key(kind, imdb_id, tmdb_id, season, episode);
    let added = conn.execute(
        "INSERT OR IGNORE INTO watch_outbox
            (service, key, kind, imdb_id, tmdb_id, season, episode, watched_at, queued_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            service,
            key,
            kind,
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

/// One string per thing watched.
fn item_key(
    kind: &str,
    imdb_id: Option<&str>,
    tmdb_id: Option<&str>,
    season: Option<i64>,
    episode: Option<i64>,
) -> String {
    format!(
        "{kind}|{}|{}|{}|{}",
        imdb_id.unwrap_or(""),
        tmdb_id.unwrap_or(""),
        season.map(|s| s.to_string()).unwrap_or_default(),
        episode.map(|e| e.to_string()).unwrap_or_default()
    )
}

/// Something finished in Kinema, as `watch_history` holds it.
#[derive(Debug, Clone, PartialEq)]
pub struct Finished {
    pub kind: String,
    pub imdb_id: Option<String>,
    pub tmdb_id: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub watched_at: i64,
}

/// Everything watched in Kinema, for the history sent at connect.
pub fn finished_history(conn: &Connection) -> rusqlite::Result<Vec<Finished>> {
    let mut stmt = conn.prepare(
        "SELECT kind, imdb_id, tmdb_id, season, episode, updated_at
           FROM watch_history
          WHERE completed = 1",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Finished {
            kind: r.get(0)?,
            imdb_id: r.get(1)?,
            tmdb_id: r.get(2)?,
            season: r.get(3)?,
            episode: r.get(4)?,
            watched_at: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// Queue each of `items` for one service. Returns how many were new.
pub fn queue_all(conn: &Connection, service: &str, items: &[Finished]) -> rusqlite::Result<usize> {
    let mut queued = 0;
    for f in items {
        if queue(
            conn,
            service,
            &f.kind,
            f.imdb_id.as_deref(),
            f.tmdb_id.as_deref(),
            f.season,
            f.episode,
            f.watched_at,
        )? {
            queued += 1;
        }
    }
    Ok(queued)
}

/// A queued item, as a service's sender reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    pub id: i64,
    pub is_film: bool,
    pub imdb_id: Option<String>,
    pub tmdb_id: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub watched_at: i64,
}

pub fn waiting(conn: &Connection, service: &str, limit: usize) -> rusqlite::Result<Vec<Waiting>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, imdb_id, tmdb_id, season, episode, watched_at
           FROM watch_outbox WHERE service = ?1 ORDER BY id LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![service, limit as i64], |r| {
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

pub fn waiting_count(conn: &Connection, service: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM watch_outbox WHERE service = ?1",
        params![service],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

pub fn forget_sent(conn: &Connection, sent: &[Waiting]) -> rusqlite::Result<()> {
    for row in sent {
        conn.execute("DELETE FROM watch_outbox WHERE id = ?1", params![row.id])?;
    }
    Ok(())
}

/// Everything waiting for one service — on disconnecting it.
pub fn forget_all(conn: &Connection, service: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM watch_outbox WHERE service = ?1", params![service])?;
    Ok(())
}

/// Have every connected service send what is waiting, a little later.
pub fn send_soon(app: &tauri::AppHandle) {
    crate::simkl::send_soon(app);
    crate::trakt::send_soon(app);
}

// ---- what the sign-in page shows, for any service --------------------------

/// What the page shows while waiting for approval.
#[derive(serde::Serialize)]
pub struct DeviceCode {
    /// The code to type, shown exactly as the service gave it.
    pub user_code: String,
    /// The page to type it on.
    pub verification_uri: String,
    /// The page to open — with the code filled in where the service allows.
    pub verification_uri_complete: String,
    pub expires_in: i64,
    /// A QR code of the page, as an SVG, to scan with a phone from the sofa.
    pub qr_svg: Option<String>,
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PollOutcome {
    /// Not approved yet. Ask again later.
    Waiting,
    Connected,
    /// The code ran out. Start again.
    Expired,
    /// The person said no on the service's page. Only Trakt says so; on
    /// SIMKL a refusal looks exactly like waiting.
    Denied,
    /// The service does not accept this app — a configuration problem, not
    /// something waiting will fix.
    Refused,
    /// Anything else, including being offline. Worth trying again.
    Failed,
}

#[derive(serde::Serialize)]
pub struct Status {
    /// There is an app ID, so connecting is possible at all.
    pub available: bool,
    pub connected: bool,
    pub needs_reconnect: bool,
    pub user: Option<String>,
    /// Finished items not yet accepted by the service.
    pub waiting: i64,
    pub last_sent_at: Option<i64>,
}

/// A web address as a QR code, for a device that cannot open web pages
/// itself: scanned with a phone instead (`ui/links.ts`).
#[tauri::command]
pub fn link_qr(url: String) -> Option<String> {
    qr_svg(&url)
}

pub fn qr_svg(text: &str) -> Option<String> {
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

/// A Unix time as the ISO-8601 both services ask for, `2026-09-30T20:15:00Z`.
///
/// Written out rather than pulled in from a date crate for the one format:
/// days since 1970 to a civil date is a few lines of well-known arithmetic
/// (Howard Hinnant's `civil_from_days`).
pub fn iso8601(secs: i64) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn
    }

    fn connect(conn: &Connection, service: &str) {
        let prefix = if service == SIMKL { "simkl" } else { "trakt" };
        crate::settings::store(conn, &format!("{prefix}_access_token"), "a").unwrap();
        crate::settings::store(conn, &format!("{prefix}_refresh_token"), "r").unwrap();
    }

    #[test]
    fn nothing_is_queued_while_no_service_is_connected() {
        let conn = db();
        assert_eq!(queue_finished(&conn, "movie", Some("tt0000001"), None, None, None, 1).unwrap(), 0);
        assert_eq!(waiting_count(&conn, SIMKL) + waiting_count(&conn, TRAKT), 0);
    }

    /// One row per connected service, and only for those.
    #[test]
    fn a_finished_item_is_queued_once_for_each_connected_service() {
        let conn = db();
        connect(&conn, SIMKL);
        assert_eq!(queue_finished(&conn, "movie", Some("tt0000001"), None, None, None, 5).unwrap(), 1);
        connect(&conn, TRAKT);
        assert_eq!(queue_finished(&conn, "series", None, Some("105"), Some(1), Some(2), 6).unwrap(), 2);
        // Finished again before it went: still one watch, the first kept.
        assert_eq!(queue_finished(&conn, "series", None, Some("105"), Some(1), Some(2), 9).unwrap(), 0);
        assert_eq!(waiting_count(&conn, SIMKL), 2);
        assert_eq!(waiting_count(&conn, TRAKT), 1);
        let trakt = waiting(&conn, TRAKT, 10).unwrap();
        assert_eq!(trakt[0].watched_at, 6);
        forget_all(&conn, TRAKT).unwrap();
        assert_eq!(waiting_count(&conn, TRAKT), 0);
        assert_eq!(waiting_count(&conn, SIMKL), 2, "the other service keeps its own");
    }

    /// The services find titles by id; without one there is nothing to send.
    #[test]
    fn a_title_with_no_ids_or_an_episode_with_no_numbers_is_not_queued() {
        let conn = db();
        assert!(!queue(&conn, SIMKL, "movie", None, Some("  "), None, None, 1).unwrap());
        assert!(!queue(&conn, SIMKL, "series", Some("tt0000002"), None, Some(1), None, 1).unwrap());
    }

    /// Everything already watched is found for a first send; anything
    /// unfinished is not.
    #[test]
    fn finished_history_is_only_what_was_finished() {
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
        let found = finished_history(&conn).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(queue_all(&conn, TRAKT, &found).unwrap(), 2);
        assert_eq!(queue_all(&conn, TRAKT, &found).unwrap(), 0, "already queued");
    }

    #[test]
    fn a_token_is_refreshed_a_day_before_it_runs_out() {
        let t = |expires_at| Tokens { access: "a".into(), refresh: "r".into(), expires_at };
        assert!(!t(1_000_000 + 2 * 86_400).due_for_refresh(1_000_000));
        assert!(t(1_000_000 + 3_600).due_for_refresh(1_000_000));
        assert!(t(0).due_for_refresh(1_000_000));
    }

    #[test]
    fn not_found_items_are_summarised_and_an_empty_list_is_not() {
        let none = json!({"added": {"movies": 1}, "not_found": {"movies": [], "shows": [], "episodes": []}});
        assert_eq!(not_found_summary(&none), None);
        let some = json!({"not_found": {"movies": [{"ids": {"tmdb": "1"}}], "episodes": [{}]}});
        assert!(not_found_summary(&some).unwrap().starts_with("2 item(s)"));
    }

    /// Each service's sign-in is its own: refusing, disconnecting and the
    /// queue of one leave the other as it was.
    #[test]
    fn one_services_sign_in_is_kept_apart_from_the_others() {
        let conn = db();
        let tokens = Tokens { access: "a".into(), refresh: "r".into(), expires_at: 9 };
        save_tokens(&conn, SIMKL, &tokens).unwrap();
        save_tokens(&conn, TRAKT, &tokens).unwrap();
        assert_eq!(read_tokens(&conn, TRAKT), Some(tokens.clone()));
        save_user(&conn, TRAKT, Some("someone")).unwrap();
        queue_finished(&conn, "movie", Some("tt0000001"), None, None, None, 1).unwrap();

        mark_needs_reconnect(&conn, SIMKL, "test").unwrap();
        assert!(!connected(&conn, SIMKL));
        assert!(connected(&conn, TRAKT));
        assert!(status(&conn, SIMKL, true).needs_reconnect);
        // Connecting again clears the refusal.
        save_tokens(&conn, SIMKL, &tokens).unwrap();
        assert!(connected(&conn, SIMKL));

        forget_sign_in(&conn, TRAKT).unwrap();
        assert_eq!(read_tokens(&conn, TRAKT), None);
        let trakt = status(&conn, TRAKT, true);
        assert!(!trakt.connected && trakt.user.is_none() && trakt.waiting == 0);
        assert!(connected(&conn, SIMKL));
        assert_eq!(waiting_count(&conn, SIMKL), 1);
    }

    #[test]
    fn a_batch_the_service_took_or_refused_leaves_and_one_for_later_stays() {
        let conn = db();
        let tokens = Tokens { access: "a".into(), refresh: "r".into(), expires_at: 9 };
        save_tokens(&conn, TRAKT, &tokens).unwrap();
        queue_finished(&conn, "movie", Some("tt0000001"), None, None, None, 1).unwrap();
        let batch = waiting(&conn, TRAKT, 10).unwrap();
        let body = history_body(&batch, |_, _| json!({}));

        assert!(settle(&conn, TRAKT, Sent::Later("offline".into()), &batch, &body).is_err());
        assert_eq!(waiting_count(&conn, TRAKT), 1, "kept for later");
        assert!(settle(&conn, TRAKT, Sent::Accepted(json!({})), &batch, &body).unwrap());
        assert_eq!(waiting_count(&conn, TRAKT), 0);
        assert!(status(&conn, TRAKT, true).last_sent_at.is_some());

        queue_finished(&conn, "movie", Some("tt0000002"), None, None, None, 1).unwrap();
        let batch = waiting(&conn, TRAKT, 10).unwrap();
        assert!(settle(&conn, TRAKT, Sent::Rejected("422".into()), &batch, &body).unwrap());
        assert_eq!(waiting_count(&conn, TRAKT), 0, "a refused batch would block the queue for good");
        assert!(!settle(&conn, TRAKT, Sent::Unauthorised, &batch, &body).unwrap());
        assert!(!connected(&conn, TRAKT));
    }

    #[test]
    fn times_are_written_as_iso_8601() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601(1_790_000_000), "2026-09-21T14:13:20Z");
        assert_eq!(iso8601(4_107_542_399), "2100-02-28T23:59:59Z");
    }
}
