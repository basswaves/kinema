//! The picture's real shape, measured.
//!
//! A remux keeps a 2.39:1 film's black bars inside a 16:9 frame, so the file
//! reports 1.78:1 and the badge would be wrong for most films on disc. Kodi,
//! Jellyfin, Plex and Zidoo show the file's figure; Kinema looks at the
//! picture. See HISTORY.md, "Picture and sound badges".
//!
//! **How:** one ffmpeg run per file, sampling one keyframe at each of eight
//! points through it, `cropdetect` on each. One run rather than eight, because
//! opening the file is most of the cost — eight runs took 11.7 s on a 4K film
//! over a network drive and one run 2.5 s; a 1080p file takes about a second.
//! Only keyframes are decoded (`-skip_frame nokey`).
//!
//! **What is measured:** every film, and one episode per season — a season's
//! episodes share their framing, and measuring each would multiply the cost
//! by the episode count for nothing. The rest of the season is given the
//! measured episode's result (`aspect_for_file`).
//!
//! **Why a single frame is enough per point, and what it gets wrong:** a dark
//! scene has dark edges, and `cropdetect` takes dark picture for bars — the
//! frame measures narrower or shorter than the film is. It can never measure
//! *more* picture than there is. So the answer is what most samples agree on,
//! and a dark sample is outvoted. See [`shape`].
//!
//! Runs after intro detection at the end of a scan, below normal priority,
//! and never again for a file unless the file changes.

use crate::library::Db;
use crate::probe::MediaDetails;
use crate::util::to_string_err;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::{Emitter, Manager};

/// Raise to measure every picture again, after a change to how.
pub const MEASURE_VERSION: i64 = 1;

const PROGRESS_EVENT: &str = "measure-progress";

/// Where through the file to look: evenly from 8% to 92%, clear of the
/// opening logos and the end credits, whose framing is often not the film's.
const SAMPLE_POINTS: [f64; 8] = [0.08, 0.20, 0.32, 0.44, 0.56, 0.68, 0.80, 0.92];

/// Anything darker than this counts as bar: 24/255, as a fraction so it
/// means the same at 8 and 10 bits. Limited-range black is 16/255 (64/1023),
/// comfortably below it.
const CROP_LIMIT: &str = "0.094";

/// Two samples are the same shape when their heights are within this share
/// of each other. `cropdetect` rounds to even pixels and wobbles by a line or
/// two on soft edges.
const SAME_HEIGHT: f64 = 0.01;

/// How many samples must agree on a taller shape before it is reported as
/// one the film opens up to. One is not enough: subtitles burned into the
/// lower bar make a single frame measure taller than the picture is.
const MIN_ALT_SAMPLES: usize = 2;

/// Samples that answered at all must number at least this many.
const MIN_SAMPLES: usize = 4;

/// What the measurement found.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    /// The shape most of the film has.
    pub main: f64,
    /// A taller shape it opens up to for part of its length — IMAX scenes in
    /// a scope film — or `None`.
    pub alt: Option<f64>,
}

