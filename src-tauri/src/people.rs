//! Actor pages: a person, and what of the library they appear in.
//!
//! "In your library" is exact or empty — a wrong person is worse than none
//! (DECISIONS: a wrong match). Two sources, both by TMDB's person id, never
//! by name: the cast stored with each title (`people.person_id`, schema 35),
//! and the person's own credits from TMDB, asked for once on opening their
//! page and kept a month (`person_info`) — which also finds the titles whose
//! cast is not stored that far down. A title matched elsewhere (Wikidata,
//! TVmaze) has no person ids and is found only by its TMDB id, if it has one.

use crate::artwork::path_prefix;
use crate::library::Db;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// How long a person's details are kept before their page asks TMDB again.
/// Well inside TMDB's six months.
pub const PERSON_MAX_AGE_SECS: i64 = 30 * 24 * 60 * 60;

#[derive(Serialize, Debug)]
pub struct Person {
    pub person_id: String,
    pub name: String,
    pub biography: Option<String>,
    pub profile_url: Option<String>,
    pub profile_path: Option<String>,
    pub imdb_id: Option<String>,
    /// TMDB was asked within `PERSON_MAX_AGE_SECS`; otherwise the page asks.
    pub fresh: bool,
    /// Titles in the library with this person, newest first.
    pub title_ids: Vec<i64>,
}

#[derive(Deserialize)]
pub struct PersonInput {
    pub person_id: String,
    pub name: String,
    pub biography: Option<String>,
    pub profile_url: Option<String>,
    pub imdb_id: Option<String>,
    /// Their credits as `movie:603` / `tv:1399`, TMDB's kinds and ids.
    pub credits: Vec<String>,
}

/// A `person_info` row: name, biography, picture, IMDb id, credits, when.
type InfoRow = (String, Option<String>, Option<String>, Option<String>, String, i64);

