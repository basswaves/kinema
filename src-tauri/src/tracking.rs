//! What is shared by the watch-tracking services: the queue of finished films
//! and episodes waiting to be sent, and the rule for what goes in it.
//!
//! Each service (`simkl.rs`, `trakt.rs`) signs in, refreshes its tokens and
//! sends in its own way; what they have in common is here, so a finished
//! episode is queued once per connected service from the one place something
//! becomes watched (`history::remember`), and a service added later needs no
//! new hook.
//!
//! **The queue survives being offline.** Rows leave `watch_outbox` only when
//! the service has accepted them. One row per service and thing watched: the
//! same episode finished twice before a send is one watch, the first kept.

use crate::util::now_secs;
use rusqlite::{params, Connection};

/// The services, as stored in `watch_outbox.service`.
pub const SIMKL: &str = "simkl";
pub const TRAKT: &str = "trakt";

/// Every service, in the order a finished item is queued for them.
const SERVICES: [&str; 2] = [SIMKL, TRAKT];

fn connected(conn: &Connection, service: &str) -> bool {
    match service {
        SIMKL => crate::simkl::connected(conn),
        TRAKT => crate::trakt::connected(conn),
        _ => false,
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
    fn times_are_written_as_iso_8601() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601(1_790_000_000), "2026-09-21T14:13:20Z");
        assert_eq!(iso8601(4_107_542_399), "2100-02-28T23:59:59Z");
    }
}
