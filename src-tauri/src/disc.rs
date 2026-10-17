//! Blu-ray discs: a disc folder (`BDMV/index.bdmv` inside it) or a disc image
//! (`.iso`), played through mpv's own Blu-ray support, and the languages a
//! disc gives the tracks of a loose Blu-ray `.m2ts`.
//!
//! What mpv does with them, measured through the real player (2026-10-17):
//!
//!  * `loadfile <disc.iso>` and `loadfile <disc>/BDMV/index.bdmv` both fail.
//!    `bd://` with the `bluray-device` option set to the folder or the image
//!    plays the disc's longest playlist — the film — with its chapters and
//!    with track languages from the disc. mpv's `path` is then `bd://`.
//!  * A Blu-ray `.m2ts` played as a file plays, but with no languages and no
//!    chapters: those live in the disc's CLPI and MPLS files, not the stream.
//!    Where the clip's CLPI is still beside it, the languages are read here.
//!  * An encrypted disc (AACS, BD+) does not open, and the reason is only in
//!    mpv's log: `[e][bd] AACS encryption detected but cannot find libaacs.`
//!    Kinema cannot decrypt a disc and does not try; it says what mpv said.
//!
//! Desktop only: Android's player has no Blu-ray support, so there a disc
//! folder stays out of the library as before (`scanner.rs`).

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The `extension` a disc folder is recorded with in `media_files`: it has no
/// extension of its own, and a folder name's last dot is not one (`.BluRay`).
pub const FOLDER_EXTENSION: &str = "bdmv";

/// `dir`'s child called `name`, compared without case: discs are written in
/// capitals (`BDMV/STREAM`), copies of them not always.
fn child(dir: &Path, name: &str) -> Option<PathBuf> {
    let exact = dir.join(name);
    if exact.exists() {
        return Some(exact);
    }
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name))
        .map(|e| e.path())
}

/// Whether a folder's name is `BDMV`, the one every disc folder has.
pub fn is_bdmv_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("bdmv")
}

/// The `BDMV` folder of a disc folder: `dir/BDMV`, holding `index.bdmv`.
fn bdmv_of(dir: &Path) -> Option<PathBuf> {
    let bdmv = child(dir, "BDMV")?;
    child(&bdmv, "index.bdmv").filter(|p| p.is_file())?;
    Some(bdmv)
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("iso"))
}

/// One clip of a disc: a `.m2ts` in `BDMV/STREAM`.
struct Clip {
    path: PathBuf,
    size: u64,
    modified: i64,
}

fn clips(bdmv: &Path) -> Vec<Clip> {
    let Some(stream) = child(bdmv, "STREAM") else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(stream) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| {
            Path::new(&e.file_name())
                .extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case("m2ts"))
        })
        .filter_map(|e| {
            let meta = e.metadata().ok().filter(|m| m.is_file())?;
            Some(Clip {
                path: e.path(),
                size: meta.len(),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs() as i64),
            })
        })
        .collect()
}

/// A disc folder as the scan records it: one title.
pub struct DiscFolder {
    /// Every clip together, so a changed disc reads as a changed file.
    pub size: u64,
    /// The newest clip's time.
    pub modified: i64,
}

/// `dir` as one disc, if it is one worth playing as a disc.
///
/// Not when a loose video beside `BDMV` is bigger than every clip in it: a
/// disc whose film was moved out (`Film/00800.m2ts` beside a `Film/BDMV`
/// holding only the menus and extras), where the loose file is the film, as
/// the scan has always found it. Played as a disc, that one would open a menu
/// clip, or nothing.
pub fn disc_folder(dir: &Path) -> Option<DiscFolder> {
    let clips = clips(&bdmv_of(dir)?);
    let biggest = clips.iter().map(|c| c.size).max()?;
    let loose = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| crate::scanner::is_video(&e.path()))
        .filter_map(|e| e.metadata().ok().filter(|m| m.is_file()).map(|m| m.len()))
        .max()
        .unwrap_or(0);
    if loose >= biggest {
        return None;
    }
    Some(DiscFolder {
        size: clips.iter().map(|c| c.size).sum(),
        modified: clips.iter().map(|c| c.modified).max().unwrap_or(0),
    })
}

/// The file ffprobe and the picture measurement read for a library entry: the
/// entry itself, or for a disc folder its biggest clip — the film. An image
/// is read as it is, which ffprobe cannot; it goes without badges.
pub fn readable(path: &Path) -> PathBuf {
    // A disc folder's name has no video extension; a file's has, and is not
    // asked about over the network a second time.
    if !crate::scanner::is_video(path) && path.is_dir() {
        if let Some(bdmv) = bdmv_of(path) {
            if let Some(clip) = clips(&bdmv).into_iter().max_by_key(|c| c.size) {
                return clip.path;
            }
        }
    }
    path.to_path_buf()
}

