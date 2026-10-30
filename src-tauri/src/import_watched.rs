//! Bringing in what was watched elsewhere (PLAN.md phase 2): Kodi's database,
//! a Jellyfin, Emby or Plex server (read once, with a key typed for it and
//! never kept), or a Trakt export file.
//!
//! **Matched by ids only.** Each film or show is looked for among the
//! library's titles by its IMDb or TMDB number, of the same kind; anything
//! with neither, or whose numbers point at different titles, is listed and
//! left alone, never guessed (a wrong match is worse than none). A show's
//! episode goes by the show's ids and its season and episode numbers.
//!
//! What is found goes into the history through `history::merge`, which never
//! un-watches and never queues anything itself. **What becomes watched here
//! is sent the way the at-connect history is**: queued once for SIMKL (which
//! ignores a watch it already has), and for Trakt the account is compared
//! first (`trakt_history_due`), since Trakt counts every play it is sent.
//! Importing the same file again finds everything already watched and sends
//! nothing.

use crate::history::{self, Carried, Merged};
use crate::library::Db;
use crate::tracking::{self, SIMKL, TRAKT};
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A film or episode as another player remembers it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Found {
    /// `movie` or `series` (an episode of a show).
    pub kind: String,
    /// The film's ids, or the show's for an episode.
    pub imdb_id: Option<String>,
    pub tmdb_id: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    /// "Example Film (2001)" or "Example Show S01E02", for the list.
    pub label: String,
    pub completed: bool,
    pub position_secs: f64,
    pub duration_secs: Option<f64>,
    /// When it was watched or left, in Unix seconds; `None` when not said.
    pub at: Option<i64>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Report {
    /// Films and episodes read with something watched or begun.
    pub read: usize,
    pub watched: usize,
    pub resume: usize,
    /// Matched, and already watched here (or an older resume point).
    pub kept: usize,
    /// No title here with these ids.
    pub not_in_library: Vec<String>,
    /// No IMDb or TMDB number, or numbers that point at different titles.
    pub unclear: Vec<String>,
    /// Queued for SIMKL; Trakt is compared with the account first.
    pub queued: usize,
}

/// The longest list shown; the counts stay whole.
const LISTED: usize = 200;

fn clean(id: Option<&str>) -> Option<String> {
    id.map(str::trim).filter(|s| !s.is_empty() && *s != "0").map(str::to_string)
}

/// An IMDb number only when it looks like one.
fn imdb(id: Option<&str>) -> Option<String> {
    clean(id).filter(|s| s.starts_with("tt") && s[2..].chars().all(|c| c.is_ascii_digit()) && s.len() > 2)
}

/// A TMDB number only when it is one.
fn tmdb(id: Option<&str>) -> Option<String> {
    clean(id).filter(|s| s.chars().all(|c| c.is_ascii_digit()))
}

fn label(kind: &str, name: &str, year: Option<i64>, season: Option<i64>, episode: Option<i64>) -> String {
    match (kind, season, episode) {
        ("series", Some(s), Some(e)) => format!("{name} S{s:02}E{e:02}"),
        _ => match year {
            Some(y) if y > 0 => format!("{name} ({y})"),
            _ => name.to_string(),
        },
    }
}

// ---- matching and taking in ----------------------------------------------------

struct Title {
    provider: String,
    provider_id: String,
    imdb_id: Option<String>,
    tmdb_id: Option<String>,
}

/// The library's title with exactly these ids, if there is one and no other
/// title contradicts it. `Err(())` when the numbers disagree.
fn title_for(conn: &Connection, f: &Found) -> rusqlite::Result<Result<Option<Title>, ()>> {
    let mut stmt = conn.prepare_cached(
        "SELECT t.provider, t.provider_id, NULLIF(t.imdb_id, ''), NULLIF(t.tmdb_id, '')
           FROM titles t
          WHERE t.kind = ?1
            AND ((?2 IS NOT NULL AND t.imdb_id = ?2) OR (?3 IS NOT NULL AND t.tmdb_id = ?3))
          ORDER BY EXISTS (SELECT 1 FROM media_files m WHERE m.title_id = t.id) DESC, t.id",
    )?;
    let found = stmt
        .query_map(params![f.kind, f.imdb_id, f.tmdb_id], |r| {
            Ok(Title {
                provider: r.get(0)?,
                provider_id: r.get(1)?,
                imdb_id: r.get(2)?,
                tmdb_id: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let differs = |a: &Option<String>, b: &Option<String>| matches!((a, b), (Some(x), Some(y)) if x != y);
    if found
        .iter()
        .any(|t| differs(&t.imdb_id, &f.imdb_id) || differs(&t.tmdb_id, &f.tmdb_id))
    {
        return Ok(Err(()));
    }
    Ok(Ok(found.into_iter().next()))
}

/// Take what was found into the history, and queue what became watched the
/// way the history at connect is.
pub fn apply(conn: &Connection, found: &[Found]) -> rusqlite::Result<Report> {
    let mut report = Report::default();
    let now = now_secs();
    let simkl = tracking::connected(conn, SIMKL);
    let trakt = tracking::connected(conn, TRAKT);
    let list = |v: &mut Vec<String>, l: &str| {
        if v.len() < LISTED && !v.iter().any(|x| x == l) {
            v.push(l.to_string());
        }
    };
    for f in found {
        if !f.completed && f.position_secs <= 0.0 {
            continue;
        }
        report.read += 1;
        if f.kind == "series" && (f.season.is_none() || f.episode.is_none()) {
            list(&mut report.unclear, &f.label);
            continue;
        }
        if f.imdb_id.is_none() && f.tmdb_id.is_none() {
            list(&mut report.unclear, &f.label);
            continue;
        }
        let title = match title_for(conn, f)? {
            Err(()) => {
                list(&mut report.unclear, &f.label);
                continue;
            }
            Ok(None) => {
                list(&mut report.not_in_library, &f.label);
                continue;
            }
            Ok(Some(t)) => t,
        };
        let at = f.at.filter(|a| *a > 0).unwrap_or(now);
        let carried = Carried {
            kind: f.kind.clone(),
            provider: title.provider,
            provider_id: title.provider_id,
            imdb_id: title.imdb_id.or(f.imdb_id.clone()),
            tmdb_id: title.tmdb_id.or(f.tmdb_id.clone()),
            season: f.season,
            episode: f.episode,
            label: f.label.clone(),
            position_secs: f.position_secs,
            duration_secs: f.duration_secs,
            completed: f.completed,
            updated_at: at,
        };
        match history::merge(conn, &carried)? {
            Merged::Kept => report.kept += 1,
            Merged::Resume => report.resume += 1,
            Merged::Watched => {
                report.watched += 1;
                let (imdb, tmdb) = (carried.imdb_id.as_deref(), carried.tmdb_id.as_deref());
                if simkl && tracking::queue(conn, SIMKL, &f.kind, imdb, tmdb, f.season, f.episode, at)? {
                    report.queued += 1;
                }
            }
        }
    }
    if trakt && report.watched > 0 {
        tracking::store(conn, crate::trakt::HISTORY_DUE_KEY, "1").map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(e.into())
        })?;
    }
    Ok(report)
}

// ---- Kodi ------------------------------------------------------------------------

/// Kodi's `lastPlayed`, `2024-01-02 20:15:00`.
fn kodi_time(text: Option<String>) -> Option<i64> {
    tracking::parse_iso8601(&text?.replacen(' ', "T", 1))
}

/// Everything watched or begun in Kodi's video database (`MyVideos*.db`),
/// read-only. Ids from its `uniqueid` table (Kodi 17 and later); a film's
/// IMDb number from `c09` before that.
pub fn read_kodi(path: &Path) -> Result<Vec<Found>, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("Kodi's database could not be opened: {e}"))?;
    let has = |table: &str| -> bool {
        conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [table], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    };
    if !has("movie") || !has("files") || !has("episode") {
        return Err("This is not Kodi's video database (MyVideos…db).".into());
    }
    let uniqueid = has("uniqueid");
    let id_of = |kind: &str, of: &str| {
        if uniqueid {
            format!("(SELECT value FROM uniqueid u WHERE u.media_id = {of} AND u.media_type = '{kind}' AND u.type = ?1 LIMIT 1)")
        } else {
            "NULL".to_string()
        }
    };
    let resume = "(SELECT timeInSeconds FROM bookmark b WHERE b.idFile = f.idFile AND b.type = 1 LIMIT 1)";
    let total = "(SELECT totalTimeInSeconds FROM bookmark b WHERE b.idFile = f.idFile AND b.type = 1 LIMIT 1)";
    let mut out = Vec::new();
    let to = |e: rusqlite::Error| format!("Kodi's database could not be read: {e}");

    let films = format!(
        "SELECT m.c00, CAST(substr(COALESCE(m.premiered, ''), 1, 4) AS INTEGER),
                COALESCE({imdb}, CASE WHEN m.c09 LIKE 'tt%' THEN m.c09 END), {tmdb},
                COALESCE(f.playCount, 0), f.lastPlayed, {resume}, {total}
           FROM movie m JOIN files f ON f.idFile = m.idFile",
        imdb = id_of("movie", "m.idMovie").replace("?1", "'imdb'"),
        tmdb = id_of("movie", "m.idMovie").replace("?1", "'tmdb'"),
    );
    let mut stmt = conn.prepare(&films).map_err(to)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<f64>>(6)?,
                r.get::<_, Option<f64>>(7)?,
            ))
        })
        .map_err(to)?;
    for row in rows {
        let (name, year, im, tm, plays, last, pos, dur) = row.map_err(to)?;
        out.push(Found {
            kind: "movie".into(),
            imdb_id: imdb(im.as_deref()),
            tmdb_id: tmdb(tm.as_deref()),
            label: label("movie", &name.unwrap_or_default(), year, None, None),
            completed: plays > 0,
            position_secs: pos.unwrap_or(0.0),
            duration_secs: dur.filter(|d| *d > 0.0),
            at: kodi_time(last),
            ..Found::default()
        });
    }

    let episodes = format!(
        "SELECT s.c00, CAST(e.c12 AS INTEGER), CAST(e.c13 AS INTEGER), {imdb}, {tmdb},
                COALESCE(f.playCount, 0), f.lastPlayed, {resume}, {total}
           FROM episode e JOIN files f ON f.idFile = e.idFile
           JOIN tvshow s ON s.idShow = e.idShow",
        imdb = id_of("tvshow", "s.idShow").replace("?1", "'imdb'"),
        tmdb = id_of("tvshow", "s.idShow").replace("?1", "'tmdb'"),
    );
    let mut stmt = conn.prepare(&episodes).map_err(to)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<f64>>(7)?,
                r.get::<_, Option<f64>>(8)?,
            ))
        })
        .map_err(to)?;
    for row in rows {
        let (name, season, episode, im, tm, plays, last, pos, dur) = row.map_err(to)?;
        out.push(Found {
            kind: "series".into(),
            imdb_id: imdb(im.as_deref()),
            tmdb_id: tmdb(tm.as_deref()),
            season,
            episode,
            label: label("series", &name.unwrap_or_default(), None, season, episode),
            completed: plays > 0,
            position_secs: pos.unwrap_or(0.0),
            duration_secs: dur.filter(|d| *d > 0.0),
            at: kodi_time(last),
        });
    }
    Ok(out)
}

