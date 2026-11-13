//! What is the matter with a file the player could not open: it is not there,
//! it is empty, Kinema is not allowed to read it, or it is there and readable
//! (so it is damaged or not a video). Asked only after a failure (A3-04, A5-06).

use serde::Serialize;
use std::io::Read;
use std::path::Path;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileState {
    /// Found and readable: whatever went wrong is in its contents.
    Readable,
    Missing,
    Empty,
    Denied,
    /// Not a plain local path (an address, a share), or the system gave another answer.
    Unknown,
}

pub fn state_of(path: &str) -> FileState {
    let p = Path::new(path);
    if !p.is_absolute() {
        return FileState::Unknown;
    }
    let meta = match std::fs::metadata(p) {
        Ok(m) => m,
        Err(e) => return classify(&e),
    };
    if !meta.is_file() {
        return FileState::Unknown;
    }
    if meta.len() == 0 {
        return FileState::Empty;
    }
    match std::fs::File::open(p).and_then(|mut f| f.read(&mut [0u8; 1])) {
        Ok(_) => FileState::Readable,
        Err(e) => classify(&e),
    }
}

fn classify(e: &std::io::Error) -> FileState {
    match e.kind() {
        std::io::ErrorKind::NotFound => FileState::Missing,
        std::io::ErrorKind::PermissionDenied => FileState::Denied,
        _ => FileState::Unknown,
    }
}

#[tauri::command]
pub async fn file_state(path: String) -> Result<FileState, String> {
    tauri::async_runtime::spawn_blocking(move || state_of(&path))
        .await
        .map_err(crate::util::to_string_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_missing_empty_and_readable_apart() {
        let dir = std::env::temp_dir().join(format!("kinema-file-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let empty = dir.join("empty.mkv");
        let full = dir.join("full.mkv");
        std::fs::write(&empty, b"").unwrap();
        std::fs::write(&full, b"not a video").unwrap();
        assert_eq!(state_of(&empty.to_string_lossy()), FileState::Empty);
        assert_eq!(state_of(&full.to_string_lossy()), FileState::Readable);
        assert_eq!(state_of(&dir.join("gone.mkv").to_string_lossy()), FileState::Missing);
        assert_eq!(state_of("relative.mkv"), FileState::Unknown);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
