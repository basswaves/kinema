//! The equipment check on Linux: the same `Equipment` the Windows reader
//! fills, from three places, each the authority on its part.
//!
//! - **The kernel** (`/sys/class/drm`): which screens are connected, on what
//!   kind of port, and each one's EDID — its name and its HDR brightness.
//! - **GNOME** (Mutter's `org.gnome.Mutter.DisplayConfig` on the session bus):
//!   the current mode, every mode the desktop can drive with its exact rate,
//!   and whether HDR is on. The kernel knows the modes too, but not which one
//!   the desktop chose, nor anything about HDR, which the compositor owns.
//!   Other desktops are not asked yet; their screens are still listed, from
//!   the kernel, with the mode left unknown.
//! - **ALSA**: each HDMI/DisplayPort sound device's `ELD` control, which holds
//!   the list of formats the TV or receiver on that output announced
//!   (`eld.rs`). Read per PCM device, not from `/proc/asound/card*/eld#*`:
//!   those are per graphics-card pin, and which pin feeds which PCM device is
//!   assigned at run time, so only the control says which device to play to.
//!
//! All of it is read-only and none of it opens a sound device, so the check
//! cannot make a sound or take a device from PipeWire.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use zbus::zvariant::OwnedValue;

use super::{
    eld, edid, AudioDevice, BitstreamSupport, Display, Equipment, HdrState, Mode, Probe,
    BITSTREAMS,
};

pub fn detect() -> Equipment {
    let mut problems = Vec::new();
    let gpus = gpus();
    let displays = displays(&mut problems);
    let audio = audio(&mut problems);
    Equipment { gpus, displays, audio, problems }
}

// ---- graphics cards ------------------------------------------------------------

fn read(path: impl AsRef<Path>) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

fn gpus() -> Vec<String> {
    let mut out = Vec::new();
    let Ok(dir) = fs::read_dir("/sys/class/drm") else { return out };
    let mut cards: Vec<PathBuf> = dir
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            n.starts_with("card") && !n.contains('-')
        })
        .collect();
    cards.sort();
    for card in cards {
        let device = card.join("device");
        let vendor = read(device.join("vendor")).unwrap_or_default();
        let id = read(device.join("device")).unwrap_or_default();
        let driver = fs::read_link(device.join("driver"))
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "no".into());
        let pci = fs::canonicalize(&device)
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default();
        // NVIDIA's own driver names the model; the others leave it to a PCI
        // database this does not carry, so the ids stand in.
        let model = read(format!("/proc/driver/nvidia/gpus/{pci}/information")).and_then(|info| {
            info.lines()
                .find_map(|l| l.strip_prefix("Model:").map(|m| m.trim().to_string()))
        });
        let name = model.unwrap_or_else(|| {
            let maker = match vendor.as_str() {
                "0x10de" => "NVIDIA",
                "0x1002" => "AMD",
                "0x8086" => "Intel",
                _ => "graphics",
            };
            format!("{maker} {}", id.trim_start_matches("0x"))
        });
        out.push(format!("{name} ({driver} driver, {}:{})", vendor.trim_start_matches("0x"), id.trim_start_matches("0x")));
    }
    out
}

// ---- screens -------------------------------------------------------------------

/// One connected output as the kernel lists it.
struct Connector {
    /// `HDMI-A-1`, as `/sys/class/drm/card1-HDMI-A-1` names it.
    name: String,
    edid: Option<edid::Edid>,
}

/// The desktop's name for a kernel connector. GNOME, KDE and mpv (which
/// reports it as `display-names`) all call `HDMI-A-1` "HDMI-1"; every other
/// connector type is spelt the same.
pub(crate) fn desktop_name(connector: &str) -> String {
    connector.replacen("HDMI-A-", "HDMI-", 1)
}

pub(crate) fn connection_of(connector: &str) -> String {
    // "HDMI-A-1" → "HDMI-A"; a virtual screen may have no dash: "LVDS1".
    let kind = connector.trim_end_matches(|c: char| c.is_ascii_digit()).trim_end_matches('-');
    match kind {
        "HDMI-A" | "HDMI-B" | "HDMI" => "HDMI",
        "DP" => "DisplayPort",
        "eDP" | "LVDS" | "DSI" => "built-in",
        k if k.starts_with("DVI") => "DVI",
        "VGA" => "VGA",
        other => other,
    }
    .into()
}