/// Kodi's video database on this computer, the newest version, if Kodi is
/// installed in its usual place.
pub fn kodi_database_here() -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("Kodi/userdata/Database"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".kodi/userdata/Database"));
        dirs.push(home.join(".var/app/tv.kodi.Kodi/data/userdata/Database"));
    }
    let version = |p: &Path| -> Option<u32> {
        let name = p.file_name()?.to_str()?;
        name.strip_prefix("MyVideos")?.strip_suffix(".db")?.parse().ok()
    };
    dirs.iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flat_map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())))
        .filter_map(|p| version(&p).map(|v| (v, p)))
        .max_by_key(|(v, _)| *v)
        .map(|(_, p)| p)
}

// ---- Trakt's export ----------------------------------------------------------------

fn ids_of(v: &Value) -> (Option<String>, Option<String>) {
    let ids = &v["ids"];
    let tm = match &ids["tmdb"] {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    };
    (imdb(ids["imdb"].as_str()), tmdb(tm.as_deref()))
}

/// Trakt's export files: watched films and shows (`plays`, `last_watched_at`)
/// or the history (`watched_at`). Ratings, lists and the watchlist are not
/// watches and are passed over; so is `playback`, a percentage with no length.
pub fn parse_trakt(json: &Value) -> Vec<Found> {
    let mut out = Vec::new();
    let Some(items) = json.as_array() else { return out };
    let time = |v: &Value| v.as_str().and_then(tracking::parse_iso8601);
    for item in items {
        let when = item.get("watched_at").or(item.get("last_watched_at"));
        if let (Some(movie), Some(when)) = (item.get("movie"), when) {
            let (im, tm) = ids_of(movie);
            out.push(Found {
                kind: "movie".into(),
                imdb_id: im,
                tmdb_id: tm,
                label: label("movie", movie["title"].as_str().unwrap_or(""), movie["year"].as_i64(), None, None),
                completed: true,
                at: time(when),
                ..Found::default()
            });
            continue;
        }
        let Some(show) = item.get("show") else { continue };
        let (im, tm) = ids_of(show);
        let name = show["title"].as_str().unwrap_or("");
        let mut push = |season: Option<i64>, episode: Option<i64>, at: Option<i64>| {
            out.push(Found {
                kind: "series".into(),
                imdb_id: im.clone(),
                tmdb_id: tm.clone(),
                season,
                episode,
                label: label("series", name, None, season, episode),
                completed: true,
                at,
                ..Found::default()
            });
        };
        if let (Some(ep), Some(when)) = (item.get("episode"), item.get("watched_at")) {
            push(ep["season"].as_i64(), ep["number"].as_i64(), time(when));
        } else if let Some(seasons) = item["seasons"].as_array() {
            for s in seasons {
                for e in s["episodes"].as_array().into_iter().flatten() {
                    push(s["number"].as_i64(), e["number"].as_i64(), time(&e["last_watched_at"]));
                }
            }
        }
    }
    out
}

