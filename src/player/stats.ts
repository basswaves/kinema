/**
 * "Stats for nerds" — a read-only snapshot of what the playback pipeline is
 * actually doing.
 *
 * The point is confirmation, not configuration. This project decides the
 * rendering settings itself and offers no quality selector, which makes the
 * question "is it doing what it claims?" the only one left worth asking — and
 * the one thing there was previously no way to answer without reading
 * `mpv.log` line by line.
 *
 * Modelled on madVR's OSD, which gets two things right that a plain property
 * dump does not:
 *
 *  - **It reports the cadence, not just the two frame rates.** 23.976p on a
 *    60Hz panel is the largest visible departure from creator's intent in a
 *    typical setup, it is invisible in any scaler discussion, and it cannot be
 *    inferred at a glance from "23.976" and "59.97" sitting in separate rows.
 *  - **It lists the render passes that actually ran**, rather than the settings
 *    that were requested. Those are different claims, and only the first one
 *    answers "is anything touching my image?".
 *
 * Two rules, both learned the hard way:
 *
 *  - **Scalars only.** Never `getProperty(x, 'node')`. The node format
 *    deserialises nested maps across the FFI boundary and takes the whole
 *    process down with STATUS_ACCESS_VIOLATION, silently, from JS. Every value
 *    here is a flat scalar or an indexed sub-key, exactly as `tracks.ts` reads
 *    the track list.
 *  - **Every read may fail.** Property names move between mpv and libplacebo
 *    versions, and reading one in a format its handler does not implement
 *    throws rather than returning null (the `sid`/`aid` lesson). `safeGet`
 *    swallows both, so an unavailable field shows as `—` instead of emptying
 *    the panel.
 *
 * The display half comes from the webview rather than from mpv: the panel can
 * measure the actual screen, which mpv only knows about indirectly.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getProperty } from 'tauri-plugin-libmpv-api';
import { readProperty, type ScalarFormat } from './property';
import { outputCheck, type OutputFacts } from './outputCheck';
import { readSwitchSettings } from './displaySwitch';
import { readAudioSettings, targetDevice } from './audioOutput';
import { getEquipment, type DisplayMode } from './equipment';

export interface StatRow {
  label: string;
  value: string;
  /** Why the value is what it is, where that is not self-evident. */
  note?: string;
  /** Draws attention: something here is costing quality. */
  warn?: boolean;
}

export interface StatGroup {
  heading: string;
  rows: StatRow[];
  /**
   * Give the label column more room. Only the render-pass list needs it —
   * libplacebo describes its passes in full sentences, not field names.
   */
  wideLabels?: boolean;
}

/**
 * Like `safeGet`, but keeps the failure. Only worth the extra plumbing where an
 * absent value is itself the finding — a property that never answers should say
 * why rather than leaving a hole the reader has to guess at.
 */
