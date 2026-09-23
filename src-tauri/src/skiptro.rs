//! Reading Skiptro's own database, instead of the sidecars it exports.
//!
//! Skiptro already stores every detection it makes in a SQLite database of its
//! own, at `%APPDATA%\Skiptro\skiptro.db`. The `.skiptro.json` files beside the
//! videos are an *export* of that database, and the app used to read the export
//! rather than the source — which meant one extra file per episode sitting in
//! every media folder forever, for information the app could ask for directly.
//!
//! Reading the source instead removes the clutter and nothing else changes:
//! same numbers, same detections, and the sidecar reader stays as a fallback so
//! existing exports (and any other producer of that format) still work.
//!
//! **This reads another application's private schema.** That is a real cost and
//! it is worth naming: a Skiptro update is free to rename these columns, and
//! nothing will warn us. Everything here is therefore written to fail *loudly
//! into the log and softly into the app* — a schema that no longer matches
//! yields no markers and a logged reason, and `skip.rs` falls through to the
//! sidecar, which is exactly the behaviour that existed before.

use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Setting key: where Skiptro keeps its database, when it is not in the usual
/// place. Empty or unset means [`default_db_path`].
pub const DB_PATH_KEY: &str = "skiptro_db_path";

/// `DetectedSegments.Type` for an introduction.
///
/// The only value Skiptro 1.2.0 ever writes. Other values are logged rather
/// than mapped onto anything: guessing that `1` means credits would produce a
/// marker out of nothing, and a marker invented from a number is precisely the
/// silent wrongness the metadata rules exist to prevent.
const TYPE_INTRO: i64 = 0;

/// Where Skiptro keeps its database when it has not been told otherwise.
///
/// Windows only, because that is the only platform this app ships on. The
/// user can point at any path from Settings if they moved it.
pub fn default_db_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(Path::new(&appdata).join("Skiptro").join("skiptro.db"))
}

/// The size and mtime of a file, as a short string, or `""` when it is absent.
fn stamp(path: &Path) -> String {
    let Ok(meta) = std::fs::metadata(path) else {
        return String::new();
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}:{}", meta.len(), mtime)
}

/// A fingerprint of the database's current contents, for cache invalidation.
///
/// **The write-ahead log is included, and that is the whole point.** Skiptro
/// runs in WAL mode, so a scan that finds twenty new intros can leave
/// `skiptro.db` itself untouched — on this machine the main file is 4 KB and
/// every row lives in `skiptro.db-wal`. Keying the cache on the main file alone
/// would look completely correct and would never notice a new detection.
pub fn version_stamp(db_path: &Path) -> String {
    let wal = db_path.with_extension("db-wal");
    format!("skiptro[{}|{}]", stamp(db_path), stamp(&wal))
}

/// An intro segment for one video, straight from Skiptro's database.
#[derive(Debug, PartialEq)]
pub struct Detection {
    pub start: f64,
    pub end: f64,
    /// Skiptro's own confidence, 0..1. Below `MIN_SKIPTRO_CONFIDENCE` in
    /// `skip.rs` the app's own analysis is preferred for the intro.
    pub confidence: f64,
}

/// Open Skiptro's database without being able to change it.
///
/// `mode=ro` rather than `immutable=1`. The difference is not a nicety: an
/// immutable open of a WAL database ignores the write-ahead log completely and
/// reports **an empty schema with no error at all**, so every query returns
/// "no such table" and the app would conclude, quietly and permanently, that
/// nothing has ever been detected. Verified against the real file.
fn open_read_only(db_path: &Path) -> rusqlite::Result<Connection> {
    let uri = format!("file:{}?mode=ro", db_path.to_string_lossy().replace('\\', "/"));
    let conn = Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )?;
    // Wait rather than fail while Skiptro is writing. The automatic pass runs
    // Skiptro at the end of every startup scan, which is exactly when an
    // episode is likely to be started — and without this the read failed at
    // once, the episode fell back to a worse source, and that worse answer was
    // cached.
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(conn)
}