// ---- languages from a clip's CLPI -----------------------------------------

/// The CLPI beside a loose clip: `00800.m2ts` with `BDMV/CLIPINF/00800.clpi`
/// in its own folder (a film moved out of its disc), or `../CLIPINF` when the
/// clip is still in `BDMV/STREAM`.
fn clpi_for(clip: &Path) -> Option<PathBuf> {
    let stem = clip.file_stem()?.to_str()?;
    let name = format!("{stem}.clpi");
    let folder = clip.parent()?;
    let in_stream = folder
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("STREAM"));
    let clipinf = if in_stream {
        child(folder.parent()?, "CLIPINF")?
    } else {
        child(&child(folder, "BDMV")?, "CLIPINF")?
    };
    child(&clipinf, &name).filter(|p| p.is_file())
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<usize> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?) as usize)
}

/// A three-letter language code as the disc stores it, if it is one.
fn language_at(b: &[u8], at: usize) -> Option<String> {
    let code = b.get(at..at + 3)?;
    code.iter()
        .all(u8::is_ascii_alphabetic)
        .then(|| String::from_utf8_lossy(code).to_ascii_lowercase())
}

/// Each stream's language by its PID, from a CLPI file's ProgramInfo — the
/// layout libbluray reads (`clpi_parse.c`). mpv's `src-id` for a track of an
/// MPEG transport stream is its PID, which is how the two are joined.
pub fn clpi_languages(b: &[u8]) -> HashMap<u16, String> {
    let mut languages = HashMap::new();
    if b.get(..4) != Some(b"HDMV") {
        return languages;
    }
    let Some(program_info) = u32_at(b, 12) else {
        return languages;
    };
    let Some(&sequences) = b.get(program_info + 5) else {
        return languages;
    };
    let mut at = program_info + 6;
    for _ in 0..sequences {
        // SPN start (4), program map PID (2), streams (1), groups (1).
        let Some(&streams) = b.get(at + 6) else {
            return languages;
        };
        at += 8;
        for _ in 0..streams {
            let (Some(pid), Some(&length)) = (u16_at(b, at), b.get(at + 2)) else {
                return languages;
            };
            let attributes = at + 3;
            let language = match b.get(attributes) {
                // Audio: coding type, then format and rate in one byte.
                Some(0x03 | 0x04 | 0x80..=0x86 | 0xa1 | 0xa2) => language_at(b, attributes + 2),
                // Presentation and interactive graphics.
                Some(0x90 | 0x91) => language_at(b, attributes + 1),
                // Text subtitles: a character code first.
                Some(0x92) => language_at(b, attributes + 2),
                _ => None,
            };
            if let Some(language) = language {
                languages.insert(pid, language);
            }
            at = attributes + length as usize;
        }
    }
    languages
}

// ---- what the player is given ----------------------------------------------

/// How the player opens a library entry.
#[derive(Serialize, Debug, Default, PartialEq)]
pub struct DiscSource {
    /// A disc folder or image: opened as `bd://` with `bluray-device`.
    pub disc: bool,
    /// For a loose Blu-ray clip, its tracks' languages by PID, from the
    /// disc's CLPI where it is still beside the clip. Empty otherwise.
    pub languages: HashMap<u16, String>,
    /// For a disc, how long mpv's log is as it is opened: why it fails is
    /// read from after here, never from an earlier disc's lines.
    pub log_mark: Option<u64>,
}

fn mpv_log(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir(app)?
        .join(crate::applog::DIR)
        .join(crate::applog::MPV_LOG))
}

/// Asked by the player as it opens a file: a few stat calls, no reading of
/// the video. Files on a share Kinema opens itself (`smb://`) are never discs:
/// mpv's Blu-ray support reads only what the system can open.
#[tauri::command]
pub fn disc_source(app: tauri::AppHandle, path: String) -> DiscSource {
    source_of(&path, || {
        mpv_log(&app)
            .ok()
            .and_then(|log| std::fs::metadata(log).ok())
            .map_or(0, |m| m.len())
    })
}

