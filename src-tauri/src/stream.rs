//! Films on a network share Kinema opens itself, handed to the player.
//!
//! Media3 reads files and web addresses; it cannot speak SMB, and teaching
//! it would mean a second SMB client in Kotlin beside the one in netshare.rs
//! (owner's choice, 2026-10-04: one client, in the core). So the core serves
//! the film to the player over HTTP on this device only — `127.0.0.1`, an
//! address no other machine can reach — at a secret address made for each
//! run, so another app on the device cannot ask for files either. The player
//! asks for the part it needs (`Range`), as it would of any web video, and
//! each request reads that part from the share.
//!
//! Nothing here is used where the system opens the share itself: there the
//! player is given the path, as always.

use crate::netshare;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};

/// What one read from the share asks for, and what is sent on at a time.
const CHUNK: usize = 1 << 20;
/// Reads made ahead of what the player has taken, so the network and the
/// player each work while the other waits.
const AHEAD: usize = 4;

struct Server {
    port: u16,
    secret: String,
    /// The films handed out, by the number in their address.
    films: Mutex<HashMap<u64, String>>,
}

fn random() -> u64 {
    // Seeded from the system's randomness, as every `RandomState` is.
    std::collections::hash_map::RandomState::new().build_hasher().finish()
}

fn server() -> io::Result<&'static Server> {
    static SERVER: OnceLock<Server> = OnceLock::new();
    if let Some(s) = SERVER.get() {
        return Ok(s);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let s = SERVER.get_or_init(|| Server {
        port,
        secret: format!("{:016x}{:016x}", random(), random()),
        films: Mutex::default(),
    });
    if s.port == port {
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    if let Err(e) = answer(conn) {
                        log::debug!("stream: {e}");
                    }
                });
            }
        });
    }
    Ok(s)
}

/// The address the player can read a film on a share from.
#[tauri::command]
pub async fn stream_address(path: String) -> Result<String, String> {
    if !netshare::is_share_path(&path) {
        return Err(format!("not on a network share: {path}"));
    }
    let s = server().map_err(|e| format!("could not start the film's link: {e}"))?;
    let mut films = s.films.lock().unwrap_or_else(|e| e.into_inner());
    let id = match films.iter().find(|(_, p)| **p == path) {
        Some((id, _)) => *id,
        None => {
            let id = films.len() as u64 + 1;
            films.insert(id, path.clone());
            id
        }
    };
    // The file's name at the end, so the player can tell its kind from it.
    let name = path.rsplit(['/', '\\']).next().unwrap_or("film");
    Ok(format!("http://127.0.0.1:{}/{}/{id}/{}", s.port, s.secret, encode(name)))
}

/// A file name as one part of a web address.
fn encode(name: &str) -> String {
    name.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The part of the file asked for: `bytes=START-` or `bytes=START-END`.
fn range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end = match end.trim() {
        "" => len.checked_sub(1)?,
        e => e.parse::<u64>().ok()?.min(len.checked_sub(1)?),
    };
    (start <= end).then_some((start, end))
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("mkv") => "video/x-matroska",
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("ts" | "m2ts" | "mts") => "video/mp2t",
        _ => "application/octet-stream",
    }
}

