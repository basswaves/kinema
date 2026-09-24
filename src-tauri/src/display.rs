//! Switching the screen to suit the film — step 4 of the native-output plan.
//!
//! Three things can change, each behind its own switch in Settings and only
//! while the player is fullscreen (a mode change is a whole-desktop change,
//! and in a window the picture is scaled to the window anyway): the refresh
//! rate, the resolution, and Windows' HDR. The frontend decides *what* to
//! switch to (`player/displayMode.ts`); this only does it, and undoes it.
//!
//! **Undoing is the part that matters.** A screen left at 23.976 Hz 1080p
//! after the app has gone is the failure people remember. So the mode before
//! the first change is saved to the settings table *before* anything is
//! changed, restored when the player closes or the app exits, and — if the app
//! died in between — at the next launch. The mode change itself is made with
//! `CDS_FULLSCREEN`, which never writes the registry: Windows' own idea of the
//! desktop mode is never touched, and resetting to it is how the mode is put
//! back.

use serde::{Deserialize, Serialize};

use crate::equipment::{HdrState, Mode};

/// Settings key for [`Original`].
pub const RESTORE_KEY: &str = "display_restore";

/// Switches and restores take turns. Leaving fullscreen and then the player
/// asks for a restore twice, a second apart; on the test TV the second arrived
/// while the first was still turning HDR off, found the record not yet
/// cleared, and did it all again (two "restored" lines in the same second).
/// Holding this for the whole of each, the second finds nothing to do.
static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The screen as it is right now.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ScreenNow {
    pub gdi_name: String,
    pub width: u32,
    pub height: u32,
    /// As Windows lists it: 23 for 23.976.
    pub hz: u32,
    pub rate: f64,
    /// The rate the display is really running at, from `QueryDisplayConfig`
    /// (the development monitor here: 59972/1000). What mpv is told after a switch — it does
    /// not notice the change itself (see `displaySwitch.ts`).
    pub exact_rate: f64,
    /// The signal actually on the cable — size and refresh — which is not
    /// always the desktop mode (GPU scaling, or Windows confused; see
    /// `restore`).
    pub signal: Option<(u32, u32, f64)>,
    /// Bits per colour channel on the link, and its encoding ("RGB",
    /// "YCbCr 4:2:2", ...), as the driver set it up.
    pub link_bits: Option<u32>,
    pub link_encoding: Option<String>,
    pub hdr: HdrState,
    pub modes: Vec<Mode>,
}

/// What the screen was before Kinema changed anything.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Original {
    pub gdi_name: String,
    pub width: u32,
    pub height: u32,
    pub hz: u32,
    /// `None` when HDR was never touched, so restoring leaves it alone.
    pub hdr_on: Option<bool>,
    /// The signal on the cable before the first switch, to check the restore
    /// against: the desktop mode coming back is not proof the signal did.
    #[serde(default)]
    pub signal: Option<(u32, u32, f64)>,
}

fn load_original(app: &tauri::AppHandle) -> Option<Original> {
    use tauri::Manager;
    let db = app.state::<crate::library::Db>();
    let conn = db.0.lock().ok()?;
    crate::settings::setting(&conn, RESTORE_KEY).and_then(|json| serde_json::from_str(&json).ok())
}

fn save_original(app: &tauri::AppHandle, original: Option<&Original>) -> Result<(), String> {
    use tauri::Manager;
    let db = app.state::<crate::library::Db>();
    let conn = db.0.lock().map_err(crate::util::to_string_err)?;
    let json = match original {
        Some(o) => serde_json::to_string(o).map_err(crate::util::to_string_err)?,
        None => String::new(),
    };
    crate::settings::store(&conn, RESTORE_KEY, &json)
}

fn describe(width: u32, height: u32, hz: u32) -> String {
    format!(
        "{width}×{height}@{}",
        crate::equipment::format_rate(crate::equipment::rate_meaning(hz))
    )
}

fn describe_signal(signal: Option<(u32, u32, f64)>) -> String {
    match signal {
        Some((w, h, rate)) => format!("{w}×{h}@{}", crate::equipment::format_rate(rate)),
        None => "unknown".into(),
    }
}

/// Two signals are the same if size matches and the refresh is within 0.5 %.
fn same_signal(a: Option<(u32, u32, f64)>, b: Option<(u32, u32, f64)>) -> bool {
    match (a, b) {
        (Some((aw, ah, ar)), Some((bw, bh, br))) => {
            aw == bw && ah == bh && (ar - br).abs() <= ar.max(br) * 0.005
        }
        // Nothing to compare against: trust the desktop mode.
        _ => true,
    }
}

