//! Running Skiptro, the intro detector.
//!
//! Skiptro is **not bundled and never will be** — no third-party binary enters
//! this repo or its output. What this module does is run a copy the user has
//! installed themselves, at a path they chose, so that detecting intros stops
//! being a separate chore in another window.
//!
//!   skiptro scan <dir>      detect intros, into Skiptro's own database
//!   skiptro export <dir>    write .skiptro.json sidecars beside the videos
//!
//! **The export step is now off by default**, and that is the point of it being
//! a template rather than a flag. `skip.rs` reads Skiptro's database directly,
//! so the sidecars were one redundant file per episode sitting in the media
//! folders for information the app could already ask for. An empty template
//! means "do not run this step"; anyone who wants the sidecars — to feed some
//! other player from the same scan — types `export {dir}` back in.
//!
//! Both templates are **editable text** rather than hard-coded. The maintenance
//! rule that kept yt-dlp out applies here too: when a tool's command line
//! changes, this should be a line of text in Settings, not a rebuild.

use crate::library::Db;
use crate::settings::setting;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::{Emitter, Manager};

fn to_string_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Event name for streamed output. One line per emit.
const PROGRESS_EVENT: &str = "skiptro-progress";

pub const PATH_KEY: &str = "skiptro_path";
pub const SCAN_ARGS_KEY: &str = "skiptro_scan_args";
pub const EXPORT_ARGS_KEY: &str = "skiptro_export_args";

/// Setting key: whether the built-in audio analysis runs by itself after a scan.
///
/// `'off'` disables it; anything else, **including unset**, leaves it on. The
/// default is on because the failure it prevents is invisible — see
/// [`auto_detect`] — and the cost of it being wrong is some ffmpeg time, not a
/// wrong marker.
pub const AUTO_ANALYSE_KEY: &str = "auto_analyse_enabled";

/// Setting key: what a TV root looked like when Skiptro last scanned it.
///
/// Per root, so adding a season to one library does not re-scan the other.
fn skiptro_stamp_key(root_id: i64) -> String {
    format!("skiptro_auto_stamp_{root_id}")
}

pub const DEFAULT_SCAN_ARGS: &str = "scan {dir}";

/// Empty: no export, no sidecars. See the module note — the app reads Skiptro's
/// database, so exporting is now opt-in rather than the way markers arrive.
pub const DEFAULT_EXPORT_ARGS: &str = "";

#[derive(Serialize, Clone)]
pub struct DetectProgress {
    /// Which of the two commands this line came from.
    pub step: String,
    pub line: String,
}

#[derive(Serialize)]
pub struct StepReport {
    pub step: String,
    pub exit_code: Option<i32>,
    /// The last few lines, so a failure says something without the event log.
    pub tail: Vec<String>,
}

#[derive(Serialize)]
pub struct DetectReport {
    pub ok: bool,
    /// Stop was pressed. Not a failure, and the UI says so differently.
    pub stopped: bool,
    pub steps: Vec<StepReport>,
}

/// Split a template into arguments, respecting double quotes.
///
/// Deliberately **not** handed to a shell. Arguments go to the process
/// individually, so a path containing spaces — `…\Media Library\TV Shows`, which
/// is the ordinary case — needs no quoting or escaping at any point, and there
/// is no shell to interpret anything else the path happens to contain.
fn tokenise(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;

    for ch in template.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    out.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        out.push(current);
    }
    out
}

/// Replace `{dir}` wherever it appears, after tokenising — so the directory is
/// substituted into a single argument and can never be split on its spaces.
fn build_args(template: &str, dir: &str) -> Vec<String> {
    tokenise(template)
        .into_iter()
        .map(|token| token.replace("{dir}", dir))
        .collect()
}

