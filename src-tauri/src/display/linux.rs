//! Changing the screen's mode and HDR through the desktop: the Linux side of
//! display.rs.
//!
//! On Wayland only the desktop may change a screen, so this asks it, through
//! `desktop.rs`: GNOME, Cinnamon, KDE Plasma and the wlroots desktops, each
//! in its own way. Where no
//! desktop Kinema knows answers, switching is not offered at all
//! (`capabilities.rs`).

use super::ScreenNow;
use crate::desktop::{self, Colour, Screen, ScreenMode};
use crate::equipment::linux::{display_from, whole_hz};
use crate::equipment::{rate_meaning, HdrState};

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
    let mut d = display_from(None, None, Some(s));
    // No EDID is at hand here, so a desktop that does not report HDR
    // (Hyprland, which switches it by itself) leaves it not known — which
    // keeps mpv's colour-space hint on, and that hint is what tells such a
    // desktop the film is HDR.
    if s.hdr_unreported {
        d.hdr = HdrState::Unknown;
    }
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

/// Kinema's window as it was when the player first floated it — full screen,
/// decorated — kept until the player closes; and whether it floats now.
struct Fitted {
    was_fullscreen: bool,
    was_decorated: bool,
    floating: bool,
}

static FITTED: std::sync::Mutex<Option<Fitted>> = std::sync::Mutex::new(None);

/// `display::player_window` on a wlroots desktop. `float`: Kinema's window at
/// the screen's size, fixed (hidden and shown again so the desktop sees a
/// new, fixed-size window, which it floats); `tile`: an ordinary window
/// again, as the film leaves full screen — but not full screen itself, which
/// would cover the windowed film; `close`: as it was before the player,
/// full screen included.
pub fn player_window(window: &tauri::WebviewWindow, how: &str) -> Result<(), String> {
    let mut fitted = FITTED.lock().map_err(|e| e.to_string())?;
    let err = |e: tauri::Error| format!("Kinema's window: {e}");
    match how {
        "float" => {
            if fitted.as_ref().is_some_and(|f| f.floating) {
                return Ok(());
            }
            let monitor = window.current_monitor().map_err(err)?.ok_or("no screen for Kinema's window")?;
            let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
            let before = fitted.take().unwrap_or(Fitted {
                was_fullscreen: window.is_fullscreen().unwrap_or(false),
                was_decorated: window.is_decorated().unwrap_or(true),
                floating: false,
            });
            window.hide().map_err(err)?;
            if window.is_fullscreen().unwrap_or(false) {
                window.set_fullscreen(false).map_err(err)?;
            }
            // Without its title bar and the invisible shadow margins GTK draws
            // round a decorated window, the page is the size asked for:
            // decorated, a nested Sway gave it 1560×860 of a 1600×900 screen,
            // less the bar.
            window.set_decorations(false).map_err(err)?;
            window.set_size(size).map_err(err)?;
            window.set_min_size(Some(size)).map_err(err)?;
            window.set_max_size(Some(size)).map_err(err)?;
            window.set_resizable(false).map_err(err)?;
            window.show().map_err(err)?;
            *fitted = Some(Fitted { floating: true, ..before });
            crate::log!("display: Kinema's window floated at {}×{} for the player", size.width, size.height);
        }
        "tile" | "close" => {
            let Some(before) = fitted.take() else { return Ok(()) };
            if before.floating {
                window.hide().map_err(err)?;
                window.set_decorations(before.was_decorated).map_err(err)?;
                window.set_resizable(true).map_err(err)?;
                window.set_min_size(None::<tauri::Size>).map_err(err)?;
                window.set_max_size(None::<tauri::Size>).map_err(err)?;
                window.show().map_err(err)?;
            }
            if how == "close" {
                if before.was_fullscreen {
                    window.set_fullscreen(true).map_err(err)?;
                }
                crate::log!("display: Kinema's window back as it was");
            } else {
                *fitted = Some(Fitted { floating: false, ..before });
                crate::log!("display: Kinema's window tiled again beside the windowed film");
            }
        }
        other => return Err(format!("player_window: no such request '{other}'")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::tests::two_screens;

    #[test]
    fn a_desktop_that_does_not_report_hdr_keeps_the_hint_on() {
        // Hyprland: no HDR state from the desktop and no EDID here, so the
        // player is told "not known" (colour-space hint on), never "SDR".
        let mut s = two_screens().remove(1);
        s.hdr_unreported = true;
        assert_eq!(now_of(&s).hdr, HdrState::Unknown);
        s.hdr_unreported = false;
        assert_eq!(now_of(&s).hdr, HdrState::Unsupported);
    }

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

    /// Switches the desktop's real screen to another of its modes and back,
    /// then to another rate at the same size and back. Ignored: it needs a
    /// GNOME, Cinnamon or Plasma session (a nested GNOME does — see
    /// notes/TEST-SETUP.md; for Cinnamon, Muffin on a dummy-driver X server,
    /// see CONTRIBUTING) and blanks a real screen for a moment.
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
        // What a film asks for: another rate at the same size (60 → 24).
        let same_size = |m: &&crate::equipment::Mode| (m.width, m.height) == (before.width, before.height);
        let Some(rate) = before.modes.iter().filter(same_size).find(|m| m.hz != before.hz).cloned() else {
            println!("one rate at this size: no rate change to try");
            return;
        };
        set(&before.gdi_name, Some((rate.width, rate.height, rate.hz)), None).unwrap();
        let (during, _) = screen_now(Some(&before.gdi_name)).unwrap();
        println!("rate:   {}×{}@{}", during.width, during.height, during.hz);
        set(&before.gdi_name, Some((before.width, before.height, before.hz)), None).unwrap();
        let (after, _) = screen_now(Some(&before.gdi_name)).unwrap();
        println!("after:  {}×{}@{}", after.width, after.height, after.hz);
        assert_eq!(during.hz, rate.hz);
        assert_eq!((after.width, after.height, after.hz), (before.width, before.height, before.hz));
    }
}
