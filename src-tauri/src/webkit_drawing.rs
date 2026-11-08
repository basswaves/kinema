//! How WebKitGTK draws the page on Linux: with the graphics card, unless this
//! computer showed it cannot.
//!
//! With the graphics card (WebKit's DMA-BUF renderer) browsing is smooth; on
//! the processor a weak computer scrolls at 22–37 frames a second where the
//! card gives 60 (docs/HISTORY.md, "The page drawn with the graphics card").
//! The card's way has one known failure: on some desktops a WebKitGTK window
//! covered by mpv's stops producing the photos the player's controls are drawn
//! from (overlay.rs), because the compositor stops asking it to draw. The
//! processor's way never stops them.
//!
//! So the card is the start, and the photos are watched: when one does not come
//! back while the player is open (`overlay.rs`), that is written down here and
//! every later start on this computer draws on the processor. The film plays on
//! meanwhile, and mpv itself says why the controls are gone.
//!
//! What is written down is tied to what the system answers — WebKitGTK's
//! version, the graphics devices the kernel lists, Wayland or X11 — never to a
//! desktop's or vendor's name: when any of that changes, the card is tried
//! again. `WEBKIT_DISABLE_DMABUF_RENDERER` set outside Kinema is left alone and
//! wins.

// Only Linux chooses; elsewhere the reading below is used by its tests alone.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use serde::Serialize;
use std::path::PathBuf;
use std::sync::OnceLock;

/// In Kinema's data folder: `processor`, the system it was found on, and when.
const FILE: &str = "webkit-drawing.txt";
const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// How this start draws, as `webkit_drawing` reports it to the page.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Drawing {
    /// `card`, `processor` (Kinema's fallback), `given` (set outside Kinema),
    /// or `none` where WebKitGTK is not the page's engine.
    pub mode: &'static str,
    /// For `processor`: when the photos stopped (Unix seconds), if known.
    pub since: Option<u64>,
    /// For `given`: the value found.
    pub value: Option<String>,
    /// This start's photos stopped: from the next start the processor draws.
    pub stopped_now: bool,
}

static CHOSEN: OnceLock<Drawing> = OnceLock::new();
/// What `choose` decided, said once the log is open (`say_choice`): it runs
/// before there is a log to write to.
static SAID: OnceLock<String> = OnceLock::new();
static STOPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `<data>/com.kinema.app`, as Tauri's app data folder is on Linux — or the
/// self-test's own data folder, so a test never writes the real one. Read
/// before Tauri exists, so it is worked out here.
fn data_dir() -> Option<PathBuf> {
    if let Some(plan) = crate::selftest::plan_path() {
        return Some(crate::selftest::data_dir_for(&plan));
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join("com.kinema.app"))
}

/// What the system answers about how the page is drawn, as one line.
#[cfg(target_os = "linux")]
fn system() -> String {
    // SAFETY: plain getters of the library's own version numbers.
    let webkit = unsafe {
        use webkit2gtk::ffi::*;
        format!("{}.{}.{}", webkit_get_major_version(), webkit_get_minor_version(), webkit_get_micro_version())
    };
    format!("webkitgtk {webkit}; {}; {}", session(), gpus())
}

/// Wayland or X11, as GTK will choose: Wayland when there is one, unless GTK
/// is told otherwise.
#[cfg(target_os = "linux")]
fn session() -> &'static str {
    let forced_x11 = std::env::var("GDK_BACKEND").is_ok_and(|b| b.trim().starts_with("x11"));
    if std::env::var_os("WAYLAND_DISPLAY").is_some() && !forced_x11 {
        "wayland"
    } else {
        "x11"
    }
}

/// The graphics devices the kernel lists, as PCI vendor:device numbers.
#[cfg(target_os = "linux")]
fn gpus() -> String {
    let mut ids: Vec<String> = std::fs::read_dir("/sys/class/drm")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            // card0, not card0-HDMI-A-1 (a connector).
            if !name.starts_with("card") || name.contains('-') {
                return None;
            }
            let read = |f: &str| std::fs::read_to_string(e.path().join("device").join(f)).ok();
            Some(format!("{}:{}", read("vendor")?.trim(), read("device")?.trim()))
        })
        .collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        "no graphics devices listed".into()
    } else {
        ids.join(",")
    }
}

/// The remembered fallback, if it was found on this same system: when it was.
fn remembered(text: &str, system: &str) -> Option<u64> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "processor" || lines.next()?.trim() != system {
        return None;
    }
    Some(lines.next().and_then(|l| l.trim().parse().ok()).unwrap_or(0))
}

