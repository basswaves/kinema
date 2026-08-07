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
/// every one of these — and there is one per window per episode.
#[cfg(windows)]
fn no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
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

#[cfg(test)]
mod tests {
    use super::*;

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