/// Run one Skiptro command, streaming its output to the frontend as it arrives.
///
/// Line-buffered rather than collected: a scan of a season takes minutes, and a
/// progress display that only appears at the end is the same as none.
fn run_step(
    app: &tauri::AppHandle,
    exe: &str,
    step: &str,
    args: &[String],
) -> Result<StepReport, String> {
    let mut command = Command::new(exe);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());

    // Without this every step flashes a console window over the app.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start {exe}: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Shared with the job registry so Stop — or closing the app — can kill it.
    // Killing closes its pipes, which ends the reads below on their own.
    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    let jobs = app.state::<crate::jobs::Jobs>();
    jobs.watch_child(child.clone());

    // stderr is drained on its **own thread**, not after stdout closes. The
    // pipe buffers are finite: a child that fills stderr while this side is
    // blocked reading stdout stops writing, so stdout never closes either and
    // both sides wait forever. Rare — Skiptro writes progress to stdout — but a
    // hang with no output is the worst possible failure for a long-running job.
    let stderr_thread = stderr.map(|stream| {
        let app = app.clone();
        let step = step.to_string();
        std::thread::spawn(move || drain(&app, &step, stream))
    });

    let mut tail = match stdout {
        Some(stream) => drain(app, step, stream),
        None => Vec::new(),
    };

    if let Some(handle) = stderr_thread {
        if let Ok(errors) = handle.join() {
            tail.extend(errors);
        }
    }

    jobs.forget_child();
    let status = child
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .wait()
        .map_err(to_string_err)?;

    // Keep only the end. A failure is explained by its last few lines, and a
    // full season's output is thousands of them.
    if tail.len() > TAIL_LINES {
        tail.drain(..tail.len() - TAIL_LINES);
    }

    Ok(StepReport {
        step: step.to_string(),
        exit_code: status.code(),
        tail,
    })
}

/// How many trailing output lines a step keeps for its report.
const TAIL_LINES: usize = 40;

/// Run Skiptro's scan, and its export when one is configured, over a directory.
///
/// Returns the reports and whether everything that ran succeeded. Shared by the
/// Detect button and the automatic pass so the two cannot drift — they differ
/// only in what they do about a failure, which is the caller's business.
fn run_skiptro(
    app: &tauri::AppHandle,
    exe: &str,
    scan_args: &str,
    export_args: &str,
    root_path: &str,
) -> Result<(Vec<StepReport>, bool), String> {
    let mut steps = Vec::new();

    for (name, template) in [("scan", scan_args), ("export", export_args)] {
        let args = build_args(template, root_path);
        // An empty template is "skip this step", which is how exporting is
        // switched off. Running the executable with no arguments at all would
        // print its help and exit 1, reporting a failure that never happened.
        if args.is_empty() {
            continue;
        }
        let report = run_step(app, exe, name, &args)?;
        let failed = report.exit_code != Some(0);
        steps.push(report);
        // Exporting after a failed scan would write sidecars from stale
        // detections, or none at all while reporting success.
        if failed {
            return Ok((steps, false));
        }
    }

    Ok((steps, true))
}

/// Emit every line of a stream as it arrives, and return them.
fn drain<R: std::io::Read>(app: &tauri::AppHandle, step: &str, stream: R) -> Vec<String> {
    let mut lines = Vec::new();
    for line in BufReader::new(stream).lines().map_while(Result::ok) {
        let _ = app.emit(
            PROGRESS_EVENT,
            DetectProgress {
                step: step.to_string(),
                line: line.clone(),
            },
        );
        lines.push(line);
    }
    lines
}

/// Run this app's own audio analysis over a library root.
///
/// Reported as one more step so the UI needs no second button and no second
/// progress display. It is deliberately **not** fatal: a missing ffmpeg or an
/// unreadable season leaves whatever Skiptro found intact, which is the same
/// arrangement every other source has.
/// How long a file must have sat unchanged before the automatic pass will
/// fingerprint the season it is in.
///
/// A download or a large copy into a watched folder is scanned repeatedly while
/// it grows, and each new size makes the whole season stale — analysis compares
/// episodes against each other, so one changed file costs a re-fingerprint of
/// all of them. Left alone, a season being downloaded is analysed once per
/// launch until it finishes, which is minutes of ffmpeg each time for an answer
/// that is about to be thrown away.
///
/// Five minutes is long enough that anything still arriving is still arriving,
/// and short enough that a season copied and left alone is ready by the time it
/// is watched. It defers, never refuses: the next scan picks the season up, and
/// the report says what it is waiting for.
///
/// **The Detect button ignores this entirely.** Pressing it is saying "now".
const SETTLING_SECS: i64 = 5 * 60;

