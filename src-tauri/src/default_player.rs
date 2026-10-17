//! Offering Kinema to Windows as a video player (Settings → Playback).
//!
//! Windows does not let a program make itself the default for anything: the
//! choice is the user's, made in Settings → Default apps, and protected so no
//! program can write it. What a program can do is say what it opens. This
//! writes that, for this Windows account only (HKCU, no administrator), and
//! then opens Kinema's page in Default apps, where the user picks.
//!
//! What is written, all under `HKCU\Software`:
//!
//!  * `Classes\Kinema.Video` — how a video is opened with Kinema: the program
//!    with the file after it, and its icon.
//!  * `Classes\.mkv\OpenWithProgids\Kinema.Video` and the same for every
//!    other extension the library scans — Kinema in each type's "Open with".
//!  * `Classes\Applications\kinema.exe` — Kinema's name in those lists.
//!  * `Kinema\Capabilities` and `RegisteredApplications\Kinema` — Kinema in
//!    Default apps, with the types it can open.
//!
//! Remove takes every one of those away again, and the empty keys it leaves
//! under a type. Nothing outside these is touched: never another program's
//! entries, never the user's choice of default.
//!
//! The folder Kinema runs from can move (it is a ZIP), so at launch an offer
//! that names another place is written again for this one (`refresh`).

// The offer's shape is built and tested everywhere; only Windows writes it.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;

/// The name Windows lists Kinema under in Default apps.
const APP: &str = "Kinema";
/// How a video opened with Kinema is described to Windows.
const PROG_ID: &str = "Kinema.Video";

#[derive(Serialize)]
pub struct PlayerOffer {
    /// Kinema is offered to Windows as a video player.
    pub offered: bool,
}

/// One value to write: under `key`, `name` (None for the key's default) set
/// to `data`.
#[derive(Debug, PartialEq)]
struct Value {
    key: String,
    name: Option<String>,
    data: String,
}

fn value(key: String, name: Option<&str>, data: impl Into<String>) -> Value {
    Value { key, name: name.map(str::to_owned), data: data.into() }
}

/// Everything an offer writes, under `base` (`Software`, or a scratch key in
/// the tests), for the program at `exe` named `exe_name`.
fn offer_values(base: &str, exe: &str, exe_name: &str, extensions: &[&str]) -> Vec<Value> {
    let command = format!("\"{exe}\" \"%1\"");
    let icon = format!("\"{exe}\",0");
    let prog = format!(r"{base}\Classes\{PROG_ID}");
    let app = format!(r"{base}\Classes\Applications\{exe_name}");
    let caps = format!(r"{base}\{APP}\Capabilities");
    let mut values = vec![
        value(prog.clone(), None, "Video"),
        value(format!(r"{prog}\DefaultIcon"), None, icon.clone()),
        value(format!(r"{prog}\shell\open\command"), None, command.clone()),
        value(app.clone(), Some("FriendlyAppName"), APP),
        value(format!(r"{app}\shell\open\command"), None, command),
        value(caps.clone(), Some("ApplicationName"), APP),
        value(
            caps.clone(),
            Some("ApplicationDescription"),
            "Plays your films, shows and videos.",
        ),
        value(caps.clone(), Some("ApplicationIcon"), icon),
    ];
    for ext in extensions {
        let ext = format!(".{ext}");
        values.push(value(format!(r"{app}\SupportedTypes"), Some(&ext), ""));
        values.push(value(format!(r"{base}\Classes\{ext}\OpenWithProgids"), Some(PROG_ID), ""));
        values.push(value(format!(r"{caps}\FileAssociations"), Some(&ext), PROG_ID));
    }
    values.push(value(
        format!(r"{base}\RegisteredApplications"),
        Some(APP),
        format!(r"{base}\{APP}\Capabilities"),
    ));
    values
}

/// The command an offer writes, to compare with what is there.
fn command_key(base: &str) -> String {
    format!(r"{base}\Classes\{PROG_ID}\shell\open\command")
}

#[cfg(windows)]
mod registry {
    //! The few registry calls the offer needs, on `HKEY_CURRENT_USER` only.

