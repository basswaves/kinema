//! NFO sidecars — the interop format MediaElch, tinyMediaManager and Kodi all
//! read and write.
//!
//! An NFO next to a video is somebody having already answered the question the
//! matcher is guessing at, usually by hand and usually correctly. When one
//! carries a provider id it is treated as authoritative: no scoring, no
//! ambiguity guard, no chance of a confidently wrong match. That is the whole
//! reason this exists.
//!
//! Parsing is deliberately tolerant of *shape* and strict about *values*. The
//! three producers disagree on plenty — `<uniqueid type="tmdb">` versus a bare
//! `<tmdbid>`, `<year>` versus `<premiered>` — and Kodi's own oldest convention
//! is a file containing nothing but a URL. Unknown elements are ignored rather
//! than treated as an error, because an NFO written by a fourth tool should
//! degrade to "no usable id" instead of to a failure.
//!
//! Nothing here writes during a scan. Export is an explicit action: these files
//! live in the user's media folders, which are frequently read-only shares, and
//! writing to them should never be a side effect of browsing.

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use std::path::{Path, PathBuf};

fn to_string_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Which root element the file had. The kind matters: an `<episodedetails>`
/// id identifies an episode, not the show, and using one as the other would
/// link a whole season to the wrong thing.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NfoKind {
    Movie,
    Tvshow,
    Episode,
    /// A bare URL or id, Kodi's oldest convention. Kind is unknown.
    Url,
}

#[derive(Serialize, Debug, Default, Clone)]
pub struct NfoIds {
    pub tmdb: Option<String>,
    pub imdb: Option<String>,
    pub tvdb: Option<String>,
}

impl NfoIds {
    fn is_empty(&self) -> bool {
        self.tmdb.is_none() && self.imdb.is_none() && self.tvdb.is_none()
    }