/// Split seasons into those ready to analyse and those still settling.
///
/// A season is held back whole, because that is the unit the analysis works in:
/// there is nothing useful to do with the nine finished episodes of a season
/// whose tenth is still arriving, since the tenth will make all of them stale
/// again the moment it lands.
fn split_settled(
    seasons: Vec<crate::analyse::Season>,
    settling_secs: Option<i64>,
) -> (Vec<crate::analyse::Season>, Vec<crate::analyse::Season>) {
    let Some(secs) = settling_secs else {
        return (seasons, Vec::new());
    };
    let cutoff = now_secs() - secs;
    seasons
        .into_iter()
        .partition(|season| season.episodes.iter().all(|e| e.mtime <= cutoff))
}

/// Run this app's own audio analysis over a library root.
///
/// `settling_secs` defers seasons containing a file written that recently; the
/// manual path passes `None` and analyses whatever it finds.
fn run_analysis(
    app: &tauri::AppHandle,
    root_path: &str,
    settling_secs: Option<i64>,
) -> StepReport {
    let mut tail: Vec<String> = Vec::new();
    let mut say = |line: String| {
        let _ = app.emit(
            PROGRESS_EVENT,
            DetectProgress {
                step: "analyse".into(),
                line: line.clone(),
            },
        );
        tail.push(line);
    };

    let (ffmpeg_path, root_id) = {
        let db = app.state::<Db>();
        let Ok(conn) = db.0.lock() else {
            say("could not read settings".into());
            return step("analyse", None, tail);
        };
        let ffmpeg_path = crate::ffmpeg::resolve(setting(&conn, crate::ffmpeg::PATH_KEY).as_deref());
        let root_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM library_roots WHERE path = ?1",
                rusqlite::params![root_path],
                |r| r.get(0),
            )
            .ok();
        (ffmpeg_path, root_id)
    };

    let Some(root_id) = root_id else {
        say(format!("no library root matches {root_path}"));
        return step("analyse", None, tail);
    };

    if !crate::ffmpeg::is_available(&ffmpeg_path) {
        say(format!(
            "ffmpeg not found at '{}' — set its location in Settings, or leave it blank to use PATH",
            ffmpeg_path.display()
        ));
        return step("analyse", None, tail);
    }

    // The season list is taken under the lock and the lock is then released.
    // Analysis is minutes of ffmpeg per season and must not hold the database
    // against the rest of the app — the same rule the scanner follows.
    let seasons = {
        let db = app.state::<Db>();
        let Ok(conn) = db.0.lock() else {
            say("could not read the library".into());
            return step("analyse", None, tail);
        };
        match crate::analyse::seasons_in_root(&conn, root_id) {
            Ok(seasons) => seasons,
            Err(e) => {
                say(format!("could not list episodes: {e}"));
                return step("analyse", None, tail);
            }
        }
    };

    let (seasons, settling) = split_settled(seasons, settling_secs);

    if !settling.is_empty() {
        // Named, not silent. A season that is skipped for a reason the user
        // cannot see is the exact failure this whole area has already produced
        // once — and "still copying" is a state they can check for themselves.
        say(format!(
            "waiting for {} file(s) still being written",
            settling.iter().map(|s| s.episodes.len()).sum::<usize>()
        ));
    }

    if seasons.is_empty() {
        if settling.is_empty() {
            say("nothing new to analyse".into());
        }
        return step("analyse", Some(0), tail);
    }

    let mut found = 0usize;

    let jobs = app.state::<crate::jobs::Jobs>();

    for season in &seasons {
        say(format!(
            "{}: {} episodes",
            season.label,
            season.episodes.len()
        ));

        let results = crate::analyse::analyse_season(
            &ffmpeg_path,
            &season.episodes,
            jobs.detection_stop_flag(),
            |line| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    DetectProgress {
                        step: "analyse".into(),
                        line,
                    },
                );
            },
        );

        // Seasons already stored stay stored; this one and the rest are
        // picked up by the next run, because nothing was written for them.
        let Some(results) = results else {
            say(format!(
                "analysis stopped part-way; {found} episode(s) with markers kept, the rest waits for the next run"
            ));
            return step("analyse", None, tail);
        };

        found += results.iter().filter(|a| !a.is_empty()).count();

        let db = app.state::<Db>();
        let Ok(conn) = db.0.lock() else {
            say("could not save results".into());
            return step("analyse", None, tail);
        };
        if let Err(e) = crate::analyse::store(&conn, &season.episodes, &results, now_secs()) {
            say(format!("could not save {}: {e}", season.label));
        }
    }

    say(format!("analysed {} episodes with markers", found));
    step("analyse", Some(0), tail)
}

