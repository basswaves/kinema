//! Detecting intros and credits by fingerprinting the audio of a season.
//!
//! The method is the one Jellyfin's intro-skipper uses, reimplemented: an intro
//! is the stretch of audio every episode of a season has in common near its
//! start, and the credits are the stretch they have in common near the end. Its
//! code is GPL-3.0 C# and none of it is here — but the **operating values** are
//! published in its documentation and are used as the starting point below,
//! which is what stops this being months of guessing at windows and durations.
//!
//! What it can do that neither other source can: it works on a file with no
//! metadata match at all, and it finds credits, which Skiptro cannot.
//!
//! ## What is measured, and what is a threshold
//!
//! The search windows and duration bounds are *facts about television* — an
//! intro is in the first quarter of an episode and lasts under two minutes —
//! and transfer directly from intro-skipper's published settings.
//!
//! [`MAX_SCORE`] and [`CLUSTER_TOLERANCE_SECS`] do **not** transfer, and it is
//! worth knowing why before touching them. Their thresholds are calibrated
//! against the fingerprints Jellyfin's ffmpeg emits; this uses
//! `rusty-chromaprint`, whose configuration produces a different fingerprint, so
//! the distance scale is simply not the same number line. Both were set by
//! running the real library — see the ignored test at the bottom, which is how
//! to re-check them.
//!
//! ## Agreement, not detection
//!
//! Nothing here trusts a single comparison. A segment has to turn up between an
//! episode and at least [`min_support`] *others* before it is believed, and the
//! reported time is the median of that cluster rather than any one measurement.
//! One episode that happens to open on a similar chord cannot produce a marker
//! on its own — which matters, because a wrong intro marker skips over content
//! the viewer never sees, the same silent wrongness a bad metadata match causes.

use crate::ffmpeg;
use rusty_chromaprint::{match_fingerprints, Configuration, Fingerprinter};
use std::path::Path;

/// Fraction of an episode an intro is looked for in.
///
/// intro-skipper: "the first 25% of an episode or the first 10 minutes,
/// whichever is smaller".
const INTRO_WINDOW_FRACTION: f64 = 0.25;
const INTRO_WINDOW_MAX_SECS: f64 = 600.0;

/// intro-skipper: intros run "between 15 seconds and 2 minutes".
const INTRO_MIN_SECS: f64 = 15.0;
const INTRO_MAX_SECS: f64 = 120.0;

/// How much of the end of a file the closing theme is looked for in.
///
/// intro-skipper detects credits "shorter than 4 minutes"; the window is wider
/// than the thing being looked for so a segment that starts early is still
/// wholly inside it.
const CREDITS_WINDOW_SECS: f64 = 480.0;

/// A closing segment shorter than this is a sting, not credits. Longer than
/// this and something has matched most of the episode.
const CREDITS_MIN_SECS: f64 = 15.0;
const CREDITS_MAX_SECS: f64 = 300.0;

/// Maximum `Segment::score` accepted, where 0 is identical and 32 is unrelated.
///
/// A threshold, not a fact — see the module note. Deliberately strict: a missed
/// intro costs a button that does not appear, a false one costs content nobody
/// sees.
const MAX_SCORE: f64 = 8.0;

/// How far apart two candidate starts can be and still be the same segment.
///
/// Fingerprint items are ~0.124 s, and different releases of the same episode
/// vary by a frame or two either way.
const CLUSTER_TOLERANCE_SECS: f64 = 3.0;

