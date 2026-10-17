//! Videos folders (LOCAL-MEDIA.md phase 2): what is neither a film nor a show.
//!
//! A library folder of kind `videos` is scanned like any other, but its files
//! are never parsed or matched — the scanner writes them as
//! `match_status = 'video'` — so they never reach Needs attention, never get a
//! title row and never reach SIMKL, Trakt, TheIntroDB or IntroDB.app, which
//! all start from a title. The page shows them as they lie on disk: the
//! folder's own files, then one group per sub-folder, each in the order a file
//! manager lists them.
//!
//! **Steps through a group** reuse the episode path: `playback::next_episode`
//! and `previous_episode` ask [`adjacent`] for a video, so the player's
//! previous/next, `n`/`p` and Up next work through a sub-folder the way they
//! work through a season, with no second mechanism.
//!
//! **A frame from the file** is each tile's picture. Measured 2026-10-17 on a
//! network share: a second libmpv handle with `vo=image` gives one in 0.65–1 s
//! (ffmpeg took 1.2 s), and libmpv is always there on a desktop while ffmpeg is
//! optional. So libmpv first, ffmpeg if that fails, and otherwise — and always
//! on Android, which has no mpv — the page draws a plain picture.

use crate::library::Db;
use crate::playback::{EpisodeRef, TitlePrefs};
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The library folder kind.
pub const KIND: &str = "videos";


/// One file in a Videos folder, as the page draws it.
#[derive(Serialize)]
pub struct VideoItem {
    pub id: i64,
    pub path: String,
    /// The file's own folder; a group is all the files sharing one.
    pub parent_dir: String,
    pub file_name: String,
    pub modified_at: i64,
    pub position_secs: f64,
    pub duration_secs: Option<f64>,
    pub completed: bool,
    /// The cached frame, when one has been taken.
    pub frame: Option<String>,
}

/// Every file of one Videos folder, the page orders and groups them.
#[tauri::command]
pub fn list_videos(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    root_id: i64,
) -> Result<Vec<VideoItem>, String> {
    let frames = frames_dir(&app)?;
    let conn = db.0.lock().map_err(to_string_err)?;
    videos_of(&conn, Some(root_id), &frames)
}

/// Every video of every Videos folder, for Search.
#[tauri::command]
pub fn list_all_videos(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
) -> Result<Vec<VideoItem>, String> {
    let frames = frames_dir(&app)?;
    let conn = db.0.lock().map_err(to_string_err)?;
    videos_of(&conn, None, &frames)
}

fn videos_of(conn: &Connection, root_id: Option<i64>, frames: &Path) -> Result<Vec<VideoItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.path, m.parent_dir, m.file_name, m.modified_at,
                    COALESCE(p.position_secs, 0), p.duration_secs, COALESCE(p.completed, 0)
               FROM media_files m
               JOIN library_roots r ON r.id = m.root_id
               LEFT JOIN playback_state p ON p.file_id = m.id
              WHERE r.kind = 'videos' AND m.missing = 0
                AND (?1 IS NULL OR m.root_id = ?1)",
        )
        .map_err(to_string_err)?;
    let rows = stmt
        .query_map(params![root_id], |r| {
            let id: i64 = r.get(0)?;
            Ok(VideoItem {
                id,
                path: r.get(1)?,
                parent_dir: r.get(2)?,
                file_name: r.get(3)?,
                modified_at: r.get(4)?,
                position_secs: r.get(5)?,
                duration_secs: r.get(6)?,
                completed: r.get::<_, i64>(7)? != 0,
                frame: cached_frame(frames, id),
            })
        })
        .map_err(to_string_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(to_string_err)
}

/// Whether a file belongs to a Videos folder.
pub fn is_video(conn: &Connection, file_id: i64) -> bool {
    conn.query_row(
        "SELECT r.kind FROM media_files m JOIN library_roots r ON r.id = m.root_id WHERE m.id = ?1",
        params![file_id],
        |r| r.get::<_, String>(0),
    )
    .is_ok_and(|kind| kind == KIND)
}