    /// First value wins. Producers sometimes emit both `<uniqueid>` and a
    /// legacy `<tmdbid>`; the modern element is read first, so keeping the
    /// earlier value means the more specific one is not overwritten by the
    /// fallback.
    fn set(&mut self, kind: &str, value: &str) {
        let value = value.trim();
        if value.is_empty() {
            return;
        }
        let slot = match kind {
            "tmdb" | "themoviedb" => &mut self.tmdb,
            "imdb" => &mut self.imdb,
            "tvdb" | "thetvdb" => &mut self.tvdb,
            _ => return,
        };
        if slot.is_none() {
            *slot = Some(value.to_string());
        }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct Nfo {
    pub kind: NfoKind,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub ids: NfoIds,
    /// Which file this came from, so the match reason can name it.
    pub source: String,
}

/// An id is only an id if it looks like one. A `<uniqueid>` holding a title, a
/// path or an empty string is a producer bug, and storing it would send the
/// matcher to a provider entry that has nothing to do with this file.
fn plausible_imdb(value: &str) -> bool {
    let v = value.trim();
    v.starts_with("tt") && v.len() >= 9 && v[2..].chars().all(|c| c.is_ascii_digit())
}

fn plausible_numeric(value: &str) -> bool {
    let v = value.trim();
    !v.is_empty() && v.len() <= 12 && v.chars().all(|c| c.is_ascii_digit())
}

fn keep_valid(ids: &mut NfoIds) {
    if !ids.imdb.as_deref().is_some_and(plausible_imdb) {
        ids.imdb = None;
    }
    if !ids.tmdb.as_deref().is_some_and(plausible_numeric) {
        ids.tmdb = None;
    }
    if !ids.tvdb.as_deref().is_some_and(plausible_numeric) {
        ids.tvdb = None;
    }
}

/// Year out of `<year>`, or the leading year of an ISO date in `<premiered>`
/// or `<aired>`. Bounded because a stray `<year>0</year>` should read as
/// "no year", not as a real one that then drags the match score around.
fn parse_year(raw: &str) -> Option<i64> {
    let text = raw.trim();
    let head: String = text.chars().take(4).collect();
    let year: i64 = head.parse().ok()?;
    (1870..=2200).contains(&year).then_some(year)
}

/// Kodi's oldest convention: the file is a provider URL, or just an id.
/// Recognised only when the file is not XML at all, so it can never
/// shadow a real document.
fn parse_bare(raw: &str, source: &str) -> Option<Nfo> {
    let text = raw.trim();
    if text.is_empty() || text.starts_with('<') {
        return None;
    }

    let mut ids = NfoIds::default();

    // themoviedb.org/movie/1234 or /tv/1234-some-slug
    if let Some(rest) = text.split("themoviedb.org/").nth(1) {
        if let Some(after_kind) = rest.split('/').nth(1) {
            let digits: String = after_kind.chars().take_while(|c| c.is_ascii_digit()).collect();
            ids.set("tmdb", &digits);
        }
    }
    // Any imdb id anywhere in the text, including a bare `tt0083658`.
    if let Some(found) = text
        .split(|c: char| !(c.is_ascii_alphanumeric()))
        .find(|token| plausible_imdb(token))
    {
        ids.set("imdb", found);
    }
    if let Some(rest) = text.split("thetvdb.com/").nth(1) {
        if let Some(id) = rest.split(['/', '?', '&', '=']).find(|s| plausible_numeric(s)) {
            ids.set("tvdb", id);
        }
    }

    keep_valid(&mut ids);
    if ids.is_empty() {
        return None;
    }

    Some(Nfo {
        kind: NfoKind::Url,
        title: None,
        year: None,
        season: None,
        episode: None,
        ids,
        source: source.to_string(),
    })
}

pub fn parse_nfo(raw: &str, source: &str) -> Option<Nfo> {
    if let Some(bare) = parse_bare(raw, source) {
        return Some(bare);
    }

    let mut reader = Reader::from_str(raw);
    let config = reader.config_mut();
    // Producers emit stray unclosed tags often enough that a strict reader
    // rejects real files; the event stream is still usable without the check.
    config.check_end_names = false;
    // Text is deliberately *not* trimmed per event. Trimming each run drops
    // the spaces on either side of an entity, turning "Fish &amp; Chips" into
    // "Fish&Chips". The accumulated buffer is trimmed once, at the closing tag.

    let mut kind: Option<NfoKind> = None;
    let mut ids = NfoIds::default();
    let mut title: Option<String> = None;
    let mut year: Option<i64> = None;
    let mut season: Option<i64> = None;
    let mut episode: Option<i64> = None;

    // The element we are inside, the depth it opened at, and — for <uniqueid>
    // — the type it declared. Text accumulates until the closing tag, because
    // an entity reference arrives as its own event and splits the run: reading
    // only the first `Text` truncates "Fish &amp; Chips" to "Fish".
    let mut current = String::new();
    let mut current_type = String::new();
    let mut current_depth = 0usize;
    let mut buffer = String::new();
    let mut depth = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                depth += 1;
                let name = String::from_utf8_lossy(e.name().as_ref()).to_ascii_lowercase();

                if depth == 1 {
                    kind = match name.as_str() {
                        "movie" => Some(NfoKind::Movie),
                        "tvshow" => Some(NfoKind::Tvshow),
                        "episodedetails" => Some(NfoKind::Episode),
                        // Not an NFO we understand. Bail rather than scrape
                        // fields out of an unrelated XML document.
                        _ => return None,
                    };
                }

                current_type.clear();
                if name == "uniqueid" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref().eq_ignore_ascii_case(b"type") {
                            current_type = String::from_utf8_lossy(&attr.value).to_ascii_lowercase();
                        }
                    }
                }
                current = name;
                current_depth = depth;
                buffer.clear();
            }
            Ok(Event::End(_)) => {
                let text = buffer.trim();
                // Only direct children of the root. `<movie><set><name>` and
                // `<actor><name>` would otherwise donate a <title> or a <name>
                // that belongs to something else entirely.
                if !text.is_empty() && current_depth == 2 {
                    match current.as_str() {
                        "uniqueid" => ids.set(&current_type, text),
                        "tmdbid" => ids.set("tmdb", text),
                        "tvdbid" => ids.set("tvdb", text),
                        "imdbid" | "imdb_id" => ids.set("imdb", text),
                        // Bare <id> is ambiguous by design — Kodi wrote
                        // whatever the active scraper used. Route it by what it
                        // looks like rather than guessing a provider.
                        "id" => {
                            if plausible_imdb(text) {
                                ids.set("imdb", text);
                            } else if plausible_numeric(text) {
                                ids.set("tmdb", text);
                            }
                        }
                        "title" if title.is_none() => title = Some(text.to_string()),
                        // Only for an episode: on a <tvshow> this is the show's
                        // own title, which we already took from <title>.
                        "showtitle" if title.is_none() && kind == Some(NfoKind::Episode) => {
                            title = Some(text.to_string())
                        }
                        "year" if year.is_none() => year = parse_year(text),
                        "premiered" | "aired" if year.is_none() => year = parse_year(text),
                        "season" if season.is_none() => season = text.parse().ok(),
                        "episode" if episode.is_none() => episode = text.parse().ok(),
                        _ => {}
                    }
                }
                depth = depth.saturating_sub(1);
                current.clear();
                buffer.clear();
            }
            Ok(Event::Text(e)) => {
                if let Ok(text) = e.decode() {
                    buffer.push_str(&text);
                }
            }
            Ok(Event::CData(e)) => {
                if let Ok(text) = e.decode() {
                    buffer.push_str(&text);
                }
            }
            // `&amp;`, `&#38;` and friends. quick-xml reports these separately
            // rather than resolving them into the surrounding text.
            Ok(Event::GeneralRef(e)) => match e.resolve_char_ref() {
                Ok(Some(c)) => buffer.push(c),
                _ => {
                    if let Ok(name) = e.decode() {
                        match name.as_ref() {
                            "amp" => buffer.push('&'),
                            "lt" => buffer.push('<'),
                            "gt" => buffer.push('>'),
                            "quot" => buffer.push('"'),
                            "apos" => buffer.push('\''),
                            _ => {}
                        }
                    }
                }
            },
            Ok(Event::Eof) => break,
            // A malformed document still yields everything read up to the
            // break. Partial data with a valid id is worth more than nothing.
            Err(_) => break,
            _ => {}
        }
    }

    let kind = kind?;
    keep_valid(&mut ids);

    // A document with neither an id nor a title tells the matcher nothing.
    if ids.is_empty() && title.is_none() {
        return None;
    }

    Some(Nfo {
        kind,
        title,
        year,
        season,
        episode,
        ids,
        source: source.to_string(),
    })
}

