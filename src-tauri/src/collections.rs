//! What each title's files were measured to hold, for smart collections
//! (`src/library/collections.ts`): 4K, HDR, Dolby Vision and its profile,
//! HDR10+, Atmos, DTS:X.
//!
//! Only what `probe.rs` read from the files themselves — never a release name
//! — so a collection never says a film has something its file does not (the
//! badges rule, DECISIONS.md). 3D and IMAX are not offered: nothing here
//! measures them.
//!
//! A film counts when any of its versions holds the trait: that version is
//! there to play. A series counts only when every episode it has was read and
//! each holds it (any version of the episode) — one Dolby Vision episode does
//! not make a Dolby Vision show.

use crate::library::Db;
use crate::probe::MediaDetails;
use crate::util::to_string_err;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Serialize, Debug, PartialEq)]
pub struct TitleTraits {
    pub title_id: i64,
    /// `4k`, `hdr`, `dv`, `dv:<profile>`, `hdr10plus`, `atmos`, `dtsx`.
    pub traits: Vec<String>,
}

/// The traits one file was measured to have.
fn file_traits(details: &MediaDetails) -> BTreeSet<String> {
    let mut traits = BTreeSet::new();
    if let Some(video) = &details.video {
        // As the 4K badge (badges.ts): by width first, a scope film is still 4K.
        if video.width >= 3200 || video.height >= 2000 {
            traits.insert("4k".to_string());
        }
        if video.transfer != crate::probe::Transfer::Sdr || video.dolby_vision.is_some() {
            traits.insert("hdr".to_string());
        }
        if video.hdr10_plus {
            traits.insert("hdr10plus".to_string());
        }
        if let Some(dv) = &video.dolby_vision {
            traits.insert("dv".to_string());
            traits.insert(format!("dv:{}", dv.profile));
        }
    }
    for audio in &details.audio {
        let profile = audio.profile.as_deref().unwrap_or("");
        if profile.contains("Atmos") {
            traits.insert("atmos".to_string());
        }
        if profile.contains("DTS:X") {
            traits.insert("dtsx".to_string());
        }
    }
    traits
}

fn traits_of(conn: &Connection) -> rusqlite::Result<Vec<TitleTraits>> {
    let mut statement = conn.prepare(
        "SELECT t.id, t.kind = 'series', m.parsed_season, m.parsed_episode, p.details
           FROM media_files m
           JOIN titles t ON t.id = m.title_id
           LEFT JOIN media_probe p ON p.file_id = m.id
          WHERE m.missing = 0",
    )?;
    // Per title, per episode (a film is one "episode"): each version's traits,
    // `None` for a version not read.
    type Versions = Vec<Option<BTreeSet<String>>>;
    type Episodes = BTreeMap<(Option<i64>, Option<i64>), Versions>;
    let mut titles: BTreeMap<i64, (bool, Episodes)> = BTreeMap::new();
    let rows = statement.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, bool>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, Option<String>>(4)?,
        ))
    })?;
    for row in rows {
        let (title_id, series, season, episode, details) = row?;
        let read = details
            .and_then(|text| serde_json::from_str::<MediaDetails>(&text).ok())
            .map(|d| file_traits(&d));
        let key = if series { (season, episode) } else { (None, None) };
        let entry = titles.entry(title_id).or_insert_with(|| (series, BTreeMap::new()));
        entry.1.entry(key).or_default().push(read);
    }
    Ok(titles
        .into_iter()
        .filter_map(|(title_id, (series, episodes))| {
            // What any version of each episode holds; `None` when no version
            // of it was read.
            let per_episode: Vec<Option<BTreeSet<String>>> = episodes
                .into_values()
                .map(|versions| {
                    let read: Vec<_> = versions.into_iter().flatten().collect();
                    (!read.is_empty()).then(|| read.into_iter().flatten().collect())
                })
                .collect();
            let traits: BTreeSet<String> = if series {
                // Every episode read, and the trait in each.
                let all: Option<Vec<BTreeSet<String>>> = per_episode.into_iter().collect();
                let mut all = all?.into_iter();
                let first = all.next()?;
                all.fold(first, |acc, next| acc.intersection(&next).cloned().collect())
            } else {
                per_episode.into_iter().flatten().flatten().collect()
            };
            (!traits.is_empty()).then(|| TitleTraits {
                title_id,
                traits: traits.into_iter().collect(),
            })
        })
        .collect())
}