/// How long a read waits for Skiptro to finish a write. Short: this runs while
/// an episode is starting, and a missing marker costs less than a stall.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// The intro Skiptro detected for one video, if it has one.
///
/// Matched on the **exact file path**, case-insensitively, which is how Skiptro
/// itself keys the row. Renaming or moving a video therefore loses its
/// detection until Skiptro is run again — the same fragility the sidecars had,
/// minus the files. This machine's database already carries twelve rows
/// pointing at paths that no longer exist for exactly that reason.
pub fn detection_for(db_path: &Path, video: &Path) -> Option<Detection> {
    if !db_path.is_file() {
        return None;
    }

    let conn = match open_read_only(db_path) {
        Ok(conn) => conn,
        Err(e) => {
            crate::log!("skiptro: could not open {}: {e}", db_path.display());
            return None;
        }
    };

    let rows = conn.prepare(
        "SELECT Type, StartSeconds, EndSeconds, Confidence
           FROM DetectedSegments
          WHERE FilePath = ?1 COLLATE NOCASE",
    );

    let mut statement = match rows {
        Ok(s) => s,
        Err(e) => {
            // The schema moved under us. Loud here, harmless in the app.
            crate::log!("skiptro: DetectedSegments is not readable ({e}) — falling back to sidecars");
            return None;
        }
    };

    let path = video.to_string_lossy().into_owned();
    let found = statement.query_map([&path], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, f64>(1)?,
            r.get::<_, f64>(2)?,
            r.get::<_, f64>(3).unwrap_or(0.0),
        ))
    });

    let found = match found {
        Ok(found) => found,
        Err(e) => {
            crate::log!("skiptro: reading {} failed ({e})", db_path.display());
            return None;
        }
    };

    for row in found {
        let row = match row {
            Ok(row) => row,
            Err(e) => {
                crate::log!("skiptro: unreadable row for {path} ({e})");
                continue;
            }
        };
        let (kind, start, end, confidence) = row;
        if kind != TYPE_INTRO {
            // A version that started detecting something else. Worth knowing
            // about; not worth guessing at.
            crate::log!("skiptro: ignoring unknown segment type {kind} for {path}");
            continue;
        }
        if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start {
            continue;
        }
        return Some(Detection {
            start,
            end,
            confidence,
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a database with Skiptro's schema, as recorded from the real file.
    fn fixture(dir: &Path, rows: &[(&str, i64, f64, f64, f64)]) -> PathBuf {
        let path = dir.join("skiptro.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE DetectedSegments (
                 Id INTEGER PRIMARY KEY AUTOINCREMENT,
                 LibraryId INTEGER NOT NULL,
                 FilePath TEXT NOT NULL,
                 ShowName TEXT, Season INTEGER, Episode INTEGER,
                 Type INTEGER NOT NULL,
                 StartSeconds REAL NOT NULL,
                 EndSeconds REAL NOT NULL,
                 Confidence REAL NOT NULL,
                 DetectedAt TEXT NOT NULL,
                 FileModifiedAt TEXT NOT NULL,
                 UserStatus INTEGER NOT NULL DEFAULT 0)",
        )
        .unwrap();

        for (file, kind, start, end, confidence) in rows {
            conn.execute(
                "INSERT INTO DetectedSegments
                    (LibraryId, FilePath, Type, StartSeconds, EndSeconds, Confidence,
                     DetectedAt, FileModifiedAt)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, '', '')",
                rusqlite::params![file, kind, start, end, confidence],
            )
            .unwrap();
        }
        path
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pn-skiptro-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The shape of a real row: the timings are Skiptro's own output, kept to
    /// the digit because the point is that they survive the round trip.
    #[test]
    fn reads_an_intro_for_the_matching_path() {
        let dir = temp_dir("reads");
        let video = r"C:\media\Example.Show.S01E08.mp4";
        let db = fixture(&dir, &[(video, 0, 0.1857764, 46.6617627, 1.0)]);

        let found = detection_for(&db, Path::new(video)).expect("row should be found");
        assert_eq!(found.start, 0.1857764);
        assert_eq!(found.end, 46.6617627);
        assert_eq!(found.confidence, 1.0);
    }

    /// Windows paths differ in case without differing as paths.
    #[test]
    fn matches_a_path_regardless_of_case() {
        let dir = temp_dir("case");
        let db = fixture(&dir, &[(r"C:\Media\Show S01E01.mkv", 0, 1.0, 40.0, 1.0)]);
        assert!(detection_for(&db, Path::new(r"c:\media\show s01e01.mkv")).is_some());
    }

    #[test]
    fn a_file_with_no_row_yields_nothing() {
        let dir = temp_dir("missing");
        let db = fixture(&dir, &[(r"C:\media\Other.mkv", 0, 1.0, 40.0, 1.0)]);
        assert_eq!(detection_for(&db, Path::new(r"C:\media\Show.mkv")), None);
    }

    /// Skiptro 1.2.0 only ever writes type 0. A future version writing anything
    /// else must not be read as an intro.
    #[test]
    fn an_unknown_segment_type_is_not_treated_as_an_intro() {
        let dir = temp_dir("type");
        let video = r"C:\media\Show.mkv";
        let db = fixture(&dir, &[(video, 7, 1.0, 40.0, 1.0)]);
        assert_eq!(detection_for(&db, Path::new(video)), None);
    }

    #[test]
    fn rejects_a_segment_that_would_seek_backwards_or_nowhere() {
        let dir = temp_dir("bad");
        let video = r"C:\media\Show.mkv";
        let db = fixture(&dir, &[(video, 0, 90.0, 30.0, 1.0), (video, 0, 5.0, 5.0, 1.0)]);
        assert_eq!(detection_for(&db, Path::new(video)), None);
    }

    #[test]
    fn a_database_that_is_not_there_is_not_an_error() {
        assert_eq!(
            detection_for(Path::new(r"C:\nope\skiptro.db"), Path::new(r"C:\media\Show.mkv")),
            None
        );
    }

    /// A file that exists but is not Skiptro's database at all.
    #[test]
    fn a_database_without_the_expected_table_yields_nothing() {
        let dir = temp_dir("schema");
        let path = dir.join("skiptro.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE Something (x INTEGER)")
            .unwrap();
        assert_eq!(detection_for(&path, Path::new(r"C:\media\Show.mkv")), None);
    }

    /// The stamp has to move when the write-ahead log does, because that is
    /// where a fresh scan's rows actually land.
    #[test]
    fn the_version_stamp_covers_the_write_ahead_log() {
        let dir = temp_dir("stamp");
        let db = fixture(&dir, &[]);
        let before = version_stamp(&db);

        std::fs::write(db.with_extension("db-wal"), b"pretend this is a scan").unwrap();
        assert_ne!(version_stamp(&db), before);
    }
}
