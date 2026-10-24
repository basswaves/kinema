//! Why a host could not be reached, in words that can be shown.
//!
//! The webview's `fetch` (tauri-plugin-http) fails with reqwest's top-level
//! text, "error sending request for url (…)", whatever happened underneath. The
//! interface used to call every such failure "Couldn't reach the internet",
//! which was wrong for a tester whose internet worked and whose network did not
//! let TMDB through. Here one request is made again from Rust, where the whole
//! chain of causes is readable — a name that did not resolve, a refused or cut
//! connection, a certificate that was not TMDB's — and the chain goes to the log
//! in full.
//!
//! Only the hosts Kinema already talks to for matching can be asked about, so
//! this adds nothing to "What leaves your computer".

use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);

/// Hosts this may be asked to reach: TMDB's two API addresses, and Wikidata as
/// the one to compare with ("is it the internet, or this host?").
const HOSTS: [&str; 3] = ["api.themoviedb.org", "api.tmdb.org", "www.wikidata.org"];

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Reach {
    /// An HTTP answer came back, of any status.
    pub reached: bool,
    pub status: Option<u16>,
    /// `dns`, `tls`, `refused`, `cut`, `timeout`, `other`, or empty when reached.
    pub cause: String,
}

/// Which kind of failure a chain of error texts describes.
fn classify(chain: &str, timeout: bool) -> &'static str {
    let text = chain.to_lowercase();
    if timeout || text.contains("timed out") || text.contains("os error 10060") {
        "timeout"
    } else if text.contains("dns error")
        || text.contains("failed to lookup address")
        || text.contains("no such host")
        || text.contains("name or service not known")
        || text.contains("os error 11001")
    {
        "dns"
    } else if text.contains("certificate") || text.contains("tls") || text.contains("handshake") {
        "tls"
    } else if text.contains("refused") || text.contains("os error 10061") {
        "refused"
    } else if text.contains("reset") || text.contains("closed") || text.contains("aborted") {
        "cut"
    } else {
        "other"
    }
}

/// Ask `host` once, at its root, and say what happened.
#[tauri::command]
pub async fn check_reach(host: String) -> Result<Reach, String> {
    if !HOSTS.contains(&host.as_str()) {
        return Err(format!("not a host Kinema checks: {host}"));
    }
    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://{host}/");
    match client.get(&url).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            crate::log!("reach: {host} answered HTTP {status}");
            Ok(Reach { reached: true, status: Some(status), cause: String::new() })
        }
        Err(e) => {
            let mut chain = e.to_string();
            let mut source = std::error::Error::source(&e);
            while let Some(s) = source {
                chain.push_str(" ← ");
                chain.push_str(&s.to_string());
                source = s.source();
            }
            let cause = classify(&chain, e.is_timeout());
            crate::log!("reach: {host} not reached ({cause}): {chain}");
            Ok(Reach { reached: false, status: None, cause: cause.to_string() })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn causes_are_told_apart() {
        assert_eq!(classify("error sending request ← dns error ← No such host is known. (os error 11001)", false), "dns");
        assert_eq!(classify("error sending request ← invalid peer certificate: UnknownIssuer", false), "tls");
        assert_eq!(classify("error sending request ← tcp connect error ← No connection could be made because the target machine actively refused it. (os error 10061)", false), "refused");
        assert_eq!(classify("error sending request ← connection reset by peer", false), "cut");
        assert_eq!(classify("error sending request", true), "timeout");
        assert_eq!(classify("error sending request", false), "other");
    }
}