/// The screen the window is on, now.
#[tauri::command]
pub fn screen_now(window: tauri::WebviewWindow) -> Result<ScreenNow, String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        win::screen_now(&crate::equipment::win::monitor_of(hwnd))
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("display switching is Windows only".into())
    }
}

/// Switch the screen the window is on. `hdr` is `None` to leave HDR alone.
#[tauri::command]
pub async fn switch_screen(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    width: u32,
    height: u32,
    hz: u32,
    hdr: Option<bool>,
) -> Result<ScreenNow, String> {
    crate::jobs::off_main(move || {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(windows)]
        {
            let hwnd = window.hwnd().map_err(|e| e.to_string())?;
            let gdi = crate::equipment::win::monitor_of(hwnd);
            let before = win::screen_now(&gdi)?;
            let hdr_change = hdr.filter(|&on| match before.hdr {
                HdrState::On => !on,
                HdrState::Off => on,
                _ => false,
            });

            // Saved first, and only the first time: a second switch within
            // the same film must not overwrite the desktop's own mode with
            // the one the first switch made.
            let mut original = load_original(&app).unwrap_or(Original {
                gdi_name: gdi.clone(),
                width: before.width,
                height: before.height,
                hz: before.hz,
                hdr_on: None,
                signal: before.signal,
            });
            if hdr_change.is_some() && original.hdr_on.is_none() {
                original.hdr_on = Some(before.hdr == HdrState::On);
            }
            save_original(&app, Some(&original))?;

            // HDR first, then the mode. Turning HDR on makes Windows put back
            // the mode it last used with HDR: on the test TV a switch that set
            // 4K@23.976 and *then* turned HDR on ended at 4K@30 — and from a
            // 1080p desktop, at 1080p@30. Set after HDR, the mode stays.
            if let Some(on) = hdr_change {
                win::set_hdr(&gdi, on)?;
            }
            let mut after = win::screen_now(&gdi)?;
            // And checked: if anything still moved it, set it once more.
            for _ in 0..2 {
                if (after.width, after.height, after.hz) == (width, height, hz) {
                    break;
                }
                win::set_mode(&gdi, width, height, hz)?;
                after = win::screen_now(&gdi)?;
            }
            crate::log!(
                "display: {} {} HDR {:?} (signal {}) → {} HDR {:?} (signal {})",
                gdi,
                describe(before.width, before.height, before.hz),
                before.hdr,
                describe_signal(before.signal),
                describe(after.width, after.height, after.hz),
                after.hdr,
                describe_signal(after.signal)
            );
            if (after.width, after.height, after.hz) != (width, height, hz) {
                crate::log!(
                    "display: asked for {} and Windows kept {}",
                    describe(width, height, hz),
                    describe(after.width, after.height, after.hz)
                );
            }
            Ok(after)
        }
        #[cfg(not(windows))]
        {
            let _ = (app, window, width, height, hz, hdr);
            Err("display switching is Windows only".into())
        }
    })
    .await
}

/// Put back whatever `switch_screen` changed. Returns whether there was
/// anything to put back.
pub fn restore(app: &tauri::AppHandle) -> Result<bool, String> {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let Some(original) = load_original(app) else { return Ok(false) };
    #[cfg(windows)]
    {
        let gdi = &original.gdi_name;
        // The reverse of the switch: HDR back first, then the mode — so
        // Windows' own mode-for-this-HDR-state cannot land after ours.
        if let Some(on) = original.hdr_on {
            win::set_hdr(gdi, on)?;
        }
        win::reset_mode(gdi)?;
        let mut now = win::screen_now(gdi)?;
        // The desktop coming back is not the whole of it. On the test TV,
        // Windows reported 1080p while the TV went on receiving 4K 60 Hz, and
        // only a full mode change (done by hand in the NVIDIA panel) cleared
        // it. So the signal is checked against the one before the first
        // switch, and a mismatch gets a forced mode change.
        if !same_signal(original.signal, now.signal) {
            crate::log!(
                "display: {gdi} is back at {} but the signal is {} (was {}); forcing a full mode change",
                describe(now.width, now.height, now.hz),
                describe_signal(now.signal),
                describe_signal(original.signal)
            );
            win::force_mode(gdi, original.width, original.height, original.hz)?;
            now = win::screen_now(gdi)?;
        }
        crate::log!(
            "display: restored {} to {} HDR {:?} (signal {})",
            gdi,
            describe(now.width, now.height, now.hz),
            now.hdr,
            describe_signal(now.signal)
        );
    }
    save_original(app, None)?;
    Ok(true)
}

#[tauri::command]
pub async fn restore_screen(app: tauri::AppHandle) -> Result<bool, String> {
    crate::jobs::off_main(move || restore(&app)).await
}

