//! What is inside each file: picture, sound and subtitles, read with ffprobe.
//!
//! This is what the detail page's badges are made from — 4K, Dolby Vision
//! profile 7 FEL, HDR10+, TrueHD Atmos 7.1, 23.976 — so it has to be the file's
//! own account of itself, never the release name's. A file called `…DV…` that
//! has no Dolby Vision in it gets no Dolby Vision badge.
//!
//! **Invoked, never shipped**, like everything else ffmpeg does here (see
//! `ffmpeg.rs`). Without ffprobe the scan skips this step and the badges that
//! need it are simply not shown.
//!
//! Two ffprobe runs per file, both short:
//!
//! 1. **The streams**, from the container's headers. Codec, size, frame rate,
//!    bit depth, HDR transfer, the Dolby Vision configuration record, every
//!    audio and subtitle track. ffprobe names object audio itself — its
//!    `profile` for TrueHD reads "Dolby TrueHD + Dolby Atmos", for DTS
//!    "DTS-HD MA + DTS:X" — so nothing here second-guesses it.
//! 2. **The first two frames of the main video**, decoded. HDR10+ and the
//!    Dolby Vision RPU travel inside the video itself rather than in the
//!    headers, and the RPU is the only place that says whether a profile 7
//!    enhancement layer is full (FEL) or minimal (MEL). About 0.2 s for a 4K
//!    frame.
//!
//! Everything is read once and kept in `media_probe`; a file is read again only
//! when its size or modification time changes, or when [`PROBE_VERSION`] is
//! raised.

use crate::library::Db;
use crate::util::{now_secs, to_string_err};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::{Emitter, Manager};

/// Raise to read every file again, after a change to what is read or how.
///
/// 2: the video's stream index, which the aspect measurement needs.
pub const PROBE_VERSION: i64 = 2;

/// Emitted once per file, so the scan can say how far it has got.
const PROGRESS_EVENT: &str = "probe-progress";

// ---- what is kept ----------------------------------------------------------

/// Everything the detail page may want to know about one file.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct MediaDetails {
    /// ffprobe's own name for the container, e.g. `matroska,webm`.
    pub container: Option<String>,
    pub duration_secs: Option<f64>,
    /// Bits per second across the whole file.
    pub bit_rate: Option<u64>,
    /// The main picture. `None` for a file with no video, or only cover art.
    pub video: Option<Video>,
    pub audio: Vec<Audio>,
    pub subtitles: Vec<Subtitle>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Video {
    /// Which stream in the file this is, for tools that must pick the same
    /// one (`aspect.rs`). Absent from details read before version 2.
    #[serde(default)]
    pub stream_index: Option<u32>,
    /// ffprobe's codec name: `hevc`, `h264`, `av1`, `vc1`, `mpeg2video`…
    pub codec: String,
    /// `Main 10`, `High`… as ffprobe reports it.
    pub profile: Option<String>,
    pub width: u32,
    pub height: u32,
    pub bit_depth: Option<u8>,
    /// Frames per second: 23.976… is kept as 24000/1001 works out, not rounded.
    pub frame_rate: Option<f64>,
    pub interlaced: bool,
    /// Width over height of the picture as stored, pixel shape included. Black
    /// bars that are part of the picture count as picture here.
    pub aspect_ratio: Option<f64>,
    pub transfer: Transfer,
    pub hdr10_plus: bool,
    pub dolby_vision: Option<DolbyVision>,
    /// The brightest the mastering display could go, in nits.
    pub mastering_peak_nits: Option<f64>,
    /// MaxCLL and MaxFALL, in nits.
    pub max_cll: Option<u32>,
    pub max_fall: Option<u32>,
}

