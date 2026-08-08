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

// ---- refining the credits boundary against the picture ----------------------
//
// The audio answer says where the closing *theme* starts. What the viewer sees
// as the start of the credits is the fade to black just before it, and the two
// are usually a second or two apart — occasionally much more, when an episode's
// credit music differs from the rest of the season and only its final bars are
// shared. So the picture gets the last word on the boundary, within limits.

/// How far earlier than the audio answer the boundary may be moved.
///
/// Generous, because the case this exists for is exactly a large correction:
/// this library's pilot shares only its last 27.7 s with the rest of the season
/// and its marker lands 32 s late. Beyond this the audio consensus — which is a
/// whole season agreeing — is the better answer.
const MAX_CREDITS_SHIFT_SECS: f64 = 45.0;

/// …and how far later. Only enough to snap onto a fade that begins a moment
/// after the music does.
const SNAP_FORWARD_SECS: f64 = 2.0;

/// Two black periods closer together than this are one credits sequence.
///
/// Credits that roll over black are a run of cards separated by short fades,
/// not one continuous black stretch. This is what joins them up.
const BLACK_RUN_GAP_SECS: f64 = 10.0;

/// How much of the region being reclaimed must actually be black.
///
/// The first of two safety rules. Moving the marker earlier means offering the
/// next episode sooner, and the standing principle is that late costs a few
/// seconds of credits while early costs the end of the episode. Requiring the
/// reclaimed region to be mostly black means what is being skipped is already
/// black frames and card transitions rather than a scene fading out.
const BLACK_RUN_MIN_FRACTION: f64 = 0.5;

/// How much longer than the season's own credits a refined segment may be.
///
/// **The second safety rule, and the one that actually does the work.** The
/// fraction above cannot tell a good long walk from a bad short one — measured
/// here, the pilot's correct 32-second walk crosses *more* visible picture
/// (15 s) than the wrong 6-second walks do (2 s), so no threshold on blackness
/// separates them.
///
/// What separates them is the season. Every episode agrees its credits run
/// about 69 seconds; the audio consensus establishes that across the whole
/// folder and it is the strongest evidence available. A refinement that makes
/// one episode's credits materially *longer* than its season's is therefore not
/// finding a boundary, it is reaching back into the episode — regardless of how
/// black the region looks.
///
/// On this library the separation is clean: the pilot's correction yields 59.8 s
/// and is taken, five episodes that would have stretched to 72–76 s are refused
/// and keep their audio answer, and the rest move by under a second.
const CREDITS_LENGTH_TOLERANCE_SECS: f64 = 2.0;

/// Whether a refined boundary may be taken.
///
/// `longest` is this season's own credits length plus a tolerance, or `None`
/// when the season produced no credits at all to measure against.
fn accept_refined(refined: f64, end: f64, longest: Option<f64>) -> bool {
    let length = end - refined;
    length >= CREDITS_MIN_SECS && longest.is_none_or(|limit| length <= limit)
}

/// How much of `[from, to]` is black.
fn black_within(periods: &[(f64, f64)], from: f64, to: f64) -> f64 {
    if to <= from {
        return 0.0;
    }
    periods
        .iter()
        .map(|(start, end)| (end.min(to) - start.max(from)).max(0.0))
        .sum()
}

