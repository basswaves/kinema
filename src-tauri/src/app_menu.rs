//! Kinema in a Linux desktop's app menu and in "Open with" for videos, for the
//! folder unpacked from the .tar.gz (LOCAL-MEDIA.md phase 1). The .deb and
//! .rpm do this themselves: their `.desktop` file (`linux/kinema.desktop`,
//! named in `tauri.linux.conf.json`) lists the same video types.
//!
//! Standards only (XDG): a desktop entry in `$XDG_DATA_HOME/applications`
//! (`~/.local/share/applications` when unset) and the icon in the hicolor
//! theme beside it. Every desktop that follows the standards lists it; none
//! is asked anything of its own. The default for a type stays the user's, set
//! in their file manager. `update-desktop-database` is run where the system
//! has it, so "Open with" sees the types at once; without it the desktop
//! notices by itself.
//!
//! The folder can move, so at launch an entry naming another place is
//! written again for this one (`refresh`), as on Windows.

// The entry is built and tested everywhere; only Linux writes it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};

/// The video types Kinema opens, for `MimeType=`: the same extensions the
/// library scans for (`scanner.rs`), by their shared-mime-info names. The
/// packages' list in `linux/kinema.desktop` is checked against this one.
pub const MIME_TYPES: &[&str] = &[
    "video/x-matroska",
    "video/webm",
    "video/mp4",
    "video/x-m4v",
    "video/quicktime",
    "video/x-msvideo",
    "video/x-ms-wmv",
    "video/x-flv",
    "video/mpeg",
    "video/mp2t",
    "video/x-ogm+ogg",
    "video/3gpp",
    "application/vnd.rn-realmedia",
    "application/x-cd-image",
];

const FILE: &str = "kinema.desktop";
/// Marks an entry as written by this button, so Remove never takes a
/// package's or the user's own.
const MARK: &str = "X-Kinema-Folder=true";

const ICON: &[u8] = include_bytes!("../icons/128x128.png");

/// One argument of `Exec=`, quoted as the Desktop Entry spec says: inside
/// double quotes, `"`, `` ` ``, `$` and `\` take a backslash; then the string
/// rules double every backslash again, and `%` is written `%%`.
fn exec_arg(arg: &str) -> String {
    let mut quoted = String::from("\"");
    for c in arg.chars() {
        match c {
            '"' | '`' | '$' => {
                quoted.push_str("\\\\");
                quoted.push(c);
            }
            '\\' => quoted.push_str("\\\\\\\\"),
            '%' => quoted.push_str("%%"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

fn entry(exe: &str) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Kinema\n\
         Comment=A local, serverless media library for movies and TV shows\n\
         Exec={} %F\n\
         Icon=kinema\n\
         Terminal=false\n\
         Categories=AudioVideo;Video;Player;\n\
         MimeType={};\n\
         StartupWMClass=kinema\n\
         {MARK}\n",
        exec_arg(exe),
        MIME_TYPES.join(";")
    )
}

/// `$XDG_DATA_HOME`, or `~/.local/share` when it is unset or not absolute.
fn data_home() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
}

fn entry_path(data: &Path) -> PathBuf {
    data.join("applications").join(FILE)
}

fn icon_path(data: &Path) -> PathBuf {
    data.join("icons/hicolor/128x128/apps/kinema.png")
}

/// Kinema installed by a package (`/usr/bin/kinema`): the package's own entry
/// already does all this, so the button is not offered. A folder unpacked
/// under `/usr/local` or `/opt` is not a package.
pub fn packaged() -> bool {
    std::env::current_exe().is_ok_and(|p| p.starts_with("/usr/bin/"))
}

fn exe() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.into_os_string().into_string().map_err(|_| "Kinema's folder has a name the desktop cannot read.".into())
}

/// This button's entry, if there is one.
fn ours(data: &Path) -> Option<String> {
    std::fs::read_to_string(entry_path(data)).ok().filter(|text| text.lines().any(|l| l == MARK))
}

pub fn is_added() -> bool {
    data_home().is_some_and(|d| ours(&d).is_some())
}

pub fn add() -> Result<(), String> {
    let data = data_home().ok_or("No home folder to put the menu entry in.")?;
    write(&data, &exe()?)
}

fn write(data: &Path, exe: &str) -> Result<(), String> {
    let path = entry_path(data);
    if path.exists() && ours(data).is_none() {
        return Err(format!("{} is not Kinema's own; it was left as it is.", path.display()));
    }
    let icon = icon_path(data);
    for p in [&path, &icon] {
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&icon, ICON).map_err(|e| e.to_string())?;
    std::fs::write(&path, entry(exe)).map_err(|e| e.to_string())?;
    update_database(data);
    Ok(())
}

