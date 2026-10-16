//! Installing ffmpeg with one press, through winget (Windows only).
//!
//! **Kinema still downloads nothing itself.** On a press — and only on one —
//! it asks Windows' own package manager to install Gyan's ffmpeg build, the
//! way a person would type it in a terminal. winget fetches it from the
//! package's own source, checks its hash, and records it as an app of its own:
//! it is listed and removed with winget like anything else, and uninstalling
//! Kinema leaves it alone (other programs may use it). See notes on the
//! binaries rule in CONTRIBUTING.md.
//!
//! **Essentials, not the full build.** `Gyan.FFmpeg.Essentials` has every
//! decoder Kinema needs (AC-3, E-AC-3, DTS, TrueHD, HEVC) and the
//! `cropdetect`/`blackdetect` filters, at about half the full build's size.
//!
//! **Per user, no questions.** `--scope user` needs no administrator prompt;
//! the agreement flags are the person's press on a button that says what will
//! happen, never accepted for anyone who did not press it. The program lands
//! where `ffmpeg.rs` looks for an install made since Kinema started, so it is
//! found at once.

use crate::ffmpeg::{self, FfmpegStatus};
use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

/// Event name for the install's progress, one plain line per emit.
const PROGRESS_EVENT: &str = "ffmpeg-install-progress";

/// The package: Gyan's "essentials" build of ffmpeg, from winget's own source.
pub const PACKAGE_ID: &str = "Gyan.FFmpeg.Essentials";

/// How many of winget's last lines a failure keeps, for the person and the log.
const TAIL_LINES: usize = 12;

/// winget's own codes for "it is installed already" — a second press, or an
/// ffmpeg installed with winget that Kinema could not find for some reason.
/// winget answers an `install` of an installed package by trying to upgrade
/// it, and "no newer version" comes back as UPDATE_NOT_APPLICABLE.
const PACKAGE_ALREADY_INSTALLED: u32 = 0x8A15_0061;
const UPDATE_NOT_APPLICABLE: u32 = 0x8A15_002B;

/// Only one install at a time: the button is in three places.
static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Installed,
    AlreadyInstalled,
    /// No winget on this computer (an older or stripped-down Windows).
    NoWinget,
    Failed,
}

#[derive(Serialize)]
pub struct InstallReport {
    pub outcome: Outcome,
    /// What went wrong, in words, when it failed.
    pub reason: Option<String>,
    pub exit_code: Option<i32>,
    /// winget's last lines, as it wrote them.
    pub tail: Vec<String>,
    /// Whether Kinema can now run ffmpeg, asked after winget finished.
    pub ffmpeg: FfmpegStatus,
}

#[derive(Serialize, Clone)]
struct Progress {
    line: String,
}

/// Install ffmpeg with winget, reporting progress as it goes.
///
/// Refused while a film plays: a 110 MB download and an unpack are exactly
/// what a film on a share or a weak computer cannot spare. `configured` is the
/// ffmpeg path field, so the answer says whether *that* finds it.
#[tauri::command]
pub async fn install_ffmpeg(
    app: tauri::AppHandle,
    configured: Option<String>,
) -> Result<InstallReport, String> {
    if !cfg!(windows) {
        return Err("Installing ffmpeg from Kinema is only for Windows.".into());
    }
    if crate::jobs::playing() {
        return Err("Not while a film is playing.".into());
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("ffmpeg is being installed already.".into());
    }
    let result = crate::jobs::off_main(move || Ok(install(&app, configured.as_deref()))).await;
    RUNNING.store(false, Ordering::SeqCst);
    result
}

fn install(app: &tauri::AppHandle, configured: Option<&str>) -> InstallReport {
    install_with(
        &|line: String| {
            let _ = app.emit(PROGRESS_EVENT, Progress { line });
        },
        configured,
    )
}

/// The install, saying each step through `say`.
fn install_with(say: &dyn Fn(String), configured: Option<&str>) -> InstallReport {
    crate::log!("ffmpeg: installing {PACKAGE_ID} with winget");
    say("Starting Windows' app installer".into());

    let run = run_winget(|segment| {
        if let Some(line) = plain(segment) {
            say(line);
        }
    });
    let status = || {
        let path = ffmpeg::resolve(configured);
        FfmpegStatus {
            resolved: path.display().to_string(),
            available: ffmpeg::is_available(&path),
        }
    };

    let (code, lines) = match run {
        Ok(done) => done,
        Err(Spawn::NotFound) => {
            crate::log!("ffmpeg: winget is not on this computer");
            return InstallReport {
                outcome: Outcome::NoWinget,
                reason: None,
                exit_code: None,
                tail: Vec::new(),
                ffmpeg: status(),
            };
        }
        Err(Spawn::Other(e)) => {
            crate::log!("ffmpeg: could not start winget: {e}");
            return InstallReport {
                outcome: Outcome::Failed,
                reason: Some(format!("Windows' app installer could not be started ({e}).")),
                exit_code: None,
                tail: Vec::new(),
                ffmpeg: status(),
            };
        }
    };

    let tail = tail_of(&lines);
    let ffmpeg = status();
    let (outcome, reason) = judge(code, ffmpeg.available);
    match outcome {
        Outcome::Installed | Outcome::AlreadyInstalled => {
            crate::log!("ffmpeg: {outcome:?} (winget code {code:?}); using {}", ffmpeg.resolved);
        }
        _ => {
            crate::log!(
                "ffmpeg: install failed (winget code {}): {}",
                code.map_or("none".into(), hex),
                reason.as_deref().unwrap_or("")
            );
            for line in &tail {
                crate::log!("ffmpeg:   winget: {line}");
            }
        }
    }
    InstallReport { outcome, reason, exit_code: code, tail, ffmpeg }
}

