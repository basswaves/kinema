//! Where skip markers come from, and which source wins.
//!
//! Five sources, ranked per segment rather than overall, because they are good
//! at different things:
//!
//! | | intro | credits | recap | scene after the credits |
//! |---|---|---|---|---|
//! | **Skiptro's database** | 1st — measured on *this* file | never has any | — | — |
//! | **`.skiptro.json` sidecar** | 2nd — same detection, exported | 1st, if a producer ever writes one | — | — |
//! | **This app's own analysis** | 3rd — measured on this file too | 2nd, and the one that usually answers | — | — |
//! | **TheIntroDB** | 4th — community-timed | 3rd | 1st | never has any |
//! | **IntroDB.app** | 5th — community-timed | 4th | 2nd | the only source, films only |
//!
//! Recaps and the scene after a film's credits come only from the two
//! community services: nothing local detects either. Between those two,
//! TheIntroDB is asked first because it is told the file's length and uses it
//! to tell releases apart; IntroDB.app is not.
//!
//! **One rule, applied to both segments: local before remote.** Something
//! measured against the actual bytes on this disk beats something timed by
//! somebody against *a* copy of the episode. That is the same judgement the
//! credits ladder in `skip.ts` already makes, and it is why the order does not
//! change between segments — only which sources have anything to say does.
//!
//! Skiptro sits above `analyse.rs` for the intro by decision rather than by
//! measurement: both fingerprint this exact file, Skiptro has years of tuning
//! behind it, and ranking the newer one second means it cannot regress an intro
//! skip that already works. **Only where Skiptro is sure**, though: measured on
//! this library they disagreed on 34 of 61 episodes, and every large
//! disagreement was one Skiptro scored 0.70 or less — so below
//! [`MIN_SKIPTRO_CONFIDENCE`] the analysis answers. `app.log` names which spoke.
//!
//! Below it, in `skip.ts`, everything is inference: a chapter name, then a
//! fixed tail, each fenced accordingly.
//!
//! Sidecars are no longer produced by default, but are still read. They are how
//! this worked before, any other tool can write them, and dropping the reader
//! would break a library that already has them for no gain.
//!
//! Every source is optional and every failure is silent-but-logged. With
//! Skiptro never installed, both community services switched off and no
//! sidecars, this returns nothing and the player behaves exactly as it did
//! before any of it existed.

use crate::util::{now_secs, to_string_err};
use crate::introdb::{self, Lookup};
use crate::introdb_app;
use crate::library::Db;
use crate::settings::setting;
use crate::skiptro;
use rusqlite::params;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

/// Segment names accepted for the closing segment in a sidecar. Skiptro's own
/// naming is confirmed only for `intro`.
const CREDITS_KEYS: [&str; 3] = ["credits", "outro", "ending"];

/// Names for the sources, as stored and as shown in the log. Short strings
/// rather than an enum because they cross into the database and into TypeScript,
/// and three places agreeing on a spelling is cheaper than three enums.
const FROM_SKIPTRO_DB: &str = "skiptro-db";
const FROM_SIDECAR: &str = "sidecar";
const FROM_ANALYSIS: &str = "analysis";
const FROM_INTRODB: &str = "introdb";
/// IntroDB.app — a different service from TheIntroDB, whatever the names say.
const FROM_INTRODB_APP: &str = "introdb-app";

/// Below this, a Skiptro intro gives way to this app's own analysis.
///
/// Measured, not guessed (2026-09-23, docs/HISTORY.md): across 79 detections,
/// every one where the two detectors disagreed by more than a few seconds had a
/// Skiptro confidence of 0.70 or less, and every confident one agreed. So
/// Skiptro keeps first place wherever it is sure, which is the decision, and
/// steps back only where it said itself that it was not.
const MIN_SKIPTRO_CONFIDENCE: f64 = 0.8;