fn source_of(path: &str, log_length: impl Fn() -> u64) -> DiscSource {
    if crate::netshare::is_share_path(path) {
        return DiscSource::default();
    }
    let path = Path::new(path);
    if (is_image(path) && path.is_file()) || (path.is_dir() && bdmv_of(path).is_some()) {
        return DiscSource { disc: true, log_mark: Some(log_length()), ..Default::default() };
    }
    let is_clip = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("m2ts"));
    let languages = is_clip
        .then(|| clpi_for(path))
        .flatten()
        .and_then(|clpi| std::fs::read(clpi).ok())
        .map(|bytes| clpi_languages(&bytes))
        .unwrap_or_default();
    DiscSource { disc: false, languages, log_mark: None }
}

// ---- why a disc did not open -----------------------------------------------

/// What mpv's log says about a disc that did not open.
#[derive(Serialize, Debug, PartialEq)]
pub struct DiscFailure {
    /// `AACS` or `BD+` when mpv said the disc is encrypted with it.
    pub protection: Option<&'static str>,
    /// mpv's own error lines about the disc, without their prefixes.
    pub said: Vec<String>,
}

#[derive(Debug, PartialEq)]
enum Reading {
    Failed(DiscFailure),
    Opened,
    /// The log has not caught up with the player yet, or holds no disc.
    NotYet,
}

/// The last disc opening in an mpv log, and how it ended.
fn last_opening(log: &str) -> Reading {
    let Some(start) = log.rfind("][bd] Opening ") else {
        return Reading::NotYet;
    };
    let mut said = Vec::new();
    for line in log[start..].lines().skip(1) {
        if line.contains("][cplayer] Opening done") {
            return Reading::Opened;
        }
        if let Some(at) = line.find("][e][bd] ") {
            said.push(line[at + "][e][bd] ".len()..].trim().to_string());
        }
        if line.contains("][cplayer] Opening failed") {
            let protection = if said.iter().any(|s| s.contains("AACS")) {
                Some("AACS")
            } else if said.iter().any(|s| s.contains("BD+")) {
                Some("BD+")
            } else {
                None
            };
            return Reading::Failed(DiscFailure { protection, said });
        }
    }
    Reading::NotYet
}

