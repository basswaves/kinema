//! Network shares Kinema opens itself, over SMB.
//!
//! On Windows and Linux the system connects to a NAS and Kinema sees a folder
//! (`\\NAS\films`, a GNOME network mount). Android does not do that for an
//! app, so there Kinema speaks SMB itself (owner's choice, 2026-10-04: one
//! SMB client, in the core, used by everything that reads files).
//!
//! A file on a share is addressed as `smb://server/share/folder/file.mkv` —
//! with a port after the server (`server:4450`) only where the share is not on
//! SMB's own. The rest of Kinema keeps such a path as text, as it keeps any
//! other; only reading it comes here.
//!
//! One connection per server, opened on first use and kept: the scanner asks
//! for thousands of folders in a row, and signing in each time would be most
//! of the cost. A connection the NAS dropped (asleep, restarted) is opened
//! once more before an error is given.

use smb::resource::Resource;
use smb::{Client, ClientConfig, FileAccessMask, FileCreateArgs, UncPath};
use std::collections::{HashMap, HashSet};
use std::io;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

const SCHEME: &str = "smb://";

/// How long a NAS is given to answer. Long, because a sleeping one has to
/// spin its disks up first; the scanner already runs off the interface.
const TIMEOUT: Duration = Duration::from_secs(20);

/// Whether a path is on a share Kinema opens itself.
pub fn is_share_path(path: &str) -> bool {
    path.get(..SCHEME.len()).is_some_and(|s| s.eq_ignore_ascii_case(SCHEME))
}

/// `smb://server[:port]/share/inner/path`, taken apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address {
    pub server: String,
    pub port: Option<u16>,
    pub share: String,
    /// Inside the share, `/`-separated, without a leading or trailing `/`;
    /// empty for the share itself.
    pub inner: String,
}

impl Address {
    pub fn parse(path: &str) -> Option<Address> {
        if !is_share_path(path) {
            return None;
        }
        let rest = &path[SCHEME.len()..];
        // `\` too: a path joined on Windows (`Path::join`) gains one.
        let mut parts = rest.split(['/', '\\']).filter(|p| !p.is_empty());
        let host = parts.next()?;
        let share = parts.next()?.to_string();
        let inner = parts.collect::<Vec<_>>().join("/");
        let (server, port) = match host.rsplit_once(':') {
            Some((s, p)) if !s.is_empty() => (s.to_string(), Some(p.parse().ok()?)),
            _ => (host.to_string(), None),
        };
        Some(Address { server, port, share, inner })
    }

    /// The server as one name, port included: what a connection is kept under.
    fn host(&self) -> String {
        match self.port {
            Some(p) => format!("{}:{p}", self.server),
            None => self.server.clone(),
        }
    }

    fn share_unc(&self) -> io::Result<UncPath> {
        UncPath::from_str(&format!("//{}/{}", self.server, self.share)).map_err(to_io)
    }

    fn unc(&self) -> io::Result<UncPath> {
        let share = self.share_unc()?;
        Ok(if self.inner.is_empty() { share } else { share.with_path(&self.inner.replace('/', "\\")) })
    }
}

/// A file or folder on a share, as a folder listing gives it.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: SystemTime,
}

#[derive(Clone)]
struct Login {
    user: String,
    password: String,
}

/// A kept connection to one server.
struct Server {
    client: Client,
    /// The shares it is signed in to, lower-cased. Locked while one is being
    /// signed in to: two sign-ins at once on one connection crashed inside the
    /// SMB library (a scan and a film starting together would do it).
    shares: Mutex<HashSet<String>>,
}

#[derive(Default)]
struct State {
    logins: HashMap<String, Login>,
    servers: HashMap<String, Arc<Server>>,
}

