//! TheIntroDB — community-timed intro and credits segments.
//!
//! <https://theintrodb.org> is a free, community-contributed database of
//! segment timestamps keyed by TMDB id. It is the only source in this app that
//! knows where the **credits** are: Skiptro detects intros and nothing else, so
//! without this the closing segment was always a chapter name or a guess.
//!
//! Three things about the way it is used here are deliberate, and all three
//! come from their terms of service rather than from taste:
//!
//! 1. **One episode at a time, when it is played.** The library is never bulk
//!    fetched. Their licence is for client-side, per-user lookups, and a sweep
//!    of every episode in a library is the shape of request it exists to
//!    prohibit.
//! 2. **The cache expires.** Answers are kept for [`CACHE_TTL_SECS`] so a
//!    rewatch costs nothing, and are then re-asked. A permanent local copy of
//!    everything played would drift towards being a second copy of their
//!    database, which the licence does not grant; a TTL also means community
//!    corrections actually reach us.
//! 3. **Attribution is shown**, in Settings, next to the switch that turns this
//!    on. They ask rather than require, and it costs one line.
//!
//! No API key is involved. Reads are unauthenticated; a key exists only for
//! *submitting* timestamps, which this app does not do.

use serde::Deserialize;

/// How long an answer is kept before it is asked for again.
///
/// Thirty days. Long enough that a rewatch is free and their server sees at
/// most one request per episode per month, short enough that a corrected
/// timestamp reaches this machine while the show is still being watched.
pub const CACHE_TTL_SECS: i64 = 30 * 24 * 60 * 60;

/// Setting key: `'off'` disables lookups entirely. Anything else, including
/// unset, leaves them on.
pub const ENABLED_KEY: &str = "introdb_enabled";

const BASE_URL: &str = "https://api.theintrodb.org/v3/media";

/// How long to wait before giving up on the lookup.
///
/// Short on purpose. This runs while the user is waiting for an episode to
/// start, and a missing skip marker is a far smaller cost than a player that
/// sits there. Failure is silent and simply means no marker from this source.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

/// One segment as the API returns it.
///
/// Both ends are optional and mean different things: a null `start_ms` on an
/// intro means "from the beginning of the file", a null `end_ms` on credits
/// means "to the end of it". Neither is a missing value to be defaulted away.
#[derive(Deserialize, Debug, Default)]
struct RawSegment {
    #[serde(default)]
    start_ms: Option<f64>,
    #[serde(default)]
    end_ms: Option<f64>,
}

#[derive(Deserialize, Debug, Default)]
struct Response {
    #[serde(default)]
    intro: Vec<RawSegment>,
    #[serde(default)]
    credits: Vec<RawSegment>,
}

/// What this app takes from a lookup. `recap` and `preview` are returned by the
/// API and deliberately ignored — the player has no path for them, and parsing
/// a segment nothing can act on would only invite acting on it.
#[derive(Debug, Default, PartialEq)]
pub struct Lookup {
    /// Start and end in seconds. An intro with no end is unusable — there would
    /// be nowhere to seek to — so it is dropped rather than guessed at.
    pub intro: Option<(f64, f64)>,
    /// Start in seconds, and an end that is `None` when the credits run to the
    /// end of the file.
    pub credits: Option<(f64, Option<f64>)>,
}

/// Which media item to ask about.
#[derive(Debug)]
pub struct Query {
    pub tmdb_id: String,
    /// Both or neither. A TV lookup without them would return the show rather
    /// than the episode.
    pub season: Option<i64>,
    pub episode: Option<i64>,
    /// The file's real duration, when it is known from a previous play.
    ///
    /// Optional in the API and worth sending: it is how they tell releases
    /// apart, and a 43-minute broadcast cut and a 47-minute extended cut do not
    /// share a credits time.
    pub duration_secs: Option<f64>,
}

fn ms_to_secs(ms: f64) -> Option<f64> {
    let secs = ms / 1000.0;
    (secs.is_finite() && secs >= 0.0).then_some(secs)
}

/// Turn the raw response into the two segments this app can act on.
///
/// Anything that would seek backwards, seek nowhere, or start before zero is
/// dropped. The same rule the sidecar reader applies, for the same reason: a
/// marker that is wrong in that particular way skips over real content.
fn interpret(response: &Response) -> Lookup {
    let intro = response.intro.iter().find_map(|s| {
        // A null start means the file opens on the intro.
        let start = s.start_ms.map_or(Some(0.0), ms_to_secs)?;
        let end = s.end_ms.and_then(ms_to_secs)?;
        (end > start).then_some((start, end))
    });

    let credits = response.credits.iter().find_map(|s| {
        let start = s.start_ms.and_then(ms_to_secs)?;
        let end = s.end_ms.and_then(ms_to_secs);
        match end {
            // A null end is the API saying "to the end of the file", which is
            // both true and the only honest thing to store.
            None => Some((start, None)),
            Some(end) if end > start => Some((start, Some(end))),
            Some(_) => None,
        }
    });

    Lookup { intro, credits }
}

fn build_url(query: &Query) -> String {
    let mut url = format!("{BASE_URL}?tmdb_id={}", query.tmdb_id);

    if let (Some(season), Some(episode)) = (query.season, query.episode) {
        url.push_str(&format!("&season={season}&episode={episode}"));
    }

    if let Some(secs) = query.duration_secs {
        if secs.is_finite() && secs > 0.0 {
            url.push_str(&format!("&duration_ms={}", (secs * 1000.0).round() as i64));
        }
    }

    url
}

