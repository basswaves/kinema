//! IntroDB.app — a second community database of skip timings.
//!
//! <https://introdb.app> is **not** TheIntroDB (`introdb.rs`), despite the
//! name: a separate service, run by different people, with its own data. It is
//! keyed on IMDb ids rather than TMDB ids, and it has two things TheIntroDB
//! does not: a film's **scene after the credits** (`post_credits`), and a
//! count of how many people agreed on each timing.
//!
//! It is used on the same footing as TheIntroDB, and for the same reasons:
//!
//! 1. **One title at a time, when it is played.** Their terms allow
//!    "integrating intro skip functionality into media players" and forbid
//!    "scraping or bulk downloading the entire database". A sweep of a library
//!    is the second, however it is dressed up.
//! 2. **The answer expires** after [`CACHE_TTL_SECS`]. Their terms set no limit;
//!    this is TheIntroDB's month, for the same reasons — a rewatch costs
//!    nothing, and a correction reaches this machine while it still matters.
//! 3. **Attribution is shown**, in Settings, in the words they ask for.
//!
//! Reads need no key. Nothing is ever submitted.
//!
//! What it says is taken narrowly. Their API documents intro, recap and credits
//! (`outro`) for **episodes** and credits and a post-credits scene for
//! **films**, and that is all that is read: a film's "intro" in their data has
//! been seen sitting at the very end of the film, where no intro is.

use crate::introdb::Lookup;
use serde::Deserialize;

/// How long an answer is kept before it is asked for again. See the module
/// notes; the same month as TheIntroDB's.
pub const CACHE_TTL_SECS: i64 = 30 * 24 * 60 * 60;

/// Setting key: `'off'` disables lookups entirely. Anything else, including
/// unset, leaves them on.
pub const ENABLED_KEY: &str = "introdb_app_enabled";

const BASE_URL: &str = "https://api.introdb.app/segments";

/// Short, for the same reason as TheIntroDB's: this runs while someone is
/// waiting for the file to start, and a missing marker costs far less than a
/// player that sits there.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

/// One segment. Both `*_ms` and `*_sec` are sent; milliseconds are read, and
/// seconds only when milliseconds are missing.
#[derive(Deserialize, Debug, Default)]
struct RawSegment {
    #[serde(default)]
    start_ms: Option<f64>,
    #[serde(default)]
    end_ms: Option<f64>,
    #[serde(default)]
    start_sec: Option<f64>,
    #[serde(default)]
    end_sec: Option<f64>,
}

/// Every segment is an object or null — never a list, unlike TheIntroDB.
#[derive(Deserialize, Debug, Default)]
struct Response {
    #[serde(default)]
    intro: Option<RawSegment>,
    #[serde(default)]
    recap: Option<RawSegment>,
    #[serde(default)]
    outro: Option<RawSegment>,
    #[serde(default)]
    post_credits: Option<RawSegment>,
}

/// Which title to ask about.
#[derive(Debug)]
pub enum Query {
    Film { imdb_id: String },
    Episode { imdb_id: String, season: i64, episode: i64 },
}

impl Query {
    /// The question for a library title, or `None` when it cannot be asked.
    ///
    /// Their API numbers seasons and episodes from 1, so a special (season 0)
    /// has no question to ask. An IMDb id that is not one is not sent either;
    /// their server would only refuse it.
    pub fn for_title(
        imdb_id: &str,
        is_film: bool,
        season: Option<i64>,
        episode: Option<i64>,
    ) -> Option<Query> {
        let imdb_id = imdb_id.trim();
        let looks_right = imdb_id.len() >= 9
            && imdb_id.starts_with("tt")
            && imdb_id[2..].bytes().all(|b| b.is_ascii_digit());
        if !looks_right {
            return None;
        }
        let imdb_id = imdb_id.to_string();
        if is_film {
            return Some(Query::Film { imdb_id });
        }
        match (season, episode) {
            (Some(season), Some(episode)) if season >= 1 && episode >= 1 => {
                Some(Query::Episode { imdb_id, season, episode })
            }
            _ => None,
        }
    }
}

fn build_url(query: &Query) -> String {
    match query {
        Query::Film { imdb_id } => format!("{BASE_URL}?imdb_id={imdb_id}&is_movie=true"),
        Query::Episode { imdb_id, season, episode } => {
            format!("{BASE_URL}?imdb_id={imdb_id}&season={season}&episode={episode}")
        }
    }
}

/// Start and end in seconds, when the segment has both and they make sense.
fn bounds(segment: Option<&RawSegment>) -> Option<(f64, f64)> {
    let segment = segment?;
    let start = segment.start_ms.map(|ms| ms / 1000.0).or(segment.start_sec)?;
    let end = segment.end_ms.map(|ms| ms / 1000.0).or(segment.end_sec)?;
    let sane = start.is_finite() && end.is_finite() && start >= 0.0 && end > start;
    sane.then_some((start, end))
}

/// Turn the raw response into what the player can act on — only the segments
/// their API documents for this kind of title.
fn interpret(response: &Response, is_film: bool) -> Lookup {
    let credits = bounds(response.outro.as_ref()).map(|(start, end)| (start, Some(end)));
    if is_film {
        Lookup {
            credits,
            post_credits: bounds(response.post_credits.as_ref()),
            ..Lookup::default()
        }
    } else {
        Lookup {
            intro: bounds(response.intro.as_ref()),
            recap: bounds(response.recap.as_ref()),
            credits,
            post_credits: None,
        }
    }
}

