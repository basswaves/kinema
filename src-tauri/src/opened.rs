//! A video handed to Kinema from outside: named on the command line (a file
//! opened from the file manager with Kinema, a file association, a file
//! dropped on the shortcut), passed on by a second Kinema started that way,
//! or dropped on the window.
//!
//! The file plays whether or not a library folder holds it. One in the library
//! plays as that library file — its resume point, its languages, Skip intro —
//! and anything else as a video of its own, resumed by path and size
//! (`playback::get_loose_progress`).
//!
//! When Kinema was started for the file, the page closes it again once the
//! file ends or Back is pressed (LOCAL-MEDIA.md, owner's decision 2); when it
//! was already running, it goes back to where it was.

use crate::library::Db;
use crate::util::to_string_err;
use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The event a second Kinema's file arrives on, for the page (`opened.ts`).
/// Desktop only: Android keeps one Kinema by itself and has no second start.
#[cfg(desktop)]
pub const EVENT: &str = "open-video";

/// The file Kinema was started for, until the page has taken it.
#[derive(Default)]
pub struct AtLaunch(pub Mutex<Option<PathBuf>>);

#[derive(Serialize, Clone)]
pub struct Opened {
    pub path: String,
    /// Kinema was started for this file, so it closes when the file is done.
    pub launched: bool,
    /// When this Kinema started (ms since 1970), for the log's "first frame
    /// after starting" — how long a double-click takes to become a picture.
    pub started_ms: u64,
}

/// When `run` began, set once by `mark_start`.
static STARTED_MS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

/// Note the moment Kinema started; the first call wins.
pub fn mark_start() {
    let _ = STARTED_MS.get_or_init(crate::util::now_millis);
}

pub fn started_ms() -> u64 {
    STARTED_MS.get().copied().unwrap_or(0)
}

/// The playable video among a command line's arguments: the first that is one.
/// Relative paths are taken from `cwd`, the folder the command was given in.
/// Switches (`-…`, `/…` that is not a path) are passed over, as Windows and
/// the WebView sometimes add their own: they are not playable files.
pub fn from_args<I>(args: I, cwd: &Path) -> Option<PathBuf>
where
    I: IntoIterator<Item = OsString>,
{
    args.into_iter()
        .skip(1)
        .map(|a| {
            let p = PathBuf::from(a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        // A flag is skipped by not being a playable file, not by its dash: a
        // video may be called "-clip.mkv".
        .find_map(|p| playable(&p))
}

/// What to play for `path`, if anything: a video file as it is; a Blu-ray
/// folder, or its `BDMV` folder, as the disc (`disc.rs`). Checked by the
/// extension the library scans for, not by the stricter rules the scan adds
/// (a `-trailer` opened on purpose is still played).
pub fn playable(path: &Path) -> Option<PathBuf> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.is_file() {
        return crate::scanner::has_video_extension(path).then(|| path.to_path_buf());
    }
    let named_bdmv = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(crate::disc::is_bdmv_name);
    let disc = if named_bdmv { path.parent()? } else { path };
    crate::disc::disc_folder(disc).map(|_| disc.to_path_buf())
}

/// Take the file Kinema was started for. Once: a page reloaded later must not
/// play it again.
#[tauri::command]
pub fn opened_at_launch(state: tauri::State<AtLaunch>) -> Option<Opened> {
    let path = state.0.lock().ok()?.take()?;
    Some(Opened { path: path.to_string_lossy().into_owned(), launched: true, started_ms: started_ms() })
}

/// The first playable video among files dropped on the window.
#[tauri::command]
pub fn playable_path(paths: Vec<String>) -> Option<String> {
    paths
        .iter()
        .find_map(|p| playable(Path::new(p)))
        .map(|p| p.to_string_lossy().into_owned())
}

/// The videos either side of one in its own folder, for the player's
/// previous/next on a video played from outside the library.
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct FolderNeighbours {
    pub prev: Option<String>,
    pub next: Option<String>,
}

/// The video files beside `path`, in the order a file manager lists them.
/// Read when the video starts, off the main thread: the folder may be on a
/// slow share, and nothing waits on it but the two buttons.
#[tauri::command]
pub async fn folder_neighbours(path: String) -> FolderNeighbours {
    tauri::async_runtime::spawn_blocking(move || neighbours_in_folder(Path::new(&path)))
        .await
        .unwrap_or_default()
}

fn neighbours_in_folder(path: &Path) -> FolderNeighbours {
    let (Some(dir), Some(own)) = (path.parent(), path.file_name()) else {
        return FolderNeighbours::default();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return FolderNeighbours::default();
    };
    let mut names: Vec<String> = entries
        .flatten()
        // The listing's own file type, so a folder on a share costs no request
        // per file; a link is followed to see what it points at.
        .filter(|e| match e.file_type() {
            Ok(t) if t.is_symlink() => e.path().is_file(),
            Ok(t) => t.is_file(),
            Err(_) => false,
        })
        .filter(|e| crate::scanner::has_video_extension(&e.path()))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    let own = own.to_string_lossy();
    let same = |n: &String| if cfg!(windows) { n.eq_ignore_ascii_case(&own) } else { *n == own };
    let Some(at) = names.iter().position(same) else {
        return FolderNeighbours::default();
    };
    let full = |i: usize| names.get(i).map(|n| dir.join(n).to_string_lossy().into_owned());
    FolderNeighbours { prev: at.checked_sub(1).and_then(full), next: full(at + 1) }
}

/// Names compared as a file manager does: runs of digits by their value
/// ("Part 2" before "Part 10"), letters without case.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    let digits = |it: &mut std::iter::Peekable<std::str::Chars>| {
        let mut run = String::new();
        while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
            run.push(c);
            it.next();
        }
        run
    };
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let (m, n) = (digits(&mut x), digits(&mut y));
                let (m, n) = (m.trim_start_matches('0'), n.trim_start_matches('0'));
                let by_value = m.len().cmp(&n.len()).then_with(|| m.cmp(n));
                if by_value != Ordering::Equal {
                    return by_value;
                }
            }
            (Some(c), Some(d)) => {
                let by_letter = c.to_lowercase().cmp(d.to_lowercase());
                if by_letter != Ordering::Equal {
                    return by_letter;
                }
                x.next();
                y.next();
            }
        }
    }
}