// ---- Jellyfin and Emby ---------------------------------------------------------

const TICKS: f64 = 10_000_000.0;

/// The ids the server has for each show, by its item id.
pub fn jellyfin_series(items: &[Value]) -> HashMap<String, (Option<String>, Option<String>)> {
    items
        .iter()
        .filter_map(|s| {
            let p = &s["ProviderIds"];
            Some((s["Id"].as_str()?.to_string(), (imdb(p["Imdb"].as_str()), tmdb(p["Tmdb"].as_str()))))
        })
        .collect()
}

/// A Jellyfin or Emby server's films and episodes, with the user's data.
pub fn parse_jellyfin(items: &[Value], series: &HashMap<String, (Option<String>, Option<String>)>) -> Vec<Found> {
    let mut out = Vec::new();
    for it in items {
        let data = &it["UserData"];
        let completed = data["Played"].as_bool().unwrap_or(false);
        let position = data["PlaybackPositionTicks"].as_f64().unwrap_or(0.0) / TICKS;
        let at = data["LastPlayedDate"].as_str().and_then(tracking::parse_iso8601);
        let duration = it["RunTimeTicks"].as_f64().map(|t| t / TICKS).filter(|d| *d > 0.0);
        let name = it["Name"].as_str().unwrap_or("");
        match it["Type"].as_str() {
            Some("Movie") => {
                let p = &it["ProviderIds"];
                out.push(Found {
                    kind: "movie".into(),
                    imdb_id: imdb(p["Imdb"].as_str()),
                    tmdb_id: tmdb(p["Tmdb"].as_str()),
                    label: label("movie", name, it["ProductionYear"].as_i64(), None, None),
                    completed,
                    position_secs: position,
                    duration_secs: duration,
                    at,
                    ..Found::default()
                });
            }
            Some("Episode") => {
                let (im, tm) = it["SeriesId"]
                    .as_str()
                    .and_then(|id| series.get(id).cloned())
                    .unwrap_or((None, None));
                let season = it["ParentIndexNumber"].as_i64();
                let first = it["IndexNumber"].as_i64();
                let last = it["IndexNumberEnd"].as_i64().or(first).max(first);
                let show = it["SeriesName"].as_str().unwrap_or(name);
                for episode in first.into_iter().flat_map(|f| f..=last.unwrap_or(f)) {
                    out.push(Found {
                        kind: "series".into(),
                        imdb_id: im.clone(),
                        tmdb_id: tm.clone(),
                        season,
                        episode: Some(episode),
                        label: label("series", show, None, season, Some(episode)),
                        completed,
                        position_secs: position,
                        duration_secs: duration,
                        at,
                    });
                }
                if first.is_none() {
                    out.push(Found {
                        kind: "series".into(),
                        label: show.to_string(),
                        completed,
                        position_secs: position,
                        ..Found::default()
                    });
                }
            }
            _ => {}
        }
    }
    out
}

