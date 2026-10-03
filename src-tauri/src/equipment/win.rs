//! What Windows reports about the screens and audio outputs: the Windows side of equipment.rs.
//!
//! Everything here is compiled on Windows only.

use super::*;
use std::collections::HashMap;
use std::mem::size_of;
use windows::core::{Interface, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Devices::Display::*;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::S_OK;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::KernelStreaming::*;
use windows::Win32::System::Com::StructuredStorage::{
    PropVariantToStringAlloc, PropVariantToUInt32,
};
use windows::Win32::System::Com::*;

pub fn detect() -> Equipment {
    let mut e = Equipment::default();
    let (gpus, outputs) = dxgi(&mut e.problems);
    e.gpus = gpus;
    e.displays = displays(&outputs, &mut e.problems);

    // Our own thread (see `detect_on_own_thread`), so this is the first COM
    // call on it and must be balanced before the thread ends.
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    match audio() {
        Ok(devices) => e.audio = devices,
        Err(err) => e.problems.push(format!("audio devices: {err}")),
    }
    if com.is_ok() {
        unsafe { CoUninitialize() };
    }
    e
}

pub(crate) fn wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn take_pwstr(p: PWSTR) -> Option<String> {
    if p.is_null() {
        return None;
    }
    let s = unsafe { p.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
    s
}

// ---- screens ----

struct OutputInfo {
    bits: u32,
    max: f32,
    min: f32,
    full_frame: f32,
}

fn dxgi(problems: &mut Vec<String>) -> (Vec<String>, HashMap<String, OutputInfo>) {
    let mut gpus = Vec::new();
    let mut outputs = HashMap::new();
    let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
        Ok(f) => f,
        Err(err) => {
            problems.push(format!("graphics adapters: {err}"));
            return (gpus, outputs);
        }
    };
    let mut i = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(i) } {
        i += 1;
        if let Ok(desc) = unsafe { adapter.GetDesc1() } {
            let name = wide(&desc.Description);
            if !name.contains("Basic Render") && !gpus.contains(&name) {
                gpus.push(name);
            }
        }
        let mut j = 0;
        while let Ok(output) = unsafe { adapter.EnumOutputs(j) } {
            j += 1;
            let Ok(output6) = output.cast::<IDXGIOutput6>() else { continue };
            if let Ok(d) = unsafe { output6.GetDesc1() } {
                outputs.insert(
                    wide(&d.DeviceName),
                    OutputInfo {
                        bits: d.BitsPerColor,
                        max: d.MaxLuminance,
                        min: d.MinLuminance,
                        full_frame: d.MaxFullFrameLuminance,
                    },
                );
            }
        }
    }
    (gpus, outputs)
}

pub(crate) fn active_paths() -> windows::core::Result<Vec<DISPLAYCONFIG_PATH_INFO>> {
    active_config().map(|(paths, _)| paths)
}

/// The HDMI/DisplayPort signal actually being sent to a screen: its size
/// and exact refresh — which is not always the desktop's. On the test TV,
/// after HDR was switched on and off around a mode change, Windows said
/// 1080p while the TV kept receiving 4K 60 Hz with the desktop scaled up
/// to it, and nothing short of a full mode change cleared it.
pub(crate) fn signal_of(gdi_name: &str) -> Option<(u32, u32, f64)> {
    let path = path_for(gdi_name)?;
    let (_, modes) = active_config().ok()?;
    let index = unsafe { path.targetInfo.Anonymous.modeInfoIdx } as usize;
    let mode = modes.get(index)?;
    if mode.infoType != DISPLAYCONFIG_MODE_INFO_TYPE_TARGET {
        return None;
    }
    let signal = unsafe { mode.Anonymous.targetMode.targetVideoSignalInfo };
    let rate = if signal.vSyncFreq.Denominator > 0 {
        f64::from(signal.vSyncFreq.Numerator) / f64::from(signal.vSyncFreq.Denominator)
    } else {
        0.0
    };
    Some((signal.activeSize.cx, signal.activeSize.cy, rate))
}

fn active_config(
) -> windows::core::Result<(Vec<DISPLAYCONFIG_PATH_INFO>, Vec<DISPLAYCONFIG_MODE_INFO>)> {
    let (mut n_paths, mut n_modes) = (0u32, 0u32);
    unsafe { GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut n_paths, &mut n_modes) }
        .ok()?;
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); n_paths as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); n_modes as usize];
    unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut n_paths,
            paths.as_mut_ptr(),
            &mut n_modes,
            modes.as_mut_ptr(),
            None,
        )
    }
    .ok()?;
    paths.truncate(n_paths as usize);
    modes.truncate(n_modes as usize);
    Ok((paths, modes))
}

