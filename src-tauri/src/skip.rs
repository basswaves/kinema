//! Intro and credits markers, read from `.skiptro.json` sidecars.
//!
//! Skiptro is run separately — it fingerprints audio and writes a small JSON
//! file next to each video. Nothing here produces markers; this only reads
//! them, which is why the format matters more than the tool: any producer that
//! writes the same sidecar works, including a future ffmpeg/chromaprint one.
//!
//! The exact shape beyond `intro` is not confirmed, so parsing is tolerant of
//! *naming* (credits vs outro) but never invents structure. A sidecar that
//! exists and yields nothing recognisable is logged with its actual keys rather
//! than being treated as "no markers" — an unreadable format should be visible,
//! not silently indistinguishable from a show with no intro.

use crate::library::Db;
use rusqlite::params;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn to_string_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Segment names accepted for the closing segment. Skiptro's own naming is
/// confirmed only for `intro`.
const CREDITS_KEYS: [&str; 3] = ["credits", "outro", "ending"];

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
}

#[derive(Serialize, Debug, Default)]
pub struct SkipMarkers {
    pub intro: Option<Segment>,
    pub credits: Option<Segment>,
    /// Which file these came from, so the UI can say where they were found.
    pub sidecar: Option<String>,
}

/// Where a sidecar might live for a given video.
///
/// Both conventions are checked because the producer decides: replacing the
/// extension (`Episode.skiptro.json`) and appending to the whole filename
/// (`Episode.mkv.skiptro.json`) are both common for sidecars.
fn candidate_paths(video: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(stem) = video.file_stem() {
        let mut name = stem.to_os_string();
        name.push(".skiptro.json");
        paths.push(video.with_file_name(name));
    }

    if let Some(file_name) = video.file_name() {
        let mut name = file_name.to_os_string();
        name.push(".skiptro.json");
        paths.push(video.with_file_name(name));
    }

    paths
}

/// Pull `{ "start": <secs>, "end": <secs> }` out of a value, whatever it is
/// nested in. A segment with end <= start is rejected: it would either do
/// nothing or seek backwards.
fn parse_segment(value: &serde_json::Value) -> Option<Segment> {
    let start = value.get("start")?.as_f64()?;
    let end = value.get("end")?.as_f64()?;

    if !start.is_finite() || !end.is_finite() || end <= start || start < 0.0 {
        return None;
    }
    Some(Segment { start, end })
}

fn parse_sidecar(raw: &str, path: &Path) -> SkipMarkers {
    let parsed: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("skip: {} is not valid JSON: {e}", path.display());
            return SkipMarkers::default();
        }
    };

    let intro = parsed.get("intro").and_then(parse_segment);
    let credits = CREDITS_KEYS
        .iter()
        .find_map(|key| parsed.get(*key).and_then(parse_segment));

    if intro.is_none() && credits.is_none() {
        // The file is there but says nothing we understand. Report the keys it
        // does have — that is the fastest route to supporting the real format.
        let keys: Vec<&str> = parsed
            .as_object()
            .map(|o| o.keys().map(|k| k.as_str()).collect())
            .unwrap_or_default();
        eprintln!(
            "skip: no usable segments in {} — top-level keys: {:?}",
            path.display(),
            keys
        );
    }

    SkipMarkers {
        intro,
        credits,
        sidecar: Some(path.display().to_string()),
    }
}

struct Sidecar {
    path: PathBuf,
    size: i64,
    mtime: i64,
}

fn find_sidecar(video: &Path) -> Option<Sidecar> {
    for path in candidate_paths(video) {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        return Some(Sidecar {
            path,
            size: meta.len() as i64,
            mtime,
        });
    }
    None
}

fn cached(
    conn: &rusqlite::Connection,
    file_id: i64,
    sidecar: &Sidecar,
) -> Option<SkipMarkers> {
    let path = sidecar.path.display().to_string();

    conn.query_row(
        "SELECT intro_start, intro_end, credits_start, credits_end
           FROM skip_markers
          WHERE file_id = ?1 AND sidecar_path = ?2
            AND sidecar_size = ?3 AND sidecar_mtime = ?4",
        params![file_id, &path, sidecar.size, sidecar.mtime],
        |r| {
            let intro = match (r.get::<_, Option<f64>>(0)?, r.get::<_, Option<f64>>(1)?) {
                (Some(start), Some(end)) => Some(Segment { start, end }),
                _ => None,
            };
            let credits = match (r.get::<_, Option<f64>>(2)?, r.get::<_, Option<f64>>(3)?) {
                (Some(start), Some(end)) => Some(Segment { start, end }),
                _ => None,
            };
            Ok(SkipMarkers {
                intro,
                credits,
                sidecar: Some(path.clone()),
            })
        },
    )
    .ok()
}

