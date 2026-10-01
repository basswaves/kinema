//! What this PC is connected to — its screens and audio outputs — and what
//! each of them can take.
//!
//! Step 1 of native output (docs/HISTORY.md → "Native output"). Nothing here
//! changes playback. It exists so that every later decision — which audio
//! formats to pass through untouched, which refresh rate to switch to, whether
//! HDR can be turned on — rests on what Windows actually reports rather than on
//! a guess, and so that one run on a machine nobody here can reach leaves a
//! complete account of it in `app.log`.
//!
//! Everything is read-only. The audio probe asks the driver whether it *would*
//! accept a format (`IAudioClient::IsFormatSupported`); it never opens the
//! device, so it cannot make a sound or take the device from anything else.
//!
//! The formats probed are **exactly** the ones mpv's WASAPI output builds for
//! each bitstream (`ao_wasapi_utils.c` and `ad_spdif.c`, checked against mpv
//! master in September 2026): same sample rate, channel count, mask and
//! sub-format. A "yes" here therefore means mpv's own open will succeed. That
//! matters because of what mpv does when its open *fails*: for anything but
//! AC3 it retries with the format relabelled as AC3, and a device that takes
//! AC3 then accepts a TrueHD stream it cannot play — silence or noise at the
//! receiver. Asking first, codec by codec, is the defence against that.

//!
//! On Linux (`linux.rs`) the same picture comes from the kernel, GNOME and
//! ALSA, and the bitstream answers from the receiver's own list (`eld.rs`)
//! rather than from a driver being asked.

// Some shared helpers (layouts, the exact WASAPI shapes) serve only the
// Windows reader. Windows' clippy still reports anything genuinely unused.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};