fn connectors() -> Vec<Connector> {
    let Ok(dir) = fs::read_dir("/sys/class/drm") else { return Vec::new() };
    let mut out: Vec<Connector> = dir
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            let (_, name) = file.split_once('-')?;
            if read(e.path().join("status")).as_deref() != Some("connected") {
                return None;
            }
            // sysfs says the file is empty whatever it holds: read, then look.
            let edid = fs::read(e.path().join("edid")).ok().and_then(|b| edid::parse(&b));
            Some(Connector { name: name.to_string(), edid })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// A monitor as Mutter describes it.
#[derive(Debug, Clone, Default)]
pub(crate) struct MutterMonitor {
    pub connector: String,
    pub display_name: String,
    /// (width, height, refresh, current, interlaced)
    pub modes: Vec<(u32, u32, f64, bool, bool)>,
    pub color_mode: Option<u32>,
    pub supported_color_modes: Vec<u32>,
}

/// Mutter's colour mode for HDR: BT.2100. GNOME 50 also lists 2, "sdr-native"
/// (wide-gamut SDR) — not HDR (GOTCHAS → "GNOME's colour mode 2 is not HDR").
pub(crate) const MUTTER_HDR: u32 = 1;

type MutterMode = (String, i32, i32, f64, f64, Vec<f64>, HashMap<String, OwnedValue>);
type MutterMonitorT = ((String, String, String, String), Vec<MutterMode>, HashMap<String, OwnedValue>);
type MutterLogical =
    (i32, i32, f64, u32, bool, Vec<(String, String, String, String)>, HashMap<String, OwnedValue>);
type MutterState = (u32, Vec<MutterMonitorT>, Vec<MutterLogical>, HashMap<String, OwnedValue>);

fn prop<T: TryFrom<OwnedValue>>(props: &HashMap<String, OwnedValue>, key: &str) -> Option<T> {
    props.get(key).and_then(|v| v.try_clone().ok()).and_then(|v| T::try_from(v).ok())
}

fn mutter() -> Result<Vec<MutterMonitor>, String> {
    let bus = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let reply = bus
        .call_method(
            Some("org.gnome.Mutter.DisplayConfig"),
            "/org/gnome/Mutter/DisplayConfig",
            Some("org.gnome.Mutter.DisplayConfig"),
            "GetCurrentState",
            &(),
        )
        .map_err(|e| e.to_string())?;
    let (_, monitors, _, _): MutterState = reply.body().deserialize().map_err(|e| e.to_string())?;
    Ok(monitors
        .into_iter()
        .map(|((connector, _, _, _), modes, props)| MutterMonitor {
            connector,
            display_name: prop::<String>(&props, "display-name").unwrap_or_default(),
            modes: modes
                .into_iter()
                .map(|(_, w, h, refresh, _, _, p)| {
                    (
                        w.max(0) as u32,
                        h.max(0) as u32,
                        refresh,
                        prop::<bool>(&p, "is-current").unwrap_or(false),
                        prop::<bool>(&p, "is-interlaced").unwrap_or(false),
                    )
                })
                .collect(),
            color_mode: prop::<u32>(&props, "color-mode"),
            supported_color_modes: prop::<Vec<u32>>(&props, "supported-color-modes")
                .unwrap_or_default(),
        })
        .collect())
}

/// The whole number a refresh rate is known by — 23 for 23.976, as Windows
/// lists it, so `Mode` means the same on both.
pub(crate) fn whole_hz(rate: f64) -> u32 {
    [23u32, 29, 47, 59, 119]
        .into_iter()
        .find(|&n| (rate - f64::from(n + 1) * 1000.0 / 1001.0).abs() < 0.01)
        .unwrap_or(rate.round() as u32)
}

/// One screen: the kernel's connector, Mutter's monitor, or both.
pub(crate) fn display_from(connector: Option<&str>, edid: Option<&edid::Edid>, gnome: Option<&MutterMonitor>) -> Display {
    let kernel_name = connector.map(str::to_string);
    let name_on_desktop = gnome
        .map(|m| m.connector.clone())
        .or_else(|| kernel_name.as_deref().map(desktop_name))
        .unwrap_or_default();
    let mut d = Display {
        id: format!(
            "{}{}",
            kernel_name.as_deref().unwrap_or(&name_on_desktop),
            edid.map(|e| format!("/{}{:04X}-{}", e.maker, e.product, e.serial)).unwrap_or_default()
        ),
        name: edid
            .and_then(|e| e.name.clone())
            .or_else(|| gnome.map(|m| m.display_name.clone()).filter(|n| !n.is_empty()))
            .unwrap_or_else(|| name_on_desktop.clone()),
        connection: connection_of(kernel_name.as_deref().unwrap_or(&name_on_desktop)),
        gdi_name: name_on_desktop,
        ..Default::default()
    };

    let can_hdr = edid.and_then(|e| e.hdr.as_ref()).is_some_and(|h| h.pq);
    d.hdr = match gnome {
        Some(m) if m.color_mode == Some(MUTTER_HDR) => HdrState::On,
        Some(m) if m.supported_color_modes.contains(&MUTTER_HDR) => HdrState::Off,
        Some(_) => HdrState::Unsupported,
        None if can_hdr => HdrState::Unknown,
        None => HdrState::Unsupported,
    };
    if d.hdr != HdrState::Unsupported {
        if let Some(h) = edid.and_then(|e| e.hdr.as_ref()) {
            d.peak_nits = h.max_nits;
            d.full_frame_nits = h.frame_average_nits;
            d.min_nits = h.min_nits;
        }
    }

    if let Some(m) = gnome {
        for &(w, h, rate, current, interlaced) in &m.modes {
            if current {
                d.width = w;
                d.height = h;
                d.refresh_num = (rate * 1000.0).round() as u32;
                d.refresh_den = 1000;
            }
            let mode = Mode { width: w, height: h, hz: whole_hz(rate), rate };
            let same = |o: &Mode| o.width == w && o.height == h && (o.rate - rate).abs() < 0.0005;
            if !interlaced && !d.modes.iter().any(same) {
                d.modes.push(mode);
            }
        }
    }
    d
}

fn displays(problems: &mut Vec<String>) -> Vec<Display> {
    let kernel = connectors();
    let gnome = match mutter() {
        Ok(m) => m,
        Err(e) => {
            problems.push(format!(
                "the screens' modes and HDR state (only GNOME is asked so far: {e})"
            ));
            Vec::new()
        }
    };
    let mut out: Vec<Display> = kernel
        .iter()
        .map(|c| {
            let m = gnome.iter().find(|m| m.connector == desktop_name(&c.name));
            display_from(Some(&c.name), c.edid.as_ref(), m)
        })
        .collect();
    // A screen the desktop drives that the kernel did not list — a nested or
    // virtual one — is still a screen.
    for m in &gnome {
        if !kernel.iter().any(|c| desktop_name(&c.name) == m.connector) {
            out.push(display_from(None, None, Some(m)));
        }
    }
    out
}

// ---- sound ---------------------------------------------------------------------

/// One playback device of a sound card, from `/proc/asound/cardN/pcmDp/info`.
pub(crate) struct Pcm {
    pub device: u32,
    /// "HDMI 0", "Generic Analog".
    pub id: String,
}

fn pcms(card: u32) -> Vec<Pcm> {
    let Ok(dir) = fs::read_dir(format!("/proc/asound/card{card}")) else { return Vec::new() };
    let mut out: Vec<Pcm> = dir
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            let device = n.strip_prefix("pcm")?.strip_suffix('p')?.parse().ok()?;
            let info = read(e.path().join("info"))?;
            let id = info.lines().find_map(|l| l.strip_prefix("id: "))?.to_string();
            Some(Pcm { device, id })
        })
        .collect();
    out.sort_by_key(|p| p.device);
    out
}