pub(crate) fn header<T>(
    kind: DISPLAYCONFIG_DEVICE_INFO_TYPE,
    adapter: windows::Win32::Foundation::LUID,
    id: u32,
) -> DISPLAYCONFIG_DEVICE_INFO_HEADER {
    DISPLAYCONFIG_DEVICE_INFO_HEADER {
        r#type: kind,
        size: size_of::<T>() as u32,
        adapterId: adapter,
        id,
    }
}

/// `DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO_2`, Windows 11 24H2 and later.
/// Not in this version of the `windows` crate, so laid out by hand from
/// wingdi.h. It is the one that separates HDR from plain wide-gamut colour
/// management: from 24H2 the older query's "advanced colour supported" is
/// also true for an SDR screen with automatic colour management.
#[repr(C)]
#[derive(Default)]
struct AdvancedColorInfo2 {
    header: DISPLAYCONFIG_DEVICE_INFO_HEADER,
    /// bit 0 advancedColorSupported, 1 advancedColorActive,
    /// 3 advancedColorLimitedByPolicy, 4 highDynamicRangeSupported,
    /// 5 highDynamicRangeUserEnabled, 6 wideColorSupported,
    /// 7 wideColorUserEnabled.
    value: u32,
    color_encoding: i32,
    bits_per_color_channel: u32,
    /// 0 SDR, 1 WCG, 2 HDR.
    active_color_mode: i32,
}
const GET_ADVANCED_COLOR_INFO_2: DISPLAYCONFIG_DEVICE_INFO_TYPE =
    DISPLAYCONFIG_DEVICE_INFO_TYPE(15);

pub(crate) fn hdr_state(p: &DISPLAYCONFIG_PATH_INFO) -> (HdrState, Option<u32>) {
    let t = &p.targetInfo;
    let mut info2 = AdvancedColorInfo2 {
        header: header::<AdvancedColorInfo2>(GET_ADVANCED_COLOR_INFO_2, t.adapterId, t.id),
        ..Default::default()
    };
    if unsafe { DisplayConfigGetDeviceInfo(&mut info2.header) } == 0 {
        let supported = info2.value & (1 << 4) != 0;
        let state = if info2.active_color_mode == 2 {
            HdrState::On
        } else if supported {
            HdrState::Off
        } else {
            HdrState::Unsupported
        };
        return (state, Some(info2.bits_per_color_channel));
    }
    // Before 24H2: "advanced colour" meant HDR.
    let mut info = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO {
        header: header::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>(
            DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
            t.adapterId,
            t.id,
        ),
        ..Default::default()
    };
    if unsafe { DisplayConfigGetDeviceInfo(&mut info.header) } != 0 {
        return (HdrState::Unknown, None);
    }
    let value = unsafe { info.Anonymous.value };
    let state = match (value & 1 != 0, value & 2 != 0) {
        (_, true) => HdrState::On,
        (true, false) => HdrState::Off,
        _ => HdrState::Unsupported,
    };
    (state, Some(info.bitsPerColorChannel))
}

/// The link to the screen as the driver set it up: colour encoding and
/// bits per channel. Vendor neutral — the same query as HDR. What says
/// "HDR at 8 bits", which at 4K 60 Hz over HDMI 2.0 is a bandwidth limit
/// rather than a setting anyone chose.
pub(crate) fn link_of(p: &DISPLAYCONFIG_PATH_INFO) -> (Option<u32>, Option<String>) {
    let t = &p.targetInfo;
    let mut info2 = AdvancedColorInfo2 {
        header: header::<AdvancedColorInfo2>(GET_ADVANCED_COLOR_INFO_2, t.adapterId, t.id),
        ..Default::default()
    };
    let (encoding, bits) = if unsafe { DisplayConfigGetDeviceInfo(&mut info2.header) } == 0 {
        (info2.color_encoding, info2.bits_per_color_channel)
    } else {
        let mut info = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO {
            header: header::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>(
                DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
                t.adapterId,
                t.id,
            ),
            ..Default::default()
        };
        if unsafe { DisplayConfigGetDeviceInfo(&mut info.header) } != 0 {
            return (None, None);
        }
        (info.colorEncoding.0, info.bitsPerColorChannel)
    };
    let name = match encoding {
        0 => "RGB",
        1 => "YCbCr 4:4:4",
        2 => "YCbCr 4:2:2",
        3 => "YCbCr 4:2:0",
        _ => "other",
    };
    (Some(bits).filter(|&b| b > 0), Some(name.to_string()))
}