/// Decide the picture's shape from what each sample measured.
///
/// `samples` are `(width, height)` of the picture inside each frame, in
/// stored pixels; `pixel_shape` is the stream's sample aspect ratio (1 for
/// nearly everything but DVDs).
///
/// Heights decide it, because bars are nearly always top and bottom. The
/// heights are grouped, and the group with the most samples is the film's
/// main shape (on a tie, the taller: darkness only ever takes picture away).
/// A group *taller* than that with at least [`MIN_ALT_SAMPLES`] samples is a
/// shape the film opens up to. Shorter groups are dark scenes and are
/// ignored. The width is the widest seen among the main group's samples, for
/// the same reason — a dark frame's sides look like pillarbox bars.
pub fn shape(samples: &[(u32, u32)], pixel_shape: f64) -> Option<Shape> {
    if samples.len() < MIN_SAMPLES {
        return None;
    }

    // Groups of heights within SAME_HEIGHT of the group's first member,
    // tallest first so a group is always led by its tallest height.
    let mut heights: Vec<u32> = samples.iter().map(|(_, h)| *h).collect();
    heights.sort_unstable_by(|a, b| b.cmp(a));
    let mut groups: Vec<(u32, usize)> = Vec::new(); // (height, count)
    for h in heights {
        match groups.last_mut() {
            Some((lead, n)) if (*lead - h) as f64 <= *lead as f64 * SAME_HEIGHT => *n += 1,
            _ => groups.push((h, 1)),
        }
    }

    // Most samples wins; `max_by_key` keeps the last maximum, so iterate
    // shortest-first to let the tallest win a tie.
    let (main_height, _) = *groups.iter().rev().max_by_key(|(_, n)| *n)?;
    let in_group = |lead: u32, h: u32| h <= lead && (lead - h) as f64 <= lead as f64 * SAME_HEIGHT;
    let width_of = |lead: u32| {
        samples
            .iter()
            .filter(|(_, h)| in_group(lead, *h))
            .map(|(w, _)| *w)
            .max()
    };
    let ratio = |w: u32, h: u32| w as f64 * pixel_shape / h as f64;

    let main = ratio(width_of(main_height)?, main_height);
    let alt = groups
        .iter()
        .filter(|(h, n)| *h > main_height && *n >= MIN_ALT_SAMPLES)
        .max_by_key(|(_, n)| *n)
        .and_then(|(h, _)| Some(ratio(width_of(*h)?, *h)));

    Some(Shape { main, alt })
}

/// Pull each `cropdetect`'s last verdict out of ffmpeg's log, by filter.
///
/// The filters are numbered in the order the filtergraph names them
/// (`Parsed_cropdetect_0` …), which is the order of the sample points.
fn parse_crops(log: &str, count: usize) -> Vec<Option<(u32, u32)>> {
    let mut found = vec![None; count];
    for line in log.lines() {
        let Some(rest) = line.split_once("Parsed_cropdetect_").map(|(_, r)| r) else {
            continue;
        };
        let index: Option<usize> = rest
            .split(|c: char| !c.is_ascii_digit())
            .next()
            .and_then(|n| n.parse().ok());
        let crop = rest.split_once("crop=").and_then(|(_, c)| {
            let mut parts = c.split(':');
            let w: u32 = parts.next()?.parse().ok()?;
            let h: u32 = parts.next()?.trim_end().parse().ok()?;
            Some((w, h))
        });
        if let (Some(i), Some(crop)) = (index, crop) {
            if i < count {
                found[i] = Some(crop);
            }
        }
    }
    found
}

