//! Small copies of posters, for the grids.
//!
//! A web page decodes a picture at its full size however small it is drawn:
//! a screen of 2000×3000 posters is 800 MB, of 4000×6000 3 GB, and on a computer
//! with 4 GB the kernel then ends the page (notes on the measurements: GOTCHAS).
//! So a grid asks for `thumb://…/<name in the artwork folder>?w=<pixels>`, and
//! gets a copy made here the first time it is seen and kept in `artwork/thumbs`.
//! Made when a card is near the screen, so a scan never waits for one.
//!
//! Only Kinema's own cache folder is written; the pictures beside a film were
//! copied there already (local_art.rs) and are not touched. Anything that goes
//! wrong answers 404 and the page falls back to the picture itself, as it did
//! before this existed (`Art.tsx`).

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use image::imageops::{self, FilterType};
use image::{codecs::jpeg::JpegEncoder, ImageReader, Limits};
use tauri::http::{header, Request, Response, StatusCode};
use tokio::sync::Semaphore;

/// The name the page uses for it, in `Art.tsx` and the content security policy.
pub const SCHEME: &str = "thumb";

/// The sizes made, which `thumbSize` in `Art.tsx` chooses from. A few fixed ones,
/// so a window dragged wider does not make a new set of every picture.
const WIDTHS: [u32; 6] = [240, 360, 480, 720, 960, 1280];

/// Inside the artwork folder (`artwork::clear_artwork_cache` knows it too).
pub const FOLDER: &str = "thumbs";

/// Two at a time: this decodes the picture at full size, and a screenful of big
/// ones at once would be the very thing this is here to stop.
static WORKERS: Semaphore = Semaphore::const_new(2);

/// Refused beyond this, which falls back to the page's own way.
const MOST_MEMORY: u64 = 512 << 20;

/// JPEG quality: nothing to see at the size these are drawn.
const QUALITY: u8 = 88;

/// What `thumb://` answers, off the window's thread.
pub fn serve(app: tauri::AppHandle, request: Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    tauri::async_runtime::spawn(async move {
        let base = crate::data_dir(&app).ok().map(|d| d.join("artwork"));
        let answer = match (wanted(&request), base) {
            (Some((name, width)), Some(base)) => picture(base, name, width).await,
            _ => None,
        };
        responder.respond(match answer {
            Some(bytes) => {
                let kind = image::guess_format(&bytes).map(|f| f.to_mime_type()).unwrap_or("image/jpeg");
                Response::builder()
                    .header(header::CONTENT_TYPE, kind)
                    .body(bytes)
                    .unwrap_or_default()
            }
            None => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Vec::new())
                .unwrap_or_default(),
        });
    });
}

/// The file name and width asked for. A name is a plain file name, and only
/// that: nothing outside the artwork folder can be asked for.
fn wanted(request: &Request<Vec<u8>>) -> Option<(String, u32)> {
    let uri = request.uri();
    let name = uri.path().trim_start_matches('/');
    let plain = !name.is_empty()
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    let width: u32 = uri.query()?.strip_prefix("w=")?.parse().ok()?;
    (plain && WIDTHS.contains(&width)).then(|| (name.to_string(), width))
}

async fn picture(base: PathBuf, name: String, width: u32) -> Option<Vec<u8>> {
    let source = base.join(&name);
    let meta = std::fs::metadata(&source).ok()?;
    let stamp = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    // By what the file is now, so a poster fetched again gets a new copy.
    let made = base.join(FOLDER).join(format!("{name}-{width}-{}-{stamp}.jpg", meta.len()));
    if let Ok(bytes) = std::fs::read(&made) {
        // Empty: this picture would not decode, and it was noted (`make`).
        return (!bytes.is_empty()).then_some(bytes);
    }
    let _turn = WORKERS.acquire().await.ok()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _low = crate::jobs::background();
        make(&source, &made, &name, width)
    })
    .await
    .ok()?
}

/// Make one and keep it, and the answer that it cannot be made too, so a damaged
/// picture is decoded once and not at every visit.
fn make(source: &Path, made: &Path, name: &str, width: u32) -> Option<Vec<u8>> {
    let folder = made.parent()?;
    std::fs::create_dir_all(folder).ok()?;
    let bytes = match shrink(&std::fs::read(source).ok()?, width) {
        Ok(bytes) => bytes,
        Err(e) => {
            crate::log!("thumbs: {name}: {e}; using the picture itself");
            Vec::new()
        }
    };
    let part = made.with_extension("part");
    std::fs::write(&part, &bytes).ok()?;
    std::fs::rename(&part, made).ok()?;
    forget_older(folder, name, width, made);
    (!bytes.is_empty()).then_some(bytes)
}