/// Every `ELD` control of a card, by PCM device.
fn elds(card: u32) -> Result<HashMap<u32, Vec<u8>>, String> {
    let hctl = alsa::HCtl::new(&format!("hw:{card}"), false).map_err(|e| e.to_string())?;
    hctl.load().map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for elem in hctl.elem_iter() {
        let Ok(id) = elem.get_id() else { continue };
        if id.get_interface() != alsa::ctl::ElemIface::PCM || id.get_name().ok() != Some("ELD") {
            continue;
        }
        if let Some(bytes) = elem.read().ok().and_then(|v| v.get_bytes().map(<[u8]>::to_vec)) {
            out.insert(id.get_device(), bytes);
        }
    }
    Ok(out)
}

/// mpv's name for a device. An HD Audio card's HDMI outputs are ALSA's
/// `hdmi:` devices, numbered by their place among the card's HDMI PCMs
/// ("HDMI 0" is `DEV=0` whatever its PCM number) — the device that also sets
/// the "non-audio" flag a bitstream needs. Anything else by its PCM number.
pub(crate) fn mpv_name(card_id: &str, pcm: &Pcm) -> String {
    match pcm.id.strip_prefix("HDMI ").and_then(|n| n.parse::<u32>().ok()) {
        Some(n) => format!("alsa/hdmi:CARD={card_id},DEV={n}"),
        None => format!("alsa/plughw:CARD={card_id},DEV={}", pcm.device),
    }
}

