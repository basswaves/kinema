//! SQLite storage for the media library.
//!
//! The database lives in the app data directory, not next to the media, so
//! network shares stay read-only as far as this app is concerned.

use rusqlite::Connection;
use std::path::Path;

/// The schema this build understands. Bump it with every new `SCHEMA_V*`.
pub const SCHEMA_VERSION: i64 = 13;

/// What can go wrong opening the library.
///
/// A type of its own only because of the second variant: a database from a
/// newer build is not a SQLite error, it is a situation SQLite is perfectly
/// happy with and this program is not.
#[derive(Debug)]
pub enum DbError {
    Sqlite(rusqlite::Error),
    /// The file was written by a newer build than this one.
    TooNew { found: i64, supported: i64 },
    /// An upgrade was needed and the safety copy could not be made, so the
    /// upgrade was not attempted.
    Backup(String),
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::Sqlite(e) => write!(f, "{e}"),
            DbError::TooNew { found, supported } => write!(
                f,
                "This library was created by a newer version of Kinema \
                 (database version {found}; this build understands {supported}). \
                 Update Kinema, or point it at a different library."
            ),
            DbError::Backup(reason) => write!(
                f,
                "This version of Kinema needs to upgrade your library, and it \
                 makes a safety copy first. The copy could not be made, so \
                 nothing was changed.\n\n{reason}"
            ),
        }
    }
}

impl std::error::Error for DbError {}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        DbError::Sqlite(e)
    }
}

/// Schema version 1. Kept as one batch so a fresh install and a migrated one
/// end up byte-identical.
const SCHEMA_V1: &str = r#"
CREATE TABLE library_roots (
    id        INTEGER PRIMARY KEY,
    path      TEXT    NOT NULL UNIQUE,
    kind      TEXT    NOT NULL,              -- 'movies' | 'tv'
    added_at  INTEGER NOT NULL
);

-- One row per video file on disk. This table is deliberately about *files*,
-- not about titles: matching a file to a movie or episode happens later and
-- can be redone without rescanning.
CREATE TABLE media_files (
    id            INTEGER PRIMARY KEY,
    root_id       INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,

    path          TEXT    NOT NULL UNIQUE,
    parent_dir    TEXT    NOT NULL,          -- used as a parse fallback when
                                             -- the filename itself is junk
    file_name     TEXT    NOT NULL,
    extension     TEXT    NOT NULL,

    -- NAS-aware identity: never hash a whole file over SMB. Size + mtime is
    -- enough to detect a changed file, and costs one stat call.
    size_bytes    INTEGER NOT NULL,
    modified_at   INTEGER NOT NULL,

    first_seen_at INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    missing       INTEGER NOT NULL DEFAULT 0,

    -- Filled in by the parse pass (guessit-js runs in the frontend).
    parsed_at      INTEGER,
    parsed_title   TEXT,
    parsed_year    INTEGER,
    parsed_season  INTEGER,
    parsed_episode INTEGER,
    parsed_kind    TEXT,                     -- 'movie' | 'episode'
    parsed_from    TEXT,                     -- 'file' | 'parent'
    parsed_json    TEXT,

    -- unparsed -> parsed -> matched | unmatched | ignored
    match_status  TEXT    NOT NULL DEFAULT 'unparsed'
);

CREATE INDEX idx_media_files_root    ON media_files(root_id);
CREATE INDEX idx_media_files_status  ON media_files(match_status);
CREATE INDEX idx_media_files_missing ON media_files(missing);
CREATE INDEX idx_media_files_title   ON media_files(parsed_title);
"#;

/// Schema version 2: settings (API keys live here, in app data — never in the
/// repo) and cached metadata matches.
const SCHEMA_V2: &str = r#"
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per matched title. Files point at these; re-matching a file never
-- refetches metadata that is already here.
CREATE TABLE titles (
    id           INTEGER PRIMARY KEY,
    kind         TEXT    NOT NULL,          -- 'movie' | 'series'
    provider     TEXT    NOT NULL,          -- 'tmdb' | 'tvmaze' | 'omdb'
    provider_id  TEXT    NOT NULL,
    imdb_id      TEXT,
    tmdb_id      TEXT,

    title        TEXT    NOT NULL,
    year         INTEGER,
    overview     TEXT,
    genres       TEXT,                      -- JSON array
    runtime_mins INTEGER,
    rating       REAL,
    poster_url   TEXT,
    backdrop_url TEXT,

    fetched_at   INTEGER NOT NULL,
    UNIQUE(provider, provider_id)
);

