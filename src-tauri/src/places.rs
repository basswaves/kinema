//! Kinema's own way of choosing a folder, for systems with no folder picker
//! of their own (capabilities `folder_picker`).
//!
//! On Android a TV box often has no picker at all, and where it has one it
//! hands back an address in Android's document system rather than a folder
//! the library can read by path. So Kinema shows the folders itself
//! (`src/ui/FolderBrowser.tsx`): the drives Android has mounted — a USB drive,
//! the box's own storage — come from the Kotlin side (`StoragePlugin.kt`,
//! registered here), and what is inside a folder from `list_folders`, which is
//! plain file reading and the same on every system.
//!
//! The same listing serves Library → Folders on every system (LOCAL-MEDIA.md
//! phase 4), which also names the videos so any of them can be played. Its
//! starting places on a desktop — drives, a home folder, mounted shares — come
//! from [`folder_places`]; Android's from the Kotlin side as above.
//!
//! Nothing here writes anything: listing a drive must leave it as it was.

use serde::Serialize;
use std::path::Path;

/// What is in one folder, as the folder browser shows it.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Listing {
    /// The folders inside, by name, in the order a person would look for them.
    pub folders: Vec<String>,
    /// How many videos sit directly in it: a hint that this is the one.
    pub videos: usize,
    /// Their names, for Library → Folders, which plays them.
    pub files: Vec<String>,
}

/// Folders a system keeps on a drive for itself, never a library.
fn is_system_folder(name: &str) -> bool {
    name.starts_with('.')
        || ["LOST.DIR", "System Volume Information", "$RECYCLE.BIN"]
            .iter()
            .any(|s| name.eq_ignore_ascii_case(s))
}

pub fn list(path: &Path) -> std::io::Result<Listing> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(path)?.flatten() {
        // Followed, as the scanner follows them: a linked folder is a folder.
        let Ok(meta) = std::fs::metadata(entry.path()) else { continue };
        entries.push((entry.file_name().to_string_lossy().into_owned(), meta.is_dir()));
    }
    Ok(listing(entries))
}

/// A folder on a network share Kinema opens itself (netshare.rs).
fn list_share(path: &str) -> std::io::Result<Listing> {
    let entries = crate::netshare::list(path)?;
    Ok(listing(entries.into_iter().map(|e| (e.name, e.is_dir))))
}

/// Names and whether each is a folder, as the browser shows them.
fn listing(entries: impl IntoIterator<Item = (String, bool)>) -> Listing {
    let mut folders = Vec::new();
    let mut files = Vec::new();
    for (name, is_dir) in entries {
        if is_dir {
            if !is_system_folder(&name) {
                folders.push(name);
            }
        } else if crate::scanner::is_video(Path::new(&name)) {
            files.push(name);
        }
    }
    folders.sort_by_key(|n| n.to_lowercase());
    files.sort_by_key(|n| n.to_lowercase());
    Listing { folders, videos: files.len(), files }
}

/// Read one folder, wherever it is. Plain blocking work; see [`list_folders`].
fn list_any(path: &str) -> Result<Listing, String> {
    let listed = if crate::netshare::is_share_path(path) { list_share(path) } else { list(Path::new(path)) };
    listed.map_err(|e| match e.kind() {
        // Said so the browser can ask for access rather than show a fault.
        std::io::ErrorKind::PermissionDenied => format!("not allowed to read {path}"),
        _ => format!("could not read {path}: {e}"),
    })
}

/// **Async, with the reading on a blocking thread.** A folder on a network
/// share is listed over the network, and a server that is asleep or gone is
/// waited for up to twenty seconds. As a plain command this ran on the main
/// thread (see `jobs.rs`) and froze the whole window for that long, in the
/// very dialog a person opens to fix a share they cannot reach.
#[tauri::command]
pub async fn list_folders(path: String) -> Result<Listing, String> {
    crate::jobs::off_main(move || list_any(&path)).await
}

/// A place Library → Folders starts from on a desktop.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct DesktopPlace {
    pub path: String,
    /// As a person knows it: `Films (D:)`, `Home`, `films on nas`.
    pub name: String,
    /// `drive`, `removable`, `disc`, `network` or `home`: what it says under the name.
    pub kind: &'static str,
}

/// **Async, off the main thread**: a drive's name is read from the drive,
/// and a disc drive can take a moment to answer.
#[tauri::command]
pub async fn folder_places() -> Result<Vec<DesktopPlace>, String> {
    crate::jobs::off_main(|| Ok(desktop_places())).await
}

