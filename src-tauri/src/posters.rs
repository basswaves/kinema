//! The poster a person chose for a title (T20): one of TMDB's for it, or the
//! picture beside its files (local_art.rs). Kept by the title's provider ids,
//! as my_list and version_choice are, so it outlives matching again; and
//! `save_title` puts a chosen TMDB poster back after every fetch — the
//! six-month refresh included — so a refresh never undoes it. Nothing is
//! written beside the files.
//!
//! `url` is the TMDB address chosen, or empty for the picture beside the
//! file — which is what a title shows anyway when it has one, so that choice
//! only matters after a TMDB one.

use crate::artwork::path_prefix;
use crate::library::Db;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// The rows of `poster_choice` that hold a TMDB poster for title `t`: a
/// fragment for `EXISTS (…)`, shared by the queries that must agree on it.
pub const CHOSEN_TMDB: &str = "SELECT 1 FROM poster_choice c
     WHERE c.kind = t.kind AND c.provider = t.provider AND c.provider_id = t.provider_id
       AND c.url <> ''";

#[derive(Serialize, Debug, PartialEq)]
pub struct PosterOptions {
    pub kind: String,
    pub tmdb_id: Option<String>,
    /// TMDB's poster as last fetched, or the one chosen.
    pub poster_url: Option<String>,
    /// The picture beside the files, as the page may load it.
    pub local_path: Option<String>,
    /// What was chosen: a TMDB address, '' for the picture beside the file,
    /// `None` for never chosen.
    pub chosen: Option<String>,
}

pub(crate) fn options(conn: &Connection, art: &str, title_id: i64) -> rusqlite::Result<PosterOptions> {
    conn.query_row(
        "SELECT t.kind, t.tmdb_id, t.poster_url,
                (SELECT ?2 || l.local_path FROM local_art l WHERE l.title_id = t.id AND l.kind = 'poster'),
                (SELECT c.url FROM poster_choice c
                  WHERE c.kind = t.kind AND c.provider = t.provider AND c.provider_id = t.provider_id)
           FROM titles t WHERE t.id = ?1",
        params![title_id, art],
        |r| {
            Ok(PosterOptions {
                kind: r.get(0)?,
                tmdb_id: r.get::<_, Option<String>>(1)?.filter(|s| !s.is_empty()),
                poster_url: r.get(2)?,
                local_path: r.get(3)?,
                chosen: r.get(4)?,
            })
        },
    )
}

/// A title's kind, provider, provider id, IMDb id and TMDB id.
type TitleIds = (String, String, String, Option<String>, Option<String>);

/// Keep `url` as the title's poster ('' for the picture beside the file).
/// Only an address of TMDB's own image host is taken, so the page cannot be
/// made to fetch from anywhere else.
pub(crate) fn choose(conn: &Connection, title_id: i64, url: &str, now: i64) -> Result<(), String> {
    if !url.is_empty() && !url.starts_with("https://image.tmdb.org/") {
        return Err("Not one of TMDB's pictures.".into());
    }
    let ids: Option<TitleIds> = conn
        .query_row(
            "SELECT kind, provider, provider_id, imdb_id, tmdb_id FROM titles WHERE id = ?1",
            params![title_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(to_string_err)?;
    let Some((kind, provider, provider_id, imdb_id, tmdb_id)) = ids else {
        return Err("That title is not in the library any more.".into());
    };
    conn.execute(
        "INSERT INTO poster_choice (kind, provider, provider_id, imdb_id, tmdb_id, url, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(kind, provider, provider_id) DO UPDATE SET
            url = excluded.url, updated_at = excluded.updated_at,
            imdb_id = excluded.imdb_id, tmdb_id = excluded.tmdb_id",
        params![kind, provider, provider_id, imdb_id, tmdb_id, url, now],
    )
    .map_err(to_string_err)?;
    apply(conn, title_id).map_err(to_string_err)
}

/// Put a chosen TMDB poster in `titles.poster_url`, where the artwork cache
/// and every screen read it. After each save of the title.
pub(crate) fn apply(conn: &Connection, title_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "UPDATE titles AS t SET poster_url =
                (SELECT c.url FROM poster_choice c
                  WHERE c.kind = t.kind AND c.provider = t.provider AND c.provider_id = t.provider_id)
              WHERE t.id = ?1 AND EXISTS ({CHOSEN_TMDB})"
        ),
        params![title_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn poster_options(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    title_id: i64,
) -> Result<PosterOptions, String> {
    let art = path_prefix(&app)?;
    let conn = db.0.lock().map_err(to_string_err)?;
    options(&conn, &art, title_id).map_err(to_string_err)
}

#[tauri::command]
pub fn choose_poster(db: tauri::State<Db>, title_id: i64, url: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    choose(&conn, title_id, &url, now_secs())
}

#[cfg(test)]
mod tests {
    use super::{choose, options};
    use rusqlite::params;

    fn library(name: &str) -> rusqlite::Connection {
        let dir = std::env::temp_dir().join(format!("pn-posters-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("library.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO titles (id, kind, provider, provider_id, tmdb_id, title, fetched_at, poster_url)
                  VALUES (1, 'movie', 'tmdb', '11', '11', 'Film', 0, 'https://image.tmdb.org/t/p/original/a.jpg');
             INSERT INTO local_art (title_id, kind, source, size, modified, local_path)
                  VALUES (1, 'poster', 'D:/f/poster.jpg', 1, 0, 'local-1.jpg');",
        )
        .unwrap();
        conn
    }

    fn shown(conn: &rusqlite::Connection) -> Option<String> {
        conn.query_row(
            &format!("{} WHERE t.id = 1", crate::metadata::TITLE_SELECT),
            rusqlite::named_params! { ":art": "" },
            |r| r.get::<_, Option<String>>(13),
        )
        .unwrap()
    }

    /// A TMDB poster chosen over the picture beside the file is shown, and a
    /// fetch of the title — a refresh — does not undo it.
    #[test]
    fn a_chosen_poster_wins_over_the_local_one_and_outlives_a_refresh() {
        let conn = library("chosen");
        let chosen = "https://image.tmdb.org/t/p/original/b.jpg";
        assert_eq!(options(&conn, "", 1).unwrap().chosen, None);
        choose(&conn, 1, chosen, 5).unwrap();
        let poster: String = conn.query_row("SELECT poster_url FROM titles WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(poster, chosen);
        // The local picture no longer stands in front of it.
        conn.execute(
            "INSERT INTO artwork_cache (url, local_path, bytes, fetched_at) VALUES (?1, 'b-cached.jpg', 1, 0)",
            params![chosen],
        )
        .unwrap();
        assert_eq!(shown(&conn).as_deref(), Some("b-cached.jpg"));

        // The six-month refresh writes TMDB's own poster back; the choice holds.
        conn.execute("UPDATE titles SET poster_url = 'https://image.tmdb.org/t/p/original/a.jpg' WHERE id = 1", []).unwrap();
        super::apply(&conn, 1).unwrap();
        let poster: String = conn.query_row("SELECT poster_url FROM titles WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(poster, chosen);

        // Back to the picture beside the file.
        choose(&conn, 1, "", 6).unwrap();
        assert_eq!(shown(&conn).as_deref(), Some("local-1.jpg"));
        assert_eq!(options(&conn, "", 1).unwrap().chosen.as_deref(), Some(""));
    }

    #[test]
    fn only_tmdbs_own_pictures_can_be_chosen() {
        let conn = library("host");
        assert!(choose(&conn, 1, "https://example.com/x.jpg", 5).is_err());
        assert!(choose(&conn, 99, "", 5).is_err());
    }
}
