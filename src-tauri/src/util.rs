//! Small helpers every module wants, kept in one place.
//!
//! Each of these used to be copied into the modules that needed it — the
//! error conversion into ten of them, the clock into seven — and the season
//! folder rule into two, where the copies had already drifted: one knew
//! `Staffel 3` and the other did not.

/// For `.map_err(to_string_err)`: Tauri commands report errors as strings.
pub fn to_string_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
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

#[cfg(test)]
mod tests {
    use super::is_season_folder;

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
