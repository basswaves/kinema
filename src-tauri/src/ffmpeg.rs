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
pub(crate) fn no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
    command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
}

#[cfg(not(windows))]
pub(crate) fn no_window(_command: &mut Command) {}

/// The configured ffmpeg, or plain `ffmpeg` to be resolved through `PATH`.
///
/// On Windows, an ffmpeg that is not on the `PATH` Kinema started with is
/// looked for where an install made *since* would be (`installed_since_start`)
/// — the one-press install (`ffmpeg_install.rs`) puts it there while Kinema
/// runs, and nobody should have to restart Kinema to have it found. A
/// configured path always wins, found or not: it is what the person said.
pub fn resolve(configured: Option<&str>) -> PathBuf {
    match configured.map(str::trim).filter(|s| !s.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => installed_since_start().unwrap_or_else(|| PathBuf::from("ffmpeg")),
    }
}

/// The program's file name in a folder; only Windows looks in folders itself.
#[cfg(any(windows, test))]
const FFMPEG_EXE: &str = "ffmpeg.exe";

/// An ffmpeg Kinema's own `PATH` does not reach, or `None` — which includes
/// "on Kinema's `PATH` already", where the bare name works as it always has.
///
/// **A program keeps the `PATH` it was started with.** winget puts its command
/// links in `%LOCALAPPDATA%\Microsoft\WinGet\Links` and adds that folder to the
/// *user's* `PATH` in the registry, which a running Kinema never sees (the
/// same trap as docs/GOTCHAS.md, "Spawned shells inherit a stale PATH"). So,
/// in order: the `PATH` as Windows has it now (machine, then user, as Windows
/// joins them), winget's links folder, and winget's own package folder in
/// case the links could not be made. Folders are only looked at, nothing is
/// run, and nothing is written: the next start finds it on the `PATH` anyway.
#[cfg(windows)]
fn installed_since_start() -> Option<PathBuf> {
    let started_with = std::env::var_os("PATH").unwrap_or_default();
    if first_with_ffmpeg(std::env::split_paths(&started_with)).is_some() {
        return None;
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    for value in [registry::machine_path(), registry::user_path()].into_iter().flatten() {
        dirs.extend(std::env::split_paths(&value));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let winget = Path::new(&local).join("Microsoft").join("WinGet");
        dirs.push(winget.join("Links"));
        dirs.extend(winget_package_bins(&winget.join("Packages")));
    }
    first_with_ffmpeg(dirs)
}

#[cfg(not(windows))]
fn installed_since_start() -> Option<PathBuf> {
    None
}

/// `ffmpeg.exe` in the first of these folders that has one.
#[cfg(any(windows, test))]
fn first_with_ffmpeg(dirs: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    dirs.into_iter()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(FFMPEG_EXE))
        .find(|exe| exe.is_file())
}

/// The `bin` folders of every Gyan ffmpeg winget has unpacked:
/// `Packages\Gyan.FFmpeg.Essentials_<source>\ffmpeg-<version>-essentials_build\bin`.
/// Newest-named first, so of two versions left side by side the later wins.
#[cfg(any(windows, test))]
fn winget_package_bins(packages: &Path) -> Vec<PathBuf> {
    let subdirs = |dir: &Path| -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut found: Vec<PathBuf> =
            entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        found.sort();
        found.reverse();
        found
    };
    subdirs(packages)
        .into_iter()
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.to_ascii_lowercase().starts_with("gyan.ffmpeg"))
        })
        .flat_map(|package| subdirs(&package))
        .map(|build| build.join("bin"))
        .collect()
}