fn state() -> std::sync::MutexGuard<'static, State> {
    static STATE: std::sync::OnceLock<Mutex<State>> = std::sync::OnceLock::new();
    let m = STATE.get_or_init(Default::default);
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The name and password a server (`nas`, or `nas:4450` off SMB's own port)
/// is signed in with. An empty name is a guest. A changed sign-in closes the
/// server's connection, so the next use signs in afresh.
pub fn set_login(server: &str, user: &str, password: &str) {
    let mut s = state();
    s.logins.insert(server.to_string(), Login { user: user.to_string(), password: password.to_string() });
    s.servers.remove(server);
}

/// Signs Kinema in to a server for this session. Kept in memory only, for
/// now; stored sign-ins come with the screen that asks for them.
#[tauri::command]
pub fn sign_in_share(server: String, user: String, password: String) {
    set_login(&server, &user, &password);
}

/// A connection to the share `addr` is on, signed in, made if need be.
fn connect(addr: &Address) -> io::Result<Arc<Server>> {
    let host = addr.host();
    let (server, login) = {
        let mut s = state();
        let login = s.logins.get(&host).cloned().unwrap_or(Login { user: String::new(), password: String::new() });
        let server = s
            .servers
            .entry(host)
            .or_insert_with(|| {
                let mut config = ClientConfig::default();
                config.connection.port = addr.port;
                config.connection.timeout = Some(TIMEOUT);
                // DFS referrals lead to other servers Kinema has no sign-in for.
                config.dfs = false;
                Arc::new(Server { client: Client::new(config), shares: Mutex::default() })
            })
            .clone();
        (server, login)
    };
    // Outside the state lock: signing in is a network round trip or several,
    // and other servers need not wait for it.
    let mut shares = server.shares.lock().unwrap_or_else(|e| e.into_inner());
    let share = addr.share.to_lowercase();
    if !shares.contains(&share) {
        server.client.share_connect(&addr.share_unc()?, &login.user, login.password).map_err(to_io)?;
        shares.insert(share);
    }
    drop(shares);
    Ok(server)
}

/// Forgets the connection to `addr`'s server, so the next use opens a new one.
fn drop_connection(addr: &Address) {
    state().servers.remove(&addr.host());
}

/// Runs `op` on a connection, once more on a fresh one if the first failed
/// for any reason but the answer itself (not there, not allowed).
fn with_client<T>(addr: &Address, op: impl Fn(&Client, &UncPath) -> io::Result<T>) -> io::Result<T> {
    let unc = addr.unc()?;
    match connect(addr).and_then(|s| op(&s.client, &unc)) {
        Err(e) if !matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied) => {
            drop_connection(addr);
            op(&connect(addr)?.client, &unc)
        }
        other => other,
    }
}

fn read_access() -> FileCreateArgs {
    FileCreateArgs::make_open_existing(FileAccessMask::new().with_generic_read(true))
}

/// Closes a file or folder on the share when it goes out of use. Without
/// this the server keeps it open, and the library warns in the log.
struct Open(Option<Resource>);

impl Drop for Open {
    fn drop(&mut self) {
        let closed = match self.0.take() {
            Some(Resource::File(f)) => f.close(),
            Some(Resource::Directory(d)) => d.close(),
            Some(Resource::Pipe(p)) => p.close(),
            None => Ok(()),
        };
        if let Err(e) = closed {
            log::debug!("netshare: closing: {e}");
        }
    }
}

/// What is in a folder on a share: its files and folders, without `.`/`..`.
pub fn list(path: &str) -> io::Result<Vec<Entry>> {
    let addr = parse(path)?;
    with_client(&addr, |client, unc| {
        let open = Open(Some(client.create_file(unc, &read_access()).map_err(to_io)?));
        let Some(Resource::Directory(dir)) = &open.0 else {
            return Err(io::Error::new(io::ErrorKind::NotADirectory, format!("{path} is not a folder")));
        };
        let mut entries = Vec::new();
        for item in dir.query::<smb::FileDirectoryInformation>("*").map_err(to_io)? {
            let item = item.map_err(to_io)?;
            let name = item.file_name.to_string();
            if name == "." || name == ".." {
                continue;
            }
            entries.push(Entry {
                name,
                is_dir: item.file_attributes.directory(),
                size: item.end_of_file,
                modified: SystemTime::from(item.last_write_time),
            });
        }
        Ok(entries)
    })
}

