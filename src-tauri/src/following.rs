//! A file that was renamed or moved keeps its row (GitHub #14, review 2026-11
//! finding 4).
//!
//! Every record about a file hangs on its row, and the scanner finds a row by
//! its exact path. A renamed file used to come back as a new row, with nothing:
//! a match or season picked by hand, an "ignored", a title kept under its own
//! name, and the resume point of a file no provider knows all stayed on the old
//! row, now missing, which nothing looks at again.
//!
//! So after every library folder has been walked (a file can cross from one to
//! another, and a folder marks its missing only at its own end), each file new
//! in this scan is compared with the rows that are missing: the **same size and
//! time** is the same file, and failing that the **same size and name** (a copy
//! to another drive gets a new time). Only exactly one against exactly one: two
//! candidates either way and nothing is assumed, and the file is new, as before.
//! A wrong pairing would hand one film's history to another, which is worse
//! than losing it.
//!
//! The old row takes the new path and the new row goes. A decision made by
//! hand stays; anything the machine decided is read again from the new name,
//! so renaming a badly named file to fix a wrong match still works. A folder
//! that could not be reached is never marked missing (`scanner::scan_root`),
//! so nothing on it can be paired.
//!
//! Nothing here touches the disk: the scan already has the sizes and times.

use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

/// One row, as much as pairing needs.
#[derive(Debug, Clone)]
struct Row {
    id: i64,
    root_id: i64,
    videos: bool,
    path: String,
    parent_dir: String,
    file_name: String,
    extension: String,
    size: i64,
    modified: i64,
}

const ROW: &str = "SELECT m.id, m.root_id, r.kind = 'videos', m.path, m.parent_dir, m.file_name,
                          m.extension, m.size_bytes, m.modified_at
                     FROM media_files m JOIN library_roots r ON r.id = m.root_id";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        root_id: r.get(1)?,
        videos: r.get(2)?,
        path: r.get(3)?,
        parent_dir: r.get(4)?,
        file_name: r.get(5)?,
        extension: r.get(6)?,
        size: r.get(7)?,
        modified: r.get(8)?,
    })
}

/// What one pass compares on, besides the size and whether it is a Videos
/// folder's (a Videos folder's files are never parsed, so one never becomes
/// the other).
/// What two rows are compared on in one pass.
type Key = (bool, i64, String);

fn pairs(new: &[Row], gone: &[Row]) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut new_used: HashSet<usize> = HashSet::new();
    let mut gone_used: HashSet<usize> = HashSet::new();
    let by_time = |r: &Row| (r.modified != 0).then(|| (r.videos, r.size, r.modified.to_string()));
    let by_name = |r: &Row| Some((r.videos, r.size, r.file_name.clone()));
    for key in [&by_time as &dyn Fn(&Row) -> Option<Key>, &by_name] {
        let mut groups: HashMap<Key, (Vec<usize>, Vec<usize>)> = HashMap::new();
        for (i, r) in new.iter().enumerate().filter(|(i, _)| !new_used.contains(i)) {
            if let Some(k) = key(r) {
                groups.entry(k).or_default().0.push(i);
            }
        }
        for (i, r) in gone.iter().enumerate().filter(|(i, _)| !gone_used.contains(i)) {
            if let Some(k) = key(r) {
                if let Some(group) = groups.get_mut(&k) {
                    group.1.push(i);
                }
            }
        }
        for (n, g) in groups.into_values() {
            if let ([n], [g]) = (n.as_slice(), g.as_slice()) {
                new_used.insert(*n);
                gone_used.insert(*g);
                found.push((*g, *n));
            }
        }
    }
    found.sort();
    found
}

/// Whether a row holds a decision a person made: a match, a hold, an
/// "ignored", a season or number placed by hand, a title kept under its own
/// name. Those survive a rename as they are.
pub(crate) const HAND_DECISION: &str = "(m.match_hold = 1 OR m.match_status = 'ignored'
     OR m.placed_from IS NOT NULL OR m.match_reason LIKE 'manual:%'
     OR EXISTS (SELECT 1 FROM titles t WHERE t.id = m.title_id AND t.provider = 'local'))";