/// Decide, before any window exists. Linux only; elsewhere there is nothing
/// to choose.
#[cfg(target_os = "linux")]
pub fn choose() {
    let drawing = if let Some(value) = std::env::var_os(VAR) {
        let _ = SAID.set(format!("webkit drawing: {VAR}={} set outside Kinema", value.to_string_lossy()));
        Drawing {
            mode: "given",
            since: None,
            value: Some(value.to_string_lossy().into_owned()),
            stopped_now: false,
        }
    } else {
        let system = system();
        let file = data_dir().map(|d| d.join(FILE));
        let found = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok());
        match found.as_deref().map(|t| (t, remembered(t, &system))) {
            Some((_, Some(since))) => {
                std::env::set_var(VAR, "1");
                let _ = SAID.set(format!("webkit drawing: processor, as remembered since {since} on {system}"));
                Drawing { mode: "processor", since: Some(since), value: None, stopped_now: false }
            }
            other => {
                if let (Some((_, None)), Some(f)) = (other, &file) {
                    // Written on another system: the card is tried again.
                    let _ = std::fs::remove_file(f);
                    let _ = SAID.set(format!("webkit drawing: the fallback was for another system; trying the graphics card on {system}"));
                } else {
                    let _ = SAID.set(format!("webkit drawing: graphics card on {system}"));
                }
                Drawing { mode: "card", since: None, value: None, stopped_now: false }
            }
        }
    };
    let _ = CHOSEN.set(drawing);
}

/// Write `choose`'s decision to app.log, once the log is open.
pub fn say_choice() {
    if let Some(line) = SAID.get() {
        crate::log!("{line}");
    }
}

/// Whether this start draws with the card: only then can the photos stop.
pub fn with_card() -> bool {
    CHOSEN.get().is_some_and(|d| d.mode == "card")
}

/// The photos stopped while the player covered the page: draw on the
/// processor from the next start. Once per start; true the first time.
pub fn photos_stopped(waited: std::time::Duration) -> bool {
    if !with_card() || STOPPED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        let system = system();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let written = data_dir().map(|d| {
            std::fs::create_dir_all(&d)
                .and_then(|_| std::fs::write(d.join(FILE), format!("processor\n{system}\n{now}\n")))
        });
        crate::log!(
            "webkit drawing: no photo of the page for {} ms while the player covered it; \
             the processor draws from the next start ({}), on {system}",
            waited.as_millis(),
            match written {
                Some(Ok(())) => "remembered".to_string(),
                Some(Err(e)) => format!("could not be written down: {e}"),
                None => "no data folder to write it in".to_string(),
            }
        );
    }
    #[cfg(not(target_os = "linux"))]
    let _ = waited;
    true
}

/// How the page is drawn on this start, for the stats and Settings.
#[tauri::command]
pub fn webkit_drawing() -> Drawing {
    let mut drawing = CHOSEN.get().cloned().unwrap_or(Drawing {
        mode: "none",
        since: None,
        value: None,
        stopped_now: false,
    });
    drawing.stopped_now = STOPPED.load(std::sync::atomic::Ordering::SeqCst);
    drawing
}

/// The refresh rate of the screen Kinema's window is on, in Hz, as GTK has
/// it from the display server (Wayland's output mode, X11's RandR): any
/// desktop, no desktop's own interface. For the Look check (lightLook.ts),
/// which cannot tell a screen's pace from frame gaps where the page is drawn
/// unevenly. None where GTK is not the page's toolkit or does not know.
#[tauri::command]
pub async fn page_screen_hz(window: tauri::WebviewWindow) -> Option<f64> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let (tx, rx) = tokio::sync::oneshot::channel::<Option<i32>>();
        window
            .with_webview(move |webview| {
                let view = webview.inner();
                let millihertz = view
                    .window()
                    .and_then(|w| view.display().monitor_at_window(&w))
                    .map(|m| m.refresh_rate());
                let _ = tx.send(millihertz);
            })
            .ok()?;
        let millihertz = rx.await.ok()??;
        (millihertz > 0).then(|| f64::from(millihertz) / 1000.0)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fallback_counts_only_on_the_system_it_was_found_on() {
        let system = "webkitgtk 2.54.2; wayland; 0x8086:0x5902";
        let text = format!("processor\n{system}\n1762600000\n");
        assert_eq!(remembered(&text, system), Some(1762600000));
        assert_eq!(remembered(&text, "webkitgtk 2.56.0; wayland; 0x8086:0x5902"), None);
        assert_eq!(remembered(&text, "webkitgtk 2.54.2; x11; 0x8086:0x5902"), None);
        assert_eq!(remembered("card\n", system), None);
        assert_eq!(remembered("", system), None);
        // An unreadable time still counts: the system matched.
        assert_eq!(remembered(&format!("processor\n{system}\n"), system), Some(0));
    }

    /// One test, because what was chosen is one value per process.
    #[test]
    fn stopped_photos_are_remembered_once_and_only_with_the_card() {
        // Nothing chosen yet: no start happened, so nothing to fall back from.
        assert!(!with_card());
        assert!(!photos_stopped(std::time::Duration::from_secs(3)));
        assert_eq!(webkit_drawing().mode, "none");

        let dir = std::env::temp_dir().join(format!("kinema-webkit-drawing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("XDG_DATA_HOME", &dir);
        let _ = CHOSEN.set(Drawing { mode: "card", since: None, value: None, stopped_now: false });
        assert!(photos_stopped(std::time::Duration::from_secs(3)), "the first stop is remembered");
        assert!(!photos_stopped(std::time::Duration::from_secs(3)), "and only once a start");
        assert!(webkit_drawing().stopped_now);
        #[cfg(target_os = "linux")]
        {
            let text = std::fs::read_to_string(dir.join("com.kinema.app").join(FILE)).unwrap();
            assert!(remembered(&text, &system()).is_some(), "{text}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