/// The `PATH` as Windows has it now, from where Windows keeps it.
#[cfg(windows)]
mod registry {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ,
        RRF_RT_REG_SZ,
    };

    pub fn machine_path() -> Option<OsString> {
        read(
            HKEY_LOCAL_MACHINE,
            w!(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        )
    }

    pub fn user_path() -> Option<OsString> {
        read(HKEY_CURRENT_USER, w!("Environment"))
    }

    /// One `Path` value, its `%LOCALAPPDATA%`-style parts expanded (RegGetValue
    /// does that unless told not to).
    fn read(root: HKEY, key: PCWSTR) -> Option<OsString> {
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
        let mut bytes: u32 = 0;
        // SAFETY: a size query; every pointer is valid or absent.
        let sized =
            unsafe { RegGetValueW(root, key, w!("Path"), flags, None, None, Some(&mut bytes)) };
        if sized.is_err() || bytes == 0 {
            return None;
        }
        // Expanding can make it longer than the size first given; RegGetValue
        // reports the expanded size, but leave room in case it changed between.
        let mut buffer: Vec<u16> = vec![0; bytes as usize / 2 + 512];
        let mut size = (buffer.len() * 2) as u32;
        // SAFETY: `buffer` is `size` bytes long and lives across the call.
        let read = unsafe {
            RegGetValueW(
                root,
                key,
                w!("Path"),
                flags,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if read.is_err() {
            return None;
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(OsString::from_wide(&buffer[..len]))
    }

    #[cfg(test)]
    mod tests {
        /// Every Windows has System32 on the machine `PATH`; reading it proves
        /// the registry call and its expansion of `%SystemRoot%`.
        #[test]
        fn the_machine_path_is_read_and_expanded() {
            let path = super::machine_path().expect("the machine PATH");
            let text = path.to_string_lossy().to_ascii_lowercase();
            assert!(text.contains("system32"), "got {text}");
            assert!(!text.contains("%systemroot%"), "not expanded: {text}");
        }
    }
}

/// ffprobe, alongside whichever ffmpeg is being used.
///
/// Derived rather than configured separately: the two ship together in every
/// build, and a second path field would be one more thing to get wrong for no
/// benefit. A bare `ffmpeg` from `PATH` yields a bare `ffprobe` from `PATH`.
pub(crate) fn probe_binary(ffmpeg: &Path) -> PathBuf {
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

/// The formats Kinema decodes itself and that some builds of ffmpeg leave
/// out, each with the decoders that can do it. A system's own "free" build —
/// Fedora's `ffmpeg-free` — has no HEVC or E-AC-3, and H.264 only through
/// Cisco's OpenH264; ffmpeg picks whichever decoder it has, so any one counts.
const NEEDED_DECODERS: [(&str, &[&str]); 6] = [
    ("hevc", &["hevc"]),
    ("h264", &["h264", "libopenh264"]),
    ("eac3", &["eac3"]),
    ("ac3", &["ac3", "ac3_fixed"]),
    ("dts", &["dca"]),
    ("truehd", &["truehd"]),
];

/// Which of [`NEEDED_DECODERS`] this ffmpeg cannot decode, by their first
/// names (`hevc`, `eac3`, …). Empty when it has them all, **and** when it
/// could not be asked: a missing answer is not a missing format.
pub fn lacking_decoders(ffmpeg: &Path) -> Vec<&'static str> {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-decoders"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    no_window(&mut command);
    let Ok(output) = command.output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    lacking_in(&decoder_names(&String::from_utf8_lossy(&output.stdout)))
}

/// The decoder names in `ffmpeg -decoders`' list: below the `------` line,
/// each line is its flags and then its name.
fn decoder_names(text: &str) -> Vec<String> {
    text.lines()
        .skip_while(|line| !line.trim_start().starts_with("------"))
        .skip(1)
        .filter_map(|line| line.split_whitespace().nth(1).map(str::to_string))
        .collect()
}

fn lacking_in(names: &[String]) -> Vec<&'static str> {
    if names.is_empty() {
        return Vec::new();
    }
    NEEDED_DECODERS
        .iter()
        .filter(|(_, any)| !any.iter().any(|d| names.iter().any(|n| n == d)))
        .map(|(format, _)| *format)
        .collect()
}

/// What Settings says about an ffmpeg that runs but cannot decode some
/// formats (`lacking_decoders`). Asked only by the two places that show it —
/// one `-decoders` call — never before a pass.
#[tauri::command]
pub async fn ffmpeg_lacks(configured: Option<String>) -> Result<Vec<String>, String> {
    crate::jobs::off_main(move || {
        let path = resolve(configured.as_deref());
        Ok(lacking_decoders(&path).into_iter().map(str::to_string).collect())
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
    let (pairs, _odd_byte) = output.stdout.as_chunks::<2>();
    Ok(pairs.iter().map(|pair| i16::from_le_bytes(*pair)).collect())
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

    /// Only away from Windows: there, an ffmpeg installed on this computer
    /// since the tests started would rightly be found by its full path.
    #[cfg(not(windows))]
    #[test]
    fn an_unset_path_falls_back_to_the_one_on_path() {
        assert_eq!(resolve(None), PathBuf::from("ffmpeg"));
        assert_eq!(resolve(Some("   ")), PathBuf::from("ffmpeg"));
    }

    /// The shape of `ffmpeg -decoders` (8.x), cut down.
    const DECODERS: &str = "Decoders:
 V..... = Video
 A..... = Audio
 ------
 V....D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
 V....D hevc                 HEVC (High Efficiency Video Coding)
 V....D hevc_cuvid           Nvidia CUVID HEVC decoder (codec hevc)
 A....D ac3                  ATSC A/52A (AC-3)
 A....D eac3                 ATSC A/52B (AC-3, E-AC-3)
 A....D dca                  DCA (DTS Coherent Acoustics) (codec dts)
 A....D truehd               TrueHD
";

    #[test]
    fn a_full_build_lacks_nothing() {
        assert!(lacking_in(&decoder_names(DECODERS)).is_empty());
    }

    /// Fedora's ffmpeg-free: no HEVC, no E-AC-3, H.264 through OpenH264 only.
    #[test]
    fn a_free_build_lacks_hevc_and_e_ac_3() {
        let text = DECODERS
            .replace(" V....D hevc                 HEVC (High Efficiency Video Coding)\n", "")
            .replace(" A....D eac3                 ATSC A/52B (AC-3, E-AC-3)\n", "")
            .replace(" h264 ", " libopenh264 ");
        // A hardware decoder named after HEVC is not the decoder ffmpeg uses.
        assert_eq!(lacking_in(&decoder_names(&text)), ["hevc", "eac3"]);
    }

    #[test]
    fn no_list_is_no_answer_not_everything_missing() {
        assert!(lacking_in(&decoder_names("")).is_empty());
        assert!(lacking_in(&decoder_names("Decoders:\n ------\n")).is_empty());
    }

    /// A fresh, empty folder of this test's own under the system's temp folder.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kinema-ffmpeg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put_ffmpeg(dir: &Path) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let exe = dir.join(FFMPEG_EXE);
        std::fs::write(&exe, b"").unwrap();
        exe
    }

    #[test]
    fn the_first_folder_with_ffmpeg_wins() {
        let root = scratch("order");
        let (empty, first, second) = (root.join("empty"), root.join("first"), root.join("second"));
        std::fs::create_dir_all(&empty).unwrap();
        let wanted = put_ffmpeg(&first);
        put_ffmpeg(&second);
        let missing = root.join("not-there");
        assert_eq!(
            first_with_ffmpeg([PathBuf::new(), missing, empty, first, second]),
            Some(wanted)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_folder_with_ffmpeg_finds_nothing() {
        let root = scratch("none");
        assert_eq!(first_with_ffmpeg([root.clone(), root.join("nope")]), None);
        // A folder *named* ffmpeg.exe is not the program.
        std::fs::create_dir_all(root.join("dir").join(FFMPEG_EXE)).unwrap();
        assert_eq!(first_with_ffmpeg([root.join("dir")]), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// winget's package folder as a portable zip install leaves it, when the
    /// command links could not be made: only Gyan's ffmpeg, newest first.
    #[test]
    fn winget_package_folders_are_found_newest_first() {
        let packages = scratch("packages");
        let essentials = packages.join("Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe");
        let old = put_ffmpeg(&essentials.join("ffmpeg-8.0-essentials_build").join("bin"));
        let new = put_ffmpeg(&essentials.join("ffmpeg-9.0.1-essentials_build").join("bin"));
        put_ffmpeg(&packages.join("Someone.Else_x").join("ffmpeg-1-build").join("bin"));
        std::fs::write(packages.join("Gyan.FFmpeg.stray-file"), b"").unwrap();

        let bins = winget_package_bins(&packages);
        assert_eq!(bins.len(), 2, "{bins:?}");
        assert_eq!(first_with_ffmpeg(bins), Some(new));
        assert!(old.is_file());
        assert!(winget_package_bins(&packages.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(&packages);
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
        // Built with `join`: `C:\tools\…` is one file name on Linux.
        let bin = Path::new("tools").join("ffmpeg").join("bin");
        let probe = probe_binary(&bin.join("ffmpeg.exe"));
        assert_eq!(probe.parent().unwrap(), bin);
        assert!(probe.file_name().unwrap().to_string_lossy().starts_with("ffprobe"));
    }

    #[test]
    fn a_bare_ffmpeg_yields_a_bare_ffprobe() {
        assert_eq!(probe_binary(Path::new("ffmpeg")), PathBuf::from("ffprobe"));
    }
}
