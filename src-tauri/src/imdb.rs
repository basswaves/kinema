//! IMDb's ratings, from the file IMDb publishes for exactly this.
//!
//! IMDb offers a daily file of every title's rating and vote count
//! (`title.ratings.tsv.gz`, about 9 MB) for **personal and non-commercial
//! use**, on three conditions that shape this module:
//!
//! 1. **Only the dataset file** — no scraping of imdb.com, ever.
//! 2. **No database of IMDb's data** beyond the user's own personal use. So
//!    the file is never kept: it is read as it arrives and only the rows for
//!    titles in this library survive, in `imdb_ratings`. The rest is dropped.
//! 3. **A credit line**, "Information courtesy of IMDb (https://www.imdb.com).
//!    Used with permission." — in Settings, beside TMDB's.
//!
//! Each copy of Kinema fetches the file for itself, and not often: when it
//! has never been fetched, when it is over 30 days old, or when a title has
//! joined the library since the last fetch and that was over a week ago. A
//! title the file was searched for and did not have is remembered as such
//! (a row with no rating), so one IMDb never rates cannot bring nine
//! megabytes down every week for ever.
//!
//! Why this and not OMDb, which has IMDb's rating per title: OMDb's free keys
//! allow 1,000 lookups a day, and one key built into every copy of Kinema
//! would run out within hours for everyone (see HISTORY.md, "Picture and sound
//! badges"). OMDb stays, with the user's own key, for Rotten Tomatoes.

use crate::library::Db;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};
use std::time::Duration;
use tauri::Manager;

const RATINGS_URL: &str = "https://datasets.imdbws.com/title.ratings.tsv.gz";

/// Setting key: when the file was last read, in seconds since the epoch.
const FETCHED_AT_KEY: &str = "imdb_ratings_fetched_at";

const DAY: i64 = 24 * 60 * 60;
/// Ratings move slowly; a month-old rating is still the rating.
const MAX_AGE: i64 = 30 * DAY;
/// How soon a title new to the library may bring the file down again.
const NEW_TITLE_AGE: i64 = 7 * DAY;

/// Nine megabytes on a slow line, with room to spare.
const TIMEOUT: Duration = Duration::from_secs(180);

/// Whether the file should be fetched now.
fn due(conn: &Connection, now: i64) -> rusqlite::Result<bool> {
    let fetched_at: Option<i64> =
        crate::settings::setting(conn, FETCHED_AT_KEY).and_then(|v| v.parse().ok());
    let Some(fetched_at) = fetched_at else {
        return has_imdb_titles(conn);
    };
    let age = now - fetched_at;
    if age >= MAX_AGE {
        return has_imdb_titles(conn);
    }
    if age >= NEW_TITLE_AGE {
        // Never looked up — not "looked up and unrated", which has a row.
        let new: i64 = conn.query_row(
            "SELECT COUNT(*) FROM titles t
              WHERE t.imdb_id LIKE 'tt%'
                AND NOT EXISTS (SELECT 1 FROM imdb_ratings r WHERE r.imdb_id = t.imdb_id)",
            [],
            |r| r.get(0),
        )?;
        return Ok(new > 0);
    }
    Ok(false)
}

/// Nothing to rate is no reason to download nine megabytes.
fn has_imdb_titles(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM titles WHERE imdb_id LIKE 'tt%')",
        [],
        |r| r.get(0),
    )
}

