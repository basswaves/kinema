//! Whether a newer Kinema has been released.
//!
//! Kinema is a ZIP with no installer and no updater, so whoever downloaded it
//! would otherwise stay on that version for good, never hearing of the fixes
//! after it. This asks GitHub for the latest release's version number, once per
//! launch, and nothing else: it downloads nothing and installs nothing, and a
//! failure of any kind — offline, rate limited, a response that no longer
//! parses — is simply "nothing to say". That is what keeps it inside the
//! no-maintenance rule: if GitHub ever changes, the notice goes quiet, and
//! nothing breaks. Settings can switch it off; the frontend does not call this
//! then.

use serde::{Deserialize, Serialize};

const LATEST: &str = "https://api.github.com/repos/Basswaves/kinema/releases/latest";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

#[derive(Serialize, Debug, PartialEq)]
pub struct Release {
    pub version: String,
    /// The release page, for the "download it" button.
    pub url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// `v0.3.10` → `[0, 3, 10]`. Anything after a `-` (a pre-release label) is
/// ignored, and a part that is not a number ends the version there.
fn parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches(['v', 'V'])
        .split('-')
        .next()
        .unwrap_or("")
        .split('.')
        .map_while(|p| p.parse().ok())
        .collect()
}

/// Whether `latest` is a later version than `current`, compared numerically —
/// so 0.3.10 is newer than 0.3.9, which comparing strings gets wrong.
pub fn is_newer(current: &str, latest: &str) -> bool {
    let (a, b) = (parts(current), parts(latest));
    if b.is_empty() {
        return false;
    }
    let len = a.len().max(b.len());
    for i in 0..len {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if y != x {
            return y > x;
        }
    }
    false
}

/// The latest release, if it is newer than this build; otherwise `None`.
#[tauri::command]
pub async fn latest_release() -> Option<Release> {
    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(TIMEOUT)
        // GitHub refuses API requests without one.
        .user_agent(concat!("Kinema/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;

    let response = match client.get(LATEST).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::log!("updates: could not ask GitHub: {e}");
            return None;
        }
    };
    if !response.status().is_success() {
        crate::log!("updates: GitHub answered {}", response.status());
        return None;
    }
    let body = response.text().await.ok()?;
    let release: GithubRelease = match serde_json::from_str(&body) {
        Ok(r) => r,
        Err(e) => {
            crate::log!("updates: could not read GitHub's answer: {e}");
            return None;
        }
    };
    if release.draft || release.prerelease {
        return None;
    }

    let current = env!("CARGO_PKG_VERSION");
    if !is_newer(current, &release.tag_name) {
        return None;
    }
    crate::log!("updates: {} is out; this is {current}", release.tag_name);
    Some(Release {
        version: release.tag_name.trim_start_matches(['v', 'V']).to_owned(),
        url: release.html_url,
    })
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_versions_as_numbers() {
        assert!(is_newer("0.3.1", "v0.3.2"));
        assert!(is_newer("0.3.9", "0.3.10"));
        assert!(is_newer("0.3.1", "1.0.0"));
        assert!(!is_newer("0.3.1", "v0.3.1"));
        assert!(!is_newer("0.3.2", "v0.3.1"));
    }

    #[test]
    fn a_tag_it_cannot_read_is_not_an_update() {
        assert!(!is_newer("0.3.1", "nightly"));
        assert!(!is_newer("0.3.1", ""));
    }

    #[test]
    fn a_pre_release_label_does_not_make_it_newer() {
        assert!(!is_newer("0.3.1", "0.3.1-beta"));
        assert!(is_newer("0.3.1", "0.4.0-rc1"));
    }
}
