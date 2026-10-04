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

#[cfg(test)]
mod tests {
    use super::*;

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
