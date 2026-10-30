//! Pictures already in the library, and a frame for a title with none.
//!
//! **Pictures beside the files.** Kodi, Jellyfin and tinyMediaManager leave a
//! film's poster and backdrop beside it — `poster.jpg`, `folder.jpg`,
//! `fanart.jpg`, `<file name>-poster.jpg`, and Plex's `<file name>.jpg` —
//! and a show's in its folder. Where
//! one is there it is used, and TMDB's picture only fills in what is missing
//! (the owner's choice, 2026-10-24: whoever put a picture there chose it).
//! Read, never written, like every sidecar.
//!
//! A name of the folder's own (`poster.jpg`) counts only where the folder
//! holds nothing but this title — a `poster.jpg` in a folder of fifty films
//! belongs to none of them. A name carrying the file's (`Film-poster.jpg`)
//! counts wherever it is. Season pictures are not read: no screen shows a
//! season's picture yet.
//!
//! The page may show pictures only from the artwork folder (GOTCHAS, Tauri),
//! so each one found is copied there as `local-<title>-<kind>-<time>.<ext>`;
//! the time in the name makes a changed picture a new address, which the
//! webview has not cached. Found after every scan, so a picture added or
//! removed is picked up by the next one. A folder that cannot be read (a share
//! that is off) changes nothing: what was found before stays.
//!
//! **A frame for a title kept without a match** (`provider = 'local'`) with no
//! picture beside it: the Videos frame-taking (`videos::take_in_turn`), wider,
//! from its first file. Not on Android, which has no mpv to take one.

use crate::files;
use crate::library::Db;
use crate::util::to_string_err;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Kept in the artwork folder, the one the page may load pictures from.
const DIR: &str = "artwork";

/// The largest picture copied. Posters and fanart are a few MB at most.
const MAX_BYTES: u64 = 16 << 20;

/// How wide the frame for a title is: it is the detail page's backdrop too.
const TITLE_FRAME_WIDTH: u32 = 1280;

/// The names a poster goes by, without extension, in a folder of its own.
const POSTER_NAMES: [&str; 3] = ["poster", "folder", "cover"];
/// The same for a backdrop.
const BACKDROP_NAMES: [&str; 3] = ["fanart", "backdrop", "background"];
/// After the file's own name: `Film (2001)-poster.jpg`.
const POSTER_SUFFIXES: [&str; 2] = ["-poster", "-cover"];
const BACKDROP_SUFFIXES: [&str; 2] = ["-fanart", "-backdrop"];
const EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Poster,
    Backdrop,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Poster => "poster",
            Kind::Backdrop => "backdrop",
        }
    }
}

#[derive(Serialize, Default, Debug)]
pub struct LocalPictures {
    /// Pictures beside the files now in use.
    pub found: usize,
    /// Frames taken this time for titles kept without a match.
    pub frames: usize,
}

/// One file of a title, as the pass needs it.
struct File {
    id: i64,
    dir: String,
    name: String,
    season: Option<i64>,
    episode: Option<i64>,
    path: String,
}

/// What a title's row in `local_art` holds.
#[derive(Clone)]
struct Row {
    source: String,
    size: i64,
    modified: i64,
    local_path: String,
}

/// A picture found beside the files.
#[derive(Debug, PartialEq)]
struct Found {
    path: PathBuf,
    name: String,
}

fn parent_of(dir: &str) -> Option<&str> {
    let trimmed = dir.trim_end_matches(['/', '\\']);
    let (parent, _) = trimmed.rsplit_once(['/', '\\'])?;
    (!parent.is_empty()).then_some(parent)
}

fn last_part(dir: &str) -> &str {
    let trimmed = dir.trim_end_matches(['/', '\\']);
    trimmed.rsplit_once(['/', '\\']).map_or(trimmed, |(_, name)| name)
}

/// Whether a folder's name says it holds one season: `Season 1`, `S01`,
/// `Staffel 2`, `Specials`.
fn is_season_folder(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    if lower == "specials" {
        return true;
    }
    for prefix in ["season", "series", "staffel", "saison", "temporada", "stagione", "sezon", "s"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let digits = rest.trim_start_matches([' ', '.', '_', '-']);
            if !digits.is_empty() && digits.len() <= 4 && digits.chars().all(|c| c.is_ascii_digit()) {
                return true;
            }
        }
    }
    false
}