/// A file to analyse.
pub struct Episode {
    pub file_id: i64,
    pub path: String,
    /// Copied onto the stored row, so a file replaced on disk is analysed again
    /// rather than keeping markers measured against bytes that are gone.
    pub size: i64,
    pub mtime: i64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Analysis {
    pub intro: Option<(f64, f64)>,
    pub credits: Option<(f64, f64)>,
}

impl Analysis {
    pub fn is_empty(&self) -> bool {
        self.intro.is_none() && self.credits.is_none()
    }
}

/// The two stretches of a file that are worth decoding, in seconds.
struct Windows {
    head: (f64, f64),
    tail: Option<(f64, f64)>,
}

/// Where to look in a file of a given length.
///
/// The tail is `None` when the file is too short for the windows not to
/// overlap. Letting them overlap would let the opening theme be found in the
/// closing window and reported as credits, which on a short file would end
/// playback in the middle of it.
fn windows(duration: f64) -> Windows {
    let head_len = (duration * INTRO_WINDOW_FRACTION).min(INTRO_WINDOW_MAX_SECS);
    let head = (0.0, head_len);

    let tail_start = (duration - CREDITS_WINDOW_SECS).max(0.0);
    let tail = (tail_start > head_len).then_some((tail_start, duration - tail_start));

    Windows { head, tail }
}

/// How many other episodes must agree before a segment is believed.
///
/// Two where there are enough episodes to ask three. A two-episode season can
/// only ever manage one agreement, and refusing to answer at all there would be
/// worse than answering from a single pairing — the pair still had to match.
fn min_support(episode_count: usize) -> usize {
    if episode_count >= 3 {
        2
    } else {
        1
    }
}

/// Fingerprint one window of one file.
fn fingerprint(
    ffmpeg_path: &Path,
    video: &Path,
    window: (f64, f64),
    config: &Configuration,
) -> Result<Vec<u32>, String> {
    let samples = ffmpeg::decode_window(ffmpeg_path, video, window.0, window.1)?;
    if samples.is_empty() {
        return Err(format!("no audio decoded from {}", video.display()));
    }

    let mut printer = Fingerprinter::new(config);
    printer
        .start(ffmpeg::SAMPLE_RATE, 1)
        .map_err(|e| format!("could not start fingerprinting: {e}"))?;
    printer.consume(&samples);
    printer.finish();

    Ok(printer.fingerprint().to_vec())
}

/// Every segment that `index` shares with any other episode, in file seconds.
fn candidates(
    index: usize,
    prints: &[Vec<u32>],
    offset: f64,
    config: &Configuration,
) -> Vec<(f64, f64)> {
    let mut found = Vec::new();

    for (other, print) in prints.iter().enumerate() {
        if other == index || prints[index].is_empty() || print.is_empty() {
            continue;
        }
        // A pair that cannot be compared is not a pair that disagrees. Skipping
        // it costs one vote; treating it as evidence would invent one.
        let Ok(segments) = match_fingerprints(&prints[index], print, config) else {
            continue;
        };

        for segment in segments {
            if segment.score > MAX_SCORE {
                continue;
            }
            // start1/end1 are seconds into *this* episode's window, so the
            // window's own offset turns them into times in the file.
            found.push((
                offset + segment.start1(config) as f64,
                offset + segment.end1(config) as f64,
            ));
        }
    }

    found
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values[values.len() / 2]
}

/// The segment the most pairings agree on, if enough of them do.
///
/// Candidates are clustered by start time and the largest cluster wins. The
/// answer is the median of that cluster, not its first or widest member: one
/// pairing that matched a couple of seconds long should not stretch the marker
/// for everybody.
fn consensus(
    mut found: Vec<(f64, f64)>,
    support: usize,
    min_len: f64,
    max_len: f64,
) -> Option<(f64, f64)> {
    found.retain(|(start, end)| {
        let length = end - start;
        length >= min_len && length <= max_len && *start >= 0.0
    });
    if found.is_empty() {
        return None;
    }

    found.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut best: &[(f64, f64)] = &[];
    let mut lower = 0;
    for upper in 0..found.len() {
        while found[upper].0 - found[lower].0 > CLUSTER_TOLERANCE_SECS {
            lower += 1;
        }
        if upper + 1 - lower > best.len() {
            best = &found[lower..=upper];
        }
    }

    if best.len() < support {
        return None;
    }

    let mut starts: Vec<f64> = best.iter().map(|c| c.0).collect();
    let mut ends: Vec<f64> = best.iter().map(|c| c.1).collect();
    Some((median(&mut starts), median(&mut ends)))
}

/// Analyse one season's worth of episodes together.
///
/// Returns one [`Analysis`] per episode, in the order given. An episode whose
/// audio could not be read gets an empty one rather than aborting the season —
/// one unreadable file in a folder of twenty should cost that file's markers
/// and nothing else.
///
/// `progress` is called with a human-readable line per file, because a season
/// takes minutes and silence for minutes is indistinguishable from a hang.
pub fn analyse_season(
    ffmpeg_path: &Path,
    episodes: &[Episode],
    mut progress: impl FnMut(String),
) -> Vec<Analysis> {
    let config = Configuration::preset_test1();
    let count = episodes.len();
    let mut results = vec![Analysis::default(); count];

    if count < 2 {
        // Nothing to compare against. This is not a failure — a season with one
        // episode simply has no repeated audio to find.
        return results;
    }

    let mut head_prints: Vec<Vec<u32>> = vec![Vec::new(); count];
    let mut tail_prints: Vec<Vec<u32>> = vec![Vec::new(); count];
    let mut head_offsets = vec![0.0; count];
    let mut tail_offsets = vec![0.0; count];

    for (i, episode) in episodes.iter().enumerate() {
        let video = Path::new(&episode.path);
        let name = video
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| episode.path.clone());

        progress(format!("reading {} of {}: {name}", i + 1, count));

        let Some(duration) = ffmpeg::duration_secs(ffmpeg_path, video) else {
            progress(format!("skipped (no duration): {name}"));
            continue;
        };

        let windows = windows(duration);

        match fingerprint(ffmpeg_path, video, windows.head, &config) {
            Ok(print) => {
                head_prints[i] = print;
                head_offsets[i] = windows.head.0;
            }
            Err(e) => progress(format!("skipped: {e}")),
        }

        if let Some(tail) = windows.tail {
            match fingerprint(ffmpeg_path, video, tail, &config) {
                Ok(print) => {
                    tail_prints[i] = print;
                    tail_offsets[i] = tail.0;
                }
                Err(e) => progress(format!("skipped end of file: {e}")),
            }
        }
    }