/// Changes whenever the *ranking* changes, so rows cached under the old rules
/// are recomputed. Without it `local_key` covers every input but the code, and
/// a new rule would not reach an episode until one of its sources moved.
const RANKING_VERSION: &str = "rank3";

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Segment {
    pub start: f64,
    /// `None` means "to the end of the file", which is what credits do and what
    /// TheIntroDB says with a null of its own. An **intro** always has a real
    /// end — one without somewhere to seek to is dropped at every source, so
    /// the player never has to handle the case.
    pub end: Option<f64>,
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct SkipMarkers {
    pub intro: Option<Segment>,
    /// Which source the intro came from, so a skip that fires somewhere
    /// surprising can be traced to the thing that claimed it.
    pub intro_source: Option<String>,
    /// "Previously on…". Always with a real end, like the intro.
    pub recap: Option<Segment>,
    pub recap_source: Option<String>,
    pub credits: Option<Segment>,
    pub credits_source: Option<String>,
    /// A film's scene after the credits, always with a real end. Whether it
    /// actually follows *these* credits, in *this* file, is checked in
    /// `skip.ts`, which knows the file's length.
    pub post_credits: Option<Segment>,
    pub post_credits_source: Option<String>,
}

impl SkipMarkers {
    fn is_empty(&self) -> bool {
        self.intro.is_none()
            && self.recap.is_none()
            && self.credits.is_none()
            && self.post_credits.is_none()
    }

    /// Fill whatever is still missing from one community service's answer.
    ///
    /// Called once per service, in rank order, after every local source has
    /// had its turn — so a community timing never displaces a measurement of
    /// this file, and the first service to answer a segment keeps it.
    fn fill_from(&mut self, found: &Lookup, source: &str) {
        let closed = |(start, end): (f64, f64)| Segment { start, end: Some(end) };
        if self.credits.is_none() {
            if let Some((start, end)) = found.credits {
                self.credits = Some(Segment { start, end });
                self.credits_source = Some(source.into());
            }
        }
        if self.intro.is_none() {
            if let Some(intro) = found.intro {
                self.intro = Some(closed(intro));
                self.intro_source = Some(source.into());
            }
        }
        if self.recap.is_none() {
            if let Some(recap) = found.recap {
                self.recap = Some(closed(recap));
                self.recap_source = Some(source.into());
            }
        }
        if self.post_credits.is_none() {
            if let Some(scene) = found.post_credits {
                self.post_credits = Some(closed(scene));
                self.post_credits_source = Some(source.into());
            }
        }
    }
}

// ---- sidecars --------------------------------------------------------------

/// Where a sidecar might live for a given video.
///
/// Both conventions are checked because the producer decides: replacing the
/// extension (`Episode.skiptro.json`) and appending to the whole filename
/// (`Episode.mkv.skiptro.json`) are both common for sidecars.
fn candidate_paths(video: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(stem) = video.file_stem() {
        let mut name = stem.to_os_string();
        name.push(".skiptro.json");
        paths.push(video.with_file_name(name));
    }

    if let Some(file_name) = video.file_name() {
        let mut name = file_name.to_os_string();
        name.push(".skiptro.json");
        paths.push(video.with_file_name(name));
    }

    paths
}

/// Pull `{ "start": <secs>, "end": <secs> }` out of a value. A segment with
/// end <= start is rejected: it would either do nothing or seek backwards.
fn parse_segment(value: &serde_json::Value) -> Option<Segment> {
    let start = value.get("start")?.as_f64()?;
    let end = value.get("end")?.as_f64()?;

    if !start.is_finite() || !end.is_finite() || end <= start || start < 0.0 {
        return None;
    }
    Some(Segment {
        start,
        end: Some(end),
    })
}

/// The intro and credits a sidecar carries, if any.
fn parse_sidecar(raw: &str, path: &Path) -> (Option<Segment>, Option<Segment>) {
    let parsed: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            crate::log!("skip: {} is not valid JSON: {e}", path.display());
            return (None, None);
        }
    };

    let intro = parsed.get("intro").and_then(parse_segment);
    let credits = CREDITS_KEYS
        .iter()
        .find_map(|key| parsed.get(*key).and_then(parse_segment));

    if intro.is_none() && credits.is_none() {
        // The file is there but says nothing we understand. Report the keys it
        // does have — that is the fastest route to supporting the real format.
        let keys: Vec<&str> = parsed
            .as_object()
            .map(|o| o.keys().map(|k| k.as_str()).collect())
            .unwrap_or_default();
        crate::log!(
            "skip: no usable segments in {} — top-level keys: {:?}",
            path.display(),
            keys
        );
    }

    (intro, credits)
}

struct Sidecar {
    path: PathBuf,
    size: i64,
    mtime: i64,
}

fn find_sidecar(video: &Path) -> Option<Sidecar> {
    for path in candidate_paths(video) {
        let Some(path) = crate::util::existing_file(&path) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        return Some(Sidecar {
            path,
            size: meta.len() as i64,
            mtime,
        });
    }
    None
}

// ---- cache -----------------------------------------------------------------

/// What the local sources looked like. When this string changes, they are read
/// again; when it does not, one database row answers the whole question.
///
/// It covers both local sources at once, deliberately. They are cheap to read
/// and re-reading one needlessly costs nothing, while *missing* a change costs
/// a marker that never appears.
///
/// **The video's own bytes are in here too**, and they are the one input that
/// is not a source. Every other guard against a replaced file goes through the
/// scanner: `read_analysis` compares against `media_files`, and the scanner
/// clears what it must when a size changes. None of that has happened yet for a
/// file replaced *since the last scan* — and if nothing else moved, the key was
/// identical and this served markers measured against bytes that are gone. It
/// costs one `stat`, next to the one `find_sidecar` already does.
///
/// `remotes` names the community services that are switched on. A row written
/// while one was on carries its segments, and without this it would go on
/// serving them after the service was switched off — until something local
/// happened to move.
fn local_key(
    video: &Path,
    skiptro_db: Option<&Path>,
    sidecar: Option<&Sidecar>,
    analysed_at: Option<i64>,
    remotes: &str,
) -> String {
    let file = std::fs::metadata(video)
        .map(|m| {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("{}:{}", m.len(), mtime)
        })
        .unwrap_or_default();
    let db = skiptro_db.map(skiptro::version_stamp).unwrap_or_default();
    let side = sidecar
        .map(|s| format!("{}:{}:{}", s.path.display(), s.size, s.mtime))
        .unwrap_or_default();
    // A fresh analysis has to invalidate the cache too, or running Detect would
    // leave the file playing with whatever it was given before.
    let analysed = analysed_at.map(|t| t.to_string()).unwrap_or_default();
    format!("{file}|{db}|{side}|{analysed}|{remotes}|{RANKING_VERSION}")
}

/// This app's own analysis for one file, if it is still valid for these bytes.
///
/// Checked against `media_files` rather than trusted: a replaced episode keeps
/// its row until Detect runs again, and markers measured on the old file could
/// be anywhere in the new one.
fn read_analysis(
    conn: &rusqlite::Connection,
    file_id: i64,
) -> Option<(Option<Segment>, Option<Segment>, i64)> {
    conn.query_row(
        "SELECT a.intro_start, a.intro_end, a.credits_start, a.credits_end, a.analysed_at
           FROM analysed_segments a
           JOIN media_files m ON m.id = a.file_id
          WHERE a.file_id = ?1
            AND a.file_size = m.size_bytes
            AND a.file_mtime = m.modified_at",
        params![file_id],
        |r| {
            let intro = r.get::<_, Option<f64>>(0)?.map(|start| Segment {
                start,
                end: r.get::<_, Option<f64>>(1).unwrap_or(None),
            });
            let credits = r.get::<_, Option<f64>>(2)?.map(|start| Segment {
                start,
                end: r.get::<_, Option<f64>>(3).unwrap_or(None),
            });
            Ok((intro, credits, r.get::<_, i64>(4)?))
        },
    )
    .ok()
}