    use super::Value;
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_NO_MORE_ITEMS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteKeyValueW, RegDeleteKeyW, RegDeleteTreeW,
        RegEnumKeyExW, RegEnumValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
    };

    fn name(name: &Option<String>) -> Option<HSTRING> {
        name.as_deref().map(HSTRING::from)
    }

    fn pcwstr(s: &Option<HSTRING>) -> PCWSTR {
        s.as_ref().map_or(PCWSTR::null(), |h| PCWSTR(h.as_ptr()))
    }

    pub fn write(v: &Value) -> Result<(), String> {
        let key = HSTRING::from(v.key.as_str());
        let mut handle = HKEY::default();
        // SAFETY: every pointer is valid for the call; the handle is closed below.
        let made = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                &key,
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                None,
                &mut handle,
                None,
            )
        };
        if made.is_err() {
            return Err(format!("could not create {}: {made:?}", v.key));
        }
        let data: Vec<u16> = v.data.encode_utf16().chain(Some(0)).collect();
        // SAFETY: `data` outlives the call; its bytes are the UTF-16 string.
        let bytes = unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), data.len() * 2) };
        let value_name = name(&v.name);
        // SAFETY: an open handle and a valid buffer.
        let set = unsafe { RegSetValueExW(handle, pcwstr(&value_name), None, REG_SZ, Some(bytes)) };
        // SAFETY: the handle opened above.
        let _ = unsafe { RegCloseKey(handle) };
        if set.is_err() {
            return Err(format!("could not write {}: {set:?}", v.key));
        }
        Ok(())
    }

    /// A string value, or None when it or its key is not there.
    pub fn read(key: &str, value: Option<&str>) -> Option<String> {
        let key = HSTRING::from(key);
        let value_name = value.map(HSTRING::from);
        let mut buffer = vec![0u16; 2048];
        let mut size = (buffer.len() * 2) as u32;
        // SAFETY: `buffer` is `size` bytes long and lives across the call.
        let got = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &key,
                pcwstr(&value_name),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if got.is_err() {
            return None;
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..len]))
    }

    /// Whether a key exists.
    #[cfg(test)]
    pub fn exists(key: &str) -> bool {
        let key = HSTRING::from(key);
        let mut handle = HKEY::default();
        // SAFETY: valid pointers; the handle is closed when opened.
        let opened = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, &key, None, KEY_READ, &mut handle) };
        if opened.is_err() {
            return false;
        }
        // SAFETY: the handle opened above.
        let _ = unsafe { RegCloseKey(handle) };
        true
    }

    /// A key and everything under it. Gone already is fine.
    pub fn delete_tree(key: &str) {
        let key = HSTRING::from(key);
        // SAFETY: a valid string; nothing is held afterwards.
        unsafe {
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &key);
            let _ = RegDeleteKeyW(HKEY_CURRENT_USER, &key);
        }
    }

    /// One value. Gone already is fine.
    pub fn delete_value(key: &str, value: &str) {
        let key = HSTRING::from(key);
        let value = HSTRING::from(value);
        // SAFETY: valid strings.
        let _ = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, &key, &value) };
    }

    /// Delete `key` if nothing is in it: no values (the default included) and
    /// no keys. A key holding anything belongs to someone else as well.
    pub fn delete_if_empty(key: &str) {
        let wide = HSTRING::from(key);
        let mut handle = HKEY::default();
        // SAFETY: valid pointers; the handle is closed below.
        let opened = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, &wide, None, KEY_READ, &mut handle) };
        if opened.is_err() {
            return;
        }
        let mut buffer = [0u16; 512];
        let mut len = buffer.len() as u32;
        // SAFETY: an open handle and a buffer of `len` characters.
        let no_values = unsafe {
            RegEnumValueW(handle, 0, Some(PWSTR(buffer.as_mut_ptr())), &mut len, None, None, None, None)
        } == ERROR_NO_MORE_ITEMS;
        let mut len = buffer.len() as u32;
        // SAFETY: as above.
        let no_keys = unsafe {
            RegEnumKeyExW(handle, 0, Some(PWSTR(buffer.as_mut_ptr())), &mut len, None, None, None, None)
        } == ERROR_NO_MORE_ITEMS;
        // SAFETY: the handle opened above.
        let _ = unsafe { RegCloseKey(handle) };
        if no_values && no_keys {
            // SAFETY: a valid string.
            let _ = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, &wide) };
        }
    }
}

#[cfg(windows)]
mod offer {
    use super::*;

    pub fn exe() -> Result<(String, String), String> {
        let path = std::env::current_exe().map_err(|e| e.to_string())?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or("Kinema's program file has no name")?;
        Ok((path.to_string_lossy().into_owned(), name))
    }

    pub fn write(base: &str, exe: &str, exe_name: &str) -> Result<(), String> {
        for v in offer_values(base, exe, exe_name, crate::scanner::video_extensions()) {
            registry::write(&v)?;
        }
        Ok(())
    }

    pub fn is_offered(base: &str) -> bool {
        registry::read(&format!(r"{base}\RegisteredApplications"), Some(APP)).is_some()
    }

    pub fn remove(base: &str, exe_name: &str) {
        registry::delete_value(&format!(r"{base}\RegisteredApplications"), APP);
        registry::delete_tree(&format!(r"{base}\Classes\{PROG_ID}"));
        registry::delete_tree(&format!(r"{base}\Classes\Applications\{exe_name}"));
        registry::delete_tree(&format!(r"{base}\{APP}\Capabilities"));
        registry::delete_if_empty(&format!(r"{base}\{APP}"));
        for ext in crate::scanner::video_extensions() {
            let type_key = format!(r"{base}\Classes\.{ext}");
            let progids = format!(r"{type_key}\OpenWithProgids");
            registry::delete_value(&progids, PROG_ID);
            registry::delete_if_empty(&progids);
            registry::delete_if_empty(&type_key);
        }
    }

