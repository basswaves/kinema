//! Reading the library's files wherever they are: on a drive or share the
//! system opened (a plain path), or on a network share Kinema opens itself
//! (`smb://…`, netshare.rs).
//!
//! Only what the library needs beside a film — is it there, how big, when
//! written, what is in this folder, the bytes of a small file — so the readers
//! of `.nfo`, trailer, skip and subtitle files work the same on both without
//! knowing which they are on. Nothing here writes: a share Kinema opens
//! itself is read-only to it, as the library promises of every folder.

use crate::netshare;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// The largest file read whole. Sidecars are kilobytes; this stops a
/// misnamed video from being pulled across the network into memory.
const MAX_READ: u64 = 16 << 20;

pub struct Meta {
    pub is_dir: bool,
    pub len: u64,
    pub modified: SystemTime,
}

impl Meta {
    /// Seconds since 1970, as the database keeps a file's time.
    pub fn modified_secs(&self) -> i64 {
        self.modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }
}

fn share(path: &Path) -> Option<&str> {
    path.to_str().filter(|p| netshare::is_share_path(p))
}

/// Size, time and kind; links followed, as `std::fs::metadata` does.
pub fn metadata(path: &Path) -> io::Result<Meta> {
    if let Some(p) = share(path) {
        let e = netshare::stat(p)?;
        return Ok(Meta { is_dir: e.is_dir, len: e.size, modified: e.modified });
    }
    let m = std::fs::metadata(path)?;
    Ok(Meta { is_dir: m.is_dir(), len: m.len(), modified: m.modified().unwrap_or(SystemTime::UNIX_EPOCH) })
}

pub fn is_file(path: &Path) -> bool {
    metadata(path).is_ok_and(|m| !m.is_dir)
}

pub fn is_dir(path: &Path) -> bool {
    metadata(path).is_ok_and(|m| m.is_dir)
}

/// A small file whole.
pub fn read(path: &Path) -> io::Result<Vec<u8>> {
    match share(path) {
        Some(p) => netshare::read(p, MAX_READ),
        None => std::fs::read(path),
    }
}

pub fn read_to_string(path: &Path) -> io::Result<String> {
    String::from_utf8(read(path)?).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// `len` bytes from `pos`, fewer only at the end of the file.
pub fn read_at(path: &Path, pos: u64, len: usize) -> io::Result<Vec<u8>> {
    let mut buf = vec![0; len];
    let n = match share(path) {
        Some(p) => netshare::open(p)?.read_at(&mut buf, pos)?,
        None => {
            use std::io::{Read, Seek, SeekFrom};
            let mut f = std::fs::File::open(path)?;
            f.seek(SeekFrom::Start(pos))?;
            let mut n = 0;
            while n < len {
                match f.read(&mut buf[n..])? {
                    0 => break,
                    k => n += k,
                }
            }
            n
        }
    };
    buf.truncate(n);
    Ok(buf)
}

/// What is in a folder: each entry's full path and whether it is a folder
/// (links followed). An entry that cannot be looked at is left out.
pub fn read_dir(path: &Path) -> io::Result<Vec<(PathBuf, bool)>> {
    if let Some(p) = share(path) {
        let base = p.trim_end_matches(['/', '\\']);
        return Ok(netshare::list(p)?
            .into_iter()
            .map(|e| (PathBuf::from(format!("{base}/{}", e.name)), e.is_dir))
            .collect());
    }
    Ok(std::fs::read_dir(path)?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let is_dir = std::fs::metadata(&p).ok()?.is_dir();
            Some((p, is_dir))
        })
        .collect())
}

// ---- a look that may not come back -------------------------------------------

/// What Kinema says when the drive or share a film is on does not answer.
pub const NOT_ANSWERING: &str =
    "The drive this film is on is not answering. Check that it is switched on and connected, then try again.";

/// How long a look at a film's file is waited for before the drive is said
/// not to answer. A NAS waking from sleep answers within it; a share that has
/// gone silent can keep Windows waiting about three minutes.
pub const LOOK_WAIT: std::time::Duration = std::time::Duration::from_secs(20);

/// Paths being looked at right now, on a thread of their own.
static IN_FLIGHT: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

/// Run `look` (a look at `path`: a stat, a folder listing, a small read) on a
/// thread of its own and wait at most `wait` for it. `None` when it did not
/// answer in time, or when an earlier look at the same path is still stuck:
/// a silent share holds every call to it until the system gives up (about
/// three minutes on Windows), so the stuck look is left to finish by itself
/// and a new one is not stacked behind it. Blocks the caller for at most
/// `wait`: a command calls it through `jobs::off_main`.
pub fn within<T: Send + 'static>(
    path: &Path,
    wait: std::time::Duration,
    look: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let key = path.to_path_buf();
    {
        let mut busy = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        if busy.contains(&key) {
            return None;
        }
        busy.push(key.clone());
    }
    let (done, answer) = std::sync::mpsc::channel();
    let started = std::thread::Builder::new().name("kinema-look".into()).spawn(move || {
        let result = look();
        IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).retain(|p| p != &key);
        let _ = done.send(result);
    });
    if started.is_err() {
        IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).retain(|p| p != path);
        return None;
    }
    answer.recv_timeout(wait).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_look_that_does_not_come_back_is_given_up_on_and_not_stacked() {
        use std::time::{Duration, Instant};
        let path = Path::new("kinema-test-silent-share/film.mkv");
        let (release, held) = std::sync::mpsc::channel::<()>();
        let started = Instant::now();
        // A look stuck until released, as on a silent share.
        let first = within(path, Duration::from_millis(100), move || held.recv().is_ok());
        assert_eq!(first, None);
        assert!(started.elapsed() < Duration::from_secs(2));
        // While it is stuck, another look at the same path is not started.
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = ran.clone();
        let second = within(path, Duration::from_secs(5), move || flag.store(true, std::sync::atomic::Ordering::SeqCst));
        assert_eq!(second, None);
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        assert!(started.elapsed() < Duration::from_secs(2));
        // Once it comes back, the path can be looked at again.
        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut again = None;
        while again.is_none() && Instant::now() < deadline {
            again = within(path, Duration::from_secs(1), || 7);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(again, Some(7));
    }

    #[test]
    fn a_look_that_answers_returns_its_answer() {
        let path = Path::new("kinema-test-quick/film.mkv");
        assert_eq!(within(path, std::time::Duration::from_secs(5), || 42), Some(42));
    }

    #[test]
    fn local_files_read_as_before() {
        let dir = std::env::temp_dir().join(format!("kinema-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.nfo"), b"0123456789").unwrap();

        assert!(is_file(&dir.join("a.nfo")) && !is_dir(&dir.join("a.nfo")));
        assert!(is_dir(&dir.join("sub")) && !is_file(&dir.join("sub")));
        assert!(!is_file(&dir.join("missing")));
        assert_eq!(metadata(&dir.join("a.nfo")).unwrap().len, 10);
        assert_eq!(read_to_string(&dir.join("a.nfo")).unwrap(), "0123456789");
        assert_eq!(read_at(&dir.join("a.nfo"), 8, 4).unwrap(), b"89");
        let mut listed = read_dir(&dir).unwrap();
        listed.sort();
        assert_eq!(listed, [(dir.join("a.nfo"), false), (dir.join("sub"), true)]);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