/// The video either side of `file_id` in its own folder, in file-manager order,
/// shaped as an episode so the player's steps and Up next take it as one.
/// `episode` is its place in the folder, counted from 1; `title` the folder's
/// name; `name` the file's.
pub fn adjacent(conn: &Connection, file_id: i64, forward: bool) -> Result<Option<EpisodeRef>, String> {
    let here: Option<(i64, String)> = conn
        .query_row(
            "SELECT root_id, parent_dir FROM media_files WHERE id = ?1",
            params![file_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(to_string_err)?;
    let Some((root_id, dir)) = here else { return Ok(None) };

    let mut stmt = conn
        .prepare(
            "SELECT id, path, file_name FROM media_files
              WHERE root_id = ?1 AND parent_dir = ?2 AND missing = 0",
        )
        .map_err(to_string_err)?;
    let mut files = stmt
        .query_map(params![root_id, &dir], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(to_string_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_string_err)?;
    files.sort_by(|a, b| crate::opened::natural_cmp(&a.2, &b.2));

    let Some(at) = files.iter().position(|f| f.0 == file_id) else { return Ok(None) };
    let other = if forward { at.checked_add(1) } else { at.checked_sub(1) };
    let Some((index, (id, path, name))) = other.and_then(|i| files.get(i).map(|f| (i, f))) else {
        return Ok(None);
    };
    Ok(Some(EpisodeRef {
        file_id: *id,
        path: path.clone(),
        season: 0,
        episode: index as i64 + 1,
        name: Some(name.clone()),
        title: folder_name(&dir),
        video: true,
    }))
}

/// The last part of a folder path, either separator.
pub fn folder_name(dir: &str) -> String {
    dir.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(dir)
        .to_string()
}

// ---- track choices, per folder --------------------------------------------

fn dir_of(conn: &Connection, file_id: i64) -> Result<Option<String>, String> {
    conn.query_row("SELECT parent_dir FROM media_files WHERE id = ?1", params![file_id], |r| r.get(0))
        .optional()
        .map_err(to_string_err)
}

/// The track choices made for the folder holding `file_id`; a video's
/// counterpart of `get_title_prefs`.
#[tauri::command]
pub fn get_video_prefs(db: tauri::State<Db>, file_id: i64) -> Result<TitlePrefs, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    prefs_for(&conn, file_id)
}

fn prefs_for(conn: &Connection, file_id: i64) -> Result<TitlePrefs, String> {
    let Some(dir) = dir_of(conn, file_id)? else { return Ok(no_prefs()) };
    conn.query_row(
        "SELECT audio_lang, sub_lang, sub_enabled FROM video_prefs WHERE dir = ?1",
        params![dir],
        |r| {
            Ok(TitlePrefs {
                audio_lang: r.get(0)?,
                sub_lang: r.get(1)?,
                sub_enabled: r.get::<_, i64>(2)? != 0,
                chosen: true,
            })
        },
    )
    .optional()
    .map(|found| found.unwrap_or_else(no_prefs))
    .map_err(to_string_err)
}

fn no_prefs() -> TitlePrefs {
    TitlePrefs { audio_lang: None, sub_lang: None, sub_enabled: true, chosen: false }
}

#[tauri::command]
pub fn set_video_prefs(db: tauri::State<Db>, file_id: i64, prefs: TitlePrefs) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    store_prefs(&conn, file_id, &prefs)
}

fn store_prefs(conn: &Connection, file_id: i64, prefs: &TitlePrefs) -> Result<(), String> {
    let Some(dir) = dir_of(conn, file_id)? else { return Ok(()) };
    conn.execute(
        "INSERT INTO video_prefs (dir, audio_lang, sub_lang, sub_enabled, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(dir) DO UPDATE SET
            audio_lang  = excluded.audio_lang,
            sub_lang    = excluded.sub_lang,
            sub_enabled = excluded.sub_enabled,
            updated_at  = excluded.updated_at",
        params![dir, prefs.audio_lang, prefs.sub_lang, prefs.sub_enabled as i64, now_secs()],
    )
    .map_err(to_string_err)?;
    Ok(())
}

// ---- Continue Watching --------------------------------------------------------

/// Part-watched videos for Continue Watching, one card per folder (as a show
/// has one), the most recent first. `kind` is `video`, `title_id` 0, `title`
/// the folder's name and `episode_name` the file's; the picture is the frame.
pub fn continue_items(
    conn: &Connection,
    frames: &Path,
    min_secs: f64,
) -> Result<Vec<crate::playback::ContinueItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.path, m.parent_dir, m.file_name, p.position_secs, p.duration_secs,
                    p.updated_at
               FROM playback_state p
               JOIN media_files m ON m.id = p.file_id
               JOIN library_roots r ON r.id = m.root_id
              WHERE r.kind = 'videos' AND m.missing = 0
                AND p.completed = 0 AND p.position_secs >= ?1
                AND NOT EXISTS (SELECT 1 FROM video_dismissed d
                                 WHERE d.dir = m.parent_dir AND d.dismissed_at >= p.updated_at)
              ORDER BY p.updated_at DESC",
        )
        .map_err(to_string_err)?;
    let rows = stmt
        .query_map(params![min_secs], |r| {
            let id: i64 = r.get(0)?;
            let dir: String = r.get(2)?;
            Ok(crate::playback::ContinueItem {
                file_id: id,
                path: r.get(1)?,
                title_id: 0,
                title: folder_name(&dir),
                kind: "video".into(),
                season: None,
                episode: None,
                episode_name: Some(r.get(3)?),
                position_secs: r.get(4)?,
                duration_secs: r.get(5)?,
                image_url: None,
                image_path: cached_frame(frames, id),
                updated_at: r.get(6)?,
                is_next_up: false,
                video_dir: Some(dir),
            })
        })
        .map_err(to_string_err)?;
    let mut items = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(to_string_err)?;
    let mut seen = std::collections::HashSet::new();
    items.retain(|item| seen.insert(item.video_dir.clone()));
    Ok(items)
}