    /// What the offer's command is now, and what it would be for this program.
    pub fn stale(base: &str, exe: &str) -> bool {
        let wanted = format!("\"{exe}\" \"%1\"");
        registry::read(&command_key(base), None).is_some_and(|now| now != wanted)
    }

    #[cfg(test)]
    pub fn exists(key: &str) -> bool {
        registry::exists(key)
    }
}

/// The real place: this account's `Software`.
#[cfg(windows)]
const BASE: &str = "Software";

/// Whether Kinema is offered to Windows as a video player.
#[tauri::command]
pub fn player_offer() -> PlayerOffer {
    #[cfg(windows)]
    {
        PlayerOffer { offered: offer::is_offered(BASE) }
    }
    #[cfg(not(windows))]
    {
        PlayerOffer { offered: false }
    }
}

/// Offer Kinema to Windows, then open its page in Default apps for the user to
/// choose what it opens.
#[tauri::command]
pub fn offer_as_player(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let (exe, name) = offer::exe()?;
        offer::write(BASE, &exe, &name)?;
        crate::log!("default player: offered to Windows ({exe})");
        open_default_apps(app)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Only Windows is offered a video player this way.".into())
    }
}

/// Kinema's page in Settings → Default apps.
#[tauri::command]
pub fn open_default_apps(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(format!("ms-settings:defaultapps?registeredAppUser={APP}"), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Take back everything an offer wrote.
#[tauri::command]
pub fn remove_as_player() -> Result<(), String> {
    #[cfg(windows)]
    {
        let (_, name) = offer::exe()?;
        offer::remove(BASE, &name);
        crate::log!("default player: offer to Windows removed");
        if offer::is_offered(BASE) {
            return Err("Windows kept Kinema's entry; try again.".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

/// At launch: an offer naming another place for Kinema (the folder was moved)
/// is written again for this one, quietly. Release builds only — a
/// development build must not take over the entries of the copy in use.
pub fn refresh() {
    #[cfg(windows)]
    if !cfg!(debug_assertions) && crate::selftest::plan_path().is_none() {
        let Ok((exe, name)) = offer::exe() else { return };
        if offer::is_offered(BASE) && offer::stale(BASE, &exe) {
            match offer::write(BASE, &exe, &name) {
                Ok(()) => crate::log!("default player: Kinema has moved; the offer now names {exe}"),
                Err(e) => crate::log!("default player: could not update the offer: {e}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_offer_names_every_type_and_the_command() {
        let values = offer_values("Software", r"C:\Kinema\kinema.exe", "kinema.exe", &["mkv", "mp4"]);
        let has = |key: &str, name: Option<&str>, data: &str| {
            values.iter().any(|v| v.key == key && v.name.as_deref() == name && v.data == data)
        };
        assert!(has(
            r"Software\Classes\Kinema.Video\shell\open\command",
            None,
            r#""C:\Kinema\kinema.exe" "%1""#
        ));
        assert!(has(r"Software\Classes\.mkv\OpenWithProgids", Some("Kinema.Video"), ""));
        assert!(has(r"Software\Classes\.mp4\OpenWithProgids", Some("Kinema.Video"), ""));
        assert!(has(r"Software\Kinema\Capabilities\FileAssociations", Some(".mkv"), "Kinema.Video"));
        assert!(has(
            r"Software\RegisteredApplications",
            Some("Kinema"),
            r"Software\Kinema\Capabilities"
        ));
        assert!(has(r"Software\Classes\Applications\kinema.exe", Some("FriendlyAppName"), "Kinema"));
    }

    /// The real calls, on a scratch key of this account that names no type
    /// Windows reads (`Software\KinemaTest-…\Classes` is not `Software\Classes`),
    /// so the test changes nothing about how any file opens. Offer, find it
    /// offered, notice a moved program, remove, and find nothing left.
    #[cfg(windows)]
    #[test]
    fn an_offer_is_written_and_removed_without_a_trace() {
        let base = format!(r"Software\KinemaTest-{}", std::process::id());
        let exe = r"C:\Old place\kinema.exe";
        offer::write(&base, exe, "kinema.exe").unwrap();
        assert!(offer::is_offered(&base));
        assert!(!offer::stale(&base, exe));
        assert!(offer::stale(&base, r"D:\New place\kinema.exe"));
        // Another program's entry under the same type stays.
        registry::write(&value(
            format!(r"{base}\Classes\.mkv\OpenWithProgids"),
            Some("Other.Player"),
            "",
        ))
        .unwrap();

        offer::remove(&base, "kinema.exe");
        assert!(!offer::is_offered(&base));
        assert!(!offer::exists(&format!(r"{base}\Classes\Kinema.Video")));
        assert!(!offer::exists(&format!(r"{base}\Kinema")));
        assert!(!offer::exists(&format!(r"{base}\Classes\.mp4")));
        assert!(registry::read(&format!(r"{base}\Classes\.mkv\OpenWithProgids"), Some("Other.Player"))
            .is_some());

        registry::delete_tree(&base);
        assert!(!offer::exists(&base));
    }
}