/// One file or folder on a share.
pub fn stat(path: &str) -> io::Result<Entry> {
    let addr = parse(path)?;
    let name = addr.inner.rsplit('/').next().unwrap_or(&addr.share).to_string();
    with_client(&addr, |client, unc| {
        let open = Open(Some(client.create_file(unc, &read_access()).map_err(to_io)?));
        let time = |t| SystemTime::from(smb::binrw_util::file_time::FileTime::from(t));
        Ok(match open.0.as_ref().expect("just opened") {
            Resource::File(f) => {
                use smb::resource::GetLen;
                Entry { name: name.clone(), is_dir: false, size: f.get_len().map_err(to_io)?, modified: time(f.modified()) }
            }
            Resource::Directory(d) => Entry { name: name.clone(), is_dir: true, size: 0, modified: time(d.modified()) },
            Resource::Pipe(_) => return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{path} is not a file"))),
        })
    })
}

/// A file on a share, open for reading anywhere in it.
pub struct RemoteFile {
    open: Open,
    len: u64,
}

impl RemoteFile {
    pub fn len(&self) -> u64 {
        self.len
    }

    /// Reads into `buf` from `pos`; fewer bytes than asked for only at the end.
    pub fn read_at(&self, buf: &mut [u8], pos: u64) -> io::Result<usize> {
        let Some(Resource::File(f)) = &self.open.0 else { unreachable!("opened as a file") };
        let mut done = 0;
        while done < buf.len() {
            // The server's largest read is often 1–8 MiB; the library
            // splits nothing, so ask in pieces it will take.
            let end = buf.len().min(done + (1 << 20));
            let n = f.read_block(&mut buf[done..end], pos + done as u64, None, false)?;
            if n == 0 {
                break;
            }
            done += n;
        }
        Ok(done)
    }
}

/// Opens a file on a share for reading.
pub fn open(path: &str) -> io::Result<RemoteFile> {
    let addr = parse(path)?;
    with_client(&addr, |client, unc| {
        let open = Open(Some(client.create_file(unc, &read_access()).map_err(to_io)?));
        let len = match &open.0 {
            Some(Resource::File(f)) => {
                use smb::resource::GetLen;
                f.get_len().map_err(to_io)?
            }
            _ => return Err(io::Error::new(io::ErrorKind::IsADirectory, format!("{path} is a folder"))),
        };
        Ok(RemoteFile { open, len })
    })
}

/// A whole small file on a share (an `.nfo`, a subtitle), up to `max` bytes.
pub fn read(path: &str, max: u64) -> io::Result<Vec<u8>> {
    let file = open(path)?;
    if file.len() > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("{path} is larger than {max} bytes")));
    }
    let mut buf = vec![0; file.len() as usize];
    let n = file.read_at(&mut buf, 0)?;
    buf.truncate(n);
    Ok(buf)
}

fn parse(path: &str) -> io::Result<Address> {
    Address::parse(path).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("not a share address: {path}")))
}

/// The library's errors as the kinds the rest of Kinema already tells apart:
/// not there, not allowed, anything else.
fn to_io(e: smb::Error) -> io::Error {
    const NOT_FOUND: &[u32] = &[
        0xC000_000F, // NO_SUCH_FILE
        0xC000_0034, // OBJECT_NAME_NOT_FOUND
        0xC000_003A, // OBJECT_PATH_NOT_FOUND
        0xC000_00CC, // BAD_NETWORK_NAME: no such share
    ];
    const DENIED: &[u32] = &[
        0xC000_0022, // ACCESS_DENIED
        0xC000_006D, // LOGON_FAILURE
        0xC000_006E, // ACCOUNT_RESTRICTION
        0xC000_0072, // ACCOUNT_DISABLED
    ];
    let status = match &e {
        smb::Error::ReceivedErrorMessage(s, _) | smb::Error::UnexpectedMessageStatus(s) => Some(*s),
        _ => None,
    };
    if let smb::Error::IoError(io) = e {
        return io;
    }
    let kind = match status {
        Some(s) if NOT_FOUND.contains(&s) => io::ErrorKind::NotFound,
        Some(s) if DENIED.contains(&s) => io::ErrorKind::PermissionDenied,
        _ => io::ErrorKind::Other,
    };
    io::Error::new(kind, e.to_string())
}