/// Take a folder's video out of Continue Watching until one of its videos is
/// watched again — the counterpart of `dismiss_continue` for a show.
#[tauri::command]
pub fn dismiss_continue_video(db: tauri::State<Db>, file_id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    let Some(dir) = dir_of(&conn, file_id)? else { return Ok(()) };
    conn.execute(
        "INSERT INTO video_dismissed (dir, dismissed_at) VALUES (?1, ?2)
         ON CONFLICT(dir) DO UPDATE SET dismissed_at = excluded.dismissed_at",
        params![dir, now_secs()],
    )
    .map_err(to_string_err)?;
    Ok(())
}

// ---- a frame from the file ---------------------------------------------------

/// Where frames are kept, under app data. Not the artwork cache: nothing here
/// came from a URL.
fn frames_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir(app)?.join("frames"))
}

fn frame_path(frames: &Path, file_id: i64) -> PathBuf {
    frames.join(format!("{file_id}.jpg"))
}

fn cached_frame(frames: &Path, file_id: i64) -> Option<String> {
    let path = frame_path(frames, file_id);
    path.is_file().then(|| path.to_string_lossy().into_owned())
}

/// Files whose frame could not be taken, this run — asked again next launch,
/// never again in a loop while the page is open.
static FAILED: std::sync::Mutex<Vec<i64>> = std::sync::Mutex::new(Vec::new());

/// One frame at a time: two decoders racing over one share help nobody.
static TAKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A frame from the video, taken now if not yet cached; `None` where none can
/// be taken (the page then draws a plain picture). Waits while a film plays.
#[tauri::command]
pub async fn video_frame(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    file_id: i64,
) -> Result<Option<String>, String> {
    let frames = frames_dir(&app)?;
    if let Some(found) = cached_frame(&frames, file_id) {
        return Ok(Some(found));
    }
    if FAILED.lock().map_err(to_string_err)?.contains(&file_id) {
        return Ok(None);
    }
    let (path, ffmpeg) = {
        let conn = db.0.lock().map_err(to_string_err)?;
        let path: Option<String> = conn
            .query_row("SELECT path FROM media_files WHERE id = ?1", params![file_id], |r| r.get(0))
            .optional()
            .map_err(to_string_err)?;
        (path, crate::settings::setting(&conn, crate::ffmpeg::PATH_KEY))
    };
    let Some(path) = path else { return Ok(None) };

    let _one = TAKING.lock().await;
    crate::jobs::wait_while_playing_async().await;
    let target = frame_path(&frames, file_id);
    let taken = crate::jobs::off_main(move || {
        std::fs::create_dir_all(&frames).map_err(to_string_err)?;
        Ok(take_frame(Path::new(&path), &target, ffmpeg.as_deref()))
    })
    .await?;
    if taken.is_none() {
        FAILED.lock().map_err(to_string_err)?.push(file_id);
    }
    Ok(taken)
}