/// A connected HDMI or DisplayPort output, from what its sink announced.
pub(crate) fn hdmi_device(card_id: &str, card_name: &str, pcm: &Pcm, e: &eld::Eld) -> AudioDevice {
    AudioDevice {
        name: format!("{} ({card_name}, {})", e.monitor_name, pcm.id),
        id: mpv_name(card_id, pcm),
        connection: e.connection.into(),
        max_pcm_channels: e.max_pcm_channels(),
        bitstream: BITSTREAMS
            .iter()
            .map(|b| BitstreamSupport {
                codec: b.codec.into(),
                label: b.label.into(),
                result: if e.takes(b.codec) { Probe::Yes } else { Probe::No },
                detail: None,
                remembered: false,
            })
            .collect(),
        ..Default::default()
    }
}

/// An output with no ELD: analogue, or S/PDIF, which carries Dolby Digital
/// and DTS but has no way to say whether what is on the other end decodes
/// them, and cannot carry the rest at all.
pub(crate) fn other_device(card_id: &str, card_name: &str, pcm: &Pcm) -> AudioDevice {
    let digital = pcm.id.contains("Digital") || pcm.id.contains("IEC958") || pcm.id.contains("SPDIF");
    AudioDevice {
        name: format!("{card_name}, {}", pcm.id),
        id: mpv_name(card_id, pcm),
        connection: if digital { "S/PDIF" } else { "analogue" }.into(),
        max_pcm_channels: digital.then_some(2),
        bitstream: BITSTREAMS
            .iter()
            .map(|b| {
                let unknowable = digital && matches!(b.codec, "ac3" | "dts");
                BitstreamSupport {
                    codec: b.codec.into(),
                    label: b.label.into(),
                    result: if unknowable { Probe::Unknown } else { Probe::No },
                    detail: unknowable.then(|| "S/PDIF cannot say".into()),
                    remembered: false,
                }
            })
            .collect(),
        ..Default::default()
    }
}