/// A switched screen left behind by a session that never got to restore it —
/// a crash, a power cut, a killed process.
pub fn restore_after_crash(app: &tauri::AppHandle) {
    match restore(app) {
        Ok(true) => crate::log!("display: put back a screen mode left by the last session"),
        Ok(false) => {}
        Err(e) => crate::log!("display: could not put back the last session's screen mode: {e}"),
    }
}

#[cfg(windows)]
mod win {
    use super::ScreenNow;
    use crate::equipment::win::{header, hdr_state, link_of, modes, path_for, signal_of};
    use crate::equipment::{rate_meaning, HdrState};
    use std::mem::size_of;
    use windows::core::PCWSTR;
    use windows::Win32::Devices::Display::*;
    use windows::Win32::Graphics::Gdi::*;

    fn wide_z(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub fn screen_now(gdi: &str) -> Result<ScreenNow, String> {
        let name = wide_z(gdi);
        let mut dm = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
        let ok = unsafe { EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_CURRENT_SETTINGS, &mut dm) };
        if !ok.as_bool() {
            return Err(format!("could not read the mode of {gdi}"));
        }
        let (_, list) = modes(gdi);
        let path = path_for(gdi);
        let hdr = path.as_ref().map_or(HdrState::Unknown, |p| hdr_state(p).0);
        let exact_rate = path
            .as_ref()
            .map(|p| p.targetInfo.refreshRate)
            .filter(|r| r.Denominator > 0)
            .map_or(rate_meaning(dm.dmDisplayFrequency), |r| {
                f64::from(r.Numerator) / f64::from(r.Denominator)
            });
        Ok(ScreenNow {
            gdi_name: gdi.to_string(),
            width: dm.dmPelsWidth,
            height: dm.dmPelsHeight,
            hz: dm.dmDisplayFrequency,
            rate: rate_meaning(dm.dmDisplayFrequency),
            exact_rate,
            signal: signal_of(gdi),
            link_bits: path.as_ref().and_then(|p| link_of(p).0),
            link_encoding: path.as_ref().and_then(|p| link_of(p).1),
            hdr,
            modes: list,
        })
    }

    fn result_name(code: DISP_CHANGE) -> String {
        match code.0 {
            1 => "the computer must be restarted".into(),
            -1 => "the driver refused the mode".into(),
            -2 => "the mode is not supported".into(),
            -3 => "the registry could not be written".into(),
            -4 => "invalid flags".into(),
            -5 => "invalid parameter".into(),
            -6 => "the display is on a different adapter".into(),
            other => format!("error {other}"),
        }
    }

    pub fn set_mode(gdi: &str, width: u32, height: u32, hz: u32) -> Result<(), String> {
        let name = wide_z(gdi);
        let mut dm = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
        dm.dmPelsWidth = width;
        dm.dmPelsHeight = height;
        dm.dmDisplayFrequency = hz;
        dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
        // Asked first, so a mode the driver will not take fails here rather
        // than blanking the screen on the way to failing.
        let test = unsafe {
            ChangeDisplaySettingsExW(PCWSTR(name.as_ptr()), Some(&dm), None, CDS_TEST, None)
        };
        if test != DISP_CHANGE_SUCCESSFUL {
            return Err(format!("{width}×{height}@{hz}: {}", result_name(test)));
        }
        // CDS_FULLSCREEN: temporary, never written to the registry.
        let done = unsafe {
            ChangeDisplaySettingsExW(PCWSTR(name.as_ptr()), Some(&dm), None, CDS_FULLSCREEN, None)
        };
        if done != DISP_CHANGE_SUCCESSFUL {
            return Err(format!("{width}×{height}@{hz}: {}", result_name(done)));
        }
        Ok(())
    }

    /// The desktop's own mode, set with `CDS_RESET` so the driver does a full
    /// mode change even when Windows believes it is already in it — what
    /// clears a signal left at the wrong size. Not written to the registry.
    pub fn force_mode(gdi: &str, width: u32, height: u32, hz: u32) -> Result<(), String> {
        let name = wide_z(gdi);
        let mut dm = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
        dm.dmPelsWidth = width;
        dm.dmPelsHeight = height;
        dm.dmDisplayFrequency = hz;
        dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
        let done =
            unsafe { ChangeDisplaySettingsExW(PCWSTR(name.as_ptr()), Some(&dm), None, CDS_RESET, None) };
        if done != DISP_CHANGE_SUCCESSFUL {
            return Err(format!("forcing {width}×{height}@{hz}: {}", result_name(done)));
        }
        Ok(())
    }

