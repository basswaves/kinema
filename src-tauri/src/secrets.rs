//! Sign-ins and keys, sealed at rest (A6-02).
//!
//! The settings in `db::SECRET_SETTINGS` are kept locked: by DPAPI to the
//! Windows user, or by Android's key store. Kinema's settings code
//! (`settings::store`, `settings::setting`) does it, so every reader and writer
//! gets the plain value and no caller handles a lock. A value an older Kinema
//! kept as plain text is locked the first time it is read. Where nothing can
//! lock it (Linux, or a key store that does not answer) it stays as it is and
//! one line says so: a sign-in is never lost for the sake of locking it.
//! On Linux the data folder is readable by its owner only (`util::keep_private`).

use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, Ordering};

/// Is `key` one of the settings that hold a sign-in or a key?
pub fn is_secret(key: &str) -> bool {
    crate::db::SECRET_SETTINGS.contains(&key)
}

fn is_sealed(stored: &str) -> bool {
    stored.starts_with("dpapi:") || stored.starts_with("keystore:")
}

/// The locked form of `text`, or `None` where nothing can lock it.
pub fn seal(text: &str) -> Option<String> {
    #[cfg(windows)]
    if let Some(sealed) = dpapi::seal(text.as_bytes()) {
        return Some(format!("dpapi:{}", hex(&sealed)));
    }
    #[cfg(target_os = "android")]
    if let Ok(sealed) = crate::share_logins::key_store("seal", text) {
        return Some(format!("keystore:{sealed}"));
    }
    let _ = text;
    None
}

/// What a stored value says: a locked one is opened (`None` if it cannot be,
/// say another Windows user's), anything else is already plain.
pub fn open(stored: &str) -> Option<String> {
    #[cfg(target_os = "android")]
    if let Some(sealed) = stored.strip_prefix("keystore:") {
        return crate::share_logins::key_store("unseal", sealed).ok();
    }
    #[cfg(windows)]
    if let Some(sealed) = stored.strip_prefix("dpapi:") {
        let bytes = unhex(sealed)?;
        return dpapi::open(&bytes).and_then(|b| String::from_utf8(b).ok());
    }
    if is_sealed(stored) {
        return None;
    }
    Some(stored.to_string())
}

static SAID: AtomicBool = AtomicBool::new(false);

fn say_once() {
    if !SAID.swap(true, Ordering::Relaxed) {
        crate::log!("secrets: this system cannot lock sign-ins and keys; they are kept as they are");
    }
}

/// What to write for `value` of `key`: locked if it is a secret and can be.
pub fn for_storage(key: &str, value: &str) -> String {
    if !is_secret(key) || value.trim().is_empty() || is_sealed(value) {
        return value.to_string();
    }
    seal(value).unwrap_or_else(|| {
        say_once();
        value.to_string()
    })
}

/// A value read from the settings table: opened if locked; an old plain value
/// of a secret is locked in the table now, where that is possible.
pub fn from_storage(conn: &Connection, key: &str, stored: String) -> Option<String> {
    if !is_secret(key) {
        return Some(stored);
    }
    if is_sealed(&stored) {
        return open(&stored);
    }
    if !stored.trim().is_empty() {
        match seal(&stored) {
            Some(sealed) => {
                let _ = conn.execute("UPDATE settings SET value = ?2 WHERE key = ?1", [key, sealed.as_str()]);
            }
            None => say_once(),
        }
    }
    Some(stored)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(windows)]
mod dpapi {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn take(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: the blob was filled in by DPAPI, which owns `cbData` bytes at
        // `pbData` until LocalFree below.
        let out = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(blob.pbData as _)));
        }
        out
    }

    pub fn seal(data: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: input points at `data`, alive for the call; output is
        // allocated by DPAPI and freed in `take`.
        unsafe {
            CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
                .ok()?;
        }
        Some(take(&output))
    }

    pub fn open(data: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as in `seal`.
        unsafe {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
                .ok()?;
        }
        Some(take(&output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{setting, store};

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        conn
    }

    #[cfg(windows)]
    fn raw(conn: &Connection, key: &str) -> String {
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_secret_reads_back_and_is_locked_where_it_can_be() {
        let conn = conn();
        store(&conn, "simkl_access_token", "tok-123").unwrap();
        assert_eq!(setting(&conn, "simkl_access_token").as_deref(), Some("tok-123"));
        #[cfg(windows)]
        assert!(raw(&conn, "simkl_access_token").starts_with("dpapi:"));
    }

    #[test]
    fn an_old_plain_value_is_locked_on_first_read_and_never_lost() {
        let conn = conn();
        conn.execute("INSERT INTO settings VALUES ('omdb_api_key', 'old key')", []).unwrap();
        assert_eq!(setting(&conn, "omdb_api_key").as_deref(), Some("old key"));
        #[cfg(windows)]
        {
            let now = raw(&conn, "omdb_api_key");
            assert!(now.starts_with("dpapi:") && !now.contains("old key"));
        }
        assert_eq!(setting(&conn, "omdb_api_key").as_deref(), Some("old key"));
    }

    #[test]
    fn other_settings_are_left_as_they_are() {
        let conn = conn();
        store(&conn, "lang_audio", "nor").unwrap();
        assert_eq!(setting(&conn, "lang_audio").as_deref(), Some("nor"));
        assert_eq!(for_storage("lang_audio", "nor"), "nor");
        assert!(is_secret("trakt_client_secret") && !is_secret("trakt_user"));
    }

    #[test]
    fn a_locked_value_that_cannot_be_opened_is_not_read_as_text() {
        assert_eq!(open("dpapi:zz"), None);
        assert_eq!(open("plain text").as_deref(), Some("plain text"));
    }
}
