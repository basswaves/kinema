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
    pub steps: Vec<StepReport>,
}

/// Split a template into arguments, respecting double quotes.
///
/// Deliberately **not** handed to a shell. Arguments go to the process
/// individually, so a path containing spaces — `…\Media\TV Shows` on this
/// machine — needs no quoting or escaping at any point, and there is no shell
/// to interpret anything the path happens to contain.
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

    let status = child.wait().map_err(to_string_err)?;

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
fn run_analysis(app: &tauri::AppHandle, root_path: &str) -> StepReport {
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

    if seasons.is_empty() {
        say("nothing new to analyse".into());
        return step("analyse", Some(0), tail);
    }

    let mut found = 0usize;

    for season in &seasons {
        say(format!(
            "{}: {} episodes",
            season.label,
            season.episodes.len()
        ));

        let results = crate::analyse::analyse_season(&ffmpeg_path, &season.episodes, |line| {
            let _ = app.emit(
                PROGRESS_EVENT,
                DetectProgress {
                    step: "analyse".into(),
                    line,
                },
            );
        });

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

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
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
        let mut steps = Vec::new();

        // Skiptro first, when there is one. Its intro outranks the analysis
        // below, so running it first means the better answer is already in
        // place by the time anything reads either.
        if let Some(exe) = exe {
            for (name, template) in [("scan", &scan_args), ("export", &export_args)] {
                let args = build_args(template, &root_path);
                // An empty template is "skip this step", which is how exporting
                // is switched off. Running the executable with no arguments at
                // all would print its help and exit 1, reporting a failure that
                // never happened.
                if args.is_empty() {
                    continue;
                }
                let report = run_step(&app, &exe, name, &args)?;
                let failed = report.exit_code != Some(0);
                steps.push(report);
                // Exporting after a failed scan would write sidecars from stale
                // detections, or none at all while reporting success.
                if failed {
                    return Ok(DetectReport { ok: false, steps });
                }
            }
        }

        steps.push(run_analysis(&app, &root_path));

        let ok = steps.iter().all(|s| s.exit_code == Some(0));
        Ok(DetectReport { ok, steps })
    })
    .await
    .map_err(to_string_err)?
}

#[cfg(test)]
mod tests {
    use super::{build_args, tokenise};

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

    /// The whole point: this machine's TV root is `…\Media\TV Shows`, and a
    /// path substituted into a token can never be re-split on its spaces.
    #[test]
    fn a_directory_with_spaces_stays_one_argument() {
        let args = build_args("scan {dir}", r"D:\Media\TV Shows");
        assert_eq!(
            args,
            vec!["scan", r"D:\Media\TV Shows"]
        );
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
