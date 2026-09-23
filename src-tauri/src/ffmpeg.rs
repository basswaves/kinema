//! Finding ffmpeg, and getting raw audio out of a video with it.
//!
//! **Invoked, never shipped** — the same standing Skiptro has. Nothing is
//! bundled or downloaded; the app runs a copy the user already has. Without one
//! the detector is unavailable and every other part of the app behaves exactly
//! as it did.
//!
//! ffmpeg rather than a Rust decoder, and the reason is not laziness: Symphonia
//! is pure Rust and decodes AAC, MP3, FLAC and Vorbis perfectly well, but it
//! cannot read **AC-3, E-AC-3, DTS or TrueHD**, which is what most of a Blu-ray
//! remux library actually contains. A detector that silently skipped every
//! remux would be worse than no detector.
//!
//! Only *windows* of audio are ever decoded — the opening minutes and the
//! closing minutes — never whole files. A 45-minute episode is analysed by
//! reading about six minutes of it, which is the difference between a season
//! taking minutes and taking an hour.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Setting key: where ffmpeg is, when it is not simply on `PATH`.
pub const PATH_KEY: &str = "ffmpeg_path";

/// The sample rate fingerprinting wants.
///
/// Chromaprint works at 11025 Hz mono internally. Asking ffmpeg for exactly
/// that means the resampler in `rusty-chromaprint` has nothing to do, and it is
/// a fourth of the bytes crossing the pipe compared to 44.1 kHz.
pub const SAMPLE_RATE: u32 = 11_025;

/// Suppress the console window that would otherwise flash over the app for
/// every one of these — and there is one per window per episode — and keep the
/// decode off the back of whatever is playing.
///
/// **The priority half matters more than it used to.** Analysis was once
/// something a user chose to start, from Settings, while not watching anything.
/// It now runs by itself at the end of a scan, so it can overlap with playback
/// of an episode from the season *before* the one being analysed — and a
/// dropped frame during an intro is a far worse trade than an analysis that
/// finishes a minute later. Below-normal only yields when something else wants
/// the CPU; on an idle machine it still runs flat out.
#[cfg(windows)]
fn no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
    command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
}

#[cfg(not(windows))]
fn no_window(_command: &mut Command) {}

/// The configured ffmpeg, or plain `ffmpeg` to be resolved through `PATH`.
pub fn resolve(configured: Option<&str>) -> PathBuf {
    match configured.map(str::trim).filter(|s| !s.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from("ffmpeg"),
    }
}

/// ffprobe, alongside whichever ffmpeg is being used.
///
/// Derived rather than configured separately: the two ship together in every
/// build, and a second path field would be one more thing to get wrong for no
/// benefit. A bare `ffmpeg` from `PATH` yields a bare `ffprobe` from `PATH`.
fn probe_binary(ffmpeg: &Path) -> PathBuf {
    match ffmpeg.parent().filter(|p| !p.as_os_str().is_empty()) {
        Some(dir) => {
            let name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
            dir.join(name)
        }
        None => PathBuf::from("ffprobe"),
    }
}

/// Whether this ffmpeg can actually be run.
///
/// Checked once before a detection run rather than discovered per episode, so
/// "ffmpeg not found" is one clear message instead of two hundred identical
/// failures.
pub fn is_available(ffmpeg: &Path) -> bool {
    let mut command = Command::new(ffmpeg);
    command
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut command);
    command.status().map(|s| s.success()).unwrap_or(false)
}

/// What Settings shows next to the ffmpeg path field.
#[derive(serde::Serialize)]
pub struct FfmpegStatus {
    /// The path actually being used, resolved from the setting or `PATH`.
    pub resolved: String,
    pub available: bool,
}

/// Whether the configured ffmpeg works, answered while the user is still
/// looking at the field.
///
/// Before this, a mistyped path was silent until a detection run minutes later
/// blamed it on Skiptro. The check is one `-version` call, so asking on every
/// keystroke would be wasteful but asking when the field settles is free.
///
/// Off the main thread: it starts a process, and a first start of an ffmpeg on
/// a network share or behind an antivirus scan can take seconds.
#[tauri::command]
pub async fn ffmpeg_status(configured: Option<String>) -> Result<FfmpegStatus, String> {
    crate::jobs::off_main(move || {
        let path = resolve(configured.as_deref());
        Ok(FfmpegStatus {
            resolved: path.display().to_string(),
            available: is_available(&path),
        })
    })
    .await
}

/// How long a video is, in seconds.
///
/// `None` when ffprobe is missing or the file has no readable duration. The
/// caller needs this to know where the *end* of the file is; without it the
/// closing window cannot be placed and only an intro can be looked for.
pub fn duration_secs(ffmpeg: &Path, video: &Path) -> Option<f64> {
    let mut command = Command::new(probe_binary(ffmpeg));
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(video)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    no_window(&mut command);

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let secs: f64 = text.trim().parse().ok()?;
    (secs.is_finite() && secs > 0.0).then_some(secs)
}