// ---- Plex ----------------------------------------------------------------------------

fn plex_ids(v: &Value) -> (Option<String>, Option<String>) {
    let mut out = (None, None);
    for g in v["Guid"].as_array().into_iter().flatten() {
        let id = g["id"].as_str().unwrap_or("");
        if let Some(i) = id.strip_prefix("imdb://") {
            out.0 = imdb(Some(i));
        } else if let Some(t) = id.strip_prefix("tmdb://") {
            out.1 = tmdb(Some(t));
        }
    }
    out
}

fn plex_items(v: &Value) -> &[Value] {
    v["MediaContainer"]["Metadata"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// The ids Plex has for each show, by its `ratingKey`.
pub fn plex_shows(shows: &Value) -> HashMap<String, (Option<String>, Option<String>)> {
    plex_items(shows)
        .iter()
        .filter_map(|s| Some((s["ratingKey"].as_str()?.to_string(), plex_ids(s))))
        .collect()
}

/// A Plex section's films (`type=1`) or episodes (`type=4`), `includeGuids=1`.
pub fn parse_plex(items: &Value, shows: &HashMap<String, (Option<String>, Option<String>)>) -> Vec<Found> {
    let mut out = Vec::new();
    for it in plex_items(items) {
        let completed = it["viewCount"].as_i64().unwrap_or(0) > 0;
        let position = it["viewOffset"].as_f64().unwrap_or(0.0) / 1000.0;
        let duration = it["duration"].as_f64().map(|d| d / 1000.0).filter(|d| *d > 0.0);
        let at = it["lastViewedAt"].as_i64();
        let name = it["title"].as_str().unwrap_or("");
        match it["type"].as_str() {
            Some("movie") => {
                let (im, tm) = plex_ids(it);
                out.push(Found {
                    kind: "movie".into(),
                    imdb_id: im,
                    tmdb_id: tm,
                    label: label("movie", name, it["year"].as_i64(), None, None),
                    completed,
                    position_secs: position,
                    duration_secs: duration,
                    at,
                    ..Found::default()
                });
            }
            Some("episode") => {
                let (im, tm) = it["grandparentRatingKey"]
                    .as_str()
                    .and_then(|k| shows.get(k).cloned())
                    .unwrap_or((None, None));
                let (season, episode) = (it["parentIndex"].as_i64(), it["index"].as_i64());
                let show = it["grandparentTitle"].as_str().unwrap_or(name);
                out.push(Found {
                    kind: "series".into(),
                    imdb_id: im,
                    tmdb_id: tm,
                    season,
                    episode,
                    label: label("series", show, None, season, episode),
                    completed,
                    position_secs: position,
                    duration_secs: duration,
                    at,
                });
            }
            _ => {}
        }
    }
    out
}

// ---- reading a server, once ---------------------------------------------------------

async fn get_json(url: &str, headers: &[(&str, &str)]) -> Result<Value, String> {
    let client = tracking::http().ok_or("Kinema could not make a web request.")?;
    let mut req = client.get(url).header("Accept", "application/json");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let resp = req.send().await.map_err(|e| format!("The server did not answer ({e})."))?;
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err("The server refused the key.".into());
    }
    if !(200..300).contains(&status) {
        return Err(format!("The server answered {status}."));
    }
    let text = resp.text().await.map_err(|e| format!("The server's answer could not be read ({e})."))?;
    serde_json::from_str(&text).map_err(|e| format!("The server's answer could not be read ({e})."))
}

async fn read_jellyfin(base: &str, key: &str, user: &str) -> Result<Vec<Found>, String> {
    let headers = [("X-Emby-Token", key)];
    let users = get_json(&format!("{base}/Users"), &headers).await?;
    let users = users.as_array().cloned().unwrap_or_default();
    let wanted = user.trim();
    let chosen: Vec<_> = users
        .iter()
        .filter(|u| wanted.is_empty() || u["Name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(wanted)))
        .collect();
    let uid = match chosen.as_slice() {
        [one] => one["Id"].as_str().unwrap_or_default().to_string(),
        [] if !wanted.is_empty() => return Err(format!("The server has no user called {wanted}.")),
        _ => {
            let names: Vec<_> = users.iter().filter_map(|u| u["Name"].as_str()).collect();
            return Err(format!("The server has several users ({}): type whose history to bring in.", names.join(", ")));
        }
    };
    let mut items = Vec::new();
    for filter in ["IsPlayed", "IsResumable"] {
        let mut start = 0;
        loop {
            let page = get_json(
                &format!(
                    "{base}/Users/{uid}/Items?Recursive=true&IncludeItemTypes=Movie,Episode\
                     &Filters={filter}&Fields=ProviderIds&EnableUserData=true&StartIndex={start}&Limit=500"
                ),
                &headers,
            )
            .await?;
            let got = page["Items"].as_array().cloned().unwrap_or_default();
            let n = got.len();
            items.extend(got);
            start += n;
            if n == 0 || start as i64 >= page["TotalRecordCount"].as_i64().unwrap_or(0) {
                break;
            }
        }
    }
    let mut ids: Vec<&str> = items.iter().filter_map(|i| i["SeriesId"].as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    let mut series = HashMap::new();
    for chunk in ids.chunks(100) {
        let page = get_json(
            &format!("{base}/Users/{uid}/Items?Ids={}&Fields=ProviderIds", chunk.join(",")),
            &headers,
        )
        .await?;
        series.extend(jellyfin_series(page["Items"].as_array().map(Vec::as_slice).unwrap_or(&[])));
    }
    Ok(parse_jellyfin(&items, &series))
}

async fn read_plex(base: &str, token: &str) -> Result<Vec<Found>, String> {
    let headers = [("X-Plex-Token", token)];
    let sections = get_json(&format!("{base}/library/sections"), &headers).await?;
    let mut out = Vec::new();
    for dir in sections["MediaContainer"]["Directory"].as_array().into_iter().flatten() {
        let Some(key) = dir["key"].as_str() else { continue };
        let all = |t: u8| format!("{base}/library/sections/{key}/all?type={t}&includeGuids=1");
        match dir["type"].as_str() {
            Some("movie") => out.extend(parse_plex(&get_json(&all(1), &headers).await?, &HashMap::new())),
            Some("show") => {
                let shows = plex_shows(&get_json(&all(2), &headers).await?);
                out.extend(parse_plex(&get_json(&all(4), &headers).await?, &shows));
            }
            _ => {}
        }
    }
    Ok(out)
}

// ---- commands ----------------------------------------------------------------------------

fn take_in(app: &tauri::AppHandle, found: &[Found]) -> Result<Report, String> {
    use tauri::Manager;
    let report = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        apply(&conn, found).map_err(to_string_err)?
    };
    crate::log!(
        "import: {} read, {} watched, {} resume points, {} kept, {} not in the library, {} unclear, {} queued",
        report.read, report.watched, report.resume, report.kept,
        report.not_in_library.len(), report.unclear.len(), report.queued
    );
    if report.watched > 0 {
        crate::simkl::send_soon(app);
        crate::trakt::send_soon(app);
    }
    Ok(report)
}

/// Kodi's database on this computer, when it has one.
#[tauri::command]
pub fn kodi_database() -> Option<String> {
    kodi_database_here().map(|p| p.to_string_lossy().into_owned())
}

/// A file: Kodi's database, or a Trakt export (`.json`).
#[tauri::command]
pub async fn import_watched_file(app: tauri::AppHandle, path: String) -> Result<Report, String> {
    let path = PathBuf::from(path);
    let head = std::fs::read(&path).map_err(|e| format!("The file could not be read: {e}"))?;
    let found = if head.starts_with(b"SQLite format 3") {
        read_kodi(&path)?
    } else {
        let json: Value = serde_json::from_slice(&head)
            .map_err(|_| "This is neither Kodi's database nor a Trakt export file.".to_string())?;
        parse_trakt(&json)
    };
    take_in(&app, &found)
}

/// A Jellyfin, Emby or Plex server, read once. The key is used for these
/// requests and kept nowhere.
#[tauri::command]
pub async fn import_watched_server(
    app: tauri::AppHandle,
    kind: String,
    url: String,
    key: String,
    user: String,
) -> Result<Report, String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("Start the server's address with http or https.".into());
    }
    let found = match kind.as_str() {
        "plex" => read_plex(&base, key.trim()).await?,
        _ => read_jellyfin(&base, key.trim(), &user).await?,
    };
    take_in(&app, &found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn library() -> Connection {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pn-import-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("library.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:/v', 'movies', 0);
             INSERT INTO titles (id, kind, provider, provider_id, imdb_id, tmdb_id, title, fetched_at) VALUES
                (1, 'movie', 'tmdb', '100', 'tt0000100', '100', 'Example Film', 0),
                (2, 'series', 'tmdb', '200', 'tt0000200', '200', 'Example Show', 0),
                (3, 'movie', 'tmdb', '300', 'tt0000300', '300', 'Other Film', 0);
             INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension, size_bytes,
                 modified_at, first_seen_at, last_seen_at, match_status, title_id, parsed_title,
                 parsed_season, parsed_episode) VALUES
                (1, 1, 'C:/v/a.mkv', 'C:/v', 'a.mkv', 'mkv', 1, 0, 0, 0, 'matched', 1, 'a', NULL, NULL),
                (2, 1, 'C:/v/s1e2.mkv', 'C:/v', 's1e2.mkv', 'mkv', 1, 0, 0, 0, 'matched', 2, 's', 1, 2);",
        )
        .unwrap();
        conn
    }

    fn film(imdb_id: Option<&str>, tmdb_id: Option<&str>, completed: bool, pos: f64) -> Found {
        Found {
            kind: "movie".into(),
            imdb_id: imdb_id.map(Into::into),
            tmdb_id: tmdb_id.map(Into::into),
            label: "x".into(),
            completed,
            position_secs: pos,
            at: Some(1_000),
            ..Found::default()
        }
    }

    fn own(conn: &Connection, file: i64) -> Option<(f64, i64)> {
        conn.query_row(
            "SELECT position_secs, completed FROM playback_state WHERE file_id = ?1",
            [file],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap()
    }

    fn outbox(conn: &Connection) -> Vec<(String, String)> {
        let mut s = conn.prepare("SELECT service, key FROM watch_outbox ORDER BY id").unwrap();
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
    }

    fn connect(conn: &Connection, service: &str) {
        crate::tracking::save_tokens(
            conn,
            service,
            &crate::tracking::Tokens { access: "a".into(), refresh: "r".into(), expires_at: i64::MAX },
        )
        .unwrap();
    }

    #[test]
    fn matched_by_either_id_and_given_to_the_file() {
        let conn = library();
        let r = apply(&conn, &[film(None, Some("100"), true, 0.0)]).unwrap();
        assert_eq!((r.watched, r.read), (1, 1));
        assert_eq!(own(&conn, 1), Some((0.0, 1)));

        let mut ep = film(Some("tt0000200"), None, false, 600.0);
        ep.kind = "series".into();
        ep.season = Some(1);
        ep.episode = Some(2);
        let r = apply(&conn, &[ep]).unwrap();
        assert_eq!(r.resume, 1);
        assert_eq!(own(&conn, 2), Some((600.0, 0)));
    }

    #[test]
    fn nothing_is_guessed() {
        let conn = library();
        let r = apply(
            &conn,
            &[
                film(None, None, true, 0.0),                       // no ids
                film(Some("tt0000100"), Some("300"), true, 0.0),   // ids of two titles
                film(Some("tt9999999"), None, true, 0.0),          // not here
            ],
        )
        .unwrap();
        assert_eq!(r.watched, 0);
        assert_eq!(r.unclear.len(), 1, "same label listed once");
        assert_eq!(r.not_in_library.len(), 1);
        assert_eq!(own(&conn, 1), None);
        // A film's TMDB number is not a show's.
        let mut tv = film(None, Some("100"), true, 0.0);
        tv.kind = "series".into();
        tv.season = Some(1);
        tv.episode = Some(1);
        assert_eq!(apply(&conn, &[tv]).unwrap().not_in_library.len(), 1);
    }

    #[test]
    fn never_unwatches_and_an_older_resume_point_loses() {
        let conn = library();
        apply(&conn, &[film(None, Some("100"), true, 0.0)]).unwrap();
        let r = apply(&conn, &[film(None, Some("100"), false, 500.0)]).unwrap();
        assert_eq!(r.kept, 1);
        assert_eq!(own(&conn, 1), Some((0.0, 1)));
    }

    #[test]
    fn imported_watches_go_once_and_never_twice() {
        let conn = library();
        // Not connected: nothing queued.
        apply(&conn, &[film(None, Some("300"), true, 0.0)]).unwrap();
        assert!(outbox(&conn).is_empty());

        connect(&conn, SIMKL);
        connect(&conn, TRAKT);
        let r = apply(&conn, &[film(None, Some("100"), true, 0.0)]).unwrap();
        assert_eq!(r.queued, 1);
        // SIMKL queued; Trakt only after comparing with the account.
        assert_eq!(outbox(&conn).iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>(), vec![SIMKL]);
        assert!(crate::settings::setting(&conn, crate::trakt::HISTORY_DUE_KEY).is_some());

        // The same file again, after the send: nothing new goes.
        conn.execute("DELETE FROM watch_outbox", []).unwrap();
        crate::tracking::clear(&conn, crate::trakt::HISTORY_DUE_KEY).unwrap();
        let r = apply(&conn, &[film(None, Some("100"), true, 0.0), film(None, Some("300"), true, 0.0)]).unwrap();
        assert_eq!((r.watched, r.kept, r.queued), (0, 2, 0));
        assert!(outbox(&conn).is_empty());
        assert!(crate::settings::setting(&conn, crate::trakt::HISTORY_DUE_KEY).is_none());
    }

    #[test]
    fn kodi_database_is_read() {
        let dir = std::env::temp_dir().join(format!("pn-kodi-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("MyVideos131.db");
        let k = Connection::open(&path).unwrap();
        k.execute_batch(
            "CREATE TABLE files (idFile INTEGER PRIMARY KEY, playCount INTEGER, lastPlayed TEXT);
             CREATE TABLE movie (idMovie INTEGER PRIMARY KEY, idFile INTEGER, c00 TEXT, c09 TEXT, premiered TEXT);
             CREATE TABLE tvshow (idShow INTEGER PRIMARY KEY, c00 TEXT);
             CREATE TABLE episode (idEpisode INTEGER PRIMARY KEY, idFile INTEGER, idShow INTEGER, c12 TEXT, c13 TEXT);
             CREATE TABLE uniqueid (media_id INTEGER, media_type TEXT, value TEXT, type TEXT);
             CREATE TABLE bookmark (idFile INTEGER, timeInSeconds REAL, totalTimeInSeconds REAL, type INTEGER);
             INSERT INTO files VALUES (1, 1, '2024-01-02 20:15:00'), (2, NULL, NULL), (3, NULL, NULL);
             INSERT INTO movie VALUES (1, 1, 'Example Film', 'tt0000100', '2001-05-01'),
                                      (2, 2, 'Other Film', '', '2002');
             INSERT INTO uniqueid VALUES (2, 'movie', '300', 'tmdb'), (1, 'tvshow', '200', 'tmdb');
             INSERT INTO tvshow VALUES (1, 'Example Show');
             INSERT INTO episode VALUES (1, 3, 1, '1', '2');
             INSERT INTO bookmark VALUES (2, 120.5, 6000, 1), (3, 60, 1800, 1);",
        )
        .unwrap();
        drop(k);
        let found = read_kodi(&path).unwrap();
        assert_eq!(found.len(), 3);
        assert_eq!(found[0].imdb_id.as_deref(), Some("tt0000100"));
        assert!(found[0].completed);
        assert_eq!(found[0].at, tracking::parse_iso8601("2024-01-02T20:15:00Z"));
        assert_eq!((found[1].tmdb_id.as_deref(), found[1].position_secs), (Some("300"), 120.5));
        assert_eq!((found[2].season, found[2].episode, found[2].tmdb_id.as_deref()), (Some(1), Some(2), Some("200")));
        let r = apply(&library(), &found).unwrap();
        assert_eq!((r.watched, r.resume), (1, 2));
    }

    #[test]
    fn trakt_export_reads_watches_only() {
        let json = json!([
            {"plays": 2, "last_watched_at": "2020-01-01T00:00:00.000Z",
             "movie": {"title": "Example Film", "year": 2001, "ids": {"imdb": "tt0000100", "tmdb": 100}}},
            {"rated_at": "2020-01-01T00:00:00.000Z", "rating": 8,
             "movie": {"title": "Rated", "ids": {"tmdb": 5}}},
            {"watched_at": "2020-01-02T00:00:00.000Z", "type": "episode",
             "episode": {"season": 1, "number": 2}, "show": {"title": "Example Show", "ids": {"tmdb": 200}}},
            {"show": {"title": "Example Show", "ids": {"tmdb": 200}},
             "seasons": [{"number": 1, "episodes": [{"number": 3, "last_watched_at": "2020-01-03T00:00:00Z"}]}]}
        ]);
        let found = parse_trakt(&json);
        assert_eq!(found.len(), 3);
        assert_eq!(found[0].label, "Example Film (2001)");
        assert_eq!(found[1].label, "Example Show S01E02");
        assert_eq!((found[2].episode, found[2].tmdb_id.as_deref()), (Some(3), Some("200")));
    }

    #[test]
    fn jellyfin_and_plex_answers_are_read() {
        let series = jellyfin_series(&[json!({"Id": "s1", "ProviderIds": {"Tmdb": "200", "Imdb": "tt0000200"}})]);
        let found = parse_jellyfin(
            &[
                json!({"Type": "Movie", "Name": "Example Film", "ProductionYear": 2001,
                       "ProviderIds": {"Imdb": "tt0000100"}, "RunTimeTicks": 60_000_000_000_i64,
                       "UserData": {"Played": true, "LastPlayedDate": "2024-01-02T20:15:00.0000000Z"}}),
                json!({"Type": "Episode", "SeriesId": "s1", "SeriesName": "Example Show",
                       "ParentIndexNumber": 1, "IndexNumber": 2, "IndexNumberEnd": 3,
                       "UserData": {"Played": false, "PlaybackPositionTicks": 6_000_000_000_i64}}),
            ],
            &series,
        );
        assert_eq!(found.len(), 3);
        assert!(found[0].completed && found[0].duration_secs == Some(6000.0));
        assert_eq!((found[2].episode, found[2].position_secs), (Some(3), 600.0));

        let shows = plex_shows(&json!({"MediaContainer": {"Metadata": [
            {"ratingKey": "7", "Guid": [{"id": "tmdb://200"}, {"id": "tvdb://1"}]}]}}));
        let found = parse_plex(
            &json!({"MediaContainer": {"Metadata": [
                {"type": "movie", "title": "Example Film", "year": 2001, "viewCount": 1, "lastViewedAt": 99,
                 "Guid": [{"id": "imdb://tt0000100"}]},
                {"type": "episode", "grandparentRatingKey": "7", "grandparentTitle": "Example Show",
                 "parentIndex": 1, "index": 2, "viewOffset": 600000, "duration": 1800000}]}}),
            &shows,
        );
        assert_eq!(found[0].imdb_id.as_deref(), Some("tt0000100"));
        assert_eq!((found[1].tmdb_id.as_deref(), found[1].position_secs), (Some("200"), 600.0));
    }
}