/// The same picture and size from before it changed.
fn forget_older(folder: &Path, name: &str, width: u32, made: &Path) {
    let start = format!("{name}-{width}-");
    let Ok(entries) = std::fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        let found = entry.file_name();
        let found = found.to_string_lossy();
        if found.starts_with(&start) && entry.path() != made {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// `bytes` at `width` wide, as JPEG; as they are if already that small.
fn shrink(bytes: &[u8], width: u32) -> Result<Vec<u8>, String> {
    let (from_w, from_h) = reader(bytes)?.into_dimensions().map_err(|e| e.to_string())?;
    if from_w <= width {
        return Ok(bytes.to_vec());
    }
    let height = ((from_h as u64 * width as u64 / from_w as u64) as u32).max(1);
    let picture = reader(bytes)?.decode().map_err(|e| e.to_string())?.into_rgb8();
    // Averaged down to twice the size first, which is quick, then filtered: the
    // filter alone on a 24 MP picture takes seconds on a slow computer.
    let picture = if from_w > width * 3 {
        let near = imageops::thumbnail(&picture, width * 2, height * 2);
        imageops::resize(&near, width, height, FilterType::Triangle)
    } else {
        imageops::resize(&picture, width, height, FilterType::Triangle)
    };
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, QUALITY)
        .encode_image(&picture)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn reader(bytes: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|e| e.to_string())?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(MOST_MEMORY);
    reader.limits(limits);
    Ok(reader)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, RgbImage};

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        RgbImage::from_pixel(w, h, image::Rgb([200, 40, 40])).write_to(&mut out, ImageFormat::Jpeg).unwrap();
        out.into_inner()
    }

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kinema-thumbs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ask(uri: &str) -> Option<(String, u32)> {
        wanted(&Request::builder().uri(uri).body(Vec::new()).unwrap())
    }

    #[test]
    fn only_a_plain_file_name_and_a_known_width_are_asked_for() {
        assert_eq!(ask("thumb://localhost/52.jpg?w=240"), Some(("52.jpg".into(), 240)));
        assert_eq!(ask("http://thumb.localhost/local-7.webp?w=480"), Some(("local-7.webp".into(), 480)));
        assert_eq!(ask("thumb://localhost/..%2F..%2Fsecret?w=240"), None);
        assert_eq!(ask("thumb://localhost/a/b.jpg?w=240"), None);
        assert_eq!(ask("thumb://localhost/.hidden?w=240"), None);
        assert_eq!(ask("thumb://localhost/52.jpg?w=241"), None);
        assert_eq!(ask("thumb://localhost/52.jpg"), None);
    }

    #[test]
    fn a_big_picture_comes_out_at_the_width_with_its_shape() {
        let small = shrink(&jpeg(2000, 3000), 240).unwrap();
        let out = image::load_from_memory(&small).unwrap();
        assert_eq!((out.width(), out.height()), (240, 360));
        // Between the quick step and straight to the filter.
        let out = image::load_from_memory(&shrink(&jpeg(500, 750), 240).unwrap()).unwrap();
        assert_eq!((out.width(), out.height()), (240, 360));
    }

    #[test]
    fn a_picture_already_small_enough_is_left_as_it_is() {
        let bytes = jpeg(200, 300);
        assert_eq!(shrink(&bytes, 240).unwrap(), bytes);
    }

    #[test]
    fn a_damaged_picture_is_refused_and_noted_so_it_is_not_tried_again() {
        let base = folder("bad");
        std::fs::write(base.join("9.jpg"), b"\xff\xd8\xffnot a picture at all").unwrap();
        let made = base.join(FOLDER).join("9.jpg-240-1-1.jpg");
        assert!(make(&base.join("9.jpg"), &made, "9.jpg", 240).is_none());
        assert_eq!(std::fs::read(&made).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_new_copy_of_a_picture_takes_the_place_of_the_old() {
        let base = folder("old");
        std::fs::write(base.join("9.jpg"), jpeg(900, 1350)).unwrap();
        let older = base.join(FOLDER).join("9.jpg-240-1-1.jpg");
        let other = base.join(FOLDER).join("9.jpg-480-1-1.jpg");
        let newer = base.join(FOLDER).join("9.jpg-240-2-2.jpg");
        assert!(make(&base.join("9.jpg"), &older, "9.jpg", 240).is_some());
        assert!(make(&base.join("9.jpg"), &other, "9.jpg", 480).is_some());
        assert!(make(&base.join("9.jpg"), &newer, "9.jpg", 240).is_some());
        assert!(!older.exists() && other.exists() && newer.exists());
        let _ = std::fs::remove_dir_all(base);
    }
}
