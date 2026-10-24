//! Send a report: the logs and the equipment check, packed into one zip for
//! a bug report (Settings → Developer tools, and the crash screen).
//!
//! Kinema sends nothing itself. The zip goes to the Downloads folder and
//! Kinema says where; the file manager and the bug-report form open only when
//! the user presses for them, so neither covers the note saying which file to
//! attach (owner, 2026-10-24: the form opening at once hid it). Before anything is packed, the home folder's path is
//! replaced by `~` everywhere, so the user name in it stays out of a public
//! issue (owner, 2026-10-23); film and folder names stay, since they are
//! often the bug.
//!
//! The zip is written here rather than with a crate: the format is frozen,
//! deflate and CRC-32 are already in the build (`flate2`), and one less
//! dependency is one less thing to break by itself.

use crate::util::{now_secs, to_string_err};
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use tauri::Manager;

/// What was packed and where, for Settings to say.
#[derive(Debug, Serialize)]
pub struct Report {
    pub path: String,
    pub files: Vec<String>,
}

/// Pack the report and save it. Showing it is `show_report`'s, on a press.
#[tauri::command]
pub async fn make_report(app: tauri::AppHandle) -> Result<Report, String> {
    crate::jobs::off_main(move || {
        let logs = crate::data_dir(&app)?.join(crate::applog::DIR);
        let home = app.path().home_dir().ok();
        let equipment = crate::equipment::latest_or_check(&app)
            .map(|view| equipment_text(&app, &view))
            .unwrap_or_else(|e| format!("The equipment check failed: {e}\n"));

        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        // This session and the one before: a crash is usually in the last one.
        for name in ["app.log", "app.previous.log", "mpv.log", "mpv.previous.log"] {
            if let Ok(bytes) = std::fs::read(logs.join(name)) {
                entries.push((name.to_string(), last_part(bytes)));
            }
        }
        entries.push(("equipment.txt".into(), equipment.into_bytes()));
        if let Some(home) = &home {
            for (_, bytes) in &mut entries {
                *bytes = hide_home(bytes, home);
            }
        }

        let folder = app
            .path()
            .download_dir()
            .ok()
            .filter(|d| d.is_dir())
            .map_or_else(|| crate::data_dir(&app), Ok)?;
        let path = folder.join(format!("kinema-report-{}.zip", stamp(now_secs())));
        let zip = write_zip(&entries, now_secs()).map_err(to_string_err)?;
        // Beside it first: a full disk or a pulled drive leaves no half zip
        // under the name the screen gives.
        let part = path.with_extension("zip.part");
        std::fs::write(&part, zip)
            .and_then(|()| std::fs::rename(&part, &path))
            .map_err(|e| {
                let _ = std::fs::remove_file(&part);
                to_string_err(e)
            })?;
        crate::log!("report: saved {} ({} files)", path.display(), entries.len());
        Ok(Report {
            path: path.to_string_lossy().into_owned(),
            files: entries.into_iter().map(|(name, _)| name).collect(),
        })
    })
    .await
}

/// Show a saved report in the file manager — only a file `make_report` named.
#[tauri::command]
pub fn show_report(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = Path::new(&path);
    let named = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("kinema-report-") && n.ends_with(".zip"));
    if !named || !path.is_file() {
        return Err(format!("not a saved report: {}", path.display()));
    }
    // A self-test runs beside someone using the PC: no file manager over
    // their work. The log line is the proof it would have shown.
    if crate::selftest::plan_path().is_some() {
        crate::log!("report: would show {}", path.display());
        return Ok(());
    }
    show(&app, path);
    Ok(())
}

/// Select the file in the file manager; failing that, open its folder.
fn show(app: &tauri::AppHandle, path: &Path) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().reveal_item_in_dir(path) {
        crate::log!("report: could not select the file ({e}); opening its folder");
        if let Some(dir) = path.parent() {
            let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
        }
    }
}