    /// Back to the mode in the registry — the desktop's own, which
    /// `set_mode` never wrote.
    pub fn reset_mode(gdi: &str) -> Result<(), String> {
        let name = wide_z(gdi);
        let done = unsafe {
            ChangeDisplaySettingsExW(PCWSTR(name.as_ptr()), None, None, CDS_TYPE(0), None)
        };
        if done != DISP_CHANGE_SUCCESSFUL {
            return Err(format!("resetting {gdi}: {}", result_name(done)));
        }
        Ok(())
    }

    /// `DISPLAYCONFIG_SET_HDR_STATE`, Windows 11 24H2 and later — the one that
    /// means HDR rather than "advanced colour", which from 24H2 includes
    /// colour management on SDR screens. Not in `windows` 0.61; laid out from
    /// wingdi.h: the header, then one `UINT32` whose bit 0 is `enableHdr`.
    #[repr(C)]
    struct SetHdrState {
        header: DISPLAYCONFIG_DEVICE_INFO_HEADER,
        value: u32,
    }
    const SET_HDR_STATE: DISPLAYCONFIG_DEVICE_INFO_TYPE = DISPLAYCONFIG_DEVICE_INFO_TYPE(16);

    pub fn set_hdr(gdi: &str, on: bool) -> Result<(), String> {
        let p = path_for(gdi).ok_or_else(|| format!("no display path for {gdi}"))?;
        let t = &p.targetInfo;
        let hdr = SetHdrState {
            header: header::<SetHdrState>(SET_HDR_STATE, t.adapterId, t.id),
            value: u32::from(on),
        };
        if unsafe { DisplayConfigSetDeviceInfo(&hdr.header) } == 0 {
            return Ok(());
        }
        // Before 24H2 "advanced colour" meant HDR.
        let mut old = DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE {
            header: header::<DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE>(
                DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE,
                t.adapterId,
                t.id,
            ),
            ..Default::default()
        };
        old.Anonymous.value = u32::from(on);
        match unsafe { DisplayConfigSetDeviceInfo(&old.header) } {
            0 => Ok(()),
            code => Err(format!("turning HDR {} on {gdi}: error {code}", if on { "on" } else { "off" })),
        }
    }
}

#[cfg(test)]
mod signal_tests {
    use super::same_signal;

    #[test]
    fn signals_match_on_size_and_near_enough_rate() {
        assert!(same_signal(Some((3840, 2160, 60.0)), Some((3840, 2160, 59.94))));
        assert!(!same_signal(Some((3840, 2160, 60.0)), Some((1920, 1080, 60.0))));
        assert!(!same_signal(Some((1920, 1080, 60.0)), Some((1920, 1080, 23.976))));
        // Unknown on either side: nothing to go on, so no forced change.
        assert!(same_signal(None, Some((1920, 1080, 60.0))));
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::win;

    /// Switches a real screen to 1080p at `KINEMA_SWITCH_HZ` (default 50) for
    /// four seconds and back. Ignored by default: it blanks the screen twice.
    /// Run with `--ignored --nocapture`; the screen is `KINEMA_SWITCH_SCREEN`,
    /// by default `\\.\DISPLAY2` — the second screen, since the first is the
    /// one somebody is usually using.
    #[test]
    #[ignore]
    fn switch_and_restore_a_real_screen() {
        let gdi = std::env::var("KINEMA_SWITCH_SCREEN").unwrap_or_else(|_| r"\\.\DISPLAY2".into());
        let hz: u32 = std::env::var("KINEMA_SWITCH_HZ").ok().and_then(|v| v.parse().ok()).unwrap_or(50);
        let before = win::screen_now(&gdi).unwrap();
        println!(
            "before: {}×{}@{} ({:?}), signal {:?}",
            before.width, before.height, before.hz, before.hdr, before.signal
        );
        win::set_mode(&gdi, 1920, 1080, hz).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(4));
        let during = win::screen_now(&gdi).unwrap();
        println!(
            "during: {}×{}@{} = {:.3} Hz, signal {:?}",
            during.width, during.height, during.hz, during.rate, during.signal
        );
        win::reset_mode(&gdi).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(3));
        // The forced full mode change `restore` uses for a stuck signal.
        win::force_mode(&gdi, before.width, before.height, before.hz).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(3));
        let after = win::screen_now(&gdi).unwrap();
        println!("after:  {}×{}@{}, signal {:?}", after.width, after.height, after.hz, after.signal);
        assert_eq!(after.signal.map(|s| (s.0, s.1)), before.signal.map(|s| (s.0, s.1)));
        assert_eq!((during.width, during.height, during.hz), (1920, 1080, hz));
        assert_eq!((after.width, after.height, after.hz), (before.width, before.height, before.hz));
    }
}
