//! Playlists (LOCAL-MEDIA.md phase 5): films, episodes and videos in an order
//! of the person's own, played one after the other through Up next.
//!
//! An item is a **path**, with the library file it was when there is one
//! (schema 26). So a playlist outlives its files' library folder, an imported
//! `.m3u` keeps files the library has never held as loose files (the owner's
//! choice, 2026-10-18), and a file scanned in again under a new id is found by
//! its path. What an item *is* — a film, an episode, a video, a loose file —
//! is read at the moment it is listed, never stored, so a later match or
//! rename shows at once.
//!
//! **Order in the player** comes from [`playlist_step`]: the item after (or
//! before) the one playing, skipping files the last scan did not find. The
//! player asks it in place of the episode or folder steps whenever it plays
//! from a playlist, so the previous/next buttons, `n`/`p` and Up next follow
//! the playlist with no second mechanism. The item last started is kept
//! (`current_item`), and Play on the playlist carries on there.
//!
//! **`.m3u`** is the plain list every player reads: `#EXTM3U`, then an
//! `#EXTINF` line (length, name) and the path for each item. Reading takes
//! paths relative to the list's own folder and `file://` addresses; web
//! addresses and files that are not there are left out and counted.

use crate::library::Db;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// One item, as the playlist page, the Home rail and the player use it.
#[derive(Serialize, Debug, Clone)]
pub struct PlaylistEntry {
    pub item_id: i64,
    pub path: String,
    /// The library file, when the path is one.
    pub file_id: Option<i64>,
    /// `film`, `episode`, `video`, `file` (in the library, no title yet) or
    /// `loose` (not in the library).
    pub kind: String,
    pub title_id: Option<i64>,
    /// The film's or show's name.
    pub title: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub episode_name: Option<String>,
    pub position_secs: f64,
    pub duration_secs: Option<f64>,
    pub completed: bool,
    pub image_url: Option<String>,
    pub image_path: Option<String>,
    /// A library file the last scan did not find: shown, never stepped to.
    pub missing: bool,
}

/// A playlist as its tile shows it.
#[derive(Serialize, Debug)]
pub struct PlaylistSummary {
    pub id: i64,
    pub name: String,
    pub count: usize,
    pub current_item: Option<i64>,
    /// The first item's picture that has one.
    pub image_url: Option<String>,
    pub image_path: Option<String>,
    pub updated_at: i64,
}