CREATE TABLE episodes (
    id           INTEGER PRIMARY KEY,
    title_id     INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
    season       INTEGER NOT NULL,
    episode      INTEGER NOT NULL,
    name         TEXT,
    overview     TEXT,
    air_date     TEXT,
    runtime_mins INTEGER,
    still_url    TEXT,
    UNIQUE(title_id, season, episode)
);

-- How a file was matched, kept separate from the file row so matching can be
-- re-run without touching scan data.
ALTER TABLE media_files ADD COLUMN title_id INTEGER REFERENCES titles(id);
ALTER TABLE media_files ADD COLUMN match_confidence REAL;
ALTER TABLE media_files ADD COLUMN match_reason TEXT;

CREATE INDEX idx_episodes_title ON episodes(title_id);
CREATE INDEX idx_media_title    ON media_files(title_id);
"#;

/// Schema version 3: resume points and per-title playback preferences.
const SCHEMA_V3: &str = r#"
CREATE TABLE playback_state (
    file_id       INTEGER PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,
    position_secs REAL    NOT NULL,
    duration_secs REAL,
    -- Set when playback reached the end, so a finished item leaves Continue
    -- Watching instead of sitting there at 99%.
    completed     INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
);

-- Track preferences are stored per *title*, not per file, and by language
-- rather than track index. Track numbering differs between releases of the
-- same show, so remembering "index 3" would select the wrong track on the next
-- episode; remembering "Danish" survives that.
CREATE TABLE title_prefs (
    title_id    INTEGER PRIMARY KEY REFERENCES titles(id) ON DELETE CASCADE,
    audio_lang  TEXT,
    sub_lang    TEXT,
    sub_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_playback_updated ON playback_state(updated_at DESC);
"#;

/// Schema version 4: locally cached artwork.
///
/// Keyed by the remote URL rather than by title, so posters, backdrops and
/// episode stills all share one mechanism, and re-matching a title never
/// orphans a downloaded file — the same TMDB URL comes back and hits the cache.
///
/// `local_path` is relative to the app data directory, not absolute: the cache
/// and this database live in the same place, so a relative path survives that
/// directory moving. An **empty** `local_path` is a row whose download failed;
/// it stays so the URL is retried on the next pass rather than being silently
/// abandoned.
const SCHEMA_V4: &str = r#"
CREATE TABLE artwork_cache (
    url        TEXT PRIMARY KEY,
    local_path TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL
);
"#;

/// Schema version 5: cached intro/credits markers read from `.skiptro.json`
/// sidecars next to the video files.
///
/// **Superseded by V8**, which drops this table. Kept here because a fresh
/// install still runs every migration in order, and a V6 database in the wild
/// has to reach V8 by the same route.
///
/// Cached so playing an episode does not re-read a file over SMB every time.
/// The sidecar's own size and mtime are stored with it, which is what keeps the
/// cache honest: running the detector *after* a file has been played would
/// otherwise leave "no markers" cached forever.
const SCHEMA_V5: &str = r#"
CREATE TABLE skip_markers (
    file_id       INTEGER PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,

    sidecar_path  TEXT    NOT NULL,
    sidecar_size  INTEGER NOT NULL,
    sidecar_mtime INTEGER NOT NULL,

    intro_start   REAL,
    intro_end     REAL,
    credits_start REAL,
    credits_end   REAL,

    checked_at    INTEGER NOT NULL
);
"#;

/// Schema version 6: the provider's trailer video id, stored on the title.
///
/// Kept on the title row rather than fetched when the detail page opens: the
/// key arrives with the rest of the metadata during matching at no extra cost,
/// and browsing should not depend on a provider being reachable.
const SCHEMA_V6: &str = r#"
ALTER TABLE titles ADD COLUMN trailer_key  TEXT;
ALTER TABLE titles ADD COLUMN trailer_site TEXT;
"#;

/// Schema version 7: title logo artwork, and cast.
///
/// Both arrive on the *same* TMDB detail request the match already makes —
/// `append_to_response` grows by two words and costs no extra round trip — so
/// neither is a new provider or a new rate-limit concern.
///
/// `people` is deliberately denormalised and keyed by title. Cast is a property
/// of a title here, not an entity with a life of its own: nothing in this app
/// asks "what else were they in", and a shared `people` table plus a join table
/// would buy that at the cost of orphan cleanup on every re-match. Re-matching
/// replaces a title's rows wholesale, which a `title_id` cascade makes free.
const SCHEMA_V7: &str = r#"
ALTER TABLE titles ADD COLUMN logo_url TEXT;

CREATE TABLE people (
    id          INTEGER PRIMARY KEY,
    title_id    INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    character   TEXT,
    profile_url TEXT,
    -- Billing order as the provider gave it. The list is meaningless reordered:
    -- the first few names are the ones anyone recognises.
    ord         INTEGER NOT NULL,
    UNIQUE(title_id, ord)
);

CREATE INDEX idx_people_title ON people(title_id);
"#;

/// Schema version 8: skip markers stop being *the sidecar's* markers.
///
/// V5 keyed the cache on one sidecar's path, size and mtime, because a sidecar
/// was the only thing that could produce a marker. There are now three sources
/// — Skiptro's own database, a sidecar, and TheIntroDB — so the cache has to
/// record which one won each segment, and it needs two different notions of
/// staleness rather than one:
///
/// * `local_key` fingerprints whatever the **local** sources looked like when
///   this row was written. It changes when Skiptro rescans or a sidecar is
///   rewritten, which is what stops "no markers" being cached forever.
/// * `remote_at` is when the **network** source was last asked. Local sources
///   are free to re-read; a remote one must not be, so it is re-asked on a
///   schedule instead of on every play.
///
/// The old table is dropped rather than migrated. It is a cache with no
/// authority — every row in it can be rebuilt from the sources in one query —
/// and carrying three sidecar columns forward to describe data that no longer
/// comes from a sidecar would be a lie in the schema.
const SCHEMA_V8: &str = r#"
DROP TABLE IF EXISTS skip_markers;

CREATE TABLE skip_markers (
    file_id        INTEGER PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,

    intro_start    REAL,
    intro_end      REAL,
    intro_source   TEXT,

    credits_start  REAL,
    -- NULL means "to the end of the file". Credits run to the end by
    -- definition, and TheIntroDB says so with a null of its own; inventing a
    -- number here would be inventing data.
    credits_end    REAL,
    credits_source TEXT,

    local_key      TEXT    NOT NULL,
    remote_at      INTEGER,

    checked_at     INTEGER NOT NULL
);
"#;

/// Schema version 9: segments this app detected itself.
///
/// Kept in its own table rather than as more columns on `skip_markers`, because
/// the two have different lifetimes. `skip_markers` is a **cache** — every row
/// is rebuildable in one query and it is dropped wholesale when its shape
/// changes. This is the opposite: minutes of ffmpeg and fingerprinting per
/// season, and losing it means doing that again.
///
/// A row whose four segment columns are all NULL is meaningful: "analysed, and
/// there is no intro or credits here". Without it a show that genuinely has no
/// intro would be re-analysed on every run, forever.
///
/// `file_size` and `file_mtime` are copied from `media_files` at analysis time
/// so a replaced file is re-analysed rather than keeping markers measured
/// against bytes that are gone.
const SCHEMA_V9: &str = r#"
CREATE TABLE analysed_segments (
    file_id       INTEGER PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,

    intro_start   REAL,
    intro_end     REAL,
    credits_start REAL,
    credits_end   REAL,

    file_size     INTEGER NOT NULL,
    file_mtime    INTEGER NOT NULL,
    analysed_at   INTEGER NOT NULL
);
"#;

/// Schema version 10: titles taken out of Continue Watching by hand.
///
/// "Remove" used to delete the file's resume point. That did nothing at all
/// for a "Next episode" card — there is no resume row to delete, it is derived
/// from the last *finished* episode — and it turned a part-watched card into a
/// "Next episode" card for the same show. A show you gave up on could never
/// leave Home.
///
/// Recorded per title with a time, and honoured only against activity older
/// than it: watching the show again brings it back, which is the one moment
/// it should come back. The resume point itself is kept.
const SCHEMA_V10: &str = r#"
CREATE TABLE continue_dismissed (
    title_id     INTEGER PRIMARY KEY REFERENCES titles(id) ON DELETE CASCADE,
    dismissed_at INTEGER NOT NULL
);
"#;

/// Schema version 11: the last episode a file covers.
///
/// `Show.S01E01E02.mkv` parses to episodes 1 *and* 2, and only the first was
/// kept: E02 showed as "not in library", could not be marked watched, and
/// "next episode" from E01 went nowhere useful. NULL means the file holds one
/// episode — every existing single-episode row needs no change.
///
/// Backfilled from `parsed_json`, which already holds guessit's raw output, so
/// files parsed before this version gain their range without a re-parse.
const SCHEMA_V11: &str = r#"
ALTER TABLE media_files ADD COLUMN parsed_episode_last INTEGER;

UPDATE media_files
   SET parsed_episode_last =
       (SELECT MAX(CAST(value AS INTEGER)) FROM json_each(media_files.parsed_json, '$.episode'))
 WHERE json_valid(parsed_json)
   AND json_type(parsed_json, '$.episode') = 'array';
"#;

/// Schema version 12: files the automatic matcher must leave alone.
///
/// "Wrong? Unlink" put a wrongly matched file back into the review queue as
/// `parsed` — and the next launch's matcher took every `parsed` file, made the
/// same choice again, and quietly re-linked it. A hand-made decision lasted
/// until the app was restarted. `match_hold = 1` is that decision: the file
/// waits in Needs attention until someone picks the right title, and choosing
/// one clears it.
const SCHEMA_V12: &str = r#"
ALTER TABLE media_files ADD COLUMN match_hold INTEGER NOT NULL DEFAULT 0;
"#;

/// Schema version 13: watch history that belongs to the episode.
///
/// `playback_state` is keyed by file row, and a file row is a path — so a
/// moved, renamed, upgraded or re-added file started with no history, and a
/// removed folder took its history with it. `watch_history` names what was
/// watched by the providers' ids and season/episode, and references no row
/// that the library ever deletes. See `history.rs` for how the two tables are
/// kept in step.
///
/// Filled from the existing `playback_state` of every matched file: one row
/// per episode a file covers (a double-episode file covers two), and where two
/// copies of one episode both have state, the most recently touched wins.
const SCHEMA_V13: &str = r#"
CREATE TABLE watch_history (
    id            INTEGER PRIMARY KEY,
    kind          TEXT    NOT NULL,          -- 'movie' | 'series'
    provider      TEXT    NOT NULL,
    provider_id   TEXT    NOT NULL,
    imdb_id       TEXT,
    tmdb_id       TEXT,
    season        INTEGER,                   -- NULL for a film
    episode       INTEGER,
    -- "Example Show S04E05": for a person reading the table, never parsed.
    label         TEXT,
    position_secs REAL    NOT NULL,
    duration_secs REAL,
    completed     INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_history_provider ON watch_history(provider, provider_id, season, episode);
CREATE INDEX idx_history_imdb ON watch_history(imdb_id, season, episode) WHERE imdb_id IS NOT NULL;
CREATE INDEX idx_history_tmdb ON watch_history(tmdb_id, season, episode) WHERE tmdb_id IS NOT NULL;

WITH RECURSIVE covered(file_id, season, episode, last) AS (
    SELECT m.id, m.parsed_season, m.parsed_episode,
           MAX(COALESCE(m.parsed_episode_last, m.parsed_episode), m.parsed_episode)
      FROM media_files m
      JOIN titles t ON t.id = m.title_id
     WHERE t.kind = 'series'
       AND m.parsed_season IS NOT NULL
       AND m.parsed_episode IS NOT NULL
    UNION ALL
    SELECT file_id, season, episode + 1, last FROM covered WHERE episode < last
),
items AS (
    SELECT t.kind, t.provider, t.provider_id, NULLIF(t.imdb_id, '') AS imdb_id,
           NULLIF(t.tmdb_id, '') AS tmdb_id, c.season, c.episode,
           t.title || printf(' S%02dE%02d', c.season, c.episode) AS label,
           p.position_secs, p.duration_secs, p.completed, p.updated_at
      FROM playback_state p
      JOIN covered c ON c.file_id = p.file_id
      JOIN media_files m ON m.id = p.file_id
      JOIN titles t ON t.id = m.title_id
    UNION ALL
    SELECT t.kind, t.provider, t.provider_id, NULLIF(t.imdb_id, ''), NULLIF(t.tmdb_id, ''),
           NULL, NULL, t.title,
           p.position_secs, p.duration_secs, p.completed, p.updated_at
      FROM playback_state p
      JOIN media_files m ON m.id = p.file_id
      JOIN titles t ON t.id = m.title_id
     WHERE t.kind <> 'series'
),
ranked AS (
    SELECT *, ROW_NUMBER() OVER (
                  PARTITION BY provider, provider_id, season, episode
                  ORDER BY updated_at DESC, completed DESC) AS n
      FROM items
)
INSERT INTO watch_history
    (kind, provider, provider_id, imdb_id, tmdb_id, season, episode, label,
     position_secs, duration_secs, completed, updated_at)
SELECT kind, provider, provider_id, imdb_id, tmdb_id, season, episode, label,
       position_secs, duration_secs, completed, updated_at
  FROM ranked
 WHERE n = 1;
"#;

/// How long a statement waits for the write lock before giving up.
///
/// Load-bearing from the moment there is more than one connection. SQLite
/// allows a single writer at a time, so while the scanner is committing a batch
/// any other write — `save_progress` fires every five seconds during playback —
/// fails *immediately* with `database is locked` unless it is willing to wait.
/// Five seconds is far longer than a batch takes and far shorter than a user
/// would tolerate as a hang.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    // WAL is what lets the UI keep reading while the scanner writes. PRAGMA
    // journal_mode returns a row, so it must be queried rather than executed.
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;")?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(())
}

pub fn open(path: &Path) -> Result<Connection, DbError> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    if let Some(dir) = path.parent() {
        backup_before_upgrade(&conn, &dir.join(BACKUP_DIR))?;
    }
    migrate(&conn)?;
    Ok(conn)
}