fn equipment_text(app: &tauri::AppHandle, view: &crate::equipment::EquipmentView) -> String {
    let mut text = format!(
        "Kinema {} on {} {}\n\n",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    for line in crate::equipment::summary(view) {
        text.push_str(&line);
        text.push('\n');
    }
    text.push('\n');
    text.push_str(&serde_json::to_string_pretty(view).unwrap_or_default());
    text.push('\n');
    text
}

/// `bytes` with every spelling of `home` replaced by `~`: as the system
/// writes it, with forward slashes, and with JSON's doubled backslashes;
/// ignoring case on Windows, where paths do.
pub fn hide_home(bytes: &[u8], home: &Path) -> Vec<u8> {
    let home = home.to_string_lossy();
    let home = home.trim_end_matches(['/', '\\']);
    if home.len() < 3 {
        return bytes.to_vec();
    }
    let forms = [home.to_string(), home.replace('\\', "/"), home.replace('\\', "\\\\")];
    let mut out = bytes.to_vec();
    for form in forms.iter().filter(|f| !f.is_empty()) {
        out = replace_all(&out, form.as_bytes(), b"~", cfg!(windows));
    }
    out
}

fn replace_all(hay: &[u8], needle: &[u8], with: &[u8], ignore_case: bool) -> Vec<u8> {
    let same = |a: &[u8]| {
        if ignore_case {
            a.eq_ignore_ascii_case(needle)
        } else {
            a == needle
        }
    };
    let mut out = Vec::with_capacity(hay.len());
    let mut i = 0;
    while i < hay.len() {
        if i + needle.len() <= hay.len() && same(&hay[i..i + needle.len()]) {
            out.extend_from_slice(with);
            i += needle.len();
        } else {
            out.push(hay[i]);
            i += 1;
        }
    }
    out
}

/// `2026-10-23-1405`, in UTC, for the file name.
fn stamp(secs: i64) -> String {
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let in_day = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}-{:02}{:02}", in_day / 3600, in_day % 3600 / 60)
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// The most of one log a report carries. app.log rotates at 8 MB (applog.rs),
/// but mpv writes its own log and only a launch starts it afresh: a long
/// session's can be far larger, and the end is where the fault is.
const MAX_LOG: usize = 16 * 1024 * 1024;

/// `bytes`, or its last [`MAX_LOG`] with a line saying what was left out.
fn last_part(bytes: Vec<u8>) -> Vec<u8> {
    if bytes.len() <= MAX_LOG {
        return bytes;
    }
    let cut = bytes.len() - MAX_LOG;
    let mut out = format!("[the first {cut} bytes of this log are left out]\n").into_bytes();
    out.extend_from_slice(&bytes[cut..]);
    out
}

/// A zip of `entries`, each deflated, with UTF-8 names. No zip64: each log is
/// cut to [`MAX_LOG`], far under its 4 GB limit, and there are five at most.
pub fn write_zip(entries: &[(String, Vec<u8>)], secs: i64) -> std::io::Result<Vec<u8>> {
    let (time, date) = dos_time(secs);
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let mut deflate = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        let packed = deflate.write_all(data).and_then(|()| deflate.finish())?;
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let offset = out.len() as u32;
        let fields = |v: &mut Vec<u8>| {
            v.extend_from_slice(&20u16.to_le_bytes()); // version needed: 2.0
            v.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
            v.extend_from_slice(&8u16.to_le_bytes()); // deflate
            v.extend_from_slice(&time.to_le_bytes());
            v.extend_from_slice(&date.to_le_bytes());
            v.extend_from_slice(&crc.sum().to_le_bytes());
            v.extend_from_slice(&(packed.len() as u32).to_le_bytes());
            v.extend_from_slice(&(data.len() as u32).to_le_bytes());
            v.extend_from_slice(&(name.len() as u16).to_le_bytes());
            v.extend_from_slice(&0u16.to_le_bytes()); // extra field
        };
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        fields(&mut out);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&packed);

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // made by: 2.0
        fields(&mut central);
        central.extend_from_slice(&[0; 6]); // comment length, disk, internal attributes
        central.extend_from_slice(&0u32.to_le_bytes()); // external attributes
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_at = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]); // this disk, the disk with the directory
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_at.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment
    Ok(out)
}

