//! What this build of Kinema can do on the system it runs on.
//!
//! The interface asks this, once, and shows or hides what depends on it. It
//! never asks which system it is on: a question like "can this switch the
//! refresh rate?" stays right when a second system learns to, where "is this
//! Windows?" would have to be found and changed everywhere it was asked.
//!
//! Each answer comes from the module that does the work, stated beside its own
//! code (`equipment::DETECTS`, `display::switches`, `power::can_*`), so adding
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
    /// Sound can be sent straight to the receiver, passing through the
    /// formats the equipment check found (Settings → Sound).
    pub audio_direct: bool,
    /// The screen's refresh rate, resolution and HDR can be switched.
    pub display_switching: bool,
    /// Kinema runs in a window on a desktop, so it may be used at a desk as
    /// well as on a TV. Where it does not — Android, where an app is the whole
    /// screen of a TV box — it is always the TV layout and never asks.
    pub windowed: bool,
    /// The system has a folder picker of its own. Where it has none (Android
    /// TV boxes, often), Kinema shows the folders itself (places.rs).
    pub folder_picker: bool,
    /// The system itself turns HDR on for an HDR film and passes sound to a
    /// receiver untouched where it can (Android, through Media3). Kinema then
    /// only matches the screen's mode to the film, with one switch, and asks
    /// nothing per device; `display_switching` and `audio_direct`, Kinema's
    /// own way of doing both, stay off.
    pub system_output: bool,
    /// Kinema can run programs the user installed themselves — ffmpeg and
    /// ffprobe for intro detection and a title's picture and sound details,
    /// Skiptro for intros. An Android app cannot run another program, so
    /// there nothing offers them.
    pub runs_programs: bool,
    /// The system puts its own keyboard on screen whenever a text field takes
    /// typing (Android). Kinema then lets a field take typing without it, and
    /// opens it only when OK is pressed on the field (ui/typing.ts).
    pub screen_keyboard: bool,
    /// The system can show a folder in a file manager (the log folder, the
    /// safety copies). A TV box has nothing to show one in.
    pub opens_folders: bool,
    /// The system can hand a file to another app through its share sheet
    /// (Android): the log goes to a bug report that way (StoragePlugin.kt).
    pub shares_files: bool,
    /// Kinema opens network shares itself (netshare.rs), because the system
    /// does not open them for it (Android): the folder browser offers the
    /// network, and Settings lists the sign-ins it keeps.
    pub network_shares: bool,
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
/// until a port has a reason to name one. Android has no mpv; its player draws
/// beneath the page as mpv does on Windows, so there is no window of its own
/// and nothing to photograph the page for (overlay.rs).
fn mpv_video() -> MpvVideo {
    if cfg!(windows) {
        MpvVideo { gpu_api: "d3d11", hwdec: "d3d11va", own_window: false }
    } else {
        MpvVideo { gpu_api: "auto", hwdec: "auto-safe", own_window: cfg!(desktop) }
    }
}

/// Worked out once per launch: on Linux it asks the desktop over D-Bus
/// (`display::switches`), which is quick but not free, and the answer does
/// not change while Kinema runs.
pub fn current() -> Capabilities {
    static ONCE: std::sync::OnceLock<Capabilities> = std::sync::OnceLock::new();
    ONCE.get_or_init(work_out).clone()
}

fn work_out() -> Capabilities {
    Capabilities {
        system: system_name(),
        engine: crate::engine::NAME,
        mpv_video: mpv_video(),
        equipment_detection: crate::equipment::DETECTS,
        audio_direct: crate::equipment::DIRECT_AUDIO,
        display_switching: crate::display::switches(),
        windowed: cfg!(desktop),
        folder_picker: cfg!(desktop),
        system_output: cfg!(target_os = "android"),
        runs_programs: cfg!(desktop),
        screen_keyboard: cfg!(mobile),
        opens_folders: cfg!(desktop),
        shares_files: cfg!(target_os = "android"),
        network_shares: cfg!(target_os = "android"),
        sleep: crate::power::can_sleep(),
        shut_down: crate::power::can_shut_down(),
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
        assert!(c.equipment_detection && c.audio_direct && c.display_switching && c.sleep && c.shut_down);
        assert!(c.windowed && c.folder_picker && !c.system_output && c.runs_programs);
        assert!(!c.screen_keyboard && c.opens_folders && !c.shares_files && !c.network_shares);
        // The rendering path the whole of docs/DESIGN.md is written about.
        assert_eq!(
            c.mpv_video,
            MpvVideo { gpu_api: "d3d11", hwdec: "d3d11va", own_window: false }
        );
    }

    /// Elsewhere, nothing is claimed that has no implementation behind it.
    /// Linux has the equipment check (equipment/linux.rs), direct sound
    /// (audio_reserve.rs), and switching where the desktop is one Kinema can
    /// ask (display/linux.rs) — which depends on where the test runs.
    #[cfg(not(windows))]
    #[test]
    fn nothing_is_claimed_without_an_implementation() {
        let c = current();
        let linux = cfg!(target_os = "linux");
        assert_eq!((c.equipment_detection, c.audio_direct), (linux, linux));
        assert_eq!(c.display_switching, crate::display::switches());
        // A desktop has windows; Android, the other system here, does not.
        assert_eq!((c.windowed, c.folder_picker), (cfg!(desktop), cfg!(desktop)));
        assert_eq!(c.system_output, cfg!(target_os = "android"));
        assert_eq!(c.runs_programs, cfg!(desktop));
        assert_eq!(c.screen_keyboard, cfg!(mobile));
        assert_eq!((c.opens_folders, c.shares_files), (cfg!(desktop), cfg!(target_os = "android")));
        assert_eq!(c.network_shares, cfg!(target_os = "android"));
        // Wherever logind says this session may (power.rs); never elsewhere.
        assert_eq!((c.sleep, c.shut_down), (crate::power::can_sleep(), crate::power::can_shut_down()));
        if !linux {
            assert!(!c.sleep && !c.shut_down);
        }
    }
}
