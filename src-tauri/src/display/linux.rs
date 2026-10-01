//! Changing the screen's mode and HDR through the desktop: the Linux side of
//! display.rs.
//!
//! On Wayland only the desktop may change a screen, so this asks it. GNOME is
//! the one desktop asked so far (`mutter.rs`); KDE Plasma and the wlroots
//! desktops each get a variant of [`Desktop`] and a module of their own when
//! they are added (notes: PORTING, "other desktops"). Where none answers,
//! switching is not offered at all (`capabilities.rs`).
//!
//! Every change is made as a *temporary* configuration: GNOME does not save
//! it, so the desktop's own setup comes back at the next login whatever
//! becomes of Kinema — on top of display.rs putting it back itself.

use super::ScreenNow;
use crate::equipment::linux::{display_from, whole_hz};
use crate::equipment::rate_meaning;
use crate::mutter::{self, Change, Monitor, MonitorMode, State};

/// The desktops Kinema can ask to change a screen.
pub enum Desktop {
    Gnome,
}

/// The desktop that answers, if any. Asked once, at startup, for the
/// capabilities.
pub fn desktop() -> Option<Desktop> {
    mutter::state().ok().map(|_| Desktop::Gnome)
}

/// The screen to switch: the one mpv's picture is on (`display-names`, which
/// the player passes), else the desktop's primary one, else any that is on.
pub(crate) fn pick<'a>(state: &'a State, screen: Option<&str>) -> Result<&'a Monitor, String> {
    let on = |m: &&Monitor| m.current().is_some();
    let named = screen.and_then(|s| state.monitors.iter().filter(on).find(|m| m.connector == s));
    let primary = state
        .logical
        .iter()
        .find(|l| l.primary)
        .and_then(|l| l.connectors.first())
        .and_then(|c| state.monitors.iter().filter(on).find(|m| &m.connector == c));
    named
        .or(primary)
        .or_else(|| state.monitors.iter().find(on))
        .ok_or_else(|| "no screen is switched on".to_string())
}

pub(crate) fn now_of(m: &Monitor) -> ScreenNow {
    let d = display_from(None, None, Some(m));
    let exact = m.current().map_or(0.0, |c| c.refresh);
    let hz = whole_hz(exact);
    ScreenNow {
        gdi_name: m.connector.clone(),
        width: d.width,
        height: d.height,
        hz,
        rate: rate_meaning(hz),
        exact_rate: exact,
        // On a desktop that composites every frame, the mode is what goes
        // down the cable; there is no separate signal to read.
        signal: m.current().map(|c| (c.width, c.height, c.refresh)),
        link_bits: None,
        link_encoding: None,
        hdr: d.hdr,
        modes: d.modes,
    }
}

/// The screen as it is now, and its colour mode (kept to put back exactly:
/// it may be GNOME's sdr-native rather than the default).
pub fn screen_now(screen: Option<&str>) -> Result<(ScreenNow, Option<u32>), String> {
    let state = mutter::state()?;
    let m = pick(&state, screen)?;
    Ok((now_of(m), m.color_mode))
}

/// The mode Windows' `width × height @ hz` stands for: the same size, a rate
/// known by that whole number, the nearest to what it means.
pub(crate) fn mode_for(m: &Monitor, width: u32, height: u32, hz: u32) -> Option<&MonitorMode> {
    let meant = rate_meaning(hz);
    m.modes
        .iter()
        .filter(|x| !x.interlaced && (x.width, x.height) == (width, height))
        .filter(|x| whole_hz(x.refresh) == hz)
        .min_by(|a, b| (a.refresh - meant).abs().total_cmp(&(b.refresh - meant).abs()))
}

/// Set `connector` to `mode` and/or `colour`, leaving alone what already is.
pub fn set(connector: &str, mode: Option<(u32, u32, u32)>, colour: Option<u32>) -> Result<(), String> {
    let state = mutter::state()?;
    let m = state
        .monitors
        .iter()
        .find(|m| m.connector == connector)
        .ok_or_else(|| format!("{connector} is not connected"))?;
    let current = m.current().map(|c| c.id.clone());
    let mode_id = match mode {
        Some((w, h, hz)) => {
            let found = mode_for(m, w, h, hz)
                .ok_or_else(|| format!("{connector} has no {w}×{h} mode at {hz} Hz"))?;
            (Some(&found.id) != current.as_ref()).then(|| found.id.clone())
        }
        None => None,
    };
    let colour = colour.filter(|c| m.color_mode != Some(*c) && m.supported_color_modes.contains(c));
    if mode_id.is_none() && colour.is_none() {
        return Ok(());
    }
    mutter::apply(&state, &Change { connector: connector.into(), mode_id, color_mode: colour })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mutter::tests::two_screens;

    #[test]
    fn the_screen_mpv_is_on_wins_then_the_primary() {
        let s = two_screens();
        assert_eq!(pick(&s, Some("DP-1")).unwrap().connector, "DP-1");
        assert_eq!(pick(&s, None).unwrap().connector, "HDMI-1");
        // A name mpv gave that the desktop does not know: the primary.
        assert_eq!(pick(&s, Some("HDMI-9")).unwrap().connector, "HDMI-1");
    }

    #[test]
    fn whole_number_rates_find_the_mode_they_mean() {
        let s = two_screens();
        let tv = &s.monitors[0];
        assert_eq!(mode_for(tv, 3840, 2160, 23).unwrap().id, "3840x2160@23.976");
        assert_eq!(mode_for(tv, 3840, 2160, 60).unwrap().id, "3840x2160@60.000");
        assert!(mode_for(tv, 3840, 2160, 24).is_none());
        assert!(mode_for(tv, 1280, 720, 60).is_none());
    }

    /// Switches the desktop's real screen to another of its modes and back,
    /// through GNOME. Ignored: it needs a GNOME session (a nested one does —
    /// see notes/TEST-SETUP.md) and blanks a real screen for a moment.
    #[test]
    #[ignore]
    fn switches_a_gnome_screen_and_puts_it_back() {
        let (before, _) = screen_now(None).unwrap();
        println!("before: {} {}×{}@{} ({:.3})", before.gdi_name, before.width, before.height, before.hz, before.exact_rate);
        let other = before
            .modes
            .iter()
            .find(|m| (m.width, m.height) != (before.width, before.height))
            .expect("a second mode to switch to")
            .clone();
        set(&before.gdi_name, Some((other.width, other.height, other.hz)), None).unwrap();
        let (during, _) = screen_now(Some(&before.gdi_name)).unwrap();
        println!("during: {}×{}@{}", during.width, during.height, during.hz);
        set(&before.gdi_name, Some((before.width, before.height, before.hz)), None).unwrap();
        let (after, _) = screen_now(Some(&before.gdi_name)).unwrap();
        println!("after:  {}×{}@{}", after.width, after.height, after.hz);
        assert_eq!((during.width, during.height), (other.width, other.height));
        assert_eq!((after.width, after.height, after.hz), (before.width, before.height, before.hz));
        // Asking for what already is changes nothing and is not an error.
        set(&before.gdi_name, Some((before.width, before.height, before.hz)), None).unwrap();
    }

    #[test]
    fn the_screen_now_speaks_windows_numbers() {
        let s = two_screens();
        let now = now_of(&s.monitors[0]);
        assert_eq!((now.gdi_name.as_str(), now.width, now.height, now.hz), ("HDMI-1", 1920, 1080, 60));
        assert_eq!(now.modes.len(), 3);
        assert!(now.modes.iter().any(|m| m.hz == 23));
    }
}
