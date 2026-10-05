//! Subtitle files beside a film, for a player that does not look for them
//! itself.
//!
//! mpv finds them on its own (`sub-auto=fuzzy`, mpvOptions.ts). Media3, on
//! Android, plays only what it is handed, so the page asks here before
//! opening a film and hands it the ones found — on a drive the system opened
//! or a share Kinema opens itself alike (files.rs). The same rule as mpv's
//! "fuzzy": any subtitle file in the film's folder whose name contains the
//! film's. What follows the film's name says the rest, as the files are
//! usually named: `Film.no.srt`, `Film.en.forced.srt`, `Film.en.sdh.srt`.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The kinds Media3 can read from a file of their own. Image subtitles
/// (`.sup`, `.sub` with `.idx`) are only read inside a film.
const KINDS: &[&str] = &["srt", "ass", "ssa", "vtt"];

#[derive(Serialize, Debug, PartialEq)]
pub struct SubtitleFile {
    pub path: String,
    /// The language its name gives, as written there ("no", "eng"); the page
    /// reads either.
    pub language: Option<String>,
    pub forced: bool,
    /// For the deaf and hard of hearing ("sdh" or "cc" in the name; not "hi",
    /// which is Hindi).
    pub hearing_impaired: bool,
}

/// The subtitle files beside `path`, in name order. None when its folder
/// cannot be read: the film plays without them.
#[tauri::command]
pub async fn subtitle_files(path: String) -> Result<Vec<SubtitleFile>, String> {
    crate::jobs::off_main(move || {
        let film = Path::new(&path);
        let Some(dir) = film.parent() else { return Ok(Vec::new()) };
        let entries = crate::files::read_dir(dir).unwrap_or_default();
        Ok(beside(film, entries))
    })
    .await
}

fn beside(film: &Path, entries: Vec<(PathBuf, bool)>) -> Vec<SubtitleFile> {
    let Some(stem) = film.file_stem().and_then(|s| s.to_str()) else { return Vec::new() };
    let stem = stem.to_lowercase();
    let mut found: Vec<SubtitleFile> = entries
        .into_iter()
        .filter(|(_, is_dir)| !is_dir)
        .filter_map(|(p, _)| {
            let kind = p.extension()?.to_str()?.to_lowercase();
            if !KINDS.contains(&kind.as_str()) {
                return None;
            }
            let name = p.file_stem()?.to_str()?.to_lowercase();
            let at = name.find(&stem)?;
            Some(described(p.to_string_lossy().into_owned(), &name[at + stem.len()..]))
        })
        .collect();
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// What the words after the film's name say: `.no.forced` → Norwegian,
/// forced.
fn described(path: String, rest: &str) -> SubtitleFile {
    let mut file = SubtitleFile { path, language: None, forced: false, hearing_impaired: false };
    for word in rest.split(['.', '_', ' ', '[', ']', '(', ')']).filter(|w| !w.is_empty()) {
        match word {
            "forced" | "foreign" => file.forced = true,
            "sdh" | "cc" => file.hearing_impaired = true,
            w if file.language.is_none() && is_language_code(w) => file.language = Some(w.to_string()),
            _ => {}
        }
    }
    file
}

/// "no", "eng", "pt-br": two or three letters, and a region after a dash.
fn is_language_code(word: &str) -> bool {
    let letters = |s: &str, lengths: std::ops::RangeInclusive<usize>| {
        lengths.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase())
    };
    match word.split_once('-') {
        Some((language, region)) => letters(language, 2..=3) && letters(region, 2..=2),
        None => letters(word, 2..=3),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(names: &[&str]) -> Vec<(PathBuf, bool)> {
        names.iter().map(|n| (PathBuf::from(format!("/films/A film/{n}")), false)).collect()
    }

    #[test]
    fn finds_the_films_own_subtitles_and_reads_their_names() {
        let film = Path::new("/films/A film/A.Film.2017.mkv");
        let found = beside(
            film,
            entries(&[
                "A.Film.2017.mkv",
                "A.Film.2017.no.srt",
                "A.Film.2017.en.forced.srt",
                "A.Film.2017.eng.SDH.srt",
                "A.Film.2017.srt",
                "A.Film.2017.nfo",
                "Another.Film.2003.en.srt",
                "A.Film.2017.en.sup",
            ]),
        );
        let said: Vec<_> = found
            .iter()
            .map(|f| (f.path.rsplit('/').next().unwrap(), f.language.as_deref(), f.forced, f.hearing_impaired))
            .collect();
        assert_eq!(
            said,
            vec![
                ("A.Film.2017.en.forced.srt", Some("en"), true, false),
                ("A.Film.2017.eng.SDH.srt", Some("eng"), false, true),
                ("A.Film.2017.no.srt", Some("no"), false, false),
                ("A.Film.2017.srt", None, false, false),
            ]
        );
    }

    #[test]
    fn a_folder_is_not_a_subtitle_and_case_does_not_matter() {
        let film = Path::new("/films/A film/a film.mkv");
        let mut list = entries(&["A FILM.pt-br.ASS"]);
        list.push((PathBuf::from("/films/A film/a film.srt"), true));
        let found = beside(film, list);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].language.as_deref(), Some("pt-br"));
    }

    #[test]
    fn on_a_share_too() {
        let film = Path::new("smb://nas/films/A film (2001)/A film.mkv");
        let found = beside(
            film,
            vec![(PathBuf::from("smb://nas/films/A film (2001)/A film.nl.srt"), false)],
        );
        assert_eq!(found[0].path, "smb://nas/films/A film (2001)/A film.nl.srt");
    }
}