fn audio(problems: &mut Vec<String>) -> Vec<AudioDevice> {
    let mut out = Vec::new();
    let Ok(dir) = fs::read_dir("/proc/asound") else {
        problems.push("the sound devices (no ALSA on this system)".into());
        return out;
    };
    let mut cards: Vec<u32> = dir
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_prefix("card")?.parse().ok())
        .collect();
    cards.sort_unstable();
    for card in cards {
        let card_id = read(format!("/proc/asound/card{card}/id")).unwrap_or_else(|| card.to_string());
        let card_name = alsa::Card::new(card as i32)
            .get_name()
            .unwrap_or_else(|_| card_id.clone());
        let elds = match elds(card) {
            Ok(e) => e,
            Err(e) => {
                problems.push(format!("what is connected to {card_name} ({e})"));
                HashMap::new()
            }
        };
        for pcm in pcms(card) {
            match elds.get(&pcm.device) {
                // An HDMI/DP output: listed only with something on the other
                // end, as Windows lists only active outputs.
                Some(bytes) => {
                    if let Some(e) = eld::parse(bytes) {
                        out.push(hdmi_device(&card_id, &card_name, &pcm, &e));
                    }
                }
                None if pcm.id.starts_with("HDMI") => {}
                None => out.push(other_device(&card_id, &card_name, &pcm)),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connectors_are_named_as_the_desktop_names_them() {
        assert_eq!(desktop_name("HDMI-A-1"), "HDMI-1");
        assert_eq!(desktop_name("DP-2"), "DP-2");
        assert_eq!(desktop_name("eDP-1"), "eDP-1");
        assert_eq!(connection_of("HDMI-A-1"), "HDMI");
        assert_eq!(connection_of("DP-3"), "DisplayPort");
        assert_eq!(connection_of("DVI-D-1"), "DVI");
        assert_eq!(connection_of("eDP-1"), "built-in");
        // A nested GNOME's virtual screen.
        assert_eq!(connection_of("LVDS1"), "built-in");
    }

    #[test]
    fn rates_get_the_whole_number_windows_would_list() {
        assert_eq!(whole_hz(23.976023), 23);
        assert_eq!(whole_hz(24.0), 24);
        assert_eq!(whole_hz(59.940060), 59);
        assert_eq!(whole_hz(60.000), 60);
        assert_eq!(whole_hz(119.880), 119);
        assert_eq!(whole_hz(50.0), 50);
    }

    fn tv_on_gnome(color_mode: u32) -> MutterMonitor {
        MutterMonitor {
            connector: "HDMI-1".into(),
            display_name: "Maker TV".into(),
            modes: vec![
                (3840, 2160, 60.0, false, false),
                (3840, 2160, 23.976023, false, false),
                (3840, 2160, 23.976023, false, false),
                (1920, 1080, 60.0, true, false),
                (1920, 1080, 59.940060, false, true),
            ],
            color_mode: Some(color_mode),
            supported_color_modes: vec![0, 2, 1],
        }
    }

    #[test]
    fn a_tv_on_gnome_with_hdr_off() {
        let edid = edid::parse(&edid::tests::sample(Some(&[6, 0b0101, 1, 0x6E, 0x5A, 0x2E]))).unwrap();
        let d = display_from(Some("HDMI-A-1"), Some(&edid), Some(&tv_on_gnome(0)));
        assert_eq!(d.id, "HDMI-A-1/KIN1234-7");
        assert_eq!((d.name.as_str(), d.gdi_name.as_str(), d.connection.as_str()), ("Test TV", "HDMI-1", "HDMI"));
        assert_eq!((d.width, d.height, d.refresh_num, d.refresh_den), (1920, 1080, 60000, 1000));
        assert_eq!(d.hdr, HdrState::Off);
        assert_eq!(d.peak_nits.map(f32::round), Some(542.0));
        // Interlaced and repeated modes are left out.
        assert_eq!(d.modes.len(), 3);
        let notes = super::super::display_notes(&d);
        assert!(notes[0].contains("switched off"), "{notes:?}");
        assert!(notes[1].contains("23.976 Hz at 3840×2160"), "{notes:?}");
    }

    #[test]
    fn sdr_native_is_not_hdr() {
        // Colour mode 2 on, as the second stick round asked for by mistake.
        let d = display_from(Some("HDMI-A-1"), None, Some(&tv_on_gnome(2)));
        assert_eq!(d.hdr, HdrState::Off);
        let on = display_from(Some("HDMI-A-1"), None, Some(&tv_on_gnome(MUTTER_HDR)));
        assert_eq!(on.hdr, HdrState::On);
    }

    #[test]
    fn a_screen_on_another_desktop_still_says_what_its_edid_does() {
        let edid = edid::parse(&edid::tests::sample(Some(&[6, 0b0101, 1, 0x6E]))).unwrap();
        let d = display_from(Some("DP-1"), Some(&edid), None);
        assert_eq!(d.hdr, HdrState::Unknown);
        assert_eq!((d.width, d.modes.len()), (0, 0));
        let sdr = edid::parse(&edid::tests::sample(None)).unwrap();
        assert_eq!(display_from(Some("DP-1"), Some(&sdr), None).hdr, HdrState::Unsupported);
    }

    #[test]
    fn hdmi_outputs_are_named_as_mpv_names_them() {
        let hdmi = Pcm { device: 7, id: "HDMI 1".into() };
        assert_eq!(mpv_name("NVidia", &hdmi), "alsa/hdmi:CARD=NVidia,DEV=1");
        let analog = Pcm { device: 0, id: "Generic Analog".into() };
        assert_eq!(mpv_name("PCH", &analog), "alsa/plughw:CARD=PCH,DEV=0");
    }

    #[test]
    fn a_receiver_behind_hdmi_takes_what_its_eld_lists() {
        let e = eld::parse(&eld::tests::receiver()).unwrap();
        let pcm = Pcm { device: 3, id: "HDMI 0".into() };
        let a = hdmi_device("NVidia", "HDA NVidia", &pcm, &e);
        assert_eq!(a.name, "AV Receiver (HDA NVidia, HDMI 0)");
        assert_eq!(a.id, "alsa/hdmi:CARD=NVidia,DEV=0");
        assert!(a.bitstream.iter().all(|b| b.result == Probe::Yes));
        assert_eq!(a.max_pcm_channels, Some(8));
        assert!(super::super::audio_notes(&a).is_empty(), "{:?}", super::super::audio_notes(&a));
    }

    #[test]
    fn analogue_takes_nothing_and_spdif_cannot_say() {
        let analog = other_device("PCH", "HDA Intel PCH", &Pcm { device: 0, id: "Generic Analog".into() });
        assert_eq!(analog.connection, "analogue");
        assert!(analog.bitstream.iter().all(|b| b.result == Probe::No));
        let spdif = other_device("PCH", "HDA Intel PCH", &Pcm { device: 1, id: "Generic Digital".into() });
        assert_eq!(spdif.connection, "S/PDIF");
        let results: Vec<Probe> = spdif.bitstream.iter().map(|b| b.result).collect();
        assert_eq!(results, [Probe::Unknown, Probe::No, Probe::Unknown, Probe::No, Probe::No]);
    }
}