/// Whether `dir` is `root` or inside it, whichever separator either uses.
fn is_within(dir: &str, root: &str) -> bool {
    let root = root.trim_end_matches(['/', '\\']);
    dir == root
        || dir
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with(['/', '\\']))
}

/// A show's folder: where most of its episodes are, one up from a season folder.
fn show_folder(files: &[File]) -> Option<String> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for f in files {
        let dir = f.dir.as_str();
        let show = if is_season_folder(last_part(dir)) {
            parent_of(dir).unwrap_or(dir)
        } else {
            dir
        };
        *counts.entry(show).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0)))
        .map(|(dir, _)| dir.to_string())
}

/// The file's name without its extension.
fn stem(name: &str) -> &str {
    name.rsplit_once('.').map_or(name, |(s, _)| s)
}

/// The picture for `kind` among a folder's file names (lower case → real path),
/// best name first: the file's own names, then the folder's where it may.
/// `bare`: a picture named exactly like the video (`Film (2001).jpg`) is its
/// poster, as Plex reads it — for a film only: beside an episode the same
/// name is that episode's still (Kodi, Jellyfin), never the show's poster.
fn pick(
    listing: &HashMap<String, PathBuf>,
    kind: Kind,
    stems: &[&str],
    folder_names: bool,
    bare: bool,
) -> Option<Found> {
    let (suffixes, names): (&[&str], &[&str]) = match kind {
        Kind::Poster => (&POSTER_SUFFIXES, &POSTER_NAMES),
        Kind::Backdrop => (&BACKDROP_SUFFIXES, &BACKDROP_NAMES),
    };
    let mut wanted: Vec<String> = Vec::new();
    for s in stems {
        for suffix in suffixes {
            wanted.push(format!("{}{suffix}", s.to_lowercase()));
        }
    }
    if bare && matches!(kind, Kind::Poster) {
        wanted.extend(stems.iter().map(|s| s.to_lowercase()));
    }
    if folder_names {
        wanted.extend(names.iter().map(|n| n.to_string()));
    }
    for base in wanted {
        for ext in EXTENSIONS {
            let name = format!("{base}.{ext}");
            if let Some(path) = listing.get(&name) {
                return Some(Found { path: path.clone(), name });
            }
        }
    }
    None
}

/// A folder's files by lower-case name; `None` if it cannot be read now.
fn list(dir: &str) -> Option<HashMap<String, PathBuf>> {
    let entries = files::read_dir(Path::new(dir)).ok()?;
    Some(
        entries
            .into_iter()
            .filter(|(_, is_dir)| !is_dir)
            .filter_map(|(path, _)| {
                let name = path.file_name()?.to_str()?.to_lowercase();
                Some((name, path))
            })
            .collect(),
    )
}