/// How brightness is encoded.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Transfer {
    #[default]
    Sdr,
    /// SMPTE ST 2084 — what HDR10, HDR10+ and most Dolby Vision are built on.
    Pq,
    Hlg,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct DolbyVision {
    pub profile: u8,
    pub level: Option<u8>,
    /// The base layer's fallback: 1 HDR10, 2 SDR, 4 HLG, 6 Blu-ray; 0 none.
    pub compatibility: Option<u8>,
    /// Only for a file carrying an enhancement layer (profile 7), and only when
    /// its RPU could be read. `None` otherwise — never guessed.
    pub enhancement_layer: Option<EnhancementLayer>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnhancementLayer {
    /// Full: the enhancement layer carries real picture — 12-bit detail the
    /// HDR10 base layer does not have.
    #[serde(rename = "FEL")]
    Full,
    /// Minimal: the layer is there but empty; only the RPU matters.
    #[serde(rename = "MEL")]
    Minimal,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Audio {
    /// `truehd`, `eac3`, `dts`, `ac3`, `aac`, `flac`…
    pub codec: String,
    /// ffprobe's name for the variant: `Dolby TrueHD + Dolby Atmos`,
    /// `DTS-HD MA + DTS:X`, `DTS-HD MA`, `LC`…
    pub profile: Option<String>,
    pub channels: Option<u32>,
    /// `7.1`, `5.1(side)`, `stereo`…
    pub layout: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
    pub default: bool,
    pub commentary: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Subtitle {
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub default: bool,
    pub forced: bool,
    /// Flagged for the deaf and hard of hearing (SDH) by the file itself.
    pub hearing_impaired: bool,
}

// ---- what ffprobe says -----------------------------------------------------

#[derive(Deserialize, Default)]
struct ProbeOutput {
    #[serde(default)]
    streams: Vec<Stream>,
    format: Option<Format>,
}

#[derive(Deserialize, Default)]
struct Format {
    format_name: Option<String>,
    duration: Option<String>,
    bit_rate: Option<String>,
}

#[derive(Deserialize, Default)]
struct Stream {
    index: u32,
    codec_type: Option<String>,
    codec_name: Option<String>,
    profile: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    sample_aspect_ratio: Option<String>,
    pix_fmt: Option<String>,
    bits_per_raw_sample: Option<String>,
    field_order: Option<String>,
    color_transfer: Option<String>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
    #[serde(default)]
    side_data_list: Vec<Value>,
    #[serde(default)]
    tags: HashMap<String, String>,
    #[serde(default)]
    disposition: HashMap<String, i64>,
}

impl Stream {
    fn kind(&self) -> &str {
        self.codec_type.as_deref().unwrap_or("")
    }

    fn flag(&self, name: &str) -> bool {
        self.disposition.get(name).is_some_and(|v| *v != 0)
    }

    /// A tag by name, whatever case the muxer wrote it in (Matroska writes
    /// `language`, some tools `LANGUAGE`).
    fn tag(&self, name: &str) -> Option<String> {
        self.tags
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }

    fn language(&self) -> Option<String> {
        // `und` is Matroska's "not said", which is what None already means.
        self.tag("language").filter(|l| l != "und")
    }
}

#[derive(Deserialize, Default)]
struct FramesOutput {
    #[serde(default)]
    frames: Vec<Frame>,
}

#[derive(Deserialize, Default)]
struct Frame {
    #[serde(default)]
    side_data_list: Vec<Value>,
}

// ---- reading it --------------------------------------------------------------

/// The picture worth describing: the first video stream that is not cover art.
///
/// MP4 and Matroska both carry posters as "video" streams flagged
/// `attached_pic`, and in an MP4 the poster is often stream 0 — a 4K film
/// would be described as a 600×900 JPEG.
fn main_video(streams: &[Stream]) -> Option<&Stream> {
    streams
        .iter()
        .find(|s| s.kind() == "video" && !s.flag("attached_pic"))
}

/// `24000/1001` → 23.976…; `0/0` and nonsense → None.
fn ratio(text: Option<&str>) -> Option<f64> {
    let (num, den) = text?.split_once(['/', ':'])?;
    let num: f64 = num.trim().parse().ok()?;
    let den: f64 = den.trim().parse().ok()?;
    let value = num / den;
    (value.is_finite() && value > 0.0).then_some(value)
}

/// The frame rate to show.
///
/// `r_frame_rate` is the stream's declared rate and is right for nearly every
/// file. A variable-rate MP4 declares a timebase-ish figure there (90000/1)
/// instead; the average is then the only honest number.
fn frame_rate(stream: &Stream) -> Option<f64> {
    let declared = ratio(stream.r_frame_rate.as_deref()).filter(|r| *r <= 300.0);
    let average = ratio(stream.avg_frame_rate.as_deref()).filter(|r| *r <= 300.0);
    match (declared, average) {
        (Some(r), Some(a)) if (r - a).abs() / a > 0.01 => Some(a),
        (Some(r), _) => Some(r),
        (None, a) => a,
    }
}

/// Bits per colour sample.
///
/// ffprobe fills `bits_per_raw_sample` for some codecs only; otherwise the
/// pixel format says it — `yuv420p10le` is 10, `p010le` is 10, `yuv420p` is 8.
/// Only digits straight after a `p` count: `nv12` is an 8-bit format whose
/// name ends in 12.
fn bit_depth(stream: &Stream) -> Option<u8> {
    if let Some(bits) = stream
        .bits_per_raw_sample
        .as_deref()
        .and_then(|b| b.parse::<u8>().ok())
        .filter(|b| *b > 0)
    {
        return Some(bits);
    }
    let format = stream.pix_fmt.as_deref()?;
    let name = format
        .strip_suffix("le")
        .or_else(|| format.strip_suffix("be"))
        .unwrap_or(format);
    let digits_at = name.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    let (head, digits) = name.split_at(digits_at);
    if !digits.is_empty() && head.ends_with('p') {
        digits.parse().ok()
    } else {
        Some(8)
    }
}

fn transfer(stream: &Stream) -> Transfer {
    match stream.color_transfer.as_deref() {
        Some("smpte2084") => Transfer::Pq,
        Some("arib-std-b67") => Transfer::Hlg,
        _ => Transfer::Sdr,
    }
}

fn side_type(entry: &Value) -> &str {
    entry
        .get("side_data_type")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn int(entry: &Value, key: &str) -> Option<i64> {
    let value = entry.get(key)?;
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

/// The Dolby Vision configuration record: profile, level, compatibility.
///
/// Matroska, MP4 and MPEG-TS all carry one, and ffprobe lists it among the
/// stream's side data.
fn dolby_vision_config(stream: &Stream) -> Option<(u8, Option<u8>, Option<u8>)> {
    let record = stream
        .side_data_list
        .iter()
        .find(|e| e.get("dv_profile").is_some())?;
    let profile = u8::try_from(int(record, "dv_profile")?).ok()?;
    let level = int(record, "dv_level").and_then(|l| u8::try_from(l).ok());
    let compatibility =
        int(record, "dv_bl_signal_compatibility_id").and_then(|c| u8::try_from(c).ok());
    Some((profile, level, compatibility))
}

/// What one frame's Dolby Vision RPU says: the profile it implies, and for a
/// file with an enhancement layer, whether that layer is full or minimal.
///
/// Both rules are dovi_tool's (quietvoid, MIT) — the tool everyone uses to
/// tell a FEL disc from a MEL one — rewritten against the field names ffprobe
/// prints, which carry the same values:
///
/// * **Profile** (`RpuDataHeader::get_dovi_profile`): an RPU profile of 0 with
///   a full-range base layer is profile 5; an RPU profile of 1 is profile 7
///   when it resamples an enhancement layer and uses its residual at 12 bits,
///   4 when not at 12 bits, and 8 otherwise.
/// * **FEL or MEL** (`RpuDataNlq::is_mel`): a minimal layer has every
///   component's NLQ parameters at the do-nothing values — offset 0, a
///   `vdr_in_max` of exactly 1.0, no dead zone. Anything else is full.
///   ffmpeg prints `vdr_in_max` as one fixed-point number with
///   `coef_log2_denom` fractional bits, so 1.0 is `1 << coef_log2_denom`.
fn read_rpu(rpu: &Value) -> (Option<u8>, Option<EnhancementLayer>) {
    let flag = |key: &str| int(rpu, key).map(|v| v != 0);

    let profile = match int(rpu, "vdr_rpu_profile") {
        Some(0) if flag("bl_video_full_range_flag") == Some(true) => Some(5),
        Some(1) => {
            let resamples_el = flag("el_spatial_resampling_filter_flag") == Some(true);
            let uses_residual = flag("disable_residual_flag") == Some(false);
            if resamples_el && uses_residual {
                Some(if int(rpu, "vdr_bit_depth") == Some(12) { 7 } else { 4 })
            } else {
                Some(8)
            }
        }
        _ => None,
    };

    // NLQ is only there when there is an enhancement layer to apply it to;
    // ffprobe prints -1 ("none") otherwise. Floating-point coefficients
    // (`coef_data_type` 1) are legal and never seen; they are not classified
    // rather than classified wrongly.
    let nlq = int(rpu, "nlq_method_idc").is_some_and(|m| m >= 0);
    let fixed_point = int(rpu, "coef_data_type") == Some(0);
    let layer = match (nlq, fixed_point, int(rpu, "coef_log2_denom")) {
        (true, true, Some(denom)) if (0..64).contains(&denom) => {
            let one = 1i64 << denom;
            let components = rpu.get("components").and_then(Value::as_array);
            components.filter(|c| c.len() == 3).map(|components| {
                let minimal = components.iter().all(|c| {
                    int(c, "nlq_offset") == Some(0)
                        && int(c, "vdr_in_max") == Some(one)
                        && int(c, "linear_deadzone_slope").unwrap_or(0) == 0
                        && int(c, "linear_deadzone_threshold").unwrap_or(0) == 0
                });
                if minimal {
                    EnhancementLayer::Minimal
                } else {
                    EnhancementLayer::Full
                }
            })
        }
        _ => None,
    };

    (profile, layer)
}

/// Turn ffprobe's two answers into [`MediaDetails`]. Pure, so it is tested
/// against real ffprobe output without a video file in sight.
fn details_from(probe: ProbeOutput, frames: Option<FramesOutput>) -> MediaDetails {
    let format = probe.format.unwrap_or_default();
    let frame_data: Vec<Value> = frames
        .map(|f| f.frames.into_iter().flat_map(|f| f.side_data_list).collect())
        .unwrap_or_default();

    let video = main_video(&probe.streams).map(|stream| {
        // The container's side data and the frames' together: MP4 keeps
        // mastering metadata in the header, Matroska usually in the stream.
        let side: Vec<&Value> = stream.side_data_list.iter().chain(frame_data.iter()).collect();
        let of_type = |name: &str| side.iter().copied().find(|e| side_type(e) == name);

        let mastering_peak_nits = of_type("Mastering display metadata")
            .and_then(|m| ratio(m.get("max_luminance").and_then(Value::as_str)));
        let light = of_type("Content light level metadata");
        let light_level = |key: &str| {
            light
                .and_then(|l| int(l, key))
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v > 0)
        };
        let hdr10_plus = side.iter().any(|e| {
            let name = side_type(e);
            name.contains("HDR10+") || name.contains("SMPTE2094-40")
        });

        let rpu = side
            .iter()
            .find(|e| side_type(e) == "Dolby Vision Metadata")
            .map(|rpu| read_rpu(rpu));
        let dolby_vision = match (dolby_vision_config(stream), rpu) {
            (Some((profile, level, compatibility)), rpu) => Some(DolbyVision {
                profile,
                level,
                compatibility,
                // Only a profile with an enhancement layer has one to name.
                enhancement_layer: rpu.and_then(|(_, el)| el).filter(|_| profile == 7),
            }),
            // No configuration record, but the frames carry an RPU: an
            // elementary stream, or a container that lost the record. The RPU
            // alone still says which profile it is.
            (None, Some((Some(profile), el))) => Some(DolbyVision {
                profile,
                level: None,
                compatibility: None,
                enhancement_layer: el.filter(|_| profile == 7),
            }),
            (None, _) => None,
        };

        let width = stream.width.unwrap_or(0);
        let height = stream.height.unwrap_or(0);
        let pixel_shape = ratio(stream.sample_aspect_ratio.as_deref()).unwrap_or(1.0);
        let aspect_ratio =
            (width > 0 && height > 0).then(|| width as f64 * pixel_shape / height as f64);

        Video {
            stream_index: Some(stream.index),
            codec: stream.codec_name.clone().unwrap_or_default(),
            profile: stream.profile.clone(),
            width,
            height,
            bit_depth: bit_depth(stream),
            frame_rate: frame_rate(stream),
            interlaced: stream
                .field_order
                .as_deref()
                .is_some_and(|f| !matches!(f, "progressive" | "unknown")),
            aspect_ratio,
            transfer: transfer(stream),
            hdr10_plus,
            dolby_vision,
            mastering_peak_nits,
            max_cll: light_level("max_content"),
            max_fall: light_level("max_average"),
        }
    });

    let audio = probe
        .streams
        .iter()
        .filter(|s| s.kind() == "audio")
        .map(|s| Audio {
            codec: s.codec_name.clone().unwrap_or_default(),
            profile: s.profile.clone(),
            channels: s.channels.filter(|c| *c > 0),
            layout: s.channel_layout.clone(),
            language: s.language(),
            title: s.tag("title"),
            default: s.flag("default"),
            commentary: s.flag("comment"),
        })
        .collect();

    let subtitles = probe
        .streams
        .iter()
        .filter(|s| s.kind() == "subtitle")
        .map(|s| Subtitle {
            codec: s.codec_name.clone().unwrap_or_default(),
            language: s.language(),
            title: s.tag("title"),
            default: s.flag("default"),
            forced: s.flag("forced"),
            hearing_impaired: s.flag("hearing_impaired"),
        })
        .collect();

    MediaDetails {
        container: format.format_name,
        duration_secs: format
            .duration
            .and_then(|d| d.parse().ok())
            .filter(|d: &f64| d.is_finite() && *d > 0.0),
        bit_rate: format.bit_rate.and_then(|b| b.parse().ok()),
        video,
        audio,
        subtitles,
    }
}

/// Run ffprobe with `args`, then the file, and return what it printed.
fn run_ffprobe(ffmpeg: &Path, args: &[&str], video: &Path) -> Result<String, String> {
    let mut command = Command::new(crate::ffmpeg::probe_binary(ffmpeg));
    command
        .args(["-v", "error", "-of", "json"])
        .args(args)
        .arg(video)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::ffmpeg::no_window(&mut command);

    let output = command
        .output()
        .map_err(|e| format!("could not run ffprobe: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr
            .lines()
            .last()
            .unwrap_or("ffprobe could not read the file")
            .to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Read one file.
pub fn probe(ffmpeg: &Path, video: &Path) -> Result<MediaDetails, String> {
    let streams = run_ffprobe(ffmpeg, &["-show_format", "-show_streams"], video)?;
    let probe: ProbeOutput =
        serde_json::from_str(&streams).map_err(|e| format!("unreadable ffprobe output: {e}"))?;

    // The frames are a bonus: HDR10+ and FEL/MEL. A file whose first frames
    // will not decode still has everything the headers said.
    let frames = main_video(&probe.streams).and_then(|stream| {
        let index = stream.index.to_string();
        let args = [
            "-select_streams",
            index.as_str(),
            "-read_intervals",
            "%+#2",
            "-show_frames",
            "-show_entries",
            "frame=side_data_list",
        ];
        run_ffprobe(ffmpeg, &args, video)
            .ok()
            .and_then(|text| serde_json::from_str::<FramesOutput>(&text).ok())
    });

    Ok(details_from(probe, frames))
}

/// Whether ffprobe runs at all, asked once before a pass rather than failing
/// once per file.
fn available(ffmpeg: &Path) -> bool {
    let mut command = Command::new(crate::ffmpeg::probe_binary(ffmpeg));
    command
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::ffmpeg::no_window(&mut command);
    command.status().map(|s| s.success()).unwrap_or(false)
}

// ---- keeping it --------------------------------------------------------------

pub(crate) struct Pending {
    pub(crate) id: i64,
    pub(crate) path: String,
    pub(crate) size: i64,
    pub(crate) modified: i64,
}

/// Files never read, changed since they were read, or read by an older
/// version of this module. Matched files first: they are the ones with a
/// detail page to show them on.
fn pending(conn: &Connection) -> rusqlite::Result<Vec<Pending>> {
    let mut statement = conn.prepare(
        "SELECT m.id, m.path, m.size_bytes, m.modified_at
           FROM media_files m
           LEFT JOIN media_probe p ON p.file_id = m.id
          WHERE m.missing = 0
            AND (p.file_id IS NULL
                 OR p.size_bytes <> m.size_bytes
                 OR p.modified_at <> m.modified_at
                 OR p.probe_version < ?1)
          ORDER BY (m.match_status = 'matched') DESC, m.id",
    )?;
    let rows = statement.query_map(params![PROBE_VERSION], |r| {
        Ok(Pending {
            id: r.get(0)?,
            path: r.get(1)?,
            size: r.get(2)?,
            modified: r.get(3)?,
        })
    })?;
    rows.collect()
}

pub(crate) fn save(
    conn: &Connection,
    file: &Pending,
    result: &Result<MediaDetails, String>,
) -> rusqlite::Result<()> {
    let (details, error) = match result {
        Ok(details) => (serde_json::to_string(details).ok(), None),
        Err(e) => (None, Some(e.as_str())),
    };
    conn.execute(
        "INSERT INTO media_probe
             (file_id, size_bytes, modified_at, probe_version, probed_at, details, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(file_id) DO UPDATE SET
             -- A measured picture belongs to the bytes it was measured in: kept
             -- when only the reader changed, dropped when the file did.
             picture_version = CASE WHEN size_bytes = excluded.size_bytes
                                     AND modified_at = excluded.modified_at
                                    THEN picture_version END,
             picture_aspect = CASE WHEN size_bytes = excluded.size_bytes
                                    AND modified_at = excluded.modified_at
                                   THEN picture_aspect END,
             picture_aspect_alt = CASE WHEN size_bytes = excluded.size_bytes
                                        AND modified_at = excluded.modified_at
                                       THEN picture_aspect_alt END,
             size_bytes = excluded.size_bytes, modified_at = excluded.modified_at,
             probe_version = excluded.probe_version, probed_at = excluded.probed_at,
             details = excluded.details, error = excluded.error",
        params![file.id, file.size, file.modified, PROBE_VERSION, now_secs(), details, error],
    )?;
    Ok(())
}

/// What has been read about one file, if anything.
pub fn details_for_file(conn: &Connection, file_id: i64) -> Option<MediaDetails> {
    let text: String = conn
        .query_row(
            "SELECT details FROM media_probe WHERE file_id = ?1 AND details IS NOT NULL",
            params![file_id],
            |r| r.get(0),
        )
        .ok()?;
    serde_json::from_str(&text).ok()
}

/// Everything the detail page's badges are made from, for one file.
#[derive(Serialize)]
pub struct FileFacts {
    /// `None` until the file has been read, or when ffprobe is missing.
    pub details: Option<MediaDetails>,
    /// The picture's measured shape (`aspect.rs`) — the file's own for a
    /// film, its season's for an episode.
    pub picture_aspect: Option<f64>,
    pub picture_aspect_alt: Option<f64>,
    /// The names the source badge is read from (`release.ts`).
    pub file_name: String,
    pub parent_dir: String,
    pub extension: String,
    /// The library folder the file is in, which the source badge must not
    /// read: it is "Movies", not a release name.
    pub root_path: String,
    /// The file's folder also holds files matched to another title, so its
    /// name belongs to that title as much as this one and is not read.
    pub folder_shared: bool,
}

/// Whether a file's folder holds files of another title as well.
///
/// Found on a real library: a film kept inside another film's release
/// folder. The folder's name is that other film's release, and reading it
/// would label this one "UHD Blu-ray remux" on the strength of a neighbour.
/// A film's own extras, or files not matched to anything, do not count.
fn folder_shared(conn: &Connection, file_id: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (
             SELECT 1 FROM media_files o JOIN media_files m ON o.parent_dir = m.parent_dir
              WHERE m.id = ?1 AND o.id <> m.id AND o.missing = 0
                AND o.title_id IS NOT NULL AND o.title_id IS NOT m.title_id)",
        params![file_id],
        |r| r.get(0),
    )
}

/// Tauri command: the badges' facts for one file. A database read, so it
/// stays synchronous (see `jobs.rs`).
#[tauri::command]
pub fn file_facts(db: tauri::State<Db>, file_id: i64) -> Result<Option<FileFacts>, String> {
    let conn = db.0.lock().map_err(to_string_err)?;
    let names = conn.query_row(
        "SELECT m.file_name, m.parent_dir, m.extension, r.path
           FROM media_files m JOIN library_roots r ON r.id = m.root_id
          WHERE m.id = ?1",
        params![file_id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        },
    );
    let (file_name, parent_dir, extension, root_path) = match names {
        Ok(names) => names,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let shape = crate::aspect::shape_for_file(&conn, file_id);
    let folder_shared = folder_shared(&conn, file_id).map_err(to_string_err)?;
    Ok(Some(FileFacts {
        details: details_for_file(&conn, file_id),
        picture_aspect: shape.map(|s| s.main),
        picture_aspect_alt: shape.and_then(|s| s.alt),
        file_name,
        parent_dir,
        extension,
        root_path,
        folder_shared,
    }))
}

#[derive(Serialize, Clone)]
pub struct ProbeProgress {
    pub done: usize,
    pub total: usize,
}

#[derive(Serialize, Default)]
pub struct ProbeReport {
    /// Files read successfully on this pass.
    pub read: usize,
    /// Files ffprobe could not read. Kept, and tried again when they change.
    pub failed: usize,
    /// ffprobe was not found, so nothing was read.
    pub unavailable: bool,
}

/// Tauri command: read every file that needs it. The scan's last step before
/// intro detection.
///
/// One file at a time, below normal priority (`ffmpeg::no_window`), so it
/// never competes with a film that is playing. The first run over a library is
/// a fraction of a second per file; later scans read only what changed.
#[tauri::command]
pub async fn probe_library(app: tauri::AppHandle) -> Result<ProbeReport, String> {
    let Some(running) = app
        .state::<crate::jobs::Jobs>()
        .try_start(crate::jobs::Job::Probe)
    else {
        return Ok(ProbeReport::default());
    };

    let (ffmpeg, files) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(to_string_err)?;
        let configured = crate::settings::setting(&conn, crate::ffmpeg::PATH_KEY);
        (
            crate::ffmpeg::resolve(configured.as_deref()),
            pending(&conn).map_err(to_string_err)?,
        )
    };
    if files.is_empty() {
        return Ok(ProbeReport::default());
    }

    crate::jobs::off_main(move || {
        let _running = running;
        if !available(&ffmpeg) {
            crate::log!(
                "probe: ffprobe not found beside {}; {} file(s) left unread",
                ffmpeg.display(),
                files.len()
            );
            return Ok(ProbeReport {
                unavailable: true,
                ..ProbeReport::default()
            });
        }

        let started = std::time::Instant::now();
        let total = files.len();
        let mut report = ProbeReport::default();
        for (done, file) in files.iter().enumerate() {
            let _ = app.emit(PROGRESS_EVENT, ProbeProgress { done, total });

            // A folder that is offline right now — a NAS asleep, a drive
            // unplugged — is not a file ffprobe failed on. Recording it as one
            // would keep it from being read until the file changed, which a
            // file on a sleeping NAS never does. Left for the next scan.
            let path = Path::new(&file.path);
            if !path.is_file() {
                continue;
            }

            let result = probe(&ffmpeg, path);
            match &result {
                Ok(_) => report.read += 1,
                Err(e) => {
                    report.failed += 1;
                    crate::log!("probe: could not read file {}: {e}", file.id);
                }
            }
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(to_string_err)?;
            save(&conn, file, &result).map_err(to_string_err)?;
        }
        crate::log!(
            "probe: read {} file(s), {} failed, in {:.1}s",
            report.read,
            report.failed,
            started.elapsed().as_secs_f64()
        );
        Ok(report)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(streams: &str, frames: Option<&str>) -> MediaDetails {
        details_from(
            serde_json::from_str(streams).expect("streams json"),
            frames.map(|f| serde_json::from_str(f).expect("frames json")),
        )
    }

    /// A 4K HDR10 film with a TrueHD Atmos, a DTS-HD MA and an AC-3 track, cut
    /// down from ffprobe 8.1.2's real output (one subtitle kept of many, tags
    /// reduced to language).
    const HDR10_FILM: &str = r#"{
      "streams": [
        { "index": 0, "codec_name": "hevc", "profile": "Main 10", "codec_type": "video",
          "width": 3840, "height": 1600, "sample_aspect_ratio": "1:1",
          "display_aspect_ratio": "12:5", "pix_fmt": "yuv420p10le",
          "color_transfer": "smpte2084", "color_primaries": "bt2020",
          "field_order": "progressive", "r_frame_rate": "24000/1001",
          "avg_frame_rate": "24000/1001",
          "disposition": { "default": 1, "forced": 0, "hearing_impaired": 0, "attached_pic": 0 },
          "tags": { "language": "eng" } },
        { "index": 1, "codec_name": "dts", "profile": "DTS-HD MA", "codec_type": "audio",
          "channels": 8, "channel_layout": "7.1",
          "disposition": { "default": 1, "comment": 0 }, "tags": { "language": "eng" } },
        { "index": 2, "codec_name": "truehd", "profile": "Dolby TrueHD + Dolby Atmos",
          "codec_type": "audio", "channels": 8, "channel_layout": "7.1",
          "disposition": { "default": 0, "comment": 0 }, "tags": { "language": "eng" } },
        { "index": 3, "codec_name": "ac3", "codec_type": "audio", "channels": 6,
          "channel_layout": "5.1(side)",
          "disposition": { "default": 0, "comment": 1 },
          "tags": { "language": "eng", "title": "Commentary" } },
        { "index": 4, "codec_name": "hdmv_pgs_subtitle", "codec_type": "subtitle",
          "disposition": { "default": 0, "forced": 0, "hearing_impaired": 1 },
          "tags": { "language": "eng", "title": "SDH" } }
      ],
      "format": { "format_name": "matroska,webm", "duration": "8160.123000",
                  "bit_rate": "26511880" }
    }"#;

    /// The first frame of the same film: HDR10's static metadata only.
    const HDR10_FRAMES: &str = r#"{ "frames": [ { "side_data_list": [
      { "side_data_type": "H.26[45] User Data Unregistered SEI message" },
      { "side_data_type": "Mastering display metadata",
        "red_x": "34000/50000", "red_y": "16000/50000", "green_x": "13250/50000",
        "green_y": "34500/50000", "blue_x": "7500/50000", "blue_y": "3000/50000",
        "white_point_x": "15635/50000", "white_point_y": "16450/50000",
        "min_luminance": "20/10000", "max_luminance": "10000000/10000" },
      { "side_data_type": "Content light level metadata",
        "max_content": 739, "max_average": 331 }
    ] } ] }"#;

    #[test]
    fn a_4k_hdr10_film_is_described_as_ffprobe_saw_it() {
        let d = parse(HDR10_FILM, Some(HDR10_FRAMES));
        let v = d.video.expect("video");
        assert_eq!(v.codec, "hevc");
        assert_eq!((v.width, v.height), (3840, 1600));
        assert_eq!(v.bit_depth, Some(10));
        assert!((v.frame_rate.unwrap() - 23.976).abs() < 0.001);
        assert!((v.aspect_ratio.unwrap() - 2.4).abs() < 0.001);
        assert!(!v.interlaced);
        assert_eq!(v.transfer, Transfer::Pq);
        assert!(!v.hdr10_plus);
        assert_eq!(v.dolby_vision, None);
        assert_eq!(v.mastering_peak_nits, Some(1000.0));
        assert_eq!((v.max_cll, v.max_fall), (Some(739), Some(331)));

        assert_eq!(d.container.as_deref(), Some("matroska,webm"));
        assert_eq!(d.bit_rate, Some(26_511_880));
        assert!((d.duration_secs.unwrap() - 8160.123).abs() < 1e-6);
    }

    #[test]
    fn every_audio_track_keeps_ffprobes_own_name_for_it() {
        let d = parse(HDR10_FILM, None);
        let names: Vec<(&str, Option<&str>, Option<u32>)> = d
            .audio
            .iter()
            .map(|a| (a.codec.as_str(), a.profile.as_deref(), a.channels))
            .collect();
        assert_eq!(
            names,
            vec![
                ("dts", Some("DTS-HD MA"), Some(8)),
                ("truehd", Some("Dolby TrueHD + Dolby Atmos"), Some(8)),
                ("ac3", None, Some(6)),
            ]
        );
        assert!(d.audio[0].default);
        assert!(d.audio[2].commentary);
        assert_eq!(d.audio[2].title.as_deref(), Some("Commentary"));
        assert_eq!(d.audio[1].language.as_deref(), Some("eng"));
    }

    #[test]
    fn subtitles_keep_their_flags() {
        let d = parse(HDR10_FILM, None);
        assert_eq!(d.subtitles.len(), 1);
        assert!(d.subtitles[0].hearing_impaired);
        assert!(!d.subtitles[0].forced);
    }

    /// Without the frames, the headers still say nearly everything.
    #[test]
    fn a_file_whose_frames_would_not_decode_still_has_its_headers() {
        let v = parse(HDR10_FILM, None).video.unwrap();
        assert_eq!(v.transfer, Transfer::Pq);
        assert_eq!(v.mastering_peak_nits, None);
    }

    /// An MP4 whose poster is stream 0 must not become a 600×900 "film".
    #[test]
    fn cover_art_is_not_the_picture() {
        let d = parse(
            r#"{ "streams": [
              { "index": 0, "codec_type": "video", "codec_name": "mjpeg",
                "width": 600, "height": 900, "disposition": { "attached_pic": 1 } },
              { "index": 1, "codec_type": "video", "codec_name": "h264",
                "width": 1920, "height": 1080, "pix_fmt": "yuv420p",
                "r_frame_rate": "25/1", "avg_frame_rate": "25/1",
                "disposition": { "attached_pic": 0 } }
            ] }"#,
            None,
        );
        let v = d.video.unwrap();
        assert_eq!((v.codec.as_str(), v.width), ("h264", 1920));
        assert_eq!(v.bit_depth, Some(8));
        assert_eq!(v.transfer, Transfer::Sdr);
    }

    #[test]
    fn a_variable_rate_mp4_shows_its_average_rate() {
        let stream = Stream {
            r_frame_rate: Some("90000/1".into()),
            avg_frame_rate: Some("30000/1001".into()),
            ..Stream::default()
        };
        assert!((frame_rate(&stream).unwrap() - 29.97).abs() < 0.001);
    }

    #[test]
    fn bit_depth_comes_from_the_pixel_format_when_nothing_else_says() {
        let depth = |fmt: &str| {
            bit_depth(&Stream {
                pix_fmt: Some(fmt.into()),
                ..Stream::default()
            })
        };
        assert_eq!(depth("yuv420p"), Some(8));
        assert_eq!(depth("yuv420p10le"), Some(10));
        assert_eq!(depth("yuv444p12be"), Some(12));
        assert_eq!(depth("p010le"), Some(10));
        assert_eq!(depth("nv12"), Some(8));
    }

    #[test]
    fn an_anamorphic_dvd_is_as_wide_as_it_is_shown() {
        let d = parse(
            r#"{ "streams": [ { "index": 0, "codec_type": "video",
              "codec_name": "mpeg2video", "width": 720, "height": 576,
              "sample_aspect_ratio": "64:45", "field_order": "tt" } ] }"#,
            None,
        );
        let v = d.video.unwrap();
        assert!((v.aspect_ratio.unwrap() - 16.0 / 9.0).abs() < 0.001);
        assert!(v.interlaced);
    }

    #[test]
    fn hlg_and_hdr10_plus_are_recognised() {
        let d = parse(
            r#"{ "streams": [ { "index": 0, "codec_type": "video", "codec_name": "hevc",
              "width": 3840, "height": 2160, "color_transfer": "arib-std-b67" } ] }"#,
            Some(
                r#"{ "frames": [ { "side_data_list": [
                  { "side_data_type": "HDR Dynamic Metadata SMPTE2094-40 (HDR10+)" } ] } ] }"#,
            ),
        );
        let v = d.video.unwrap();
        assert_eq!(v.transfer, Transfer::Hlg);
        assert!(v.hdr10_plus);
    }

    // ---- Dolby Vision ----
    //
    // The RPUs below are what ffprobe 8.1.2 printed for dovi_tool's own test
    // RPUs (assets/tests/fel_orig.bin, mel_orig.bin and profile8.bin in
    // quietvoid/dovi_tool, MIT), put into a short HEVC clip. Trimmed to the
    // fields this module reads.

    /// A profile 7 disc's configuration record, as ffprobe lists it.
    const P7_STREAM: &str = r#"{ "streams": [ { "index": 0, "codec_type": "video",
      "codec_name": "hevc", "width": 3840, "height": 2160, "pix_fmt": "yuv420p10le",
      "color_transfer": "smpte2084",
      "side_data_list": [ { "side_data_type": "DOVI configuration record",
        "dv_version_major": 1, "dv_version_minor": 0, "dv_profile": 7, "dv_level": 6,
        "rpu_present_flag": 1, "el_present_flag": 1, "bl_present_flag": 1,
        "dv_bl_signal_compatibility_id": 6, "dv_md_compression": "none" } ] } ] }"#;

    fn rpu_frame(fields: &str, component: &str) -> String {
        format!(
            r#"{{ "frames": [ {{ "side_data_list": [
              {{ "side_data_type": "Dolby Vision RPU Data" }},
              {{ "side_data_type": "Dolby Vision Metadata", "rpu_type": 2, "rpu_format": 18,
                 "coef_data_type": 0, "coef_log2_denom": 23, "bl_bit_depth": 10,
                 "el_bit_depth": 10, "vdr_bit_depth": 12, {fields},
                 "components": [ {component}, {component}, {component} ] }} ] }} ] }}"#
        )
    }

    const P7_HEADER: &str = r#""vdr_rpu_profile": 1, "bl_video_full_range_flag": 0,
        "el_spatial_resampling_filter_flag": 1, "disable_residual_flag": 0,
        "nlq_method_idc": 0, "nlq_method_idc_name": "linear_dz""#;

    fn fel() -> String {
        rpu_frame(
            P7_HEADER,
            r#"{ "pivots": "0 1023", "nlq_offset": 512, "vdr_in_max": 1048576,
                 "linear_deadzone_slope": 2048, "linear_deadzone_threshold": 0 }"#,
        )
    }

    fn mel() -> String {
        rpu_frame(
            P7_HEADER,
            r#"{ "pivots": "0 1023", "nlq_offset": 0, "vdr_in_max": 8388608,
                 "linear_deadzone_slope": 0, "linear_deadzone_threshold": 0 }"#,
        )
    }

    fn profile8() -> String {
        rpu_frame(
            r#""vdr_rpu_profile": 1, "bl_video_full_range_flag": 0,
               "el_spatial_resampling_filter_flag": 0, "disable_residual_flag": 1,
               "nlq_method_idc": -1, "nlq_method_idc_name": "none""#,
            r#"{ "pivots": "0 1023" }"#,
        )
    }

    #[test]
    fn a_full_enhancement_layer_is_named_fel() {
        let dv = parse(P7_STREAM, Some(&fel())).video.unwrap().dolby_vision.unwrap();
        assert_eq!(dv.profile, 7);
        assert_eq!(dv.level, Some(6));
        assert_eq!(dv.compatibility, Some(6));
        assert_eq!(dv.enhancement_layer, Some(EnhancementLayer::Full));
    }

    #[test]
    fn a_minimal_enhancement_layer_is_named_mel() {
        let dv = parse(P7_STREAM, Some(&mel())).video.unwrap().dolby_vision.unwrap();
        assert_eq!(dv.enhancement_layer, Some(EnhancementLayer::Minimal));
    }

    /// The record says profile 7 but the frames could not be read: say
    /// profile 7 and nothing about the layer, rather than guess.
    #[test]
    fn a_profile_7_without_a_readable_rpu_says_nothing_about_its_layer() {
        let dv = parse(P7_STREAM, None).video.unwrap().dolby_vision.unwrap();
        assert_eq!(dv.profile, 7);
        assert_eq!(dv.enhancement_layer, None);
    }

    /// One component off its do-nothing value is enough to make a layer full.
    #[test]
    fn one_active_component_makes_the_layer_full() {
        let frames = mel().replacen(r#""nlq_offset": 0"#, r#""nlq_offset": 64"#, 1);
        let dv = parse(P7_STREAM, Some(&frames)).video.unwrap().dolby_vision.unwrap();
        assert_eq!(dv.enhancement_layer, Some(EnhancementLayer::Full));
    }

    #[test]
    fn profile_8_has_no_layer_to_name() {
        let stream = P7_STREAM
            .replace(r#""dv_profile": 7"#, r#""dv_profile": 8"#)
            .replace(r#""dv_bl_signal_compatibility_id": 6"#, r#""dv_bl_signal_compatibility_id": 1"#);
        let dv = parse(&stream, Some(&profile8())).video.unwrap().dolby_vision.unwrap();
        assert_eq!((dv.profile, dv.compatibility), (8, Some(1)));
        assert_eq!(dv.enhancement_layer, None);
    }

    /// No configuration record at all — an elementary stream — but an RPU in
    /// every frame: the RPU alone says what it is, by dovi_tool's rule.
    #[test]
    fn the_rpu_alone_names_the_profile() {
        let bare = r#"{ "streams": [ { "index": 0, "codec_type": "video",
          "codec_name": "hevc", "width": 640, "height": 360 } ] }"#;
        let profile = |frames: &str| parse(bare, Some(frames)).video.unwrap().dolby_vision;

        let p7 = profile(&fel()).unwrap();
        assert_eq!((p7.profile, p7.enhancement_layer), (7, Some(EnhancementLayer::Full)));
        let p8 = profile(&profile8()).unwrap();
        assert_eq!((p8.profile, p8.enhancement_layer), (8, None));
        let p5 = profile(&profile8().replace(
            r#""vdr_rpu_profile": 1, "bl_video_full_range_flag": 0"#,
            r#""vdr_rpu_profile": 0, "bl_video_full_range_flag": 1"#,
        ))
        .unwrap();
        assert_eq!(p5.profile, 5);
    }

    #[test]
    fn a_file_without_dolby_vision_has_none() {
        let v = parse(HDR10_FILM, Some(HDR10_FRAMES)).video.unwrap();
        assert_eq!(v.dolby_vision, None);
    }

    /// Stored as JSON and read back by the detail page; the names in it are
    /// what the frontend matches on.
    #[test]
    fn details_survive_being_stored() {
        let d = parse(P7_STREAM, Some(&fel()));
        let text = serde_json::to_string(&d).unwrap();
        assert!(text.contains(r#""enhancement_layer":"FEL""#), "{text}");
        assert!(text.contains(r#""transfer":"pq""#), "{text}");
        let back: MediaDetails = serde_json::from_str(&text).unwrap();
        assert_eq!(back, d);
    }

    // ---- keeping it ----

    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&conn).map_err(|e| e.to_string()).unwrap();
        conn.execute_batch(
            "INSERT INTO library_roots (id, path, kind, added_at) VALUES (1, 'D:\\Media', 'movies', 0);
             INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                                      size_bytes, modified_at, first_seen_at, last_seen_at)
             VALUES (1, 1, 'D:\\Media\\A film.mkv', 'D:\\Media', 'A film.mkv', 'mkv', 100, 5, 0, 0),
                    (2, 1, 'D:\\Media\\Another.mkv', 'D:\\Media', 'Another.mkv', 'mkv', 200, 5, 0, 0);",
        )
        .unwrap();
        conn
    }

    fn pending_ids(conn: &Connection) -> Vec<i64> {
        pending(conn).unwrap().iter().map(|p| p.id).collect()
    }

    #[test]
    fn a_file_is_read_once() {
        let conn = library();
        assert_eq!(pending_ids(&conn), vec![1, 2]);
        for file in pending(&conn).unwrap() {
            save(&conn, &file, &Ok(parse(HDR10_FILM, None))).unwrap();
        }
        assert!(pending_ids(&conn).is_empty());
        assert_eq!(details_for_file(&conn, 1).unwrap(), parse(HDR10_FILM, None));
    }

    /// A download that finished since it was read, or a file replaced by a
    /// better copy, is read again.
    #[test]
    fn a_changed_file_is_read_again() {
        let conn = library();
        for file in pending(&conn).unwrap() {
            save(&conn, &file, &Ok(MediaDetails::default())).unwrap();
        }
        conn.execute("UPDATE media_files SET size_bytes = 300 WHERE id = 2", []).unwrap();
        assert_eq!(pending_ids(&conn), vec![2]);
    }

    /// A file ffprobe cannot read is remembered as such — not retried on
    /// every scan, and never shown as details.
    #[test]
    fn a_failure_is_kept_and_not_retried_until_the_file_changes() {
        let conn = library();
        let files = pending(&conn).unwrap();
        save(&conn, &files[0], &Err("Invalid data found when processing input".into())).unwrap();
        assert_eq!(pending_ids(&conn), vec![2]);
        assert_eq!(details_for_file(&conn, 1), None);
    }

    #[test]
    fn a_missing_file_is_not_read() {
        let conn = library();
        conn.execute("UPDATE media_files SET missing = 1 WHERE id = 1", []).unwrap();
        assert_eq!(pending_ids(&conn), vec![2]);
    }

    #[test]
    fn a_newer_reader_reads_everything_again() {
        let conn = library();
        for file in pending(&conn).unwrap() {
            save(&conn, &file, &Ok(MediaDetails::default())).unwrap();
        }
        conn.execute("UPDATE media_probe SET probe_version = ?1", [PROBE_VERSION - 1])
            .unwrap();
        assert_eq!(pending_ids(&conn), vec![1, 2]);
    }

    /// A film in another film's folder does not take that folder's name;
    /// a film beside its own extras, or beside unmatched files, does.
    #[test]
    fn a_folder_shared_with_another_title_is_not_read() {
        let conn = library();
        conn.execute_batch(
            "INSERT INTO titles (id, kind, provider, provider_id, title, fetched_at) VALUES
                 (1, 'movie', 'tmdb', '1', 'A film', 0), (2, 'movie', 'tmdb', '2', 'Another', 0);
             INSERT INTO media_files (id, root_id, path, parent_dir, file_name, extension,
                                      size_bytes, modified_at, first_seen_at, last_seen_at, title_id)
             VALUES (3, 1, 'D:\\Media\\Extra.mkv', 'D:\\Media', 'Extra.mkv', 'mkv', 1, 1, 0, 0, NULL);
             UPDATE media_files SET title_id = 1 WHERE id = 1;",
        )
        .unwrap();
        // File 2 is unmatched and file 3 has no title: neither is another title.
        assert!(!folder_shared(&conn, 1).unwrap());
        conn.execute("UPDATE media_files SET title_id = 2 WHERE id = 2", []).unwrap();
        assert!(folder_shared(&conn, 1).unwrap());
        assert!(folder_shared(&conn, 2).unwrap());
    }

    /// Removing a file from the library removes what was read from it.
    #[test]
    fn details_go_with_their_file() {
        let conn = library();
        for file in pending(&conn).unwrap() {
            save(&conn, &file, &Ok(MediaDetails::default())).unwrap();
        }
        conn.execute("DELETE FROM media_files WHERE id = 1", []).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_probe", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1);
    }

    /// For developers: what this module makes of any file, as the JSON the
    /// detail page will get. Run with `KINEMA_PROBE_FILE` set to a video's
    /// path and `--ignored --nocapture`.
    #[test]
    #[ignore = "reads the file named in KINEMA_PROBE_FILE"]
    fn probe_the_file_named_in_the_environment() {
        let Ok(path) = std::env::var("KINEMA_PROBE_FILE") else {
            return;
        };
        let started = std::time::Instant::now();
        let details = probe(Path::new("ffmpeg"), Path::new(&path)).expect("probe");
        println!("{}", serde_json::to_string_pretty(&details).unwrap());
        println!("read in {:.2}s", started.elapsed().as_secs_f64());
    }

    /// The real thing, when ffprobe is installed: a file this module made
    /// itself, so nothing about it depends on the machine's library.
    #[test]
    #[ignore = "needs ffmpeg and ffprobe on PATH"]
    fn reads_a_real_file_end_to_end() {
        let dir = std::env::temp_dir().join(format!("kinema-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test.mkv");
        let status = Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=1280x720:rate=24000/1001")
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"])
            .args(["-t", "1", "-pix_fmt", "yuv420p10le", "-c:v", "libx265"])
            .args(["-x265-params", "log-level=error:transfer=smpte2084:colorprim=bt2020"])
            .args(["-c:a", "ac3", "-ac", "6", "-metadata:s:a:0", "language=eng"])
            .arg(&file)
            .status()
            .expect("ffmpeg");
        assert!(status.success());

        let d = probe(Path::new("ffmpeg"), &file).expect("probe");
        let _ = std::fs::remove_dir_all(&dir);
        let v = d.video.unwrap();
        assert_eq!((v.codec.as_str(), v.width, v.height), ("hevc", 1280, 720));
        assert_eq!(v.bit_depth, Some(10));
        assert_eq!(v.transfer, Transfer::Pq);
        assert!((v.frame_rate.unwrap() - 23.976).abs() < 0.001);
        assert_eq!(d.audio.len(), 1);
        assert_eq!(d.audio[0].codec, "ac3");
        assert_eq!(d.audio[0].channels, Some(6));
        assert_eq!(d.audio[0].language.as_deref(), Some("eng"));
    }
}