/// MS-DOS time and date, as zip keeps them (UTC here; two-second steps).
fn dos_time(secs: i64) -> (u16, u16) {
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    let time = (((s / 3600) << 11) | ((s % 3600 / 60) << 5) | ((s % 60) / 2)) as u16;
    let date = ((((y - 1980).max(0) << 9) as u32) | (m << 5) | d) as u16;
    (time, date)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_log_past_the_limit_keeps_its_end_and_says_so() {
        let small = b"short".to_vec();
        assert_eq!(last_part(small.clone()), small);
        let mut big = vec![b'a'; MAX_LOG];
        big.extend_from_slice(b"the end");
        let kept = last_part(big);
        assert!(kept.starts_with(b"[the first 7 bytes of this log are left out]\n"));
        assert!(kept.ends_with(b"the end"));
    }

    #[test]
    fn the_stamp_is_the_utc_date_and_minute() {
        assert_eq!(stamp(0), "1970-01-01-0000");
        // 2026-10-23 14:05:09 UTC
        assert_eq!(stamp(1_792_764_309), "2026-10-23-1405");
        assert_eq!(civil(-1), (1969, 12, 31));
        assert_eq!(civil(11_016), (2000, 2, 29));
    }

    #[test]
    fn the_home_folder_is_hidden_in_every_spelling() {
        let home = Path::new(r"C:\Users\Someone");
        let log = br#"open C:\Users\Someone\Films\a.mkv; json "C:\\Users\\Someone\\x"; C:/Users/Someone/y"#;
        let out = String::from_utf8(hide_home(log, home)).unwrap();
        assert_eq!(out, r#"open ~\Films\a.mkv; json "~\\x"; ~/y"#);
        let unix = hide_home(b"/home/someone/Films/b.mkv and /home/someoneelse", Path::new("/home/someone/"));
        assert_eq!(unix, b"~/Films/b.mkv and ~else");
    }

    #[test]
    fn a_short_home_is_left_alone() {
        assert_eq!(hide_home(b"/ a /b", Path::new("/")), b"/ a /b");
    }

    #[test]
    fn the_zip_reads_back() {
        let entries = vec![
            ("app.log".to_string(), b"hello hello hello hello".to_vec()),
            ("equipment.txt".to_string(), "screen \u{2014} ok\n".as_bytes().to_vec()),
        ];
        let zip = write_zip(&entries, 1_792_764_309).unwrap();
        // For checking with a real unzip tool (`unzip -t`, Expand-Archive).
        if let Ok(out) = std::env::var("KINEMA_REPORT_ZIP_OUT") {
            std::fs::write(out, &zip).unwrap();
        }
        // End record: two entries, and the directory where it says it is.
        let end = &zip[zip.len() - 22..];
        assert_eq!(&end[..4], &0x0605_4b50u32.to_le_bytes());
        assert_eq!(u16::from_le_bytes([end[10], end[11]]), 2);
        let dir_at = u32::from_le_bytes([end[16], end[17], end[18], end[19]]) as usize;
        // Every directory entry where the one before it says, with its name.
        let mut at = dir_at;
        for (name, _) in &entries {
            assert_eq!(&zip[at..at + 4], &0x0201_4b50u32.to_le_bytes());
            let n = u16::from_le_bytes([zip[at + 28], zip[at + 29]]) as usize;
            assert_eq!(&zip[at + 46..at + 46 + n], name.as_bytes());
            at += 46 + n;
        }
        assert_eq!(at, zip.len() - 22);
        // First entry: header, name, then data that inflates back.
        assert_eq!(&zip[..4], &0x0403_4b50u32.to_le_bytes());
        let packed_len = u32::from_le_bytes([zip[18], zip[19], zip[20], zip[21]]) as usize;
        let name_len = u16::from_le_bytes([zip[26], zip[27]]) as usize;
        assert_eq!(&zip[30..30 + name_len], b"app.log");
        let start = 30 + name_len;
        let mut inflated = Vec::new();
        std::io::Read::read_to_end(
            &mut flate2::read::DeflateDecoder::new(&zip[start..start + packed_len]),
            &mut inflated,
        )
        .unwrap();
        assert_eq!(inflated, entries[0].1);
        let mut crc = flate2::Crc::new();
        crc.update(&entries[0].1);
        assert_eq!(u32::from_le_bytes([zip[14], zip[15], zip[16], zip[17]]), crc.sum());
    }
}