    progress(format!("comparing {count} episodes"));
    let support = min_support(count);

    for i in 0..count {
        results[i].intro = consensus(
            candidates(i, &head_prints, head_offsets[i], &config),
            support,
            INTRO_MIN_SECS,
            INTRO_MAX_SECS,
        );
        results[i].credits = consensus(
            candidates(i, &tail_prints, tail_offsets[i], &config),
            support,
            CREDITS_MIN_SECS,
            CREDITS_MAX_SECS,
        );
    }

    results
}

// ---- grouping a library root into seasons -----------------------------------

/// One season's files, in episode order.
pub struct Season {
    pub label: String,
    pub episodes: Vec<Episode>,
}

/// Group a library root's files into the sets that should be compared together.
///
/// Keyed on the **title and season**, not on the folder. Those are usually the
/// same thing and occasionally are not: this machine's Sex and the City season
/// has ten episodes in a `Season 1` subfolder and two still loose in the show
/// folder above it. Grouping by directory would have compared two sets of one
/// and found nothing, in complete silence.
///
/// `title_id` is used when the file is matched and `parsed_title` when it is
/// not, which is what lets this work on the Needs attention queue — the one
/// thing neither Skiptro nor TheIntroDB can do.
pub fn seasons_in_root(conn: &rusqlite::Connection, root_id: i64) -> rusqlite::Result<Vec<Season>> {
    let mut statement = conn.prepare(
        "SELECT m.id, m.path, m.size_bytes, m.modified_at,
                m.title_id, m.parsed_title, m.parsed_season, m.parsed_episode,
                a.file_id IS NOT NULL
                  AND a.file_size = m.size_bytes
                  AND a.file_mtime = m.modified_at AS fresh
           FROM media_files m
           LEFT JOIN analysed_segments a ON a.file_id = m.id
          WHERE m.root_id = ?1
            AND m.missing = 0
            AND m.parsed_season IS NOT NULL
          ORDER BY m.parsed_season, m.parsed_episode, m.path",
    )?;

    struct Row {
        episode: Episode,
        key: String,
        fresh: bool,
    }

    let rows = statement.query_map([root_id], |r| {
        let title_id: Option<i64> = r.get(4)?;
        let parsed_title: Option<String> = r.get(5)?;
        let season: i64 = r.get(6)?;
        let key = match title_id {
            Some(id) => format!("title:{id}|s{season}"),
            None => format!("name:{}|s{season}", parsed_title.unwrap_or_default()),
        };
        Ok(Row {
            episode: Episode {
                file_id: r.get(0)?,
                path: r.get(1)?,
                size: r.get(2)?,
                mtime: r.get(3)?,
            },
            key,
            fresh: r.get(8)?,
        })
    })?;

    let mut order: Vec<String> = Vec::new();
    let mut grouped: std::collections::HashMap<String, (Vec<Episode>, bool)> =
        std::collections::HashMap::new();

    for row in rows.flatten() {
        let entry = grouped.entry(row.key.clone()).or_insert_with(|| {
            order.push(row.key.clone());
            (Vec::new(), true)
        });
        // A season is skipped only when *every* file in it is already analysed
        // against its current bytes. Analysis is a whole-season operation —
        // there is nothing to compare one new episode against on its own.
        entry.1 &= row.fresh;
        entry.0.push(row.episode);
    }

    Ok(order
        .into_iter()
        .filter_map(|key| {
            let (episodes, all_fresh) = grouped.remove(&key)?;
            (!all_fresh && episodes.len() >= 2).then_some(Season {
                label: key,
                episodes,
            })
        })
        .collect())
}

