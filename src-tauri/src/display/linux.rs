//! Changing the screen's mode and HDR through the desktop: the Linux side of
//! display.rs.
//!
//! On Wayland only the desktop may change a screen, so this asks it, through
//! `desktop.rs`: GNOME and KDE Plasma so far, each in its own way. Where no
//! desktop Kinema knows answers, switching is not offered at all
//! (`capabilities.rs`).

use super::ScreenNow;
use crate::desktop::{self, Colour, Screen, ScreenMode};
use crate::equipment::linux::{display_from, whole_hz};
use crate::equipment::rate_meaning;

/// Whether a desktop Kinema can ask is running.
pub fn can_switch() -> bool {
    desktop::which().is_some()
}

/// The screen to switch: the one mpv's picture is on (`display-names`, which
/// the player passes), else the desktop's primary one, else any that is on.
pub(crate) fn pick<'a>(screens: &'a [Screen], name: Option<&str>) -> Result<&'a Screen, String> {
    let on = |s: &&Screen| s.current().is_some();
    let named = name.and_then(|n| screens.iter().filter(on).find(|s| s.connector == n));
    let primary = screens.iter().filter(on).find(|s| s.primary);
    named
        .or(primary)
        .or_else(|| screens.iter().find(on))
        .ok_or_else(|| "no screen is switched on".to_string())
}

pub(crate) fn now_of(s: &Screen) -> ScreenNow {
    let d = display_from(None, None, Some(s));
    let exact = s.current().map_or(0.0, |c| c.refresh);
    let hz = whole_hz(exact);
    ScreenNow {
        gdi_name: s.connector.clone(),
        width: d.width,
        height: d.height,
        hz,
        rate: rate_meaning(hz),
        exact_rate: exact,
        // On a desktop that composites every frame, the mode is what goes
        // down the cable; there is no separate signal to read.
        signal: s.current().map(|c| (c.width, c.height, c.refresh)),
        link_bits: None,
        link_encoding: None,
        hdr: d.hdr,
        modes: d.modes,
    }
}

/// The screen as it is now, and GNOME's colour mode on it (kept to put back
/// exactly: it may be sdr-native rather than the default). None on Plasma.
pub fn screen_now(name: Option<&str>) -> Result<(ScreenNow, Option<u32>), String> {
    let screens = desktop::screens()?;
    let s = pick(&screens, name)?;
    Ok((now_of(s), s.colour_mode))
}

/// The mode Windows' `width × height @ hz` stands for: the same size, a rate
/// known by that whole number, the nearest to what it means.
pub(crate) fn mode_for(s: &Screen, width: u32, height: u32, hz: u32) -> Option<&ScreenMode> {
    let meant = rate_meaning(hz);
    s.modes
        .iter()
        .filter(|x| !x.interlaced && (x.width, x.height) == (width, height))
        .filter(|x| whole_hz(x.refresh) == hz)
        .min_by(|a, b| (a.refresh - meant).abs().total_cmp(&(b.refresh - meant).abs()))
}

/// What has to change on `s` to reach `mode` and `colour`: nothing that
/// already is, and no HDR on a screen that has none.
pub(crate) fn needed(
    s: &Screen,
    mode: Option<(u32, u32, u32)>,
    colour: Option<Colour>,
) -> Result<(Option<String>, Option<Colour>), String> {
    let current = s.current().map(|c| c.id.as_str());
    let mode_id = match mode {
        Some((w, h, hz)) => {
            let found = mode_for(s, w, h, hz)
                .ok_or_else(|| format!("{} has no {w}×{h} mode at {hz} Hz", s.connector))?;
            (Some(found.id.as_str()) != current).then(|| found.id.clone())
        }
        None => None,
    };
    let colour = colour.filter(|c| match (*c, s.hdr) {
        (_, None) => false,
        (Colour::Hdr(on), Some(now)) => on != now,
        (Colour::Exactly(n), Some(_)) => s.colour_mode != Some(n),
    });
    Ok((mode_id, colour))
}