fn connection(tech: DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY) -> String {
    match tech.0 {
        0 => "VGA",
        4 => "DVI",
        5 => "HDMI",
        6 | 11 => "built-in panel",
        10 => "DisplayPort",
        15 => "Miracast",
        16 | 17 => "virtual display",
        18 => "USB-C DisplayPort",
        x if x as u32 == 0x8000_0000 => "built-in panel",
        _ => "other",
    }
    .into()
}

pub(crate) fn modes(gdi_name: &str) -> (Option<(u32, u32)>, Vec<Mode>) {
    let name: Vec<u16> = gdi_name.encode_utf16().chain(Some(0)).collect();
    let fresh = || DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
    let mut current = fresh();
    let now = unsafe {
        EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_CURRENT_SETTINGS, &mut current)
    }
    .as_bool()
    .then_some((current.dmPelsWidth, current.dmPelsHeight));

    let mut out: Vec<Mode> = Vec::new();
    let mut i = 0;
    loop {
        let mut dm = fresh();
        let ok = unsafe {
            EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_DISPLAY_SETTINGS_MODE(i), &mut dm)
        };
        if !ok.as_bool() {
            break;
        }
        i += 1;
        let interlaced = unsafe { dm.Anonymous2.dmDisplayFlags } & DM_INTERLACED.0 != 0;
        if interlaced || dm.dmBitsPerPel < 24 {
            continue;
        }
        let mode = Mode::new(dm.dmPelsWidth, dm.dmPelsHeight, dm.dmDisplayFrequency);
        if !out.contains(&mode) {
            out.push(mode);
        }
    }
    out.sort_by(|a, b| {
        (b.width * b.height).cmp(&(a.width * a.height)).then(b.hz.cmp(&a.hz))
    });
    (now, out)
}

/// HDR state of the screen a window is on, asked fresh — it can be switched
/// in Windows at any moment, so a value from the launch check will not do.
pub fn hdr_for_window(hwnd: windows::Win32::Foundation::HWND) -> (String, HdrState) {
    let gdi_name = monitor_of(hwnd);
    let state = path_for(&gdi_name).map_or(HdrState::Unknown, |p| hdr_state(&p).0);
    (gdi_name, state)
}

/// Windows' name (`\\.\DISPLAY1`) for the screen a window is mostly on.
pub(crate) fn monitor_of(hwnd: windows::Win32::Foundation::HWND) -> String {
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    let ok = unsafe {
        GetMonitorInfoW(monitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO)
    };
    if ok.as_bool() {
        wide(&info.szDevice)
    } else {
        String::new()
    }
}

/// The active display path whose source is that screen.
pub(crate) fn path_for(gdi_name: &str) -> Option<DISPLAYCONFIG_PATH_INFO> {
    if gdi_name.is_empty() {
        return None;
    }
    active_paths().ok()?.into_iter().find(|p| {
        let s = &p.sourceInfo;
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
            header: header::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>(
                DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                s.adapterId,
                s.id,
            ),
            ..Default::default()
        };
        (unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } == 0)
            && wide(&source.viewGdiDeviceName) == gdi_name
    })
}

fn displays(outputs: &HashMap<String, OutputInfo>, problems: &mut Vec<String>) -> Vec<Display> {
    let paths = match active_paths() {
        Ok(p) => p,
        Err(err) => {
            problems.push(format!("screen layout: {err}"));
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for p in &paths {
        let s = &p.sourceInfo;
        let t = &p.targetInfo;
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
            header: header::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>(
                DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                s.adapterId,
                s.id,
            ),
            ..Default::default()
        };
        if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } != 0 {
            problems.push("a screen's Windows name".into());
            continue;
        }
        let gdi_name = wide(&source.viewGdiDeviceName);

        let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME {
            header: header::<DISPLAYCONFIG_TARGET_DEVICE_NAME>(
                DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                t.adapterId,
                t.id,
            ),
            ..Default::default()
        };
        let (name, id, tech) = if unsafe { DisplayConfigGetDeviceInfo(&mut target.header) } == 0 {
            (
                wide(&target.monitorFriendlyDeviceName),
                wide(&target.monitorDevicePath),
                target.outputTechnology,
            )
        } else {
            (String::new(), String::new(), t.outputTechnology)
        };

        let (hdr, bits) = hdr_state(p);
        let (now, modes) = modes(&gdi_name);
        let (width, height) = now.unwrap_or_default();
        let lum = outputs.get(&gdi_name);
        let hdr_capable = matches!(hdr, HdrState::On | HdrState::Off);
        out.push(Display {
            id,
            name: if name.is_empty() { gdi_name.clone() } else { name },
            gdi_name,
            connection: connection(tech),
            width,
            height,
            refresh_num: t.refreshRate.Numerator,
            refresh_den: t.refreshRate.Denominator,
            hdr,
            // Windows reports a screen that offers HDR as on or off, never
            // unsupported, so the state already says it.
            screen_hdr: hdr_capable,
            peak_nits: lum.filter(|_| hdr_capable).map(|l| l.max),
            full_frame_nits: lum.filter(|_| hdr_capable).map(|l| l.full_frame),
            min_nits: lum.filter(|_| hdr_capable).map(|l| l.min),
            bits_per_color: bits.filter(|&b| b > 0).or(lum.map(|l| l.bits)),
            modes,
            notes: Vec::new(),
        });
    }
    out
}

