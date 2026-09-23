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
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![&key, &value],
    )
    .map_err(to_string_err)?;
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
    use tauri::Manager;
    Ok(app.path().app_data_dir().map_err(to_string_err)?.join(crate::applog::DIR))
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
