//! Local trailer discovery.
//!
//! Trailers are ordinary video files on disk, found by the same conventions
//! Jellyfin and Kodi use — so a library that already has them keeps working,
//! and one built here stays readable by those.
//!
//! Nothing downloads anything. That is the point: a local file has no ads, no
//! binary to ship, no API to break, and it plays through the same mpv pipeline
//! as the feature itself. Titles with no local trailer fall back to opening the
//! provider's YouTube link in the user's own browser, where their own ad
//! blocking already applies.

use std::path::{Path, PathBuf};

/// Container formats a trailer might be in. Same list the scanner indexes.
const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "m4v", "avi", "mov", "wmv", "flv", "webm", "mpg", "mpeg", "m2ts", "ts", "divx",
];

/// Filename endings that mark a file as a trailer rather than a feature.
///
/// Jellyfin also accepts a space (`Movie trailer.mkv`). That form is
/// deliberately **not** supported here, because it cannot be told apart from a
/// film whose title genuinely ends in the word — `The Trailer.mkv`,
/// `Trailer Park Boys.mkv`. Getting that wrong removes a real title from the
/// library and there is nothing to notice: it simply is not there. Failing to
/// recognise a space-named trailer costs a button, and the file still shows up
/// as ordinary work in the review queue.
const TRAILER_SUFFIXES: &[&str] = &["-trailer", ".trailer", "_trailer"];

/// Subfolder convention, checked before the suffix one.
const TRAILER_DIR: &str = "trailers";

fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Whether a filename names a trailer.
///
/// Also used by the scanner: a file recognised here must not be indexed as a
/// feature, or using the `-trailer` convention would add a junk title to the
/// library for every film that has one.
pub fn is_trailer_file_name(file_name: &str) -> bool {
    let lower = file_name.to_lowercase();
    let stem = match lower.rsplit_once('.') {
        Some((stem, _ext)) => stem,
        None => lower.as_str(),
    };

    stem == "trailer" || TRAILER_SUFFIXES.iter().any(|suffix| stem.ends_with(suffix))
}

/// Whether a directory is a season folder, and therefore whether the show's
/// trailer is plausibly one level up.
///
/// Only season folders get that treatment. Walking up from a *movie* folder
/// would reach the library root, where a stray `trailers` directory would then
/// be served as the trailer for every film in the library.
fn looks_like_season_dir(dir: &Path) -> bool {
    let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_lowercase();

    lower.starts_with("season")
        || lower.starts_with("staffel")
        || lower.starts_with("specials")
        || (lower.starts_with('s')
            && lower.len() <= 4
            && lower[1..].chars().all(|c| c.is_ascii_digit())
            && lower.len() > 1)
}

/// First video file inside `<dir>/trailers`, if that folder exists.
fn trailer_in_subfolder(dir: &Path) -> Option<PathBuf> {
    let folder = dir.join(TRAILER_DIR);
    let entries = std::fs::read_dir(&folder).ok()?;

    let mut found: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_video(p))
        .collect();

    // Sorted so a folder with several files resolves to the same one every
    // time rather than to whatever the filesystem listed first.
    found.sort();
    found.into_iter().next()
}

/// A trailer-suffixed file sitting directly in `dir`.
fn trailer_beside(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;

    let mut found: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && is_video(p)
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(is_trailer_file_name)
                    .unwrap_or(false)
        })
        .collect();

    found.sort();
    found.into_iter().next()
}

fn search_dir(dir: &Path) -> Option<PathBuf> {
    trailer_in_subfolder(dir).or_else(|| trailer_beside(dir))
}

/// Find a local trailer for a video, or `None`.
///
/// Searches the video's own directory, and — only for a season folder — the
/// show directory above it, since a show's trailer usually sits at the top
/// rather than inside Season 1.
#[tauri::command]
pub fn find_local_trailer(video_path: String) -> Result<Option<String>, String> {
    let video = Path::new(&video_path);
    let Some(dir) = video.parent() else {
        return Ok(None);
    };

    if let Some(found) = search_dir(dir) {
        return Ok(Some(found.display().to_string()));
    }

    if looks_like_season_dir(dir) {
        if let Some(parent) = dir.parent() {
            if let Some(found) = search_dir(parent) {
                return Ok(Some(found.display().to_string()));
            }
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_unambiguous_trailer_spellings() {
        for name in [
            "trailer.mp4",
            "Best Movie-trailer.mkv",
            "Best Movie.trailer.mkv",
            "Best Movie_trailer.mkv",
            "BEST MOVIE-TRAILER.MKV",
        ] {
            assert!(is_trailer_file_name(name), "{name} should be a trailer");
        }
    }

    #[test]
    fn leaves_ordinary_features_alone() {
        for name in [
            "Best Movie (2019).mkv",
            "Trailer Park Boys S01E01.mkv",
            "trailers.mkv",
        ] {
            assert!(!is_trailer_file_name(name), "{name} is not a trailer");
        }
    }

    /// The space-separated form is not supported on purpose: misreading a real
    /// title as a trailer hides it from the library with nothing to notice,
    /// while missing a trailer only costs a button.
    #[test]
    fn never_mistakes_a_title_ending_in_trailer_for_one() {
        assert!(!is_trailer_file_name("The Trailer.mkv"));
        assert!(!is_trailer_file_name("Best Movie trailer.mkv"));
    }

    #[test]
    fn only_season_folders_look_upward() {
        for dir in ["Season 1", "season 02", "S01", "Specials", "Staffel 3"] {
            assert!(looks_like_season_dir(Path::new(dir)), "{dir} is a season");
        }
        for dir in ["300 (2006)", "filmer", "Sex And The City S01 1080p BluRay"] {
            assert!(
                !looks_like_season_dir(Path::new(dir)),
                "{dir} must not walk up to the library root"
            );
        }
    }
}
