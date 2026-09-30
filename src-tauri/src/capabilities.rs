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
    /// Screens and audio outputs can be examined (Settings → Equipment).
    pub equipment_detection: bool,
    /// The screen's refresh rate, resolution and HDR can be switched.
    pub display_switching: bool,
    pub sleep: bool,
    pub shut_down: bool,
}

pub fn current() -> Capabilities {
    Capabilities {
        system: system_name(),
        engine: "mpv",
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
    }

    /// Elsewhere, nothing is claimed that has no implementation behind it.
    #[cfg(not(windows))]
    #[test]
    fn nothing_is_claimed_without_an_implementation() {
        let c = current();
        assert!(!c.equipment_detection && !c.display_switching && !c.sleep && !c.shut_down);
    }
}
