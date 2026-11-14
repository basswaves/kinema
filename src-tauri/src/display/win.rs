//! Changing the screen's mode and HDR through Windows: the Windows side of display.rs.
//!
//! Everything here is compiled on Windows only.

use super::ScreenNow;
use crate::equipment::win::{
    active_config, header, hdr_state, link_of, modes, path_for, signal_of, source_gdi,
};
use crate::equipment::{rate_meaning, HdrState};
use std::mem::size_of;
use windows::core::PCWSTR;
use windows::Win32::Devices::Display::*;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER, WM_DISPLAYCHANGE,
};

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
    if test == DISP_CHANGE_BADMODE || test == DISP_CHANGE_FAILED {
        // The old call keeps the link's colour format, and some links have
        // room for a mode only in a smaller one: a TV PC at 4K 30 Hz, 10-bit
        // YCbCr 4:2:2, listed 4K 59.94 Hz and refused it here, while Windows'
        // Settings set it, at 8-bit 4:2:0 (2026-11-14). Asked the way
        // Settings asks, the driver may lower the format to fit.
        crate::log!(
            "display: {width}×{height}@{hz} refused in the link's current colour format ({}); asking as Windows' Settings does",
            result_name(test)
        );
        return set_mode_letting_driver_fit(gdi, width, height, hz)
            .map_err(|e| format!("{width}×{height}@{hz}: {} ({e})", result_name(test)));
    }
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

/// "No target mode given": Windows picks one for the source mode and the
/// path's refresh rate (wingdi.h `DISPLAYCONFIG_PATH_MODE_IDX_INVALID`).
const NO_MODE: u32 = 0xffff_ffff;

/// A Windows refresh as listed (59) as the exact fraction (60000/1001).
fn rational(hz: u32) -> DISPLAYCONFIG_RATIONAL {
    if crate::equipment::rate_meaning(hz) == f64::from(hz) {
        DISPLAYCONFIG_RATIONAL { Numerator: hz, Denominator: 1 }
    } else {
        DISPLAYCONFIG_RATIONAL { Numerator: (hz + 1) * 1000, Denominator: 1001 }
    }
}

/// The mode set as Windows' own Settings sets it (`SetDisplayConfig`): the
/// desktop's size and the path's refresh, with no target mode, so the driver
/// chooses the signal — and may lower the bit depth or chroma for a rate the
/// cable has no room for otherwise. Not saved (no `SDC_SAVE_TO_DATABASE`):
/// `reset_mode` puts the saved mode back. Unlike `CDS_FULLSCREEN` it does not
/// end with the process; the restore record covers a crash.
pub fn set_mode_letting_driver_fit(gdi: &str, width: u32, height: u32, hz: u32) -> Result<(), String> {
    let (mut paths, mut modes) = active_config().map_err(|e| e.to_string())?;
    let path = paths
        .iter_mut()
        .find(|p| source_gdi(p).as_deref() == Some(gdi))
        .ok_or_else(|| format!("no display path for {gdi}"))?;
    let source = unsafe { path.sourceInfo.Anonymous.modeInfoIdx } as usize;
    let entry = modes
        .get_mut(source)
        .filter(|m| m.infoType == DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE)
        .ok_or("the desktop's mode could not be read")?;
    let mut desktop = unsafe { entry.Anonymous.sourceMode };
    desktop.width = width;
    desktop.height = height;
    entry.Anonymous.sourceMode = desktop;
    path.targetInfo.Anonymous.modeInfoIdx = NO_MODE;
    path.targetInfo.refreshRate = rational(hz);
    let how = SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES;
    let code = unsafe { SetDisplayConfig(Some(&paths), Some(&modes), how | SDC_VALIDATE) };
    if code != 0 {
        return Err(format!("Windows would not take it either: error {code}"));
    }
    match unsafe { SetDisplayConfig(Some(&paths), Some(&modes), how | SDC_APPLY) } {
        0 => Ok(()),
        code => Err(format!("Windows would not set it: error {code}")),
    }
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

/// The screen's bounds as Windows reports them now, for the screen the window
/// is mostly on.
fn screen_rect(hwnd: HWND) -> Option<RECT> {
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool().then_some(info.rcMonitor)
}

/// Set a full-screen window to its screen's bounds as they are now. A window
/// made full screen at 1920×1080 stays 1920×1080 when the screen goes to
/// 3840×2160 under it — Windows moves nothing and Tauri sized it once — so
/// the film played in the top-left quarter of a 4K TV. Returns the window's
/// size before and after when it had to change.
pub fn fit_to_screen(hwnd: HWND) -> Result<Option<(Size, Size)>, String> {
    let mut now = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut now) }.map_err(|e| e.to_string())?;
    let screen = screen_rect(hwnd).ok_or("the window's screen could not be read")?;
    let Some(to) = super::fitted(rect(now), rect(screen)) else { return Ok(None) };
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            to.0,
            to.1,
            to.2 - to.0,
            to.3 - to.1,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(Some(((now.right - now.left, now.bottom - now.top), (to.2 - to.0, to.3 - to.1))))
}

/// Width and height.
pub type Size = (i32, i32);

fn rect(r: RECT) -> (i32, i32, i32, i32) {
    (r.left, r.top, r.right, r.bottom)
}

/// Hear Windows say a screen changed mode (`WM_DISPLAYCHANGE`, sent to every
/// top-level window once the change is made), whoever changed it: Kinema's
/// own switch and restore, HDR moving the mode by itself, or someone in
/// Windows' settings. `then` runs on its own thread, since asking Tauri
/// whether the window is full screen from inside the window's own message
/// handler would wait on that very handler.
pub fn on_display_change(hwnd: HWND, then: Box<dyn Fn() + Send + Sync>) -> Result<(), String> {
    let data = Box::into_raw(Box::new(then)) as usize;
    // Kept for the life of the window: there is one, and it lives as long as
    // the process.
    let ok = unsafe { SetWindowSubclass(hwnd, Some(display_change_proc), 0x4b44_4350, data) };
    if ok.as_bool() {
        Ok(())
    } else {
        Err("the window's messages could not be listened to".into())
    }
}

unsafe extern "system" fn display_change_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    if msg == WM_DISPLAYCHANGE {
        let then = data as *const Box<dyn Fn() + Send + Sync>;
        // The pointer lives as long as the window (never freed).
        let then: &'static (dyn Fn() + Send + Sync) = unsafe { &**then };
        std::thread::spawn(then);
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}
