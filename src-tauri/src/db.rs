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
    provider     TEXT    NOT NULL,          -- 'tvmaze' | 'omdb' | 'mdblist'
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

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;

    // WAL keeps reads from blocking the scan writer. PRAGMA journal_mode
    // returns a row, so it must be queried rather than executed.
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;")?;

    migrate(&conn)?;
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

    Ok(())
}