/// What is asked to be added: a path, and its library file when known.
#[derive(Deserialize, Debug)]
pub struct NewItem {
    pub path: String,
    pub file_id: Option<i64>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Added {
    pub added: usize,
    /// Already in the playlist, so not added twice.
    pub already: usize,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Imported {
    pub id: i64,
    pub name: String,
    /// Files the library holds.
    pub library: usize,
    /// Files kept as loose files.
    pub loose: usize,
    /// Lines left out: not there, or a web address.
    pub skipped: usize,
}

// ---- reading ----------------------------------------------------------------

const ENTRY_SELECT: &str = "
    SELECT i.id, i.path, m.id, r.kind, t.id, t.title, t.kind,
           m.parsed_season, m.parsed_episode, e.name,
           COALESCE(p.position_secs, 0), p.duration_secs, COALESCE(p.completed, 0),
           COALESCE(e.still_url, t.backdrop_url, t.poster_url),
           COALESCE(
             (SELECT ?2 || a.local_path FROM artwork_cache a
               WHERE a.url = e.still_url AND a.local_path <> ''),
             -- With no still, the title's picture: one beside the files first.
             CASE WHEN e.still_url IS NULL THEN COALESCE(
               (SELECT ?2 || l.local_path FROM local_art l
                 WHERE l.title_id = t.id AND l.kind = 'backdrop'),
               (SELECT ?2 || a.local_path FROM artwork_cache a
                 WHERE a.url = t.backdrop_url AND a.local_path <> ''),
               (SELECT ?2 || l.local_path FROM local_art l
                 WHERE l.title_id = t.id AND l.kind = 'poster'),
               (SELECT ?2 || a.local_path FROM artwork_cache a
                 WHERE a.url = t.poster_url AND a.local_path <> '')) END),
           COALESCE(m.missing, 0)
      FROM playlist_items i
      LEFT JOIN media_files m
             ON m.id = COALESCE(i.file_id, (SELECT f.id FROM media_files f WHERE f.path = i.path PATH_CMP))
      LEFT JOIN library_roots r ON r.id = m.root_id
      LEFT JOIN titles t ON t.id = m.title_id
      LEFT JOIN playback_state p ON p.file_id = m.id
      LEFT JOIN episodes e ON e.title_id = m.title_id
                          AND e.season  = m.parsed_season
                          AND e.episode = m.parsed_episode
     WHERE i.playlist_id = ?1
     ORDER BY i.position, i.id";

fn entries(conn: &Connection, playlist_id: i64, art: &str, frames: &Path) -> Result<Vec<PlaylistEntry>, String> {
    // A path compared as the system compares names, as `library_file` does.
    let sql = ENTRY_SELECT.replace("PATH_CMP", if cfg!(windows) { "COLLATE NOCASE" } else { "" });
    let mut stmt = conn.prepare_cached(&sql).map_err(to_string_err)?;
    let rows = stmt
        .query_map(params![playlist_id, art], |r| {
            let file_id: Option<i64> = r.get(2)?;
            let root_kind: Option<String> = r.get(3)?;
            let title_kind: Option<String> = r.get(6)?;
            let kind = match (file_id, root_kind.as_deref(), title_kind.as_deref()) {
                (None, _, _) => "loose",
                (Some(_), Some(crate::videos::KIND), _) => "video",
                (Some(_), _, Some("movie")) => "film",
                (Some(_), _, Some("series")) => "episode",
                _ => "file",
            };
            let video = kind == "video";
            Ok(PlaylistEntry {
                item_id: r.get(0)?,
                path: r.get(1)?,
                file_id,
                kind: kind.into(),
                title_id: r.get(4)?,
                title: r.get(5)?,
                season: if kind == "episode" { r.get(7)? } else { None },
                episode: if kind == "episode" { r.get(8)? } else { None },
                episode_name: r.get(9)?,
                position_secs: r.get(10)?,
                duration_secs: r.get(11)?,
                completed: r.get::<_, i64>(12)? != 0,
                image_url: r.get(13)?,
                image_path: match file_id {
                    Some(id) if video => crate::videos::cached_frame(frames, id),
                    _ => r.get(14)?,
                },
                missing: r.get::<_, i64>(15)? != 0,
            })
        })
        .map_err(to_string_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(to_string_err)
}

fn summaries(conn: &Connection, art: &str, frames: &Path) -> Result<Vec<PlaylistSummary>, String> {
    let lists: Vec<(i64, String, Option<i64>, i64)> = {
        let mut stmt = conn
            .prepare("SELECT id, name, current_item, updated_at FROM playlists ORDER BY updated_at DESC, id DESC")
            .map_err(to_string_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(to_string_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(to_string_err)?
    };
    lists
        .into_iter()
        .map(|(id, name, current_item, updated_at)| {
            let items = entries(conn, id, art, frames)?;
            let pictured = items.iter().find(|e| e.image_path.is_some() || e.image_url.is_some());
            Ok(PlaylistSummary {
                id,
                name,
                count: items.len(),
                current_item,
                image_url: pictured.and_then(|e| e.image_url.clone()),
                image_path: pictured.and_then(|e| e.image_path.clone()),
                updated_at,
            })
        })
        .collect()
}

/// The playable item after (or before) `item_id`, skipping files the last scan
/// did not find and files outside the library that are no longer there
/// (`exists`, asked only of those). None at either end: a playlist plays once
/// through.
fn step(
    items: &[PlaylistEntry],
    item_id: i64,
    forward: bool,
    exists: impl Fn(&Path) -> bool,
) -> Option<PlaylistEntry> {
    let here = items.iter().position(|e| e.item_id == item_id)?;
    let playable = |e: &&PlaylistEntry| !e.missing && (e.file_id.is_some() || exists(Path::new(&e.path)));
    if forward {
        items[here + 1..].iter().find(playable).cloned()
    } else {
        items[..here].iter().rev().find(playable).cloned()
    }
}

// ---- changing ---------------------------------------------------------------

fn touch(conn: &Connection, playlist_id: i64) -> Result<(), String> {
    conn.execute("UPDATE playlists SET updated_at = ?2 WHERE id = ?1", params![playlist_id, now_secs()])
        .map_err(to_string_err)?;
    Ok(())
}

fn create(conn: &Connection, name: &str) -> Result<i64, String> {
    let name = name.trim();
    let name = if name.is_empty() { "Playlist" } else { name };
    let now = now_secs();
    conn.execute(
        "INSERT INTO playlists (name, created_at, updated_at) VALUES (?1, ?2, ?2)",
        params![name, now],
    )
    .map_err(to_string_err)?;
    Ok(conn.last_insert_rowid())
}

/// `name`, or `name (2)`, `(3)`… when a playlist is already called that: an
/// imported list named like one there was a second with the same name.
fn free_name(conn: &Connection, name: &str) -> Result<String, String> {
    let taken = |n: &str| -> Result<bool, String> {
        conn.query_row("SELECT EXISTS(SELECT 1 FROM playlists WHERE name = ?1)", params![n], |r| r.get(0))
            .map_err(to_string_err)
    };
    let name = name.trim();
    if !taken(name)? {
        return Ok(name.to_string());
    }
    let mut n = 2;
    loop {
        let candidate = format!("{name} ({n})");
        if !taken(&candidate)? {
            return Ok(candidate);
        }
        n += 1;
    }
}

fn add(conn: &Connection, playlist_id: i64, items: &[NewItem]) -> Result<Added, String> {
    let tx = conn.unchecked_transaction().map_err(to_string_err)?;
    let result = add_rows(&tx, playlist_id, items)?;
    tx.commit().map_err(to_string_err)?;
    Ok(result)
}

/// [`add`] inside a transaction the caller holds.
fn add_rows(tx: &Connection, playlist_id: i64, items: &[NewItem]) -> Result<Added, String> {
    // The same file twice is the same name as the system compares names.
    let same_path = if cfg!(windows) {
        "SELECT EXISTS (SELECT 1 FROM playlist_items WHERE playlist_id = ?1 AND path = ?2 COLLATE NOCASE)"
    } else {
        "SELECT EXISTS (SELECT 1 FROM playlist_items WHERE playlist_id = ?1 AND path = ?2)"
    };
    let mut next: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM playlist_items WHERE playlist_id = ?1",
            params![playlist_id],
            |r| r.get(0),
        )
        .map_err(to_string_err)?;
    let mut result = Added { added: 0, already: 0 };
    for item in items {
        let there: bool = tx
            .query_row(same_path, params![playlist_id, item.path], |r| r.get(0))
            .map_err(to_string_err)?;
        if there {
            result.already += 1;
            continue;
        }
        tx.execute(
            "INSERT INTO playlist_items (playlist_id, position, file_id, path) VALUES (?1, ?2, ?3, ?4)",
            params![playlist_id, next, item.file_id, item.path],
        )
        .map_err(to_string_err)?;
        next += 1;
        result.added += 1;
    }
    touch(tx, playlist_id)?;
    Ok(result)
}

/// Swap an item with the one before (`up`) or after it. At either end, nothing.
fn shift(conn: &Connection, item_id: i64, up: bool) -> Result<(), String> {
    let Some((playlist_id, position)) = conn
        .query_row(
            "SELECT playlist_id, position FROM playlist_items WHERE id = ?1",
            params![item_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(to_string_err)?
    else {
        return Ok(());
    };
    let (cmp, order) = if up { ("<", "DESC") } else { (">", "ASC") };
    let other: Option<(i64, i64)> = conn
        .query_row(
            &format!(
                "SELECT id, position FROM playlist_items
                  WHERE playlist_id = ?1 AND position {cmp} ?2
                  ORDER BY position {order} LIMIT 1"
            ),
            params![playlist_id, position],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(to_string_err)?;
    let Some((other_id, other_position)) = other else { return Ok(()) };
    let tx = conn.unchecked_transaction().map_err(to_string_err)?;
    tx.execute("UPDATE playlist_items SET position = ?2 WHERE id = ?1", params![item_id, other_position])
        .map_err(to_string_err)?;
    tx.execute("UPDATE playlist_items SET position = ?2 WHERE id = ?1", params![other_id, position])
        .map_err(to_string_err)?;
    touch(&tx, playlist_id)?;
    tx.commit().map_err(to_string_err)
}

fn remove(conn: &Connection, item_id: i64) -> Result<(), String> {
    let playlist_id: Option<i64> = conn
        .query_row("SELECT playlist_id FROM playlist_items WHERE id = ?1", params![item_id], |r| r.get(0))
        .optional()
        .map_err(to_string_err)?;
    let Some(playlist_id) = playlist_id else { return Ok(()) };
    conn.execute("DELETE FROM playlist_items WHERE id = ?1", params![item_id])
        .map_err(to_string_err)?;
    conn.execute(
        "UPDATE playlists SET current_item = NULL WHERE id = ?1 AND current_item = ?2",
        params![playlist_id, item_id],
    )
    .map_err(to_string_err)?;
    touch(conn, playlist_id)
}

// ---- .m3u -------------------------------------------------------------------

/// What an item is called in the list, as a player shows it.
fn label(entry: &PlaylistEntry) -> String {
    let file = || {
        Path::new(&entry.path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| entry.path.clone())
    };
    match (entry.kind.as_str(), &entry.title) {
        ("film", Some(title)) => title.clone(),
        ("episode", Some(title)) => match (entry.season, entry.episode) {
            (Some(s), Some(e)) => format!("{title} S{s:02}E{e:02}"),
            _ => title.clone(),
        },
        _ => file(),
    }
}

fn write_m3u(items: &[PlaylistEntry]) -> String {
    let mut out = String::from("#EXTM3U\n");
    for entry in items {
        let secs = entry.duration_secs.map_or(-1, |d| d.round() as i64);
        // A line break inside a name would end the line early.
        let name = label(entry).replace(['\r', '\n'], " ");
        out.push_str(&format!("#EXTINF:{secs},{name}\n{}\n", entry.path));
    }
    out
}

/// Turn `%20` and friends back into bytes, for a `file://` address.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The paths a list names, in order: relative ones against the list's own
/// folder, `file://` addresses as paths. Web addresses come back as None, to
/// be counted as left out.
fn read_m3u(text: &str, base: &Path) -> Vec<Option<PathBuf>> {
    text.lines()
        .map(|line| line.trim().trim_start_matches('\u{feff}'))
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            if let Some(rest) = line.strip_prefix("file://") {
                // file:///C:/x on Windows, file:///home/x elsewhere, and
                // file://server/share/x for a share.
                let rest = percent_decode(rest);
                let path = match rest.strip_prefix('/') {
                    Some(local) if cfg!(windows) => local.to_string(),
                    Some(_) => rest,
                    None if cfg!(windows) => format!("\\\\{rest}"),
                    None => format!("//{rest}"),
                };
                return Some(PathBuf::from(path));
            }
            if line.contains("://") {
                return None;
            }
            let path = PathBuf::from(line);
            // A drive letter is a whole path wherever the list is read: one
            // written on Windows names no file in the list's folder elsewhere.
            let b = line.as_bytes();
            let drive = b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\');
            Some(if path.is_absolute() || drive || line.starts_with("\\\\") { path } else { base.join(path) })
        })
        .collect()
}

/// The library file at `path`, compared as the system compares names.
fn library_file(conn: &Connection, path: &str) -> Result<Option<(i64, String)>, String> {
    let sql = if cfg!(windows) {
        "SELECT id, path FROM media_files WHERE path = ?1 COLLATE NOCASE LIMIT 1"
    } else {
        "SELECT id, path FROM media_files WHERE path = ?1 LIMIT 1"
    };
    conn.query_row(sql, params![path], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(to_string_err)
}

fn import(conn: &Connection, list: &Path, exists: impl Fn(&Path) -> bool) -> Result<Imported, String> {
    let bytes = std::fs::read(list).map_err(|e| format!("{}: {e}", list.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let base = list.parent().unwrap_or(Path::new(""));
    let name = list
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Playlist".into());

    let mut result = Imported { id: 0, name, library: 0, loose: 0, skipped: 0 };
    let mut items = Vec::new();
    for path in read_m3u(&text, base) {
        let Some(path) = path else {
            result.skipped += 1;
            continue;
        };
        let text = path.to_string_lossy().into_owned();
        if let Some((file_id, stored)) = library_file(conn, &text)? {
            result.library += 1;
            items.push(NewItem { path: stored, file_id: Some(file_id) });
        } else if exists(&path) {
            result.loose += 1;
            items.push(NewItem { path: text, file_id: None });
        } else {
            result.skipped += 1;
        }
    }
    // One transaction: a failure leaves no empty playlist behind.
    let tx = conn.unchecked_transaction().map_err(to_string_err)?;
    result.name = free_name(&tx, &result.name)?;
    result.id = create(&tx, &result.name)?;
    add_rows(&tx, result.id, &items)?;
    tx.commit().map_err(to_string_err)?;
    Ok(result)
}

// ---- commands ---------------------------------------------------------------

fn places(app: &tauri::AppHandle) -> Result<(String, PathBuf), String> {
    Ok((crate::artwork::path_prefix(app)?, crate::videos::frames_dir(app)?))
}

#[tauri::command]
pub fn list_playlists(app: tauri::AppHandle, db: tauri::State<Db>) -> Result<Vec<PlaylistSummary>, String> {
    let (art, frames) = places(&app)?;
    let conn = db.0.lock().map_err(to_string_err)?;
    summaries(&conn, &art, &frames)
}

#[tauri::command]
pub fn playlist_entries(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    playlist_id: i64,
) -> Result<Vec<PlaylistEntry>, String> {
    let (art, frames) = places(&app)?;
    let conn = db.0.lock().map_err(to_string_err)?;
    entries(&conn, playlist_id, &art, &frames)
}

#[tauri::command]
pub fn create_playlist(db: tauri::State<Db>, name: String) -> Result<i64, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    create(&conn, &name)
}

#[tauri::command]
pub fn rename_playlist(db: tauri::State<Db>, playlist_id: i64, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A playlist needs a name.".into());
    }
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.execute("UPDATE playlists SET name = ?2 WHERE id = ?1", params![playlist_id, name])
        .map_err(to_string_err)?;
    Ok(())
}

#[tauri::command]
pub fn delete_playlist(db: tauri::State<Db>, playlist_id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![playlist_id])
        .map_err(to_string_err)?;
    Ok(())
}

#[tauri::command]
pub fn add_to_playlist(db: tauri::State<Db>, playlist_id: i64, items: Vec<NewItem>) -> Result<Added, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    add(&conn, playlist_id, &items)
}

#[tauri::command]
pub fn remove_playlist_item(db: tauri::State<Db>, item_id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    remove(&conn, item_id)
}

#[tauri::command]
pub fn move_playlist_item(db: tauri::State<Db>, item_id: i64, up: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    shift(&conn, item_id, up)
}

/// The item now playing, where the playlist's Play carries on next time.
#[tauri::command]
pub fn set_playlist_current(db: tauri::State<Db>, playlist_id: i64, item_id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.execute(
        "UPDATE playlists SET current_item = ?2, updated_at = ?3 WHERE id = ?1",
        params![playlist_id, item_id, now_secs()],
    )
    .map_err(to_string_err)?;
    Ok(())
}

/// Off the main thread, and with the library let go before a file outside it
/// is looked for: that may be on a share that is not answering.
#[tauri::command]
pub async fn playlist_step(
    app: tauri::AppHandle,
    playlist_id: i64,
    item_id: i64,
    forward: bool,
) -> Result<Option<PlaylistEntry>, String> {
    crate::jobs::off_main(move || {
        let (art, frames) = places(&app)?;
        let items = {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            entries(&conn, playlist_id, &art, &frames)?
        };
        Ok(step(&items, item_id, forward, Path::is_file))
    })
    .await
}

/// Write the playlist as `.m3u` to `path`; the number of items written.
#[tauri::command]
pub fn export_playlist(db: tauri::State<Db>, playlist_id: i64, path: String) -> Result<usize, String> {
    let items = {
        let conn = db.0.lock().map_err(to_string_err)?;
        entries(&conn, playlist_id, "", Path::new(""))?
    };
    std::fs::write(&path, write_m3u(&items)).map_err(|e| format!("{path}: {e}"))?;
    Ok(items.len())
}

/// Read a `.m3u` (or `.m3u8`) into a new playlist named after the file.
///
/// Off the main thread, and every named file is looked for before the library
/// is locked: a list of files on a share that is not answering waits on the
/// network, never holding up the player or the pages.
#[tauri::command]
pub async fn import_playlist(app: tauri::AppHandle, path: String) -> Result<Imported, String> {
    crate::jobs::off_main(move || {
        let list = Path::new(&path);
        let text = std::fs::read(list).map_err(|e| format!("{}: {e}", list.display()))?;
        let base = list.parent().unwrap_or(Path::new(""));
        let present: std::collections::HashSet<PathBuf> = read_m3u(&String::from_utf8_lossy(&text), base)
            .into_iter()
            .flatten()
            .filter(|p| p.is_file())
            .collect();
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        import(&conn, list, |p| present.contains(p))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            r#"INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:/m', 'movies', 0), (2, 'C:/tv', 'tv', 0);
               INSERT INTO library_roots (id, path, kind, added_at, name) VALUES (3, 'C:/v', 'videos', 0, 'Home');
               INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at) VALUES (10, 'movie', 'tmdb', '1', 'A Film', 0), (20, 'series', 'tmdb', '2', 'A Show', 0);
               INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension, size_bytes, modified_at, first_seen_at, last_seen_at, match_status, title_id, parsed_season, parsed_episode) VALUES
                 (1, 1, 'C:/m/film.mkv', 'C:/m', 'film.mkv', 'mkv', 1, 0, 0, 0, 'matched', 10, NULL, NULL),
                 (2, 2, 'C:/tv/s01e01.mkv', 'C:/tv', 's01e01.mkv', 'mkv', 1, 0, 0, 0, 'matched', 20, 1, 1),
                 (3, 2, 'C:/tv/s01e02.mkv', 'C:/tv', 's01e02.mkv', 'mkv', 1, 0, 0, 0, 'matched', 20, 1, 2),
                 (4, 3, 'C:/v/clip.mp4', 'C:/v', 'clip.mp4', 'mp4', 1, 0, 0, 0, 'video', NULL, NULL, NULL);"#,
        )
        .unwrap();
        conn
    }

    fn item(path: &str, file_id: Option<i64>) -> NewItem {
        NewItem { path: path.into(), file_id }
    }

    fn listed(conn: &Connection, id: i64) -> Vec<PlaylistEntry> {
        entries(conn, id, "", Path::new("")).unwrap()
    }

    #[test]
    fn items_are_read_as_what_they_are_now() {
        let conn = library();
        let id = create(&conn, "  Evening ").unwrap();
        let added = add(
            &conn,
            id,
            &[item("C:/m/film.mkv", Some(1)), item("C:/tv/s01e02.mkv", Some(3)), item("C:/v/clip.mp4", Some(4)), item("D:/x.mkv", None)],
        )
        .unwrap();
        assert_eq!(added, Added { added: 4, already: 0 });
        let items = listed(&conn, id);
        let kinds: Vec<_> = items.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["film", "episode", "video", "loose"]);
        assert_eq!((items[1].season, items[1].episode), (Some(1), Some(2)));
        assert_eq!(items[0].title.as_deref(), Some("A Film"));
        let name: String = conn.query_row("SELECT name FROM playlists", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "Evening");
    }

    #[test]
    fn the_same_file_is_not_added_twice() {
        let conn = library();
        let id = create(&conn, "x").unwrap();
        add(&conn, id, &[item("C:/m/film.mkv", Some(1))]).unwrap();
        let again = add(&conn, id, &[item("C:/m/film.mkv", Some(1)), item("C:/tv/s01e01.mkv", Some(2))]).unwrap();
        assert_eq!(again, Added { added: 1, already: 1 });
    }

    #[test]
    fn steps_follow_the_playlist_and_skip_missing_files() {
        let conn = library();
        let id = create(&conn, "x").unwrap();
        add(&conn, id, &[item("C:/tv/s01e02.mkv", Some(3)), item("C:/m/film.mkv", Some(1)), item("C:/tv/s01e01.mkv", Some(2))]).unwrap();
        conn.execute("UPDATE media_files SET missing = 1 WHERE id = 1", []).unwrap();
        let items = listed(&conn, id);
        let there = |_: &Path| true;
        let next = step(&items, items[0].item_id, true, there).unwrap();
        assert_eq!(next.file_id, Some(2), "the playlist's order, not the show's; the missing film skipped");
        assert_eq!(step(&items, items[2].item_id, false, there).unwrap().file_id, Some(3));
        assert!(step(&items, items[2].item_id, true, there).is_none(), "the end of the playlist ends it");
    }

    #[test]
    fn a_file_outside_the_library_that_is_gone_is_stepped_over() {
        let conn = library();
        let id = create(&conn, "x").unwrap();
        add(&conn, id, &[item("C:/m/film.mkv", Some(1)), item("D:/gone.mkv", None), item("D:/here.mkv", None)])
            .unwrap();
        let items = listed(&conn, id);
        let next = step(&items, items[0].item_id, true, |p| p == Path::new("D:/here.mkv")).unwrap();
        assert_eq!(next.path, "D:/here.mkv");
    }

    #[cfg(windows)]
    #[test]
    fn the_same_file_spelled_in_another_case_is_not_added_twice() {
        let conn = library();
        let id = create(&conn, "x").unwrap();
        add(&conn, id, &[item("d:/Clips/a.mkv", None)]).unwrap();
        assert_eq!(add(&conn, id, &[item("D:/clips/A.mkv", None)]).unwrap(), Added { added: 0, already: 1 });
    }

    #[test]
    fn moving_swaps_with_the_neighbour_and_stops_at_the_ends() {
        let conn = library();
        let id = create(&conn, "x").unwrap();
        add(&conn, id, &[item("a", None), item("b", None), item("c", None)]).unwrap();
        let ids: Vec<i64> = listed(&conn, id).iter().map(|e| e.item_id).collect();
        shift(&conn, ids[2], true).unwrap();
        shift(&conn, ids[0], true).unwrap();
        let paths: Vec<String> = listed(&conn, id).into_iter().map(|e| e.path).collect();
        assert_eq!(paths, ["a", "c", "b"]);
    }

    #[test]
    fn removing_a_library_folder_keeps_the_item_by_path() {
        let conn = library();
        let id = create(&conn, "x").unwrap();
        add(&conn, id, &[item("C:/m/film.mkv", Some(1))]).unwrap();
        conn.execute("DELETE FROM library_roots WHERE id = 1", []).unwrap();
        let items = listed(&conn, id);
        assert_eq!((items.len(), items[0].kind.as_str(), items[0].file_id), (1, "loose", None));
        // Scanned in again under a new id: found by its path.
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (5, 'C:/m', 'movies', 0);
             INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension, size_bytes, modified_at, first_seen_at, last_seen_at, match_status, title_id)
             VALUES (9, 5, 'C:/m/film.mkv', 'C:/m', 'film.mkv', 'mkv', 1, 0, 0, 0, 'matched', 10);",
        )
        .unwrap();
        assert_eq!(listed(&conn, id)[0].file_id, Some(9));
    }

    #[test]
    fn removing_the_current_item_forgets_it_and_deleting_the_playlist_takes_its_items() {
        let conn = library();
        let id = create(&conn, "x").unwrap();
        add(&conn, id, &[item("a", None)]).unwrap();
        let item_id = listed(&conn, id)[0].item_id;
        conn.execute("UPDATE playlists SET current_item = ?1", params![item_id]).unwrap();
        remove(&conn, item_id).unwrap();
        let current: Option<i64> = conn.query_row("SELECT current_item FROM playlists", [], |r| r.get(0)).unwrap();
        assert_eq!(current, None);
        add(&conn, id, &[item("b", None)]).unwrap();
        conn.execute("DELETE FROM playlists WHERE id = ?1", params![id]).unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM playlist_items", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn summaries_count_items_and_take_the_first_picture() {
        let conn = library();
        let id = create(&conn, "x").unwrap();
        add(&conn, id, &[item("a", None), item("C:/m/film.mkv", Some(1))]).unwrap();
        conn.execute("UPDATE titles SET poster_url = 'https://img/p.jpg' WHERE id = 10", []).unwrap();
        let all = summaries(&conn, "", Path::new("")).unwrap();
        assert_eq!((all[0].count, all[0].image_url.as_deref()), (2, Some("https://img/p.jpg")));
    }

    #[test]
    fn m3u_is_written_with_names_and_lengths() {
        let conn = library();
        let id = create(&conn, "x").unwrap();
        add(&conn, id, &[item("C:/m/film.mkv", Some(1)), item("C:/tv/s01e02.mkv", Some(3)), item("D:/home/clip one.mp4", None)]).unwrap();
        conn.execute("INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at) VALUES (1, 0, 5400.4, 0, 0)", []).unwrap();
        let text = write_m3u(&listed(&conn, id));
        assert_eq!(
            text,
            "#EXTM3U\n#EXTINF:5400,A Film\nC:/m/film.mkv\n#EXTINF:-1,A Show S01E02\nC:/tv/s01e02.mkv\n#EXTINF:-1,clip one\nD:/home/clip one.mp4\n"
        );
    }

    #[test]
    fn m3u_paths_are_read_relative_to_the_list_and_web_addresses_left_out() {
        let base = Path::new("/lists");
        let text = "\u{feff}#EXTM3U\n#EXTINF:1,x\nfilm.mkv\n\nhttps://example.com/a.mp4\n/abs/b.mkv\n";
        let read = read_m3u(text, base);
        assert_eq!(read, [Some(base.join("film.mkv")), None, Some(PathBuf::from("/abs/b.mkv"))]);
        let uri = read_m3u("file:///media/My%20Film.mkv", base);
        let expected = if cfg!(windows) { "media/My Film.mkv" } else { "/media/My Film.mkv" };
        assert_eq!(uri, [Some(PathBuf::from(expected))]);
        let share = read_m3u("file://server/films/a.mkv", base);
        let expected = if cfg!(windows) { "\\\\server/films/a.mkv" } else { "//server/films/a.mkv" };
        assert_eq!(share, [Some(PathBuf::from(expected))]);
    }

    #[test]
    fn importing_finds_library_files_keeps_loose_ones_and_counts_the_rest() {
        let conn = library();
        let dir = std::env::temp_dir().join(format!("kinema-m3u-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let list = dir.join("Road trip.m3u");
        std::fs::write(&list, "#EXTM3U\nC:/m/film.mkv\nhere.mp4\ngone.mp4\nhttp://x/y\n").unwrap();
        let here = dir.join("here.mp4");
        let result = import(&conn, &list, |p| p == here).unwrap();
        assert_eq!((result.name.as_str(), result.library, result.loose, result.skipped), ("Road trip", 1, 1, 2));
        let items = listed(&conn, result.id);
        assert_eq!((items[0].file_id, items[1].kind.as_str()), (Some(1), "loose"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_import_named_like_a_playlist_there_gets_a_number() {
        let conn = library();
        create(&conn, "Road trip").unwrap();
        create(&conn, "Road trip (2)").unwrap();
        let dir = std::env::temp_dir().join(format!("kinema-m3u-name-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let list = dir.join("Road trip.m3u");
        std::fs::write(&list, "#EXTM3U\nC:/m/film.mkv\n").unwrap();
        assert_eq!(import(&conn, &list, |_| false).unwrap().name, "Road trip (3)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Exported and read back, the same files in the same order.
    #[test]
    fn an_export_reads_back_as_the_same_playlist() {
        let conn = library();
        let id = create(&conn, "x").unwrap();
        add(&conn, id, &[item("C:/tv/s01e02.mkv", Some(3)), item("C:/m/film.mkv", Some(1))]).unwrap();
        let dir = std::env::temp_dir().join(format!("kinema-m3u-back-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let list = dir.join("x.m3u");
        std::fs::write(&list, write_m3u(&listed(&conn, id))).unwrap();
        let back = import(&conn, &list, |_| false).unwrap();
        let ids: Vec<_> = listed(&conn, back.id).iter().map(|e| e.file_id).collect();
        assert_eq!(ids, [Some(3), Some(1)]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