/// Where the safety copies go, beside the database.
const BACKUP_DIR: &str = "backups";

/// How many safety copies to keep. Each is a whole library, so this is a
/// balance: enough to step back past a bad upgrade and the one after it,
/// few enough that years of updates do not quietly fill the disk.
const BACKUPS_KEPT: usize = 3;

/// Copy the library aside before an upgrade changes it.
///
/// Only when an upgrade is actually about to run, and only for a library that
/// has something in it — a fresh install at version 0 has nothing to protect.
/// The watch history, resume points and hand-made matches in this file exist
/// nowhere else, and a schema step is the one moment the whole file is
/// rewritten on purpose.
///
/// `VACUUM INTO` rather than copying the file. The database runs in WAL mode,
/// so recent writes live in `library.db-wal`; a plain file copy would miss
/// them and produce a backup that looks complete and is not. `VACUUM INTO`
/// writes a single consistent snapshot, WAL included.
///
/// A failed copy stops the upgrade. Starting on the previous schema is
/// impossible for this build, so the app refuses to start with a sentence that
/// says why — better than an upgrade with no way back.
fn backup_before_upgrade(conn: &Connection, dir: &Path) -> Result<Option<std::path::PathBuf>, DbError> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == 0 || version >= SCHEMA_VERSION {
        return Ok(None);
    }

    std::fs::create_dir_all(dir)
        .map_err(|e| DbError::Backup(format!("{}: {e}", dir.display())))?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let target = dir.join(format!("library-v{version}-{stamp}.db"));

    conn.execute("VACUUM INTO ?1", [target.to_string_lossy()])
        .map_err(|e| DbError::Backup(format!("{}: {e}", target.display())))?;

    prune_backups(dir);
    Ok(Some(target))
}