/// How wide a frame is kept: a tile is never drawn wider than this on a 4K
/// screen at the TV layout's scale, and 480 px keeps each file near 10 KB.
const FRAME_WIDTH: u32 = 480;

/// Where in the file the frame is taken: past an opening title or a fade from
/// black, which a frame at the very start would show.
const FRAME_AT_PERCENT: u32 = 20;

#[cfg(not(target_os = "android"))]
fn take_frame(video: &Path, target: &Path, ffmpeg: Option<&str>) -> Option<String> {
    let started = std::time::Instant::now();
    let how = if mpv_frame::take(video, target).is_some() {
        "libmpv"
    } else if ffmpeg_frame(video, target, ffmpeg) {
        "ffmpeg"
    } else {
        crate::log!("video frame: none could be taken from {}", video.display());
        return None;
    };
    crate::log!("video frame: {how}, {} ms", started.elapsed().as_millis());
    Some(target.to_string_lossy().into_owned())
}

/// Android has no mpv, and a frame there would mean a decoder of its own; the
/// page draws a plain picture instead (the owner's decision 3, round 2).
#[cfg(target_os = "android")]
fn take_frame(_video: &Path, _target: &Path, _ffmpeg: Option<&str>) -> Option<String> {
    None
}

#[cfg(not(target_os = "android"))]
fn ffmpeg_frame(video: &Path, target: &Path, configured: Option<&str>) -> bool {
    let ffmpeg = crate::ffmpeg::resolve(configured);
    if !crate::ffmpeg::is_available(&ffmpeg) {
        return false;
    }
    let at = crate::ffmpeg::duration_secs(&ffmpeg, video)
        .map(|d| d * f64::from(FRAME_AT_PERCENT) / 100.0)
        .unwrap_or(0.0);
    let mut command = std::process::Command::new(ffmpeg);
    crate::ffmpeg::no_window(&mut command);
    command
        .args(["-v", "error", "-ss", &format!("{at:.1}"), "-i"])
        .arg(video)
        .args(["-frames:v", "1", "-vf", &format!("scale={FRAME_WIDTH}:-2"), "-y"])
        .arg(target);
    command.status().is_ok_and(|s| s.success()) && target.is_file()
}

/// A second libmpv handle, separate from the player's, that decodes one frame
/// to a JPEG (`vo=image`) and closes. Loaded the way the player's own wrapper
/// is found: beside the program, then its `lib` folder, then the system's.
#[cfg(not(target_os = "android"))]
mod mpv_frame {
    use super::{FRAME_AT_PERCENT, FRAME_WIDTH};
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::path::Path;
    use std::time::{Duration, Instant};

    #[repr(C)]
    struct Event {
        event_id: c_int,
        error: c_int,
        reply_userdata: u64,
        data: *mut c_void,
    }

    type Create = unsafe extern "C" fn() -> *mut c_void;
    type SetOption = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
    type Initialize = unsafe extern "C" fn(*mut c_void) -> c_int;
    type Command = unsafe extern "C" fn(*mut c_void, *mut *const c_char) -> c_int;
    type WaitEvent = unsafe extern "C" fn(*mut c_void, f64) -> *mut Event;
    type Destroy = unsafe extern "C" fn(*mut c_void);

    const EVENT_SHUTDOWN: c_int = 1;
    const EVENT_END_FILE: c_int = 7;

    /// A file that takes longer than this is skipped; the tile keeps its plain
    /// picture. The measured time was about a second over a network share.
    const DEADLINE: Duration = Duration::from_secs(20);