/// Windows: the person's Videos folder, then every drive letter, named as
/// Explorer names them. A name is read only from a drive on this computer — a
/// network drive whose server is gone would hold the list up — and a drive
/// with nothing in it (a card reader with no card, a disc drive with no disc)
/// is left out.
#[cfg(windows)]
fn desktop_places() -> Vec<DesktopPlace> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};
    use windows::Win32::System::Diagnostics::Debug::{
        SetThreadErrorMode, SEM_FAILCRITICALERRORS, THREAD_ERROR_MODE,
    };
    // GetDriveTypeW's answers (WindowsProgramming's DRIVE_* constants).
    const REMOVABLE: u32 = 2;
    const FIXED: u32 = 3;
    const REMOTE: u32 = 4;
    const CDROM: u32 = 5;
    const RAMDISK: u32 = 6;

    let mut places = Vec::new();
    // Where a phone's or a camera's videos usually land.
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let videos = Path::new(&profile).join("Videos");
        if videos.is_dir() {
            places.push(DesktopPlace {
                path: videos.to_string_lossy().into_owned(),
                name: "Videos".into(),
                kind: "home",
            });
        }
    }
    // A drive with nothing in it must answer "not ready", not put Windows'
    // own "There is no disk in the drive" box up over Kinema. This thread
    // only, and as it was afterwards: it is a pool thread.
    let mut before = THREAD_ERROR_MODE(0);
    let quiet = unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS, Some(&mut before)) }.is_ok();
    let mask = unsafe { GetLogicalDrives() };
    for (i, letter) in ('A'..='Z').enumerate() {
        if mask & (1 << i) == 0 {
            continue;
        }
        let root = format!("{letter}:{}", std::path::MAIN_SEPARATOR);
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        let kind = match unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } {
            FIXED | RAMDISK => "drive",
            REMOVABLE => "removable",
            CDROM => "disc",
            REMOTE => "network",
            _ => continue,
        };
        let label = if kind == "network" {
            None
        } else {
            let mut name = [0u16; 261];
            let read = unsafe {
                GetVolumeInformationW(PCWSTR(wide.as_ptr()), Some(&mut name), None, None, None, None)
            };
            match read {
                Ok(()) => {
                    let end = name.iter().position(|&c| c == 0).unwrap_or(name.len());
                    Some(String::from_utf16_lossy(&name[..end]))
                }
                // Nothing in the drive.
                Err(_) if kind != "drive" => continue,
                Err(_) => None,
            }
        };
        places.push(DesktopPlace { path: root, name: drive_name(label.as_deref(), letter, kind), kind });
    }
    if quiet {
        let _ = unsafe { SetThreadErrorMode(before, None) };
    }
    places
}

/// `Films (D:)`, or for a drive with no name of its own, what kind it is.
#[cfg(any(windows, test))]
fn drive_name(label: Option<&str>, letter: char, kind: &str) -> String {
    let label = label.map(str::trim).filter(|l| !l.is_empty()).unwrap_or(match kind {
        "removable" => "USB drive",
        "disc" => "Disc",
        "network" => "Network drive",
        _ => "Local disk",
    });
    format!("{label} ({letter}:)")
}

/// Linux: the home folder, the whole computer, then what is mounted where
/// desktops mount drives, and network shares wherever they are — read from
/// the kernel's own list, which every desktop shares — plus the shares a file
/// manager opened (GVfs, in the session's runtime folder).
#[cfg(target_os = "linux")]
fn desktop_places() -> Vec<DesktopPlace> {
    let mut places = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        places.push(DesktopPlace { path: home.to_string_lossy().into_owned(), name: "Home".into(), kind: "home" });
    }
    places.push(DesktopPlace { path: "/".into(), name: "This computer".into(), kind: "drive" });
    if let Ok(mounts) = std::fs::read_to_string("/proc/self/mounts") {
        places.extend(mounted(&mounts));
    }
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
        if let Ok(entries) = std::fs::read_dir(Path::new(&runtime).join("gvfs")) {
            let mut shares: Vec<_> = entries
                .flatten()
                .map(|e| DesktopPlace {
                    path: e.path().to_string_lossy().into_owned(),
                    name: gvfs_name(&e.file_name().to_string_lossy()),
                    kind: "network",
                })
                .collect();
            shares.sort_by_key(|p| p.name.to_lowercase());
            places.extend(shares);
        }
    }
    places
}

/// The places in `/proc/self/mounts`: drives under the folders desktops
/// mount them in, and network shares wherever they are. Said as a drive, not
/// a USB drive: a second disk is mounted in the same places.
#[cfg(any(target_os = "linux", test))]
fn mounted(mounts: &str) -> Vec<DesktopPlace> {
    const NETWORK: [&str; 6] = ["cifs", "smb3", "nfs", "nfs4", "fuse.sshfs", "davfs"];
    let mut places: Vec<DesktopPlace> = Vec::new();
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(source), Some(point), Some(fs)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let point = unescape_mount(point);
        let network = NETWORK.contains(&fs);
        let drive = ["/media/", "/run/media/", "/mnt/"].iter().any(|p| point.starts_with(p));
        if !(network || drive) || places.iter().any(|p| p.path == point) {
            continue;
        }
        let last = point.rsplit('/').next().unwrap_or(&point).to_string();
        let name = if network { format!("{last} ({})", unescape_mount(source)) } else { last };
        places.push(DesktopPlace { path: point, name, kind: if network { "network" } else { "drive" } });
    }
    places
}