// ---- audio ----

fn audio() -> windows::core::Result<Vec<AudioDevice>> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }?;
    let default_id = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .ok()
        .and_then(|d| unsafe { d.GetId() }.ok())
        .and_then(take_pwstr);
    let collection = unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }?;
    let count = unsafe { collection.GetCount() }?;
    let mut out = Vec::new();
    for i in 0..count {
        let device = unsafe { collection.Item(i) }?;
        out.push(audio_device(&device, default_id.as_deref()));
    }
    Ok(out)
}

fn form_factor(n: u32) -> String {
    match n {
        0 => "network",
        1 => "speakers",
        2 => "line out",
        3 => "headphones",
        5 => "headset",
        7 => "digital",
        8 => "S/PDIF",
        9 => "HDMI",
        _ => "unknown",
    }
    .into()
}

fn audio_device(device: &IMMDevice, default_id: Option<&str>) -> AudioDevice {
    let id = unsafe { device.GetId() }.ok().and_then(take_pwstr).unwrap_or_default();
    let mut a = AudioDevice {
        is_default: default_id == Some(id.as_str()),
        id,
        ..Default::default()
    };
    if let Ok(store) = unsafe { device.OpenPropertyStore(STGM_READ) } {
        if let Ok(v) = unsafe { store.GetValue(&PKEY_Device_FriendlyName) } {
            a.name = unsafe { PropVariantToStringAlloc(&v) }
                .ok()
                .and_then(take_pwstr)
                .unwrap_or_default();
        }
        if let Ok(v) = unsafe { store.GetValue(&PKEY_AudioEndpoint_FormFactor) } {
            a.connection = form_factor(unsafe { PropVariantToUInt32(&v) }.unwrap_or(10));
        }
    }

    // Activating the spatial client is only possible while a spatial
    // format is selected for the device; zero objects means the same.
    // The dynamic object count is the detector: 0 with spatial sound off,
    // non-zero with it on (128 for Windows Sonic, 20 for Dolby Atmos for
    // home theater). The static mask (0xffffe) and stream availability
    // ("ok") answer the same with it off and mean nothing — see GOTCHAS.
    // Every answer is still logged, for the next driver that differs.
    match unsafe { device.Activate::<ISpatialAudioClient>(CLSCTX_ALL, None) } {
        Ok(s) => {
            let dynamic = unsafe { s.GetMaxDynamicObjectCount() };
            let mask = unsafe { s.GetNativeStaticObjectTypeMask() };
            let stream = unsafe {
                s.IsSpatialAudioStreamAvailable(&ISpatialAudioObjectRenderStream::IID, None)
            };
            a.spatial_detail = format!(
                "dynamic={} static-mask={} stream={}",
                dynamic.as_ref().map_or_else(|e| e.code().to_string(), |n| n.to_string()),
                mask.as_ref().map_or_else(|e| e.code().to_string(), |m| format!("{:#x}", m.0)),
                stream.as_ref().map_or_else(|e| e.code().to_string(), |_| "ok".into()),
            );
            a.spatial_objects = dynamic.ok().filter(|&n| n > 0);
        }
        Err(err) => a.spatial_detail = format!("activate={}", err.code()),
    }

    let client: IAudioClient = match unsafe { device.Activate(CLSCTX_ALL, None) } {
        Ok(c) => c,
        Err(err) => {
            a.bitstream = BITSTREAMS
                .iter()
                .map(|b| BitstreamSupport {
                    codec: b.codec.into(),
                    label: b.label.into(),
                    result: Probe::Unknown,
                    detail: Some(err.code().to_string()),
                    remembered: false,
                })
                .collect();
            return a;
        }
    };

    if let Ok(mix) = unsafe { client.GetMixFormat() } {
        let wf: WAVEFORMATEX = unsafe { std::ptr::read_unaligned(mix) };
        let mask = if u32::from(wf.wFormatTag) == WAVE_FORMAT_EXTENSIBLE && wf.cbSize >= 22 {
            let ext: WAVEFORMATEXTENSIBLE =
                unsafe { std::ptr::read_unaligned(mix as *const WAVEFORMATEXTENSIBLE) };
            ext.dwChannelMask
        } else {
            0
        };
        a.mix_channels = wf.nChannels;
        a.mix_rate = wf.nSamplesPerSec;
        a.mix_layout = layout_name(wf.nChannels, mask);
        unsafe { CoTaskMemFree(Some(mix as *const _)) };
    }

    a.bitstream = BITSTREAMS
        .iter()
        .map(|b| {
            let hr = is_supported(&client, b.rate, b.channels, b.mask, 16, 16, bitstream_subtype(b.codec));
            let result = classify(hr);
            BitstreamSupport {
                codec: b.codec.into(),
                label: b.label.into(),
                result,
                detail: (result == Probe::Unknown).then(|| hr.to_string()),
                remembered: false,
            }
        })
        .collect();

    // PCM straight to the device, bypassing the Windows mixer: 16-bit and
    // 24-in-32, because HDMI drivers differ on which they take.
    let pcm = |channels: u16, mask: u32| {
        [(16, 16), (32, 24)].iter().any(|&(bits, valid)| {
            is_supported(&client, 48_000, channels, mask, bits, valid, KSDATAFORMAT_SUBTYPE_PCM)
                .is_ok()
        })
    };
    let any_answer = a.bitstream.iter().any(|b| matches!(b.result, Probe::Yes | Probe::No));
    if any_answer {
        a.max_pcm_channels = if pcm(8, SEVEN_ONE) {
            Some(8)
        } else if pcm(6, 0x60F) || pcm(6, 0x3F) {
            Some(6)
        } else if pcm(2, STEREO) {
            Some(2)
        } else {
            None
        };
    }
    a
}

