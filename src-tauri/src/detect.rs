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

/// Detect intros for one library root.
///
/// Long-running by nature, so the work happens off the main thread. The Skiptro
/// process touches *its own* database and the media folders; nothing here writes
/// to this app's database at all, which is why no lock is held for the duration.
#[tauri::command]
pub async fn detect_intros(
    app: tauri::AppHandle,
    root_path: String,
) -> Result<DetectReport, String> {
    let (exe, scan_args, export_args) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        let exe = setting(&conn, PATH_KEY).ok_or_else(|| {
            "No Skiptro executable chosen — set one in Settings → Intro detection.".to_string()
        })?;
        (
            exe,
            setting(&conn, SCAN_ARGS_KEY).unwrap_or_else(|| DEFAULT_SCAN_ARGS.to_string()),
            setting(&conn, EXPORT_ARGS_KEY).unwrap_or_else(|| DEFAULT_EXPORT_ARGS.to_string()),
        )
    };

    if !std::path::Path::new(&exe).is_file() {
        return Err(format!("Skiptro executable not found: {exe}"));
    }
    if !std::path::Path::new(&root_path).is_dir() {
        return Err(format!("folder not reachable: {root_path}"));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut steps = Vec::new();

        for (name, template) in [("scan", &scan_args), ("export", &export_args)] {
            let args = build_args(template, &root_path);
            // An empty template is "skip this step", which is how exporting is
            // switched off. Running the executable with no arguments at all
            // would print its help and exit 1, reporting a failure that never
            // happened.
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

        Ok(DetectReport { ok: true, steps })
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