/// Keep the newest [`BACKUPS_KEPT`] copies. Best effort: a copy that cannot be
/// deleted costs disk space, not correctness, so failures are ignored.
fn prune_backups(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut copies: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("library-v") && n.ends_with(".db"))
        })
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();

    copies.sort_by_key(|copy| std::cmp::Reverse(copy.0));
    for (_, old) in copies.into_iter().skip(BACKUPS_KEPT) {
        let _ = std::fs::remove_file(old);
    }
}

/// A second connection to a database `open` has already migrated.
///
/// The scanner gets one of these so that walking a NAS share does not hold the
/// single lock every other command needs. It deliberately does **not** migrate:
/// the schema has one owner, and a second migrator racing the first is a
/// problem worth not having.
pub fn open_secondary(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

/// Every migration, in order. The index is the version it produces.
const MIGRATIONS: [&str; SCHEMA_VERSION as usize] = [
    SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7, SCHEMA_V8,
    SCHEMA_V9, SCHEMA_V10, SCHEMA_V11, SCHEMA_V12, SCHEMA_V13,
];

/// Bring the database up to [`SCHEMA_VERSION`].
///
/// **Each step and its version bump are one transaction.** They used to be two
/// statements, and the gap between them was a real hazard: a crash or a power
/// cut in between left the schema changed and the version still saying it was
/// not, so the next launch re-ran the step. V1 and V8 happen to be re-runnable;
/// V2, V6 and V7 are bare `ALTER TABLE ADD COLUMN`, which fails with "duplicate
/// column name" — and since this runs in `setup`, that failure took the whole
/// app down before a window existed. A migration that half-applies must undo
/// itself instead.
///
/// `PRAGMA user_version` lives in the database header and is written inside the
/// transaction like anything else, so a rollback takes it with the schema.
fn migrate(conn: &Connection) -> Result<(), DbError> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

    // Refuse a database from a newer build rather than limping on. Without this
    // the mismatch surfaces later as "no such column" from whichever query
    // happens to run first, which says nothing about the actual problem.
    if version > SCHEMA_VERSION {
        return Err(DbError::TooNew {
            found: version,
            supported: SCHEMA_VERSION,
        });
    }

    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let target = index as i64 + 1;
        if version >= target {
            continue;
        }
        // `unchecked_transaction` because the connection is behind a shared
        // reference here; nothing else can be using it during setup.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.execute_batch(&format!("PRAGMA user_version={target};"))?;
        tx.commit()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A database migrated only as far as `version`, the way an older build
    /// would have left it.
    fn at_version(version: i64) -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database");
        configure(&conn).expect("configure");
        for (index, sql) in MIGRATIONS.iter().enumerate().take(version as usize) {
            conn.execute_batch(sql).expect("schema step");
            conn.execute_batch(&format!("PRAGMA user_version={};", index + 1))
                .expect("version bump");
        }
        conn
    }

    fn version_of(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0))
            .expect("user_version")
    }

    #[test]
    fn the_migration_list_matches_the_declared_version() {
        assert_eq!(MIGRATIONS.len() as i64, SCHEMA_VERSION);
    }

    #[test]
    fn a_fresh_database_lands_on_the_current_version() {
        let conn = at_version(0);
        migrate(&conn).expect("fresh migrate");
        assert_eq!(version_of(&conn), SCHEMA_VERSION);
    }

    /// The upgrade path every existing install will actually take. Each older
    /// version is walked all the way forward, which is the case that had no
    /// coverage at all while the schema grew to nine steps.
    #[test]
    fn every_older_version_reaches_the_current_one() {
        for start in 0..=SCHEMA_VERSION {
            let conn = at_version(start);
            migrate(&conn).unwrap_or_else(|e| panic!("migrating from v{start}: {e}"));
            assert_eq!(
                version_of(&conn),
                SCHEMA_VERSION,
                "starting from v{start}"
            );
        }
    }

    /// Whatever the starting point, the schema ends up the same. A fresh
    /// install and a migrated one being byte-identical is the property the
    /// one-batch-per-version arrangement exists to preserve.
    #[test]
    fn a_migrated_database_matches_a_fresh_one() {
        fn shape(conn: &Connection) -> Vec<String> {
            let mut stmt = conn
                .prepare(
                    "SELECT type || ' ' || name || ' ' || COALESCE(sql, '')
                     FROM sqlite_master
                     WHERE name NOT LIKE 'sqlite_%'
                     ORDER BY type, name",
                )
                .expect("prepare");
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .expect("query")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("collect");
            rows
        }

        let fresh = at_version(0);
        migrate(&fresh).expect("fresh");

        for start in 1..SCHEMA_VERSION {
            let stepped = at_version(start);
            migrate(&stepped).expect("stepped");
            assert_eq!(shape(&stepped), shape(&fresh), "migrated from v{start}");
        }
    }

    #[test]
    fn migrating_twice_changes_nothing() {
        let conn = at_version(0);
        migrate(&conn).expect("first");
        migrate(&conn).expect("second");
        assert_eq!(version_of(&conn), SCHEMA_VERSION);
    }

    /// A library written by a newer build is refused with something a user can
    /// act on, rather than failing later on an unknown column.
    #[test]
    fn a_database_from_a_newer_build_is_refused() {
        let conn = at_version(0);
        migrate(&conn).expect("migrate");
        conn.execute_batch(&format!("PRAGMA user_version={};", SCHEMA_VERSION + 1))
            .expect("bump past");

        match migrate(&conn) {
            Err(DbError::TooNew { found, supported }) => {
                assert_eq!(found, SCHEMA_VERSION + 1);
                assert_eq!(supported, SCHEMA_VERSION);
            }
            other => panic!("expected TooNew, got {other:?}"),
        }
    }

    // ---- safety copy before an upgrade ----------------------------------

    /// A library on disk left at `version` by an older build, holding one
    /// resume point, with its connection still open so the rows can sit in the
    /// write-ahead log rather than the main file.
    fn library_on_disk(name: &str, version: i64) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("pn-db-backup-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.db");

        let conn = Connection::open(&path).unwrap();
        configure(&conn).unwrap();
        // Keep everything in the WAL: the case a plain file copy gets wrong.
        conn.execute_batch("PRAGMA wal_autocheckpoint=0;").unwrap();
        for (index, sql) in MIGRATIONS.iter().enumerate().take(version as usize) {
            conn.execute_batch(sql).unwrap();
            conn.execute_batch(&format!("PRAGMA user_version={};", index + 1)).unwrap();
        }
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:\\m', 'tv', 0);
             INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                 size_bytes, modified_at, first_seen_at, last_seen_at)
                 VALUES (1, 1, 'C:\\m\\a.mkv', 'C:\\m', 'a.mkv', 'mkv', 1, 1, 1, 1);
             INSERT INTO playback_state (file_id, position_secs, completed, updated_at)
                 VALUES (1, 812.5, 0, 1);",
        )
        .unwrap();
        (dir, conn)
    }

    fn backups_in(dir: &Path) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(dir.join(BACKUP_DIR))
            .map(|entries| entries.flatten().map(|e| e.path()).collect())
            .unwrap_or_default()
    }

    /// The point of the whole feature: an upgrade leaves a copy of what was
    /// there before it, and that copy really contains the watch history —
    /// including rows that had not yet left the write-ahead log.
    #[test]
    fn an_upgrade_leaves_a_complete_copy_behind() {
        let (dir, writer) = library_on_disk("upgrade", 8);
        let upgraded = open(&dir.join("library.db")).expect("upgrade");
        assert_eq!(version_of(&upgraded), SCHEMA_VERSION);
        drop(writer);

        let copies = backups_in(&dir);
        assert_eq!(copies.len(), 1, "one safety copy");
        let copy = Connection::open(&copies[0]).unwrap();
        assert_eq!(version_of(&copy), 8, "the copy is the library *before* the upgrade");
        let position: f64 = copy
            .query_row("SELECT position_secs FROM playback_state WHERE file_id = 1", [], |r| {
                r.get(0)
            })
            .expect("the resume point survives in the copy");
        assert_eq!(position, 812.5);
    }

    /// An ordinary launch changes nothing and copies nothing.
    #[test]
    fn a_current_library_is_not_copied() {
        let (dir, writer) = library_on_disk("current", SCHEMA_VERSION);
        drop(writer);
        open(&dir.join("library.db")).expect("open");
        assert!(backups_in(&dir).is_empty());
    }

    /// A first run has nothing to protect.
    #[test]
    fn a_fresh_install_is_not_copied() {
        let dir = std::env::temp_dir().join("pn-db-backup-fresh");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        open(&dir.join("library.db")).expect("fresh");
        assert!(backups_in(&dir).is_empty());
    }

    /// Years of updates must not fill the disk with whole-library copies.
    #[test]
    fn only_the_newest_copies_are_kept() {
        let dir = std::env::temp_dir().join("pn-db-backup-prune");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for n in 0..5 {
            std::fs::write(dir.join(format!("library-v{n}-{n}.db")), b"x").unwrap();
            // Distinct mtimes, so "newest" is well defined.
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        std::fs::write(dir.join("unrelated.txt"), b"keep me").unwrap();

        prune_backups(&dir);

        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec!["library-v2-2.db", "library-v3-3.db", "library-v4-4.db", "unrelated.txt"]
        );
    }

    /// Files parsed before v11 gain their episode range from the guessit output
    /// already stored beside them, so an existing S01E01E02 is fixed without a
    /// re-parse — and a single-episode file is left alone.
    #[test]
    fn the_v11_upgrade_backfills_multi_episode_files() {
        let conn = at_version(10);
        conn.execute_batch(
            r#"INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:/tv', 'tv', 0);
               INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                   size_bytes, modified_at, first_seen_at, last_seen_at, parsed_episode, parsed_json)
               VALUES (1, 1, 'a', 'C:/tv', 'a', 'mkv', 1, 0, 0, 0, 1, '{"season":1,"episode":[1,2]}'),
                      (2, 1, 'b', 'C:/tv', 'b', 'mkv', 1, 0, 0, 0, 3, '{"season":1,"episode":3}'),
                      (3, 1, 'c', 'C:/tv', 'c', 'mkv', 1, 0, 0, 0, NULL, 'not json');"#,
        )
        .unwrap();
        migrate(&conn).unwrap();
        let last = |id: i64| -> Option<i64> {
            conn.query_row("SELECT parsed_episode_last FROM media_files WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(last(1), Some(2));
        assert_eq!(last(2), None);
        assert_eq!(last(3), None, "an unparsable parsed_json must not fail the upgrade");
    }

    /// Existing watch state becomes episode history: one row per episode a
    /// file covers, the most recent copy winning, films included, and nothing
    /// for a file that was never identified.
    #[test]
    fn the_v13_upgrade_fills_the_history_from_existing_watch_state() {
        let conn = at_version(12);
        conn.execute_batch(
            r#"INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'C:/tv', 'tv', 0);
               INSERT INTO titles (id, kind, provider, provider_id, imdb_id, tmdb_id, title, fetched_at)
               VALUES (4, 'series', 'tmdb', '105', 'tt9000001', '105', 'Example Show', 0),
                      (1, 'movie',  'tmdb', '1271', 'tt0416449', '', '300', 0);
               INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                   size_bytes, modified_at, first_seen_at, last_seen_at, title_id,
                   parsed_season, parsed_episode, parsed_episode_last)
               VALUES (1, 1, 'a', 'C:/tv', 'a', 'mkv', 1, 0, 0, 0, 4, 1, 1, 2),     -- S01E01E02
                      (2, 1, 'b', 'C:/tv', 'b', 'mkv', 1, 0, 0, 0, 4, 1, 3, NULL),  -- S01E03, old copy
                      (3, 1, 'c', 'C:/tv', 'c', 'mkv', 1, 0, 0, 0, 4, 1, 3, NULL),  -- S01E03, newer copy
                      (4, 1, 'd', 'C:/tv', 'd', 'mkv', 1, 0, 0, 0, 1, NULL, NULL, NULL), -- the film
                      (5, 1, 'e', 'C:/tv', 'e', 'mkv', 1, 0, 0, 0, NULL, 1, 9, NULL); -- unidentified
               INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at)
               VALUES (1, 2900, 2950, 1, 10), (2, 1700, 1750, 1, 20), (3, 300, 1760, 0, 30),
                      (4, 3000, 7000, 0, 40), (5, 100, 1000, 0, 50);"#,
        )
        .unwrap();
        migrate(&conn).unwrap();

        type Row = (Option<i64>, Option<i64>, f64, i64, String, Option<String>);
        let rows: Vec<Row> = {
            let mut stmt = conn
                .prepare(
                    "SELECT season, episode, position_secs, completed, label, tmdb_id
                       FROM watch_history ORDER BY kind DESC, season, episode",
                )
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
                .unwrap()
                .flatten()
                .collect()
        };
        assert_eq!(
            rows,
            vec![
                (Some(1), Some(1), 2900.0, 1, "Example Show S01E01".into(), Some("105".into())),
                (Some(1), Some(2), 2900.0, 1, "Example Show S01E02".into(), Some("105".into())),
                (Some(1), Some(3), 300.0, 0, "Example Show S01E03".into(), Some("105".into())),
                (None, None, 3000.0, 0, "300".into(), None),
            ]
        );
    }

    /// The reason each step is a transaction: a step that fails part-way must
    /// leave the version where it was, so the next launch retries cleanly
    /// rather than tripping over half its own work.
    #[test]
    fn a_failed_step_rolls_back_and_leaves_the_version_alone() {
        let conn = at_version(0);
        configure(&conn).expect("configure");

        let tx = conn.unchecked_transaction().expect("begin");
        tx.execute_batch("CREATE TABLE half_applied (id INTEGER PRIMARY KEY);")
            .expect("first statement");
        tx.execute_batch("PRAGMA user_version=1;").expect("bump");
        // Whatever goes wrong next, neither the table nor the version survives.
        drop(tx);

        assert_eq!(version_of(&conn), 0);
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'half_applied'",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(exists, 0);
    }
}