/// What winget's exit code and a fresh look for ffmpeg add up to.
///
/// **Success is only claimed when Kinema can run what was installed.** winget
/// saying "installed" while Kinema still cannot find the program is a failure
/// from where the person sits, and is said as one.
fn judge(code: Option<i32>, found: bool) -> (Outcome, Option<String>) {
    let code_u = code.map(|c| c as u32);
    let installed = match code_u {
        Some(0) => Some(Outcome::Installed),
        Some(PACKAGE_ALREADY_INSTALLED | UPDATE_NOT_APPLICABLE) => Some(Outcome::AlreadyInstalled),
        _ => None,
    };
    match (installed, found) {
        (Some(outcome), true) => (outcome, None),
        (Some(_), false) => (
            Outcome::Failed,
            Some(
                "Windows' app installer says ffmpeg is installed, but Kinema cannot find it. \
                 Restarting Kinema may help; if not, type where ffmpeg.exe is below."
                    .into(),
            ),
        ),
        (None, _) => (Outcome::Failed, Some(failure_words(code_u))),
    }
}

/// winget's commonest failures, in words; anything else by its code.
fn failure_words(code: Option<u32>) -> String {
    match code {
        None => "Windows' app installer stopped without saying why.".into(),
        Some(0x8A15_0008) => {
            "The download failed. Check the internet connection and try again.".into()
        }
        Some(0x8A15_000F | 0x8A15_0044 | 0x8A15_0046) => {
            "Windows' app installer could not read its list of packages. \
             Check the internet connection and try again."
                .into()
        }
        Some(0x8A15_0014) => {
            "Windows' app installer could not find ffmpeg in its list of packages.".into()
        }
        Some(0x8A15_0011) => "The downloaded file did not match its expected checksum, \
             so it was not installed."
            .into(),
        Some(code) => format!("Windows' app installer stopped with code {}.", hex(code as i32)),
    }
}

fn hex(code: i32) -> String {
    format!("0x{:08X}", code as u32)
}

enum Spawn {
    NotFound,
    Other(String),
}

/// Where winget is: on the `PATH` (it is an app alias in the user's
/// WindowsApps folder), or that folder named directly when Kinema was started
/// with a `PATH` that lacks it.
fn winget_candidates() -> Vec<PathBuf> {
    let mut found = vec![PathBuf::from("winget")];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        found.push(
            PathBuf::from(local).join("Microsoft").join("WindowsApps").join("winget.exe"),
        );
    }
    found
}

/// Run the install, handing each piece of output to `each` as it arrives.
/// Returns winget's exit code and every line it wrote.
fn run_winget(mut each: impl FnMut(&str)) -> Result<(Option<i32>, Vec<String>), Spawn> {
    let mut child = None;
    let mut last_error = None;
    for exe in winget_candidates() {
        let mut command = Command::new(&exe);
        command
            .args(["install", "--id", PACKAGE_ID, "--exact", "--source", "winget"])
            .args(["--scope", "user", "--silent", "--disable-interactivity"])
            .args(["--accept-package-agreements", "--accept-source-agreements"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        ffmpeg::no_window(&mut command);
        match command.spawn() {
            Ok(started) => {
                child = Some(started);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => last_error = Some(e.to_string()),
        }
    }
    let Some(mut child) = child else {
        return Err(last_error.map_or(Spawn::NotFound, Spawn::Other));
    };

    // stderr on its own thread, so a child filling it can never stall stdout
    // (the same reason as detect.rs `run_step`).
    let stderr = child.stderr.take().map(|mut stream| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
            bytes
        })
    });

    let mut lines = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let mut pending: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 4096];
        while let Ok(read) = stdout.read(&mut buffer) {
            if read == 0 {
                break;
            }
            pending.extend_from_slice(&buffer[..read]);
            // winget redraws its progress bar with carriage returns, so a
            // piece ends at either.
            while let Some(end) = pending.iter().position(|&b| b == b'\r' || b == b'\n') {
                let piece: Vec<u8> = pending.drain(..=end).collect();
                take_piece(&piece[..piece.len() - 1], &mut lines, &mut each);
            }
        }
        take_piece(&pending, &mut lines, &mut each);
    }
    if let Some(Ok(bytes)) = stderr.map(std::thread::JoinHandle::join) {
        for piece in bytes.split(|&b| b == b'\r' || b == b'\n') {
            take_piece(piece, &mut lines, &mut each);
        }
    }

    let code = child.wait().ok().and_then(|s| s.code());
    Ok((code, lines))
}