/// Measure one file. `None` when it cannot be measured — too short, no
/// usable frames, or ffmpeg failed — which is kept, not retried.
pub fn measure(ffmpeg: &Path, video: &Path, details: &MediaDetails) -> Option<Shape> {
    let stream = details.video.as_ref()?;
    let index = stream.stream_index?;
    let duration = details.duration_secs.filter(|d| *d > 60.0)?;
    let pixel_shape = match (stream.aspect_ratio, stream.width, stream.height) {
        (Some(aspect), w, h) if w > 0 && h > 0 => aspect * h as f64 / w as f64,
        _ => 1.0,
    };

    let mut command = Command::new(ffmpeg);
    command.args(["-hide_banner", "-nostats", "-nostdin", "-v", "info"]);
    for point in SAMPLE_POINTS {
        command
            .args(["-skip_frame", "nokey"])
            .args(["-ss", &format!("{:.3}", duration * point)])
            .arg("-i")
            .arg(video);
    }
    let graph: Vec<String> = (0..SAMPLE_POINTS.len())
        .map(|i| {
            format!("[{i}:{index}]cropdetect=limit={CROP_LIMIT}:round=2:reset=0:skip=0[o{i}]")
        })
        .collect();
    command.args(["-filter_complex", &graph.join(";")]);
    for i in 0..SAMPLE_POINTS.len() {
        command
            .args(["-map", &format!("[o{i}]")])
            .args(["-frames:v", "1", "-f", "null", "-"]);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    crate::ffmpeg::no_window(&mut command);

    let output = command.output().ok()?;
    let log = String::from_utf8_lossy(&output.stderr);
    let samples: Vec<(u32, u32)> = parse_crops(&log, SAMPLE_POINTS.len())
        .into_iter()
        .flatten()
        // A crop of almost nothing is a black frame, not a shape.
        .filter(|(w, h)| *w * 5 >= stream.width && *h * 5 >= stream.height)
        .collect();
    shape(&samples, pixel_shape)
}

// ---- which files, and keeping the answer --------------------------------------

struct Candidate {
    id: i64,
    path: String,
    details: MediaDetails,
    /// `(title, season)` for an episode, so a season is measured once.
    season: Option<(i64, i64)>,
}

/// What needs measuring: every film not yet measured, and for each season
/// with no measured episode, its episodes in order — the first that can be
/// measured speaks for the season.
fn candidates(conn: &Connection) -> rusqlite::Result<Vec<Candidate>> {
    let mut done = conn.prepare(
        "SELECT DISTINCT m.title_id, m.parsed_season
           FROM media_files m
           JOIN media_probe p ON p.file_id = m.id
          WHERE p.picture_version >= ?1 AND p.picture_aspect IS NOT NULL",
    )?;
    let measured: HashSet<(i64, i64)> = done
        .query_map(params![MEASURE_VERSION], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0)))
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut statement = conn.prepare(
        "SELECT m.id, m.path, p.details, t.kind, m.title_id, m.parsed_season
           FROM media_files m
           JOIN media_probe p ON p.file_id = m.id
           JOIN titles t ON t.id = m.title_id
          WHERE m.missing = 0
            AND m.match_status = 'matched'
            AND p.details IS NOT NULL
            AND (p.picture_version IS NULL OR p.picture_version < ?1)
          ORDER BY t.kind, m.title_id, m.parsed_season, m.parsed_episode, m.id",
    )?;
    let rows = statement.query_map(params![MEASURE_VERSION], |r| {
        let details: String = r.get(2)?;
        let kind: String = r.get(3)?;
        let season = (kind == "series")
            .then(|| -> rusqlite::Result<(i64, i64)> {
                Ok((r.get(4)?, r.get::<_, Option<i64>>(5)?.unwrap_or(0)))
            })
            .transpose()?;
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, details, season))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (id, path, details, season) = row?;
        if season.is_some_and(|s| measured.contains(&s)) {
            continue;
        }
        let Ok(details) = serde_json::from_str(&details) else {
            continue;
        };
        out.push(Candidate {
            id,
            path,
            details,
            season,
        });
    }
    Ok(out)
}

fn save(conn: &Connection, file_id: i64, shape: Option<Shape>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE media_probe
            SET picture_version = ?2, picture_aspect = ?3, picture_aspect_alt = ?4
          WHERE file_id = ?1",
        params![
            file_id,
            MEASURE_VERSION,
            shape.map(|s| s.main),
            shape.and_then(|s| s.alt)
        ],
    )?;
    Ok(())
}

/// The measured shape for a file: its own, or for an episode, its season's.
pub fn shape_for_file(conn: &Connection, file_id: i64) -> Option<Shape> {
    conn.query_row(
        "SELECT p.picture_aspect, p.picture_aspect_alt
           FROM media_files f
           JOIN media_files m
             ON m.id = f.id
             OR (f.title_id IS NOT NULL AND m.title_id = f.title_id
                 AND m.parsed_season IS f.parsed_season
                 AND EXISTS (SELECT 1 FROM titles t
                              WHERE t.id = f.title_id AND t.kind = 'series'))
           JOIN media_probe p ON p.file_id = m.id
          WHERE f.id = ?1 AND p.picture_aspect IS NOT NULL
          ORDER BY (m.id = f.id) DESC
          LIMIT 1",
        params![file_id],
        |r| {
            Ok(Shape {
                main: r.get(0)?,
                alt: r.get(1)?,
            })
        },
    )
    .ok()
}

#[derive(Serialize, Clone)]
pub struct MeasureProgress {
    pub done: usize,
    pub total: usize,
}

#[derive(Serialize, Default)]
pub struct MeasureReport {
    pub measured: usize,
    /// ffmpeg was not found, so nothing was measured.
    pub unavailable: bool,
}