fn library_ids(conn: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut statement =
        conn.prepare("SELECT DISTINCT imdb_id FROM titles WHERE imdb_id LIKE 'tt%'")?;
    let rows = statement.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// One rating: IMDb id, average out of 10, number of votes.
#[derive(Debug, Clone, PartialEq)]
pub struct Rating {
    pub imdb_id: String,
    pub rating: f64,
    pub votes: i64,
}

/// Read the file's rows for `wanted` ids and drop every other.
///
/// The format is IMDb's documented one: a header line, then
/// `tconst \t averageRating \t numVotes`. A line that does not parse is
/// skipped rather than failing the whole file.
fn read_ratings<R: Read>(gzipped: R, wanted: &HashSet<String>) -> std::io::Result<Vec<Rating>> {
    let reader = BufReader::new(flate2::read::GzDecoder::new(gzipped));
    let mut found = Vec::new();
    for line in reader.lines() {
        let line = line?;
        let mut fields = line.split('\t');
        let (Some(id), Some(rating), Some(votes)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if !wanted.contains(id) {
            continue;
        }
        if let (Ok(rating), Ok(votes)) = (rating.parse::<f64>(), votes.trim().parse::<i64>()) {
            found.push(Rating {
                imdb_id: id.to_string(),
                rating,
                votes,
            });
        }
    }
    Ok(found)
}

/// Replace the kept ratings with `ratings`, record every other id that was
/// searched for as unrated, and note when.
fn save(
    conn: &mut Connection,
    searched: &HashSet<String>,
    ratings: &[Rating],
    now: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM imdb_ratings", [])?;
    {
        let mut insert =
            tx.prepare("INSERT INTO imdb_ratings (imdb_id, rating, votes) VALUES (?1, ?2, ?3)")?;
        for r in ratings {
            insert.execute(params![r.imdb_id, r.rating, r.votes])?;
        }
        let mut unrated = tx.prepare(
            "INSERT INTO imdb_ratings (imdb_id, rating, votes) VALUES (?1, NULL, NULL)
             ON CONFLICT(imdb_id) DO NOTHING",
        )?;
        for id in searched {
            unrated.execute(params![id])?;
        }
    }
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![FETCHED_AT_KEY, now.to_string()],
    )?;
    tx.commit()
}

#[derive(Serialize, Default)]
pub struct ImdbReport {
    /// The file was fetched on this pass.
    pub fetched: bool,
    /// Library titles that have an IMDb rating now.
    pub rated: usize,
}

/// Tauri command: fetch IMDb's ratings if they are due. Part of every scan;
/// usually decides there is nothing to do.
#[tauri::command]
pub async fn refresh_imdb_ratings(app: tauri::AppHandle) -> Result<ImdbReport, String> {
    let wanted = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        if !due(&conn, now_secs()).map_err(to_string_err)? {
            return Ok(ImdbReport::default());
        }
        library_ids(&conn).map_err(to_string_err)?
    };

    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("Kinema/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(to_string_err)?;
    let response = client
        .get(RATINGS_URL)
        .send()
        .await
        .map_err(|e| format!("IMDb ratings: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("IMDb ratings: the server answered {}", response.status()));
    }
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("IMDb ratings: {e}"))?;

    crate::jobs::off_main(move || {
        let started = std::time::Instant::now();
        let ratings = read_ratings(body.as_ref(), &wanted)
            .map_err(|e| format!("IMDb ratings: the file could not be read: {e}"))?;
        let db = app.state::<Db>();
        let mut conn = db.0.lock().map_err(to_string_err)?;
        save(&mut conn, &wanted, &ratings, now_secs()).map_err(to_string_err)?;
        crate::log!(
            "imdb: {} of {} titles rated, read in {:.1}s",
            ratings.len(),
            wanted.len(),
            started.elapsed().as_secs_f64()
        );
        Ok(ImdbReport {
            fetched: true,
            rated: ratings.len(),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gzip(text: &str) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(text.as_bytes()).unwrap();
        encoder.finish().unwrap()
    }

    fn ids(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// The layout IMDb documents, header and all.
    const FILE: &str = "tconst\taverageRating\tnumVotes\n\
                        tt0000001\t5.7\t2100\n\
                        tt0133093\t8.7\t2213456\n\
                        tt0944947\t9.2\t2400000\n\
                        tt9999999\tnot-a-number\t10\n";

    #[test]
    fn only_the_librarys_titles_are_kept() {
        let found = read_ratings(gzip(FILE).as_slice(), &ids(&["tt0133093", "tt0944947"])).unwrap();
        assert_eq!(
            found,
            vec![
                Rating { imdb_id: "tt0133093".into(), rating: 8.7, votes: 2_213_456 },
                Rating { imdb_id: "tt0944947".into(), rating: 9.2, votes: 2_400_000 },
            ]
        );
    }

    #[test]
    fn a_line_that_does_not_parse_is_skipped() {
        let found = read_ratings(gzip(FILE).as_slice(), &ids(&["tt9999999"])).unwrap();
        assert!(found.is_empty());
    }

    #[test]
    fn a_file_that_is_not_gzip_is_an_error_not_an_empty_list() {
        assert!(read_ratings(FILE.as_bytes(), &ids(&["tt0133093"])).is_err());
    }

    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).map_err(|e| e.to_string()).unwrap();
        conn.execute_batch(
            "INSERT INTO titles (id, kind, provider, provider_id, imdb_id, title, fetched_at) VALUES
                 (1, 'movie',  'tmdb',   '1', 'tt0133093', 'A film', 0),
                 (2, 'series', 'tvmaze', '2', 'tt0944947', 'A show', 0),
                 (3, 'movie',  'tmdb',   '3', NULL,        'No id',  0);",
        )
        .unwrap();
        conn
    }

    fn rating(id: &str) -> Rating {
        Rating { imdb_id: id.into(), rating: 8.0, votes: 10 }
    }

    fn searched(list: &[&str]) -> HashSet<String> {
        ids(list)
    }

    #[test]
    fn it_is_due_the_first_time_and_then_not_for_a_while() {
        let mut conn = library();
        let both = searched(&["tt0133093", "tt0944947"]);
        assert!(due(&conn, 1_000 * DAY).unwrap());
        save(&mut conn, &both, &[rating("tt0133093"), rating("tt0944947")], 1_000 * DAY).unwrap();
        assert!(!due(&conn, 1_000 * DAY + 29 * DAY).unwrap());
        assert!(due(&conn, 1_000 * DAY + 30 * DAY).unwrap());
    }

    /// A title new since the last fetch waits a week for the next one.
    #[test]
    fn a_new_title_waits_a_week() {
        let mut conn = library();
        // The last fetch knew only the film; the show came afterwards.
        save(&mut conn, &searched(&["tt0133093"]), &[rating("tt0133093")], 1_000 * DAY).unwrap();
        assert!(!due(&conn, 1_000 * DAY + 6 * DAY).unwrap());
        assert!(due(&conn, 1_000 * DAY + 7 * DAY).unwrap());
    }

    /// A title the file did not have is remembered as unrated, and does not
    /// bring nine megabytes down every week until the month is up.
    #[test]
    fn a_title_imdb_does_not_rate_is_not_asked_about_weekly() {
        let mut conn = library();
        let both = searched(&["tt0133093", "tt0944947"]);
        save(&mut conn, &both, &[rating("tt0133093")], 1_000 * DAY).unwrap();
        assert!(!due(&conn, 1_000 * DAY + 20 * DAY).unwrap());
        assert!(due(&conn, 1_000 * DAY + 30 * DAY).unwrap());
        let unrated: Option<f64> = conn
            .query_row("SELECT rating FROM imdb_ratings WHERE imdb_id = 'tt0944947'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(unrated, None);
    }

    #[test]
    fn a_library_with_no_imdb_ids_never_downloads() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).map_err(|e| e.to_string()).unwrap();
        assert!(!due(&conn, 1_000 * DAY).unwrap());
    }

    /// Each fetch replaces the last: a title removed from the library takes
    /// its rating with it at the next one.
    #[test]
    fn a_fetch_replaces_what_was_kept() {
        let mut conn = library();
        save(&mut conn, &searched(&[]), &[rating("tt0133093"), rating("tt0000001")], 1).unwrap();
        save(&mut conn, &searched(&[]), &[rating("tt0944947")], 2).unwrap();
        let kept: Vec<String> = conn
            .prepare("SELECT imdb_id FROM imdb_ratings")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(kept, vec!["tt0944947".to_string()]);
    }

    /// The real file, when there is a network: it downloads, decompresses and
    /// has the columns this module expects.
    #[test]
    #[ignore = "downloads IMDb's ratings file"]
    fn reads_the_real_file() {
        let body = std::process::Command::new("curl")
            .args(["-sL", RATINGS_URL])
            .output()
            .expect("curl")
            .stdout;
        let started = std::time::Instant::now();
        let found = read_ratings(body.as_slice(), &ids(&["tt0133093", "tt0944947"])).unwrap();
        println!("read {} bytes in {:.2}s", body.len(), started.elapsed().as_secs_f64());
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found.iter().all(|r| r.rating > 5.0 && r.votes > 100_000), "{found:?}");
    }
}