/// The kernel writes a space in a mount point as `\040`, and so on: octal.
#[cfg(any(target_os = "linux", test))]
fn unescape_mount(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let octal = bytes.get(i + 1..i + 4).filter(|d| d.iter().all(|b| (b'0'..=b'7').contains(b)));
        match (bytes[i], octal) {
            (b'\\', Some(d)) => {
                out.push((d[0] - b'0') * 64 + (d[1] - b'0') * 8 + (d[2] - b'0'));
                i += 4;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// GVfs names a share's folder `smb-share:server=nas,share=films`: said as
/// `films on nas`. Anything else is shown as it is.
#[cfg(any(target_os = "linux", test))]
fn gvfs_name(id: &str) -> String {
    let field = |key: &str| {
        id.split([':', ','])
            .find_map(|part| part.strip_prefix(key).and_then(|v| v.strip_prefix('=')))
    };
    match (field("share"), field("server").or_else(|| field("host"))) {
        (Some(share), Some(server)) => format!("{share} on {server}"),
        (None, Some(server)) => server.to_string(),
        _ => id.to_string(),
    }
}

/// Android's places come from its own side (`plugin:storage|places`).
#[cfg(not(any(windows, target_os = "linux")))]
fn desktop_places() -> Vec<DesktopPlace> {
    Vec::new()
}

/// The Kotlin side (drives, and permission to read them), registered under
/// the name the page calls it by. Android only; a desktop has a picker.
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(desktop)]
    return builder;
    #[cfg(mobile)]
    builder.plugin(storage())
}

#[cfg(mobile)]
fn storage<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("storage")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin("com.kinema.app", "StoragePlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_sorted_system_folders_left_out_videos_counted() {
        let dir = std::env::temp_dir().join(format!("kinema-places-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for f in ["movies", "Anime", ".Trash-1000", "LOST.DIR", "System Volume Information"] {
            std::fs::create_dir_all(dir.join(f)).unwrap();
        }
        for f in ["A film (2001).mkv", "Another.mp4", "notes.txt", "A film (2001)-trailer.mkv"] {
            std::fs::write(dir.join(f), b"").unwrap();
        }
        let listing = list(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(listing.folders, ["Anime", "movies"]);
        // The trailer is not a title, as the scanner has it.
        assert_eq!(listing.videos, 2);
        assert_eq!(listing.files, ["A film (2001).mkv", "Another.mp4"]);
    }

    #[test]
    fn drives_named_as_explorer_names_them() {
        assert_eq!(drive_name(Some("Films"), 'D', "drive"), "Films (D:)");
        assert_eq!(drive_name(Some("  "), 'C', "drive"), "Local disk (C:)");
        assert_eq!(drive_name(None, 'Z', "network"), "Network drive (Z:)");
    }

    #[test]
    fn mounted_drives_and_shares_only() {
        let mounts = [
            "/dev/nvme0n1p2 / ext4 rw 0 0",
            "proc /proc proc rw 0 0",
            r"/dev/sdb1 /media/me/My\040Films exfat rw 0 0",
            "/dev/sdc1 /run/media/me/USB vfat rw 0 0",
            "//nas/films /srv/films cifs rw 0 0",
            "nas:/tv /mnt/tv nfs4 rw 0 0",
            "/dev/sdc1 /run/media/me/USB vfat rw 0 0",
        ]
        .join("\n");
        let places = mounted(&mounts);
        let got: Vec<_> = places.iter().map(|p| (p.path.as_str(), p.name.as_str(), p.kind)).collect();
        assert_eq!(
            got,
            [
                ("/media/me/My Films", "My Films", "drive"),
                ("/run/media/me/USB", "USB", "drive"),
                ("/srv/films", "films (//nas/films)", "network"),
                ("/mnt/tv", "tv (nas:/tv)", "network"),
            ]
        );
        assert_eq!(unescape_mount(r"a\\b\04"), r"a\\b\04");
    }

    /// The real list on the computer running the tests: Windows' own drive.
    #[cfg(windows)]
    #[test]
    fn this_computers_system_drive_is_listed() {
        let places = desktop_places();
        let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let drive = places.iter().find(|p| p.path == format!("{system}\\")).expect("system drive");
        assert_eq!(drive.kind, "drive");
        assert!(drive.name.ends_with(&format!("({system})")), "{}", drive.name);
    }

    #[test]
    fn gvfs_shares_said_plainly() {
        assert_eq!(gvfs_name("smb-share:server=nas,share=films"), "films on nas");
        assert_eq!(gvfs_name("sftp:host=box"), "box");
        assert_eq!(gvfs_name("something"), "something");
    }

    #[test]
    fn a_missing_folder_is_an_error_not_an_empty_listing() {
        assert!(list_any("/no/such/folder/for/kinema").is_err());
    }
}
