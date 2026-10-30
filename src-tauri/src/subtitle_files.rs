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

/// What a subtitle file covers, read from its own cue times: how many cues,
/// and when the first starts and the last ends. "Subtitle candidates read
/// before offering" (VENTIC.md), for the one already fetched: a file that
/// stops far short of the film, or runs past its end, was made for another
/// cut, and the panel says so rather than leaving it to be found out.
#[derive(Serialize, Debug, PartialEq)]
pub struct SubtitleSpan {
    pub cues: usize,
    pub first_secs: f64,
    pub last_secs: f64,
}

/// `01:02:03,456` (SRT), `01:02:03.456` and `02:03.456` (WebVTT).
fn cue_time(text: &str) -> Option<f64> {
    let stamp = text.split_whitespace().next()?.replace(',', ".");
    let parts: Vec<&str> = stamp.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let mut secs = 0.0;
    for part in &parts {
        secs = secs * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(secs)
}

/// The span of a text subtitle's cues (SRT, WebVTT), or None when it has none.
pub fn span_of(text: &str) -> Option<SubtitleSpan> {
    let mut span: Option<SubtitleSpan> = None;
    for line in text.lines() {
        let Some((start, end)) = line.split_once("-->") else { continue };
        let (Some(start), Some(end)) = (cue_time(start), cue_time(end)) else { continue };
        let s = span.get_or_insert(SubtitleSpan { cues: 0, first_secs: start, last_secs: end });
        s.cues += 1;
        s.first_secs = s.first_secs.min(start);
        s.last_secs = s.last_secs.max(end);
    }
    span
}

/// The span of the subtitle file at `path`; None when it cannot be read or
/// holds no cues Kinema can read, which says nothing either way.
#[tauri::command]
pub async fn subtitle_span(path: String) -> Result<Option<SubtitleSpan>, String> {
    crate::jobs::off_main(move || {
        Ok(std::fs::read(&path).ok().and_then(|bytes| span_of(&String::from_utf8_lossy(&bytes))))
    })
    .await
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

    #[test]
    fn a_subtitle_s_span_is_read_from_its_cue_times() {
        let srt = ["1", "00:01:02,500 --> 00:01:04,000", "Hello", "", "2", "01:58:00,000 --> 01:58:03,250", "Bye", ""].join("\n");
        assert_eq!(span_of(&srt), Some(SubtitleSpan { cues: 2, first_secs: 62.5, last_secs: 7083.25 }));
        let vtt = ["WEBVTT", "", "00:05.000 --> 00:07.000 line:90%", "Hi"].join("\n");
        assert_eq!(span_of(&vtt), Some(SubtitleSpan { cues: 1, first_secs: 5.0, last_secs: 7.0 }));
        assert_eq!(span_of("no cues here"), None);
        assert_eq!(span_of("1 --> x"), None);
    }
}