fn answer(conn: TcpStream) -> io::Result<()> {
    let mut reader = BufReader::new(conn.try_clone()?);
    let mut out = conn;
    let mut request = String::new();
    reader.read_line(&mut request)?;
    let mut range_header = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("range") {
                range_header = Some(value.trim().to_string());
            }
        }
    }
    let mut words = request.split_whitespace();
    let (method, target) = (words.next().unwrap_or(""), words.next().unwrap_or(""));
    let head_only = method == "HEAD";
    let s = server()?;
    let path = {
        let mut parts = target.trim_start_matches('/').split('/');
        let secret_ok = parts.next() == Some(s.secret.as_str());
        let id = parts.next().and_then(|i| i.parse::<u64>().ok());
        let films = s.films.lock().unwrap_or_else(|e| e.into_inner());
        id.filter(|_| secret_ok).and_then(|id| films.get(&id).cloned())
    };
    let Some(path) = path.filter(|_| method == "GET" || head_only) else {
        return out.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };

    let file = match netshare::open(&path) {
        Ok(f) => f,
        Err(e) => {
            crate::log!("stream: could not open {path}: {e}");
            let status = match e.kind() {
                io::ErrorKind::NotFound => "404 Not Found",
                io::ErrorKind::PermissionDenied => "403 Forbidden",
                _ => "502 Bad Gateway",
            };
            return write!(out, "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
    };
    let len = file.len();
    let (start, end, status) = match range_header.as_deref() {
        Some(h) => match range(h, len) {
            Some((a, b)) => (a, b, "206 Partial Content"),
            None => {
                return write!(
                    out,
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
            }
        },
        None if len == 0 => (0, 0, "200 OK"),
        None => (0, len - 1, "200 OK"),
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    write!(
        out,
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\n",
        content_type(&path)
    )?;
    if status.starts_with("206") {
        write!(out, "Content-Range: bytes {start}-{end}/{len}\r\n")?;
    }
    out.write_all(b"Connection: close\r\n\r\n")?;
    if head_only || count == 0 {
        return Ok(());
    }

    // Read ahead on one thread, send on this one. A player that stops
    // listening (a seek, the film closed) ends the sending, and with it
    // the reading: the reader's next hand-over finds no one there.
    let (tx, rx) = mpsc::sync_channel::<io::Result<Vec<u8>>>(AHEAD);
    std::thread::spawn(move || {
        let mut file = file;
        let mut pos = start;
        while pos <= end {
            let want = CHUNK.min((end - pos + 1) as usize);
            let got = read_or_reopen(&mut file, &path, pos, want);
            let stop = !matches!(&got, Ok(b) if !b.is_empty());
            if let Ok(b) = &got {
                pos += b.len() as u64;
            }
            if tx.send(got).is_err() || stop {
                break;
            }
        }
    });
    for chunk in rx {
        let chunk = chunk?;
        if chunk.is_empty() {
            break;
        }
        out.write_all(&chunk)?;
    }
    Ok(())
}

/// A part of the film, the file opened afresh and the read tried again if
/// it fails: a NAS busy with a burst of skips, or a connection it dropped,
/// should cost a moment, not the film (seen on a box: replies cut short and
/// the player giving up).
fn read_or_reopen(file: &mut netshare::RemoteFile, path: &str, pos: u64, want: usize) -> io::Result<Vec<u8>> {
    let mut tries = 0;
    loop {
        let mut buf = vec![0; want];
        match file.read_at(&mut buf, pos) {
            Ok(n) => {
                buf.truncate(n);
                return Ok(buf);
            }
            Err(e) if tries < 2 => {
                tries += 1;
                crate::log!("stream: reading {path} at {pos}: {e}; opening it again");
                std::thread::sleep(std::time::Duration::from_millis(300 * tries));
                match netshare::open(path) {
                    Ok(again) => *file = again,
                    Err(e) => crate::log!("stream: could not open {path} again: {e}"),
                }
            }
            Err(e) => {
                crate::log!("stream: reading {path} at {pos} failed: {e}");
                return Err(e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn ranges_are_read_as_players_send_them() {
        assert_eq!(range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(range("bytes=10-19", 100), Some((10, 19)));
        // Past the end is cut to it.
        assert_eq!(range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(range("bytes=100-", 100), None);
        assert_eq!(range("bytes=-500", 100), None);
        assert_eq!(range("items=0-1", 100), None);
    }

    #[test]
    fn names_survive_the_address() {
        assert_eq!(encode("A Film (2001).mkv"), "A%20Film%20%282001%29.mkv");
    }

    fn get(url: &str, range: Option<&str>) -> (String, Vec<u8>) {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut conn = TcpStream::connect(host).unwrap();
        let extra = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
        write!(conn, "GET /{path} HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n").unwrap();
        let mut all = Vec::new();
        conn.read_to_end(&mut all).unwrap();
        let split = all.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&all[..split]).into_owned(), all[split + 4..].to_vec())
    }

    /// Skipping ahead again and again, as a remote held on → does: each skip
    /// is a new request, and the one before is dropped part-way. The film
    /// read after them must still come whole. (On a box, a burst of skips
    /// was followed by replies cut short and the player giving up.)
    #[test]
    fn a_burst_of_skips_leaves_the_film_readable() {
        let Some(root) = crate::netshare::test_share() else { return };
        let mut dir = root;
        let video = loop {
            let entries = netshare::list(&dir).unwrap();
            if let Some(v) = entries.iter().find(|e| !e.is_dir && e.size > 16 << 20) {
                break format!("{dir}/{}", v.name);
            }
            dir = format!("{dir}/{}", entries.iter().find(|e| e.is_dir).unwrap().name);
        };
        let whole = netshare::read(&video, 1 << 30).unwrap();
        let url = tauri::async_runtime::block_on(stream_address(video)).unwrap();
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        for i in 0..15u64 {
            let mut conn = TcpStream::connect(host).unwrap();
            let from = i * (whole.len() as u64 / 16);
            write!(conn, "GET /{path} HTTP/1.1\r\nHost: {host}\r\nRange: bytes={from}-\r\n\r\n").unwrap();
            let mut some = vec![0; 256 * 1024];
            conn.read_exact(&mut some).unwrap();
            // Dropped mid-reply, as a player does on the next skip.
        }
        let from = whole.len() - (8 << 20);
        let (head, body) = get(&url, Some(&format!("bytes={from}-")));
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(body == whole[from..], "the film after the skips: {} of {} bytes", body.len(), whole.len() - from);
    }

    /// Against a real share, when one is named (`netshare::test_share`).
    #[test]
    fn a_film_on_a_share_is_served_in_parts() {
        let Some(root) = crate::netshare::test_share() else { return };
        let mut dir = root;
        let video = loop {
            let entries = netshare::list(&dir).unwrap();
            if let Some(v) = entries.iter().find(|e| !e.is_dir && crate::scanner::is_video(std::path::Path::new(&e.name))) {
                break format!("{dir}/{}", v.name);
            }
            dir = format!("{dir}/{}", entries.iter().find(|e| e.is_dir).unwrap().name);
        };
        let whole = netshare::read(&video, 1 << 30).unwrap();
        let url = tauri::async_runtime::block_on(stream_address(video.clone())).unwrap();
        assert_eq!(url, tauri::async_runtime::block_on(stream_address(video)).unwrap(), "one address per film");

        let (head, body) = get(&url, None);
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert_eq!(body, whole);

        let (head, body) = get(&url, Some("bytes=1000-"));
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains(&format!("Content-Range: bytes 1000-{}/{}", whole.len() - 1, whole.len())), "{head}");
        assert_eq!(body, whole[1000..]);

        let (_, body) = get(&url, Some("bytes=5-9"));
        assert_eq!(body, whole[5..10]);

        // Without the secret, nothing.
        let wrong = url.replacen(&server().unwrap().secret, "0123", 1);
        assert!(get(&wrong, None).0.starts_with("HTTP/1.1 404"));
    }
}