    #[cfg(windows)]
    const NAMES: &[&str] = &["libmpv-2.dll"];
    #[cfg(not(windows))]
    const NAMES: &[&str] = &["libmpv.so.2", "libmpv.so"];

    fn library() -> Option<&'static libloading::Library> {
        static LIB: std::sync::OnceLock<Option<libloading::Library>> = std::sync::OnceLock::new();
        LIB.get_or_init(|| {
            let mut candidates = Vec::new();
            if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
                for name in NAMES {
                    candidates.push(dir.join(name));
                    candidates.push(dir.join("lib").join(name));
                }
            }
            candidates.extend(NAMES.iter().map(std::path::PathBuf::from));
            candidates.into_iter().find_map(|path| {
                // SAFETY: libmpv's initialisers have no preconditions; it is
                // the same library the player loads.
                unsafe { libloading::Library::new(&path) }.ok()
            })
        })
        .as_ref()
    }

    pub fn take(video: &Path, target: &Path) -> Option<()> {
        let lib = library()?;
        let out = tempdir(target)?;
        let result = grab(lib, video, &out);
        let produced = std::fs::read_dir(&out)
            .ok()
            .and_then(|mut entries| entries.find_map(|e| e.ok().map(|e| e.path())));
        let moved = result.is_some()
            && produced.is_some_and(|file| std::fs::rename(&file, target).is_ok());
        let _ = std::fs::remove_dir_all(&out);
        moved.then_some(())
    }

    fn tempdir(target: &Path) -> Option<std::path::PathBuf> {
        let dir = target.with_extension("taking");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    }

    fn grab(lib: &libloading::Library, video: &Path, out: &Path) -> Option<()> {
        // SAFETY: the signatures are libmpv's client API (client.h), stable
        // across libmpv 2.x; the handle is used on this thread only and
        // destroyed before returning.
        unsafe {
            let create: libloading::Symbol<Create> = lib.get(b"mpv_create\0").ok()?;
            let set: libloading::Symbol<SetOption> = lib.get(b"mpv_set_option_string\0").ok()?;
            let init: libloading::Symbol<Initialize> = lib.get(b"mpv_initialize\0").ok()?;
            let command: libloading::Symbol<Command> = lib.get(b"mpv_command\0").ok()?;
            let wait: libloading::Symbol<WaitEvent> = lib.get(b"mpv_wait_event\0").ok()?;
            let destroy: libloading::Symbol<Destroy> = lib.get(b"mpv_terminate_destroy\0").ok()?;

            let handle = create();
            if handle.is_null() {
                return None;
            }
            let options = [
                ("config", "no".to_string()),
                ("terminal", "no".to_string()),
                ("vo", "image".to_string()),
                ("vo-image-format", "jpg".to_string()),
                ("vo-image-outdir", out.to_string_lossy().into_owned()),
                ("ao", "null".to_string()),
                ("audio", "no".to_string()),
                ("sid", "no".to_string()),
                ("frames", "1".to_string()),
                ("start", format!("{FRAME_AT_PERCENT}%")),
                ("hr-seek", "no".to_string()),
                // Software decoding: one frame, and never a fight with the
                // player's own decoder for the graphics card.
                ("hwdec", "no".to_string()),
                ("vf", format!("scale={FRAME_WIDTH}:-2")),
                ("ytdl", "no".to_string()),
                ("load-scripts", "no".to_string()),
            ];
            for (name, value) in options {
                let (Ok(name), Ok(value)) = (CString::new(name), CString::new(value)) else {
                    destroy(handle);
                    return None;
                };
                set(handle, name.as_ptr(), value.as_ptr());
            }
            if init(handle) < 0 {
                destroy(handle);
                return None;
            }
            let Ok(path) = CString::new(video.to_string_lossy().as_bytes()) else {
                destroy(handle);
                return None;
            };
            let load = CString::new("loadfile").ok()?;
            let mut args = [load.as_ptr(), path.as_ptr(), std::ptr::null()];
            if command(handle, args.as_mut_ptr()) < 0 {
                destroy(handle);
                return None;
            }
            let started = Instant::now();
            let mut ended = false;
            while started.elapsed() < DEADLINE {
                let event = wait(handle, 0.5);
                let id = if event.is_null() { 0 } else { (*event).event_id };
                if id == EVENT_END_FILE || id == EVENT_SHUTDOWN {
                    ended = true;
                    break;
                }
            }
            destroy(handle);
            ended.then_some(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            r#"INSERT INTO library_roots (id, path, kind, added_at, name) VALUES (1, 'C:/v', 'videos', 0, 'Home videos');
               INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension, size_bytes, modified_at, first_seen_at, last_seen_at, match_status) VALUES
                 (1, 1, 'C:/v/Trip/clip 10.mp4', 'C:/v/Trip', 'clip 10.mp4', 'mp4', 1, 0, 0, 0, 'video'),
                 (2, 1, 'C:/v/Trip/clip 2.mp4',  'C:/v/Trip', 'clip 2.mp4',  'mp4', 1, 0, 0, 0, 'video'),
                 (3, 1, 'C:/v/Trip/Clip 3.mp4',  'C:/v/Trip', 'Clip 3.mp4',  'mp4', 1, 0, 0, 0, 'video'),
                 (4, 1, 'C:/v/other.mp4',        'C:/v',      'other.mp4',   'mp4', 1, 0, 0, 0, 'video');"#,
        )
        .unwrap();
        conn
    }

    #[test]
    fn steps_go_through_the_folder_in_file_manager_order() {
        let conn = library();
        let next = adjacent(&conn, 2, true).unwrap().unwrap();
        assert_eq!((next.file_id, next.episode, next.video), (3, 2, true));
        assert_eq!(next.title, "Trip");
        assert_eq!(adjacent(&conn, 3, true).unwrap().unwrap().file_id, 1);
        assert!(adjacent(&conn, 1, true).unwrap().is_none(), "the folder ends; nothing beyond it");
        assert!(adjacent(&conn, 2, false).unwrap().is_none());
        assert!(adjacent(&conn, 4, true).unwrap().is_none(), "another folder is another group");
    }

    #[test]
    fn a_video_is_known_by_its_folder_kind() {
        let conn = library();
        assert!(is_video(&conn, 1));
        assert!(!is_video(&conn, 99));
    }

    #[test]
    fn track_choices_are_kept_per_folder() {
        let conn = library();
        assert!(!prefs_for(&conn, 1).unwrap().chosen);
        let prefs = TitlePrefs { audio_lang: Some("nor".into()), sub_lang: None, sub_enabled: false, chosen: true };
        store_prefs(&conn, 1, &prefs).unwrap();
        let same_folder = prefs_for(&conn, 3).unwrap();
        assert_eq!(same_folder.audio_lang.as_deref(), Some("nor"));
        assert!(!prefs_for(&conn, 4).unwrap().chosen, "another folder has its own");
    }

    #[test]
    fn continue_watching_has_one_card_per_folder_until_put_away() {
        let conn = library();
        conn.execute_batch(
            "INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at) VALUES
               (1, 100, 600, 0, 50), (2, 200, 600, 0, 60), (4, 10, 600, 0, 70);",
        )
        .unwrap();
        let items = continue_items(&conn, Path::new("nowhere"), 30.0).unwrap();
        assert_eq!(items.iter().map(|i| i.file_id).collect::<Vec<_>>(), vec![2]);
        assert_eq!(items[0].kind, "video");
        conn.execute("INSERT INTO video_dismissed (dir, dismissed_at) VALUES ('C:/v/Trip', 60)", [])
            .unwrap();
        assert!(continue_items(&conn, Path::new("nowhere"), 30.0).unwrap().is_empty());
        conn.execute("UPDATE playback_state SET updated_at = 61 WHERE file_id = 1", []).unwrap();
        assert_eq!(continue_items(&conn, Path::new("nowhere"), 30.0).unwrap()[0].file_id, 1);
    }

    #[test]
    fn a_folder_name_is_its_last_part() {
        assert_eq!(folder_name("C:\\v\\Trip\\"), "Trip");
        assert_eq!(folder_name("/home/v/Trip"), "Trip");
    }
}