/// Read a file as text, tolerating what actually turns up on disk: a UTF-8
/// BOM, or Windows-1252 bytes from an older tool. Lossy rather than strict —
/// one undecodable byte in a plot summary must not cost the id in the same
/// file.
fn read_text(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let bytes = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF])
        .unwrap_or(&bytes)
        .to_vec();
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Where a movie or episode NFO may sit for a given video.
fn video_nfo_paths(video: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    // `Movie (2017).nfo` — the extension is replaced. By far the most common.
    if let Some(stem) = video.file_stem() {
        let mut name = stem.to_os_string();
        name.push(".nfo");
        paths.push(video.with_file_name(name));
    }
    // `movie.nfo` beside it, which tinyMediaManager can be configured to write.
    if let Some(dir) = video.parent() {
        paths.push(dir.join("movie.nfo"));
    }
    paths
}

/// Where the *show* NFO may sit, given one of its episode files.
///
/// Checked two levels up because `Show/Season 01/Episode.mkv` is the usual
/// layout and `Show/Episode.mkv` is common enough; beyond that the walk starts
/// finding the NFO of a different show in a shared parent folder.
fn show_nfo_paths(video: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut dir = video.parent();
    for _ in 0..2 {
        let Some(d) = dir else { break };
        paths.push(d.join("tvshow.nfo"));
        dir = d.parent();
    }
    paths
}

