//! Moving to a new computer (PLAN.md phase 2): what exists nowhere else, as
//! one file, taken in by another Kinema.
//!
//! The file holds the watch history and resume points (by the providers'
//! ids, as `watch_history` keeps them), the matches and "not a film"
//! decisions made by hand (by file name and size, since the path changes),
//! My list, the chosen versions and posters, the playlists, and the settings
//! that describe the person rather than this computer.
//!
//! **What it never holds**: a sign-in (SIMKL, Trakt, OpenSubtitles, a share's
//! login), a key or a password, this machine's devices and paths, and the
//! queue of watches waiting to be sent. On the new computer one signs in
//! again; SIMKL's and Trakt's at-connect rules then apply as they do to any
//! reconnect (SIMKL ignores a watch it has, Trakt is compared first), and
//! taking the file in queues nothing at all — what the old computer sent
//! stays sent. Taking it in never un-watches, and an older resume point never
//! replaces a newer one (`history::merge`), so a library that already has
//! history keeps it, and a later sync file can still win for what it covers.

use crate::history::{self, Carried};
use crate::library::Db;
use crate::settings::setting;
use crate::util::{now_secs, to_string_err};
use rusqlite::types::Value as Sql;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const FORMAT: i64 = 1;

/// Hand-made matches whose files were not here yet, as JSON, applied when
/// they appear (`moved_matches_ready`).
const PENDING_KEY: &str = "moved_hand_matches";

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct MoveFile {
    pub kinema_move: i64,
    pub made_at: i64,
    pub version: String,
    pub history: Vec<Value>,
    /// Table name → rows, for the tables named by the provider's ids.
    pub chosen: Map<String, Value>,
    pub hand: Vec<Hand>,
    pub playlists: Vec<Playlist>,
    pub settings: Map<String, Value>,
}

/// A decision made by hand about one file.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct Hand {
    pub file_name: String,
    pub size_bytes: i64,
    /// `match` or `ignore`.
    pub what: String,
    pub kind: Option<String>,
    pub provider: Option<String>,
    pub provider_id: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Playlist {
    pub name: String,
    pub shuffle: i64,
    pub repeat_all: i64,
    pub items: Vec<PlaylistItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistItem {
    pub path: String,
    pub file_name: String,
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Serialize, Default, PartialEq)]
pub struct MoveReport {
    pub history: usize,
    pub chosen: usize,
    pub hand_applied: usize,
    pub hand_waiting: usize,
    pub playlists: usize,
    pub settings: usize,
}

/// Tables named by the provider's ids, and the columns carried.
const CHOSEN: [(&str, &[&str]); 3] = [
    ("my_list", &["kind", "provider", "provider_id", "imdb_id", "tmdb_id", "added_at"]),
    (
        "version_choice",
        &["kind", "provider", "provider_id", "imdb_id", "tmdb_id", "path", "key", "updated_at"],
    ),
    ("poster_choice", &["kind", "provider", "provider_id", "imdb_id", "tmdb_id", "url", "updated_at"]),
];

/// Whether a setting goes with the person to a new computer. Sign-ins, keys
/// and passwords never do; nor does what describes this machine — its sound
/// and screen devices, its paths, what it was found to manage, its first run.
pub fn carried_setting(key: &str) -> bool {
    const MACHINE: [&str; 22] = [
        "simkl_", "trakt_", "share_login:", "tmdb_builtin", "tmdb_api_host", "omdb_scores",
        "imdb_ratings", "audio_device", "audio_direct", "audio_delay", "display_", "equipment",
        "player_step_down", "video_sync", "ffmpeg", "skiptro_", "setup_pages", "tv_mode", "look",
        "quality_notice", "moved_", "update_",
    ];
    const SECRET: [&str; 7] = ["token", "password", "secret", "api_key", "_path", "_args", "_devices"];
    if key == "opensubtitles_forced" {
        return true;
    }
    !(key.starts_with("opensubtitles_")
        || MACHINE.iter().any(|p| key.starts_with(p))
        || SECRET.iter().any(|s| key.contains(s)))
}