/// Store one season's results, including the empty ones.
///
/// An episode that yielded nothing still gets a row. Without it, a show that
/// genuinely has no intro is re-analysed on every run for as long as it exists.
pub fn store(
    conn: &rusqlite::Connection,
    episodes: &[Episode],
    results: &[Analysis],
    now: i64,
) -> rusqlite::Result<()> {
    for (episode, analysis) in episodes.iter().zip(results) {
        conn.execute(
            "INSERT INTO analysed_segments
                (file_id, intro_start, intro_end, credits_start, credits_end,
                 file_size, file_mtime, analysed_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(file_id) DO UPDATE SET
                intro_start   = excluded.intro_start,
                intro_end     = excluded.intro_end,
                credits_start = excluded.credits_start,
                credits_end   = excluded.credits_end,
                file_size     = excluded.file_size,
                file_mtime    = excluded.file_mtime,
                analysed_at   = excluded.analysed_at",
            rusqlite::params![
                episode.file_id,
                analysis.intro.map(|s| s.0),
                analysis.intro.map(|s| s.1),
                analysis.credits.map(|s| s.0),
                analysis.credits.map(|s| s.1),
                episode.size,
                episode.mtime,
                now,
            ],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_intro_window_is_the_smaller_of_a_quarter_and_ten_minutes() {
        // A 25-minute episode: a quarter of it wins.
        assert_eq!(windows(1500.0).head, (0.0, 375.0));
        // A 90-minute one: the ten-minute cap wins.
        assert_eq!(windows(5400.0).head, (0.0, 600.0));
    }

    #[test]
    fn the_closing_window_is_the_last_eight_minutes() {
        let tail = windows(1500.0).tail.expect("a 25-minute file has room");
        assert_eq!(tail, (1020.0, 480.0));
    }

    /// The windows must never meet. On a short file the opening theme would
    /// otherwise be found in the closing window and reported as credits, which
    /// would end playback in the middle of the episode.
    #[test]
    fn a_short_file_gets_no_closing_window_rather_than_an_overlapping_one() {
        assert!(windows(500.0).tail.is_none());
        assert!(windows(120.0).tail.is_none());
    }

    #[test]
    fn two_episodes_can_only_agree_once() {
        assert_eq!(min_support(2), 1);
        assert_eq!(min_support(3), 2);
        assert_eq!(min_support(12), 2);
    }

    #[test]
    fn a_segment_needs_enough_agreement() {
        let one = vec![(0.5, 45.0)];
        assert_eq!(consensus(one.clone(), 2, INTRO_MIN_SECS, INTRO_MAX_SECS), None);
        assert_eq!(
            consensus(one, 1, INTRO_MIN_SECS, INTRO_MAX_SECS),
            Some((0.5, 45.0))
        );
    }

    /// The reported time is the middle of the cluster, so one long match cannot
    /// stretch the marker for everybody.
    #[test]
    fn the_cluster_median_wins_not_the_outlier() {
        let found = vec![(0.4, 45.0), (0.5, 45.6), (0.6, 52.0)];
        assert_eq!(
            consensus(found, 2, INTRO_MIN_SECS, INTRO_MAX_SECS),
            Some((0.5, 45.6))
        );
    }

    /// Three matches around 0.5 s and two around 400 s: the bigger group is the
    /// intro, and the stray pair must not drag it.
    #[test]
    fn the_largest_cluster_wins() {
        let found = vec![
            (0.4, 45.0),
            (0.5, 45.6),
            (0.6, 46.0),
            (400.0, 445.0),
            (401.0, 446.0),
        ];
        let (start, _) = consensus(found, 2, INTRO_MIN_SECS, INTRO_MAX_SECS).unwrap();
        assert!(start < 1.0, "expected the opening cluster, got {start}");
    }

    #[test]
    fn segments_outside_the_duration_bounds_are_dropped() {
        // Five seconds is a sting, six minutes is most of the episode.
        let too_short = vec![(1.0, 6.0), (1.1, 6.1)];
        assert_eq!(consensus(too_short, 1, INTRO_MIN_SECS, INTRO_MAX_SECS), None);

        let too_long = vec![(1.0, 400.0), (1.1, 400.1)];
        assert_eq!(consensus(too_long, 1, INTRO_MIN_SECS, INTRO_MAX_SECS), None);
    }

    #[test]
    fn nothing_found_is_not_an_error() {
        assert_eq!(consensus(Vec::new(), 1, INTRO_MIN_SECS, INTRO_MAX_SECS), None);
    }

    /// Calibration run. **Needs real media**, so it is ignored by default:
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
    /// ```
    ///
    /// This is how MAX_SCORE and CLUSTER_TOLERANCE_SECS were set, and how to
    /// re-check them. Point it at a season and compare the intro it reports
    /// against one already known — Skiptro's, or a stopwatch.
    #[test]
    #[ignore = "needs a real season on disk"]
    fn calibrate_against_a_real_season() {
        let dir = std::env::var("PN_SEASON_DIR").unwrap_or_else(|_| {
            r"D:\Media\TV Shows\Example Show\Season 1".into()
        });

        let mut episodes: Vec<Episode> = std::fs::read_dir(&dir)
            .expect("season folder should exist")
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                matches!(
                    p.extension().and_then(|e| e.to_str()),
                    Some("mkv" | "mp4" | "m4v" | "avi")
                )
            })
            .enumerate()
            .map(|(i, p)| Episode {
                file_id: i as i64,
                path: p.to_string_lossy().into_owned(),
                size: 0,
                mtime: 0,
            })
            .collect();
        episodes.sort_by(|a, b| a.path.cmp(&b.path));

        assert!(episodes.len() >= 2, "need at least two episodes in {dir}");

        let ffmpeg_path = ffmpeg::resolve(None);
        assert!(ffmpeg::is_available(&ffmpeg_path), "ffmpeg must be on PATH");

        let results = analyse_season(&ffmpeg_path, &episodes, |line| println!("  {line}"));

        for (episode, analysis) in episodes.iter().zip(&results) {
            let name = Path::new(&episode.path).file_name().unwrap().to_string_lossy();
            println!(
                "{name}\n    intro   {:?}\n    credits {:?}",
                analysis.intro, analysis.credits
            );
        }
    }
}
