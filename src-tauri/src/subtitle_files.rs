//! Subtitle files beside a film, for a player that does not look for them
//! itself.
//!
//! Media3, on Android, plays only what it is handed, so the page asks here
//! before opening a film and hands it the ones found — on a drive the system
//! opened or a share Kinema opens itself alike (files.rs). mpv finds most of
//! them on its own (`sub-auto=fuzzy`, mpvOptions.ts) and is handed the rest
//! (`exact_name`, engine.ts `addSubtitlesBeside`).
//!
//! The rule is mpv's "fuzzy" — any subtitle file in the film's folder whose
//! name contains the film's — with spaces, dots and other marks not counted,
//! nor capitals: a release whose subtitle file says `7. 1` where the film
//! says `7.1` is still the film's. What follows the film's name says the
//! rest, as the files are usually named: `Film.no.srt`, `Film.en.forced.srt`,
//! `Film.en.sdh.srt`.

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
    /// Its name holds the film's exactly, letter for letter and mark for
    /// mark: mpv's own search finds it, and is not handed it a second time.
    pub exact_name: bool,
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
    let (key, _) = letters_and_digits(&stem);
    // A film named only in marks would otherwise claim every subtitle file.
    if key.is_empty() {
        return Vec::new();
    }
    let mut found: Vec<SubtitleFile> = entries
        .into_iter()
        .filter(|(_, is_dir)| !is_dir)
        .filter_map(|(p, _)| {
            let kind = p.extension()?.to_str()?.to_lowercase();
            if !KINDS.contains(&kind.as_str()) {
                return None;
            }
            let name = p.file_stem()?.to_str()?.to_lowercase();
            let (squeezed, ends) = letters_and_digits(&name);
            let at = squeezed.find(&key)?;
            // Where the film's name ends in this file's name as written.
            let rest = &name[ends[at + key.len() - 1]..];
            Some(described(p.to_string_lossy().into_owned(), rest, name.contains(&stem)))
        })
        .collect();
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// `name` with only its letters and digits, and for each byte of that, where
/// the letter or digit it is part of ends in `name`.
fn letters_and_digits(name: &str) -> (String, Vec<usize>) {
    let mut squeezed = String::new();
    let mut ends = Vec::new();
    for (at, c) in name.char_indices().filter(|(_, c)| c.is_alphanumeric()) {
        squeezed.push(c);
        ends.extend(std::iter::repeat_n(at + c.len_utf8(), c.len_utf8()));
    }
    (squeezed, ends)
}

/// What the words after the film's name say: `.no.forced` → Norwegian,
/// forced.
fn described(path: String, rest: &str, exact_name: bool) -> SubtitleFile {
    let mut file = SubtitleFile { path, language: None, forced: false, hearing_impaired: false, exact_name };
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

    #[test]
    fn spaces_and_marks_in_the_names_do_not_count() {
        let film = Path::new("/films/A film/A Film 2006 2160p TrueHD 7.1 Atmos-GRP.mkv");
        let found = beside(
            film,
            entries(&[
                "A Film 2006 2160p TrueHD 7. 1 Atmos-GRP.srt",
                "A_Film_2006_2160p_TrueHD_7_1_Atmos_GRP.no.forced.srt",
                "A Film 2006 2160p TrueHD 7.1 Atmos-GRP.en.srt",
                "A Film 2006 2160p TrueHD 5.1 Atmos-GRP.srt",
            ]),
        );
        let said: Vec<_> = found
            .iter()
            .map(|f| (f.path.rsplit('/').next().unwrap(), f.language.as_deref(), f.forced, f.exact_name))
            .collect();
        assert_eq!(
            said,
            vec![
                ("A Film 2006 2160p TrueHD 7. 1 Atmos-GRP.srt", None, false, false),
                ("A Film 2006 2160p TrueHD 7.1 Atmos-GRP.en.srt", Some("en"), false, true),
                ("A_Film_2006_2160p_TrueHD_7_1_Atmos_GRP.no.forced.srt", Some("no"), true, false),
            ]
        );
    }

    #[test]
    fn letters_beyond_plain_english_are_kept() {
        let film = Path::new("/films/A film/Blåbær.mkv");
        let found = beside(film, entries(&["Blå bær.nb.srt", "Blabaer.srt"]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].language.as_deref(), Some("nb"));
    }

    #[test]
    fn a_film_named_only_in_marks_claims_nothing() {
        let film = Path::new("/films/A film/---.mkv");
        assert!(beside(film, entries(&["A film.srt"])).is_empty());
    }
}