/// mpv's log from `from` on — at most its last half megabyte, enough for one
/// opening however long the session. A log shorter than `from` has been
/// started afresh, and is read from its start.
fn log_from(path: &Path, from: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 512 * 1024;
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let length = file.metadata().map(|m| m.len()).unwrap_or(0);
    let from = if from > length { 0 } else { from };
    let _ = file.seek(SeekFrom::Start(from.max(length.saturating_sub(TAIL))));
    let mut bytes = Vec::new();
    let _ = file.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Why the disc the player just tried did not open, as mpv's log says after
/// `from` (its `log_mark`) — asked after mpv reported that it failed. mpv
/// writes its log from a thread of its own, so the lines may arrive a moment
/// after the event: read again for up to a second. None when the log says
/// nothing about it.
#[tauri::command]
pub async fn disc_failure(
    app: tauri::AppHandle,
    from: u64,
) -> Result<Option<DiscFailure>, String> {
    let log = mpv_log(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        for _ in 0..10 {
            match last_opening(&log_from(&log, from)) {
                Reading::Failed(failure) => return Some(failure),
                Reading::Opened => return None,
                Reading::NotYet => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
        None
    })
    .await
    .map_err(crate::util::to_string_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A CLPI with one program: H.264 video, TrueHD and AC-3 audio, one PG
    /// subtitle track, laid out as libbluray reads it.
    fn clpi() -> Vec<u8> {
        let mut b = b"HDMV0200".to_vec();
        b.extend([0, 0, 0, 0]); // sequence info
        b.extend(40u32.to_be_bytes()); // program info here
        b.resize(40, 0);
        b.extend([0, 0, 0, 0, 0, 1]); // length, reserved, one program sequence
        b.extend([0, 0, 0, 0, 0x01, 0x00, 4, 0]); // SPN, map PID, 4 streams, groups
        b.extend([0x10, 0x11, 5, 0x1b, 0x61, 0, 0, 0]); // video: no language
        b.extend([0x11, 0x00, 5, 0x83, 0x61, b'e', b'n', b'g']); // TrueHD
        b.extend([0x11, 0x01, 5, 0x81, 0x61, b'f', b'r', b'a']); // AC-3
        b.extend([0x12, 0x00, 4, 0x90, b'n', b'o', b'r']); // PG
        b
    }

    #[test]
    fn languages_come_from_each_streams_attributes() {
        let languages = clpi_languages(&clpi());
        assert_eq!(languages.len(), 3);
        assert_eq!(languages[&0x1100], "eng");
        assert_eq!(languages[&0x1101], "fra");
        assert_eq!(languages[&0x1200], "nor");
    }

    #[test]
    fn a_file_that_is_not_a_clpi_has_no_languages() {
        assert!(clpi_languages(b"not a clip information file").is_empty());
        let mut cut = clpi();
        cut.truncate(60);
        // Cut short in the middle of the streams: what was read before stays.
        assert!(clpi_languages(&cut).len() <= 1);
    }

    #[test]
    fn an_encrypted_disc_is_named_from_the_log() {
        let log = "[  97.494][v][bd] Opening bd://\n\
            [  97.506][e][bd] AACS encryption detected but cannot find libaacs.\n\
            [  97.508][e][stream] No protocol handler found to open URL bd://\n\
            [  97.508][v][cplayer] Opening failed or was aborted: bd://\n";
        assert_eq!(
            last_opening(log),
            Reading::Failed(DiscFailure {
                protection: Some("AACS"),
                said: vec!["AACS encryption detected but cannot find libaacs.".into()],
            })
        );
    }

    #[test]
    fn only_the_last_opening_counts() {
        let log = "[1][v][bd] Opening bd://\n[1][e][bd] AACS encryption detected\n\
            [1][v][cplayer] Opening failed or was aborted: bd://\n\
            [2][v][bd] Opening bd://\n[2][v][cplayer] Opening done: bd://\n";
        assert_eq!(last_opening(log), Reading::Opened);
        let failed_plainly = "[3][v][bd] Opening bd://\n[3][v][cplayer] Opening failed or was aborted: bd://\n";
        assert_eq!(
            last_opening(failed_plainly),
            Reading::Failed(DiscFailure { protection: None, said: vec![] })
        );
    }

    #[test]
    fn the_log_is_read_from_the_mark_on() {
        let log = std::env::temp_dir().join(format!("kinema-disc-log-{}", std::process::id()));
        let earlier = "[1][v][bd] Opening bd://\n[1][e][bd] AACS encryption detected\n\
            [1][v][cplayer] Opening failed or was aborted: bd://\n";
        std::fs::write(&log, earlier).unwrap();
        let mark = earlier.len() as u64;
        // Nothing of this disc's yet: the earlier disc's reason is not taken.
        assert_eq!(last_opening(&log_from(&log, mark)), Reading::NotYet);
        std::fs::write(&log, format!("{earlier}[2][v][bd] Opening bd://\n[2][v][cplayer] Opening done: bd://\n")).unwrap();
        assert_eq!(last_opening(&log_from(&log, mark)), Reading::Opened);
        // A log started afresh since the mark is read from its start.
        assert!(log_from(&log, 1 << 30).starts_with("[1]"));
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn a_log_that_has_not_caught_up_is_read_again() {
        assert_eq!(last_opening("[1][v][bd] Opening bd://\n"), Reading::NotYet);
        assert_eq!(last_opening(""), Reading::NotYet);
    }

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kinema-disc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("BDMV/STREAM")).unwrap();
        std::fs::create_dir_all(dir.join("BDMV/CLIPINF")).unwrap();
        std::fs::write(dir.join("BDMV/index.bdmv"), b"INDX0200").unwrap();
        std::fs::write(dir.join("BDMV/STREAM/00001.m2ts"), vec![0; 3000]).unwrap();
        std::fs::write(dir.join("BDMV/STREAM/00002.m2ts"), vec![0; 1000]).unwrap();
        dir
    }

    #[test]
    fn a_whole_disc_folder_is_one_title_read_through_its_biggest_clip() {
        let dir = folder("whole");
        let disc = disc_folder(&dir).expect("a disc");
        assert_eq!(disc.size, 4000);
        assert_eq!(readable(&dir), dir.join("BDMV").join("STREAM").join("00001.m2ts"));
        let source = source_of(&dir.to_string_lossy(), || 77);
        assert!(source.disc);
        assert_eq!(source.log_mark, Some(77));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_film_moved_out_of_its_disc_stays_the_title() {
        let dir = folder("moved");
        std::fs::write(dir.join("00800.m2ts"), vec![0; 5000]).unwrap();
        std::fs::write(dir.join("BDMV/CLIPINF/00800.clpi"), clpi()).unwrap();
        assert!(disc_folder(&dir).is_none());
        let clip = source_of(&dir.join("00800.m2ts").to_string_lossy(), || 0);
        assert!(!clip.disc);
        assert_eq!(clip.languages[&0x1101], "fra");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_without_index_bdmv_is_not_a_disc() {
        let dir = folder("noindex");
        std::fs::remove_file(dir.join("BDMV/index.bdmv")).unwrap();
        assert!(disc_folder(&dir).is_none());
        assert!(!source_of(&dir.to_string_lossy(), || 0).disc);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