/// Whether the bytes are a picture the page can show.
fn is_picture(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(b"\x89PNG")
        || (bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

/// What one title's folders hold. `None` for a kind means nothing there;
/// the outer `None` means a folder could not be read, so nothing is known.
struct Look {
    poster: Option<Found>,
    backdrop: Option<Found>,
}

/// Look beside a title's files. `owners` is, for every folder with library
/// files in it, the titles those files belong to (`0` for none).
fn look(
    is_series: bool,
    files: &[File],
    owners: &HashMap<String, HashSet<i64>>,
    title_id: i64,
    lister: &mut dyn FnMut(&str) -> Option<HashMap<String, PathBuf>>,
) -> Option<Look> {
    let only_this = |dir: &str, inside: bool| {
        owners
            .iter()
            .filter(|(d, _)| if inside { is_within(d, dir) } else { d.as_str() == dir })
            .all(|(_, ids)| ids.len() == 1 && ids.contains(&title_id))
    };
    if is_series {
        let show = show_folder(files)?;
        let listing = lister(&show)?;
        let own = only_this(&show, true);
        let name = last_part(&show).to_string();
        let stems = [name.as_str()];
        return Some(Look {
            poster: pick(&listing, Kind::Poster, &stems, own, false),
            backdrop: pick(&listing, Kind::Backdrop, &stems, own, false),
        });
    }
    let mut result = Look { poster: None, backdrop: None };
    let mut dirs: Vec<&str> = files.iter().map(|f| f.dir.as_str()).collect();
    dirs.sort_unstable();
    dirs.dedup();
    for dir in dirs {
        let listing = lister(dir)?;
        let stems: Vec<&str> = files.iter().filter(|f| f.dir == dir).map(|f| stem(&f.name)).collect();
        let own = only_this(dir, false);
        if result.poster.is_none() {
            result.poster = pick(&listing, Kind::Poster, &stems, own, true);
        }
        if result.backdrop.is_none() {
            result.backdrop = pick(&listing, Kind::Backdrop, &stems, own, true);
        }
    }
    Some(result)
}

/// Copy a found picture into the artwork folder unless the row already has
/// this one. Returns the row to keep, or `None` if it could not be copied.
fn bring_in(
    base: &Path,
    title_id: i64,
    kind: Kind,
    found: &Found,
    before: Option<&Row>,
) -> Option<Row> {
    let meta = files::metadata(&found.path).ok()?;
    if meta.len > MAX_BYTES {
        return None;
    }
    let source = found.path.to_string_lossy().into_owned();
    let (size, modified) = (meta.len as i64, meta.modified_secs());
    if let Some(row) = before {
        if row.source == source
            && row.size == size
            && row.modified == modified
            && base.join(&row.local_path).is_file()
        {
            return Some(row.clone());
        }
    }
    let bytes = files::read(&found.path).ok()?;
    if !is_picture(&bytes) {
        crate::log!("local pictures: {source} is not a picture the page can show");
        return None;
    }
    let ext = found.name.rsplit_once('.').map_or("jpg", |(_, e)| e);
    let name = format!("local-{title_id}-{}-{modified}.{ext}", kind.name());
    let dir = base.join(DIR);
    std::fs::create_dir_all(&dir).ok()?;
    if let Err(e) = std::fs::write(dir.join(&name), &bytes) {
        crate::log!("local pictures: writing {name} failed: {e}");
        return None;
    }
    Some(Row {
        source,
        size,
        modified,
        local_path: format!("{DIR}{}{name}", std::path::MAIN_SEPARATOR),
    })
}

/// Everything the pass reads from the library, in one go under the lock.
struct Library {
    titles: Vec<(i64, bool, bool)>,
    files: HashMap<i64, Vec<File>>,
    owners: HashMap<String, HashSet<i64>>,
    rows: HashMap<(i64, String), Row>,
}

fn read_library(conn: &Connection) -> rusqlite::Result<Library> {
    let titles = conn
        .prepare("SELECT id, kind = 'series', provider = 'local' FROM titles")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut files: HashMap<i64, Vec<File>> = HashMap::new();
    let mut owners: HashMap<String, HashSet<i64>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT id, title_id, parent_dir, file_name, parsed_season, parsed_episode, path
           FROM media_files WHERE missing = 0 AND match_status <> 'ignored'",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, Option<i64>>(1)?,
            File {
                id: r.get(0)?,
                dir: r.get(2)?,
                name: r.get(3)?,
                season: r.get(4)?,
                episode: r.get(5)?,
                path: r.get(6)?,
            },
        ))
    })?;
    for row in rows {
        let (title, file) = row?;
        owners.entry(file.dir.clone()).or_default().insert(title.unwrap_or(0));
        if let Some(t) = title {
            files.entry(t).or_default().push(file);
        }
    }
    let rows = conn
        .prepare("SELECT title_id, kind, source, size, modified, local_path FROM local_art")?
        .query_map([], |r| {
            Ok((
                (r.get(0)?, r.get(1)?),
                Row { source: r.get(2)?, size: r.get(3)?, modified: r.get(4)?, local_path: r.get(5)? },
            ))
        })?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    Ok(Library { titles, files, owners, rows })
}

/// What changes for one title and kind: a row to keep or none.
type Outcome = ((i64, String), Option<Row>);