fn step(name: &str, exit_code: Option<i32>, mut tail: Vec<String>) -> StepReport {
    if tail.len() > TAIL_LINES {
        tail.drain(..tail.len() - TAIL_LINES);
    }
    StepReport {
        step: name.to_string(),
        exit_code,
        tail,
    }
}

/// How many episodes are waiting to be analysed, per library root.
///
/// This exists because of a real report: a season added after the last Detect
/// run silently fell back to the *last-resort* credits guess — `duration − 60s`,
/// firing eighteen seconds into the credits — and nothing anywhere said why.
/// Every other refusal in this app is surfaced and correctable; this one was
/// invisible, which is precisely the failure mode the Needs attention queue
/// exists to prevent elsewhere.
///
/// Deliberately **not** an automatic re-run after a scan. Analysis is minutes of
/// ffmpeg per season, and spending that without being asked is exactly what a
/// media library should not do. Saying so and offering the button is enough.
///
/// The count comes from `seasons_in_root`, the same query Detect itself uses, so
/// the number shown is precisely the work the button would do.
#[tauri::command]
pub async fn analysis_backlog(app: tauri::AppHandle) -> Result<Vec<(i64, usize)>, String> {
    crate::jobs::off_main(move || backlog(&app)).await
}

fn backlog(app: &tauri::AppHandle) -> Result<Vec<(i64, usize)>, String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(to_string_err)?;

    let mut statement = conn
        .prepare("SELECT id FROM library_roots WHERE kind = 'tv'")
        .map_err(to_string_err)?;
    let roots: Vec<i64> = statement
        .query_map([], |r| r.get(0))
        .map_err(to_string_err)?
        .flatten()
        .collect();

    let mut backlog = Vec::new();
    for root_id in roots {
        let pending: usize = crate::analyse::seasons_in_root(&conn, root_id)
            .map_err(to_string_err)?
            .iter()
            .map(|season| season.episodes.len())
            .sum();
        backlog.push((root_id, pending));
    }

    Ok(backlog)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---- the automatic pass ----------------------------------------------------

/// What the automatic pass did, or declined to do, for one library root.
#[derive(Serialize, Clone)]
pub struct AutoStep {
    pub root_path: String,
    /// `"skiptro"`, `"analyse"`, or `"root"` when the folder itself was the
    /// problem and neither step could be attempted.
    pub step: String,
    pub ran: bool,
    /// One sentence written for the user rather than for a log: what it did, or
    /// why it did not. Shown in Settings after a scan.
    pub note: String,
}

#[derive(Serialize, Default)]
pub struct AutoDetectReport {
    pub steps: Vec<AutoStep>,
}

/// A fingerprint of what is under a root, which moves only when material is
/// **added or replaced**.
///
/// The newest `first_seen_at` covers an episode that arrived; the newest
/// `modified_at` covers one that was replaced in place. A *deleted* episode
/// moves neither, on purpose — there is nothing new for Skiptro to look at, and
/// re-scanning a library because a file was tidied away is minutes spent for
/// nothing.
///
/// `None` when the question could not be answered, which is treated as "run it".
/// Guessing "nothing changed" from a failed query is the one wrong answer here:
/// it is indistinguishable from success and skips the work silently.
fn root_stamp(conn: &rusqlite::Connection, root_id: i64) -> Option<String> {
    conn.query_row(
        "SELECT COALESCE(MAX(first_seen_at), 0), COALESCE(MAX(modified_at), 0)
           FROM media_files
          WHERE root_id = ?1 AND missing = 0",
        rusqlite::params![root_id],
        |r| Ok(format!("{}:{}", r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )
    .ok()
}

/// Record that Skiptro has now seen everything under this root.
fn remember_stamp(app: &tauri::AppHandle, root_id: i64, stamp: &str) {
    let db = app.state::<Db>();
    let Ok(conn) = db.0.lock() else { return };
    store_setting(&conn, &skiptro_stamp_key(root_id), stamp);
}

/// The same stamp, for the Detect button — which knows the root by its path.
fn remember_skiptro_stamp(app: &tauri::AppHandle, root_path: &str) {
    let db = app.state::<Db>();
    let Ok(conn) = db.0.lock() else { return };

    let root_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM library_roots WHERE path = ?1",
            rusqlite::params![root_path],
            |r| r.get(0),
        )
        .ok();

    if let Some(root_id) = root_id {
        if let Some(stamp) = root_stamp(&conn, root_id) {
            store_setting(&conn, &skiptro_stamp_key(root_id), &stamp);
        }
    }
}

/// How many episodes under one root the automatic analysis would look at now.
///
/// The same query Detect itself uses, **and the same settling rule the
/// automatic run applies**, so the number reported is precisely the work that
/// would be done. Counting a season that is still downloading would put "12
/// episode(s) not analysed" in front of a user whose only available action is
/// to wait.
fn pending_episodes(app: &tauri::AppHandle, root_id: i64) -> usize {
    let db = app.state::<Db>();
    let Ok(conn) = db.0.lock() else { return 0 };

    let seasons = crate::analyse::seasons_in_root(&conn, root_id).unwrap_or_default();
    split_settled(seasons, Some(SETTLING_SECS))
        .0
        .iter()
        .map(|s| s.episodes.len())
        .sum()
}

fn store_setting(conn: &rusqlite::Connection, key: &str, value: &str) {
    if let Err(e) = conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    ) {
        crate::log!("detect: could not remember {key}: {e}");
    }
}