async function probe<T>(
  name: string,
  format: ScalarFormat
): Promise<{ value: T | null; error: string | null }> {
  try {
    const value = await getProperty(name, format);
    return { value: (value ?? null) as T | null, error: null };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The first of these properties that exists, for names that moved upstream. */
async function firstOf<T>(names: string[], format: ScalarFormat): Promise<T | null> {
  for (const name of names) {
    const value = await readProperty<T>(name, format);
    if (value !== null) return value;
  }
  return null;
}

const DASH = '—';

function text(value: string | null | undefined): string {
  return value && value.length > 0 ? value : DASH;
}

function num(value: number | null, digits = 0, suffix = ''): string {
  if (value === null || Number.isNaN(value)) return DASH;
  return `${value.toFixed(digits)}${suffix}`;
}

function bitrate(bitsPerSecond: number | null): string {
  if (!bitsPerSecond) return DASH;
  const mbit = bitsPerSecond / 1_000_000;
  return mbit >= 1 ? `${mbit.toFixed(2)} Mb/s` : `${(bitsPerSecond / 1000).toFixed(0)} kb/s`;
}

function resolution(w: number | null, h: number | null): string {
  return w && h ? `${w} × ${h}` : DASH;
}

/**
 * Render-pass timings. Documented as nanoseconds, but scaled by magnitude
 * rather than by that assumption — a unit that changed upstream would otherwise
 * turn into three orders of magnitude of silent nonsense.
 */
function elapsed(value: number | null): string {
  if (value === null || Number.isNaN(value)) return DASH;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} ms`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} µs`;
  return `${value.toFixed(0)} ns`;
}

/**
 * A friendly name for a resolution, since "3840 × 2160" and "is this the 4K
 * one?" are the same question asked twice.
 */
function resolutionClass(w: number | null, h: number | null): string | undefined {
  if (!w || !h) return undefined;
  if (h >= 2000 || w >= 3800) return '4K / UHD';
  if (h >= 1400 || w >= 2500) return '1440p';
  if (h >= 1000 || w >= 1900) return '1080p';
  if (h >= 700) return '720p';
  return 'SD';
}

/** Bit depth read off the pixel format name, which is where it actually lives. */
function bitDepth(pixelFormat: string | null): string | undefined {
  if (!pixelFormat) return undefined;
  if (/p010|p10|10le|10be/i.test(pixelFormat)) return '10-bit';
  if (/p016|p16|12le|12be/i.test(pixelFormat)) return '12-bit';
  if (/yuv4\d\d[ps]?$|nv12|yuvj/i.test(pixelFormat)) return '8-bit';
  return undefined;
}

/** Transfer functions that carry more range than an SDR display can show. */
const HDR_TRANSFERS = new Set(['pq', 'hlg', 'st2084', 'arib-std-b67']);

function isHdr(gamma: string | null): boolean {
  return gamma !== null && HDR_TRANSFERS.has(gamma.toLowerCase());
}

/** Two rates agree if they are within this fraction of each other. */
const CADENCE_TOLERANCE = 0.005;

function near(value: number, target: number): boolean {
  return Math.abs(value - target) / target < CADENCE_TOLERANCE;
}

/**
 * How each source frame lands on the display's refresh cycle.
 *
 * This is the headline number and the reason the panel exists in this form. A
 * whole-number ratio means every frame is held for the same time and motion is
 * as even as the master. 2.5 is 3:2 pulldown — frames alternating between three
 * refreshes and two — which is the standard 24p-on-60Hz judder, visible on any
 * slow pan, and not something the player can fix: no frame-timing strategy
 * makes an uneven division even, and interpolating the difference away would
 * invent frames nobody shot.
 */
function describeCadence(sourceFps: number | null, displayHz: number | null): StatRow {
  if (!sourceFps || !displayHz) {
    return { label: 'Cadence', value: DASH };
  }

  const ratio = displayHz / sourceFps;
  const whole = Math.round(ratio);

  if (whole >= 1 && near(ratio, whole)) {
    return {
      label: 'Cadence',
      value: `${whole}:${whole} — even`,
      note: 'every frame held for the same number of refreshes; motion is as shot',
    };
  }

  if (near(ratio, 2.5)) {
    return {
      label: 'Cadence',
      value: '3:2 pulldown — uneven',
      note: `frames alternate between 3 and 2 refreshes; judders on pans. A ${(
        sourceFps * 5
      ).toFixed(0)} Hz display mode would give an even 5:5`,
      warn: true,
    };
  }

  return {
    label: 'Cadence',
    value: `${ratio.toFixed(3)} refreshes per frame — uneven`,
    note: 'frames are held for differing numbers of refreshes; motion will judder',
    warn: true,
  };
}

/**
 * What the scaler is doing, and why.
 *
 * `scaler-resizes-only` is the whole reason this is worth showing: when the
 * frame is already at output size, no scaler runs at all, and "none" is the
 * correct and desirable answer rather than a missing value.
 */
function describeScaling(
  sourceW: number | null,
  sourceH: number | null,
  videoW: number | null,
  videoH: number | null,
  scale: string | null,
  dscale: string | null,
  resizesOnly: boolean | null
): StatRow {
  if (!sourceW || !sourceH || !videoW || !videoH) {
    return { label: 'Luma scaling', value: DASH };
  }

  // Within a pixel either way is 1:1. The video rectangle is derived by
  // subtracting integer margins, so an exact match is not guaranteed even when
  // nothing is being resized.
  if (Math.abs(sourceW - videoW) <= 1 && Math.abs(sourceH - videoH) <= 1) {
    return {
      label: 'Luma scaling',
      value: 'none — 1:1',
      note: resizesOnly
        ? 'scaler-resizes-only keeps every scaler out of the path at native size'
        : 'frame is already at output size',
    };
  }

  const up = videoW * videoH > sourceW * sourceH;
  const factor = (videoH / sourceH).toFixed(3);

  return up
    ? {
        label: 'Luma scaling',
        value: `upscale ${factor}× · ${text(scale)}`,
        note: 'classical resampling in sigmoidised light — no ML, nothing invented',
      }
    : {
        label: 'Luma scaling',
        value: `downscale ${factor}× · ${text(dscale)}`,
        note: 'correct- and linear-downscaling: resampled in linear light',
      };
}

/**
 * What happened to the dynamic range, in one line.
 *
 * This is the field the whole panel exists for: HDR passthrough is the one
 * thing about this pipeline that cannot be confirmed on an SDR panel, and
 * guessing from the picture is exactly how you end up believing something that
 * is not true.
 */
/**
 * Whether the sound reached the device as the film carries it. `spdif-*` is
 * mpv's name for a bitstream wrapped for HDMI/S/PDIF and not decoded — the one
 * case where the receiver gets exactly what is on the disc.
 */
/**
 * What happens to a Dolby Vision track. Windows has no way to send a Dolby
 * Vision signal to a TV, so it is always shown as HDR10 — how depends on the
 * profile. `null` for a file that is not Dolby Vision (or whose container does
 * not say).
 */
export function describeDolbyVision(profile: number | null): StatRow | null {
  if (profile === null || profile <= 0) return null;
  const label = 'Dolby Vision';
  switch (profile) {
    case 5:
      return {
        label,
        value: 'profile 5 → converted to HDR10',
        note: 'no HDR10 layer in the file, so its own Dolby Vision metadata maps it; Windows cannot send Dolby Vision itself',
      };
    case 7:
      return {
        label,
        value: 'profile 7 → HDR10 base layer',
        note: 'the disc’s HDR10 layer is shown and the enhancement layer is not used; Windows cannot send Dolby Vision itself',
      };
    case 8:
      return {
        label,
        value: 'profile 8 → HDR10 base layer',
        note: 'made to fall back to HDR10 (or HLG), which is shown; Windows cannot send Dolby Vision itself',
      };
    default:
      return {
        label,
        value: `profile ${profile} → HDR10`,
        note: 'Windows cannot send Dolby Vision itself',
      };
  }
}

export function describeAudioPath(format: string | null, exclusive: boolean | null): StatRow {
  if (format?.startsWith('spdif-')) {
    return {
      label: 'Path',
      value: `untouched bitstream (${format.slice('spdif-'.length)}) → receiver`,
      note: 'passed through, not decoded: the receiver decodes it, Atmos and DTS:X included',
    };
  }
  if (!format) return { label: 'Path', value: DASH };
  return exclusive
    ? {
        label: 'Path',
        value: 'decoded · straight to the device',
        note: 'Windows mixer and spatial sound bypassed',
      }
    : {
        label: 'Path',
        value: 'decoded · through the Windows mixer',
        note: "mixed to Windows' speaker setup; no Atmos or DTS:X",
      };
}

export interface HdrFacts {
  sourceGamma: string | null;
  /** From `video-target-params` — what mpv actually rendered for. */
  targetGamma: string | null;
  /** Nits; 0 or null when not tagged. */
  sourcePeak: number | null;
  targetPeak: number | null;
  toneMapping: string | null;
  computePeak: boolean | null;
}

/**
 * HDR out is not the same as HDR untouched. With the colour-space hint in
 * `target` mode, mpv sends HDR10 but first compresses it to the peak Windows
 * reports for the screen — the test TV received exactly that, and this row used to
 * call it "tone mapping" only by accident: it read `target-params`, which does
 * not exist, and treated no answer as tone mapping. The property is
 * `video-target-params`; no answer now says so rather than guessing.
 */
/** What happened to the dynamic range, as one word — shared with the output check. */
export function hdrOutcome(f: HdrFacts): OutputFacts['hdrOut'] {
  if (!isHdr(f.sourceGamma)) return 'sdr';
  if (!f.targetGamma) return 'unknown';
  if (!isHdr(f.targetGamma)) return 'sdr';
  const source = f.sourcePeak ?? 0;
  const target = f.targetPeak ?? 0;
  return source > 0 && target > 0 && target < source - 1 ? 'compressed' : 'passthrough';
}

export function describeHdr(f: HdrFacts): StatRow {
  if (!isHdr(f.sourceGamma)) {
    return {
      label: 'HDR pipeline',
      value: 'SDR source — nothing to map',
      note: `transfer ${text(f.sourceGamma)}`,
    };
  }

  if (!f.targetGamma) {
    return {
      label: 'HDR pipeline',
      value: `${DASH} — mpv did not report its output`,
      note: 'video-target-params is empty until the first frame is drawn',
    };
  }

  if (isHdr(f.targetGamma)) {
    const source = f.sourcePeak ?? 0;
    const target = f.targetPeak ?? 0;
    // A nit either way is rounding in the metadata, not a tone curve.
    if (source > 0 && target > 0 && target < source - 1) {
      return {
        label: 'HDR pipeline',
        value: `HDR out, compressed · ${source.toFixed(0)} → ${target.toFixed(0)} nits`,
        note: 'adapted to the peak Windows reports for the screen, not sent as mastered',
        warn: true,
      };
    }
    return {
      label: 'HDR pipeline',
      value: `passthrough — ${f.sourceGamma} in, ${f.targetGamma} out`,
      note: "sent with the film's own HDR metadata; the display does its own tone mapping",
    };
  }

  return {
    label: 'HDR pipeline',
    value: `tone mapped to SDR (${f.targetGamma}) · ${text(f.toneMapping)}`,
    note: f.computePeak
      ? 'this screen is SDR, or Windows HDR is off; measured frame peak'
      : 'this screen is SDR, or Windows HDR is off',
  };
}

/**
 * The render passes libplacebo actually executed on the last frame.
 *
 * madVR's most useful panel, and the only honest answer to "is anything
 * touching my image?" — every other row here reports what was *requested*.
 * Read as indexed scalars, never as the `vo-passes` node.
 *
 * The sub-path moved between mpv versions, so the shape is probed rather than
 * assumed; an unsupported build simply contributes no rows.
 */
async function readRenderPasses(): Promise<{ rows: StatRow[]; unavailable: string | null }> {
  /** Enough to cover a full chain without turning the panel into a wall. */
  const MAX_PASSES = 24;

  const roots = ['vo-passes/fresh', 'vo-passes'];
  let firstError: string | null = null;

  for (const root of roots) {
    const { value: count, error } = await probe<number>(`${root}/count`, 'int64');
    if (firstError === null && error !== null) firstError = error;
    if (count === null || count <= 0) continue;

    const rows: StatRow[] = [];
    for (let i = 0; i < Math.min(count, MAX_PASSES); i++) {
      const desc = await readProperty<string>(`${root}/${i}/desc`, 'string');
      if (!desc) continue;
      const avg = await readProperty<number>(`${root}/${i}/avg`, 'double');
      const peak = await readProperty<number>(`${root}/${i}/peak`, 'double');
      rows.push({
        label: desc,
        value: elapsed(avg),
        note: peak === null ? undefined : `peak ${elapsed(peak)}`,
      });
    }

    if (rows.length > 0) {
      if (count > MAX_PASSES) {
        rows.push({ label: `… and ${count - MAX_PASSES} more`, value: '' });
      }
      return { rows, unavailable: null };
    }
  }

  return { rows: [], unavailable: firstError ?? 'no passes reported' };
}

/** Everything the webview can say about the panel it is being drawn on. */
function displayGroup(
  refreshHz: number | null,
  outW: number | null,
  outH: number | null,
  videoW: number | null,
  videoH: number | null,
  letterboxed: boolean,
  sourceFps: number | null,
  videoSync: string | null
): StatGroup {
  const dpr = window.devicePixelRatio || 1;
  const screenW = Math.round(window.screen.width * dpr);
  const screenH = Math.round(window.screen.height * dpr);

  // Chromium exposes whether the *browser* believes the display can show high
  // dynamic range. It is the only HDR signal available on this side, and it
  // describes the panel rather than what mpv chose to send it.
  const hdrCapable = window.matchMedia?.('(dynamic-range: high)').matches ?? false;

  return {
    heading: 'Display',
    rows: [
      {
        label: 'Monitor',
        value: resolution(screenW, screenH),
        note: dpr === 1 ? undefined : `${dpr}× scaling reported by the webview`,
      },
      {
        label: 'Refresh',
        value: num(refreshHz, 3, ' Hz'),
        note: 'as measured by mpv, not as advertised by the driver',
      },
      { label: 'Output surface', value: resolution(outW, outH) },
      {
        label: 'Video rectangle',
        value: resolution(videoW, videoH),
        note: letterboxed
          ? 'letterboxed inside the surface — this, not the window, is what the frame is scaled to'
          : undefined,
      },
      describeCadence(sourceFps, refreshHz),
      {
        label: 'Frame timing',
        value: text(videoSync),
        note:
          videoSync === 'audio'
            ? 'timed to the audio clock; the only mode compatible with bitstream passthrough'
            : 'timed to the display clock, audio resampled to match',
      },
      {
        label: 'Reported range',
        value: hdrCapable ? 'high (HDR)' : 'standard (SDR)',
        note: 'what the webview thinks the panel can show',
      },
    ],
  };
}

interface ScreenNowRaw {
  width: number;
  height: number;
  hdr: 'unknown' | 'unsupported' | 'off' | 'on';
  link_bits: number | null;
  link_encoding: string | null;
  modes: DisplayMode[];
}

/**
 * The output check (step 5 of the native-output plan): a verdict per part of
 * the chain, with the reason and the fix, at the top of the panel. The facts
 * mpv knows come in from the caller; the rest — fullscreen, the screen and its
 * link, the settings, the sound device — are gathered here. Any of them
 * failing leaves that check out rather than the panel empty.
 */
async function readOutputCheck(from: {
  source: OutputFacts['source'];
  drawn: OutputFacts['drawn'];
  fps: number | null;
  displayHz: number | null;
  hdrSource: boolean;
  hdrOut: OutputFacts['hdrOut'];
  dolbyVision: number | null;
  codec: string | null;
  outFormat: string | null;
}): Promise<StatGroup | null> {
  const [fullscreen, screen, switches, audioSettings, equipment, inCount, outCount] =
    await Promise.all([
      getCurrentWindow()
        .isFullscreen()
        .catch(() => false),
      invoke<ScreenNowRaw>('screen_now').catch(() => null),
      readSwitchSettings(),
      readAudioSettings(),
      getEquipment().catch(() => null),
      readProperty<number>('audio-params/channel-count', 'int64'),
      readProperty<number>('audio-out-params/channel-count', 'int64'),
    ]);
  const checks = outputCheck({
    fullscreen,
    source: from.source,
    drawn: from.drawn,
    screen: screen && {
      width: screen.width,
      height: screen.height,
      hdr: screen.hdr,
      linkBits: screen.link_bits,
      linkEncoding: screen.link_encoding,
      modes: screen.modes,
    },
    fps: from.fps,
    displayHz: from.displayHz,
    hdrSource: from.hdrSource,
    hdrOut: from.hdrOut,
    dolbyVision: from.dolbyVision,
    switches,
    audio: {
      codec: from.codec,
      outFormat: from.outFormat,
      inChannels: inCount,
      outChannels: outCount,
      direct: audioSettings.direct,
      device: targetDevice(equipment, audioSettings.deviceId),
    },
  });
  if (checks.length === 0) return null;
  return {
    heading: 'Output check',
    rows: checks.map((c) => ({
      label: c.label,
      value: c.verdict === 'native' ? `✓ ${c.value}` : c.value,
      note: [c.why, c.fix && `Fix: ${c.fix}`].filter(Boolean).join(' ') || undefined,
      warn: c.verdict === 'limited',
    })),
  };
}

/**
 * One snapshot of the whole pipeline. Read sequentially rather than in
 * parallel: this crosses an FFI boundary that has already proved willing to
 * take the process down, and a panel that refreshes once a second has no need
 * of the concurrency.
 */
export async function readPlaybackStats(): Promise<StatGroup[]> {
  // ---- source ----
  const videoCodec = await readProperty<string>('video-codec', 'string');
  const videoFormat = await readProperty<string>('video-format', 'string');
  const sourceW = await readProperty<number>('video-params/w', 'int64');
  const sourceH = await readProperty<number>('video-params/h', 'int64');
  // Under hardware decode `pixelformat` reports the *surface* type — "d3d11" —
  // and the real format lives in `hw-pixelformat`. Reading only the first one
  // loses the bit depth and makes every subsampled source look like it is not.
  const surfaceFormat = await readProperty<string>('video-params/pixelformat', 'string');
  const hwFormat = await readProperty<string>('video-params/hw-pixelformat', 'string');
  const pixelFormat = hwFormat ?? surfaceFormat;
  const containerFps = await readProperty<number>('container-fps', 'double');
  const actualFps = await readProperty<number>('estimated-vf-fps', 'double');
  const videoBitrate = await readProperty<number>('video-bitrate', 'int64');
  const interlaced = await readProperty<boolean>('video-frame-info/interlaced', 'flag');
  const deinterlaceActive = await readProperty<boolean>('deinterlace-active', 'flag');
  const deinterlace = await readProperty<string>('deinterlace', 'string');

  // ---- colour ----
  const colormatrix = await readProperty<string>('video-params/colormatrix', 'string');
  const primaries = await readProperty<string>('video-params/primaries', 'string');
  const gamma = await readProperty<string>('video-params/gamma', 'string');
  const levels = await readProperty<string>('video-params/colorlevels', 'string');
  const chromaLocation = await readProperty<string>('video-params/chroma-location', 'string');
  // `max-luma` is the newer name and is in nits; `sig-peak` is the older one and
  // is relative to SDR reference white. Neither exists on every build.
  const maxLuma = await readProperty<number>('video-params/max-luma', 'double');
  const dolbyVision = await readProperty<number>(
    'current-tracks/video/dolby-vision-profile',
    'int64'
  );
  const sigPeak = await readProperty<number>('video-params/sig-peak', 'double');
  // What mpv rendered *for*. The property is `video-target-params`; this read
  // `target-params` for months, which does not exist — see describeHdr.
  const targetGamma = await readProperty<string>('video-target-params/gamma', 'string');
  const targetPrimaries = await readProperty<string>('video-target-params/primaries', 'string');
  const targetPeak = await readProperty<number>('video-target-params/max-luma', 'double');

  // ---- rendering options, read live rather than assumed ----
  const vo = await readProperty<string>('current-vo', 'string');
  const gpuApi = await readProperty<string>('gpu-api', 'string');
  const hwdec = await readProperty<string>('hwdec-current', 'string');
  const scale = await readProperty<string>('scale', 'string');
  const dscale = await readProperty<string>('dscale', 'string');
  const cscale = await readProperty<string>('cscale', 'string');
  const resizesOnly = await readProperty<boolean>('scaler-resizes-only', 'flag');
  const deband = await readProperty<boolean>('deband', 'flag');
  const dither = await readProperty<string>('dither-depth', 'string');
  const toneMapping = await readProperty<string>('tone-mapping', 'string');
  const computePeak = await readProperty<boolean>('hdr-compute-peak', 'flag');
  const colorspaceHint = await readProperty<string>('target-colorspace-hint', 'string');
  const colorspaceHintMode = await readProperty<string>('target-colorspace-hint-mode', 'string');
  const videoSync = await readProperty<string>('video-sync', 'string');

  // ---- output ----
  // `osd-dimensions` is the whole output surface, margins included. A 2.40:1
  // film in a 16:10 window is letterboxed, so comparing the source against the
  // *window* reports a scale factor for an image that size was never drawn at —
  // a 3840×1600 scope master in a 2560×1600 window came out as "downscale
  // 1.000×", which is both wrong and self-contradictory. Subtract the margins.
  const outW = await readProperty<number>('osd-dimensions/w', 'int64');
  const outH = await readProperty<number>('osd-dimensions/h', 'int64');
  const marginL = (await readProperty<number>('osd-dimensions/ml', 'int64')) ?? 0;
  const marginR = (await readProperty<number>('osd-dimensions/mr', 'int64')) ?? 0;
  const marginT = (await readProperty<number>('osd-dimensions/mt', 'int64')) ?? 0;
  const marginB = (await readProperty<number>('osd-dimensions/mb', 'int64')) ?? 0;
  const videoW = outW === null ? null : outW - marginL - marginR;
  const videoH = outH === null ? null : outH - marginT - marginB;
  const letterboxed = marginL + marginR + marginT + marginB > 2;
  // Renamed upstream; try both rather than showing nothing on one of them.
  const displayFps = await firstOf<number>(
    ['display-fps', 'estimated-display-fps', 'display-fps-override'],
    'double'
  );

  // ---- audio ----
  const audioCodec = await readProperty<string>('audio-codec-name', 'string');
  const audioBitrate = await readProperty<number>('audio-bitrate', 'int64');
  const inChannels = await readProperty<string>('audio-params/channels', 'string');
  const inRate = await readProperty<number>('audio-params/samplerate', 'int64');
  const inFormat = await readProperty<string>('audio-params/format', 'string');
  const outChannels = await readProperty<string>('audio-out-params/channels', 'string');
  const outRate = await readProperty<number>('audio-out-params/samplerate', 'int64');
  const outFormat = await readProperty<string>('audio-out-params/format', 'string');
  const exclusive = await readProperty<boolean>('audio-exclusive', 'flag');
  const ao = await readProperty<string>('current-ao', 'string');

  // ---- health ----
  const dropped = await readProperty<number>('frame-drop-count', 'int64');
  const decoderDropped = await readProperty<number>('decoder-frame-drop-count', 'int64');
  const avsync = await readProperty<number>('avsync', 'double');
  const cache = await readProperty<number>('demuxer-cache-duration', 'double');

  const passes = await readRenderPasses();

  /**
   * The rate frames actually reach the display.
   *
   * Deinterlacing changes it — one interlaced frame becomes two progressive
   * ones — so the container rate is the wrong input for the cadence on exactly
   * the old content the deinterlacer exists for. `estimated-vf-fps` is what
   * comes out of the filter chain.
   */
  const displayedFps =
    deinterlaceActive === true ? (actualFps ?? containerFps) : (containerFps ?? actualFps);

  // Both peak properties report 0 on SDR content rather than going absent, and
  // "0.00× SDR white" is worse than saying there is nothing to report.
  const hdrSource = isHdr(gamma);
  const peak = !hdrSource
    ? 'n/a — SDR source'
    : maxLuma !== null && maxLuma > 0
      ? `${maxLuma.toFixed(0)} nits`
      : sigPeak !== null && sigPeak > 0
        ? `${sigPeak.toFixed(2)}× SDR white`
        : `${DASH} — not tagged in the file`;

  // Chroma is subsampled in essentially every consumer encode, so this scaler
  // runs on every file whatever the resolution. Worth stating plainly: it is
  // the reason "no processing" is never literally true, and `scaler-resizes-
  // only` neither does nor can suppress it.
  const chromaRow: StatRow = {
    label: 'Chroma upscaling',
    value: text(cscale),
    note:
      pixelFormat && /4?4[42]0|nv12|p010|yuv42/i.test(pixelFormat)
        ? 'subsampled source, so this runs on every frame regardless of resolution'
        : 'source is not subsampled',
  };

  const downmixed = Boolean(inChannels && outChannels && inChannels !== outChannels);

  const check = await readOutputCheck({
    source: sourceW && sourceH ? { width: sourceW, height: sourceH } : null,
    drawn: videoW && videoH ? { width: videoW, height: videoH } : null,
    fps: displayedFps,
    displayHz: displayFps,
    hdrSource,
    dolbyVision,
    hdrOut: hdrOutcome({
      sourceGamma: gamma,
      targetGamma,
      sourcePeak: maxLuma,
      targetPeak,
      toneMapping,
      computePeak,
    }),
    codec: audioCodec,
    outFormat,
  });

  const groups: StatGroup[] = [
    ...(check ? [check] : []),
    {
      heading: 'Source',
      rows: [
        {
          label: 'Resolution',
          value: resolution(sourceW, sourceH),
          note: resolutionClass(sourceW, sourceH),
        },
        {
          label: 'Video codec',
          value: text(videoFormat ?? videoCodec),
          note: videoCodec ?? undefined,
        },
        {
          label: 'Pixel format',
          value: text(pixelFormat),
          note: [
            bitDepth(pixelFormat),
            hwFormat && surfaceFormat ? `in a ${surfaceFormat} surface` : undefined,
          ]
            .filter(Boolean)
            .join(' · '),
        },
        {
          label: 'Frame rate',
          value: num(containerFps, 3, ' fps'),
          note:
            deinterlaceActive === true && actualFps !== null
              ? `${actualFps.toFixed(3)} fps reaching the display after deinterlacing`
              : actualFps === null
                ? undefined
                : `${actualFps.toFixed(3)} fps measured`,
        },
        { label: 'Video bitrate', value: bitrate(videoBitrate) },
        {
          label: 'Scan',
          value:
            interlaced === true
              ? deinterlaceActive === true
                ? 'interlaced — deinterlacing'
                : 'interlaced — NOT deinterlaced'
              : 'progressive',
          note:
            interlaced === true
              ? `deinterlace=${text(deinterlace)}`
              : 'nothing to weave; the deinterlacer never runs',
          warn: interlaced === true && deinterlaceActive !== true,
        },
      ],
    },
    displayGroup(displayFps, outW, outH, videoW, videoH, letterboxed, displayedFps, videoSync),
    {
      heading: 'Rendering',
      rows: [
        {
          label: 'Path',
          value: `${text(vo)} · ${text(gpuApi)}`,
          note: 'vendor-neutral: identical on NVIDIA, AMD and Intel',
        },
        {
          label: 'Hardware decode',
          value: text(hwdec),
          note: hwdec === null || hwdec === 'no' ? 'software decoding' : undefined,
          warn: hwdec === 'no',
        },
        describeScaling(sourceW, sourceH, videoW, videoH, scale, dscale, resizesOnly),
        chromaRow,
        // An absent value is itself the finding here, so it says so rather than
        // leaving a hole. gpu-next does not implement `vo-passes` on every
        // build, and "no section" and "no passes ran" look identical.
        ...(passes.unavailable
          ? [
              {
                label: 'Render passes',
                value: 'not reported by this VO',
                note: `${passes.unavailable} — the settings above are what was requested, not what ran`,
              },
            ]
          : []),
        {
          label: 'Debanding',
          value: deband ? 'on' : 'off',
          note: deband
            ? 'adds dithered noise across the frame — not in the master'
            : 'off on purpose — debanding alters the image to hide a source artifact',
          warn: deband === true,
        },
        { label: 'Dither', value: text(dither) },
      ],
    },
    {
      heading: 'Colour',
      rows: [
        describeHdr({
          sourceGamma: gamma,
          targetGamma,
          sourcePeak: maxLuma,
          targetPeak,
          toneMapping,
          computePeak,
        }),
        ...[describeDolbyVision(dolbyVision)].filter((r): r is StatRow => r !== null),
        { label: 'Transfer', value: text(gamma) },
        {
          label: 'Primaries',
          value: text(primaries),
          note:
            primaries && targetPrimaries && primaries !== targetPrimaries
              ? `converted to ${targetPrimaries} for the display`
              : undefined,
        },
        { label: 'Matrix', value: text(colormatrix) },
        { label: 'Levels', value: text(levels) },
        { label: 'Chroma siting', value: text(chromaLocation) },
        { label: 'Mastering peak', value: peak },
        {
          label: 'Target',
          value:
            targetGamma || targetPrimaries
              ? `${text(targetPrimaries)} · ${text(targetGamma)}${
                  isHdr(targetGamma) && targetPeak ? ` · ${targetPeak.toFixed(0)} nits` : ''
                }`
              : DASH,
          note: targetGamma || targetPrimaries ? undefined : 'mpv has not reported its output yet',
        },
        {
          label: 'Colour-space hint',
          value: `${text(colorspaceHint)} · ${text(colorspaceHintMode)}`,
          note:
            colorspaceHintMode === 'source'
              ? "an HDR display gets the film's own metadata"
              : colorspaceHintMode === 'target'
                ? 'HDR is adapted to the peak Windows reports before it is sent'
                : undefined,
        },
      ],
    },
    {
      heading: 'Audio',
      rows: [
        { label: 'Codec', value: text(audioCodec) },
        { label: 'Bitrate', value: bitrate(audioBitrate) },
        {
          label: 'Source',
          value: `${text(inChannels)} · ${num(inRate, 0, ' Hz')} · ${text(inFormat)}`,
        },
        {
          label: 'To device',
          value: `${text(outChannels)} · ${num(outRate, 0, ' Hz')} · ${text(outFormat)}`,
          note: downmixed
            ? 'channels differ from the source — the layout is being remapped or downmixed'
            : 'matches the source layout',
          warn: downmixed,
        },
        describeAudioPath(outFormat, exclusive),
        { label: 'Output', value: text(ao) },
      ],
    },
    {
      heading: 'Health',
      rows: [
        {
          label: 'Dropped frames',
          value: `${dropped ?? 0} output · ${decoderDropped ?? 0} decoder`,
          note:
            (dropped ?? 0) + (decoderDropped ?? 0) > 0
              ? 'anything above zero is worth chasing'
              : undefined,
          warn: (dropped ?? 0) + (decoderDropped ?? 0) > 0,
        },
        { label: 'A/V sync', value: num(avsync, 3, ' s') },
        {
          label: 'Demuxer cache',
          value: num(cache, 1, ' s'),
          note: 'how far ahead the file is read — low values over SMB mean the share is the limit',
        },
      ],
    },
  ];

  // Last, because it is the longest section and the one you scroll to
  // deliberately. Absent entirely on a build that does not expose it, rather
  // than present and empty.
  if (passes.rows.length > 0) {
    groups.push({ heading: 'Render passes (last frame)', rows: passes.rows, wideLabels: true });
  }

  return groups;
}
