//! SQLite storage for the media library.
//!
//! The database lives in the app data directory, not next to the media, so
//! network shares stay read-only as far as this app is concerned.

use rusqlite::Connection;
use std::path::Path;

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

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
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

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

    if version < 1 {
        conn.execute_batch(SCHEMA_V1)?;
        conn.execute_batch("PRAGMA user_version=1;")?;
    }

    if version < 2 {
        conn.execute_batch(SCHEMA_V2)?;
        conn.execute_batch("PRAGMA user_version=2;")?;
    }

    if version < 3 {
        conn.execute_batch(SCHEMA_V3)?;
        conn.execute_batch("PRAGMA user_version=3;")?;
    }

    if version < 4 {
        conn.execute_batch(SCHEMA_V4)?;
        conn.execute_batch("PRAGMA user_version=4;")?;
    }

    if version < 5 {
        conn.execute_batch(SCHEMA_V5)?;
        conn.execute_batch("PRAGMA user_version=5;")?;
    }

    if version < 6 {
        conn.execute_batch(SCHEMA_V6)?;
        conn.execute_batch("PRAGMA user_version=6;")?;
    }

    if version < 7 {
        conn.execute_batch(SCHEMA_V7)?;
        conn.execute_batch("PRAGMA user_version=7;")?;
    }

    if version < 8 {
        conn.execute_batch(SCHEMA_V8)?;
        conn.execute_batch("PRAGMA user_version=8;")?;
    }

    Ok(())
}