/// What the automatic pass needs to know before it starts doing anything.
struct AutoPlan {
    exe: Option<String>,
    scan_args: String,
    export_args: String,
    auto_analyse: bool,
    /// TV roots only, with the stamp each was left at by the last Skiptro run.
    roots: Vec<(i64, String, Option<String>, Option<String>)>,
}

/// Detect intros and credits for anything new, without being asked.
///
/// Run at the end of every scan. It exists because of the failure that started
/// all this: a season added to a watched folder appeared in the library
/// immediately, had **no marker from any source**, and said nothing about why.
/// The two local detectors only ever ran from a button in Settings, which is the
/// one screen you do not visit when you do not yet know anything is wrong.
///
/// The two steps are deliberately governed differently:
///
/// * **Skiptro always runs**, when it is installed and there is new material.
///   It is fast, it has its own idea of what it has already seen, and its intro
///   outranks everything else — so there is no version of "later" that is better
///   than now.
/// * **The built-in analysis is a setting** ([`AUTO_ANALYSE_KEY`], on by
///   default). It is minutes of ffmpeg per season, which is a real cost to spend
///   unasked, and it is the one step a user might reasonably want to keep on a
///   button.
///
/// **Nothing here is an error.** No Skiptro, no ffmpeg, an unreachable share:
/// each is a step that did not run, reported as a sentence, with every other
/// step carrying on. A media library that refuses to finish scanning because an
/// optional detector is missing would be a worse bug than the one this fixes.
#[tauri::command]
pub async fn auto_detect(app: tauri::AppHandle) -> Result<AutoDetectReport, String> {
    // Detect pressed in Settings is already doing this work — or more of it,
    // since the button ignores the settling rule. Said, not silent.
    let Some(running) = app
        .state::<crate::jobs::Jobs>()
        .try_start(crate::jobs::Job::Detect)
    else {
        return Ok(AutoDetectReport {
            steps: vec![AutoStep {
                root_path: String::new(),
                step: "detect".into(),
                ran: false,
                note: "detection was already running, so it was left to finish".into(),
            }],
        });
    };

    // Everything the plan needs, in one lock. What follows is minutes of
    // subprocess work and must not hold the database against playback.
    let plan = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;

        let mut statement = conn
            .prepare("SELECT id, path FROM library_roots WHERE kind = 'tv' ORDER BY id")
            .map_err(to_string_err)?;
        let roots: Vec<(i64, String, Option<String>, Option<String>)> = statement
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(to_string_err)?
            .flatten()
            .map(|(id, path)| {
                let stamp = root_stamp(&conn, id);
                let last = setting(&conn, &skiptro_stamp_key(id));
                (id, path, stamp, last)
            })
            .collect();

        AutoPlan {
            exe: setting(&conn, PATH_KEY),
            scan_args: setting(&conn, SCAN_ARGS_KEY)
                .unwrap_or_else(|| DEFAULT_SCAN_ARGS.to_string()),
            export_args: setting(&conn, EXPORT_ARGS_KEY)
                .unwrap_or_else(|| DEFAULT_EXPORT_ARGS.to_string()),
            auto_analyse: setting(&conn, AUTO_ANALYSE_KEY).as_deref() != Some("off"),
            roots,
        }
    };

    tauri::async_runtime::spawn_blocking(move || {
        let _running = running;
        let mut steps: Vec<AutoStep> = Vec::new();

        let jobs = app.state::<crate::jobs::Jobs>();

        for (root_id, root_path, stamp, last_stamp) in &plan.roots {
            if jobs.detection_stopped() {
                steps.push(AutoStep {
                    root_path: root_path.clone(),
                    step: "detect".into(),
                    ran: false,
                    note: "you stopped detection; the rest is picked up by the next scan".into(),
                });
                break;
            }
            let mut say = |step: &str, ran: bool, note: String| {
                steps.push(AutoStep {
                    root_path: root_path.clone(),
                    step: step.to_string(),
                    ran,
                    note,
                });
            };

            // An offline NAS is not a detection problem and must not be reported
            // as one. The scanner has already left this root's files alone.
            if !std::path::Path::new(root_path).is_dir() {
                say("root", false, "folder not reachable, so nothing was detected".into());
                continue;
            }

            // ---- Skiptro ----
            //
            // Silence when it was never set up: nothing was expected to happen,
            // so there is nothing to report. A *configured* Skiptro that is not
            // where it was left is the opposite case and says so.
            match &plan.exe {
                None => {}
                Some(exe) if !std::path::Path::new(exe).is_file() => say(
                    "skiptro",
                    false,
                    format!("Skiptro is set to {exe}, which is not there — skipped"),
                ),
                Some(exe) => {
                    if stamp.is_some() && stamp == last_stamp {
                        say("skiptro", false, "no new episodes since its last run".into());
                    } else {
                        match run_skiptro(&app, exe, &plan.scan_args, &plan.export_args, root_path)
                        {
                            Ok((reports, true)) => {
                                // Only a clean run may move the stamp. Storing it
                                // after a failure would mean one bad run made the
                                // new episodes permanently invisible to Skiptro.
                                if let Some(stamp) = stamp {
                                    remember_stamp(&app, *root_id, stamp);
                                }
                                let ran = reports.len();
                                say("skiptro", true, format!("Skiptro finished ({ran} step(s))"));
                            }
                            Ok(_) if jobs.detection_stopped() => {
                                say("skiptro", false, "Skiptro was stopped".into());
                                continue;
                            }
                            Ok((reports, false)) => {
                                let why = reports
                                    .last()
                                    .and_then(|r| r.tail.last().cloned())
                                    .unwrap_or_else(|| "no output".into());
                                say("skiptro", false, format!("Skiptro failed: {why}"));
                            }
                            Err(e) => say("skiptro", false, format!("Skiptro could not run: {e}")),
                        }
                    }
                }
            }

            // ---- the built-in analysis ----
            //
            // The backlog is checked first so the "it is turned off" note only
            // appears when there is actually work being left undone. Saying it
            // after every scan of an up-to-date library would be noise, and noise
            // is how the Settings warning got ignored in the first place.
            let pending = pending_episodes(&app, *root_id);

            if pending == 0 {
                continue;
            }
            if !plan.auto_analyse {
                say(
                    "analyse",
                    false,
                    format!("{pending} episode(s) not analysed — automatic detection is off in Settings"),
                );
                continue;
            }

            let report = run_analysis(&app, root_path, Some(SETTLING_SECS));
            let note = report
                .tail
                .last()
                .cloned()
                .unwrap_or_else(|| "nothing to analyse".into());
            say("analyse", report.exit_code == Some(0), note);
        }

        AutoDetectReport { steps }
    })
    .await
    .map_err(to_string_err)
}