/// Decode one window of a file's first audio track to 11025 Hz mono samples.
///
/// `-ss` goes **before** `-i`, which makes it an input seek: ffmpeg jumps to
/// the keyframe and starts decoding there rather than decoding the whole file
/// and throwing away the part before the window. On a 45-minute episode that is
/// the difference between reading six minutes and reading forty-five.
pub fn decode_window(
    ffmpeg: &Path,
    video: &Path,
    start_secs: f64,
    length_secs: f64,
) -> Result<Vec<i16>, String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-v", "error", "-nostdin"])
        .args(["-ss", &format!("{start_secs:.3}")])
        .args(["-t", &format!("{length_secs:.3}")])
        .arg("-i")
        .arg(video)
        // First audio track only. A remux with a commentary track would
        // otherwise fingerprint whichever ffmpeg felt like picking, and two
        // episodes analysed from different tracks never match.
        .args(["-map", "0:a:0"])
        .args(["-vn", "-ac", "1"])
        .args(["-ar", &SAMPLE_RATE.to_string()])
        .args(["-f", "s16le", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut command);

    let output = command
        .output()
        .map_err(|e| format!("could not run {}: {e}", ffmpeg.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffmpeg failed on {}: {}",
            video.display(),
            stderr.lines().last().unwrap_or("no output")
        ));
    }

    // s16le, little-endian, two bytes a sample. A trailing odd byte would mean
    // a truncated write; dropping it is right and silently reinterpreting the
    // stream is not.
    Ok(output
        .stdout
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect())
}

/// The shortest run of black frames worth reporting, in seconds.
///
/// ffmpeg's own default is two seconds, which is useless here: the fade between
/// two credit cards is a fraction of a second, and those transitions are most
/// of what identifies a credits sequence at all.
const BLACK_MIN_SECS: f64 = 0.05;

/// Periods of black picture in one window of a file, as `(start, end)` in
/// seconds from the **start of the file**.
///
/// `blackdetect` reports times relative to the seek point, so the window offset
/// is added back here — every caller wants file time, and a relative time that
/// looks absolute is the kind of thing that produces a marker in the wrong
/// place with nothing to show for it.
///
/// An empty result is ordinary: it means the picture never went black, which is
/// true of plenty of files.
pub fn black_periods(
    ffmpeg: &Path,
    video: &Path,
    start_secs: f64,
    length_secs: f64,
) -> Vec<(f64, f64)> {
    let mut command = Command::new(ffmpeg);
    command
        // `blackdetect` reports at info level, so `-v error` — which every other
        // call here uses — would return nothing at all, successfully.
        // `-nostats` drops the progress spam that comes with it.
        .args(["-v", "info", "-nostats", "-nostdin"])
        .args(["-ss", &format!("{start_secs:.3}")])
        .args(["-t", &format!("{length_secs:.3}")])
        .arg("-i")
        .arg(video)
        .args(["-an", "-sn"])
        .args(["-vf", &format!("blackdetect=d={BLACK_MIN_SECS}:pix_th=0.10")])
        .args(["-f", "null", "-"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    no_window(&mut command);

    let Ok(output) = command.output() else {
        return Vec::new();
    };

    String::from_utf8_lossy(&output.stderr)
        .lines()
        .filter_map(|line| parse_black_line(line, start_secs))
        .collect()
}

/// Pull `black_start:… black_end:…` out of one log line.
fn parse_black_line(line: &str, offset: f64) -> Option<(f64, f64)> {
    let field = |name: &str| -> Option<f64> {
        let rest = line.split_once(name)?.1;
        let value: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        value.parse::<f64>().ok()
    };

    let start = field("black_start:")?;
    let end = field("black_end:")?;
    (end > start).then_some((offset + start, offset + end))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real line, copied from ffmpeg 8.1.2 running over this library.
    #[test]
    fn reads_a_black_period_from_a_real_log_line() {
        let line = "[Parsed_blackdetect_0 @ 000001dd7ce39600] black_start:110.008833 \
                    black_end:111.760583 black_duration:1.75175";
        assert_eq!(parse_black_line(line, 0.0), Some((110.008833, 111.760583)));
    }

    /// Times are relative to the seek point, and every caller wants file time.
    #[test]
    fn the_window_offset_is_added_back() {
        let line = "[Parsed_blackdetect_0 @ x] black_start:110.008833 black_end:111.760583";
        let (start, end) = parse_black_line(line, 1430.697).unwrap();
        assert!((start - 1540.705833).abs() < 1e-6, "got {start}");
        assert!((end - 1542.457583).abs() < 1e-6, "got {end}");
    }

    #[test]
    fn ordinary_ffmpeg_output_is_not_a_black_period() {
        assert_eq!(parse_black_line("frame= 2849 fps=368 q=-0.0 size=N/A", 0.0), None);
        assert_eq!(parse_black_line("  Stream #0:0: Video: hevc, yuv420p", 0.0), None);
        assert_eq!(parse_black_line("", 0.0), None);
    }

    #[test]
    fn a_line_missing_its_end_is_dropped_rather_than_guessed_at() {
        assert_eq!(parse_black_line("black_start:110.0 black_duration:1.7", 0.0), None);
    }

    #[test]
    fn an_unset_path_falls_back_to_the_one_on_path() {
        assert_eq!(resolve(None), PathBuf::from("ffmpeg"));
        assert_eq!(resolve(Some("   ")), PathBuf::from("ffmpeg"));
    }

    #[test]
    fn a_configured_path_is_used_as_given() {
        assert_eq!(
            resolve(Some(r"C:\tools\ffmpeg\bin\ffmpeg.exe")),
            PathBuf::from(r"C:\tools\ffmpeg\bin\ffmpeg.exe")
        );
    }

    /// ffprobe has to come from the same install, or a configured ffmpeg would
    /// silently be paired with some other copy off `PATH`.
    #[test]
    fn ffprobe_is_found_beside_the_configured_ffmpeg() {
        let probe = probe_binary(Path::new(r"C:\tools\ffmpeg\bin\ffmpeg.exe"));
        assert_eq!(probe.parent().unwrap(), Path::new(r"C:\tools\ffmpeg\bin"));
        assert!(probe.file_name().unwrap().to_string_lossy().starts_with("ffprobe"));
    }

    #[test]
    fn a_bare_ffmpeg_yields_a_bare_ffprobe() {
        assert_eq!(probe_binary(Path::new("ffmpeg")), PathBuf::from("ffprobe"));
    }
}