/// Move a credits start onto the picture's own boundary, where there is one.
///
/// Returns `None` when the picture offers nothing better, which is the common
/// case for a file that cuts straight to credits over a live shot.
///
/// Two steps. First find the black period the audio answer lands in or just
/// after — that alone fixes the ordinary case, where the theme starts a fraction
/// of a second into the fade. Then walk *backwards* through the run of card
/// transitions, and keep that longer answer only if the region it reclaims is
/// mostly black.
fn refine_credits_start(periods: &[(f64, f64)], audio_start: f64, earliest: f64) -> Option<f64> {
    let anchor = periods
        .iter()
        .filter(|(start, _)| *start <= audio_start + SNAP_FORWARD_SECS)
        .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))?;

    let floor = earliest.max(audio_start - MAX_CREDITS_SHIFT_SECS);
    if anchor.0 < floor {
        return None;
    }

    // Walk back while each gap is short enough to be a transition between two
    // credit cards rather than the end of a scene.
    let mut start = anchor.0;
    loop {
        let previous = periods
            .iter()
            .filter(|(s, e)| *s < start && start - *e <= BLACK_RUN_GAP_SECS && *s >= floor)
            .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        match previous {
            Some((s, _)) => start = *s,
            None => break,
        }
    }

    if start < anchor.0 {
        let span = audio_start - start;
        let black = black_within(periods, start, audio_start);
        // Not black enough to be credits. Keep the anchor, which is a snap onto
        // the nearest fade rather than a relocation.
        if span > 0.0 && black / span < BLACK_RUN_MIN_FRACTION {
            start = anchor.0;
        }
    }

    (start < audio_start - 0.01 || start > audio_start + 0.01).then_some(start)
}

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
    // Kept for the refinement pass: it needs to know how far back the closing
    // window reaches, so a boundary can never be moved outside it.
    let mut tail_starts: Vec<Option<f64>> = vec![None; count];

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
            tail_starts[i] = Some(tail.0);
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

    // ---- second pass: let the picture correct the closing boundary ----------
    //
    // Only for episodes that got a credits marker at all, and only over the
    // stretch the boundary could legally move within — about a minute of video
    // rather than the eight minutes the audio pass read. Decoding pictures is
    // far more expensive than decoding sound, and this is the whole reason it
    // stays affordable.

    // How long this season's credits actually run, from the answers the audio
    // already agreed on. The median rather than the mean, so the one outlier
    // this exists to correct cannot move the standard it is judged against.
    let mut lengths: Vec<f64> = results
        .iter()
        .filter_map(|a| a.credits)
        .map(|(start, end)| end - start)
        .collect();
    let longest_credits = (!lengths.is_empty())
        .then(|| median(&mut lengths) + CREDITS_LENGTH_TOLERANCE_SECS);

    for (i, episode) in episodes.iter().enumerate() {
        let Some((audio_start, end)) = results[i].credits else {
            continue;
        };
        let Some(tail_start) = tail_starts[i] else {
            continue;
        };

        let video = Path::new(&episode.path);
        let name = video
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| episode.path.clone());
        progress(format!("checking the picture at the credits: {name}"));

        let from = (audio_start - MAX_CREDITS_SHIFT_SECS).max(tail_start).max(0.0);
        let to = audio_start + SNAP_FORWARD_SECS;
        let periods = ffmpeg::black_periods(ffmpeg_path, video, from, to - from);

        if let Some(refined) = refine_credits_start(&periods, audio_start, from) {
            if accept_refined(refined, end, longest_credits) {
                progress(format!(
                    "credits {audio_start:.1}s → {refined:.1}s from the picture: {name}"
                ));
                results[i].credits = Some((refined, end));
            } else {
                progress(format!(
                    "kept the audio credits at {audio_start:.1}s — the picture would have \
                     stretched them to {:.0}s: {name}",
                    end - refined
                ));
            }
        }
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
/// same thing and occasionally are not: this machine's Example Show season
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

    // ---- credits boundary against the picture -------------------------------
    //
    // Every fixture below is real `blackdetect` output from this library,
    // converted to file time. They are the calibration for the three constants.

    /// The pilot. Its credit music differs from the rest of the season, so only
    /// its last 27.7 s matched and the audio marker landed 32 s late. The run of
    /// card transitions starts at 1540.7 — exactly 70 s before the end, which is
    /// the credits length every other episode agrees on.
    #[test]
    fn walks_back_through_a_credits_run_that_is_mostly_black() {
        let periods = vec![
            (1540.706, 1542.458),
            (1546.381, 1551.470),
            (1557.225, 1559.603),
            (1562.481, 1564.316),
            (1567.194, 1576.578),
        ];
        let refined = refine_credits_start(&periods, 1572.821, 1130.0).unwrap();
        assert!((refined - 1540.706).abs() < 0.01, "got {refined}");
    }

    /// The same walk, refused. Episode 3 has fades at 1354.2 and 1357.8 before
    /// its credits, but the region they would reclaim is only 26% black — the
    /// last scene fading out, not credit cards. So the marker stays put, moving
    /// six tenths of a second forward onto the fade the credits actually begin
    /// with rather than six seconds back into the episode.
    #[test]
    fn refuses_to_walk_back_across_a_region_that_is_mostly_picture() {
        let periods = vec![
            (1354.228, 1354.603),
            (1357.815, 1359.066),
            (1361.026, 1368.617),
        ];
        let refined = refine_credits_start(&periods, 1360.397, 960.0).unwrap();
        assert!(
            (refined - 1361.026).abs() < 0.01,
            "expected the snap, not the walk — got {refined}"
        );
        assert!(refined > 1360.0, "must not move back into the episode");
    }

    /// The ordinary case: the theme starts a tenth of a second into the fade,
    /// and the boundary moves by that tenth. Episode 4.
    #[test]
    fn snaps_onto_the_fade_the_music_starts_inside() {
        let periods = vec![
            (1332.039, 1332.790),
            (1334.792, 1346.428),
            (1354.937, 1359.108),
        ];
        let refined = refine_credits_start(&periods, 1334.909, 934.0).unwrap();
        assert!((refined - 1334.792).abs() < 0.01, "got {refined}");
    }

    #[test]
    fn a_file_with_no_black_at_all_keeps_its_audio_answer() {
        assert_eq!(refine_credits_start(&[], 1360.0, 960.0), None);
    }

    /// Nothing may be dragged further than the audio consensus is worth — a
    /// whole season agreeing beats one fade a long way off.
    #[test]
    fn refuses_a_boundary_further_back_than_the_shift_allows() {
        let periods = vec![(1200.0, 1260.0)];
        assert_eq!(refine_credits_start(&periods, 1400.0, 900.0), None);
    }

    /// …and never outside the window the audio was measured in.
    #[test]
    fn never_moves_the_boundary_out_of_the_closing_window() {
        let periods = vec![(1000.0, 1050.0), (1355.0, 1360.0)];
        let refined = refine_credits_start(&periods, 1360.0, 1340.0).unwrap();
        assert!(refined >= 1340.0, "got {refined}");
    }

    /// A fade that begins after the music does is still the visual boundary, so
    /// long as it is close.
    #[test]
    fn a_fade_just_after_the_music_still_counts() {
        let periods = vec![(1361.0, 1370.0)];
        let refined = refine_credits_start(&periods, 1360.0, 960.0).unwrap();
        assert!((refined - 1361.0).abs() < 0.01, "got {refined}");
    }

    /// Black periods far past the marker are the end of the file, not its start.
    #[test]
    fn ignores_black_well_past_the_credits_start() {
        assert_eq!(refine_credits_start(&[(1435.2, 1440.2)], 1360.0, 960.0), None);
    }

    /// The rule that decides the five awkward episodes. Their credits end at
    /// 1607.6; the audio starts them at 1538.3 for a 69 s segment, and the
    /// picture would drag that back to 1531.8 for a 76 s one. The season says
    /// 69 s, so 76 s is not a boundary — it is two seconds of the last shot.
    #[test]
    fn refuses_a_boundary_that_outruns_the_seasons_own_credits() {
        let limit = Some(69.3 + CREDITS_LENGTH_TOLERANCE_SECS);
        assert!(!accept_refined(1531.780, 1607.610, limit), "76s should be refused");
        assert!(accept_refined(1538.277, 1607.610, limit), "69s should be taken");
    }

    /// …and the pilot's correction, which is the whole point: it *shortens* the
    /// segment to 59.8 s, so the same rule waves it through.
    #[test]
    fn allows_the_correction_that_shortens_a_segment() {
        let limit = Some(69.3 + CREDITS_LENGTH_TOLERANCE_SECS);
        assert!(accept_refined(1540.706, 1600.554, limit));
    }

    #[test]
    fn a_season_with_nothing_to_measure_against_falls_back_to_the_minimum() {
        assert!(accept_refined(1000.0, 1100.0, None));
        // Still never shorter than credits can be.
        assert!(!accept_refined(1095.0, 1100.0, None));
    }

    #[test]
    fn measures_only_the_black_inside_the_span() {
        let periods = vec![(0.0, 10.0), (20.0, 30.0)];
        assert!((black_within(&periods, 5.0, 25.0) - 10.0).abs() < 1e-9);
        assert!((black_within(&periods, 25.0, 5.0)).abs() < 1e-9);
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
    ///
    /// The season is yours to choose: set `KINEMA_SEASON_DIR` to a folder
    /// holding at least two episodes. There is no default, because the
    /// thresholds above were calibrated against one programme and the whole
    /// value of running this is to try them against a different one.
    #[test]
    #[ignore = "needs a real season on disk"]
    fn calibrate_against_a_real_season() {
        let Ok(dir) = std::env::var("KINEMA_SEASON_DIR") else {
            println!("set KINEMA_SEASON_DIR to a season folder to run this");
            return;
        };

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