/// The person as far as the library knows them, or `None` for an id no
/// title's cast and no fetched page holds.
pub(crate) fn person(
    conn: &Connection,
    art: &str,
    person_id: &str,
    now: i64,
) -> rusqlite::Result<Option<Person>> {
    let info: Option<InfoRow> = conn
        .query_row(
            "SELECT name, biography, profile_url, imdb_id, credits, fetched_at
               FROM person_info WHERE person_id = ?1",
            params![person_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .ok();
    let cast: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT name, profile_url FROM people WHERE person_id = ?1
              ORDER BY profile_url IS NULL, id LIMIT 1",
            params![person_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (name, biography, profile_url, imdb_id, credits, fetched_at) = match (info, cast) {
        (Some((name, bio, profile, imdb, credits, at)), cast) => {
            // The cast row's picture is the one in the artwork cache.
            let profile = cast.and_then(|c| c.1).or(profile);
            (name, bio, profile, imdb, credits, Some(at))
        }
        (None, Some((name, profile))) => (name, None, profile, None, String::new(), None),
        (None, None) => return Ok(None),
    };

    let mut ids: BTreeSet<i64> = BTreeSet::new();
    let mut stmt = conn.prepare("SELECT DISTINCT title_id FROM people WHERE person_id = ?1")?;
    for id in stmt.query_map(params![person_id], |r| r.get::<_, i64>(0))? {
        ids.insert(id?);
    }
    let mut by_tmdb = conn.prepare("SELECT id FROM titles WHERE tmdb_id = ?1 AND kind = ?2")?;
    for credit in credits.split('\t') {
        let Some((kind, tmdb_id)) = credit.split_once(':') else { continue };
        let kind = match kind {
            "movie" => "movie",
            "tv" => "series",
            _ => continue,
        };
        for id in by_tmdb.query_map(params![tmdb_id, kind], |r| r.get::<_, i64>(0))? {
            ids.insert(id?);
        }
    }
    // Only titles with a file still here, newest first.
    let list = format!("[{}]", ids.iter().map(i64::to_string).collect::<Vec<_>>().join(","));
    let mut stmt = conn.prepare(
        "SELECT t.id FROM titles t
          WHERE t.id IN (SELECT value FROM json_each(?1))
            AND EXISTS (SELECT 1 FROM media_files m WHERE m.title_id = t.id AND m.missing = 0)
          ORDER BY t.year IS NULL, t.year DESC, t.id",
    )?;
    let held = stmt
        .query_map(params![list], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let profile_path = match &profile_url {
        Some(url) => conn
            .query_row(
                "SELECT ?1 || local_path FROM artwork_cache WHERE url = ?2 AND local_path <> ''",
                params![art, url],
                |r| r.get(0),
            )
            .ok(),
        None => None,
    };
    Ok(Some(Person {
        person_id: person_id.to_owned(),
        name,
        biography: biography.filter(|b| !b.trim().is_empty()),
        profile_url,
        profile_path,
        imdb_id: imdb_id.filter(|i| !i.is_empty()),
        fresh: fetched_at.is_some_and(|at| now - at < PERSON_MAX_AGE_SECS),
        title_ids: held,
    }))
}

pub(crate) fn save(conn: &Connection, person: &PersonInput, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO person_info (person_id, name, biography, profile_url, imdb_id, credits, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(person_id) DO UPDATE SET
            name = excluded.name, biography = excluded.biography,
            profile_url = excluded.profile_url, imdb_id = excluded.imdb_id,
            credits = excluded.credits, fetched_at = excluded.fetched_at",
        params![
            person.person_id,
            person.name,
            person.biography,
            person.profile_url,
            person.imdb_id,
            person.credits.join("\t"),
            now
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub fn get_person(app: tauri::AppHandle, db: tauri::State<Db>, person_id: String) -> Result<Option<Person>, String> {
    let art = path_prefix(&app)?;
    let conn = db.0.lock().map_err(to_string_err)?;
    person(&conn, &art, &person_id, now_secs()).map_err(to_string_err)
}

#[tauri::command]
pub fn save_person(db: tauri::State<Db>, person: PersonInput) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    save(&conn, &person, now_secs()).map_err(to_string_err)
}

#[cfg(test)]
mod tests {
    use super::{person, save, PersonInput, PERSON_MAX_AGE_SECS};

    fn library(name: &str) -> rusqlite::Connection {
        let dir = std::env::temp_dir().join(format!("pn-people-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("library.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:/films', 'movies', 0);
             INSERT INTO titles (id, kind, provider, provider_id, tmdb_id, title, year, fetched_at) VALUES
                 (1, 'movie',  'tmdb', '11', '11', 'Old film',   1990, 0),
                 (2, 'movie',  'tmdb', '22', '22', 'New film',   2020, 0),
                 (3, 'series', 'tmdb', '33', '33', 'A show',     2005, 0),
                 (4, 'movie',  'tmdb', '44', '44', 'Not held',   2010, 0),
                 (5, 'movie',  'tmdb', '55', '55', 'Namesake',   2015, 0);
             INSERT INTO people (title_id, name, ord, person_id) VALUES
                 (1, 'Ada Actor', 0, '7'),
                 (4, 'Ada Actor', 0, '7'),
                 (5, 'Ada Actor', 0, '8');",
        )
        .unwrap();
        for (id, title) in [(101, 1), (102, 2), (103, 3), (105, 5)] {
            conn.execute(
                "INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                     size_bytes, modified_at, first_seen_at, last_seen_at, match_status, title_id)
                 VALUES (?1, 1, ?2, 'C:/films', ?2, 'mkv', 1, 0, 0, 0, 'matched', ?3)",
                rusqlite::params![id, format!("C:/films/{id}.mkv"), title],
            )
            .unwrap();
        }
        conn
    }

    /// From the stored cast alone: by id, never by name — the namesake (8)
    /// is not them — and only titles with a file here.
    #[test]
    fn a_person_s_titles_are_theirs_by_id_and_held() {
        let conn = library("cast");
        let p = person(&conn, "", "7", 0).unwrap().unwrap();
        assert_eq!(p.name, "Ada Actor");
        assert_eq!(p.title_ids, vec![1]);
        assert!(!p.fresh);
        assert!(person(&conn, "", "9", 0).unwrap().is_none());
    }

    /// TMDB's credits add the titles whose stored cast does not list them,
    /// by kind and TMDB id, newest first; kept a month.
    #[test]
    fn tmdb_credits_find_the_rest_and_are_kept_a_month() {
        let conn = library("credits");
        let input = PersonInput {
            person_id: "7".into(),
            name: "Ada Actor".into(),
            biography: Some("Born somewhere.".into()),
            profile_url: None,
            imdb_id: Some("nm0000001".into()),
            // movie 33 is not the show 33; tv 33 is.
            credits: vec!["movie:22".into(), "tv:33".into(), "movie:33".into(), "person:1".into()],
        };
        save(&conn, &input, 1000).unwrap();
        let p = person(&conn, "", "7", 1000 + PERSON_MAX_AGE_SECS - 1).unwrap().unwrap();
        assert_eq!(p.title_ids, vec![2, 3, 1]);
        assert_eq!(p.biography.as_deref(), Some("Born somewhere."));
        assert_eq!(p.imdb_id.as_deref(), Some("nm0000001"));
        assert!(p.fresh);
        assert!(!person(&conn, "", "7", 1000 + PERSON_MAX_AGE_SECS).unwrap().unwrap().fresh);
    }
}