fn take_piece(bytes: &[u8], lines: &mut Vec<String>, each: &mut impl FnMut(&str)) {
    let text = String::from_utf8_lossy(bytes);
    let text = clean(&text);
    if text.is_empty() {
        return;
    }
    each(text);
    // A progress bar is a hundred redraws of one line; only its last matters.
    if is_bar(text) && lines.last().is_some_and(|last: &String| is_bar(last)) {
        lines.pop();
    }
    lines.push(text.to_string());
}

/// A piece without its spinner: winget turns `- \ | /` in place while it works.
fn clean(text: &str) -> &str {
    let text = text.trim();
    if text.len() == 1 && matches!(text, "-" | "\\" | "|" | "/") {
        return "";
    }
    text
}

fn is_bar(line: &str) -> bool {
    line.contains('█') || line.contains('▒')
}

/// The last lines, for the person and the log (a bar is already one line).
fn tail_of(lines: &[String]) -> Vec<String> {
    let start = lines.len().saturating_sub(TAIL_LINES);
    lines[start..].to_vec()
}

/// One of winget's lines in the words the button's progress line uses, or
/// `None` for one that says nothing to a person (licence boilerplate).
fn plain(line: &str) -> Option<String> {
    let line = clean(line);
    if line.is_empty() {
        return None;
    }
    if let Some(sizes) = download_sizes(line) {
        return Some(format!("Downloading ffmpeg: {sizes}"));
    }
    let lower = line.to_ascii_lowercase();
    let said = if lower.starts_with("found ") {
        "Found ffmpeg in Windows' app installer"
    } else if lower.starts_with("downloading") {
        "Downloading ffmpeg"
    } else if lower.contains("verified installer hash") {
        "Download checked"
    } else if lower.starts_with("extracting") {
        "Unpacking ffmpeg"
    } else if lower.starts_with("starting package install") {
        "Installing ffmpeg"
    } else if lower.starts_with("successfully installed") {
        "Installed"
    } else if lower.contains("licensed to you")
        || lower.contains("not responsible")
        || lower.contains("restart your shell")
        || lower.contains("command line alias added")
        || lower.contains("successfully extracted")
    {
        return None;
    } else {
        return Some(line.to_string());
    };
    Some(said.to_string())
}

