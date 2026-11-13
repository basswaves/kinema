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

/// Milliseconds since the Unix epoch, for timings that span processes.
pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Words a season's or a disc's folder is called by, followed by its number.
const SEASON_WORDS: &[&str] = &[
    "seasons", "season", "saisons", "saison", "staffel", "s\u{e6}son", "saeson", "sesong", "s\u{e4}song",
    "sasong", "series", "serie", "temporadas", "temporada", "stagione", "\u{441}\u{435}\u{437}\u{43e}\u{43d}",
    "sezon", "sezona", "seizoen", "kausi", "\u{e9}vad", "evad", "\u{c2dc}\u{c98c}",
    "\u{30b7}\u{30fc}\u{30ba}\u{30f3}", "disc", "disk", "dvd", "bd",
];
const SPECIALS: &[&str] = &[
    "specials", "special", "spezial", "specialer", "speciale", "speciali", "especiales",
    "sp\u{e9}ciaux", "speciaux",
];

/// Does this folder name say it holds a season or a disc, rather than a show?
///
/// `Season 1`, `season 02`, `Staffel 3`, `Specials`, `S01`, `s1`, `Disc 1`, and
/// not `Severance`, `Season of the Witch` or `Special (2006)`. Not `Example Show
/// S01 1080p BluRay` either: a release folder named after a season is the show's
/// folder as far as layout goes. The parser has the same rule (`isSeasonFolder`
/// in `parse.ts`); the test below and its test read one list of names.
pub fn is_season_folder(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    if SPECIALS.contains(&lower.as_str()) {
        return true;
    }
    if lower
        .strip_prefix('s')
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
    {
        return true;
    }
    if lower.starts_with('\u{7b2c}') && lower.ends_with('\u{5b63}') {
        return true;
    }
    SEASON_WORDS.iter().any(|word| {
        lower.strip_prefix(word).is_some_and(|rest| {
            let rest = rest.trim_start_matches([' ', '.', '_', '-']);
            let digits = rest.chars().take_while(char::is_ascii_digit).count();
            (1..=4).contains(&digits) && !rest[digits..].starts_with(char::is_alphanumeric)
        })
    })
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

/// Make Kinema's data folder openable by this account only: the folder 0700,
/// the library (and its -wal and -shm) and the safety copies 0600.
///
/// The folder holds the sign-ins and keys. Windows gives app data that
/// protection already, and Android's app folder is private to the app; on
/// Linux a new folder is readable by every account on the machine, and there
/// is no secret store every desktop has, so this is what keeps them out.
/// Never an error that stops start-up: the caller logs it.
pub fn keep_private(dir: &Path) -> std::io::Result<()> {
    #[cfg(all(unix, not(target_os = "android")))]
    {
        use std::os::unix::fs::PermissionsExt;
        let set = |path: &Path, mode: u32| std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
        set(dir, 0o700)?;
        let mut first_error = None;
        let mut note = |r: std::io::Result<()>| {
            if let Err(e) = r {
                first_error.get_or_insert(e);
            }
        };
        for name in ["library.db", "library.db-wal", "library.db-shm"] {
            let file = dir.join(name);
            if file.exists() {
                note(set(&file, 0o600));
            }
        }
        let backups = dir.join(crate::db::BACKUP_DIR);
        if backups.is_dir() {
            note(set(&backups, 0o700));
            if let Ok(entries) = std::fs::read_dir(&backups) {
                for entry in entries.flatten() {
                    if entry.path().is_file() {
                        note(set(&entry.path(), 0o600));
                    }
                }
            }
        }
        if let Some(e) = first_error {
            return Err(e);
        }
    }
    #[cfg(not(all(unix, not(target_os = "android"))))]
    let _ = dir;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{count, existing_file, is_season_folder, keep_private};

    #[test]
    fn keep_private_leaves_the_folder_usable() {
        let dir = std::env::temp_dir().join(format!("kinema-private-{}", std::process::id()));
        let backups = dir.join(crate::db::BACKUP_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        for name in ["library.db", "library.db-wal", "library.db-shm"] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        std::fs::write(backups.join("copy.db"), "x").unwrap();
        keep_private(&dir).unwrap();
        assert_eq!(std::fs::read(dir.join("library.db")).unwrap(), b"x");
        #[cfg(all(unix, not(target_os = "android")))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&backups), 0o700);
            for p in ["library.db", "library.db-wal", "library.db-shm", "backups/copy.db"] {
                assert_eq!(mode(&dir.join(p)), 0o600, "{p}");
            }
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

    /// One list for this and for the parser's rule (`parse.names.test.ts`).
    #[test]
    fn season_folders() {
        let names: serde_json::Value =
            serde_json::from_str(include_str!("../../src/library/seasonFolderNames.json")).unwrap();
        for name in names["season"].as_array().unwrap() {
            let name = name.as_str().unwrap();
            assert!(is_season_folder(name), "{name} is a season folder");
        }
        for name in names["not"].as_array().unwrap() {
            let name = name.as_str().unwrap();
            assert!(!is_season_folder(name), "{name} is not a season folder");
        }
    }
}