pub fn remove() -> Result<(), String> {
    let Some(data) = data_home() else { return Ok(()) };
    if ours(&data).is_none() {
        return Ok(());
    }
    std::fs::remove_file(entry_path(&data)).map_err(|e| e.to_string())?;
    // The icon only if it is the one written here, not another install's.
    let icon = icon_path(&data);
    if std::fs::read(&icon).is_ok_and(|bytes| bytes == ICON) {
        let _ = std::fs::remove_file(icon);
    }
    update_database(&data);
    Ok(())
}

/// The entry names another place for Kinema: the folder was moved.
fn stale(data: &Path, exe: &str) -> bool {
    ours(data).is_some_and(|text| !text.contains(&format!("Exec={} %F", exec_arg(exe))))
}

/// At launch: an entry for a moved folder is written again for this one.
pub fn refresh() {
    let (Some(data), Ok(exe)) = (data_home(), exe()) else { return };
    if stale(&data, &exe) {
        match write(&data, &exe) {
            Ok(()) => crate::log!("app menu: Kinema has moved; the entry now names {exe}"),
            Err(e) => crate::log!("app menu: could not update the entry: {e}"),
        }
    }
}

/// Tell the desktop the types changed, where the system has the tool for it.
fn update_database(data: &Path) {
    let _ = std::process::Command::new("update-desktop-database")
        .arg(data.join("applications"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_is_quoted_as_the_spec_says() {
        assert_eq!(exec_arg("/home/a/Kinema/kinema"), "\"/home/a/Kinema/kinema\"");
        assert_eq!(exec_arg("/a b/100%/$x"), "\"/a b/100%%/\\\\$x\"");
        assert_eq!(exec_arg("/a\\b"), "\"/a\\\\\\\\b\"");
    }

    #[test]
    fn the_entry_is_written_moved_and_removed_and_never_takes_another() {
        let data = std::env::temp_dir().join(format!("kinema-app-menu-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        write(&data, "/opt/k/kinema").unwrap();
        let text = ours(&data).unwrap();
        assert!(text.contains("Exec=\"/opt/k/kinema\" %F\n"));
        assert!(text.contains("MimeType=video/x-matroska;"));
        assert!(icon_path(&data).exists());
        assert!(!stale(&data, "/opt/k/kinema"));
        assert!(stale(&data, "/home/k/kinema"));

        std::fs::remove_dir_all(&data).unwrap();
        std::fs::create_dir_all(data.join("applications")).unwrap();
        std::fs::write(entry_path(&data), "[Desktop Entry]\nName=Mine\n").unwrap();
        assert!(write(&data, "/opt/k/kinema").is_err());
        assert!(!stale(&data, "/opt/k/kinema"));
        std::fs::remove_dir_all(&data).unwrap();
    }

    /// The packages' `.desktop` names the same types as the folder's entry, and
    /// every extension the library scans has one of them.
    #[test]
    fn the_packages_name_the_same_video_types() {
        let template = include_str!("../linux/kinema.desktop");
        assert!(template.contains(&format!("
MimeType={};
", MIME_TYPES.join(";"))));
        assert!(template.contains("
Exec={{exec}} %F
"));
        let by_extension = [
            ("mkv", "video/x-matroska"), ("webm", "video/webm"), ("mp4", "video/mp4"),
            ("m4v", "video/x-m4v"), ("mov", "video/quicktime"), ("avi", "video/x-msvideo"),
            ("divx", "video/x-msvideo"), ("wmv", "video/x-ms-wmv"), ("flv", "video/x-flv"),
            ("mpg", "video/mpeg"), ("mpeg", "video/mpeg"), ("vob", "video/mpeg"),
            ("ts", "video/mp2t"), ("m2ts", "video/mp2t"), ("mts", "video/mp2t"),
            ("ogm", "video/x-ogm+ogg"), ("3gp", "video/3gpp"),
            ("rmvb", "application/vnd.rn-realmedia"), ("iso", "application/x-cd-image"),
        ];
        for ext in crate::scanner::video_extensions() {
            let (_, mime) = by_extension.iter().find(|(e, _)| e == ext).expect(ext);
            assert!(MIME_TYPES.contains(mime), "{ext}: {mime}");
        }
    }
}
