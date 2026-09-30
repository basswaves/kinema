//! What this build of Kinema can do on the system it runs on.
//!
//! The interface asks this, once, and shows or hides what depends on it. It
//! never asks which system it is on: a question like "can this switch the
//! refresh rate?" stays right when a second system learns to, where "is this
//! Windows?" would have to be found and changed everywhere it was asked.
//!
//! Each answer comes from the module that does the work, stated beside its own
//! code (`equipment::DETECTS`, `display::SWITCHES`, `power::CAN_*`), so adding
//! a platform's implementation and saying it exists happen in the same place.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Capabilities {
    /// The system's name, for text shown to people ("through the Windows
    /// mixer"). Never for deciding anything — that is what the rest is for.
    pub system: &'static str,
    /// Which player engine plays the films.
    pub engine: &'static str,
    /// How mpv reaches the graphics card on this system.
    pub mpv_video: MpvVideo,
    /// Screens and audio outputs can be examined (Settings → Equipment).
    pub equipment_detection: bool,
    /// The screen's refresh rate, resolution and HDR can be switched.
    pub display_switching: bool,
    pub sleep: bool,
    pub shut_down: bool,
}

/// mpv's `gpu-api` and `hwdec`, which name the system's own graphics
/// interface and so cannot be the same everywhere. Both abort mpv's start if
/// refused, so each system gets only what it has.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct MpvVideo {
    pub gpu_api: &'static str,
    pub hwdec: &'static str,
    /// mpv shows the video in a full-screen window of its own, open only
    /// while something plays, instead of beneath Kinema's transparent page.
    /// On Linux the page cannot be put over mpv any other way: Wayland has
    /// no `--wid`, and a second window cannot be kept above mpv's
    /// (docs/GOTCHAS.md). The controls then reach the screen through mpv.
    pub own_window: bool,
}

/// On Windows, d3d11 and d3d11va: the vendor-neutral path, the same on
/// NVIDIA, AMD and Intel (docs/DESIGN.md). Elsewhere mpv chooses for itself —
/// Vulkan or OpenGL, and only the hardware decoders it knows to be safe —
/// until a port has a reason to name one.
fn mpv_video() -> MpvVideo {
    if cfg!(windows) {
        MpvVideo { gpu_api: "d3d11", hwdec: "d3d11va", own_window: false }
    } else {
        MpvVideo { gpu_api: "auto", hwdec: "auto-safe", own_window: true }
    }
}

pub fn current() -> Capabilities {
    Capabilities {
        system: system_name(),
        engine: "mpv",
        mpv_video: mpv_video(),
        equipment_detection: crate::equipment::DETECTS,
        display_switching: crate::display::SWITCHES,
        sleep: crate::power::CAN_SLEEP,
        shut_down: crate::power::CAN_SHUT_DOWN,
    }
}

fn system_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "linux" => "Linux",
        "macos" => "macOS",
        "android" => "Android",
        _ => "this system",
    }
}

#[tauri::command]
pub fn capabilities() -> Capabilities {
    current()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows is the platform everything is built on; nothing may go missing
    /// there because a port declared something wrongly.
    #[cfg(windows)]
    #[test]
    fn windows_can_do_everything() {
        let c = current();
        assert_eq!(c.system, "Windows");
        assert!(c.equipment_detection && c.display_switching && c.sleep && c.shut_down);
        // The rendering path the whole of docs/DESIGN.md is written about.
        assert_eq!(
            c.mpv_video,
            MpvVideo { gpu_api: "d3d11", hwdec: "d3d11va", own_window: false }
        );
    }

    /// Elsewhere, nothing is claimed that has no implementation behind it.
    #[cfg(not(windows))]
    #[test]
    fn nothing_is_claimed_without_an_implementation() {
        let c = current();
        assert!(!c.equipment_detection && !c.display_switching && !c.sleep && !c.shut_down);
    }
}