fn json_of(v: Sql) -> Value {
    match v {
        Sql::Null => Value::Null,
        Sql::Integer(i) => i.into(),
        Sql::Real(f) => f.into(),
        Sql::Text(s) => s.into(),
        Sql::Blob(_) => Value::Null,
    }
}

fn sql_of(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn rows(conn: &Connection, sql: &str, cols: &[&str]) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let out = stmt
        .query_map([], |r| {
            let mut m = Map::new();
            for (i, c) in cols.iter().enumerate() {
                m.insert((*c).to_string(), json_of(r.get::<_, Sql>(i)?));
            }
            Ok(Value::Object(m))
        })?
        .collect();
    out
}

const HISTORY_COLS: [&str; 12] = [
    "kind", "provider", "provider_id", "imdb_id", "tmdb_id", "season", "episode", "label",
    "position_secs", "duration_secs", "completed", "updated_at",
];

/// Everything that moves, read from this library.
pub fn export(conn: &Connection) -> rusqlite::Result<MoveFile> {
    let history = rows(conn, &format!("SELECT {} FROM watch_history", HISTORY_COLS.join(", ")), &HISTORY_COLS)?;
    let mut chosen = Map::new();
    for (table, cols) in CHOSEN {
        chosen.insert(
            table.to_string(),
            Value::Array(rows(conn, &format!("SELECT {} FROM {table}", cols.join(", ")), cols)?),
        );
    }
    let mut stmt = conn.prepare(
        "SELECT m.file_name, m.size_bytes,
                CASE WHEN m.match_reason = 'ignored by hand' THEN 'ignore' ELSE 'match' END,
                t.kind, t.provider, t.provider_id, m.match_reason
           FROM media_files m LEFT JOIN titles t ON t.id = m.title_id
          WHERE (m.match_reason LIKE 'manual:%' AND t.id IS NOT NULL)
             OR m.match_reason = 'ignored by hand'",
    )?;
    let hand = stmt
        .query_map([], |r| {
            Ok(Hand {
                file_name: r.get(0)?,
                size_bytes: r.get(1)?,
                what: r.get(2)?,
                kind: r.get(3)?,
                provider: r.get(4)?,
                provider_id: r.get(5)?,
                reason: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut playlists = Vec::new();
    let mut stmt = conn.prepare("SELECT id, name, shuffle, repeat_all FROM playlists ORDER BY id")?;
    let lists = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<Vec<(i64, String, i64, i64)>>>()?;
    for (id, name, shuffle, repeat_all) in lists {
        let mut items = conn.prepare(
            "SELECT i.path, m.file_name, m.size_bytes FROM playlist_items i
               LEFT JOIN media_files m ON m.id = i.file_id
              WHERE i.playlist_id = ?1 ORDER BY i.position",
        )?;
        let items = items
            .query_map([id], |r| {
                let path: String = r.get(0)?;
                let name: Option<String> = r.get(1)?;
                Ok(PlaylistItem {
                    file_name: name.unwrap_or_else(|| file_name_of(&path)),
                    path,
                    size_bytes: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        playlists.push(Playlist { name, shuffle, repeat_all, items });
    }
    let mut settings = Map::new();
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (k, v) = row?;
        if carried_setting(&k) {
            settings.insert(k, v.into());
        }
    }
    Ok(MoveFile {
        kinema_move: FORMAT,
        made_at: now_secs(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        history,
        chosen,
        hand,
        playlists,
        settings,
    })
}

fn file_name_of(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

fn text(v: &Value, k: &str) -> Option<String> {
    v[k].as_str().map(str::to_string)
}

/// The files here with this name and size, present ones first.
fn files_named(conn: &Connection, name: &str, size: Option<i64>) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, path FROM media_files WHERE file_name = ?1 AND (?2 IS NULL OR size_bytes = ?2)
          ORDER BY missing, id",
    )?;
    let out = stmt.query_map(params![name, size], |r| Ok((r.get(0)?, r.get(1)?)))?.collect();
    out
}

/// Take a moved library in. Queues nothing for SIMKL or Trakt.
pub fn import(conn: &mut Connection, file: &MoveFile) -> Result<MoveReport, String> {
    if file.kinema_move != FORMAT {
        return Err(format!(
            "This file was made by a newer Kinema (format {}). Update Kinema here first.",
            file.kinema_move
        ));
    }
    let mut report = MoveReport::default();
    let tx = conn.transaction().map_err(to_string_err)?;

    for h in &file.history {
        let num = |k: &str| h[k].as_f64();
        let carried = Carried {
            kind: text(h, "kind").unwrap_or_default(),
            provider: text(h, "provider").unwrap_or_default(),
            provider_id: text(h, "provider_id").unwrap_or_default(),
            imdb_id: text(h, "imdb_id"),
            tmdb_id: text(h, "tmdb_id"),
            season: h["season"].as_i64(),
            episode: h["episode"].as_i64(),
            label: text(h, "label").unwrap_or_default(),
            position_secs: num("position_secs").unwrap_or(0.0),
            duration_secs: num("duration_secs"),
            completed: h["completed"].as_i64().unwrap_or(0) != 0,
            updated_at: h["updated_at"].as_i64().unwrap_or(0),
        };
        if carried.kind.is_empty() || carried.provider.is_empty() {
            continue;
        }
        if history::merge(&tx, &carried).map_err(to_string_err)? != history::Merged::Kept {
            report.history += 1;
        }
    }

    for (table, cols) in CHOSEN {
        let sql = format!(
            "INSERT OR IGNORE INTO {table} ({}) VALUES ({})",
            cols.join(", "),
            vec!["?"; cols.len()].join(", ")
        );
        for row in file.chosen.get(table).and_then(Value::as_array).into_iter().flatten() {
            let values: Vec<Sql> = cols.iter().map(|c| sql_of(&row[*c])).collect();
            report.chosen += tx
                .execute(&sql, rusqlite::params_from_iter(values))
                .map_err(to_string_err)?;
        }
    }

    // Hand-made decisions wait for their files; those here are applied now
    // (ignores) or by the matcher's next run (matches, `moved_matches_ready`).
    let mut pending: Vec<Hand> = setting(&tx, PENDING_KEY)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for h in &file.hand {
        if h.what == "ignore" {
            let ids: Vec<i64> = files_named(&tx, &h.file_name, Some(h.size_bytes))
                .map_err(to_string_err)?
                .into_iter()
                .map(|(id, _)| id)
                .collect();
            if !ids.is_empty() {
                // As lifecycle::ignored, inside this transaction.
                for id in ids {
                    tx.execute(
                        "UPDATE media_files
                            SET title_id = NULL, match_confidence = NULL,
                                match_reason = 'ignored by hand', match_status = 'ignored'
                          WHERE id = ?1",
                        [id],
                    )
                    .map_err(to_string_err)?;
                }
                report.hand_applied += 1;
                continue;
            }
        }
        if !pending.contains(h) {
            pending.push(h.clone());
        }
    }
    report.hand_waiting = pending.iter().filter(|h| h.what == "match").count();
    store_pending(&tx, &pending)?;

    for list in &file.playlists {
        let exists: bool = tx
            .query_row("SELECT EXISTS (SELECT 1 FROM playlists WHERE name = ?1)", [&list.name], |r| r.get(0))
            .map_err(to_string_err)?;
        if exists {
            continue;
        }
        let now = now_secs();
        tx.execute(
            "INSERT INTO playlists (name, shuffle, repeat_all, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![list.name, list.shuffle, list.repeat_all, now],
        )
        .map_err(to_string_err)?;
        let id = tx.last_insert_rowid();
        for (position, item) in list.items.iter().enumerate() {
            let here = files_named(&tx, &item.file_name, item.size_bytes).map_err(to_string_err)?;
            let (file_id, path) = match here.into_iter().next() {
                Some((id, path)) => (Some(id), path),
                None => (None, item.path.clone()),
            };
            tx.execute(
                "INSERT INTO playlist_items (playlist_id, position, file_id, path) VALUES (?1, ?2, ?3, ?4)",
                params![id, position as i64, file_id, path],
            )
            .map_err(to_string_err)?;
        }
        report.playlists += 1;
    }

    for (k, v) in &file.settings {
        if let (true, Some(v)) = (carried_setting(k), v.as_str()) {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![k, v],
            )
            .map_err(to_string_err)?;
            report.settings += 1;
        }
    }
    tx.commit().map_err(to_string_err)?;
    Ok(report)
}

fn store_pending(conn: &Connection, pending: &[Hand]) -> Result<(), String> {
    if pending.is_empty() {
        conn.execute("DELETE FROM settings WHERE key = ?1", [PENDING_KEY]).map_err(to_string_err)?;
        return Ok(());
    }
    let json = serde_json::to_string(pending).map_err(to_string_err)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![PENDING_KEY, json],
    )
    .map_err(to_string_err)?;
    Ok(())
}

/// A moved hand-made match whose file is here now.
#[derive(Debug, Serialize, PartialEq)]
pub struct ReadyMatch {
    pub file_ids: Vec<i64>,
    pub file_name: String,
    pub size_bytes: i64,
    pub kind: String,
    pub provider: String,
    pub provider_id: String,
    pub reason: String,
}

/// The waiting matches whose files are here; ones already matched so are
/// dropped from the waiting list.
pub fn ready(conn: &Connection) -> Result<Vec<ReadyMatch>, String> {
    let pending: Vec<Hand> = setting(conn, PENDING_KEY)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut keep = Vec::new();
    let mut out = Vec::new();
    for h in pending {
        let (Some(kind), Some(provider), Some(provider_id)) = (&h.kind, &h.provider, &h.provider_id) else {
            continue;
        };
        if h.what != "match" {
            keep.push(h);
            continue;
        }
        let mut stmt = conn
            .prepare_cached(
                "SELECT m.id, t.provider = ?3 AND t.provider_id = ?4 FROM media_files m
                   LEFT JOIN titles t ON t.id = m.title_id
                  WHERE m.file_name = ?1 AND m.size_bytes = ?2",
            )
            .map_err(to_string_err)?;
        let files = stmt
            .query_map(params![h.file_name, h.size_bytes, provider, provider_id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Option<bool>>(1)?.unwrap_or(false)))
            })
            .map_err(to_string_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(to_string_err)?;
        let todo: Vec<i64> = files.iter().filter(|(_, done)| !done).map(|(id, _)| *id).collect();
        if files.is_empty() {
            keep.push(h);
        } else if !todo.is_empty() {
            out.push(ReadyMatch {
                file_ids: todo,
                file_name: h.file_name.clone(),
                size_bytes: h.size_bytes,
                kind: kind.clone(),
                provider: provider.clone(),
                provider_id: provider_id.clone(),
                reason: h.reason.clone().unwrap_or_else(|| "manual: moved".into()),
            });
            keep.push(h);
        }
    }
    store_pending(conn, &keep)?;
    Ok(out)
}

/// A waiting match was applied (or failed for good): it waits no longer.
pub fn done(conn: &Connection, file_name: &str, size_bytes: i64) -> Result<(), String> {
    let mut pending: Vec<Hand> = setting(conn, PENDING_KEY)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    pending.retain(|h| !(h.file_name == file_name && h.size_bytes == size_bytes));
    store_pending(conn, &pending)
}

// ---- commands -------------------------------------------------------------------

#[tauri::command]
pub fn export_move(db: tauri::State<Db>, path: String) -> Result<usize, String> {
    let file = {
        let conn = db.0.lock().map_err(to_string_err)?;
        export(&conn).map_err(to_string_err)?
    };
    let json = serde_json::to_vec_pretty(&file).map_err(to_string_err)?;
    std::fs::write(&path, json).map_err(|e| format!("The file could not be written: {e}"))?;
    crate::log!(
        "move: wrote {} history rows, {} hand-made decisions, {} playlists, {} settings",
        file.history.len(), file.hand.len(), file.playlists.len(), file.settings.len()
    );
    Ok(file.history.len())
}

#[tauri::command]
pub fn import_move(db: tauri::State<Db>, path: String) -> Result<MoveReport, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("The file could not be read: {e}"))?;
    let file: MoveFile = serde_json::from_slice(&bytes)
        .map_err(|_| "This is not a file made by Move to a new computer.".to_string())?;
    let mut conn = db.0.lock().map_err(to_string_err)?;
    let report = import(&mut conn, &file)?;
    crate::log!("move: took in {report:?}");
    Ok(report)
}

#[tauri::command]
pub fn moved_matches_ready(db: tauri::State<Db>) -> Result<Vec<ReadyMatch>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    ready(&conn)
}

#[tauri::command]
pub fn moved_match_done(db: tauri::State<Db>, file_name: String, size_bytes: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    done(&conn, &file_name, size_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library(tag: &str) -> Connection {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pn-move-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("library.db")).unwrap();
        // The same films on both computers, under other folders.
        let root = if tag == "old" { "C:/films" } else { "/media/films" };
        conn.execute_batch(&format!(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, '{root}', 'movies', 0);
             INSERT INTO titles (id, kind, provider, provider_id, imdb_id, tmdb_id, title, fetched_at) VALUES
                (1, 'movie', 'tmdb', '100', 'tt0000100', '100', 'Example Film', 0),
                (2, 'series', 'tmdb', '200', 'tt0000200', '200', 'Example Show', 0);
             INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension, size_bytes,
                 modified_at, first_seen_at, last_seen_at, match_status, title_id, parsed_title,
                 parsed_season, parsed_episode) VALUES
                (1, 1, '{root}/a.mkv', '{root}', 'a.mkv', 'mkv', 11, 0, 0, 0, 'matched', 1, 'a', NULL, NULL),
                (2, 1, '{root}/s01e02.mkv', '{root}', 's01e02.mkv', 'mkv', 22, 0, 0, 0, 'matched', 2, 's', 1, 2),
                (3, 1, '{root}/sample.mkv', '{root}', 'sample.mkv', 'mkv', 33, 0, 0, 0, 'parsed', NULL, 'x', NULL, NULL),
                (4, 1, '{root}/odd.mkv', '{root}', 'odd.mkv', 'mkv', 44, 0, 0, 0, 'parsed', NULL, 'odd', NULL, NULL);"
        ))
        .unwrap();
        conn
    }

    fn watch(conn: &Connection, file: i64, pos: f64, done: bool, at: i64) {
        conn.execute(
            "INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at)
             VALUES (?1, ?2, 3000, ?3, ?4)",
            params![file, pos, done as i64, at],
        )
        .unwrap();
        history::remember(conn, file).unwrap();
    }

    type Row = (String, Option<i64>, Option<i64>, f64, i64, i64);

    fn history_rows(conn: &Connection) -> Vec<Row> {
        let mut s = conn
            .prepare(
                "SELECT provider_id, season, episode, position_secs, completed, updated_at
                   FROM watch_history ORDER BY provider_id, season, episode",
            )
            .unwrap();
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn connect(conn: &Connection, service: &str) {
        crate::tracking::save_tokens(
            conn,
            service,
            &crate::tracking::Tokens { access: "a".into(), refresh: "r".into(), expires_at: i64::MAX },
        )
        .unwrap();
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_library_moves_whole_and_nothing_is_sent_again() {
        let old = library("old");
        connect(&old, crate::tracking::SIMKL);
        watch(&old, 1, 2900.0, true, 1_000);
        watch(&old, 2, 600.0, false, 2_000);
        old.execute_batch(
            "INSERT INTO my_list (kind, provider, provider_id, imdb_id, tmdb_id, added_at)
                 VALUES ('movie', 'tmdb', '100', 'tt0000100', '100', 5);
             UPDATE media_files SET match_status = 'ignored', match_reason = 'ignored by hand' WHERE id = 3;
             INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at)
                 VALUES (3, 'movie', 'tmdb', '777', 'Odd Film', 0);
             UPDATE media_files SET match_status = 'matched', title_id = 3, match_reason = 'manual: picked'
              WHERE id = 4;
             INSERT INTO playlists (id, name, created_at, updated_at) VALUES (1, 'Weekend', 0, 0);
             INSERT INTO playlist_items (playlist_id, position, file_id, path)
                 VALUES (1, 0, 1, 'C:/films/a.mkv');
             INSERT INTO settings (key, value) VALUES ('lang_audio', 'nor'), ('audio_device', 'wasapi/x'),
                 ('opensubtitles_password', 'p'), ('share_login:nas', 'u'), ('omdb_api_key', 'k'),
                 ('subtitle_style', '{}'), ('opensubtitles_forced', 'on');",
        )
        .unwrap();
        assert_eq!(count(&old, "SELECT COUNT(*) FROM watch_outbox"), 1, "the old one queued its watch");

        let file = export(&old).unwrap();
        let json = serde_json::to_string(&file).unwrap();
        for secret in ["access_token", "refresh_token", "opensubtitles_password", "share_login", "omdb_api_key", "wasapi"] {
            assert!(!json.contains(secret), "{secret} must not leave");
        }

        let mut new = library("new");
        // Signed in on the new computer before moving in: still nothing is queued.
        connect(&new, crate::tracking::SIMKL);
        connect(&new, crate::tracking::TRAKT);
        let back: MoveFile = serde_json::from_str(&json).unwrap();
        let report = import(&mut new, &back).unwrap();

        assert_eq!(history_rows(&new), history_rows(&old));
        assert_eq!(count(&new, "SELECT completed FROM playback_state WHERE file_id = 1"), 1);
        assert_eq!(count(&new, "SELECT CAST(position_secs AS INTEGER) FROM playback_state WHERE file_id = 2"), 600);
        assert_eq!(count(&new, "SELECT COUNT(*) FROM watch_outbox"), 0, "nothing sent again");
        assert!(setting(&new, crate::trakt::HISTORY_DUE_KEY).is_none());
        assert_eq!(count(&new, "SELECT COUNT(*) FROM my_list"), 1);
        assert_eq!(count(&new, "SELECT match_status = 'ignored' FROM media_files WHERE id = 3"), 1);
        assert_eq!(setting(&new, "lang_audio").as_deref(), Some("nor"));
        assert_eq!(setting(&new, "opensubtitles_forced").as_deref(), Some("on"));
        assert!(setting(&new, "audio_device").is_none());
        assert!(setting(&new, "omdb_api_key").is_none());
        assert_eq!(
            count(&new, "SELECT COUNT(*) FROM playlist_items WHERE file_id = 1 AND path = '/media/films/a.mkv'"),
            1,
            "the playlist points at the file here"
        );
        assert_eq!((report.playlists, report.hand_applied, report.hand_waiting), (1, 1, 1));

        // The hand-made match is offered to the matcher until it is done.
        let ready_now = ready(&new).unwrap();
        assert_eq!(ready_now.len(), 1);
        assert_eq!((ready_now[0].file_ids.clone(), ready_now[0].provider_id.as_str()), (vec![4], "777"));
        done(&new, "odd.mkv", 44).unwrap();
        assert!(ready(&new).unwrap().is_empty());

        // Taken in twice: nothing doubles, nothing is sent.
        import(&mut new, &back).unwrap();
        assert_eq!(history_rows(&new), history_rows(&old));
        assert_eq!(count(&new, "SELECT COUNT(*) FROM playlists"), 1);
        assert_eq!(count(&new, "SELECT COUNT(*) FROM watch_outbox"), 0);
    }

    #[test]
    fn newer_history_here_is_kept() {
        let old = library("old");
        watch(&old, 2, 600.0, false, 2_000);
        let file = export(&old).unwrap();
        let mut new = library("new");
        watch(&new, 2, 900.0, false, 3_000);
        watch(&new, 1, 2900.0, true, 500);
        import(&mut new, &file).unwrap();
        assert_eq!(count(&new, "SELECT CAST(position_secs AS INTEGER) FROM playback_state WHERE file_id = 2"), 900);
        assert_eq!(count(&new, "SELECT completed FROM playback_state WHERE file_id = 1"), 1);
    }

    #[test]
    fn secrets_and_this_machine_stay() {
        for k in [
            "simkl_access_token", "trakt_resume", "opensubtitles_username", "share_login:x", "tmdb_api_key",
            "ffmpeg_path", "audio_direct_devices", "display_match", "setup_pages", "tv_mode",
        ] {
            assert!(!carried_setting(k), "{k}");
        }
        for k in ["lang_audio", "lang_subs", "subtitle_style", "collections", "still_watching", "opensubtitles_forced", "volume"] {
            assert!(carried_setting(k), "{k}");
        }
    }
}