/// Tauri command: the measured traits of every title that has any. A
/// database read, so it stays synchronous (see `jobs.rs`).
#[tauri::command]
pub fn title_traits(db: tauri::State<Db>) -> Result<Vec<TitleTraits>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    traits_of(&conn).map_err(to_string_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&conn).map_err(|e| e.to_string()).unwrap();
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'D:\\Media', 'movies', 0);
             INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at)
             VALUES (1, 'movie', 'tmdb', '1', 'A film', 0),
                    (2, 'series', 'tmdb', '2', 'A show', 0);",
        )
        .unwrap();
        conn
    }

    /// A file of `title`, read as `details` (or not read, with `None`).
    fn file(conn: &Connection, id: i64, title: i64, ep: Option<i64>, details: Option<&str>) {
        conn.execute(
            "INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                                      size_bytes, modified_at, first_seen_at, last_seen_at,
                                      title_id, parsed_season, parsed_episode)
             VALUES (?1, 1, 'D:\\Media\\' || ?1, 'D:\\Media', ?1, 'mkv', 1, 1, 0, 0, ?2, ?3, ?3)",
            params![id, title, ep],
        )
        .unwrap();
        if let Some(details) = details {
            conn.execute(
                "INSERT INTO media_probe (file_id, size_bytes, modified_at, probe_version,
                                          probed_at, details)
                 VALUES (?1, 1, 1, 2, 0, ?2)",
                params![id, details],
            )
            .unwrap();
        }
    }

    const UHD_DV_ATMOS: &str = r#"{"container":null,"duration_secs":null,"bit_rate":null,
        "video":{"codec":"hevc","profile":null,"width":3840,"height":1600,"bit_depth":10,
          "frame_rate":null,"interlaced":false,"aspect_ratio":null,"transfer":"pq",
          "hdr10_plus":false,"dolby_vision":{"profile":7,"level":6,"compatibility":6,
          "enhancement_layer":"FEL"},"mastering_peak_nits":null,"max_cll":null,"max_fall":null},
        "audio":[{"codec":"truehd","profile":"Dolby TrueHD + Dolby Atmos","channels":8,
          "layout":"7.1","language":"eng","title":null,"default":true,"commentary":false}],
        "subtitles":[]}"#;
    const HD_SDR: &str = r#"{"container":null,"duration_secs":null,"bit_rate":null,
        "video":{"codec":"h264","profile":null,"width":1920,"height":1080,"bit_depth":8,
          "frame_rate":null,"interlaced":false,"aspect_ratio":null,"transfer":"sdr",
          "hdr10_plus":false,"dolby_vision":null,"mastering_peak_nits":null,"max_cll":null,
          "max_fall":null},
        "audio":[{"codec":"dts","profile":"DTS-HD MA + DTS:X","channels":8,"layout":"7.1",
          "language":null,"title":null,"default":true,"commentary":false}],"subtitles":[]}"#;

    fn traits(conn: &Connection, title: i64) -> Vec<String> {
        traits_of(conn)
            .unwrap()
            .into_iter()
            .find(|t| t.title_id == title)
            .map(|t| t.traits)
            .unwrap_or_default()
    }

    #[test]
    fn a_film_has_what_any_of_its_versions_holds() {
        let conn = library();
        file(&conn, 1, 1, None, Some(UHD_DV_ATMOS));
        file(&conn, 2, 1, None, Some(HD_SDR));
        assert_eq!(traits(&conn, 1), ["4k", "atmos", "dtsx", "dv", "dv:7", "hdr"]);
    }

    #[test]
    fn a_file_never_read_says_nothing() {
        let conn = library();
        file(&conn, 1, 1, None, None);
        assert!(traits(&conn, 1).is_empty());
    }

    /// One 4K episode is not a 4K show.
    #[test]
    fn a_series_has_only_what_every_episode_holds() {
        let conn = library();
        file(&conn, 1, 2, Some(1), Some(UHD_DV_ATMOS));
        file(&conn, 2, 2, Some(2), Some(HD_SDR));
        assert!(traits(&conn, 2).is_empty());
        conn.execute("UPDATE media_probe SET details = ?1 WHERE file_id = 2", [UHD_DV_ATMOS])
            .unwrap();
        assert_eq!(traits(&conn, 2), ["4k", "atmos", "dv", "dv:7", "hdr"]);
    }

    /// An episode not read yet might not hold it: the show waits.
    #[test]
    fn a_series_with_an_episode_not_read_has_nothing_yet() {
        let conn = library();
        file(&conn, 1, 2, Some(1), Some(UHD_DV_ATMOS));
        file(&conn, 2, 2, Some(2), None);
        assert!(traits(&conn, 2).is_empty());
        // A second, read copy of that episode is enough.
        file(&conn, 3, 2, Some(2), Some(UHD_DV_ATMOS));
        assert_eq!(traits(&conn, 2), ["4k", "atmos", "dv", "dv:7", "hdr"]);
    }

    #[test]
    fn a_missing_file_does_not_count() {
        let conn = library();
        file(&conn, 1, 1, None, Some(UHD_DV_ATMOS));
        conn.execute("UPDATE media_files SET missing = 1", []).unwrap();
        assert!(traits(&conn, 1).is_empty());
    }
}