/// Ask IntroDB.app about one title.
///
/// The same contract as TheIntroDB's lookup: `Some` is an answer — including
/// "nobody has timed this", which their server gives as a 200 with every
/// segment null, or as a 404 — and `None` is a question that could not be
/// asked, which the caller must not remember as an answer.
pub async fn lookup(query: &Query) -> Option<Lookup> {
    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .ok()?;

    let url = build_url(query);
    let response = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::log!("introdb.app: request failed: {e}");
            return None;
        }
    };

    let status = response.status();
    if status.as_u16() == 404 {
        return Some(Lookup::default());
    }
    if !status.is_success() {
        crate::log!("introdb.app: {url} returned {status}");
        return None;
    }

    let body = match response.text().await {
        Ok(body) => body,
        Err(e) => {
            crate::log!("introdb.app: could not read the response: {e}");
            return None;
        }
    };

    let is_film = matches!(query, Query::Film { .. });
    match serde_json::from_str::<Response>(&body) {
        Ok(parsed) => Some(interpret(&parsed, is_film)),
        Err(e) => {
            crate::log!("introdb.app: unexpected response shape ({e}): {body}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str, is_film: bool) -> Lookup {
        interpret(&serde_json::from_str(raw).expect("fixture should be valid JSON"), is_film)
    }

    /// The shape recorded from the live API for a film with a scene after the
    /// credits (numbers rounded; the title does not matter).
    #[test]
    fn reads_a_films_credits_and_the_scene_after_them() {
        let lookup = parse(
            r#"{"imdb_id":"tt0000001","media_type":"movie","is_movie":true,"season":0,"episode":0,
                "intro":null,"recap":null,
                "outro":{"start_sec":8251,"end_sec":8852,"start_ms":8251000,"end_ms":8852000,
                         "confidence":1,"submission_count":1},
                "post_credits":{"start_sec":8852,"end_sec":8947,"start_ms":8852000,"end_ms":8947000,
                                "confidence":1,"submission_count":1}}"#,
            true,
        );
        assert_eq!(lookup.credits, Some((8251.0, Some(8852.0))));
        assert_eq!(lookup.post_credits, Some((8852.0, 8947.0)));
    }

    /// Recorded from the live API: a film whose "intro" sits at the very end.
    /// Their API documents no intro for films, and this is why it is not read.
    #[test]
    fn a_films_intro_and_recap_are_not_read() {
        let lookup = parse(
            r#"{"intro":{"start_ms":7512000,"end_ms":7545000},
                "recap":{"start_ms":0,"end_ms":30000}}"#,
            true,
        );
        assert_eq!(lookup.intro, None);
        assert_eq!(lookup.recap, None);
    }

    /// …and an episode's post-credits scene is not read either: their API
    /// documents it for films only.
    #[test]
    fn an_episode_reads_intro_recap_and_credits_only() {
        let lookup = parse(
            r#"{"intro":{"start_ms":60000,"end_ms":90000},
                "recap":{"start_ms":0,"end_ms":60000},
                "outro":{"start_ms":3431000,"end_ms":3500000},
                "post_credits":{"start_ms":3500000,"end_ms":3520000}}"#,
            false,
        );
        assert_eq!(lookup.intro, Some((60.0, 90.0)));
        assert_eq!(lookup.recap, Some((0.0, 60.0)));
        assert_eq!(lookup.credits, Some((3431.0, Some(3500.0))));
        assert_eq!(lookup.post_credits, None);
    }

    /// What their server says about something nobody has timed: a 200 with
    /// every segment null. That is an answer, and an empty one.
    #[test]
    fn an_untimed_title_is_an_empty_answer() {
        let lookup = parse(
            r#"{"imdb_id":"tt0000001","media_type":"tv","is_movie":false,"season":1,"episode":1,
                "intro":null,"recap":null,"outro":null,"post_credits":null}"#,
            false,
        );
        assert_eq!(lookup, Lookup::default());
    }

    #[test]
    fn seconds_are_used_when_milliseconds_are_missing() {
        let lookup = parse(r#"{"intro":{"start_sec":5,"end_sec":35.5}}"#, false);
        assert_eq!(lookup.intro, Some((5.0, 35.5)));
    }

    #[test]
    fn rejects_segments_that_would_seek_backwards_or_nowhere() {
        for raw in [
            r#"{"intro":{"start_ms":90000,"end_ms":30000}}"#,
            r#"{"intro":{"start_ms":90000,"end_ms":90000}}"#,
            r#"{"intro":{"start_ms":-5000,"end_ms":30000}}"#,
            r#"{"intro":{"start_ms":0}}"#,
        ] {
            assert_eq!(parse(raw, false).intro, None, "should reject {raw}");
        }
    }

    #[test]
    fn a_film_url_says_so_and_an_episode_url_carries_its_numbers() {
        let film = Query::for_title("tt0000001", true, None, None).unwrap();
        assert_eq!(build_url(&film), "https://api.introdb.app/segments?imdb_id=tt0000001&is_movie=true");

        let episode = Query::for_title("tt0000002", false, Some(2), Some(5)).unwrap();
        assert_eq!(
            build_url(&episode),
            "https://api.introdb.app/segments?imdb_id=tt0000002&season=2&episode=5"
        );
    }

    /// Nothing is sent that their API would refuse: a special, an episode with
    /// no numbers, or an id that is not an IMDb id.
    #[test]
    fn questions_it_cannot_answer_are_not_asked() {
        assert!(Query::for_title("tt0000002", false, Some(0), Some(1)).is_none());
        assert!(Query::for_title("tt0000002", false, Some(1), None).is_none());
        assert!(Query::for_title("", true, None, None).is_none());
        assert!(Query::for_title("12345", true, None, None).is_none());
        assert!(Query::for_title("tt12ab", true, None, None).is_none());
    }
}
