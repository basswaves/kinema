//! The player's page, as a picture for mpv to draw over the video.
//!
//! Where mpv plays in a window of its own (capabilities `own_window`: Linux),
//! Kinema's page cannot be put over the video — Wayland has no `--wid`, and a
//! second window cannot be kept above mpv's (docs/GOTCHAS.md). So the page is
//! photographed and mpv draws the photo: `overlay_frame` takes one, the
//! frontend (`player/overlay.ts`) hands it to mpv's `overlay-add`. The page
//! stays the one copy of the controls.
//!
//! A frame is premultiplied BGRA — cairo's ARGB32 in memory, which is exactly
//! what mpv's `bgra` takes — written to one of two files in turn, because mpv
//! may still be reading the last one. A frame the same as the last is not
//! written at all, and one with nothing visible in it is reported as empty,
//! so the overlay can be removed rather than blended as nothing.
//!
//! Only the rows with something visible are written: the controls are a bar
//! at the top and one at the bottom, and between them is the film. Each run
//! of visible rows is a band, written one after the other into the file and
//! drawn by mpv as an overlay of its own - at 4K a whole frame was 33 MB ten
//! times a second for two bars of a fraction of that.

// Only Linux photographs the page; elsewhere the frame keeping below is used
// by its tests alone. Linux's clippy still reports anything genuinely unused.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

#[cfg(target_os = "linux")]
mod linux;

/// Rows `y` to `y + height` of the frame, written at `offset` in the file.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Band {
    pub y: i32,
    pub height: i32,
    pub offset: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct OverlayFrame {
    /// Different from the last frame; when false, nothing below was written.
    pub changed: bool,
    /// Nothing visible: every pixel fully transparent.
    pub empty: bool,
    pub path: String,
    pub width: i32,
    pub height: i32,
    pub stride: i32,
    /// The visible parts, top to bottom; empty when nothing is visible.
    pub bands: Vec<Band>,
}

/// Fewer invisible rows than this between two visible ones join their bands:
/// an overlay per line of text would cost more than the rows it saves.
const BAND_GAP: usize = 64;
/// At most this many bands; the closest are joined until it fits.
const MAX_BANDS: usize = 4;

struct Last {
    pixels: Vec<u8>,
    turn: usize,
    costs: Costs,
}

/// What the pictures cost while the player was open, said in app.log when
/// it closes: the measure for any change to how the page is drawn.
#[derive(Default)]
struct Costs {
    photos: u32,
    taking: Duration,
    keeping: Duration,
    written: u64,
}

static LAST: Mutex<Last> = Mutex::new(Last {
    pixels: Vec::new(),
    turn: 0,
    costs: Costs { photos: 0, taking: Duration::ZERO, keeping: Duration::ZERO, written: 0 },
});

/// Where frame number `turn` (0 or 1) is written: memory-backed where the
/// system has it, so ten frames a second never touch a disk.
fn frame_path(turn: usize) -> PathBuf {
    let shm = std::path::Path::new("/dev/shm");
    let dir = if shm.is_dir() { shm.to_path_buf() } else { std::env::temp_dir() };
    dir.join(format!("kinema-overlay-{}-{turn}", std::process::id()))
}

/// Whether premultiplied BGRA `pixels` have nothing visible: alpha is every
/// fourth byte, and zero everywhere.
fn nothing_visible(pixels: &[u8]) -> bool {
    pixels.iter().skip(3).step_by(4).all(|&alpha| alpha == 0)
}

/// The runs of rows with anything visible, as (first row, row count), joined
/// across gaps under `BAND_GAP` and down to `MAX_BANDS`. Only the first
/// `width` pixels of each row count: the rest of a stride is padding.
fn visible_rows(pixels: &[u8], stride: usize, width: usize) -> Vec<(usize, usize)> {
    let mut bands: Vec<(usize, usize)> = Vec::new();
    if stride == 0 {
        return bands;
    }
    for (y, row) in pixels.chunks(stride).enumerate() {
        if nothing_visible(&row[..row.len().min(width * 4)]) {
            continue;
        }
        match bands.last_mut() {
            Some((start, rows)) if y - (*start + *rows) < BAND_GAP => *rows = y + 1 - *start,
            _ => bands.push((y, 1)),
        }
    }
    while bands.len() > MAX_BANDS {
        // Join the two with the fewest rows between them.
        let i = (0..bands.len() - 1)
            .min_by_key(|&i| bands[i + 1].0 - (bands[i].0 + bands[i].1))
            .unwrap_or(0);
        let (next, rows) = bands.remove(i + 1);
        bands[i].1 = next + rows - bands[i].0;
    }
    bands
}

/// Keep a frame: compare it with the last, and write its visible rows if it differs.
fn store(width: i32, height: i32, stride: i32, pixels: Vec<u8>) -> Result<OverlayFrame, String> {
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let changed = last.pixels != pixels;
    let empty = nothing_visible(&pixels);
    if changed && !empty {
        last.turn = 1 - last.turn;
    }
    let path = frame_path(last.turn);
    let row_bytes = usize::try_from(stride).unwrap_or(0);
    let mut bands = Vec::new();
    // Only for a frame that is drawn: an unchanged one is not handed to mpv.
    if changed && !empty {
        let mut offset = 0u64;
        for (y, rows) in visible_rows(&pixels, row_bytes, usize::try_from(width).unwrap_or(0)) {
            bands.push(Band { y: y as i32, height: rows as i32, offset });
            offset += (rows * row_bytes) as u64;
        }
    }
    if changed && !empty {
        let mut file = Vec::with_capacity(bands.iter().map(|b| b.height as usize * row_bytes).sum());
        for band in &bands {
            let start = band.y as usize * row_bytes;
            file.extend_from_slice(&pixels[start..start + band.height as usize * row_bytes]);
        }
        std::fs::write(&path, &file).map_err(crate::util::to_string_err)?;
        last.costs.written += file.len() as u64;
    }
    if changed {
        last.pixels = pixels;
    }
    Ok(OverlayFrame {
        changed,
        empty,
        path: path.to_string_lossy().into_owned(),
        width,
        height,
        stride,
        bands,
    })
}