/// Does this folder name look like a season folder rather than the show's own?
fn is_season_folder(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    if lower == "specials" || lower.starts_with("season") {
        return true;
    }
    // `S01`, `s1` — but not `Severance`, so the rest must be all digits.
    lower
        .strip_prefix('s')
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
}

/// Where `tvshow.nfo` should go for a given episode file.
///
/// Placement matters more here than anywhere else in this module: episodes
/// normally live in `Show/Season 01/`, so the immediate parent is the *season*
/// folder and writing there produces a file every other tool will ignore.
///
/// An existing `tvshow.nfo` wins outright — that is where this library's owner
/// (or MediaElch) already decided it goes, and matching it keeps the export an
/// update rather than a second, competing file.
fn show_nfo_target(video: &Path) -> Option<PathBuf> {
    for candidate in show_nfo_paths(video) {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let parent = video.parent()?;
    let looks_like_season = parent
        .file_name()
        .map(|n| is_season_folder(&n.to_string_lossy()))
        .unwrap_or(false);

    let folder = if looks_like_season {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };
    Some(folder.join("tvshow.nfo"))
}

fn first_parsed(paths: Vec<PathBuf>) -> Option<Nfo> {
    for path in paths {
        if !path.is_file() {
            continue;
        }
        let source = path.display().to_string();
        let Some(raw) = read_text(&path) else {
            crate::log!("nfo: could not read {source}");
            continue;
        };
        match parse_nfo(&raw, &source) {
            Some(nfo) => return Some(nfo),
            // Present but unusable is worth saying out loud. Silently treating
            // it as absent is how an unsupported dialect stays unnoticed.
            None => crate::log!("nfo: nothing usable in {source}"),
        }
    }
    None
}

/// The NFO for one video file — its own, not the show's.
#[tauri::command]
pub fn read_nfo(path: String) -> Result<Option<Nfo>, String> {
    Ok(first_parsed(video_nfo_paths(Path::new(&path))))
}

/// The show-level NFO for an episode file.
///
/// Separate from `read_nfo` because a series is matched as a group: the id that
/// resolves twelve episodes is the show's, and an `<episodedetails>` id would
/// link all of them to a single episode entry.
#[tauri::command]
pub fn read_show_nfo(path: String) -> Result<Option<Nfo>, String> {
    Ok(first_parsed(show_nfo_paths(Path::new(&path))))
}

// ---- writing ---------------------------------------------------------------

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn element(out: &mut String, name: &str, value: &str) {
    if !value.trim().is_empty() {
        out.push_str(&format!("  <{name}>{}</{name}>\n", escape(value)));
    }
}

/// What to write for one file. Assembled on the TS side, where the library
/// data already lives.
#[derive(serde::Deserialize)]
pub struct NfoExport {
    /// The video file. The NFO goes beside it, extension replaced.
    pub video_path: String,
    /// `movie`, `tvshow` or `episodedetails`.
    pub kind: String,
    pub title: String,
    pub original_title: Option<String>,
    pub year: Option<i64>,
    pub plot: Option<String>,
    pub runtime_mins: Option<i64>,
    pub rating: Option<f64>,
    pub genres: Vec<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub tmdb_id: Option<String>,
    pub imdb_id: Option<String>,
}

fn render(export: &NfoExport) -> String {
    let root = match export.kind.as_str() {
        "tvshow" => "tvshow",
        "episodedetails" => "episodedetails",
        _ => "movie",
    };

    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    out.push_str(&format!("<{root}>\n"));

    element(&mut out, "title", &export.title);
    if let Some(v) = &export.original_title {
        element(&mut out, "originaltitle", v);
    }
    if let Some(v) = export.year {
        element(&mut out, "year", &v.to_string());
    }
    if let Some(v) = &export.plot {
        element(&mut out, "plot", v);
    }
    if let Some(v) = export.runtime_mins {
        element(&mut out, "runtime", &v.to_string());
    }
    if let Some(v) = export.rating {
        element(&mut out, "rating", &format!("{v:.1}"));
    }
    for genre in &export.genres {
        element(&mut out, "genre", genre);
    }
    if let Some(v) = export.season {
        element(&mut out, "season", &v.to_string());
    }
    if let Some(v) = export.episode {
        element(&mut out, "episode", &v.to_string());
    }

    // `default="true"` on the first: Kodi picks that one when re-scraping, and
    // an export with no default makes the reader choose arbitrarily.
    let mut first = true;
    for (kind, value) in [("tmdb", &export.tmdb_id), ("imdb", &export.imdb_id)] {
        if let Some(id) = value.as_deref().filter(|s| !s.trim().is_empty()) {
            out.push_str(&format!(
                "  <uniqueid type=\"{kind}\" default=\"{}\">{}</uniqueid>\n",
                first,
                escape(id)
            ));
            first = false;
        }
    }

    out.push_str(&format!("</{root}>\n"));
    out
}

/// One matched file, with everything an NFO for it needs.
///
/// A query of its own rather than a widening of `TITLE_SELECT`: export is the
/// only caller that wants `imdb_id` and `tmdb_id`, and joining the episode row
/// here means the frontend assembles exports without a request per episode.
#[derive(Serialize)]
pub struct NfoTarget {
    pub path: String,
    pub title_id: i64,
    pub kind: String,
    pub title: String,
    pub year: Option<i64>,
    pub overview: Option<String>,
    /// JSON array, as stored.
    pub genres: Option<String>,
    pub runtime_mins: Option<i64>,
    pub rating: Option<f64>,
    pub imdb_id: Option<String>,
    pub tmdb_id: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub episode_name: Option<String>,
    pub episode_overview: Option<String>,
    pub episode_runtime: Option<i64>,
}

/// Every matched file that is still on disk.
///
/// Missing files are excluded: writing an NFO next to something that has
/// vanished would either fail or, worse, recreate a folder that was deleted.
#[tauri::command]
pub fn nfo_targets(db: tauri::State<crate::library::Db>) -> Result<Vec<NfoTarget>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT m.path, t.id, t.kind, t.title, t.year, t.overview, t.genres,
                    t.runtime_mins, t.rating, t.imdb_id, t.tmdb_id,
                    m.parsed_season, m.parsed_episode,
                    e.name, e.overview, e.runtime_mins
               FROM media_files m
               JOIN titles t ON t.id = m.title_id
               LEFT JOIN episodes e
                 ON e.title_id = t.id
                AND e.season   = m.parsed_season
                AND e.episode  = m.parsed_episode
              WHERE m.title_id IS NOT NULL
                AND m.missing = 0
              ORDER BY t.title, m.parsed_season, m.parsed_episode",
        )
        .map_err(to_string_err)?;

    let rows = stmt
        .query_map([], |r| {
            Ok(NfoTarget {
                path: r.get(0)?,
                title_id: r.get(1)?,
                kind: r.get(2)?,
                title: r.get(3)?,
                year: r.get(4)?,
                overview: r.get(5)?,
                genres: r.get(6)?,
                runtime_mins: r.get(7)?,
                rating: r.get(8)?,
                imdb_id: r.get(9)?,
                tmdb_id: r.get(10)?,
                season: r.get(11)?,
                episode: r.get(12)?,
                episode_name: r.get(13)?,
                episode_overview: r.get(14)?,
                episode_runtime: r.get(15)?,
            })
        })
        .map_err(to_string_err)?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_string_err)
}