fn bitstream_subtype(codec: &str) -> GUID {
    match codec {
        "ac3" => KSDATAFORMAT_SUBTYPE_IEC61937_DOLBY_DIGITAL,
        "eac3" => KSDATAFORMAT_SUBTYPE_IEC61937_DOLBY_DIGITAL_PLUS,
        "dts" => KSDATAFORMAT_SUBTYPE_IEC61937_DTS,
        "dts-hd" => KSDATAFORMAT_SUBTYPE_IEC61937_DTS_HD,
        _ => KSDATAFORMAT_SUBTYPE_IEC61937_DOLBY_MLP,
    }
}

/// `IsFormatSupported` in exclusive mode, which is the mode mpv uses for
/// every bitstream whatever `--audio-exclusive` says.
fn is_supported(
    client: &IAudioClient,
    rate: u32,
    channels: u16,
    mask: u32,
    bits: u16,
    valid_bits: u16,
    subtype: GUID,
) -> HRESULT {
    let block = channels * bits / 8;
    let format = WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
            nChannels: channels,
            nSamplesPerSec: rate,
            nAvgBytesPerSec: rate * u32::from(block),
            nBlockAlign: block,
            wBitsPerSample: bits,
            cbSize: (size_of::<WAVEFORMATEXTENSIBLE>() - size_of::<WAVEFORMATEX>()) as u16,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 { wValidBitsPerSample: valid_bits },
        dwChannelMask: mask,
        SubFormat: subtype,
    };
    unsafe {
        client.IsFormatSupported(
            AUDCLNT_SHAREMODE_EXCLUSIVE,
            &format as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX,
            None,
        )
    }
}

fn classify(hr: HRESULT) -> Probe {
    if hr == S_OK {
        Probe::Yes
    } else if hr == AUDCLNT_E_UNSUPPORTED_FORMAT {
        Probe::No
    } else if hr == AUDCLNT_E_DEVICE_IN_USE {
        Probe::Busy
    } else if hr == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED {
        Probe::NotAllowed
    } else if hr.is_ok() {
        // S_FALSE and friends: mpv treats any success as acceptance.
        Probe::Yes
    } else {
        Probe::Unknown
    }
}
