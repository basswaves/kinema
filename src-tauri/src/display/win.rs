//! Changing the screen's mode and HDR through Windows: the Windows side of display.rs.
//!
//! Everything here is compiled on Windows only.

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