/// Pair the files `added` in this scan with missing rows, and move each pair
/// onto the old row. Returns the old rows' ids.
pub fn follow(conn: &mut Connection, added: &[i64]) -> rusqlite::Result<Vec<i64>> {
    // A first scan adds everything and has nothing missing: ask nothing more.
    let any_missing: bool =
        conn.query_row("SELECT EXISTS (SELECT 1 FROM media_files WHERE missing = 1)", [], |r| r.get(0))?;
    if added.is_empty() || !any_missing {
        return Ok(Vec::new());
    }
    let new: Vec<Row> = {
        let mut stmt = conn.prepare_cached(&format!("{ROW} WHERE m.id = ?1 AND m.size_bytes > 0"))?;
        let mut rows = Vec::new();
        for id in added {
            if let Ok(r) = stmt.query_row([id], row) {
                rows.push(r);
            }
        }
        rows
    };
    let sizes: HashSet<i64> = new.iter().map(|r| r.size).collect();
    let gone: Vec<Row> = {
        let mut stmt =
            conn.prepare_cached(&format!("{ROW} WHERE m.missing = 1 AND m.size_bytes = ?1 ORDER BY m.id"))?;
        let mut rows = Vec::new();
        for size in &sizes {
            for r in stmt.query_map([size], row)? {
                rows.push(r?);
            }
        }
        rows
    };
    if gone.is_empty() {
        return Ok(Vec::new());
    }
    let found = pairs(&new, &gone);
    if found.is_empty() {
        return Ok(Vec::new());
    }

    let now = crate::util::now_secs();
    let tx = conn.transaction()?;
    let mut followed = Vec::with_capacity(found.len());
    {
        let mut drop_new = tx.prepare("DELETE FROM media_files WHERE id = ?1")?;
        let mut take = tx.prepare(
            "UPDATE media_files
                SET root_id = ?2, path = ?3, parent_dir = ?4, file_name = ?5, extension = ?6,
                    size_bytes = ?7, modified_at = ?8, last_seen_at = ?9, missing = 0
              WHERE id = ?1",
        )?;
        // What the machine decided is read again from the new name.
        let mut read_again = tx.prepare(&format!(
            "UPDATE media_files AS m
                SET match_status = 'unparsed', parsed_at = NULL, parsed_title = NULL,
                    parsed_year = NULL, parsed_season = NULL, parsed_episode = NULL,
                    parsed_kind = NULL, parsed_from = NULL, parsed_json = NULL,
                    parsed_episode_last = NULL, title_id = NULL, match_confidence = NULL,
                    match_reason = NULL
              WHERE m.id = ?1 AND m.match_status <> 'video' AND NOT {HAND_DECISION}"
        ))?;
        for (g, n) in found {
            let (old, new) = (&gone[g], &new[n]);
            drop_new.execute([new.id])?;
            take.execute(params![
                old.id,
                new.root_id,
                new.path,
                new.parent_dir,
                new.file_name,
                new.extension,
                new.size,
                new.modified,
                now
            ])?;
            read_again.execute([old.id])?;
            carry_paths(&tx, old.id, &old.path, &new.path, &old.parent_dir, &new.parent_dir)?;
            crate::log!("scan: followed a file renamed or moved, row {}", old.id);
            followed.push(old.id);
        }
    }
    tx.commit()?;
    Ok(followed)
}

/// The other places a file's path or folder is kept, moved with it: a chosen
/// version, a playlist entry, a Videos folder's track choices and its put-away
/// Continue Watching card (those by folder, and only once nothing is left in
/// the old folder).
fn carry_paths(
    conn: &Connection,
    id: i64,
    old_path: &str,
    new_path: &str,
    old_dir: &str,
    new_dir: &str,
) -> rusqlite::Result<()> {
    carry_file(conn, id, old_path, new_path)?;
    carry_dir(conn, old_dir, new_dir)
}

fn carry_file(conn: &Connection, id: i64, old_path: &str, new_path: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE version_choice SET path = ?2 WHERE path = ?1", params![old_path, new_path])?;
    conn.execute(
        "UPDATE playlist_items SET path = ?3, file_id = ?1 WHERE file_id = ?1 OR path = ?2",
        params![id, old_path, new_path],
    )?;
    Ok(())
}

fn carry_dir(conn: &Connection, old_dir: &str, new_dir: &str) -> rusqlite::Result<()> {
    if old_dir == new_dir {
        return Ok(());
    }
    for table in ["video_prefs", "video_dismissed"] {
        conn.execute(
            &format!(
                "UPDATE OR IGNORE {table} SET dir = ?2 WHERE dir = ?1
                   AND NOT EXISTS (SELECT 1 FROM media_files
                                    WHERE parent_dir = ?1 AND missing = 0)"
            ),
            params![old_dir, new_dir],
        )?;
    }
    Ok(())
}

// ---- "It moved": a library folder under another letter or mount (finding 5) ----
//
// A drive that comes back under another letter, or a disk mounted under a new
// name, left the old folder unreachable — never marked missing, so its rows
// stayed live and the page could offer the dead copy — and adding the new
// place made every file a second, empty row. Now the folder itself is told
// where it went, and every row under it takes the new path: the same rows,
// nothing lost, no dead copies.

