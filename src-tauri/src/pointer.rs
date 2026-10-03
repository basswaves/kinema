//! The mouse on mpv's own window, given back to Kinema's page.
//!
//! Where mpv plays in a window of its own (capabilities `own_window`: Linux),
//! the player's page is hidden behind it and reaches the screen as a picture
//! (overlay.rs), so the mouse lands on mpv's window, not on the page. mpv
//! reports what it does there through a small script (`pointer/mouse.lua`,
//! loaded by `player/engine.ts`), and `pointer_event` does it again on the
//! page — as real mouse input to the web view, not as events made up in
//! JavaScript, so hovering, dragging the seek bar, double clicks and the
//! wheel behave exactly as they do on Windows, through the same handlers.

// Only Linux has a page to give the mouse back to.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

#[cfg(target_os = "linux")]
mod linux;

/// mpv's side: reports each press, release, move and wheel turn on its window.
const SCRIPT: &str = include_str!("pointer/mouse.lua");

/// Write mpv's mouse script into the data folder and say where, for mpv's
/// `load-script`. Written at every start, so it is always this build's.
#[tauri::command]
pub fn pointer_script(app: tauri::AppHandle) -> Result<String, String> {
    let path = crate::data_dir(&app)?.join("kinema-mouse.lua");
    std::fs::write(&path, SCRIPT).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// What the mouse did, at `x`, `y` in the page's own (CSS) pixels.
#[derive(serde::Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PointerKind {
    Move,
    Down,
    Up,
    WheelUp,
    WheelDown,
    Leave,
}

/// Do on the page what the mouse did on mpv's window. `time` is mpv's clock
/// in milliseconds, so two clicks are a double click exactly when they were
/// one on mpv's window; `held` says the left button is down.
#[tauri::command]
pub fn pointer_event(
    window: tauri::WebviewWindow,
    kind: PointerKind,
    x: f64,
    y: f64,
    time: u32,
    held: bool,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        linux::send(&window, kind, x, y, time, held)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, kind, x, y, time, held);
        Err("the mouse is only handed on where mpv has a window of its own".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_are_named_as_the_page_sends_them() {
        let kinds: Vec<PointerKind> =
            serde_json::from_str(r#"["move","down","up","wheel-up","wheel-down","leave"]"#).unwrap();
        assert_eq!(
            kinds,
            [
                PointerKind::Move,
                PointerKind::Down,
                PointerKind::Up,
                PointerKind::WheelUp,
                PointerKind::WheelDown,
                PointerKind::Leave
            ]
        );
    }

    #[test]
    fn the_script_reports_every_kind() {
        for kind in ["move", "down", "up", "wheel-up", "wheel-down", "leave"] {
            assert!(SCRIPT.contains(&format!("\"{kind}\"")), "mouse.lua never reports {kind}");
        }
    }
}