/// Look beside every title's files and bring in what is there. Returns what
/// each title and kind should hold now; a title not in the answer is left as
/// it is (its folder could not be read, or it has no files here now).
fn find_all(base: &Path, library: &Library, found: &mut usize) -> Vec<Outcome> {
    let mut listed: HashMap<String, Option<HashMap<String, PathBuf>>> = HashMap::new();
    let mut lister = |dir: &str| -> Option<HashMap<String, PathBuf>> {
        listed.entry(dir.to_string()).or_insert_with(|| list(dir)).clone()
    };
    let mut outcomes = Vec::new();
    for &(title_id, is_series, _) in &library.titles {
        let Some(files) = library.files.get(&title_id) else { continue };
        let Some(seen) = look(is_series, files, &library.owners, title_id, &mut lister) else {
            continue;
        };
        for (kind, picked) in [(Kind::Poster, seen.poster), (Kind::Backdrop, seen.backdrop)] {
            let key = (title_id, kind.name().to_string());
            let before = library.rows.get(&key).filter(|r| r.source != FRAME);
            let row = picked.and_then(|p| bring_in(base, title_id, kind, &p, before));
            if row.is_some() {
                *found += 1;
            }
            outcomes.push((key, row));
        }
    }
    outcomes
}

/// What a frame's row says in `source`.
const FRAME: &str = "frame";

fn frame_name(title_id: i64) -> String {
    format!("local-{title_id}-frame.jpg")
}

fn write_rows(conn: &mut Connection, outcomes: &[Outcome]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut put = tx.prepare(
            "INSERT INTO local_art (title_id, kind, source, size, modified, local_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(title_id, kind) DO UPDATE SET source = excluded.source,
                 size = excluded.size, modified = excluded.modified,
                 local_path = excluded.local_path",
        )?;
        let mut drop = tx.prepare("DELETE FROM local_art WHERE title_id = ?1 AND kind = ?2")?;
        for ((title_id, kind), row) in outcomes {
            match row {
                Some(r) => {
                    put.execute(params![title_id, kind, r.source, r.size, r.modified, r.local_path])?;
                }
                None => {
                    drop.execute(params![title_id, kind])?;
                }
            }
        }
    }
    tx.commit()
}

