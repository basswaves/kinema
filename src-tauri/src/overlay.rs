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

// Only Linux photographs the page; elsewhere the frame keeping below is used
// by its tests alone. Linux's clippy still reports anything genuinely unused.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(target_os = "linux")]
mod linux;

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
}

struct Last {
    pixels: Vec<u8>,
    turn: usize,
}

static LAST: Mutex<Last> = Mutex::new(Last { pixels: Vec::new(), turn: 0 });

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

/// Keep a frame: compare it with the last, and write it if it differs.
fn store(width: i32, height: i32, stride: i32, pixels: Vec<u8>) -> Result<OverlayFrame, String> {
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let changed = last.pixels != pixels;
    let empty = nothing_visible(&pixels);
    if changed && !empty {
        last.turn = 1 - last.turn;
    }
    let path = frame_path(last.turn);
    if changed && !empty {
        std::fs::write(&path, &pixels).map_err(crate::util::to_string_err)?;
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
    })
}

/// Forget the last frame and delete its files, when the player closes: the
/// next film starts from nothing, and no picture of the page is left behind.
#[tauri::command]
pub fn overlay_reset() {
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    last.pixels = Vec::new();
    for turn in 0..2 {
        let _ = std::fs::remove_file(frame_path(turn));
    }
}

/// Photograph the page as it is now.
#[tauri::command]
pub async fn overlay_frame(window: tauri::WebviewWindow) -> Result<OverlayFrame, String> {
    #[cfg(target_os = "linux")]
    {
        let (width, height, stride, pixels) = linux::snapshot(&window).await?;
        store(width, height, stride, pixels)
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
        assert_eq!(std::fs::read(&first.path).unwrap(), frame(255, 10));

        let again = store(2, 2, 8, frame(255, 10)).unwrap();
        assert!(!again.changed, "the same picture is not written twice");

        let next = store(2, 2, 8, frame(255, 20)).unwrap();
        assert!(next.changed);
        assert_ne!(next.path, first.path, "two files in turn: mpv may still read the last");

        let gone = store(2, 2, 8, frame(0, 0)).unwrap();
        assert!(gone.changed && gone.empty);

        overlay_reset();
        assert!(!std::path::Path::new(&first.path).exists());
        assert!(!std::path::Path::new(&next.path).exists());
    }
}