/// Detect intros and credits for one library root.
///
/// Two producers behind one button. Skiptro finds intros by fingerprinting
/// against its own model; this app's analysis finds intros *and credits* by
/// comparing the episodes to each other. Neither is required — with no Skiptro
/// configured the first is skipped, with no ffmpeg the second is, and with
/// neither the button simply reports that there was nothing to run.
///
/// Long-running by nature, so the work happens off the main thread.
#[tauri::command]
pub async fn detect_intros(
    app: tauri::AppHandle,
    root_path: String,
) -> Result<DetectReport, String> {
    let running = app
        .state::<crate::jobs::Jobs>()
        .try_start(crate::jobs::Job::Detect)
        .ok_or(
            "Detection is already running — the library scan starts it by itself. \
             Wait for it to finish, then try again.",
        )?;

    let (exe, scan_args, export_args) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        (
            setting(&conn, PATH_KEY),
            setting(&conn, SCAN_ARGS_KEY).unwrap_or_else(|| DEFAULT_SCAN_ARGS.to_string()),
            setting(&conn, EXPORT_ARGS_KEY).unwrap_or_else(|| DEFAULT_EXPORT_ARGS.to_string()),
        )
    };

    if !std::path::Path::new(&root_path).is_dir() {
        return Err(format!("folder not reachable: {root_path}"));
    }
    if let Some(exe) = &exe {
        if !std::path::Path::new(exe).is_file() {
            return Err(format!("Skiptro executable not found: {exe}"));
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _running = running;
        let mut steps = Vec::new();

        let jobs = app.state::<crate::jobs::Jobs>();

        // Skiptro first, when there is one. Its intro outranks the analysis
        // below, so running it first means the better answer is already in
        // place by the time anything reads either.
        if let Some(exe) = exe {
            let (reports, ok) = run_skiptro(&app, &exe, &scan_args, &export_args, &root_path)?;
            steps.extend(reports);
            if !ok {
                return Ok(DetectReport {
                    ok: false,
                    stopped: jobs.detection_stopped(),
                    steps,
                });
            }
            // The automatic pass keys off this stamp, so a manual run has to
            // move it too. Without this, pressing Detect by hand would leave the
            // next scan running the whole thing again for nothing.
            remember_skiptro_stamp(&app, &root_path);
        }

        // No settling rule on this path: pressing Detect is saying "now", and
        // second-guessing that would look exactly like the button not working.
        steps.push(run_analysis(&app, &root_path, None));

        let ok = steps.iter().all(|s| s.exit_code == Some(0));
        Ok(DetectReport {
            ok,
            stopped: jobs.detection_stopped(),
            steps,
        })
    })
    .await
    .map_err(to_string_err)?
}