/// Remove copies no row points at any more (a picture removed or replaced).
fn tidy(base: &Path, conn: &Connection) -> rusqlite::Result<()> {
    let kept: HashSet<String> = conn
        .prepare("SELECT local_path FROM local_art")?
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(Result::ok)
        .filter_map(|p| p.rsplit(['/', '\\']).next().map(str::to_string))
        .collect();
    if let Ok(entries) = std::fs::read_dir(base.join(DIR)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("local-") && !kept.contains(&name) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// The first file of a title: a film's file, a show's first episode.
fn first_file(files: &[File]) -> Option<&File> {
    files.iter().min_by_key(|f| {
        (f.season.unwrap_or(i64::MAX), f.episode.unwrap_or(i64::MAX), f.id)
    })
}

/// Find the pictures beside every title's files, and take a frame for each
/// title kept without a match that has none. Runs after a scan
/// (`pipeline.ts`), when the library's folders have just been read.
#[tauri::command]
pub async fn find_local_pictures(app: tauri::AppHandle) -> Result<LocalPictures, String> {
    let base = crate::data_dir(&app)?;
    let ffmpeg;
    let library = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        ffmpeg = crate::settings::setting(&conn, crate::ffmpeg::PATH_KEY);
        read_library(&conn).map_err(to_string_err)?
    };

    let mut result = LocalPictures::default();
    // Reading the folders can take a while on a share: not on the async threads.
    let (outcomes, library, found) = {
        let base = base.clone();
        crate::jobs::off_main(move || {
            let mut found = 0;
            let outcomes = find_all(&base, &library, &mut found);
            Ok((outcomes, library, found))
        })
        .await?
    };
    result.found = found;

    // Titles kept without a match with no poster beside them: a frame.
    let has_poster: HashSet<i64> = outcomes
        .iter()
        .filter(|((_, kind), row)| kind == "poster" && row.is_some())
        .map(|((id, _), _)| *id)
        .collect();
    let mut frames: Vec<Outcome> = Vec::new();
    for &(title_id, _, is_local) in &library.titles {
        if !is_local || has_poster.contains(&title_id) {
            continue;
        }
        let Some(file) = library.files.get(&title_id).and_then(|f| first_file(f)) else { continue };
        let target = base.join(DIR).join(frame_name(title_id));
        let fresh = !target.is_file();
        let Some(_) = crate::videos::take_in_turn(
            file.path.clone(),
            target,
            ffmpeg.clone(),
            TITLE_FRAME_WIDTH,
        )
        .await?
        else {
            continue;
        };
        if fresh {
            result.frames += 1;
        }
        let local_path = format!("{DIR}{}{}", std::path::MAIN_SEPARATOR, frame_name(title_id));
        for kind in [Kind::Poster, Kind::Backdrop] {
            let key = (title_id, kind.name().to_string());
            // A backdrop found beside the files stays.
            let kept = outcomes.iter().any(|(k, row)| *k == key && row.is_some());
            if !kept {
                frames.push((
                    key,
                    Some(Row { source: FRAME.into(), size: 0, modified: 0, local_path: local_path.clone() }),
                ));
            }
        }
    }

    let db = app.state::<Db>();
    let mut conn = db.0.lock().map_err(to_string_err)?;
    // A frame is not a picture beside the files: the look above must not drop it.
    let outcomes: Vec<Outcome> = outcomes
        .into_iter()
        .filter(|(key, row)| row.is_some() || !frames.iter().any(|(k, _)| k == key))
        .chain(frames.clone())
        .collect();
    write_rows(&mut conn, &outcomes).map_err(to_string_err)?;
    tidy(&base, &conn).map_err(to_string_err)?;
    if result.found > 0 || result.frames > 0 {
        crate::log!("local pictures: {} beside the files, {} frames taken", result.found, result.frames);
    }
    Ok(result)
}

/// Rewrite paths written on another system to this one's separator, as
/// `artwork::use_this_systems_separator` does for downloads.
pub fn use_this_systems_separator(conn: &Connection) -> rusqlite::Result<usize> {
    let (other, here) = if cfg!(windows) { ("/", "\\") } else { ("\\", "/") };
    conn.execute(
        "UPDATE local_art SET local_path = replace(local_path, ?1, ?2)
          WHERE instr(local_path, ?1) > 0",
        params![other, here],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(id: i64, dir: &str, name: &str) -> File {
        File {
            id,
            dir: dir.into(),
            name: name.into(),
            season: None,
            episode: None,
            path: format!("{dir}/{name}"),
        }
    }

    fn listing(names: &[&str]) -> HashMap<String, PathBuf> {
        names.iter().map(|n| (n.to_lowercase(), PathBuf::from(n))).collect()
    }

    fn owners(pairs: &[(&str, i64)]) -> HashMap<String, HashSet<i64>> {
        let mut map: HashMap<String, HashSet<i64>> = HashMap::new();
        for (dir, id) in pairs {
            map.entry(dir.to_string()).or_default().insert(*id);
        }
        map
    }

    fn found_name(f: &Option<Found>) -> Option<&str> {
        f.as_ref().map(|f| f.name.as_str())
    }

    #[test]
    fn a_film_in_its_own_folder_takes_the_folder_names() {
        let files = [file(1, "D:/Films/Film (2001)", "Film (2001).mkv")];
        let own = owners(&[("D:/Films/Film (2001)", 7)]);
        let mut lister = |_: &str| Some(listing(&["Poster.JPG", "fanart.png", "Film (2001).mkv"]));
        let seen = look(false, &files, &own, 7, &mut lister).expect("read");
        assert_eq!(found_name(&seen.poster), Some("poster.jpg"));
        assert_eq!(found_name(&seen.backdrop), Some("fanart.png"));
    }

    #[test]
    fn a_shared_folder_takes_only_names_carrying_the_file_s() {
        let files = [file(1, "D:/Films", "Film (2001).mkv")];
        let own = owners(&[("D:/Films", 7), ("D:/Films", 8)]);
        let mut lister =
            |_: &str| Some(listing(&["poster.jpg", "fanart.jpg", "film (2001)-poster.jpg"]));
        let seen = look(false, &files, &own, 7, &mut lister).expect("read");
        assert_eq!(found_name(&seen.poster), Some("film (2001)-poster.jpg"));
        assert!(seen.backdrop.is_none(), "fanart.jpg belongs to no one film here");
    }

    #[test]
    fn a_picture_named_like_the_film_is_its_poster_even_in_a_shared_folder() {
        let files = [file(1, "D:/Films", "Some Film [2011].mkv")];
        let own = owners(&[("D:/Films", 7), ("D:/Films", 8)]);
        let mut lister = |_: &str| {
            Some(listing(&["Some Film [2011].mkv", "Some Film [2011].PNG", "Other [2018].jpg"]))
        };
        let seen = look(false, &files, &own, 7, &mut lister).expect("read");
        assert_eq!(found_name(&seen.poster), Some("some film [2011].png"));
        assert!(seen.backdrop.is_none(), "a bare name is a poster, not a backdrop");
    }

    #[test]
    fn a_name_with_poster_in_it_wins_over_the_bare_name() {
        let files = [file(1, "/m", "Film.mkv")];
        let own = owners(&[("/m", 7)]);
        let mut lister = |_: &str| Some(listing(&["Film.jpg", "Film-poster.jpg", "poster.jpg"]));
        let seen = look(false, &files, &own, 7, &mut lister).expect("read");
        assert_eq!(found_name(&seen.poster), Some("film-poster.jpg"));
    }

    #[test]
    fn an_episode_s_own_picture_is_never_the_show_s_poster() {
        let files = [file(1, "/tv/Show/Season 1", "Show S01E01.mkv")];
        let own = owners(&[("/tv/Show/Season 1", 7)]);
        let mut lister = |_: &str| Some(listing(&["Show S01E01.jpg"]));
        let seen = look(true, &files, &own, 7, &mut lister).expect("read");
        assert!(seen.poster.is_none());
    }

    #[test]
    fn an_unmatched_file_beside_a_film_makes_the_folder_shared() {
        let files = [file(1, "D:/Films", "a.mkv")];
        let own = owners(&[("D:/Films", 7), ("D:/Films", 0)]);
        let mut lister = |_: &str| Some(listing(&["folder.jpg"]));
        let seen = look(false, &files, &own, 7, &mut lister).expect("read");
        assert!(seen.poster.is_none());
    }

    #[test]
    fn the_file_s_own_name_wins_over_the_folder_s() {
        let files = [file(1, "/m/Film", "Film.mkv")];
        let own = owners(&[("/m/Film", 7)]);
        let mut lister = |_: &str| Some(listing(&["folder.jpg", "Film-poster.png"]));
        let seen = look(false, &files, &own, 7, &mut lister).expect("read");
        assert_eq!(found_name(&seen.poster), Some("film-poster.png"));
    }

    #[test]
    fn a_show_s_pictures_come_from_above_its_season_folders() {
        let files = [
            file(1, r"\\nas\tv\Show\Season 01", "Show S01E01.mkv"),
            file(2, r"\\nas\tv\Show\Season 02", "Show S02E01.mkv"),
        ];
        let own = owners(&[(r"\\nas\tv\Show\Season 01", 9), (r"\\nas\tv\Show\Season 02", 9)]);
        let mut asked = Vec::new();
        let mut lister = |dir: &str| {
            asked.push(dir.to_string());
            Some(listing(&["poster.jpg", "fanart.jpg", "season01-poster.jpg"]))
        };
        let seen = look(true, &files, &own, 9, &mut lister).expect("read");
        assert_eq!(asked, vec![r"\\nas\tv\Show".to_string()]);
        assert_eq!(found_name(&seen.poster), Some("poster.jpg"));
        assert_eq!(found_name(&seen.backdrop), Some("fanart.jpg"));
    }

    #[test]
    fn a_show_folder_with_another_show_inside_takes_no_folder_names() {
        let files = [file(1, "smb://nas/tv/Show/S01", "e1.mkv")];
        let own = owners(&[("smb://nas/tv/Show/S01", 9), ("smb://nas/tv/Show/Other", 10)]);
        let mut lister = |_: &str| Some(listing(&["poster.jpg", "Show-poster.jpg"]));
        let seen = look(true, &files, &own, 9, &mut lister).expect("read");
        assert_eq!(found_name(&seen.poster), Some("show-poster.jpg"));
    }

    #[test]
    fn a_folder_that_cannot_be_read_says_nothing_is_known() {
        let files = [file(1, "D:/Films/Film", "Film.mkv")];
        let own = owners(&[("D:/Films/Film", 7)]);
        let mut lister = |_: &str| None;
        assert!(look(false, &files, &own, 7, &mut lister).is_none());
    }

    #[test]
    fn season_folders_are_known_by_their_names() {
        for name in ["Season 1", "season01", "S02", "Staffel 3", "Specials", "Series.4"] {
            assert!(is_season_folder(name), "{name}");
        }
        for name in ["Show", "Seasons", "S", "Season One", "2001"] {
            assert!(!is_season_folder(name), "{name}");
        }
    }

    #[test]
    fn parents_and_containment_work_with_either_separator() {
        assert_eq!(parent_of(r"C:\tv\Show\Season 1"), Some(r"C:\tv\Show"));
        assert_eq!(parent_of("/media/tv/Show/S01"), Some("/media/tv/Show"));
        assert_eq!(parent_of("smb://nas/tv/Show/S01"), Some("smb://nas/tv/Show"));
        assert!(is_within(r"C:\tv\Show\S01", r"C:\tv\Show"));
        assert!(is_within("/tv/Show", "/tv/Show/"));
        assert!(!is_within("/tv/Showtime", "/tv/Show"));
    }

    #[test]
    fn only_real_pictures_are_copied() {
        assert!(is_picture(&[0xFF, 0xD8, 0xFF, 0xE0]));
        assert!(is_picture(b"\x89PNG\r\n\x1a\n"));
        assert!(is_picture(b"RIFF\0\0\0\0WEBPVP8 "));
        assert!(!is_picture(b"<html>"));
    }

    /// A real library and a real folder: found, kept, changed and removed.
    #[test]
    fn a_picture_added_changed_and_removed_follows_the_folder() {
        let n = std::process::id();
        let root = std::env::temp_dir().join(format!("kinema-local-art-{n}"));
        let _ = std::fs::remove_dir_all(&root);
        let films = root.join("films").join("Film");
        let data = root.join("data");
        std::fs::create_dir_all(&films).expect("dirs");
        std::fs::create_dir_all(&data).expect("data dir");
        let dir = films.to_string_lossy().into_owned();
        let mut conn = crate::db::open(&data.join("library.db")).expect("open");
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'x', 'movies', 0);
             INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at)
                  VALUES (7, 'movie', 'tmdb', '1', 'Film', 0);",
        )
        .expect("title");
        conn.execute(
            "INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                 size_bytes, modified_at, first_seen_at, last_seen_at, match_status, title_id)
             VALUES (1, 1, ?1, ?2, 'Film.mkv', 'mkv', 1, 0, 0, 0, 'matched', 7)",
            params![format!("{dir}/Film.mkv"), dir],
        )
        .expect("file");

        let pass = |conn: &mut Connection| {
            let library = read_library(conn).expect("read");
            let mut found = 0;
            let outcomes = find_all(&data, &library, &mut found);
            write_rows(conn, &outcomes).expect("write");
            tidy(&data, conn).expect("tidy");
            conn.query_row(
                "SELECT local_path FROM local_art WHERE title_id = 7 AND kind = 'poster'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
        };

        assert_eq!(pass(&mut conn), None, "nothing there yet");
        std::fs::write(films.join("poster.jpg"), [0xFF, 0xD8, 0xFF, 0xE0, 1]).expect("poster");
        let first = pass(&mut conn).expect("found");
        assert!(data.join(&first).is_file());
        assert_eq!(pass(&mut conn), Some(first.clone()), "unchanged: the same copy");

        std::fs::remove_file(films.join("poster.jpg")).expect("remove");
        assert_eq!(pass(&mut conn), None, "removed beside the file, gone here");
        assert!(!data.join(&first).exists(), "and its copy tidied away");

        // A folder that cannot be read leaves what was there.
        std::fs::write(films.join("poster.jpg"), [0xFF, 0xD8, 0xFF, 0xE0, 2]).expect("again");
        let again = pass(&mut conn).expect("found again");
        std::fs::remove_dir_all(&films).expect("gone");
        assert_eq!(pass(&mut conn), Some(again));
        let _ = std::fs::remove_dir_all(&root);
    }
}