fn store(
    conn: &rusqlite::Connection,
    file_id: i64,
    sidecar: &Sidecar,
    markers: &SkipMarkers,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO skip_markers
            (file_id, sidecar_path, sidecar_size, sidecar_mtime,
             intro_start, intro_end, credits_start, credits_end, checked_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(file_id) DO UPDATE SET
            sidecar_path  = excluded.sidecar_path,
            sidecar_size  = excluded.sidecar_size,
            sidecar_mtime = excluded.sidecar_mtime,
            intro_start   = excluded.intro_start,
            intro_end     = excluded.intro_end,
            credits_start = excluded.credits_start,
            credits_end   = excluded.credits_end,
            checked_at    = excluded.checked_at",
        params![
            file_id,
            sidecar.path.display().to_string(),
            sidecar.size,
            sidecar.mtime,
            markers.intro.map(|s| s.start),
            markers.intro.map(|s| s.end),
            markers.credits.map(|s| s.start),
            markers.credits.map(|s| s.end),
            now_secs()
        ],
    )?;
    Ok(())
}

/// Markers for one video, or `None` when there is no sidecar.
///
/// `file_id` is optional so an ad-hoc file (dragged in, not in the library)
/// still gets markers — it just does not get a cache entry.
#[tauri::command]
pub fn get_skip_markers(
    db: tauri::State<Db>,
    path: String,
    file_id: Option<i64>,
) -> Result<Option<SkipMarkers>, String> {
    let video = Path::new(&path);

    // One stat is the whole filesystem cost when the cache is warm. It is also
    // what makes the cache safe: markers produced after the first play are
    // picked up, because the sidecar's mtime no longer matches.
    let Some(sidecar) = find_sidecar(video) else {
        if let Some(id) = file_id {
            let conn = db.0.lock().map_err(to_string_err)?;
            conn.execute("DELETE FROM skip_markers WHERE file_id = ?1", params![id])
                .map_err(to_string_err)?;
        }
        return Ok(None);
    };

    if let Some(id) = file_id {
        let conn = db.0.lock().map_err(to_string_err)?;
        if let Some(hit) = cached(&conn, id, &sidecar) {
            return Ok(Some(hit));
        }
    }

    let raw = std::fs::read_to_string(&sidecar.path).map_err(to_string_err)?;
    let markers = parse_sidecar(&raw, &sidecar.path);

    if let Some(id) = file_id {
        let conn = db.0.lock().map_err(to_string_err)?;
        store(&conn, id, &sidecar, &markers).map_err(to_string_err)?;
    }

    Ok(Some(markers))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_documented_intro_shape() {
        let markers = parse_sidecar(
            r#"{ "intro": { "start": 0, "end": 87.5 } }"#,
            Path::new("x.skiptro.json"),
        );
        assert_eq!(markers.intro, Some(Segment { start: 0.0, end: 87.5 }));
        assert_eq!(markers.credits, None);
    }

    #[test]
    fn accepts_either_name_for_the_closing_segment() {
        for key in ["credits", "outro", "ending"] {
            let raw = format!(r#"{{ "{key}": {{ "start": 2600, "end": 2700 }} }}"#);
            let markers = parse_sidecar(&raw, Path::new("x.skiptro.json"));
            assert_eq!(
                markers.credits,
                Some(Segment {
                    start: 2600.0,
                    end: 2700.0
                }),
                "key {key} should be recognised"
            );
        }
    }

    #[test]
    fn rejects_segments_that_would_seek_backwards_or_nowhere() {
        for raw in [
            r#"{ "intro": { "start": 90, "end": 30 } }"#,
            r#"{ "intro": { "start": 90, "end": 90 } }"#,
            r#"{ "intro": { "start": -5, "end": 30 } }"#,
            r#"{ "intro": { "start": 0 } }"#,
        ] {
            let markers = parse_sidecar(raw, Path::new("x.skiptro.json"));
            assert_eq!(markers.intro, None, "should reject {raw}");
        }
    }

    #[test]
    fn malformed_json_yields_no_markers_rather_than_an_error() {
        let markers = parse_sidecar("not json at all", Path::new("x.skiptro.json"));
        assert!(markers.intro.is_none() && markers.credits.is_none());
    }

    #[test]
    fn looks_for_both_sidecar_naming_conventions() {
        let paths = candidate_paths(Path::new(r"C:\media\Show S01E01.mkv"));
        let names: Vec<String> = paths
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"Show S01E01.skiptro.json".to_string()));
        assert!(names.contains(&"Show S01E01.mkv.skiptro.json".to_string()));
    }
}