/// Tauri command: measure what needs measuring. The scan's last step.
#[tauri::command]
pub async fn measure_pictures(app: tauri::AppHandle) -> Result<MeasureReport, String> {
    // No ffmpeg can be run here (Android): nothing to measure with.
    if !crate::capabilities::current().runs_programs {
        return Ok(MeasureReport::default());
    }
    // The same job as reading the files: both are "the scan looks at files",
    // and neither should run twice at once.
    let Some(running) = app
        .state::<crate::jobs::Jobs>()
        .try_start(crate::jobs::Job::Probe)
    else {
        return Ok(MeasureReport::default());
    };

    let (ffmpeg, files) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        let configured = crate::settings::setting(&conn, crate::ffmpeg::PATH_KEY);
        (
            crate::ffmpeg::resolve(configured.as_deref()),
            candidates(&conn).map_err(to_string_err)?,
        )
    };
    if files.is_empty() {
        return Ok(MeasureReport::default());
    }

    crate::jobs::off_main(move || {
        let _running = running;
        if !crate::ffmpeg::is_available(&ffmpeg) {
            return Ok(MeasureReport {
                unavailable: true,
                ..MeasureReport::default()
            });
        }

        let started = std::time::Instant::now();
        // Progress counts films and seasons — what is actually measured —
        // not the episodes waiting behind each season's first.
        let seasons: HashSet<(i64, i64)> = files.iter().filter_map(|f| f.season).collect();
        let total = files.iter().filter(|f| f.season.is_none()).count() + seasons.len();
        let mut done = 0;
        let mut report = MeasureReport::default();
        let mut seasons_done: HashSet<(i64, i64)> = HashSet::new();
        let mut seasons_started: HashSet<(i64, i64)> = HashSet::new();
        for file in &files {
            if file.season.is_some_and(|s| seasons_done.contains(&s)) {
                continue;
            }
            if file.season.is_none_or(|s| seasons_started.insert(s)) {
                let _ = app.emit(PROGRESS_EVENT, MeasureProgress { done, total });
                done += 1;
            }

            // Offline right now is not unmeasurable; see probe.rs.
            let path = Path::new(&file.path);
            if !path.is_file() {
                continue;
            }
            let shape = measure(&ffmpeg, path, &file.details);
            if shape.is_some() {
                report.measured += 1;
                if let Some(season) = file.season {
                    seasons_done.insert(season);
                }
            }
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            save(&conn, file.id, shape).map_err(to_string_err)?;
        }
        crate::log!(
            "aspect: measured {} picture(s) in {:.1}s",
            report.measured,
            started.elapsed().as_secs_f64()
        );
        Ok(report)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.01
    }

    /// A 2.39:1 film in a 1080p remux: bars top and bottom in every frame.
    #[test]
    fn a_scope_film_in_a_16_9_frame_measures_scope() {
        let s = shape(&[(1920, 800); 8], 1.0).unwrap();
        assert!(close(s.main, 2.4), "{s:?}");
        assert_eq!(s.alt, None);
    }

    /// Dark scenes measure short or narrow. They are outvoted, and they can
    /// never make the film look taller than it is.
    #[test]
    fn dark_scenes_are_outvoted() {
        let samples = [
            (3840, 1600),
            (3840, 1600),
            (3624, 1600), // dark sides
            (3840, 1600),
            (3840, 1600),
            (3424, 1600),
            (3382, 1600),
            (3840, 1600),
        ];
        let s = shape(&samples, 1.0).unwrap();
        assert!(close(s.main, 2.4), "{s:?}");
        assert_eq!(s.alt, None);

        // Measured on a real episode: two dark frames, one of them short.
        let samples = [
            (1920, 1080),
            (1920, 1080),
            (1776, 1080),
            (1920, 1080),
            (1920, 1080),
            (1920, 1080),
            (1920, 1080),
            (1728, 848),
        ];
        let s = shape(&samples, 1.0).unwrap();
        assert!(close(s.main, 16.0 / 9.0), "{s:?}");
        assert_eq!(s.alt, None);
    }

    /// Mostly scope, opening up to full frame for its IMAX scenes.
    #[test]
    fn an_imax_film_opens_up() {
        let samples = [
            (1920, 800),
            (1920, 1080),
            (1920, 800),
            (1920, 800),
            (1920, 1080),
            (1920, 800),
            (1920, 802),
            (1920, 800),
        ];
        let s = shape(&samples, 1.0).unwrap();
        assert!(close(s.main, 2.4), "{s:?}");
        assert!(close(s.alt.unwrap(), 16.0 / 9.0), "{s:?}");
    }

    /// Subtitles in the lower bar make one frame measure taller. One frame is
    /// not a shape.
    #[test]
    fn one_tall_frame_is_not_an_imax_scene() {
        let mut samples = [(1920, 800); 8];
        samples[3] = (1920, 952);
        let s = shape(&samples, 1.0).unwrap();
        assert!(close(s.main, 2.4));
        assert_eq!(s.alt, None);
    }

    /// Cropdetect wobbles by a line or two; that is one shape, not two.
    #[test]
    fn a_line_or_two_is_the_same_shape() {
        let samples = [
            (1920, 800),
            (1920, 802),
            (1920, 798),
            (1920, 800),
            (1920, 804),
            (1920, 800),
        ];
        let s = shape(&samples, 1.0).unwrap();
        assert_eq!(s.alt, None);
        assert!((2.38..2.41).contains(&s.main), "{s:?}");
    }

    #[test]
    fn a_4_3_picture_in_a_16_9_frame_measures_4_3() {
        let s = shape(&[(1440, 1080); 6], 1.0).unwrap();
        assert!(close(s.main, 4.0 / 3.0), "{s:?}");
    }

    #[test]
    fn a_dvds_pixels_are_not_square() {
        // 720×576 PAL, 16:9 anamorphic, letterboxed to 2.35 inside.
        let s = shape(&[(720, 436); 6], 64.0 / 45.0).unwrap();
        assert!((2.3..2.4).contains(&s.main), "{s:?}");
    }

    #[test]
    fn too_few_samples_is_no_answer() {
        assert_eq!(shape(&[(1920, 800); 3], 1.0), None);
        assert_eq!(shape(&[], 1.0), None);
    }

    /// ffmpeg 8.1.2's log lines, in the shape it prints them (the first is
    /// verbatim; the others vary it). Only each filter's last verdict counts.
    #[test]
    fn reads_each_filters_verdict_from_the_log() {
        let log = "\
[Parsed_cropdetect_0 @ 0000016acc7f1240] x1:0 x2:1919 y1:140 y2:939 w:1920 h:800 x:0 y:140 pts:0 t:0.000000 limit:0.094000 crop=1920:800:0:140
[Parsed_cropdetect_1 @ 0000016acc7f19c0] x1:0 x2:1919 y1:0 y2:1079 w:1920 h:1080 x:0 y:0 pts:0 t:0.000000 limit:0.094000 crop=1920:1080:0:0
[Parsed_cropdetect_0 @ 0000016acc7f1240] x1:0 x2:1919 y1:138 y2:941 w:1920 h:802 x:0 y:138 pts:1 t:0.041667 limit:0.094000 crop=1920:802:0:138
[out#0/null @ 0000016acc7f2000] video:0KiB audio:0KiB subtitle:0KiB other streams:0KiB";
        assert_eq!(
            parse_crops(log, 3),
            vec![Some((1920, 802)), Some((1920, 1080)), None]
        );
    }

    // ---- which files ----

    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&conn).map_err(|e| e.to_string()).unwrap();
        let details = serde_json::to_string(&MediaDetails::default()).unwrap();
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'D:\\Media', 'movies', 0);
             INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at)
             VALUES (1, 'movie', 'tmdb', '1', 'A film', 0),
                    (2, 'series', 'tmdb', '2', 'A show', 0);",
        )
        .unwrap();
        // One film, and two seasons of three episodes.
        let files: [(i64, i64, Option<i64>, Option<i64>); 7] = [
            (1, 1, None, None),
            (2, 2, Some(1), Some(1)),
            (3, 2, Some(1), Some(2)),
            (4, 2, Some(1), Some(3)),
            (5, 2, Some(2), Some(1)),
            (6, 2, Some(2), Some(2)),
            (7, 2, Some(2), Some(3)),
        ];
        for (id, title, season, episode) in files {
            conn.execute(
                "INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                     size_bytes, modified_at, first_seen_at, last_seen_at, match_status,
                     title_id, parsed_season, parsed_episode)
                 VALUES (?1, 1, 'D:\\Media\\f' || ?1, 'D:\\Media', 'f', 'mkv', 1, 1, 0, 0,
                         'matched', ?2, ?3, ?4)",
                params![id, title, season, episode],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO media_probe (file_id, size_bytes, modified_at, probe_version,
                                          probed_at, details)
                 VALUES (?1, 1, 1, ?2, 0, ?3)",
                params![id, crate::probe::PROBE_VERSION, details],
            )
            .unwrap();
        }
        conn
    }

    fn candidate_ids(conn: &Connection) -> Vec<i64> {
        candidates(conn).unwrap().iter().map(|c| c.id).collect()
    }

    const SCOPE: Shape = Shape { main: 2.4, alt: None };

    #[test]
    fn a_film_and_each_season_are_measured_once() {
        let conn = library();
        // Episodes wait in order behind the first of their season.
        assert_eq!(candidate_ids(&conn), vec![1, 2, 3, 4, 5, 6, 7]);

        save(&conn, 1, Some(SCOPE)).unwrap();
        save(&conn, 2, Some(SCOPE)).unwrap();
        // The film is done, and season 1 speaks through episode 1.
        assert_eq!(candidate_ids(&conn), vec![5, 6, 7]);
    }

    /// An episode that could not be measured does not settle its season; the
    /// next one is tried.
    #[test]
    fn an_unmeasurable_episode_passes_to_the_next() {
        let conn = library();
        save(&conn, 2, None).unwrap();
        let ids = candidate_ids(&conn);
        assert!(ids.contains(&3) && !ids.contains(&2), "{ids:?}");
    }

    #[test]
    fn an_episode_gets_its_seasons_shape() {
        let conn = library();
        save(&conn, 2, Some(SCOPE)).unwrap();
        save(&conn, 5, Some(Shape { main: 1.78, alt: None })).unwrap();
        assert_eq!(shape_for_file(&conn, 4), Some(SCOPE));
        assert_eq!(shape_for_file(&conn, 7).unwrap().main, 1.78);
        // A film has only its own.
        assert_eq!(shape_for_file(&conn, 1), None);
    }

    /// Reading the file again because the reader improved keeps the
    /// measurement; the file itself changing drops it.
    #[test]
    fn a_measurement_lasts_as_long_as_the_file() {
        let conn = library();
        save(&conn, 1, Some(Shape { main: 2.4, alt: Some(1.78) })).unwrap();
        let reread = |size: i64| {
            let file = crate::probe::Pending {
                id: 1,
                path: String::new(),
                size,
                modified: 1,
            };
            crate::probe::save(&conn, &file, &Ok(MediaDetails::default())).unwrap();
        };
        reread(1);
        assert_eq!(
            shape_for_file(&conn, 1),
            Some(Shape { main: 2.4, alt: Some(1.78) })
        );
        reread(2);
        assert_eq!(shape_for_file(&conn, 1), None);
    }

    /// The real thing: a letterboxed clip made here, so nothing depends on
    /// the machine's library.
    #[test]
    #[ignore = "needs ffmpeg and ffprobe on PATH"]
    fn measures_a_real_letterboxed_file() {
        let dir = std::env::temp_dir().join(format!("kinema-aspect-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("letterboxed.mkv");
        // A 1920×800 picture padded to 1920×1080, as a scope remux is, with a
        // keyframe every second so every sample point has one nearby.
        let status = Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=1920x800:rate=24,pad=1920:1080:0:140:black")
            .args(["-t", "90", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24"])
            .arg(&file)
            .status()
            .expect("ffmpeg");
        assert!(status.success());

        let details = crate::probe::probe(Path::new("ffmpeg"), &file).expect("probe");
        let shape = measure(Path::new("ffmpeg"), &file, &details);
        let _ = std::fs::remove_dir_all(&dir);
        let shape = shape.expect("a shape");
        assert!(close(shape.main, 2.4), "{shape:?}");
        assert_eq!(shape.alt, None);
    }
}