/// "50.0 MB of 111 MB" from a progress bar's "██▒▒  50.0 MB /  111 MB".
fn download_sizes(line: &str) -> Option<String> {
    let (left, right) = line.split_once(" / ")?;
    let mut left_words = left.split_whitespace().rev();
    let (unit_a, amount_a) = (left_words.next()?, left_words.next()?);
    let mut right_words = right.split_whitespace();
    let (amount_b, unit_b) = (right_words.next()?, right_words.next()?);
    let unit = |u: &str| matches!(u, "B" | "KB" | "MB" | "GB");
    let number = |n: &str| n.parse::<f64>().is_ok();
    (unit(unit_a) && unit(unit_b) && number(amount_a) && number(amount_b))
        .then(|| format!("{amount_a} {unit_a} of {amount_b} {unit_b}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The real install — never on a computer of the owner's.** Run in a
    /// throwaway Windows (Windows Sandbox, or a CI runner) with winget:
    /// `kinema_lib-*.exe ffmpeg_install::tests::a_real_winget_install
    /// --ignored --nocapture`. Started, like a running Kinema, with a `PATH`
    /// that has no ffmpeg, and it must find the one just installed anyway.
    #[cfg(windows)]
    #[test]
    #[ignore = "installs ffmpeg with winget; for a throwaway Windows only"]
    fn a_real_winget_install() {
        assert!(
            !ffmpeg::is_available(&ffmpeg::resolve(None)),
            "ffmpeg must be missing before the install"
        );
        let report = install_with(&|line| println!("progress: {line}"), None);
        for line in &report.tail {
            println!("winget: {line}");
        }
        println!("outcome {:?}, code {:?}, using {}", report.outcome, report.exit_code, report.ffmpeg.resolved);
        assert_eq!(report.outcome, Outcome::Installed, "{:?}", report.reason);
        assert!(report.ffmpeg.available);
        // Found where winget put it, by the lookup for installs since start.
        assert!(report.ffmpeg.resolved.contains("WinGet"), "{}", report.ffmpeg.resolved);
        // ffprobe beside it, for a title's details.
        let ffmpeg = ffmpeg::resolve(None);
        let probe = ffmpeg::probe_binary(&ffmpeg);
        assert!(ffmpeg::is_available(&probe), "ffprobe at {}", probe.display());
        // Essentials decodes everything Kinema decodes itself.
        assert!(ffmpeg::lacking_decoders(&ffmpeg).is_empty());
        // A second press: already installed, still found.
        let again = install_with(&|_| {}, None);
        println!("again: {:?}, code {:?}", again.outcome, again.exit_code);
        assert_eq!(again.outcome, Outcome::AlreadyInstalled, "{:?}", again.reason);
    }

    #[test]
    fn a_clean_install_that_kinema_can_run_is_installed() {
        assert_eq!(judge(Some(0), true), (Outcome::Installed, None));
    }

    #[test]
    fn winget_s_already_installed_codes_are_already_installed() {
        for code in [PACKAGE_ALREADY_INSTALLED, UPDATE_NOT_APPLICABLE] {
            assert_eq!(judge(Some(code as i32), true).0, Outcome::AlreadyInstalled);
        }
    }

    /// Kinema never claims an install it cannot use.
    #[test]
    fn installed_but_not_found_is_a_failure_and_says_so() {
        let (outcome, reason) = judge(Some(0), false);
        assert_eq!(outcome, Outcome::Failed);
        assert!(reason.unwrap().contains("cannot find it"));
    }

    #[test]
    fn a_failure_is_named_in_words_or_by_its_code() {
        let (outcome, reason) = judge(Some(0x8A15_0008_u32 as i32), false);
        assert_eq!(outcome, Outcome::Failed);
        assert!(reason.unwrap().contains("download failed"));
        let (_, reason) = judge(Some(0x8A15_9999_u32 as i32), true);
        assert!(reason.unwrap().contains("0x8A159999"), "a code nobody mapped is still said");
        let (_, reason) = judge(None, false);
        assert!(reason.unwrap().contains("without saying why"));
    }

    #[test]
    fn progress_bars_become_sizes() {
        assert_eq!(
            plain("  ██████████▒▒▒▒▒▒▒▒▒▒  50.0 MB /  111 MB").as_deref(),
            Some("Downloading ffmpeg: 50.0 MB of 111 MB")
        );
        assert_eq!(download_sizes("1024 KB / 2.00 MB").as_deref(), Some("1024 KB of 2.00 MB"));
        assert_eq!(download_sizes("this / that"), None);
    }

    #[test]
    fn winget_s_steps_are_said_plainly() {
        let said = |l: &str| plain(l);
        assert_eq!(
            said("Found FFmpeg (Essentials Build) [Gyan.FFmpeg.Essentials] Version 9.0.1").as_deref(),
            Some("Found ffmpeg in Windows' app installer")
        );
        assert_eq!(
            said("Downloading https://github.com/GyanD/codexffmpeg/releases/download/x.zip")
                .as_deref(),
            Some("Downloading ffmpeg")
        );
        assert_eq!(said("Successfully verified installer hash").as_deref(), Some("Download checked"));
        assert_eq!(said("Extracting archive...").as_deref(), Some("Unpacking ffmpeg"));
        assert_eq!(said("Starting package install...").as_deref(), Some("Installing ffmpeg"));
        assert_eq!(said("Successfully installed").as_deref(), Some("Installed"));
        assert_eq!(said("This application is licensed to you by its owner."), None);
        assert_eq!(said("Path environment variable modified; restart your shell to use the new value."), None);
        assert_eq!(said("  -  "), None);
        assert_eq!(said("\\"), None);
        assert_eq!(said("Something unexpected").as_deref(), Some("Something unexpected"));
    }

    #[test]
    fn a_progress_bar_keeps_only_its_last_redraw() {
        let mut lines = Vec::new();
        let mut seen = Vec::new();
        let mut each = |s: &str| seen.push(s.to_string());
        for piece in ["Downloading x", "██ 1 MB / 111 MB", "███ 2 MB / 111 MB", "|", "Done"] {
            take_piece(piece.as_bytes(), &mut lines, &mut each);
        }
        assert_eq!(lines, ["Downloading x", "███ 2 MB / 111 MB", "Done"]);
        assert_eq!(seen.len(), 4, "every piece but the spinner goes out as progress");
    }

    #[test]
    fn the_tail_is_the_last_lines() {
        let lines: Vec<String> = (0..30).map(|n| n.to_string()).collect();
        let tail = tail_of(&lines);
        assert_eq!(tail.len(), TAIL_LINES);
        assert_eq!(tail.last().unwrap(), "29");
    }
}