/// Where `path`, under the library folder `old_root`, is under `new_root`. By
/// the path below the folder, so a share (`/`) and a Windows folder (`\`) can
/// stand for each other. `None` for a path not under `old_root`.
pub(crate) fn relocated(old_root: &str, new_root: &str, path: &str) -> Option<String> {
    let rest = path.strip_prefix(old_root)?;
    let boundary = old_root.ends_with(['/', '\\'])
        || rest.is_empty()
        || rest.starts_with('/')
        || (!old_root.starts_with('/') && rest.starts_with('\\'));
    if !boundary {
        return None;
    }
    // A Linux name may hold a backslash; only a Windows path splits on one.
    let parts: Vec<&str> = if old_root.starts_with('/') || crate::netshare::is_share_path(old_root) {
        rest.split('/').filter(|p| !p.is_empty()).collect()
    } else {
        rest.split(['/', '\\']).filter(|p| !p.is_empty()).collect()
    };
    if parts.is_empty() {
        return Some(new_root.to_string());
    }
    if crate::netshare::is_share_path(new_root) {
        return Some(format!("{}/{}", new_root.trim_end_matches('/'), parts.join("/")));
    }
    let mut joined = std::path::PathBuf::from(new_root);
    joined.extend(parts);
    Some(joined.to_string_lossy().into_owned())
}

