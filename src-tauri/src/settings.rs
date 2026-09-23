//! Key/value settings, including provider API keys.
//!
//! These live in the SQLite database in the app data directory — never in the
//! repository, never in a bundled file. Nothing secret is ever committed, and
//! changing a key needs no rebuild.

use crate::library::Db;
use rusqlite::params;

fn to_string_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Read one setting from an already-held connection.
///
/// A blank value is treated as unset, so clearing a text field in Settings and
/// never having filled it in mean the same thing — which is what a user who
/// just emptied a box expects, and it saves every caller a `trim`.
pub fn setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .filter(|v| !v.trim().is_empty())
}

#[tauri::command]
pub fn get_setting(db: tauri::State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![&key],
        |r| r.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(to_string_err(other)),
    })
}

#[tauri::command]
pub fn set_setting(db: tauri::State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    store(&conn, &key, &value)
}

/// The settings whose change can change a match's answer.
const PROVIDER_KEYS: [&str; 2] = ["tmdb_api_key", "omdb_api_key"];

fn store(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    let before = setting(conn, key);
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(to_string_err)?;

    // Refused matches are not re-asked at every launch any more — the same
    // question gets the same answer. A new or changed provider key is the one
    // thing that can change it (a group refused as "no provider for movies",
    // or searched through TVmaze before a TMDB key existed), so it re-opens
    // them for the next scan. Files held by hand stay held.
    let after = setting(conn, key);
    if PROVIDER_KEYS.contains(&key) && after.is_some() && after != before {
        let reopened = conn
            .execute(
                "UPDATE media_files SET match_status = 'parsed'
                  WHERE match_status = 'unmatched' AND match_hold = 0",
                [],
            )
            .map_err(to_string_err)?;
        crate::log!("settings: {key} changed; {reopened} refused file(s) will be matched again");
    }
    Ok(())
}

/// Append a line from the frontend to `app.log`. This is the only way UI-side
/// errors become readable from outside the webview. See `applog` for where
/// the file lives and how it is kept from growing.
#[tauri::command]
pub fn append_log(level: String, message: String) {
    crate::applog::write(&level, &message);
}

#[derive(serde::Serialize)]
pub struct LogPaths {
    /// The folder both logs live in.
    pub dir: String,
    /// Absolute path for mpv's `log-file` option.
    pub mpv_log: String,
}

/// Where the logs are. The player needs the absolute mpv log path before it
/// initialises mpv; a relative one lands in whatever the current directory is.
#[tauri::command]
pub fn log_paths(app: tauri::AppHandle) -> Result<LogPaths, String> {
    let dir = log_dir(&app)?;
    Ok(LogPaths {
        mpv_log: dir.join(crate::applog::MPV_LOG).to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
    })
}

fn log_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::data_dir(app)?.join(crate::applog::DIR))
}

/// Open the log folder in Explorer, for attaching logs to a bug report.
#[tauri::command]
pub fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = log_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(to_string_err)
}

/// Which providers are usable right now. The UI uses this to explain what is
/// and is not available rather than failing opaquely mid-match.
#[tauri::command]
pub fn provider_status(db: tauri::State<Db>) -> Result<Vec<(String, bool)>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    let has = |key: &str| -> bool {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        )
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    };

    Ok(vec![
        // TVmaze needs no key at all — always available.
        ("tvmaze".into(), true),
        ("omdb".into(), has("omdb_api_key")),
        ("tmdb".into(), has("tmdb_api_key")),
    ])
}

#[cfg(test)]
mod tests {
    use super::store;

    fn library(name: &str) -> rusqlite::Connection {
        let dir = std::env::temp_dir().join(format!("pn-settings-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("library.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:/m', 'movies', 0);
             INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                 size_bytes, modified_at, first_seen_at, last_seen_at, match_status, match_hold,
                 parsed_title)
             VALUES (1, 1, 'a', 'C:/m', 'a', 'mkv', 1, 0, 0, 0, 'unmatched', 0, 'Film'),
                    (2, 1, 'b', 'C:/m', 'b', 'mkv', 1, 0, 0, 0, 'unmatched', 1, 'Other');",
        )
        .unwrap();
        conn
    }

    fn status(conn: &rusqlite::Connection, id: i64) -> String {
        conn.query_row("SELECT match_status FROM media_files WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    /// Adding a TMDB key can turn a refusal into a match, so refusals are
    /// re-opened — except one a person unlinked, which stays held.
    #[test]
    fn a_new_provider_key_reopens_refusals_but_not_held_files() {
        let conn = library("reopen");
        store(&conn, "tmdb_api_key", "abc").unwrap();
        assert_eq!(status(&conn, 1), "parsed");
        assert_eq!(status(&conn, 2), "unmatched");
    }

    /// Saving the same key again — the debounced autosave does — re-opens
    /// nothing, and neither does an unrelated setting.
    #[test]
    fn an_unchanged_key_or_another_setting_reopens_nothing() {
        let conn = library("same");
        store(&conn, "tmdb_api_key", "abc").unwrap();
        conn.execute("UPDATE media_files SET match_status = 'unmatched' WHERE id = 1", [])
            .unwrap();
        store(&conn, "tmdb_api_key", "abc").unwrap();
        store(&conn, "tv_mode", "on").unwrap();
        assert_eq!(status(&conn, 1), "unmatched");
    }

    /// Clearing a key cannot produce a new answer, so it reopens nothing.
    #[test]
    fn clearing_a_key_reopens_nothing() {
        let conn = library("cleared");
        store(&conn, "tmdb_api_key", "").unwrap();
        assert_eq!(status(&conn, 1), "unmatched");
    }
}