/// One look at the hardware, as Windows answers it right now.
#[derive(Debug, Clone, Serialize, Default)]
pub struct Equipment {
    /// Graphics adapters, by name. For the log: HDR and mode switching both
    /// depend on the driver, so a report without it is hard to read.
    pub gpus: Vec<String>,
    pub displays: Vec<Display>,
    pub audio: Vec<AudioDevice>,
    /// Anything that could not be read, in words. Detection is best effort per
    /// item: one screen failing to answer does not hide the others.
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Display {
    /// Stable across launches and reconnections: Windows' device path for the
    /// monitor, which carries its EDID maker and model and the port it is on.
    /// What the remembered equipment is keyed by.
    pub id: String,
    /// The monitor's own name, from its EDID ("<TV model>", "<monitor model>").
    pub name: String,
    /// Windows' name for the output, `\\.\DISPLAY1`. mpv's log uses the same.
    pub gdi_name: String,
    /// HDMI, DisplayPort, …
    pub connection: String,
    pub width: u32,
    pub height: u32,
    /// The exact current refresh rate, e.g. 24000/1001.
    pub refresh_num: u32,
    pub refresh_den: u32,
    pub hdr: HdrState,
    /// What the screen reports it can reach, in nits. Only filled in for a
    /// screen that supports HDR — an SDR panel reports a nominal figure that
    /// means nothing.
    pub peak_nits: Option<f32>,
    pub full_frame_nits: Option<f32>,
    pub min_nits: Option<f32>,
    pub bits_per_color: Option<u32>,
    /// Every progressive mode Windows offers for this screen.
    pub modes: Vec<Mode>,
    /// Plain-language findings, shown in Settings and written to the log.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HdrState {
    #[default]
    Unknown,
    Unsupported,
    /// The screen can do HDR and Windows has it switched off.
    Off,
    On,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Mode {
    pub width: u32,
    pub height: u32,
    /// The refresh rate as Windows lists it: a whole number.
    pub hz: u32,
    /// What that number means. Windows lists 23.976 Hz as `23` and 59.94 Hz as
    /// `59` — the NTSC rates are one below the round figure they are 1000/1001
    /// of. This is the convention madVR and Kodi rely on too.
    pub rate: f64,
}

impl Mode {
    pub fn new(width: u32, height: u32, hz: u32) -> Self {
        Mode { width, height, hz, rate: rate_meaning(hz) }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AudioDevice {
    pub name: String,
    pub id: String,
    /// Windows' default output — what mpv plays to today.
    pub is_default: bool,
    /// HDMI, S/PDIF, speakers, headphones, …
    pub connection: String,
    /// What the Windows mixer is set to for this device ("speaker setup").
    /// Everything played in shared mode is mixed to this.
    pub mix_channels: u16,
    pub mix_layout: String,
    pub mix_rate: u32,
    /// The most PCM channels the device takes directly, bypassing the mixer.
    /// `None` when that could not be asked.
    pub max_pcm_channels: Option<u16>,
    /// Windows spatial sound — "Dolby Atmos for home theater", "DTS:X for
    /// home theater", Windows Sonic — is on for this device, with this many
    /// dynamic objects. `None` when it is off. mpv does not use the spatial
    /// audio API those modes are fed through; with one on, mpv's ordinary
    /// stream failed to open on the test TV and the film played silent.
    #[serde(default)]
    pub spatial_objects: Option<u32>,
    /// Every answer the spatial audio API gave, for the log.
    #[serde(default)]
    pub spatial_detail: String,
    pub bitstream: Vec<BitstreamSupport>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BitstreamSupport {
    /// mpv's name for it, as `--audio-spdif` takes it.
    pub codec: String,
    pub label: String,
    pub result: Probe,
    /// The raw answer when it was neither yes nor no, for the log.
    pub detail: Option<String>,
    /// The device could not be asked this time — busy, or not answering — so
    /// this is what it said at an earlier check. See [`merge`].
    #[serde(default)]
    pub remembered: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Probe {
    Yes,
    No,
    /// Another program holds the device exclusively right now.
    Busy,
    /// Windows' "allow applications to take exclusive control" is off for this
    /// device. Passthrough cannot work until it is on.
    NotAllowed,
    Unknown,
}

/// One bitstream format, described exactly as mpv hands it to WASAPI.
pub struct Bitstream {
    pub codec: &'static str,
    pub label: &'static str,
    pub rate: u32,
    pub channels: u16,
    pub mask: u32,
}

const STEREO: u32 = 0x3;
/// FL FR FC LFE BL BR SL SR — mpv's default 8-channel layout.
const SEVEN_ONE: u32 = 0x63F;

/// In the order Settings lists them. Rates and channel counts are IEC 61937's:
/// the high-bitrate formats ride on eight channels at 192 kHz, E-AC3 on two at
/// 192 kHz, the rest on plain 48 kHz stereo.
pub const BITSTREAMS: [Bitstream; 5] = [
    Bitstream { codec: "ac3", label: "Dolby Digital", rate: 48_000, channels: 2, mask: STEREO },
    Bitstream {
        codec: "eac3",
        label: "Dolby Digital Plus (incl. Atmos)",
        rate: 192_000,
        channels: 2,
        mask: STEREO,
    },
    Bitstream { codec: "dts", label: "DTS", rate: 48_000, channels: 2, mask: STEREO },
    Bitstream {
        codec: "dts-hd",
        label: "DTS-HD Master Audio (incl. DTS:X)",
        rate: 192_000,
        channels: 8,
        mask: SEVEN_ONE,
    },
    Bitstream {
        codec: "truehd",
        label: "Dolby TrueHD (incl. Atmos)",
        rate: 192_000,
        channels: 8,
        mask: SEVEN_ONE,
    },
];

// ---- interpretation (pure, tested) -------------------------------------------

/// Windows' whole-number refresh rate → the rate it stands for.
pub fn rate_meaning(hz: u32) -> f64 {
    match hz {
        23 | 29 | 47 | 59 | 119 => f64::from(hz + 1) * 1000.0 / 1001.0,
        _ => f64::from(hz),
    }
}

/// `23.976`, `24`, `59.94` — as a person writes them.
pub fn format_rate(rate: f64) -> String {
    let s = format!("{rate:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

fn exact_rate(num: u32, den: u32) -> f64 {
    if den == 0 {
        0.0
    } else {
        f64::from(num) / f64::from(den)
    }
}

pub fn layout_name(channels: u16, mask: u32) -> String {
    match mask {
        0x4 => "mono".into(),
        0x3 => "stereo".into(),
        0xB => "2.1".into(),
        0x33 | 0x603 => "quad".into(),
        0x3F => "5.1".into(),
        0x60F => "5.1 (side)".into(),
        0x63F => "7.1".into(),
        _ => match channels {
            1 => "mono".into(),
            2 => "stereo".into(),
            6 => "5.1".into(),
            8 => "7.1".into(),
            n => format!("{n} channels"),
        },
    }
}

/// Films are 23.976 fps; a screen shows them without 3:2 judder only at a
/// whole multiple of that. Plain 24 Hz counts too: one repeated frame every
/// ~42 seconds is invisible next to 3:2 cadence on every frame.
fn is_film_rate(rate: f64) -> bool {
    [23.976, 24.0, 47.952, 48.0, 119.88, 120.0].iter().any(|r| (rate - r).abs() < 0.01)
}

/// The resolutions at which a film rate is on offer, highest first.
pub fn film_modes(modes: &[Mode]) -> Vec<&Mode> {
    let mut out: Vec<&Mode> = modes.iter().filter(|m| is_film_rate(m.rate)).collect();
    out.sort_by(|a, b| {
        (b.width * b.height)
            .cmp(&(a.width * a.height))
            .then(a.rate.partial_cmp(&b.rate).unwrap_or(std::cmp::Ordering::Equal))
    });
    out
}

/// Who sets the screens up, for the notes: Windows, or on Linux the desktop
/// (GNOME, KDE…), which is where HDR and the mode are switched.
const SCREEN_OWNER: &str = if cfg!(windows) { "Windows" } else { "the desktop" };

pub fn display_notes(d: &Display) -> Vec<String> {
    let mut notes = Vec::new();
    match d.hdr {
        HdrState::On => notes.push(match d.peak_nits {
            Some(p) => format!("HDR is on. The screen reports a peak of {p:.0} nits."),
            None => "HDR is on.".into(),
        }),
        HdrState::Off => notes.push(format!(
            "Supports HDR, but {SCREEN_OWNER} has it switched off, so HDR videos are converted \
             to SDR on this screen until it is on."
        )),
        HdrState::Unsupported => notes.push("SDR screen: HDR videos are converted to SDR.".into()),
        // On Linux "unknown" is a screen whose EDID offers HDR on a desktop
        // that is not asked (linux.rs).
        HdrState::Unknown => notes.push(if cfg!(windows) {
            "Windows did not say whether this screen does HDR.".into()
        } else {
            "The screen can show HDR; whether it is switched on, the desktop did not say.".into()
        }),
    }

    let native = d.modes.iter().any(|m| m.width == d.width && m.height == d.height);
    let film = film_modes(&d.modes);
    let at_native: Vec<String> = film
        .iter()
        .filter(|m| m.width == d.width && m.height == d.height)
        .map(|m| format_rate(m.rate))
        .collect();
    if !at_native.is_empty() {
        notes.push(format!(
            "Can show movies without judder: {} Hz at {}×{}.",
            at_native.join(" / "),
            d.width,
            d.height
        ));
    } else if let Some(best) = film.first() {
        let rates: Vec<String> = film
            .iter()
            .filter(|m| (m.width, m.height) == (best.width, best.height))
            .map(|m| format_rate(m.rate))
            .collect();
        notes.push(if best.width * best.height > d.width * d.height {
            // A 4K TV the desktop left at 1080p, as GNOME does by default.
            format!(
                "Can show movies without judder at {} Hz at {}×{}, above the {}×{} the screen \
                 is set to now.",
                rates.join(" / "),
                best.width,
                best.height,
                d.width,
                d.height
            )
        } else {
            format!(
                "A 24 Hz mode is only offered at a lower resolution: {} Hz at {}×{}.",
                rates.join(" / "),
                best.width,
                best.height
            )
        });
    } else if native {
        notes.push(
            "No 24 Hz mode: movies play with 3:2 judder on this screen, whatever the setting."
                .into(),
        );
    }
    notes
}

pub fn audio_notes(a: &AudioDevice) -> Vec<String> {
    let mut notes = Vec::new();
    if a.bitstream.iter().any(|b| b.result == Probe::NotAllowed) {
        notes.push(
            "Windows does not let programs take exclusive control of this device, which \
             passing audio through untouched needs. Sound settings → this device → Advanced."
                .into(),
        );
    } else if a.bitstream.iter().any(|b| b.remembered) {
        notes.push(
            "Could not be asked this time (another program had it to itself, or it did not \
             answer), so these are its answers from the last check that worked."
                .into(),
        );
    } else if a.bitstream.iter().any(|b| b.result == Probe::Busy) {
        notes.push(
            "Another program had this device to itself, so what it accepts could not be \
             checked. Close it and check again."
                .into(),
        );
    }

    // What it does take is not repeated here: Settings shows each format's
    // answer beside the device, and the log line lists them all.
    if a.bitstream.iter().all(|b| b.result == Probe::No) {
        notes.push("Takes no compressed surround formats: everything has to be decoded.".into());
    }

    let takes = |codec: &str| {
        a.bitstream.iter().any(|b| b.codec == codec && b.result == Probe::Yes)
    };
    let refuses = |codec: &str| {
        a.bitstream.iter().any(|b| b.codec == codec && b.result == Probe::No)
    };
    if a.connection == "HDMI" && takes("ac3") && refuses("truehd") && refuses("dts-hd") {
        notes.push(
            "Takes Dolby Digital but not TrueHD or DTS-HD, which is typical of a TV rather than a \
             receiver. If a receiver sits behind this TV, connecting the PC to the receiver \
             directly usually unlocks the lossless formats."
                .into(),
        );
    }

    // Only over HDMI does "takes 8 channels" describe the equipment on the far
    // end — the receiver's EDID. An analogue jack reports what the sound chip
    // can drive, which says nothing about the two speakers plugged into it.
    if a.spatial_objects.is_some() {
        notes.push(
            "Windows spatial sound (Dolby Atmos or DTS:X for home theater, or Windows Sonic) \
             is on for this device. Sound played through Windows is decoded to 7.1 first and \
             then re-wrapped by Windows, so the receiver may say Atmos, but a film's own \
             Atmos or DTS:X height and object sound does not survive. Sending sound straight \
             to the receiver keeps it."
                .into(),
        );
    }

    // A mixer setting of 0 is one that was not read (Linux: PipeWire's own
    // layout is not asked yet).
    if let (Some(max), "HDMI") = (a.max_pcm_channels, a.connection.as_str()) {
        if a.mix_channels > 0 && a.mix_channels < max && a.mix_channels <= 2 {
            notes.push(format!(
                "Windows is set to {} for this device, though it takes {} channels directly. \
                 Anything mixed by Windows is folded down to {}.",
                a.mix_layout,
                max,
                a.mix_layout
            ));
        }
    }
    notes
}

// ---- remembering ---------------------------------------------------------------

/// A device as the app knows it across launches.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Seen<T> {
    #[serde(flatten)]
    pub item: T,
    /// Present at the latest check.
    pub connected: bool,
    /// Unix seconds.
    pub first_seen: i64,
    pub last_seen: i64,
    /// Never seen before the latest check.
    #[serde(default)]
    pub new: bool,
}

/// Everything ever seen, stored as JSON under [`MEMORY_KEY`].
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Remembered {
    #[serde(default)]
    pub displays: Vec<Seen<Display>>,
    #[serde(default)]
    pub audio: Vec<Seen<AudioDevice>>,
}

/// What Settings shows and later steps decide from: the latest check, filled
/// in from memory where a device could not answer, plus every device seen
/// before that is not connected now.
#[derive(Debug, Clone, Serialize, Default)]
pub struct EquipmentView {
    pub gpus: Vec<String>,
    pub displays: Vec<Seen<Display>>,
    pub audio: Vec<Seen<AudioDevice>>,
    pub problems: Vec<String>,
    /// Unix seconds.
    pub checked_at: i64,
}

/// Settings key for [`Remembered`]. A JSON value in the settings table rather
/// than tables of its own, so remembering devices needs no database upgrade.
pub const MEMORY_KEY: &str = "equipment_memory";

fn answered(p: Probe) -> bool {
    matches!(p, Probe::Yes | Probe::No)
}

/// Fold a fresh check into memory.
///
/// Every launch checks everything — it takes a tenth of a second, and it
/// catches what changes without a device being plugged in (HDR switched on in
/// Windows, a new speaker setup). Memory is for the case the check cannot
/// cover: a receiver that is busy or does not answer at launch keeps the
/// answers it gave last time, marked `remembered`, instead of looking like one
/// that takes nothing. An answer it *does* give always replaces the old one.
pub fn merge(memory: &Remembered, fresh: Equipment, now: i64) -> (EquipmentView, Remembered) {
    fn fold<T: Clone>(
        known: &[Seen<T>],
        fresh: Vec<T>,
        key: impl Fn(&T) -> String,
        mut fill: impl FnMut(&mut T, &T),
        now: i64,
    ) -> Vec<Seen<T>> {
        let mut out: Vec<Seen<T>> = fresh
            .into_iter()
            .map(|mut item| {
                let before = known.iter().find(|k| key(&k.item) == key(&item));
                if let Some(before) = before {
                    fill(&mut item, &before.item);
                }
                Seen {
                    item,
                    connected: true,
                    first_seen: before.map_or(now, |b| b.first_seen),
                    last_seen: now,
                    new: before.is_none(),
                }
            })
            .collect();
        for k in known {
            if !out.iter().any(|o| key(&o.item) == key(&k.item)) {
                out.push(Seen { connected: false, new: false, ..k.clone() });
            }
        }
        out
    }

    let display_key = |d: &Display| if d.id.is_empty() { d.name.clone() } else { d.id.clone() };
    let displays = fold(&memory.displays, fresh.displays, display_key, |_, _| {}, now);

    let audio = fold(
        &memory.audio,
        fresh.audio,
        |a: &AudioDevice| a.id.clone(),
        |now_: &mut AudioDevice, before: &AudioDevice| {
            for b in &mut now_.bitstream {
                // A refusal of exclusive access is a real, current answer:
                // passthrough cannot work until it changes, so memory must
                // not paper over it.
                if answered(b.result) || b.result == Probe::NotAllowed {
                    continue;
                }
                if let Some(old) = before.bitstream.iter().find(|o| o.codec == b.codec) {
                    if answered(old.result) {
                        b.result = old.result;
                        b.detail = None;
                        b.remembered = true;
                    }
                }
            }
            if now_.max_pcm_channels.is_none() {
                now_.max_pcm_channels = before.max_pcm_channels;
            }
        },
        now,
    );

    let mut view = EquipmentView {
        gpus: fresh.gpus,
        displays,
        audio,
        problems: fresh.problems,
        checked_at: now,
    };
    for d in view.displays.iter_mut().filter(|d| d.connected) {
        d.item.notes = display_notes(&d.item);
    }
    for a in view.audio.iter_mut().filter(|a| a.connected) {
        a.item.notes = audio_notes(&a.item);
    }
    let memory = Remembered {
        displays: view.displays.iter().map(|d| Seen { new: false, ..d.clone() }).collect(),
        audio: view.audio.iter().map(|a| Seen { new: false, ..a.clone() }).collect(),
    };
    (view, memory)
}

/// The account of this machine written to `app.log`, one line each.
pub fn summary(view: &EquipmentView) -> Vec<String> {
    let mut lines = Vec::new();
    for gpu in &view.gpus {
        lines.push(format!("gpu {gpu}"));
    }
    let days_ago = |t: i64| (view.checked_at - t).max(0) / 86_400;
    for seen in view.displays.iter().filter(|d| !d.connected) {
        lines.push(format!(
            "display \"{}\" not connected (last seen {} day(s) ago)",
            seen.item.name,
            days_ago(seen.last_seen)
        ));
    }
    for seen in view.displays.iter().filter(|d| d.connected) {
        let d = &seen.item;
        lines.push(format!(
            "display {} \"{}\"{} via {}: {}×{} @ {} Hz ({}/{}), HDR {:?}{}{}",
            d.gdi_name,
            d.name,
            if seen.new { " (new)" } else { "" },
            d.connection,
            d.width,
            d.height,
            format_rate(exact_rate(d.refresh_num, d.refresh_den)),
            d.refresh_num,
            d.refresh_den,
            d.hdr,
            d.peak_nits.map(|p| format!(", peak {p:.0} nits")).unwrap_or_default(),
            d.bits_per_color.map(|b| format!(", {b}-bit")).unwrap_or_default(),
        ));
        // Grouped by resolution: "1920×1080@23.976/24".
        let mut film: Vec<String> = Vec::new();
        let mut last: Option<(u32, u32)> = None;
        for m in film_modes(&d.modes) {
            if last == Some((m.width, m.height)) {
                if let Some(entry) = film.last_mut() {
                    entry.push_str(&format!("/{}", format_rate(m.rate)));
                }
            } else {
                film.push(format!("{}×{}@{}", m.width, m.height, format_rate(m.rate)));
                last = Some((m.width, m.height));
            }
        }
        lines.push(format!(
            "display {} modes: {} total; film rates: {}",
            d.gdi_name,
            d.modes.len(),
            if film.is_empty() { "none".into() } else { film.join(" ") }
        ));
        for n in &d.notes {
            lines.push(format!("display {}: {n}", d.gdi_name));
        }
    }
    for seen in view.audio.iter().filter(|a| !a.connected) {
        lines.push(format!(
            "audio \"{}\" not connected (last seen {} day(s) ago)",
            seen.item.name,
            days_ago(seen.last_seen)
        ));
    }
    for seen in view.audio.iter().filter(|a| a.connected) {
        let a = &seen.item;
        let formats: Vec<String> = a
            .bitstream
            .iter()
            .map(|b| {
                format!(
                    "{}={}{}",
                    b.codec,
                    match (&b.result, &b.detail) {
                        (Probe::Unknown, Some(d)) => d.clone(),
                        (p, _) => format!("{p:?}").to_lowercase(),
                    },
                    if b.remembered { "(remembered)" } else { "" }
                )
            })
            .collect();
        // The Windows mixer and spatial sound exist only there; elsewhere the
        // device's id says what mpv will call it.
        let mixer = if a.mix_channels > 0 {
            format!(
                "Windows mixes to {} @ {} Hz; spatial sound {} [{}]",
                a.mix_layout,
                a.mix_rate,
                a.spatial_objects.map_or("off".to_string(), |n| format!("on ({n} objects)")),
                a.spatial_detail,
            )
        } else {
            format!("device {}", a.id)
        };
        lines.push(format!(
            "audio \"{}\"{}{} via {}: {mixer}; direct PCM up to {}; bitstream {}",
            a.name,
            if seen.new { " (new)" } else { "" },
            if a.is_default { " (default)" } else { "" },
            a.connection,
            a.max_pcm_channels.map(|c| format!("{c} ch")).unwrap_or_else(|| "unknown".into()),
            formats.join(" "),
        ));
        for n in &a.notes {
            lines.push(format!("audio \"{}\": {n}", a.name));
        }
    }
    for p in &view.problems {
        lines.push(format!("could not read: {p}"));
    }
    lines
}

// ---- entry points ------------------------------------------------------------

/// Whether this build can look at the screens and audio outputs at all
/// (`capabilities.rs`). Where it cannot, `detect` says so as a problem.
pub const DETECTS: bool = cfg!(any(windows, target_os = "linux"));

/// Whether sound can be sent straight to the receiver with the formats found
/// here (Settings → Sound). Windows only until Linux has its own way
/// (notes: PORTING, phase 4 step 2): the plan names WASAPI devices.
pub const DIRECT_AUDIO: bool = cfg!(windows);

/// Look at everything, as the system answers right now. Blocking, but quick —
/// about a tenth of a second for three audio devices and two screens.
pub fn detect() -> Equipment {
    #[cfg(windows)]
    return win::detect();
    #[cfg(target_os = "linux")]
    return linux::detect();
    #[cfg(not(any(windows, target_os = "linux")))]
    Equipment { problems: vec!["equipment detection is not written for this system".into()], ..Default::default() }
}

/// On a thread of its own, so COM can be initialised the way the audio API
/// wants without caring what the calling thread already did with it.
fn detect_on_own_thread() -> Equipment {
    std::thread::spawn(detect).join().unwrap_or_else(|_| Equipment {
        problems: vec!["equipment detection crashed".into()],
        ..Default::default()
    })
}

/// The latest view, and a lock that makes checks take turns: Settings opened
/// while the launch check is still running waits for it rather than starting
/// a second one.
#[derive(Default)]
pub struct EquipmentState {
    latest: std::sync::Mutex<Option<EquipmentView>>,
    checking: std::sync::Mutex<()>,
}

/// Check, fold into memory, save, log. The one path every check goes through.
fn check(app: &tauri::AppHandle) -> Result<EquipmentView, String> {
    use tauri::Manager;
    let fresh = detect_on_own_thread();
    let db = app.state::<crate::library::Db>();
    let view = {
        let conn = db.0.lock().map_err(crate::util::to_string_err)?;
        // Unreadable memory (a future format, a hand edit) is started over
        // rather than trusted: the worst that costs is one launch without
        // remembered answers.
        let memory: Remembered = crate::settings::setting(&conn, MEMORY_KEY)
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        let (view, memory) = merge(&memory, fresh, crate::util::now_secs());
        let json = serde_json::to_string(&memory).map_err(crate::util::to_string_err)?;
        crate::settings::store(&conn, MEMORY_KEY, &json)?;
        view
    };
    for line in summary(&view) {
        crate::log!("equipment: {line}");
    }
    *app.state::<EquipmentState>().latest.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(view.clone());
    Ok(view)
}

fn check_in_turn(app: &tauri::AppHandle) -> Result<EquipmentView, String> {
    use tauri::Manager;
    let state = app.state::<EquipmentState>();
    let _turn = state.checking.lock().unwrap_or_else(|e| e.into_inner());
    check(app)
}

/// Check once per launch, in the background, so the saved answers are fresh
/// and a log from any machine says what it was connected to.
pub fn check_at_startup(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = check_in_turn(&app) {
            crate::log!("equipment: launch check failed: {e}");
        }
    });
}

/// What Settings shows when it opens: this launch's check, without asking
/// the hardware again.
#[tauri::command]
pub async fn get_equipment(app: tauri::AppHandle) -> Result<EquipmentView, String> {
    crate::jobs::off_main(move || {
        use tauri::Manager;
        let state = app.state::<EquipmentState>();
        let _turn = state.checking.lock().unwrap_or_else(|e| e.into_inner());
        let latest = state.latest.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match latest {
            Some(view) => Ok(view),
            None => check(&app),
        }
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowDisplay {
    pub gdi_name: String,
    pub hdr: HdrState,
}

/// Whether the screen the window is on has HDR switched on right now.
///
/// The player asks this before every file and tells mpv to send HDR only when
/// it is. Left to itself mpv sends HDR10 even to an SDR screen (tested on the
/// development monitor here, with `target-colorspace-hint` both `yes` and `auto`), and Windows
/// then converts it down — so mpv's own BT.2390 tone mapping, the one this
/// project chose on purpose, never ran on an SDR screen at all.
#[tauri::command]
pub fn window_display(window: tauri::WebviewWindow) -> WindowDisplay {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        let (gdi_name, hdr) = win::hdr_for_window(hwnd);
        return WindowDisplay { gdi_name, hdr };
    }
    #[cfg(not(windows))]
    let _ = window;
    WindowDisplay { gdi_name: String::new(), hdr: HdrState::Unknown }
}

/// Settings → Check again: ask every connected device again, and save the
/// answers over the old ones.
#[tauri::command]
pub async fn check_equipment(app: tauri::AppHandle) -> Result<EquipmentView, String> {
    crate::jobs::off_main(move || check_in_turn(&app)).await
}

// ---- the systems ---------------------------------------------------------------

#[cfg(windows)]
pub(crate) mod win;

#[cfg(target_os = "linux")]
pub(crate) mod linux;

/// What screens and receivers say about themselves, read where the system
/// hands over the raw bytes (Linux). Compiled everywhere so their tests run on
/// every machine.
mod edid;
mod eld;

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(w: u32, h: u32, hz: u32) -> Mode {
        Mode::new(w, h, hz)
    }

    #[test]
    fn windows_whole_number_rates_mean_the_ntsc_ones() {
        assert_eq!(format_rate(rate_meaning(23)), "23.976");
        assert_eq!(format_rate(rate_meaning(24)), "24");
        assert_eq!(format_rate(rate_meaning(59)), "59.94");
        assert_eq!(format_rate(rate_meaning(60)), "60");
        assert_eq!(format_rate(rate_meaning(119)), "119.88");
        assert_eq!(format_rate(rate_meaning(50)), "50");
    }

    #[test]
    fn film_modes_find_every_multiple_of_24_and_nothing_else() {
        let modes = [
            mode(3840, 2160, 60),
            mode(3840, 2160, 23),
            mode(3840, 2160, 50),
            mode(1920, 1080, 24),
            mode(1920, 1080, 119),
            mode(1920, 1080, 30),
        ];
        let film: Vec<String> = film_modes(&modes)
            .iter()
            .map(|m| format!("{}@{}", m.height, format_rate(m.rate)))
            .collect();
        assert_eq!(film, ["2160@23.976", "1080@24", "1080@119.88"]);
    }

    fn display(w: u32, h: u32, hdr: HdrState, modes: Vec<Mode>) -> Display {
        Display { width: w, height: h, hdr, modes, ..Default::default() }
    }

    #[test]
    fn a_4k_tv_with_24p_says_films_play_without_judder() {
        let d = display(
            3840,
            2160,
            HdrState::Off,
            vec![mode(3840, 2160, 60), mode(3840, 2160, 23), mode(3840, 2160, 24)],
        );
        let notes = display_notes(&d);
        assert!(notes[0].contains("switched off"), "{notes:?}");
        assert!(notes[1].contains("23.976 / 24 Hz at 3840×2160"), "{notes:?}");
    }

    #[test]
    fn a_monitor_offering_24p_only_below_native() {
        // The real mode list of a 2560×1600 development monitor.
        let d = display(
            2560,
            1600,
            HdrState::Unsupported,
            vec![mode(2560, 1600, 60), mode(1920, 1080, 60), mode(1920, 1080, 24), mode(1920, 1080, 23)],
        );
        let notes = display_notes(&d);
        assert!(notes[0].starts_with("SDR screen"), "{notes:?}");
        assert!(notes[1].contains("only offered at a lower resolution"), "{notes:?}");
        assert!(notes[1].contains("1920×1080"), "{notes:?}");
    }

    #[test]
    fn a_60hz_only_screen_owns_up_to_judder() {
        let d = display(1920, 1080, HdrState::Unsupported, vec![mode(1920, 1080, 60), mode(1920, 1080, 50)]);
        assert!(display_notes(&d)[1].contains("3:2 judder"));
    }

    fn device(connection: &str, results: [Probe; 5], mix: (u16, &str), max_pcm: Option<u16>) -> AudioDevice {
        AudioDevice {
            name: "test".into(),
            connection: connection.into(),
            mix_channels: mix.0,
            mix_layout: mix.1.into(),
            max_pcm_channels: max_pcm,
            bitstream: BITSTREAMS
                .iter()
                .zip(results)
                .map(|(b, result)| BitstreamSupport {
                    codec: b.codec.into(),
                    label: b.label.into(),
                    result,
                    detail: None,
                    remembered: false,
                })
                .collect(),
            ..Default::default()
        }
    }

    use Probe::{Busy, No, NotAllowed, Yes};

    #[test]
    fn a_receiver_that_takes_everything_has_nothing_to_warn_about() {
        let a = device("HDMI", [Yes; 5], (8, "7.1"), Some(8));
        assert!(audio_notes(&a).is_empty(), "{:?}", audio_notes(&a));
    }

    #[test]
    fn a_tv_that_takes_only_the_lossy_formats_is_called_out() {
        let a = device("HDMI", [Yes, Yes, No, No, No], (2, "stereo"), Some(8));
        let notes = audio_notes(&a);
        assert!(notes.iter().any(|n| n.contains("typical of a TV")), "{notes:?}");
        assert!(notes.iter().any(|n| n.contains("Windows is set to stereo")), "{notes:?}");
    }

    #[test]
    fn onboard_stereo_says_everything_is_decoded_and_nothing_else() {
        // What this machine's onboard output answered.
        // Its jack reports 8 channels; that is the chip, not the speakers.
        let a = device("speakers", [No; 5], (2, "stereo"), Some(8));
        assert_eq!(
            audio_notes(&a),
            ["Takes no compressed surround formats: everything has to be decoded."]
        );
    }

    #[test]
    fn a_blocked_or_busy_device_says_why_it_could_not_be_asked() {
        let blocked = device("HDMI", [NotAllowed; 5], (2, "stereo"), None);
        assert!(audio_notes(&blocked)[0].contains("exclusive control"));
        let busy = device("HDMI", [Busy; 5], (2, "stereo"), None);
        assert!(audio_notes(&busy)[0].contains("Another program"));
        // Neither claims the device takes nothing: it was never answered.
        assert!(!audio_notes(&busy).iter().any(|n| n.contains("no compressed")));
    }

    #[test]
    fn layouts_are_named_by_mask_first() {
        assert_eq!(layout_name(6, 0x60F), "5.1 (side)");
        assert_eq!(layout_name(8, 0x63F), "7.1");
        assert_eq!(layout_name(2, 0), "stereo");
        assert_eq!(layout_name(10, 0), "10 channels");
    }

    #[test]
    fn the_probed_formats_match_what_mpv_sends() {
        // ad_spdif.c: TrueHD and DTS-HD MA ride on 8 ch @ 192 kHz, E-AC3 on
        // 2 ch @ 192 kHz, AC3 and DTS core on 2 ch @ 48 kHz. If these drift
        // from mpv, a "yes" here stops meaning mpv's open will succeed.
        let shape: Vec<(&str, u32, u16)> =
            BITSTREAMS.iter().map(|b| (b.codec, b.rate, b.channels)).collect();
        assert_eq!(
            shape,
            [
                ("ac3", 48_000, 2),
                ("eac3", 192_000, 2),
                ("dts", 48_000, 2),
                ("dts-hd", 192_000, 8),
                ("truehd", 192_000, 8)
            ]
        );
    }

    fn receiver(results: [Probe; 5]) -> AudioDevice {
        AudioDevice { id: "avr".into(), name: "AV receiver".into(), ..device("HDMI", results, (8, "7.1"), Some(8)) }
    }

    fn fresh(audio: Vec<AudioDevice>, displays: Vec<Display>) -> Equipment {
        Equipment { audio, displays, ..Default::default() }
    }

    fn tv() -> Display {
        Display { id: "tv-path".into(), name: "TV".into(), ..Default::default() }
    }

    #[test]
    fn a_device_seen_for_the_first_time_is_new() {
        let (view, memory) = merge(&Remembered::default(), fresh(vec![receiver([Yes; 5])], vec![tv()]), 100);
        assert!(view.audio[0].new && view.audio[0].connected);
        assert_eq!(view.audio[0].first_seen, 100);
        assert!(view.displays[0].new);
        // What is saved is never "new": that belongs to one check.
        assert!(!memory.audio[0].new && !memory.displays[0].new);
    }

    #[test]
    fn a_device_seen_before_keeps_its_first_sighting() {
        let (_, memory) = merge(&Remembered::default(), fresh(vec![receiver([Yes; 5])], vec![]), 100);
        let (view, _) = merge(&memory, fresh(vec![receiver([Yes; 5])], vec![]), 200);
        assert!(!view.audio[0].new);
        assert_eq!((view.audio[0].first_seen, view.audio[0].last_seen), (100, 200));
    }

    #[test]
    fn an_unplugged_device_is_remembered_as_not_connected() {
        let (_, memory) = merge(&Remembered::default(), fresh(vec![receiver([Yes; 5])], vec![tv()]), 100);
        let (view, memory) = merge(&memory, fresh(vec![], vec![]), 200);
        assert_eq!(view.audio.len(), 1);
        assert!(!view.audio[0].connected);
        assert_eq!(view.audio[0].last_seen, 100);
        assert!(!view.displays[0].connected);
        // And plugged back in, it is the same device, not a new one.
        let (view, _) = merge(&memory, fresh(vec![receiver([Yes; 5])], vec![tv()]), 300);
        assert!(view.audio[0].connected && !view.audio[0].new);
        assert_eq!(view.audio[0].first_seen, 100);
    }

    #[test]
    fn a_receiver_busy_at_launch_keeps_the_answers_it_gave_before() {
        let (_, memory) = merge(&Remembered::default(), fresh(vec![receiver([Yes, Yes, Yes, No, Yes])], vec![]), 100);
        let mut busy = receiver([Busy; 5]);
        busy.max_pcm_channels = None;
        let (view, memory) = merge(&memory, fresh(vec![busy], vec![]), 200);
        let a = &view.audio[0].item;
        let results: Vec<Probe> = a.bitstream.iter().map(|b| b.result).collect();
        assert_eq!(results, [Yes, Yes, Yes, No, Yes]);
        assert!(a.bitstream.iter().all(|b| b.remembered));
        assert_eq!(a.max_pcm_channels, Some(8));
        assert!(a.notes[0].contains("answers from the last check"), "{:?}", a.notes);
        // Still remembered after a second busy launch.
        let (view, _) = merge(&memory, fresh(vec![receiver([Busy; 5])], vec![]), 300);
        assert_eq!(view.audio[0].item.bitstream[4].result, Yes);
    }

    #[test]
    fn a_fresh_answer_always_replaces_a_remembered_one() {
        let (_, memory) = merge(&Remembered::default(), fresh(vec![receiver([Yes; 5])], vec![]), 100);
        // Recabled through a TV: the lossless formats are gone. That must win.
        let (view, _) = merge(&memory, fresh(vec![receiver([Yes, Yes, No, No, No])], vec![]), 200);
        let a = &view.audio[0].item;
        assert_eq!(a.bitstream[4].result, No);
        assert!(!a.bitstream.iter().any(|b| b.remembered));
    }

    #[test]
    fn exclusive_access_switched_off_is_not_papered_over() {
        let (_, memory) = merge(&Remembered::default(), fresh(vec![receiver([Yes; 5])], vec![]), 100);
        let (view, _) = merge(&memory, fresh(vec![receiver([NotAllowed; 5])], vec![]), 200);
        let a = &view.audio[0].item;
        assert!(a.bitstream.iter().all(|b| b.result == NotAllowed && !b.remembered));
        assert!(a.notes[0].contains("exclusive control"));
    }

    #[test]
    fn memory_survives_the_round_trip_through_settings() {
        let (_, memory) = merge(&Remembered::default(), fresh(vec![receiver([Yes; 5])], vec![tv()]), 100);
        let json = serde_json::to_string(&memory).unwrap();
        let back: Remembered = serde_json::from_str(&json).unwrap();
        assert_eq!(back.audio[0].item.id, "avr");
        assert_eq!(back.audio[0].item.bitstream[4].result, Yes);
        assert_eq!(back.displays[0].item.id, "tv-path");
        // Flattened: the device's own fields sit beside `connected`, which is
        // the shape the frontend reads.
        assert!(json.contains(r#""name":"AV receiver""#) && json.contains(r#""connected":true"#));
    }

    /// Runs the real detection against this machine and prints the log lines.
    /// Ignored by default because it depends on the hardware present.
    #[test]
    #[ignore]
    fn print_this_machine() {
        let (view, _) = merge(&Remembered::default(), detect(), crate::util::now_secs());
        for line in summary(&view) {
            println!("{line}");
        }
    }
}