/// Every file of a library folder, where it would be under `new_root`: what
/// "58 of 60 files found there" counts.
pub fn moved_paths(conn: &Connection, root_id: i64, new_root: &str) -> rusqlite::Result<Vec<String>> {
    let old_root: String =
        conn.query_row("SELECT path FROM library_roots WHERE id = ?1", [root_id], |r| r.get(0))?;
    let mut stmt = conn.prepare("SELECT path FROM media_files WHERE root_id = ?1")?;
    let paths = stmt.query_map([root_id], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for path in paths {
        if let Some(p) = relocated(&old_root, new_root, &path?) {
            out.push(p);
        }
    }
    Ok(out)
}

/// What moving a library folder did.
#[derive(Debug, serde::Serialize, PartialEq)]
pub struct Moved {
    /// Rows that took the new path.
    pub files: usize,
    /// Rows already at the new place (the folder was added there as well):
    /// the older row wins and these go.
    pub replaced: usize,
}

/// The library folder `root_id` is now at `new_root`. One transaction, as
/// `merge_roots`. A library folder already added at `new_root` (the person
/// added the new place before finding this) is taken in: where both have a
/// row for a file the older one stays. A place inside or around another
/// library folder is refused, as adding it would be.
pub fn move_root(conn: &mut Connection, root_id: i64, new_root: &str) -> Result<Moved, String> {
    use crate::util::to_string_err;
    let (old_root, kind): (String, String) = conn
        .query_row("SELECT path, kind FROM library_roots WHERE id = ?1", [root_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(to_string_err)?;
    let others: Vec<(i64, String, String)> = {
        let mut stmt =
            conn.prepare("SELECT id, path, kind FROM library_roots WHERE id <> ?1").map_err(to_string_err)?;
        let rows = stmt.query_map([root_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(to_string_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(to_string_err)?
    };
    let wanted = crate::library::comparable(new_root);
    let mut absorb: Option<(i64, String)> = None;
    for (id, path, other_kind) in others {
        let known = crate::library::comparable(&path);
        if known == wanted {
            if other_kind != kind {
                return Err(format!("That folder is already a library folder of another kind:\n{path}"));
            }
            absorb = Some((id, path));
        } else if crate::library::is_within(&wanted, &known) || crate::library::is_within(&known, &wanted) {
            return Err(format!(
                "That folder overlaps a library folder you have already added:\n{path}"
            ));
        }
    }
    // Spelled as the folder already added is, so its rows' paths compare.
    let target = absorb.as_ref().map_or(new_root.to_string(), |(_, p)| p.clone());

    let tx = conn.transaction().map_err(to_string_err)?;
    let mut moved = Moved { files: 0, replaced: 0 };
    {
        let rows: Vec<(i64, String, String)> = {
            let mut stmt = tx
                .prepare("SELECT id, path, parent_dir FROM media_files WHERE root_id = ?1 ORDER BY id")
                .map_err(to_string_err)?;
            let rows = stmt.query_map([root_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(to_string_err)?;
            rows.collect::<rusqlite::Result<_>>().map_err(to_string_err)?
        };
        let mut dirs: Vec<(String, String)> = Vec::new();
        for (id, path, dir) in rows {
            let Some(new_path) = relocated(&old_root, &target, &path) else { continue };
            let new_dir = relocated(&old_root, &target, &dir).unwrap_or_else(|| target.clone());
            moved.replaced += tx
                .execute("DELETE FROM media_files WHERE path = ?1 AND id <> ?2", params![new_path, id])
                .map_err(to_string_err)?;
            tx.execute(
                "UPDATE media_files SET path = ?2, parent_dir = ?3 WHERE id = ?1",
                params![id, new_path, new_dir],
            )
            .map_err(to_string_err)?;
            carry_file(&tx, id, &path, &new_path).map_err(to_string_err)?;
            if !dirs.iter().any(|(d, _)| *d == dir) {
                dirs.push((dir, new_dir));
            }
            moved.files += 1;
        }
        for (old_dir, new_dir) in dirs {
            carry_dir(&tx, &old_dir, &new_dir).map_err(to_string_err)?;
        }
        if let Some((other, _)) = &absorb {
            tx.execute("UPDATE media_files SET root_id = ?1 WHERE root_id = ?2", params![root_id, other])
                .map_err(to_string_err)?;
            tx.execute("DELETE FROM library_roots WHERE id = ?1", [other]).map_err(to_string_err)?;
        }
        tx.execute("UPDATE library_roots SET path = ?2 WHERE id = ?1", params![root_id, target])
            .map_err(to_string_err)?;
    }
    tx.commit().map_err(to_string_err)?;
    crate::log!("library: folder moved, {} files, {} copies replaced", moved.files, moved.replaced);
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(id: i64, name: &str, size: i64, modified: i64) -> Row {
        Row {
            id,
            root_id: 1,
            videos: false,
            path: format!("/m/{name}"),
            parent_dir: "/m".into(),
            file_name: name.into(),
            extension: "mkv".into(),
            size,
            modified,
        }
    }

    #[test]
    fn one_against_one_by_time_then_by_name() {
        // Renamed: same size and time. Copied: same name and size, new time.
        let new = [r(10, "b.mkv", 100, 5), r(11, "c.mkv", 200, 9)];
        let gone = [r(1, "a.mkv", 100, 5), r(2, "c.mkv", 200, 7)];
        assert_eq!(pairs(&new, &gone), vec![(0, 0), (1, 1)]);
    }

    #[test]
    fn two_candidates_either_way_is_nothing() {
        let new = [r(10, "x.mkv", 100, 5), r(11, "y.mkv", 100, 5)];
        let gone = [r(1, "a.mkv", 100, 5)];
        assert!(pairs(&new, &gone).is_empty());
        let new = [r(10, "x.mkv", 100, 5)];
        let gone = [r(1, "a.mkv", 100, 5), r(2, "b.mkv", 100, 5)];
        assert!(pairs(&new, &gone).is_empty());
    }

    #[test]
    fn a_new_size_or_a_videos_folder_is_never_the_same_file() {
        assert!(pairs(&[r(10, "a.mkv", 101, 5)], &[r(1, "a.mkv", 100, 5)]).is_empty());
        let mut video = r(10, "a.mkv", 100, 5);
        video.videos = true;
        assert!(pairs(&[video], &[r(1, "a.mkv", 100, 5)]).is_empty());
    }

    /// Ambiguous by time, told apart by name.
    #[test]
    fn a_tie_by_time_can_be_settled_by_name() {
        let new = [r(10, "a.mkv", 100, 5), r(11, "b.mkv", 100, 5)];
        let gone = [r(1, "b.mkv", 100, 5), r(2, "a.mkv", 100, 5)];
        assert_eq!(pairs(&new, &gone), vec![(0, 1), (1, 0)]);
    }

    // ---- with a real scan over real folders ----

    use crate::scanner::scan_all;
    use std::path::{Path, PathBuf};

    pub(crate) struct Lib {
        pub conn: Connection,
        pub dir: PathBuf,
    }

    impl Lib {
        /// Two library folders, `Shows` (tv) and `Other` (movies), and the
        /// files given, each as many bytes long as its number, so no two are
        /// the same file.
        pub fn new(name: &str, files: &[(&str, usize)]) -> Lib {
            let dir = std::env::temp_dir().join(format!("kinema-follow-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            for root in ["Shows", "Other"] {
                std::fs::create_dir_all(dir.join(root)).unwrap();
            }
            for (file, size) in files {
                let path = dir.join(file);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, vec![b'x'; *size]).unwrap();
            }
            let mut conn = crate::db::open(&dir.join("library.db")).unwrap();
            conn.execute(
                "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, ?1, 'tv', 0), (2, ?2, 'movies', 0)",
                params![dir.join("Shows").to_string_lossy(), dir.join("Other").to_string_lossy()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at)
                     VALUES (7, 'series', 'tmdb', '46296', 'A Show', 0)",
                [],
            )
            .unwrap();
            scan_all(&mut conn).unwrap();
            Lib { conn, dir }
        }
        /// As the scan writes it: this system's separators.
        pub fn path(&self, file: &str) -> String {
            let mut path = self.dir.clone();
            path.extend(file.split('/'));
            path.to_string_lossy().into_owned()
        }
        pub fn id(&self, file: &str) -> i64 {
            self.conn
                .query_row("SELECT id FROM media_files WHERE path = ?1", [self.path(file)], |r| r.get(0))
                .unwrap()
        }
        pub fn rename(&self, from: &str, to: &str) {
            let to = self.dir.join(to);
            std::fs::create_dir_all(to.parent().unwrap()).unwrap();
            std::fs::rename(self.dir.join(from), to).unwrap();
        }
        pub fn rows(&self) -> i64 {
            self.conn.query_row("SELECT COUNT(*) FROM media_files", [], |r| r.get(0)).unwrap()
        }
        /// Every video's name, time and size, to show nothing was touched.
        pub fn on_disk(&self) -> Vec<(String, std::time::SystemTime, u64)> {
            let mut all: Vec<_> = walkdir::WalkDir::new(&self.dir)
                .into_iter()
                .flatten()
                .filter(|e| e.file_type().is_file())
                .filter(|e| e.path().extension().is_some_and(|x| x == "mkv"))
                .map(|e| {
                    let m = e.metadata().unwrap();
                    (e.path().to_string_lossy().into_owned(), m.modified().unwrap(), m.len())
                })
                .collect();
            all.sort();
            all
        }
    }

    impl Drop for Lib {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    type State = (String, Option<i64>, Option<String>, Option<i64>, bool);

    fn state(lib: &Lib, id: i64) -> State {
        lib.conn
            .query_row(
                "SELECT match_status, title_id, match_reason, parsed_season, missing FROM media_files WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap()
    }

    fn resume(lib: &Lib, id: i64) -> f64 {
        lib.conn
            .query_row("SELECT position_secs FROM playback_state WHERE file_id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    fn played(lib: &Lib, id: i64, at: f64) {
        lib.conn
            .execute(
                "INSERT INTO playback_state (file_id, position_secs, duration_secs, completed, updated_at)
                 VALUES (?1, ?2, 3000.0, 0, 0)",
                params![id, at],
            )
            .unwrap();
    }

    /// The reporter's case (GitHub #14): files linked and placed on Specials by
    /// hand, then the folder renamed. The same rows, with the link, the
    /// numbers, the placement's undo, the resume point and a chosen version.
    #[test]
    fn a_renamed_folder_keeps_what_was_decided_by_hand() {
        let names = ["Arena.S01E01.mkv", "Arena.S01E02.mkv", "Arena.S01E03.mkv"];
        let files: Vec<(String, usize)> =
            names.iter().enumerate().map(|(i, n)| (format!("Shows/Arena/{n}"), 10 + i)).collect();
        let files: Vec<(&str, usize)> = files.iter().map(|(f, s)| (f.as_str(), *s)).collect();
        let mut lib = Lib::new("hand", &files);
        let ids: Vec<i64> = files.iter().map(|(f, _)| lib.id(f)).collect();
        crate::lifecycle::matched(&mut lib.conn, &ids, 7, Some(1.0), Some("manual: “A Show” via tmdb")).unwrap();
        for (i, id) in ids.iter().enumerate() {
            lib.conn
                .execute(
                    "UPDATE media_files SET parsed_season = 1, parsed_episode = ?2 WHERE id = ?1",
                    params![id, i as i64 + 1],
                )
                .unwrap();
        }
        let places: Vec<crate::lifecycle::Placement> = ids
            .iter()
            .enumerate()
            .map(|(i, &file_id)| crate::lifecycle::Placement {
                file_id,
                season: Some(0),
                episode: Some(i as i64 + 1),
                episode_last: None,
            })
            .collect();
        crate::lifecycle::placed(&mut lib.conn, &places, Some("manual: placed")).unwrap();
        played(&lib, ids[0], 600.0);
        lib.conn
            .execute(
                "INSERT INTO version_choice (kind, provider, provider_id, path, key, updated_at)
                 VALUES ('series', 'tmdb', '46296', ?1, 'k', 1)",
                [lib.path(files[0].0)],
            )
            .unwrap();

        lib.rename("Shows/Arena", "Shows/Gods of the Arena");
        let before = lib.on_disk();
        let report = scan_all(&mut lib.conn).unwrap();
        assert_eq!(lib.on_disk(), before, "the scan touched nothing on disk");

        assert_eq!((report.files_followed, report.files_added, report.files_missing), (3, 0, 0));
        assert!(report.errors.is_empty(), "nothing said gone: {:?}", report.errors);
        assert_eq!(lib.rows(), 3);
        for (i, name) in names.iter().enumerate() {
            let now = format!("Shows/Gods of the Arena/{name}");
            assert_eq!(lib.id(&now), ids[i], "{name} kept its row");
            let (status, title, reason, season, missing) = state(&lib, ids[i]);
            assert_eq!((status.as_str(), title, season, missing), ("matched", Some(7), Some(0), false));
            assert!(reason.unwrap().starts_with("manual:"));
        }
        let (episode, undo): (i64, String) = lib
            .conn
            .query_row("SELECT parsed_episode, placed_from FROM media_files WHERE id = ?1", [ids[2]], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(episode, 3);
        assert!(undo.contains("\"season\":1"), "the undo still goes back to the name: {undo}");
        assert_eq!(resume(&lib, ids[0]), 600.0);
        let version: String = lib.conn.query_row("SELECT path FROM version_choice", [], |r| r.get(0)).unwrap();
        assert_eq!(version, lib.path("Shows/Gods of the Arena/Arena.S01E01.mkv"));

        // And the next scan finds nothing new.
        let again = scan_all(&mut lib.conn).unwrap();
        assert_eq!((again.files_followed, again.files_added, again.files_missing), (0, 0, 0));
    }

    /// Ignored, held (unlinked by hand) and kept under its own name: each
    /// stays. One is only a change of capitals, as Windows lets one do.
    #[test]
    fn ignored_held_and_own_title_survive_a_rename() {
        let mut lib =
            Lib::new("kinds", &[("Other/Extra Bit.mkv", 11), ("Other/Wrong.mkv", 12), ("Other/Home Film.mkv", 13)]);
        let (ignored, held, own) =
            (lib.id("Other/Extra Bit.mkv"), lib.id("Other/Wrong.mkv"), lib.id("Other/Home Film.mkv"));
        crate::lifecycle::ignored(&mut lib.conn, &[ignored]).unwrap();
        crate::lifecycle::unlinked(&mut lib.conn, &[held], "unlinked by hand").unwrap();
        lib.conn
            .execute(
                "INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at)
                     VALUES (8, 'movie', 'local', 'l1', 'Home Film', 0)",
                [],
            )
            .unwrap();
        crate::lifecycle::matched(&mut lib.conn, &[own], 8, None, Some("kept under its own name")).unwrap();

        // Through a name of its own first: a change of capitals alone is the
        // same file on Windows and macOS.
        lib.rename("Other/Extra Bit.mkv", "Other/extra-x.mkv");
        lib.rename("Other/extra-x.mkv", "Other/EXTRA BIT.mkv");
        lib.rename("Other/Wrong.mkv", "Other/Wrong (1999).mkv");
        lib.rename("Other/Home Film.mkv", "Other/Sub/Home Film 2001.mkv");
        let report = scan_all(&mut lib.conn).unwrap();
        assert_eq!(report.files_followed, 3);
        assert_eq!(lib.id("Other/EXTRA BIT.mkv"), ignored);
        assert_eq!(state(&lib, ignored).0, "ignored");
        assert_eq!(state(&lib, held).0, "unmatched");
        let hold: bool =
            lib.conn.query_row("SELECT match_hold FROM media_files WHERE id = ?1", [held], |r| r.get(0)).unwrap();
        assert!(hold);
        assert_eq!(state(&lib, own).1, Some(8));
        assert_eq!(lib.id("Other/Sub/Home Film 2001.mkv"), own);
    }

    /// A file the machine matched is read again from its new name, so renaming
    /// it to fix a wrong match works; its resume point stays (by row).
    #[test]
    fn a_machine_match_is_read_again_and_keeps_its_resume_point() {
        let mut lib = Lib::new("machine", &[("Other/Wrong Name.mkv", 21)]);
        let id = lib.id("Other/Wrong Name.mkv");
        crate::lifecycle::matched(&mut lib.conn, &[id], 7, Some(0.9), Some("score 0.90")).unwrap();
        played(&lib, id, 42.0);
        lib.rename("Other/Wrong Name.mkv", "Other/Right Name (2001).mkv");
        let report = scan_all(&mut lib.conn).unwrap();
        assert_eq!(report.files_followed, 1);
        let (status, title, reason, _, _) = state(&lib, id);
        assert_eq!((status.as_str(), title, reason), ("unparsed", None, None));
        assert_eq!(resume(&lib, id), 42.0);
    }

    /// A copy to another library folder gets a new time: the same name and
    /// size are enough, one against one. Two such files are not.
    #[test]
    fn a_copy_to_another_folder_by_name_and_size_but_never_a_guess() {
        // C stays, so Shows is not a folder left empty (which hides nothing).
        let mut lib = Lib::new("copy", &[("Shows/A.S01E01.mkv", 31), ("Shows/B.mkv", 32), ("Shows/C.mkv", 33)]);
        let a = lib.id("Shows/A.S01E01.mkv");
        let b = lib.id("Shows/B.mkv");
        crate::lifecycle::ignored(&mut lib.conn, &[a, b]).unwrap();

        // A: moved to the other library folder, with a new time.
        lib.rename("Shows/A.S01E01.mkv", "Other/A.S01E01.mkv");
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(lib.dir.join("Other/A.S01E01.mkv"))
            .unwrap()
            .set_modified(later)
            .unwrap();
        // B: two files of its size and name appear. Which is it? Neither is assumed.
        lib.rename("Shows/B.mkv", "Other/B.mkv");
        std::fs::create_dir_all(lib.dir.join("Other/Again")).unwrap();
        std::fs::copy(lib.dir.join("Other/B.mkv"), lib.dir.join("Other/Again/B.mkv")).unwrap();

        let report = scan_all(&mut lib.conn).unwrap();
        assert_eq!(report.files_followed, 1);
        assert_eq!(lib.id("Other/A.S01E01.mkv"), a);
        let root: i64 =
            lib.conn.query_row("SELECT root_id FROM media_files WHERE id = ?1", [a], |r| r.get(0)).unwrap();
        assert_eq!(root, 2, "the row moved to the folder the file is in now");
        assert_ne!(lib.id("Other/B.mkv"), b);
        assert_ne!(lib.id("Other/Again/B.mkv"), b);
        assert!(state(&lib, b).4, "B's old row stays missing, with its decision");
        assert_eq!(report.files_added, 2);
    }

    /// A folder renamed while another goes: only the one really gone is said.
    #[test]
    fn only_what_is_really_gone_is_said() {
        let mut lib = Lib::new(
            "said",
            &[
                ("Other/Old/One.mkv", 41),
                ("Other/Old/Two.mkv", 42),
                ("Other/Old/Three.mkv", 43),
                ("Other/Gone/Four.mkv", 44),
                ("Other/Gone/Five.mkv", 45),
                ("Other/Gone/Six.mkv", 46),
            ],
        );
        lib.rename("Other/Old", "Other/New");
        std::fs::remove_dir_all(lib.dir.join("Other/Gone")).unwrap();
        let report = scan_all(&mut lib.conn).unwrap();
        assert_eq!((report.files_followed, report.files_missing, report.files_added), (3, 3, 0));
        let gone = Path::new(&lib.path("Other/Gone")).display().to_string();
        assert_eq!(report.errors, vec![format!("videos gone: 3 :: {gone}")]);
    }

    // ---- It moved ----

    #[test]
    fn a_path_below_one_folder_is_the_same_below_another() {
        assert_eq!(
            relocated(r"E:\TV", r"F:\Shows", r"E:\TV\Show\Season 1\a.mkv"),
            Some(std::path::PathBuf::from(r"F:\Shows").join("Show").join("Season 1").join("a.mkv").to_string_lossy().into_owned())
        );
        assert_eq!(relocated(r"E:\TV", r"F:\Shows", r"E:\TV"), Some(r"F:\Shows".into()));
        assert_eq!(relocated(r"E:\TV", "F:", r"E:\TV2\a.mkv"), None, "TV2 is not under TV");
        assert_eq!(relocated("/media/old", "/media/new", "/media/old/A/b.mkv").map(|p| p.replace('\\', "/")), Some("/media/new/A/b.mkv".into()));
        assert_eq!(
            relocated(r"E:\TV", "smb://nas/tv/", r"E:\TV\Show\a.mkv"),
            Some("smb://nas/tv/Show/a.mkv".into())
        );
        assert_eq!(relocated("smb://nas/tv", "smb://nas2/tv", "smb://nas/tv/a.mkv"), Some("smb://nas2/tv/a.mkv".into()));
        // A Linux name may hold a backslash.
        if cfg!(unix) {
            assert_eq!(relocated("/m/a", "/m/b", r"/m/a/x\y.mkv"), Some(r"/m/b/x\y.mkv".into()));
        }
    }

    /// The setup for It moved: a library folder whose drive is now elsewhere
    /// (the folder renamed stands for a new letter), so the scan cannot reach it.
    fn moved_away(name: &str) -> (Lib, Vec<i64>) {
        let mut lib = Lib::new(
            name,
            &[("Shows/Show/S01E01.mkv", 51), ("Shows/Show/S01E02.mkv", 52), ("Shows/Show/S01E03.mkv", 53)],
        );
        let ids: Vec<i64> = ["S01E01", "S01E02", "S01E03"].iter().map(|e| lib.id(&format!("Shows/Show/{e}.mkv"))).collect();
        crate::lifecycle::matched(&mut lib.conn, &ids, 7, Some(1.0), Some("manual: “A Show” via tmdb")).unwrap();
        played(&lib, ids[1], 77.0);
        lib.conn
            .execute(
                "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (1, 'P', 0, 0)",
                [],
            )
            .unwrap();
        lib.conn
            .execute(
                "INSERT INTO playlist_items (playlist_id, position, file_id, path) VALUES (1, 0, ?1, ?2)",
                params![ids[0], lib.path("Shows/Show/S01E01.mkv")],
            )
            .unwrap();
        std::fs::rename(lib.dir.join("Shows"), lib.dir.join("Moved")).unwrap();
        let report = scan_all(&mut lib.conn).unwrap();
        assert!(report.errors.iter().any(|e| e.starts_with("root unavailable")), "{:?}", report.errors);
        (lib, ids)
    }

    fn after_move(lib: &mut Lib, ids: &[i64]) {
        let report = scan_all(&mut lib.conn).unwrap();
        assert_eq!((report.files_added, report.files_missing, report.files_followed), (0, 0, 0));
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(lib.rows(), 3);
        for (i, e) in ["S01E01", "S01E02", "S01E03"].iter().enumerate() {
            assert_eq!(lib.id(&format!("Moved/Show/{e}.mkv")), ids[i]);
            assert_eq!(state(lib, ids[i]).1, Some(7));
        }
        assert_eq!(resume(lib, ids[1]), 77.0);
        let item: String = lib.conn.query_row("SELECT path FROM playlist_items", [], |r| r.get(0)).unwrap();
        assert_eq!(item, lib.path("Moved/Show/S01E01.mkv"));
        let roots: Vec<String> = {
            let mut stmt = lib.conn.prepare("SELECT path FROM library_roots ORDER BY id").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(roots, vec![lib.path("Moved"), lib.path("Other")]);
    }

    #[test]
    fn it_moved_takes_every_row_to_the_new_place() {
        let (mut lib, ids) = moved_away("moved");
        let new_root = lib.path("Moved");
        let paths = moved_paths(&lib.conn, 1, &new_root).unwrap();
        let found = paths.iter().filter(|p| Path::new(p).exists()).count();
        assert_eq!((found, paths.len()), (3, 3), "3 of 3 files found there");

        let moved = move_root(&mut lib.conn, 1, &new_root).unwrap();
        assert_eq!(moved, Moved { files: 3, replaced: 0 });
        after_move(&mut lib, &ids);
    }

    /// The trap the review found: the new place added as a folder of its own
    /// and scanned, so each episode had two rows and the page offered the dead
    /// one. Moving the old folder there keeps the old rows and drops the copies.
    #[test]
    fn it_moved_onto_a_folder_added_since_keeps_the_older_rows() {
        let (mut lib, ids) = moved_away("trap");
        lib.conn
            .execute("INSERT INTO library_roots (id, path, kind, added_at) VALUES (3, ?1, 'tv', 0)", [lib.path("Moved")])
            .unwrap();
        let report = scan_all(&mut lib.conn).unwrap();
        assert_eq!(report.files_added, 3, "today's behaviour: three new rows");
        assert_eq!(lib.rows(), 6);

        let there = lib.path("Moved");
        let moved = move_root(&mut lib.conn, 1, &there).unwrap();
        assert_eq!(moved, Moved { files: 3, replaced: 3 });
        after_move(&mut lib, &ids);
    }

    #[test]
    fn it_moved_never_overlaps_another_folder_or_kind() {
        let (mut lib, _) = moved_away("overlap");
        let inside = lib.path("Other");
        let err = move_root(&mut lib.conn, 1, &format!("{inside}{}Sub", std::path::MAIN_SEPARATOR)).unwrap_err();
        assert!(err.contains("overlaps"), "{err}");
        let err = move_root(&mut lib.conn, 1, &inside).unwrap_err();
        assert!(err.contains("another kind"), "{err}");
        assert_eq!(lib.rows(), 3, "nothing changed");
    }
}