#[derive(Serialize, Default)]
pub struct WriteReport {
    pub written: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

/// Write NFO files beside their videos.
///
/// `overwrite` defaults to false and that matters: an NFO already on disk was
/// very likely put there by MediaElch or tinyMediaManager, with fields this app
/// does not model. Replacing it wholesale would discard someone else's work,
/// so an existing file is skipped unless replacing it is asked for explicitly.
#[tauri::command]
pub fn write_nfo(exports: Vec<NfoExport>, overwrite: bool) -> Result<WriteReport, String> {
    let mut report = WriteReport::default();

    for export in exports {
        let video = Path::new(&export.video_path);
        let Some(stem) = video.file_stem() else {
            report
                .errors
                .push(format!("no filename in {}", export.video_path));
            continue;
        };

        let target = if export.kind == "tvshow" {
            match show_nfo_target(video) {
                Some(path) => path,
                None => {
                    report
                        .errors
                        .push(format!("no folder for {}", export.video_path));
                    continue;
                }
            }
        } else {
            let mut name = stem.to_os_string();
            name.push(".nfo");
            video.with_file_name(name)
        };

        if target.exists() && !overwrite {
            report.skipped += 1;
            continue;
        }

        match std::fs::write(&target, render(&export)) {
            Ok(()) => report.written += 1,
            // Read-only shares are ordinary, not exceptional. Report which
            // file and carry on rather than abandoning the whole export.
            Err(e) => report
                .errors
                .push(format!("{}: {}", target.display(), to_string_err(e))),
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_modern_uniqueid() {
        let raw = r#"<?xml version="1.0"?>
            <movie>
              <title>Blade Runner 2049</title>
              <year>2017</year>
              <uniqueid type="tmdb" default="true">335984</uniqueid>
              <uniqueid type="imdb">tt1856101</uniqueid>
            </movie>"#;
        let nfo = parse_nfo(raw, "x.nfo").expect("should parse");
        assert_eq!(nfo.kind, NfoKind::Movie);
        assert_eq!(nfo.title.as_deref(), Some("Blade Runner 2049"));
        assert_eq!(nfo.year, Some(2017));
        assert_eq!(nfo.ids.tmdb.as_deref(), Some("335984"));
        assert_eq!(nfo.ids.imdb.as_deref(), Some("tt1856101"));
    }

    #[test]
    fn reads_legacy_elements_and_premiered() {
        let raw = r#"<tvshow>
              <title>Severance</title>
              <premiered>2022-02-18</premiered>
              <tmdbid>95396</tmdbid>
            </tvshow>"#;
        let nfo = parse_nfo(raw, "x.nfo").expect("should parse");
        assert_eq!(nfo.kind, NfoKind::Tvshow);
        assert_eq!(nfo.year, Some(2022));
        assert_eq!(nfo.ids.tmdb.as_deref(), Some("95396"));
    }

    #[test]
    fn bare_url_is_kodis_oldest_convention() {
        let nfo = parse_nfo("https://www.themoviedb.org/movie/335984-blade-runner-2049", "x")
            .expect("should parse");
        assert_eq!(nfo.kind, NfoKind::Url);
        assert_eq!(nfo.ids.tmdb.as_deref(), Some("335984"));

        let nfo = parse_nfo("tt1856101", "x").expect("should parse");
        assert_eq!(nfo.ids.imdb.as_deref(), Some("tt1856101"));
    }

    #[test]
    fn rejects_ids_that_are_not_ids() {
        // A producer bug that would otherwise send the matcher somewhere random.
        let raw = r#"<movie>
              <title>Something</title>
              <uniqueid type="imdb">not-an-id</uniqueid>
              <uniqueid type="tmdb">abc</uniqueid>
            </movie>"#;
        let nfo = parse_nfo(raw, "x.nfo").expect("should parse");
        assert!(nfo.ids.is_empty());
        assert_eq!(nfo.title.as_deref(), Some("Something"));
    }

    #[test]
    fn ignores_unrelated_xml() {
        assert!(parse_nfo("<rss><channel><title>Not an NFO</title></channel></rss>", "x").is_none());
    }

    #[test]
    fn episode_keeps_its_numbers() {
        let raw = r#"<episodedetails>
              <title>Good News About Hell</title>
              <showtitle>Severance</showtitle>
              <season>1</season>
              <episode>1</episode>
            </episodedetails>"#;
        let nfo = parse_nfo(raw, "x.nfo").expect("should parse");
        assert_eq!(nfo.kind, NfoKind::Episode);
        assert_eq!(nfo.season, Some(1));
        assert_eq!(nfo.episode, Some(1));
    }

    /// tinyMediaManager writes `<set>` for collections and `<actor>` for cast,
    /// both of which contain their own `<name>` and sometimes `<title>`. Taking
    /// one of those as the film's title would search the provider for the
    /// collection or an actor.
    #[test]
    fn ignores_titles_belonging_to_nested_elements() {
        let raw = r#"<movie>
              <set><name>Blade Runner Collection</name><title>Collection</title></set>
              <title>Blade Runner 2049</title>
              <actor><name>Ryan Gosling</name></actor>
              <uniqueid type="tmdb">335984</uniqueid>
            </movie>"#;
        let nfo = parse_nfo(raw, "x.nfo").expect("should parse");
        assert_eq!(nfo.title.as_deref(), Some("Blade Runner 2049"));
        assert_eq!(nfo.ids.tmdb.as_deref(), Some("335984"));
    }

    /// The bug the round-trip test caught: an entity reference arrives as its
    /// own event, so reading only the first text run truncated the value.
    #[test]
    fn entities_do_not_truncate_text() {
        let raw = r#"<movie>
              <title>Fish &amp; Chips &#38; Peas</title>
              <uniqueid type="tmdb">7</uniqueid>
            </movie>"#;
        let nfo = parse_nfo(raw, "x.nfo").expect("should parse");
        assert_eq!(nfo.title.as_deref(), Some("Fish & Chips & Peas"));
    }

    #[test]
    fn season_folders_are_recognised_but_show_names_are_not() {
        assert!(is_season_folder("Season 01"));
        assert!(is_season_folder("season 1"));
        assert!(is_season_folder("Specials"));
        assert!(is_season_folder("S01"));
        // The trap: a show whose name starts with "s".
        assert!(!is_season_folder("Severance"));
        assert!(!is_season_folder("Succession"));
        assert!(!is_season_folder(""));
    }

    /// `Show/Season 01/Episode.mkv` must put tvshow.nfo in `Show/`, not in the
    /// season folder where every other tool would ignore it.
    #[test]
    fn show_nfo_skips_the_season_folder() {
        let target = show_nfo_target(Path::new("/media/Severance/Season 01/E01.mkv"))
            .expect("should resolve");
        assert!(target.ends_with("Severance/tvshow.nfo"), "{target:?}");

        let flat =
            show_nfo_target(Path::new("/media/Severance/E01.mkv")).expect("should resolve");
        assert!(flat.ends_with("Severance/tvshow.nfo"), "{flat:?}");
    }

    #[test]
    fn round_trips_through_render() {
        let export = NfoExport {
            video_path: "C:/x/Movie.mkv".into(),
            kind: "movie".into(),
            title: "Fish & Chips <2>".into(),
            original_title: None,
            year: Some(1999),
            plot: None,
            runtime_mins: Some(100),
            rating: Some(7.25),
            genres: vec!["Drama".into()],
            season: None,
            episode: None,
            tmdb_id: Some("42".into()),
            imdb_id: None,
        };
        let rendered = render(&export);
        let nfo = parse_nfo(&rendered, "x.nfo").expect("should parse");
        assert_eq!(nfo.title.as_deref(), Some("Fish & Chips <2>"));
        assert_eq!(nfo.year, Some(1999));
        assert_eq!(nfo.ids.tmdb.as_deref(), Some("42"));
    }
}
