//! The screens as the desktop has them set up, whichever desktop it is:
//! what the equipment check reads and what display switching changes, on
//! Linux.
//!
//! On Wayland the desktop owns the screens — no program may set a mode, only
//! ask the desktop to — and every desktop is asked its own way: GNOME over
//! D-Bus (`mutter.rs`), KDE Plasma through its own `kscreen-doctor`
//! (`kscreen.rs`). Each answers in its own shape; this is the one shape the
//! rest of Kinema sees. A desktop added later (Sway, Hyprland: wlroots) is a
//! module like those two and a variant here.

use std::sync::OnceLock;

/// One screen, as the desktop has it.
#[derive(Debug, Clone, Default)]
pub struct Screen {
    /// The desktop's name for the output, which is also mpv's
    /// (`display-names`): GNOME says "HDMI-1", KDE "HDMI-A-1".
    pub connector: String,
    /// What the desktop calls the screen, when it says (GNOME does).
    pub display_name: String,
    pub modes: Vec<ScreenMode>,
    pub primary: bool,
    /// `None`: the desktop does not offer HDR on this screen. Otherwise
    /// whether it is on.
    pub hdr: Option<bool>,
    /// GNOME's own colour-mode number, kept so a restore puts back exactly
    /// what was there — sdr-native (2) is neither HDR nor the default.
    pub colour_mode: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct ScreenMode {
    /// The desktop's id for the mode, which is what a change names.
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub refresh: f64,
    pub current: bool,
    pub interlaced: bool,
}

impl Screen {
    pub fn current(&self) -> Option<&ScreenMode> {
        self.modes.iter().find(|m| m.current)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Desktop {
    Gnome,
    Kde,
}

/// The colour change asked of a screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Colour {
    /// HDR on or off.
    Hdr(bool),
    /// GNOME's colour mode exactly as it was (a restore).
    Exactly(u32),
}

/// The desktop that answers, found once per launch: GNOME if Mutter answers
/// on the session bus, else KDE Plasma if this is a Plasma session and its
/// `kscreen-doctor` answers. Not taken from the desktop's name alone — a
/// desktop Kinema cannot actually talk to must not be offered a switch.
pub fn which() -> Option<Desktop> {
    static WHICH: OnceLock<Option<Desktop>> = OnceLock::new();
    *WHICH.get_or_init(|| {
        if crate::mutter::state().is_ok() {
            return Some(Desktop::Gnome);
        }
        if crate::kscreen::is_plasma() {
            match crate::kscreen::screens() {
                Ok(_) => return Some(Desktop::Kde),
                // Said once: a Plasma session that does not answer is not
                // switched for the whole launch.
                Err(e) => crate::log!("display: a Plasma session, but its screens could not be read: {e}"),
            }
        }
        None
    })
}

pub fn screens() -> Result<Vec<Screen>, String> {
    match which() {
        Some(Desktop::Gnome) => crate::mutter::screens(),
        Some(Desktop::Kde) => crate::kscreen::screens(),
        None => Err("this desktop is not one Kinema can ask (GNOME and KDE Plasma so far)".into()),
    }
}

/// Change one screen's mode (by the desktop's mode id) and/or colour; the
/// other screens and everything else about this one stay as they are.
pub fn set(connector: &str, mode_id: Option<&str>, colour: Option<Colour>) -> Result<(), String> {
    match which() {
        Some(Desktop::Gnome) => crate::mutter::set(connector, mode_id, colour),
        Some(Desktop::Kde) => crate::kscreen::set(connector, mode_id, colour),
        None => Err("this desktop is not one Kinema can ask".into()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn mode(id: &str, w: u32, h: u32, refresh: f64, current: bool) -> ScreenMode {
        ScreenMode { id: id.into(), width: w, height: h, refresh, current, interlaced: false }
    }

    /// A TV at 1080p60 that can do HDR, beside a monitor that cannot.
    pub(crate) fn two_screens() -> Vec<Screen> {
        vec![
            Screen {
                connector: "HDMI-1".into(),
                display_name: "Maker TV".into(),
                modes: vec![
                    mode("3840x2160@60.000", 3840, 2160, 60.0, false),
                    mode("3840x2160@23.976", 3840, 2160, 23.976023, false),
                    mode("1920x1080@60.000", 1920, 1080, 60.0, true),
                ],
                primary: true,
                hdr: Some(false),
                colour_mode: Some(0),
            },
            Screen {
                connector: "DP-1".into(),
                display_name: "Desk".into(),
                modes: vec![mode("2560x1440@59.951", 2560, 1440, 59.951, true)],
                primary: false,
                hdr: None,
                colour_mode: None,
            },
        ]
    }
}