/// Set `connector` to `mode` and/or `colour`, leaving alone what already is.
pub fn set(connector: &str, mode: Option<(u32, u32, u32)>, colour: Option<Colour>) -> Result<(), String> {
    let screens = desktop::screens()?;
    let s = screens
        .iter()
        .find(|s| s.connector == connector)
        .ok_or_else(|| format!("{connector} is not connected"))?;
    let (mode_id, colour) = needed(s, mode, colour)?;
    if mode_id.is_none() && colour.is_none() {
        return Ok(());
    }
    desktop::set(connector, mode_id.as_deref(), colour)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::tests::two_screens;

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
        let tv = &s[0];
        assert_eq!(mode_for(tv, 3840, 2160, 23).unwrap().id, "3840x2160@23.976");
        assert_eq!(mode_for(tv, 3840, 2160, 60).unwrap().id, "3840x2160@60.000");
        assert!(mode_for(tv, 3840, 2160, 24).is_none());
        assert!(mode_for(tv, 1280, 720, 60).is_none());
    }

    #[test]
    fn only_what_is_not_already_so_is_changed() {
        let s = two_screens();
        let (tv, desk) = (&s[0], &s[1]);
        // The current mode, HDR off already: nothing to do.
        assert_eq!(needed(tv, Some((1920, 1080, 60)), Some(Colour::Hdr(false))).unwrap(), (None, None));
        let (mode, colour) = needed(tv, Some((3840, 2160, 23)), Some(Colour::Hdr(true))).unwrap();
        assert_eq!((mode.as_deref(), colour), (Some("3840x2160@23.976"), Some(Colour::Hdr(true))));
        // A screen with no HDR is never asked for it.
        assert_eq!(needed(desk, None, Some(Colour::Hdr(true))).unwrap(), (None, None));
        // GNOME's exact colour mode back: sdr-native differs from 0.
        assert_eq!(needed(tv, None, Some(Colour::Exactly(2))).unwrap().1, Some(Colour::Exactly(2)));
        assert!(needed(tv, Some((1280, 720, 60)), None).is_err());
    }

    #[test]
    fn the_screen_now_speaks_windows_numbers() {
        let s = two_screens();
        let now = now_of(&s[0]);
        assert_eq!((now.gdi_name.as_str(), now.width, now.height, now.hz), ("HDMI-1", 1920, 1080, 60));
        assert_eq!(now.modes.len(), 3);
        assert!(now.modes.iter().any(|m| m.hz == 23));
    }

    /// Switches the desktop's real screen to another of its modes and back.
    /// Ignored: it needs a GNOME or Plasma session (a nested GNOME does —
    /// see notes/TEST-SETUP.md) and blanks a real screen for a moment.
    #[test]
    #[ignore]
    fn switches_a_desktops_screen_and_puts_it_back() {
        println!("desktop: {:?}", desktop::which());
        let (before, _) = screen_now(None).unwrap();
        println!("before: {} {}×{}@{} ({:.3})", before.gdi_name, before.width, before.height, before.hz, before.exact_rate);
        // Asking for what already is changes nothing and is not an error.
        set(&before.gdi_name, Some((before.width, before.height, before.hz)), None).unwrap();
        let Some(other) = before.modes.iter().find(|m| (m.width, m.height) != (before.width, before.height)).cloned()
        else {
            println!("only one mode: nothing to switch to");
            return;
        };
        set(&before.gdi_name, Some((other.width, other.height, other.hz)), None).unwrap();
        let (during, _) = screen_now(Some(&before.gdi_name)).unwrap();
        println!("during: {}×{}@{}", during.width, during.height, during.hz);
        set(&before.gdi_name, Some((before.width, before.height, before.hz)), None).unwrap();
        let (after, _) = screen_now(Some(&before.gdi_name)).unwrap();
        println!("after:  {}×{}@{}", after.width, after.height, after.hz);
        assert_eq!((during.width, during.height), (other.width, other.height));
        assert_eq!((after.width, after.height, after.hz), (before.width, before.height, before.hz));
    }
}