/// Ask TheIntroDB about one media item.
///
/// `Some` means **the question was answered**, including a 404 — which is the
/// ordinary case of nobody having timed this episode yet, and is an empty
/// [`Lookup`] rather than a failure.
///
/// `None` means the question could not be *asked*: offline, timed out, rate
/// limited, or a response that no longer parses. The distinction is load-bearing
/// and not cosmetic. The caller records a timestamp on `Some` and suppresses
/// lookups for a month; doing that on a failure would mean one moment of being
/// offline caches "this show has no credits" until September.
pub async fn lookup(query: &Query) -> Option<Lookup> {
    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .ok()?;

    let url = build_url(query);
    let response = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::log!("introdb: request failed: {e}");
            return None;
        }
    };

    let status = response.status();

    // 404 is an answer: nobody has timed this episode yet. Recorded as such, so
    // an untimed show is asked about once a month rather than once a play.
    if status.as_u16() == 404 {
        return Some(Lookup::default());
    }

    if !status.is_success() {
        // Anything else — a 429 above all — is a question that failed to get
        // asked. Logged, because a rate limit that nothing reports looks exactly
        // like a library where no show has credits.
        crate::log!("introdb: {url} returned {status}");
        return None;
    }

    // Deserialised from text rather than with reqwest's `json()`, which needs a
    // cargo feature this build of tauri-plugin-http does not enable.
    let body = match response.text().await {
        Ok(body) => body,
        Err(e) => {
            crate::log!("introdb: could not read the response: {e}");
            return None;
        }
    };

    match serde_json::from_str::<Response>(&body) {
        Ok(parsed) => Some(interpret(&parsed)),
        Err(e) => {
            crate::log!("introdb: unexpected response shape ({e}): {body}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Lookup {
        interpret(&serde_json::from_str(raw).expect("fixture should be valid JSON"))
    }

    /// Recorded from the live API for Breaking Bad S01E01, which is the case
    /// this whole source exists for: it carries credits, and Skiptro cannot.
    #[test]
    fn reads_a_real_response_with_both_segments() {
        let lookup = parse(
            r#"{"tmdb_id":1396,"type":"tv","season":1,"episode":1,
                "intro":[{"start_ms":228892,"end_ms":245607}],
                "credits":[{"start_ms":3431000,"end_ms":null}]}"#,
        );
        assert_eq!(lookup.intro, Some((228.892, 245.607)));
        assert_eq!(lookup.credits, Some((3431.0, None)));
    }

    /// Recorded from the live API for Example Show S01E01 — an intro that
    /// starts at the first frame, which the API states as a null rather than a
    /// zero. Read as "missing" it would drop the only marker the episode has.
    #[test]
    fn a_null_intro_start_means_the_first_frame() {
        let lookup = parse(r#"{"intro":[{"start_ms":null,"end_ms":46000}]}"#);
        assert_eq!(lookup.intro, Some((0.0, 46.0)));
        assert_eq!(lookup.credits, None);
    }

    #[test]
    fn an_intro_with_no_end_is_dropped() {
        // There would be nowhere to seek to, so the Skip button would do nothing.
        assert_eq!(parse(r#"{"intro":[{"start_ms":1000,"end_ms":null}]}"#).intro, None);
    }

    #[test]
    fn credits_with_no_start_are_dropped() {
        assert_eq!(parse(r#"{"credits":[{"start_ms":null,"end_ms":90000}]}"#).credits, None);
    }

    #[test]
    fn rejects_segments_that_would_seek_backwards_or_nowhere() {
        assert_eq!(parse(r#"{"intro":[{"start_ms":90000,"end_ms":30000}]}"#).intro, None);
        assert_eq!(parse(r#"{"intro":[{"start_ms":90000,"end_ms":90000}]}"#).intro, None);
        assert_eq!(parse(r#"{"credits":[{"start_ms":9000,"end_ms":9000}]}"#).credits, None);
    }

    #[test]
    fn missing_arrays_are_not_an_error() {
        assert_eq!(parse(r#"{"tmdb_id":1,"type":"movie"}"#), Lookup::default());
    }

    /// `recap` and `preview` exist in the API and must not leak in as an intro.
    #[test]
    fn ignores_segment_types_the_player_cannot_act_on() {
        let lookup = parse(
            r#"{"recap":[{"start_ms":0,"end_ms":30000}],
                "preview":[{"start_ms":1680000,"end_ms":1740000}]}"#,
        );
        assert_eq!(lookup, Lookup::default());
    }

    #[test]
    fn a_tv_url_carries_the_episode_and_a_movie_url_does_not() {
        let tv = build_url(&Query {
            tmdb_id: "105".into(),
            season: Some(1),
            episode: Some(2),
            duration_secs: None,
        });
        assert_eq!(tv, "https://api.theintrodb.org/v3/media?tmdb_id=105&season=1&episode=2");

        let movie = build_url(&Query {
            tmdb_id: "1271".into(),
            season: None,
            episode: None,
            duration_secs: None,
        });
        assert_eq!(movie, "https://api.theintrodb.org/v3/media?tmdb_id=1271");
    }

    #[test]
    fn duration_is_sent_in_milliseconds_when_it_is_known() {
        let url = build_url(&Query {
            tmdb_id: "105".into(),
            season: Some(1),
            episode: Some(1),
            duration_secs: Some(1783.5),
        });
        assert!(url.ends_with("&duration_ms=1783500"), "got {url}");
    }

    /// A duration of zero is what an unplayed file reports, not a real length.
    #[test]
    fn a_zero_duration_is_left_out_rather_than_sent() {
        let url = build_url(&Query {
            tmdb_id: "105".into(),
            season: Some(1),
            episode: Some(1),
            duration_secs: Some(0.0),
        });
        assert!(!url.contains("duration_ms"), "got {url}");
    }
}
