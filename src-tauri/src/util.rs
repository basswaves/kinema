//! Small helpers every module wants, kept in one place.
//!
//! Each of these used to be copied into the modules that needed it — the
//! error conversion into ten of them, the clock into seven — and the season
//! folder rule into two, where the copies had already drifted: one knew
//! `Staffel 3` and the other did not.

use std::path::{Path, PathBuf};

/// For `.map_err(to_string_err)`: Tauri commands report errors as strings.
pub fn to_string_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// A count with its noun, `1 file` / `3 files`, for messages the settings
/// screen shows. The frontend's `count` in `ui/format.ts` does the same.
pub fn count(n: usize, noun: &str) -> String {
    if n == 1 {
        format!("1 {noun}")
    } else {
        format!("{n} {noun}s")
    }
}

/// Seconds since the Unix epoch — what every timestamp column stores.
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Does this folder name look like a season folder rather than a show's own?
///
/// `Season 1`, `season 02`, `Staffel 3`, `Specials`, `S01`, `s1` — and not
/// `Severance` or `Succession`, so after an `s` the rest must be all digits.
/// Not `Example Show S01 1080p BluRay` either: a release folder named
/// after a season is the show's folder as far as layout goes.
pub fn is_season_folder(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    if lower.starts_with("season") || lower.starts_with("staffel") || lower.starts_with("specials")
    {
        return true;
    }
    lower
        .strip_prefix('s')
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
}

/// `path` if it is a file, or the file beside it whose name differs only in
/// case — `TVShow.nfo` for `tvshow.nfo`.
///
/// Sidecars are named by people and a dozen tools, not by us, so the case they
/// use is anyone's. On Windows the filesystem already ignores it, and the
/// folder is never listed: most lookups are for a file that is simply not
/// there, and listing a NAS folder for each would slow every scan. Elsewhere a
/// wrong case was a silent miss, so the folder is searched — an exact match
/// first, then the first by name, so the answer is the same every time.
pub fn existing_file(path: &Path) -> Option<PathBuf> {
    if crate::files::is_file(path) {
        return Some(path.to_path_buf());
    }
    // A NAS ignores case for its clients as Windows does.
    if cfg!(windows) || path.to_str().is_some_and(crate::netshare::is_share_path) {
        return None;
    }
    let wanted = path.file_name()?.to_string_lossy().to_lowercase();
    let mut found: Vec<PathBuf> = crate::files::read_dir(path.parent()?)
        .ok()?
        .into_iter()
        .filter(|(p, is_dir)| !is_dir && p.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase() == wanted))
        .map(|(p, _)| p)
        .collect();
    found.sort();
    found.into_iter().next()
}

/// Make Kinema's data folder openable by this account only.
///
/// It holds the SIMKL and Trakt sign-ins and, outside Windows, a kept
/// OpenSubtitles password. Windows gives app data that protection already; on
/// Linux a new folder is readable by every account on the machine.
pub fn keep_private(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{count, existing_file, is_season_folder, keep_private};

    #[test]
    fn keep_private_leaves_the_folder_usable() {
        let dir = std::env::temp_dir().join(format!("kinema-private-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        keep_private(&dir).unwrap();
        std::fs::write(dir.join("library.db"), "x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn existing_file_ignores_case_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("kinema-case-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("TVShow.NFO"), "x").unwrap();

        // Windows hands back the name as asked, and opens the file by it;
        // Linux must hand back the name on disk, or opening it fails.
        let found = existing_file(&dir.join("tvshow.nfo")).expect("found whatever the case");
        assert!(found.is_file(), "{found:?}");
        assert!(found.ends_with("tvshow.nfo") || found.ends_with("TVShow.NFO"));
        assert!(existing_file(&dir.join("tvshow.nfo.bak")).is_none());
        assert!(existing_file(&dir.join("missing").join("tvshow.nfo")).is_none());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn count_uses_the_singular_only_for_one() {
        assert_eq!(count(1, "file"), "1 file");
        assert_eq!(count(0, "file"), "0 files");
        assert_eq!(count(12, "episode"), "12 episodes");
    }

    /// Everything either of the two old rules accepted.
    #[test]
    fn season_folders() {
        for name in ["Season 1", "season 02", "Season 01", "S01", "s1", "Specials", "Staffel 3"] {
            assert!(is_season_folder(name), "{name} is a season folder");
        }
    }

    #[test]
    fn not_season_folders() {
        for name in [
            "Severance",
            "Succession",
            "",
            "Example Film (2017)",
            "films",
            "Example Show S01 1080p BluRay",
        ] {
            assert!(!is_season_folder(name), "{name} is not a season folder");
        }
    }
}
