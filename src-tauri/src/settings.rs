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

/// Append a line from the frontend to `app.log` in the project's src-tauri
/// directory. This is the only way UI-side errors become readable from outside
/// the webview.
#[tauri::command]
pub fn append_log(level: String, message: String) -> Result<(), String> {
    use std::io::Write;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let line = format!("[{stamp}][{}] {}\n", level.to_uppercase(), message);

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("app.log")
        .map_err(to_string_err)?;

    file.write_all(line.as_bytes()).map_err(to_string_err)?;
    Ok(())
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