/// A library file, to play as itself.
#[derive(Serialize, Debug, PartialEq)]
pub struct LibraryFile {
    pub file_id: i64,
    pub title_id: Option<i64>,
    pub title: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub episode_name: Option<String>,
}

/// The library's row for `path`, if a library folder holds it.
#[tauri::command]
pub fn library_file(db: tauri::State<Db>, path: String) -> Result<Option<LibraryFile>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    find_library_file(&conn, &path).map_err(to_string_err)
}

fn find_library_file(
    conn: &rusqlite::Connection,
    path: &str,
) -> rusqlite::Result<Option<LibraryFile>> {
    // Windows does not care about case in a path, and the file manager does
    // not always give it as the scan found it. Exact first, which the index
    // answers; the other only where the system ignores case.
    let sql = |compare: &str| {
        format!(
            "SELECT m.id, t.id, t.title, m.parsed_season, m.parsed_episode, e.name
               FROM media_files m
               LEFT JOIN titles t ON t.id = m.title_id
               LEFT JOIN episodes e ON e.title_id = m.title_id
                                   AND e.season = m.parsed_season
                                   AND e.episode = m.parsed_episode
                                   AND t.kind = 'series'
              WHERE {compare} AND m.missing = 0
              ORDER BY m.id LIMIT 1"
        )
    };
    let read = |r: &rusqlite::Row| {
        let title_id: Option<i64> = r.get(1)?;
        Ok(LibraryFile {
            file_id: r.get(0)?,
            title_id,
            title: r.get(2)?,
            // Season and episode only mean something on a matched series.
            season: if title_id.is_some() { r.get(3)? } else { None },
            episode: if title_id.is_some() { r.get(4)? } else { None },
            episode_name: r.get(5)?,
        })
    };
    let found = conn.query_row(&sql("m.path = ?1"), [path], read);
    let found = match found {
        Err(rusqlite::Error::QueryReturnedNoRows) if cfg!(windows) => {
            conn.query_row(&sql("m.path = ?1 COLLATE NOCASE"), [path], read)
        }
        other => other,
    };
    match found {
        Ok(file) => Ok(Some(file)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kinema-opened-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_first_video_on_the_command_line_is_taken() {
        let dir = scratch("args");
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        std::fs::write(dir.join("A film.mkv"), b"x").unwrap();
        std::fs::write(dir.join("-clip.mkv"), b"x").unwrap();
        let args = ["kinema.exe", "--flag", "notes.txt", "A film.mkv", "missing.mkv"]
            .map(OsString::from);
        assert_eq!(from_args(args, &dir), Some(dir.join("A film.mkv")));
        let args = ["kinema.exe", "--flag", "-clip.mkv"].map(OsString::from);
        assert_eq!(from_args(args, &dir), Some(dir.join("-clip.mkv")));
        // The program's own name is never the file, even when it is a video's.
        assert_eq!(from_args([OsString::from(dir.join("A film.mkv"))], &dir), None);
        assert_eq!(from_args(["kinema.exe"].map(OsString::from), &dir), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_videos_either_side_are_in_file_manager_order() {
        let dir = scratch("folder");
        for name in ["Part 10.mkv", "part 2.mp4", "Part 1.mkv", "notes.txt", "Part 3.srt"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        std::fs::create_dir_all(dir.join("Part 5.mkv")).unwrap();
        let got = neighbours_in_folder(&dir.join("part 2.mp4"));
        assert_eq!(got.prev, Some(dir.join("Part 1.mkv").to_string_lossy().into_owned()));
        assert_eq!(got.next, Some(dir.join("Part 10.mkv").to_string_lossy().into_owned()));
        let first = neighbours_in_folder(&dir.join("Part 1.mkv"));
        assert_eq!(first.prev, None);
        let last = neighbours_in_folder(&dir.join("Part 10.mkv"));
        assert_eq!(last.next, None);
        // A file that is not there has no neighbours, rather than a guess.
        assert_eq!(neighbours_in_folder(&dir.join("gone.mkv")), FolderNeighbours::default());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn names_compare_by_number_value_and_without_case() {
        use std::cmp::Ordering::*;
        assert_eq!(natural_cmp("Part 2", "Part 10"), Less);
        assert_eq!(natural_cmp("part 2", "Part 1"), Greater);
        assert_eq!(natural_cmp("Clip 007", "Clip 7b"), Less);
        assert_eq!(natural_cmp("a", "a1"), Less);
    }

    #[test]
    fn a_blu_ray_folder_plays_as_the_disc_from_itself_or_its_bdmv() {
        let dir = scratch("disc");
        let disc = dir.join("A disc");
        let stream = disc.join("BDMV").join("STREAM");
        std::fs::create_dir_all(&stream).unwrap();
        std::fs::write(disc.join("BDMV").join("index.bdmv"), b"x").unwrap();
        std::fs::write(stream.join("00800.m2ts"), vec![0u8; 64]).unwrap();
        assert_eq!(playable(&disc), Some(disc.clone()));
        assert_eq!(playable(&disc.join("BDMV")), Some(disc.clone()));
        assert_eq!(playable(&dir), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_library_file_is_found_by_its_path() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'D:/TV', 'tv', 0);
             INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at)
                  VALUES (7, 'series', 'tmdb', '1', 'A show', 0);
             INSERT INTO episodes (title_id, season, episode, name) VALUES (7, 1, 2, 'The second');
             INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension, size_bytes,
                    modified_at, first_seen_at, last_seen_at, parsed_season, parsed_episode, title_id)
                  VALUES (3, 1, 'D:/TV/A show/S01E02.mkv', 'D:/TV/A show', 'S01E02.mkv', 'mkv', 1, 0, 0, 0, 1, 2, 7);",
        )
        .unwrap();
        let found = find_library_file(&conn, "D:/TV/A show/S01E02.mkv").unwrap().unwrap();
        assert_eq!(
            found,
            LibraryFile {
                file_id: 3,
                title_id: Some(7),
                title: Some("A show".into()),
                season: Some(1),
                episode: Some(2),
                episode_name: Some("The second".into()),
            }
        );
        let other_case = find_library_file(&conn, "d:/tv/a show/s01e02.mkv").unwrap();
        assert_eq!(other_case.is_some(), cfg!(windows));
        assert!(find_library_file(&conn, "D:/TV/Elsewhere.mkv").unwrap().is_none());
    }
}
