//! Sign-ins to network shares, kept between runs, for the shares Kinema
//! opens itself (netshare.rs).
//!
//! The password is kept locked: on Android with a key held by the system's
//! key store (`NetworkPlugin.kt`), which never leaves the device — a copy of
//! the library, a safety copy included, does not carry a usable password.
//! A system without a key store keeps a sign-in for the session only; none
//! needs one yet, since Windows and Linux open shares themselves.
//!
//! The kept sign-ins are unlocked into memory when Kinema starts (`load`),
//! rather than read when a share is first used: a share can be read while
//! the library's connection is held (a resume point checking its file), and
//! reading the sign-in there would wait on that same connection forever.

use crate::library::Db;
use crate::netshare;
use crate::util::to_string_err;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Each sign-in is one setting: `share_login:<server>`.
const PREFIX: &str = "share_login:";

#[derive(Serialize, Deserialize)]
struct Kept {
    user: String,
    /// The password, locked by the key store.
    sealed: String,
}

#[cfg(target_os = "android")]
static PLUGIN: std::sync::OnceLock<tauri::plugin::PluginHandle<tauri::Wry>> = std::sync::OnceLock::new();

/// The Android half (the key store; finding servers), registered under the
/// name it is called by. Nothing on a computer.
pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(desktop)]
    return builder;
    #[cfg(mobile)]
    builder.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("network")
            .setup(|_app, api| {
                #[cfg(target_os = "android")]
                {
                    let handle = api.register_android_plugin("com.kinema.app", "NetworkPlugin")?;
                    let _ = PLUGIN.set(handle);
                }
                #[cfg(not(target_os = "android"))]
                let _ = api;
                Ok(())
            })
            .build(),
    )
}

/// Locks (`seal`) or unlocks (`unseal`) a password with the key store.
fn key_store(command: &str, text: &str) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        #[derive(Deserialize)]
        struct Answer {
            text: String,
        }
        let plugin = PLUGIN.get().ok_or("the key store is not ready")?;
        plugin
            .run_mobile_plugin::<Answer>(command, serde_json::json!({ "text": text }))
            .map(|a| a.text)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (command, text);
        Err("this system has no key store for Kinema".into())
    }
}

/// Unlocks the kept sign-ins into memory, once the library is open. On a
/// thread of its own: each is a call into Android. netshare waits for it
/// before it signs in anywhere.
pub fn load(app: &tauri::AppHandle) {
    let rows: Vec<(String, String)> = {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare("SELECT key, value FROM settings WHERE key LIKE 'share\\_login:%' ESCAPE '\\'") {
            Ok(s) => s,
            Err(e) => {
                crate::log!("network: could not read the kept sign-ins: {e}");
                netshare::logins_loaded();
                return;
            }
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    };
    std::thread::spawn(move || {
        for (key, value) in rows {
            let server = &key[PREFIX.len()..];
            let unlocked = serde_json::from_str::<Kept>(&value)
                .map_err(|e| e.to_string())
                .and_then(|kept| key_store("unseal", &kept.sealed).map(|password| (kept.user, password)));
            match unlocked {
                Ok((user, password)) => netshare::set_login(server, &user, &password),
                // Kinema reinstalled, or its data cleared: the key is gone.
                // The share asks again when it is next used.
                Err(e) => crate::log!("network: the sign-in for {server} could not be unlocked: {e}"),
            }
        }
        netshare::logins_loaded();
    });
}

#[derive(Serialize)]
pub struct SavedLogin {
    server: String,
    user: String,
}

/// The servers Kinema keeps a sign-in for, for Settings.
#[tauri::command]
pub fn share_logins(db: tauri::State<Db>) -> Result<Vec<SavedLogin>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings WHERE key LIKE 'share\\_login:%' ESCAPE '\\' ORDER BY key")
        .map_err(to_string_err)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(to_string_err)?;
    Ok(rows
        .flatten()
        .filter_map(|(key, value)| {
            let kept = serde_json::from_str::<Kept>(&value).ok()?;
            Some(SavedLogin { server: key[PREFIX.len()..].to_string(), user: kept.user })
        })
        .collect())
}

#[derive(Serialize)]
pub struct Saved {
    /// Kept for next time; false where this system cannot lock it, and it
    /// lasts until Kinema closes.
    kept: bool,
}

/// Signs in to a server (`nas`, or `nas:4450` off SMB's own port) and, if it
/// accepts the name and password, keeps them.
#[tauri::command]
pub async fn save_share_login(
    app: tauri::AppHandle,
    server: String,
    user: String,
    password: String,
) -> Result<Saved, String> {
    let server = server.trim().to_string();
    let user = user.trim().to_string();
    // The SMB library cannot finish a guest's sign-in yet (it waits for a
    // last step a guest never gets); said plainly rather than as its error.
    if user.is_empty() {
        return Err("Kinema cannot connect as a guest yet. Enter a user name and password.".into());
    }
    let before = netshare::login(&server);
    let tried = {
        let named = server.clone();
        let (server, user, password) = (server.clone(), user.clone(), password.clone());
        crate::jobs::off_main(move || {
            netshare::set_login(&server, &user, &password);
            netshare::try_sign_in(&server).map_err(|e| match e.kind() {
                std::io::ErrorKind::PermissionDenied => {
                    format!("{server} did not accept that user name and password.")
                }
                _ => format!("Could not reach {server}: {e}"),
            })
        })
        .await
        // A fault in Kinema while connecting (it is in the log): said as
        // that, so nobody retypes a password that was never the problem.
        .map_err(|e| {
            if e.starts_with("Something went wrong inside Kinema") {
                format!(
                    "Connecting to {named} failed because of a fault in Kinema, not your user name or password. What happened is in its log (Settings → Advanced)."
                )
            } else {
                e
            }
        })
    };
    if tried.is_err() {
        // A mistyped password leaves the sign-in that worked as it was.
        match before {
            Some((user, password)) => netshare::set_login(&server, &user, &password),
            None => netshare::forget_login(&server),
        }
    }
    tried?;
    let sealed = match key_store("seal", &password) {
        Ok(s) => s,
        Err(e) => {
            crate::log!("network: the sign-in for {server} is kept until Kinema closes: {e}");
            return Ok(Saved { kept: false });
        }
    };
    let value = serde_json::to_string(&Kept { user, sealed }).map_err(to_string_err)?;
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(to_string_err)?;
    crate::settings::store(&conn, &format!("{PREFIX}{server}"), &value)?;
    Ok(Saved { kept: true })
}

/// Forgets a server's sign-in, kept and in memory.
#[tauri::command]
pub fn forget_share_login(db: tauri::State<Db>, server: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    conn.execute("DELETE FROM settings WHERE key = ?1", params![format!("{PREFIX}{server}")])
        .map_err(to_string_err)?;
    netshare::forget_login(&server);
    Ok(())
}