struct Cached {
    markers: SkipMarkers,
    local_key: String,
}

/// A segment from two nullable columns. The end may be NULL only where the
/// segment allows it (credits); elsewhere a row with a NULL end was never
/// written, since every source drops such a segment.
fn segment_at(r: &rusqlite::Row, start: usize) -> rusqlite::Result<Option<Segment>> {
    Ok(r.get::<_, Option<f64>>(start)?.map(|s| Segment {
        start: s,
        end: r.get::<_, Option<f64>>(start + 1).unwrap_or(None),
    }))
}

fn read_cache(conn: &rusqlite::Connection, file_id: i64) -> Option<Cached> {
    conn.query_row(
        "SELECT intro_start, intro_end, intro_source,
                recap_start, recap_end, recap_source,
                credits_start, credits_end, credits_source,
                post_credits_start, post_credits_end, post_credits_source,
                local_key
           FROM skip_markers
          WHERE file_id = ?1",
        params![file_id],
        |r| {
            Ok(Cached {
                markers: SkipMarkers {
                    intro: segment_at(r, 0)?,
                    intro_source: r.get(2)?,
                    recap: segment_at(r, 3)?,
                    recap_source: r.get(5)?,
                    credits: segment_at(r, 6)?,
                    credits_source: r.get(8)?,
                    post_credits: segment_at(r, 9)?,
                    post_credits_source: r.get(11)?,
                },
                local_key: r.get(12)?,
            })
        },
    )
    .ok()
}

