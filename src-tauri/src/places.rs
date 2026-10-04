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
}

/// Folders a system keeps on a drive for itself, never a library.
fn is_system_folder(name: &str) -> bool {
    name.starts_with('.')
        || ["LOST.DIR", "System Volume Information", "$RECYCLE.BIN"]
            .iter()
            .any(|s| name.eq_ignore_ascii_case(s))
}

pub fn list(path: &Path) -> std::io::Result<Listing> {
    let mut folders = Vec::new();
    let mut videos = 0;
    for entry in std::fs::read_dir(path)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Followed, as the scanner follows them: a linked folder is a folder.
        let Ok(meta) = std::fs::metadata(entry.path()) else { continue };
        if meta.is_dir() {
            if !is_system_folder(&name) {
                folders.push(name);
            }
        } else if crate::scanner::is_video(&entry.path()) {
            videos += 1;
        }
    }
    folders.sort_by_key(|n| n.to_lowercase());
    Ok(Listing { folders, videos })
}

#[tauri::command]
pub fn list_folders(path: String) -> Result<Listing, String> {
    list(Path::new(&path)).map_err(|e| match e.kind() {
        // Said so the browser can ask for access rather than show a fault.
        std::io::ErrorKind::PermissionDenied => format!("not allowed to read {path}"),
        _ => format!("could not read {path}: {e}"),
    })
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
    }

    #[test]
    fn a_missing_folder_is_an_error_not_an_empty_listing() {
        assert!(list_folders("/no/such/folder/for/kinema".into()).is_err());
    }
}