#[cfg(test)]
mod tests {
    use super::{build_args, root_stamp, skiptro_stamp_key, tokenise};

    /// Just enough of `media_files` for the stamp, which is all it reads.
    fn library(rows: &[(i64, i64)]) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE media_files (
                 id INTEGER PRIMARY KEY, root_id INTEGER NOT NULL,
                 first_seen_at INTEGER NOT NULL, modified_at INTEGER NOT NULL,
                 missing INTEGER NOT NULL DEFAULT 0)",
        )
        .unwrap();
        for (first_seen, modified) in rows {
            conn.execute(
                "INSERT INTO media_files (root_id, first_seen_at, modified_at) VALUES (1, ?1, ?2)",
                rusqlite::params![first_seen, modified],
            )
            .unwrap();
        }
        conn
    }

    /// The case that started this: a season dropped into a watched folder has
    /// to move the stamp, or the automatic pass decides there is nothing to do
    /// and the new episodes never get a marker from anything.
    #[test]
    fn a_new_episode_moves_the_stamp() {
        let conn = library(&[(100, 50), (100, 50)]);
        let before = root_stamp(&conn, 1).unwrap();

        conn.execute(
            "INSERT INTO media_files (root_id, first_seen_at, modified_at) VALUES (1, 200, 60)",
            [],
        )
        .unwrap();
        assert_ne!(root_stamp(&conn, 1).unwrap(), before);
    }

    /// A file replaced in place keeps its `first_seen_at`, so the stamp has to
    /// watch `modified_at` as well — a re-encoded episode is new material even
    /// though the row is not.
    #[test]
    fn a_replaced_episode_moves_the_stamp_too() {
        let conn = library(&[(100, 50)]);
        let before = root_stamp(&conn, 1).unwrap();

        conn.execute("UPDATE media_files SET modified_at = 900", []).unwrap();
        assert_ne!(root_stamp(&conn, 1).unwrap(), before);
    }

    /// And a *deleted* episode must not, or tidying one file away would spend
    /// minutes re-scanning a library that has nothing new in it.
    #[test]
    fn removing_an_episode_leaves_the_stamp_alone() {
        let conn = library(&[(100, 50), (200, 60)]);
        let before = root_stamp(&conn, 1).unwrap();

        // How the scanner records a deletion: flagged, never removed.
        conn.execute("UPDATE media_files SET missing = 1 WHERE first_seen_at = 100", [])
            .unwrap();
        assert_eq!(root_stamp(&conn, 1).unwrap(), before);
    }

    /// An empty root still answers. `None` means "could not tell", which is
    /// treated as "run it", and a root with nothing in it is not that.
    #[test]
    fn an_empty_root_has_a_stamp_rather_than_no_answer() {
        assert_eq!(root_stamp(&library(&[]), 1).as_deref(), Some("0:0"));
    }

    /// Two libraries must not share one stamp, or adding a season to one would
    /// mark the other as already scanned.
    #[test]
    fn each_root_remembers_separately() {
        assert_ne!(skiptro_stamp_key(1), skiptro_stamp_key(2));
    }

    // ---- the settling rule ----

    use crate::analyse::{Episode, Season};

    fn season(label: &str, mtimes: &[i64]) -> Season {
        Season {
            label: label.into(),
            episodes: mtimes
                .iter()
                .map(|mtime| Episode {
                    file_id: 0,
                    path: String::new(),
                    size: 1,
                    mtime: *mtime,
                })
                .collect(),
        }
    }

    /// A season nobody has touched for a while is ready.
    #[test]
    fn a_settled_season_is_analysed() {
        let old = super::now_secs() - 3600;
        let (ready, settling) =
            super::split_settled(vec![season("s1", &[old, old])], Some(super::SETTLING_SECS));
        assert_eq!(ready.len(), 1);
        assert!(settling.is_empty());
    }

    /// One file still arriving holds back the **whole** season, because the
    /// analysis compares episodes against each other — fingerprinting the other
    /// nine now only means fingerprinting them again when the tenth lands.
    #[test]
    fn one_file_still_being_written_holds_back_its_season() {
        let old = super::now_secs() - 3600;
        let just_now = super::now_secs();
        let (ready, settling) = super::split_settled(
            vec![season("s1", &[old, old, just_now])],
            Some(super::SETTLING_SECS),
        );
        assert!(ready.is_empty());
        assert_eq!(settling.len(), 1);
    }

    /// …and only its own season. A download in one show must not stop every
    /// other show in the library being analysed.
    #[test]
    fn a_download_does_not_hold_back_other_seasons() {
        let old = super::now_secs() - 3600;
        let (ready, settling) = super::split_settled(
            vec![season("busy", &[super::now_secs()]), season("quiet", &[old])],
            Some(super::SETTLING_SECS),
        );
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].label, "quiet");
        assert_eq!(settling.len(), 1);
    }

    /// The Detect button waits for nothing. Pressing it is saying "now", and a
    /// button that quietly declined would look exactly like a broken one.
    #[test]
    fn the_manual_path_ignores_settling_entirely() {
        let (ready, settling) =
            super::split_settled(vec![season("s1", &[super::now_secs()])], None);
        assert_eq!(ready.len(), 1);
        assert!(settling.is_empty());
    }

    #[test]
    fn splits_on_whitespace() {
        assert_eq!(tokenise("scan {dir}"), vec!["scan", "{dir}"]);
        assert_eq!(
            tokenise("scan --force  --movie {dir}"),
            vec!["scan", "--force", "--movie", "{dir}"]
        );
    }

    #[test]
    fn quotes_hold_a_token_together() {
        assert_eq!(
            tokenise(r#"scan "two words" {dir}"#),
            vec!["scan", "two words", "{dir}"]
        );
    }

    /// The whole point: a library root routinely has spaces in it, and a path
    /// substituted into a token can never be re-split on its spaces.
    #[test]
    fn a_directory_with_spaces_stays_one_argument() {
        let args = build_args("scan {dir}", r"D:\Media Library\TV Shows");
        assert_eq!(args, vec!["scan", r"D:\Media Library\TV Shows"]);
    }

    #[test]
    fn substitutes_into_a_quoted_token_too() {
        let args = build_args(r#"export "{dir}""#, r"D:\My Shows");
        assert_eq!(args, vec!["export", r"D:\My Shows"]);
    }

    /// How the export step is turned off: no arguments means the step is
    /// skipped rather than run bare.
    #[test]
    fn an_empty_template_produces_no_arguments() {
        assert!(tokenise("   ").is_empty());
        assert!(build_args("", r"C:\media").is_empty());
        assert!(build_args(super::DEFAULT_EXPORT_ARGS, r"C:\media").is_empty());
    }
}