fn write_cache(
    conn: &rusqlite::Connection,
    file_id: i64,
    markers: &SkipMarkers,
    key: &str,
) -> rusqlite::Result<()> {
    let start = |s: Option<Segment>| s.map(|s| s.start);
    let end = |s: Option<Segment>| s.and_then(|s| s.end);
    conn.execute(
        "INSERT INTO skip_markers
            (file_id, intro_start, intro_end, intro_source,
             recap_start, recap_end, recap_source,
             credits_start, credits_end, credits_source,
             post_credits_start, post_credits_end, post_credits_source,
             local_key, checked_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(file_id) DO UPDATE SET
            intro_start         = excluded.intro_start,
            intro_end           = excluded.intro_end,
            intro_source        = excluded.intro_source,
            recap_start         = excluded.recap_start,
            recap_end           = excluded.recap_end,
            recap_source        = excluded.recap_source,
            credits_start       = excluded.credits_start,
            credits_end         = excluded.credits_end,
            credits_source      = excluded.credits_source,
            post_credits_start  = excluded.post_credits_start,
            post_credits_end    = excluded.post_credits_end,
            post_credits_source = excluded.post_credits_source,
            local_key           = excluded.local_key,
            checked_at          = excluded.checked_at",
        params![
            file_id,
            start(markers.intro),
            end(markers.intro),
            markers.intro_source,
            start(markers.recap),
            end(markers.recap),
            markers.recap_source,
            start(markers.credits),
            end(markers.credits),
            markers.credits_source,
            start(markers.post_credits),
            end(markers.post_credits),
            markers.post_credits_source,
            key,
            now_secs()
        ],
    )?;
    Ok(())
}

// ---- community services' answers ---------------------------------------------

/// One service's stored answer for a file, if it is still in date.
///
/// An expired answer is treated as no answer at all, even when the service
/// cannot be reached to replace it: keeping answers only for a month is the
/// services' terms, not a freshness preference.
fn read_answer(
    conn: &rusqlite::Connection,
    file_id: i64,
    source: &str,
    ttl_secs: i64,
) -> Option<Lookup> {
    let pair = |r: &rusqlite::Row, i: usize| -> rusqlite::Result<Option<(f64, f64)>> {
        Ok(match (r.get::<_, Option<f64>>(i)?, r.get::<_, Option<f64>>(i + 1)?) {
            (Some(start), Some(end)) => Some((start, end)),
            _ => None,
        })
    };
    conn.query_row(
        "SELECT intro_start, intro_end, recap_start, recap_end,
                credits_start, credits_end, post_credits_start, post_credits_end
           FROM remote_skip_answers
          WHERE file_id = ?1 AND source = ?2 AND fetched_at > ?3",
        params![file_id, source, now_secs() - ttl_secs],
        |r| {
            Ok(Lookup {
                intro: pair(r, 0)?,
                recap: pair(r, 2)?,
                credits: r
                    .get::<_, Option<f64>>(4)?
                    .map(|start| (start, r.get::<_, Option<f64>>(5).unwrap_or(None))),
                post_credits: pair(r, 6)?,
            })
        },
    )
    .ok()
}

fn write_answer(
    conn: &rusqlite::Connection,
    file_id: i64,
    source: &str,
    found: &Lookup,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO remote_skip_answers
            (file_id, source, intro_start, intro_end, recap_start, recap_end,
             credits_start, credits_end, post_credits_start, post_credits_end, fetched_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(file_id, source) DO UPDATE SET
            intro_start        = excluded.intro_start,
            intro_end          = excluded.intro_end,
            recap_start        = excluded.recap_start,
            recap_end          = excluded.recap_end,
            credits_start      = excluded.credits_start,
            credits_end        = excluded.credits_end,
            post_credits_start = excluded.post_credits_start,
            post_credits_end   = excluded.post_credits_end,
            fetched_at         = excluded.fetched_at",
        params![
            file_id,
            source,
            found.intro.map(|s| s.0),
            found.intro.map(|s| s.1),
            found.recap.map(|s| s.0),
            found.recap.map(|s| s.1),
            found.credits.map(|s| s.0),
            found.credits.and_then(|s| s.1),
            found.post_credits.map(|s| s.0),
            found.post_credits.map(|s| s.1),
            now_secs()
        ],
    )?;
    Ok(())
}

/// Let go of answers past their month. Only episodes that were played ever have
/// one, but a month is the terms, and a row past it has no further use.
fn forget_expired_answers(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    let ttl = introdb::CACHE_TTL_SECS.max(introdb_app::CACHE_TTL_SECS);
    conn.execute(
        "DELETE FROM remote_skip_answers WHERE fetched_at <= ?1",
        params![now_secs() - ttl],
    )?;
    Ok(())
}

// ---- assembling the answer -------------------------------------------------

/// What the community services need to be asked about a file, gathered from
/// the library.
struct RemoteQueries {
    /// TheIntroDB, keyed on the TMDB id.
    theintrodb: Option<introdb::Query>,
    /// IntroDB.app, keyed on the IMDb id.
    introdb_app: Option<introdb_app::Query>,
}

/// Only a matched file can be looked up: both services are keyed on an id the
/// match supplies, and a file in the Needs attention queue has none. That is a
/// real gap and the reason the local sources are not merely a fallback — they
/// work on anything.
fn remote_queries(conn: &rusqlite::Connection, file_id: i64) -> RemoteQueries {
    let row = conn.query_row(
        "SELECT t.tmdb_id, t.imdb_id, t.kind, m.parsed_season, m.parsed_episode, p.duration_secs
           FROM media_files m
           JOIN titles t ON t.id = m.title_id
           LEFT JOIN playback_state p ON p.file_id = m.id
          WHERE m.id = ?1",
        params![file_id],
        |r| {
            Ok((
                r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                r.get::<_, String>(2)?,
                r.get::<_, Option<i64>>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, Option<f64>>(5)?,
            ))
        },
    );
    let Ok((tmdb_id, imdb_id, kind, season, episode, duration_secs)) = row else {
        return RemoteQueries {
            theintrodb: None,
            introdb_app: None,
        };
    };

    // Both or neither: a season with no episode would ask about the wrong
    // thing rather than about nothing.
    let numbered = season.is_some() && episode.is_some();
    let theintrodb = (!tmdb_id.trim().is_empty()).then(|| introdb::Query {
        tmdb_id: tmdb_id.trim().to_string(),
        season: season.filter(|_| numbered),
        episode: episode.filter(|_| numbered),
        duration_secs,
    });
    let introdb_app = introdb_app::Query::for_title(&imdb_id, kind == "movie", season, episode);

    RemoteQueries {
        theintrodb,
        introdb_app,
    }
}

/// Read every local source and rank them.
fn local_markers(
    skiptro_db: Option<&Path>,
    video: &Path,
    sidecar: Option<&Sidecar>,
    analysis: Option<(Option<Segment>, Option<Segment>)>,
) -> SkipMarkers {
    let mut markers = SkipMarkers::default();
    // A Skiptro intro it was itself unsure of, held back until the other local
    // sources have had their turn. See `MIN_SKIPTRO_CONFIDENCE`.
    let mut unsure_skiptro: Option<Segment> = None;

    if let Some(db_path) = skiptro_db {
        if let Some(found) = skiptro::detection_for(db_path, video) {
            let segment = Segment {
                start: found.start,
                end: Some(found.end),
            };
            if found.confidence >= MIN_SKIPTRO_CONFIDENCE {
                markers.intro = Some(segment);
                markers.intro_source = Some(FROM_SKIPTRO_DB.into());
            } else {
                crate::log!(
                    "skiptro: confidence {:.2} for {} is below {MIN_SKIPTRO_CONFIDENCE} — \
                     the analysis is asked first",
                    found.confidence,
                    video.display()
                );
                unsure_skiptro = Some(segment);
            }
        }
    }

    if let Some(sidecar) = sidecar {
        match std::fs::read_to_string(&sidecar.path) {
            Ok(raw) => {
                let (intro, credits) = parse_sidecar(&raw, &sidecar.path);
                if markers.intro.is_none() {
                    if let Some(intro) = intro {
                        markers.intro = Some(intro);
                        markers.intro_source = Some(FROM_SIDECAR.into());
                    }
                }
                if let Some(credits) = credits {
                    markers.credits = Some(credits);
                    markers.credits_source = Some(FROM_SIDECAR.into());
                }
            }
            Err(e) => crate::log!("skip: could not read {}: {e}", sidecar.path.display()),
        }
    }

    // Last of the local sources for the intro — see the ranking note at the top
    // of this file for why it sits behind Skiptro rather than ahead of it — and
    // the first that has ever had a measured closing segment to offer.
    if let Some((intro, credits)) = analysis {
        if markers.intro.is_none() {
            if let Some(intro) = intro {
                markers.intro = Some(intro);
                markers.intro_source = Some(FROM_ANALYSIS.into());
            }
        }
        if markers.credits.is_none() {
            if let Some(credits) = credits {
                markers.credits = Some(credits);
                markers.credits_source = Some(FROM_ANALYSIS.into());
            }
        }
    }

    // Still a measurement of this exact file, so still ahead of TheIntroDB —
    // and in this library a low score has meant the intro was cut *short*,
    // which leaves some theme playing rather than skipping story.
    if markers.intro.is_none() {
        if let Some(segment) = unsure_skiptro {
            markers.intro = Some(segment);
            markers.intro_source = Some(FROM_SKIPTRO_DB.into());
        }
    }

    markers
}

/// Markers for one video, or `None` when no source has anything to say.
///
/// `file_id` is optional so an ad-hoc file (dragged in, not in the library)
/// still gets local markers — it just gets no cache entry and no community
/// lookup, since there is no title to look up.
#[tauri::command]
pub async fn get_skip_markers(
    app: tauri::AppHandle,
    path: String,
    file_id: Option<i64>,
) -> Result<Option<SkipMarkers>, String> {
    let video = PathBuf::from(&path);

    // Everything the database is needed for, taken in one lock and then let go.
    // The lookups below are awaits, and a held guard across an await is how a
    // UI freezes on a slow network.
    let (skiptro_db, cached, analysis, theintrodb, introdb_app, remotes) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;

        let skiptro_db = setting(&conn, skiptro::DB_PATH_KEY)
            .map(PathBuf::from)
            .or_else(skiptro::default_db_path);

        let theintrodb_on = setting(&conn, introdb::ENABLED_KEY).as_deref() != Some("off");
        let introdb_app_on = setting(&conn, introdb_app::ENABLED_KEY).as_deref() != Some("off");
        // Which services are on is part of the cache key: see `local_key`.
        let remotes = format!(
            "{}{}",
            if theintrodb_on { "t" } else { "" },
            if introdb_app_on { "a" } else { "" }
        );

        let cached = file_id.and_then(|id| read_cache(&conn, id));
        let analysis = file_id.and_then(|id| read_analysis(&conn, id));
        let queries = file_id.map(|id| remote_queries(&conn, id));
        let (tq, aq) = queries.map_or((None, None), |q| (q.theintrodb, q.introdb_app));

        // For each service that is on and has something to be asked: the
        // stored answer if it is still in date, and otherwise the question.
        let theintrodb = match (file_id, tq) {
            (Some(id), Some(q)) if theintrodb_on => Some(
                read_answer(&conn, id, FROM_INTRODB, introdb::CACHE_TTL_SECS).ok_or(q),
            ),
            _ => None,
        };
        let introdb_app = match (file_id, aq) {
            (Some(id), Some(q)) if introdb_app_on => Some(
                read_answer(&conn, id, FROM_INTRODB_APP, introdb_app::CACHE_TTL_SECS).ok_or(q),
            ),
            _ => None,
        };

        (skiptro_db, cached, analysis, theintrodb, introdb_app, remotes)
    };

    let sidecar = find_sidecar(&video);
    let key = local_key(
        &video,
        skiptro_db.as_deref(),
        sidecar.as_ref(),
        analysis.as_ref().map(|(_, _, at)| *at),
        &remotes,
    );

    // The cache answers outright only when the local sources are unchanged and
    // no service is due to be asked. A stored answer that is still in date is
    // already folded into the cached row: this function wrote both.
    let must_ask = matches!(theintrodb, Some(Err(_))) || matches!(introdb_app, Some(Err(_)));
    if let Some(cached) = &cached {
        if cached.local_key == key && !must_ask {
            return Ok((!cached.markers.is_empty()).then(|| cached.markers.clone()));
        }
    }

    let mut markers = local_markers(
        skiptro_db.as_deref(),
        &video,
        sidecar.as_ref(),
        analysis.map(|(intro, credits, _)| (intro, credits)),
    );

    // Each service: the stored answer, or a fresh one. Only an *answered*
    // question is stored — a 404 or "nobody has timed this" is an answer, so
    // an untimed episode is asked about once a month; being offline is not,
    // so an outage does not store "no credits" until next month.
    let mut fetched: Vec<(&str, Lookup)> = Vec::new();
    let theintrodb = match theintrodb {
        Some(Ok(stored)) => Some(stored),
        Some(Err(query)) => {
            let found = introdb::lookup(&query).await;
            if let Some(found) = found {
                fetched.push((FROM_INTRODB, found));
            }
            found
        }
        None => None,
    };
    let introdb_app = match introdb_app {
        Some(Ok(stored)) => Some(stored),
        Some(Err(query)) => {
            let found = introdb_app::lookup(&query).await;
            if let Some(found) = found {
                fetched.push((FROM_INTRODB_APP, found));
            }
            found
        }
        None => None,
    };

    // After every local source, and in rank order: see the table at the top.
    if let Some(found) = &theintrodb {
        markers.fill_from(found, FROM_INTRODB);
    }
    if let Some(found) = &introdb_app {
        markers.fill_from(found, FROM_INTRODB_APP);
    }

    if let Some(id) = file_id {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        for (source, found) in &fetched {
            write_answer(&conn, id, source, found).map_err(to_string_err)?;
        }
        if !fetched.is_empty() {
            forget_expired_answers(&conn).map_err(to_string_err)?;
        }
        write_cache(&conn, id, &markers, &key).map_err(to_string_err)?;
    }

    Ok((!markers.is_empty()).then_some(markers))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sidecar_of(raw: &str) -> (Option<Segment>, Option<Segment>) {
        parse_sidecar(raw, Path::new("x.skiptro.json"))
    }

    #[test]
    fn reads_the_documented_intro_shape() {
        let (intro, credits) = sidecar_of(r#"{ "intro": { "start": 0, "end": 87.5 } }"#);
        assert_eq!(
            intro,
            Some(Segment {
                start: 0.0,
                end: Some(87.5)
            })
        );
        assert_eq!(credits, None);
    }

    #[test]
    fn accepts_either_name_for_the_closing_segment() {
        for key in ["credits", "outro", "ending"] {
            let raw = format!(r#"{{ "{key}": {{ "start": 2600, "end": 2700 }} }}"#);
            assert_eq!(
                sidecar_of(&raw).1,
                Some(Segment {
                    start: 2600.0,
                    end: Some(2700.0)
                }),
                "key {key} should be recognised"
            );
        }
    }

    #[test]
    fn rejects_segments_that_would_seek_backwards_or_nowhere() {
        for raw in [
            r#"{ "intro": { "start": 90, "end": 30 } }"#,
            r#"{ "intro": { "start": 90, "end": 90 } }"#,
            r#"{ "intro": { "start": -5, "end": 30 } }"#,
            r#"{ "intro": { "start": 0 } }"#,
        ] {
            assert_eq!(sidecar_of(raw).0, None, "should reject {raw}");
        }
    }

    #[test]
    fn malformed_json_yields_no_markers_rather_than_an_error() {
        let (intro, credits) = sidecar_of("not json at all");
        assert!(intro.is_none() && credits.is_none());
    }

    #[test]
    fn looks_for_both_sidecar_naming_conventions() {
        let paths = candidate_paths(Path::new(r"C:\media\Show S01E01.mkv"));
        let names: Vec<String> = paths
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"Show S01E01.skiptro.json".to_string()));
        assert!(names.contains(&"Show S01E01.mkv.skiptro.json".to_string()));
    }

    /// Skiptro's database outranks its own export for the intro, so a rescan
    /// that has not been exported still wins over a stale sidecar.
    #[test]
    fn the_skiptro_database_outranks_the_sidecar_for_the_intro() {
        let dir = std::env::temp_dir().join("pn-skip-rank");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let video = dir.join("Show S01E01.mkv");
        std::fs::write(&video, b"").unwrap();
        std::fs::write(
            dir.join("Show S01E01.skiptro.json"),
            br#"{ "intro": { "start": 0, "end": 10 }, "credits": { "start": 1200, "end": 1300 } }"#,
        )
        .unwrap();

        let db = dir.join("skiptro.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE DetectedSegments (
                 Id INTEGER PRIMARY KEY AUTOINCREMENT, LibraryId INTEGER NOT NULL,
                 FilePath TEXT NOT NULL, ShowName TEXT, Season INTEGER, Episode INTEGER,
                 Type INTEGER NOT NULL, StartSeconds REAL NOT NULL, EndSeconds REAL NOT NULL,
                 Confidence REAL NOT NULL, DetectedAt TEXT NOT NULL, FileModifiedAt TEXT NOT NULL,
                 UserStatus INTEGER NOT NULL DEFAULT 0)",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO DetectedSegments
                (LibraryId, FilePath, Type, StartSeconds, EndSeconds, Confidence,
                 DetectedAt, FileModifiedAt)
             VALUES (1, ?1, 0, 2.0, 45.0, 1.0, '', '')",
            rusqlite::params![video.to_string_lossy()],
        )
        .unwrap();
        drop(conn);

        let sidecar = find_sidecar(&video);
        let markers = local_markers(Some(&db), &video, sidecar.as_ref(), None);

        assert_eq!(markers.intro_source.as_deref(), Some(FROM_SKIPTRO_DB));
        assert_eq!(markers.intro.unwrap().end, Some(45.0));
        // …and the sidecar still supplies the credits it cannot.
        assert_eq!(markers.credits_source.as_deref(), Some(FROM_SIDECAR));
        assert_eq!(markers.credits.unwrap().start, 1200.0);
    }

    /// Skiptro keeps the intro when both have one — the ordering decision — but
    /// the analysis supplies the credits Skiptro has never been able to.
    #[test]
    fn skiptro_keeps_the_intro_and_the_analysis_brings_the_credits() {
        let dir = std::env::temp_dir().join("pn-skip-analysis");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let video = dir.join("Show S01E03.mkv");
        std::fs::write(&video, b"").unwrap();

        let db = dir.join("skiptro.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE DetectedSegments (
                 Id INTEGER PRIMARY KEY AUTOINCREMENT, LibraryId INTEGER NOT NULL,
                 FilePath TEXT NOT NULL, ShowName TEXT, Season INTEGER, Episode INTEGER,
                 Type INTEGER NOT NULL, StartSeconds REAL NOT NULL, EndSeconds REAL NOT NULL,
                 Confidence REAL NOT NULL, DetectedAt TEXT NOT NULL, FileModifiedAt TEXT NOT NULL,
                 UserStatus INTEGER NOT NULL DEFAULT 0)",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO DetectedSegments
                (LibraryId, FilePath, Type, StartSeconds, EndSeconds, Confidence,
                 DetectedAt, FileModifiedAt)
             VALUES (1, ?1, 0, 0.2, 46.6, 1.0, '', '')",
            rusqlite::params![video.to_string_lossy()],
        )
        .unwrap();
        drop(conn);

        let analysis = (
            Some(Segment {
                start: 0.0,
                end: Some(45.7),
            }),
            Some(Segment {
                start: 1430.9,
                end: Some(1500.3),
            }),
        );
        let markers = local_markers(Some(&db), &video, None, Some(analysis));

        assert_eq!(markers.intro_source.as_deref(), Some(FROM_SKIPTRO_DB));
        assert_eq!(markers.intro.unwrap().end, Some(46.6));
        assert_eq!(markers.credits_source.as_deref(), Some(FROM_ANALYSIS));
        assert_eq!(markers.credits.unwrap().start, 1430.9);
    }

    /// A Skiptro database holding one intro for `video`.
    fn skiptro_with(dir: &Path, video: &Path, confidence: f64, end: f64) -> PathBuf {
        let db = dir.join("skiptro.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE DetectedSegments (
                 Id INTEGER PRIMARY KEY AUTOINCREMENT, LibraryId INTEGER NOT NULL,
                 FilePath TEXT NOT NULL, ShowName TEXT, Season INTEGER, Episode INTEGER,
                 Type INTEGER NOT NULL, StartSeconds REAL NOT NULL, EndSeconds REAL NOT NULL,
                 Confidence REAL NOT NULL, DetectedAt TEXT NOT NULL, FileModifiedAt TEXT NOT NULL,
                 UserStatus INTEGER NOT NULL DEFAULT 0)",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO DetectedSegments
                (LibraryId, FilePath, Type, StartSeconds, EndSeconds, Confidence,
                 DetectedAt, FileModifiedAt)
             VALUES (1, ?1, 0, 0.19, ?2, ?3, '', '')",
            rusqlite::params![video.to_string_lossy(), end, confidence],
        )
        .unwrap();
        db
    }

    fn fresh_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pn-skip-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn analysed_intro(end: f64) -> (Option<Segment>, Option<Segment>) {
        (Some(Segment { start: 0.0, end: Some(end) }), None)
    }

    /// The case the threshold exists for, with this library's own numbers:
    /// S04E05, where Skiptro said 37.6 s at confidence 0.70 and the analysis
    /// said 44.6 s. Skiptro was unsure, so the analysis answers.
    #[test]
    fn an_unsure_skiptro_intro_gives_way_to_the_analysis() {
        let dir = fresh_dir("unsure");
        let video = dir.join("Show S04E05.mkv");
        let db = skiptro_with(&dir, &video, 0.70, 37.6);

        let markers = local_markers(Some(&db), &video, None, Some(analysed_intro(44.6)));
        assert_eq!(markers.intro_source.as_deref(), Some(FROM_ANALYSIS));
        assert_eq!(markers.intro.unwrap().end, Some(44.6));
    }

    /// Where Skiptro is sure it keeps first place — the decision this sits
    /// inside. 0.8 itself counts as sure.
    #[test]
    fn a_confident_skiptro_intro_still_wins() {
        for confidence in [1.0, 0.95, 0.8] {
            let dir = fresh_dir(&format!("sure-{confidence}"));
            let video = dir.join("Show S04E01.mkv");
            let db = skiptro_with(&dir, &video, confidence, 44.9);

            let markers = local_markers(Some(&db), &video, None, Some(analysed_intro(44.4)));
            assert_eq!(
                markers.intro_source.as_deref(),
                Some(FROM_SKIPTRO_DB),
                "confidence {confidence}"
            );
            assert_eq!(markers.intro.unwrap().end, Some(44.9));
        }
    }

    /// With nothing else local to ask, an unsure Skiptro intro is still used:
    /// it measured this file, which TheIntroDB did not.
    #[test]
    fn an_unsure_skiptro_intro_is_used_when_nothing_else_local_has_one() {
        let dir = fresh_dir("unsure-alone");
        let video = dir.join("Show S06E04.mkv");
        let db = skiptro_with(&dir, &video, 0.48, 29.1);

        let markers = local_markers(Some(&db), &video, None, None);
        assert_eq!(markers.intro_source.as_deref(), Some(FROM_SKIPTRO_DB));
        assert_eq!(markers.intro.unwrap().end, Some(29.1));
    }

    /// Rows cached under the old ranking must be recomputed, or the new rule
    /// would not reach an episode until one of its sources happened to move.
    #[test]
    fn the_cache_key_carries_the_ranking_version() {
        let key = local_key(Path::new(r"Z:\offline\Show.mkv"), None, None, None, "");
        assert!(key.ends_with(RANKING_VERSION), "got {key}");
    }

    /// With no Skiptro at all, the analysis carries both segments on its own.
    #[test]
    fn the_analysis_supplies_the_intro_when_nothing_else_does() {
        let analysis = (
            Some(Segment {
                start: 0.0,
                end: Some(45.7),
            }),
            None,
        );
        let markers = local_markers(None, Path::new(r"C:\media\x.mkv"), None, Some(analysis));
        assert_eq!(markers.intro_source.as_deref(), Some(FROM_ANALYSIS));
        assert_eq!(markers.intro.unwrap().end, Some(45.7));
    }

    /// With no Skiptro database at all, the sidecar is the intro source. This
    /// is the pre-existing behaviour and it must not have changed.
    #[test]
    fn the_sidecar_still_works_on_its_own() {
        let dir = std::env::temp_dir().join("pn-skip-sidecar-only");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let video = dir.join("Show S01E02.mkv");
        std::fs::write(&video, b"").unwrap();
        std::fs::write(
            dir.join("Show S01E02.skiptro.json"),
            br#"{ "intro": { "start": 0.2, "end": 45.6 } }"#,
        )
        .unwrap();

        let sidecar = find_sidecar(&video);
        let markers = local_markers(None, &video, sidecar.as_ref(), None);
        assert_eq!(markers.intro_source.as_deref(), Some(FROM_SIDECAR));
        assert_eq!(markers.intro.unwrap().start, 0.2);
    }

    /// The cache key must move when Skiptro rescans, or a newly detected intro
    /// never appears for a file that has already been played once.
    #[test]
    fn the_local_key_changes_when_skiptro_rescans() {
        let dir = std::env::temp_dir().join("pn-skip-key");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let video = dir.join("Show S01E01.mkv");
        let db = dir.join("skiptro.db");
        std::fs::write(&db, b"x").unwrap();
        let before = local_key(&video, Some(&db), None, None, "");

        std::fs::write(db.with_extension("db-wal"), b"a scan happened").unwrap();
        assert_ne!(local_key(&video, Some(&db), None, None, ""), before);
    }

    /// …and when Detect produces a fresh analysis, or the cached answer from
    /// before it would stay on screen.
    #[test]
    fn the_local_key_changes_when_the_analysis_is_rerun() {
        let video = Path::new(r"C:\media\x.mkv");
        assert_ne!(
            local_key(video, None, None, Some(200), ""),
            local_key(video, None, None, Some(100), "")
        );
        assert_ne!(
            local_key(video, None, None, Some(100), ""),
            local_key(video, None, None, None, "")
        );
    }

    /// A file replaced on disk must lose its markers even when no scan has run
    /// and nothing else moved — the case every other guard misses, because they
    /// all read `media_files` and that is what has not been updated yet.
    #[test]
    fn the_local_key_changes_when_the_video_itself_does() {
        let dir = std::env::temp_dir().join("pn-skip-video-key");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let video = dir.join("Show S01E01.mkv");
        std::fs::write(&video, b"half a download").unwrap();
        let before = local_key(&video, None, None, None, "");

        std::fs::write(&video, b"the whole thing, which is longer").unwrap();
        assert_ne!(local_key(&video, None, None, None, ""), before);
    }

    /// A file that is not there yields a key rather than a panic: an offline
    /// share must degrade to "no markers", not take the player down.
    #[test]
    fn a_missing_video_still_produces_a_key() {
        let key = local_key(Path::new(r"Z:\offline\Show.mkv"), None, None, None, "");
        assert!(key.starts_with('|'), "got {key}");
    }

    fn answer(
        intro: Option<(f64, f64)>,
        recap: Option<(f64, f64)>,
        credits: Option<(f64, Option<f64>)>,
        post_credits: Option<(f64, f64)>,
    ) -> Lookup {
        Lookup {
            intro,
            recap,
            credits,
            post_credits,
        }
    }

    /// A measurement of this file keeps its segments; the community services
    /// only fill what is still missing, TheIntroDB before IntroDB.app.
    #[test]
    fn community_answers_fill_gaps_in_rank_order() {
        let mut markers = local_markers(
            None,
            Path::new(r"C:\media\x.mkv"),
            None,
            Some((Some(Segment { start: 0.0, end: Some(45.0) }), None)),
        );
        markers.fill_from(
            &answer(Some((2.0, 50.0)), None, Some((1400.0, None)), None),
            FROM_INTRODB,
        );
        markers.fill_from(
            &answer(
                Some((3.0, 51.0)),
                Some((50.0, 80.0)),
                Some((1390.0, Some(1450.0))),
                None,
            ),
            FROM_INTRODB_APP,
        );

        assert_eq!(markers.intro_source.as_deref(), Some(FROM_ANALYSIS));
        assert_eq!(markers.intro.unwrap().end, Some(45.0));
        assert_eq!(markers.credits_source.as_deref(), Some(FROM_INTRODB));
        assert_eq!(markers.credits.unwrap().start, 1400.0);
        // Only IntroDB.app had a recap, so it supplies one.
        assert_eq!(markers.recap_source.as_deref(), Some(FROM_INTRODB_APP));
        assert_eq!(markers.recap, Some(Segment { start: 50.0, end: Some(80.0) }));
    }

    /// TheIntroDB answers first for a recap, as for everything else.
    #[test]
    fn theintrodb_keeps_the_recap_when_both_have_one() {
        let mut markers = SkipMarkers::default();
        markers.fill_from(&answer(None, Some((0.0, 40.0)), None, None), FROM_INTRODB);
        markers.fill_from(&answer(None, Some((0.0, 55.0)), None, None), FROM_INTRODB_APP);
        assert_eq!(markers.recap_source.as_deref(), Some(FROM_INTRODB));
        assert_eq!(markers.recap.unwrap().end, Some(40.0));
    }

    /// A film's scene after the credits comes through beside credits from
    /// another source; whether the two fit together is `skip.ts`'s question.
    #[test]
    fn the_scene_after_the_credits_is_carried_beside_other_credits() {
        let mut markers = SkipMarkers::default();
        markers.fill_from(&answer(None, None, Some((7000.0, None)), None), FROM_INTRODB);
        markers.fill_from(
            &answer(None, None, Some((7010.0, Some(7500.0))), Some((7500.0, 7560.0))),
            FROM_INTRODB_APP,
        );
        assert_eq!(markers.credits_source.as_deref(), Some(FROM_INTRODB));
        assert_eq!(markers.post_credits_source.as_deref(), Some(FROM_INTRODB_APP));
        assert_eq!(markers.post_credits, Some(Segment { start: 7500.0, end: Some(7560.0) }));
    }

    /// A recap alone is still something to say.
    #[test]
    fn a_recap_alone_is_not_empty() {
        let mut markers = SkipMarkers::default();
        assert!(markers.is_empty());
        markers.fill_from(&answer(None, Some((0.0, 30.0)), None, None), FROM_INTRODB);
        assert!(!markers.is_empty());
    }

    /// Switching a service off must change the key, or a row written while it
    /// was on would keep serving its segments.
    #[test]
    fn the_local_key_changes_when_a_service_is_switched_off() {
        let video = Path::new(r"C:\media\x.mkv");
        assert_ne!(
            local_key(video, None, None, None, "ta"),
            local_key(video, None, None, None, "a")
        );
    }

    /// The round trip through both tables on the real schema: a stored answer
    /// reads back as it went in, and one past its month does not.
    #[test]
    fn a_stored_answer_reads_back_and_expires() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();

        let found = answer(
            None,
            Some((0.0, 41.0)),
            Some((3431.0, None)),
            Some((3500.0, 3520.0)),
        );
        write_answer(&conn, 7, FROM_INTRODB_APP, &found).unwrap();
        assert_eq!(read_answer(&conn, 7, FROM_INTRODB_APP, 60), Some(found));
        assert_eq!(read_answer(&conn, 7, FROM_INTRODB, 60), None);

        conn.execute("UPDATE remote_skip_answers SET fetched_at = fetched_at - 120", [])
            .unwrap();
        assert_eq!(read_answer(&conn, 7, FROM_INTRODB_APP, 60), None);

        let mut markers = SkipMarkers::default();
        markers.fill_from(&found, FROM_INTRODB_APP);
        write_cache(&conn, 7, &markers, "k").unwrap();
        let cached = read_cache(&conn, 7).unwrap();
        assert_eq!(cached.markers, markers);
        assert_eq!(cached.local_key, "k");
    }
}