/// Forget the last frame and delete its files, when the player closes: the
/// next film starts from nothing, and no picture of the page is left behind.
#[tauri::command]
pub fn overlay_reset() {
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    last.pixels = Vec::new();
    let costs = std::mem::take(&mut last.costs);
    if costs.photos > 0 {
        let each = |total: Duration| total.as_secs_f64() * 1000.0 / costs.photos as f64;
        crate::log!(
            "overlay: {} photos, {:.1} ms to take and {:.1} ms to keep each, {:.1} MB written",
            costs.photos,
            each(costs.taking),
            each(costs.keeping),
            costs.written as f64 / 1e6
        );
    }
    for turn in 0..2 {
        let _ = std::fs::remove_file(frame_path(turn));
    }
}

/// Photograph the page as it is now.
#[tauri::command]
pub async fn overlay_frame(window: tauri::WebviewWindow) -> Result<OverlayFrame, String> {
    #[cfg(target_os = "linux")]
    {
        let started = std::time::Instant::now();
        let (width, height, stride, pixels) = linux::snapshot(&window).await?;
        let taken = std::time::Instant::now();
        let frame = store(width, height, stride, pixels);
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        last.costs.photos += 1;
        last.costs.taking += taken - started;
        last.costs.keeping += taken.elapsed();
        frame
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Err("the page is only photographed where mpv has a window of its own".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(alpha: u8, fill: u8) -> Vec<u8> {
        (0..4 * 4).map(|i| if i % 4 == 3 { alpha } else { fill }).collect()
    }

    #[test]
    fn transparent_is_nothing_visible() {
        assert!(nothing_visible(&frame(0, 0)));
        assert!(!nothing_visible(&frame(1, 0)));
        let mut one = frame(0, 0);
        one[7] = 255;
        assert!(!nothing_visible(&one));
    }

    /// One test, because the last frame is shared state.
    #[test]
    fn frames_are_written_only_when_they_change() {
        overlay_reset();
        let first = store(2, 2, 8, frame(255, 10)).unwrap();
        assert!(first.changed && !first.empty);
        assert_eq!(first.bands, vec![Band { y: 0, height: 2, offset: 0 }]);
        assert_eq!(std::fs::read(&first.path).unwrap(), frame(255, 10));

        let again = store(2, 2, 8, frame(255, 10)).unwrap();
        assert!(!again.changed, "the same picture is not written twice");

        let next = store(2, 2, 8, frame(255, 20)).unwrap();
        assert!(next.changed);
        assert_ne!(next.path, first.path, "two files in turn: mpv may still read the last");

        let gone = store(2, 2, 8, frame(0, 0)).unwrap();
        assert!(gone.changed && gone.empty);
        assert!(gone.bands.is_empty());

        // Two bars far apart: only their rows are written, one after the other.
        let bars = store(1, 300, 4, page(300, &[0..10, 200..210])).unwrap();
        assert_eq!(
            bars.bands,
            vec![Band { y: 0, height: 10, offset: 0 }, Band { y: 200, height: 10, offset: 40 }]
        );
        assert_eq!(std::fs::read(&bars.path).unwrap().len(), 80);

        overlay_reset();
        assert!(!std::path::Path::new(&first.path).exists());
        assert!(!std::path::Path::new(&next.path).exists());
    }

    /// A page `rows` tall and one pixel wide, visible on the rows given.
    fn page(rows: usize, visible: &[std::ops::Range<usize>]) -> Vec<u8> {
        (0..rows)
            .flat_map(|y| {
                let alpha = if visible.iter().any(|r| r.contains(&y)) { 255 } else { 0 };
                [1, 2, 3, alpha]
            })
            .collect()
    }

    #[test]
    fn only_the_visible_rows_are_bands() {
        // A top bar and a bottom bar, the film between them.
        let bars = page(1000, &[0..80, 900..1000]);
        assert_eq!(visible_rows(&bars, 4, 1), vec![(0, 80), (900, 100)]);
        // Lines of text closer than the gap are one band.
        let text = page(1000, &[900..920, 940..960, 980..1000]);
        assert_eq!(visible_rows(&text, 4, 1), vec![(900, 100)]);
        assert!(visible_rows(&page(100, &[]), 4, 1).is_empty());
    }

    #[test]
    fn too_many_bands_join_the_closest() {
        // Six spots 200 rows apart, and a seventh 100 rows after the last.
        let mut spots: Vec<_> = (0..6).map(|i| i * 200..i * 200 + 10).collect();
        spots.push(1100..1110);
        let bands = visible_rows(&page(1200, &spots), 4, 1);
        assert_eq!(bands.len(), MAX_BANDS, "{bands:?}");
        assert_eq!(bands.last(), Some(&(1000, 110)), "{bands:?}");
    }

    #[test]
    fn padding_past_the_width_is_not_looked_at() {
        // Stride 8 for a width of 1: the second pixel of the row is padding.
        let pixels = vec![0, 0, 0, 0, 9, 9, 9, 255];
        assert!(visible_rows(&pixels, 8, 1).is_empty());
    }
}