/// A real share for tests, when one is named: `KINEMA_TEST_SHARE` (an
/// `smb://` folder holding at least one folder and one video), signed in with
/// `KINEMA_TEST_SHARE_USER` and `KINEMA_TEST_SHARE_PASSWORD`. None otherwise,
/// and the test passes without it — CI has no NAS. `scripts/android-bench.sh
/// share` makes one.
#[cfg(test)]
pub(crate) fn test_share() -> Option<String> {
    let root = std::env::var("KINEMA_TEST_SHARE").ok()?;
    let addr = Address::parse(&root).expect("KINEMA_TEST_SHARE is an smb:// address");
    set_login(
        &addr.host(),
        &std::env::var("KINEMA_TEST_SHARE_USER").unwrap_or_default(),
        &std::env::var("KINEMA_TEST_SHARE_PASSWORD").unwrap_or_default(),
    );
    Some(root.trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_taken_apart() {
        assert_eq!(
            Address::parse("smb://nas/films/Some Film (2001)/film.mkv"),
            Some(Address { server: "nas".into(), port: None, share: "films".into(), inner: "Some Film (2001)/film.mkv".into() })
        );
        assert_eq!(
            Address::parse("SMB://10.0.2.2:4450/films/"),
            Some(Address { server: "10.0.2.2".into(), port: Some(4450), share: "films".into(), inner: String::new() })
        );
        // A server alone is not a place a file can be.
        assert_eq!(Address::parse("smb://nas/films\\A Film\\a.nfo").unwrap().inner, "A Film/a.nfo");
        assert_eq!(Address::parse("smb://nas"), None);
        assert_eq!(Address::parse("smb://nas:x/films"), None);
        assert_eq!(Address::parse("/storage/films"), None);
        assert!(is_share_path("smb://nas/films"));
        assert!(!is_share_path("C:\\films"));
    }

    /// A slow link, made here: a relay to the real share that passes the
    /// server's answers on in pieces, with a pause longer than the SMB
    /// library's 100 ms poll between them. The library lost its place in
    /// the middle of a message like this (an emulator's network did it),
    /// until the patched copy in vendor/.
    #[test]
    fn a_slow_link_loses_nothing() {
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        let Some(root) = test_share() else { return };
        let addr = Address::parse(&root).unwrap();
        let target = format!("{}:{}", addr.server, addr.port.unwrap_or(445));
        let relay = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = relay.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for client in relay.incoming().flatten() {
                let server = TcpStream::connect(&target).unwrap();
                let (mut c_in, mut s_out) = (client.try_clone().unwrap(), server.try_clone().unwrap());
                std::thread::spawn(move || std::io::copy(&mut c_in, &mut s_out));
                let (mut s_in, mut c_out) = (server, client);
                std::thread::spawn(move || {
                    let mut buf = vec![0; 300 * 1024];
                    while let Ok(n) = s_in.read(&mut buf) {
                        if n == 0 || c_out.write_all(&buf[..n]).is_err() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(150));
                    }
                });
            }
        });
        let slow_host = format!("127.0.0.1:{port}");
        let (user, password) = {
            let s = state();
            let l = s.logins.get(&addr.host()).cloned().unwrap();
            (l.user, l.password)
        };
        set_login(&slow_host, &user, &password);
        let slow_root = format!("smb://{slow_host}/{}/{}", addr.share, addr.inner);
        let fast_root = root.clone();

        // The first video, and the same 3 MiB of it read both ways.
        let mut dir = (fast_root.clone(), slow_root.clone());
        let (fast, slow) = loop {
            let entries = list(&dir.0).unwrap();
            if let Some(v) = entries.iter().find(|e| !e.is_dir && e.size > 4 << 20) {
                break (format!("{}/{}", dir.0, v.name), format!("{}/{}", dir.1, v.name));
            }
            let sub = &entries.iter().find(|e| e.is_dir).expect("a video over 4 MiB below").name;
            dir = (format!("{}/{sub}", dir.0), format!("{}/{sub}", dir.1));
        };
        let mut expected = vec![0; 3 << 20];
        open(&fast).unwrap().read_at(&mut expected, 1 << 20).unwrap();
        let mut got = vec![0; 3 << 20];
        let n = open(&slow).unwrap().read_at(&mut got, 1 << 20).unwrap();
        assert_eq!(n, got.len());
        assert!(got == expected, "the same bytes over the slow link");
        // And the connection still answers after it.
        assert!(stat(&slow).is_ok());
    }

    /// Against a real share, when one is named (`test_share`).
    #[test]
    fn a_real_share_lists_reads_and_says_what_is_missing() {
        let Some(root) = test_share() else { return };
        let root = root.as_str();
        // Several at once on a fresh sign-in: the library's own sign-in
        // crashed when two ran together on one connection.
        let at_once: Vec<_> = (0..8)
            .map(|_| {
                let root = root.to_string();
                std::thread::spawn(move || list(&root).map(|e| e.len()))
            })
            .collect();
        for t in at_once {
            t.join().expect("no crash").unwrap();
        }
        let entries = list(root).unwrap();
        assert!(entries.iter().any(|e| e.is_dir), "{entries:?}");

        // The first video anywhere below, by walking down.
        let mut dir = root.to_string();
        let video = loop {
            let entries = list(&dir).unwrap();
            if let Some(v) = entries.iter().find(|e| !e.is_dir && crate::scanner::is_video(std::path::Path::new(&e.name))) {
                break format!("{dir}/{}", v.name);
            }
            let sub = entries.iter().find(|e| e.is_dir).expect("a folder with a video below it");
            dir = format!("{dir}/{}", sub.name);
        };
        let found = stat(&video).unwrap();
        assert!(!found.is_dir && found.size > 0);
        assert!(found.modified > SystemTime::UNIX_EPOCH);

        let file = open(&video).unwrap();
        assert_eq!(file.len(), found.size);
        let mut head = vec![0; 4];
        assert_eq!(file.read_at(&mut head, 0).unwrap(), 4);
        // A video's first bytes say what it is (Matroska: 1A 45 DF A3).
        assert_ne!(head, [0; 4]);
        // Past the end, nothing; across it, what there is.
        assert_eq!(file.read_at(&mut head, found.size).unwrap(), 0);
        assert_eq!(file.read_at(&mut head, found.size - 2).unwrap(), 2);

        // Read by several at once, as a player opening a film does (the
        // start and the end of it): every byte as it is in the file.
        let whole = read(&video, 1 << 30).unwrap();
        let readers: Vec<_> = (0..4)
            .map(|i| {
                let video = video.clone();
                std::thread::spawn(move || {
                    let file = open(&video).unwrap();
                    let mut out = vec![0; file.len() as usize];
                    let mut pos = (i * 1_000_003) as u64 % file.len();
                    for _ in 0..2 {
                        while pos < file.len() {
                            let end = (pos as usize + (1 << 20)).min(out.len());
                            let n = file.read_at(&mut out[pos as usize..end], pos).unwrap();
                            pos += n as u64;
                        }
                        pos = 0;
                    }
                    out
                })
            })
            .collect();
        for r in readers {
            assert!(r.join().expect("no crash") == whole, "the same bytes");
        }

        assert_eq!(stat(&format!("{root}/no such file.mkv")).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(list(&format!("{root}/no such folder")).unwrap_err().kind(), io::ErrorKind::NotFound);
    }
}
