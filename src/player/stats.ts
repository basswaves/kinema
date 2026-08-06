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
import { getProperty } from 'tauri-plugin-libmpv-api';

export interface StatRow {
  label: string;
  value: string;
  /** Why the value is what it is, where that is not self-evident. */
  note?: string;
}

export interface StatGroup {
  heading: string;
  rows: StatRow[];
}

type Format = 'string' | 'int64' | 'double' | 'flag';

async function safeGet<T>(name: string, format: Format): Promise<T | null> {
  try {
    const value = await getProperty(name, format);
    return (value ?? null) as T | null;
  } catch {
    return null;
  }
}

/** The first of these properties that exists, for names that moved upstream. */
async function firstOf<T>(names: string[], format: Format): Promise<T | null> {
  for (const name of names) {
    const value = await safeGet<T>(name, format);
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

/** Transfer functions that carry more range than an SDR display can show. */
const HDR_TRANSFERS = new Set(['pq', 'hlg', 'st2084', 'arib-std-b67']);

function isHdr(gamma: string | null): boolean {
  return gamma !== null && HDR_TRANSFERS.has(gamma.toLowerCase());
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
  outW: number | null,
  outH: number | null,
  scale: string | null,
  dscale: string | null,
  resizesOnly: boolean | null
): StatRow {
  if (!sourceW || !sourceH || !outW || !outH) {
    return { label: 'Scaling', value: DASH };
  }

  if (sourceW === outW && sourceH === outH) {
    return {
      label: 'Scaling',
      value: 'none — 1:1',
      note: resizesOnly
        ? 'scaler-resizes-only keeps every scaler out of the path at native size'
        : 'frame is already at output size',
    };
  }

  const up = outW * outH > sourceW * sourceH;
  const factor = (outH / sourceH).toFixed(2);

  return up
    ? {
        label: 'Scaling',
        value: `upscale ${factor}× · ${text(scale)}`,
        note: 'classical resampling in sigmoidised light — no ML, nothing invented',
      }
    : {
        label: 'Scaling',
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
function describeHdr(
  sourceGamma: string | null,
  targetGamma: string | null,
  toneMapping: string | null,
  computePeak: boolean | null,
  hint: string | null
): StatRow {
  if (!isHdr(sourceGamma)) {
    return {
      label: 'HDR pipeline',
      value: 'SDR source — nothing to map',
      note: `transfer ${text(sourceGamma)}`,
    };
  }

  if (targetGamma && isHdr(targetGamma)) {
    return {
      label: 'HDR pipeline',
      value: `passthrough — ${sourceGamma} in, ${targetGamma} out`,
      note: 'the display takes the signal untouched; no tone mapping in the path',
    };
  }

  // A null target transfer means this build does not expose `target-params`,
  // not that nothing is happening — say so rather than implying passthrough.
  return {
    label: 'HDR pipeline',
    value: targetGamma
      ? `tone mapped to ${targetGamma} · ${text(toneMapping)}`
      : `tone mapping · ${text(toneMapping)}`,
    note: computePeak
      ? 'measured frame peak, not the static metadata in the file'
      : `static metadata; target-colorspace-hint=${text(hint)}`,
  };
}

/** Everything the webview can say about the panel it is being drawn on. */
function displayGroup(refreshHz: number | null, outW: number | null, outH: number | null): StatGroup {
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
        value: num(refreshHz, 2, ' Hz'),
        note: 'as measured by mpv, not as advertised by the driver',
      },
      { label: 'Output surface', value: resolution(outW, outH) },
      {
        label: 'Reported range',
        value: hdrCapable ? 'high (HDR)' : 'standard (SDR)',
        note: 'what the webview thinks the panel can show',
      },
    ],
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
  const videoCodec = await safeGet<string>('video-codec', 'string');
  const videoFormat = await safeGet<string>('video-format', 'string');
  const sourceW = await safeGet<number>('video-params/w', 'int64');
  const sourceH = await safeGet<number>('video-params/h', 'int64');
  const pixelFormat = await safeGet<string>('video-params/pixelformat', 'string');
  const containerFps = await safeGet<number>('container-fps', 'double');
  const actualFps = await safeGet<number>('estimated-vf-fps', 'double');
  const videoBitrate = await safeGet<number>('video-bitrate', 'int64');

  // ---- colour ----
  const colormatrix = await safeGet<string>('video-params/colormatrix', 'string');
  const primaries = await safeGet<string>('video-params/primaries', 'string');
  const gamma = await safeGet<string>('video-params/gamma', 'string');
  const levels = await safeGet<string>('video-params/colorlevels', 'string');
  // `max-luma` is the newer name and is in nits; `sig-peak` is the older one and
  // is relative to SDR reference white. Neither exists on every build.
  const maxLuma = await safeGet<number>('video-params/max-luma', 'double');
  const sigPeak = await safeGet<number>('video-params/sig-peak', 'double');
  const targetGamma = await safeGet<string>('target-params/gamma', 'string');
  const targetPrimaries = await safeGet<string>('target-params/primaries', 'string');

  // ---- rendering options, read live rather than assumed ----
  const vo = await safeGet<string>('current-vo', 'string');
  const gpuApi = await safeGet<string>('gpu-api', 'string');
  const hwdec = await safeGet<string>('hwdec-current', 'string');
  const scale = await safeGet<string>('scale', 'string');
  const dscale = await safeGet<string>('dscale', 'string');
  const cscale = await safeGet<string>('cscale', 'string');
  const resizesOnly = await safeGet<boolean>('scaler-resizes-only', 'flag');
  const deband = await safeGet<boolean>('deband', 'flag');
  const dither = await safeGet<string>('dither-depth', 'string');
  const toneMapping = await safeGet<string>('tone-mapping', 'string');
  const computePeak = await safeGet<boolean>('hdr-compute-peak', 'flag');
  const colorspaceHint = await safeGet<string>('target-colorspace-hint', 'string');

  // ---- output ----
  const outW = await safeGet<number>('osd-dimensions/w', 'int64');
  const outH = await safeGet<number>('osd-dimensions/h', 'int64');
  // Renamed upstream; try both rather than showing nothing on one of them.
  const displayFps = await firstOf<number>(
    ['display-fps', 'estimated-display-fps', 'display-fps-override'],
    'double'
  );

  // ---- audio ----
  const audioCodec = await safeGet<string>('audio-codec-name', 'string');
  const audioBitrate = await safeGet<number>('audio-bitrate', 'int64');
  const inChannels = await safeGet<string>('audio-params/channels', 'string');
  const inRate = await safeGet<number>('audio-params/samplerate', 'int64');
  const inFormat = await safeGet<string>('audio-params/format', 'string');
  const outChannels = await safeGet<string>('audio-out-params/channels', 'string');
  const outRate = await safeGet<number>('audio-out-params/samplerate', 'int64');
  const outFormat = await safeGet<string>('audio-out-params/format', 'string');
  const ao = await safeGet<string>('current-ao', 'string');

  // ---- health ----
  const dropped = await safeGet<number>('frame-drop-count', 'int64');
  const decoderDropped = await safeGet<number>('decoder-frame-drop-count', 'int64');
  const avsync = await safeGet<number>('avsync', 'double');
  const cache = await safeGet<number>('demuxer-cache-duration', 'double');

  const peak =
    maxLuma !== null
      ? `${maxLuma.toFixed(0)} nits`
      : sigPeak !== null
        ? `${sigPeak.toFixed(2)}× SDR white`
        : DASH;

  return [
    {
      heading: 'Source',
      rows: [
        {
          label: 'Resolution',
          value: resolution(sourceW, sourceH),
          note: resolutionClass(sourceW, sourceH),
        },
        { label: 'Video codec', value: text(videoFormat ?? videoCodec), note: videoCodec ?? undefined },
        { label: 'Pixel format', value: text(pixelFormat) },
        {
          label: 'Frame rate',
          value: num(containerFps, 3, ' fps'),
          note: actualFps === null ? undefined : `${actualFps.toFixed(3)} fps measured`,
        },
        { label: 'Video bitrate', value: bitrate(videoBitrate) },
      ],
    },
    displayGroup(displayFps, outW, outH),
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
        },
        describeScaling(sourceW, sourceH, outW, outH, scale, dscale, resizesOnly),
        { label: 'Chroma scaler', value: text(cscale) },
        {
          label: 'Debanding',
          value: deband ? 'on' : 'off',
          note: deband ? undefined : 'off on purpose — debanding adds noise the master did not have',
        },
        { label: 'Dither', value: text(dither) },
      ],
    },
    {
      heading: 'Colour',
      rows: [
        describeHdr(gamma, targetGamma, toneMapping, computePeak, colorspaceHint),
        { label: 'Transfer', value: text(gamma) },
        { label: 'Primaries', value: text(primaries) },
        { label: 'Matrix', value: text(colormatrix) },
        { label: 'Levels', value: text(levels) },
        { label: 'Mastering peak', value: peak },
        {
          label: 'Target',
          value: targetGamma || targetPrimaries
            ? `${text(targetPrimaries)} · ${text(targetGamma)}`
            : DASH,
          note:
            targetGamma || targetPrimaries
              ? undefined
              : 'this build does not expose target-params',
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
          note:
            inChannels && outChannels && inChannels !== outChannels
              ? 'channels differ — the layout is being remapped or downmixed'
              : 'matches the source layout',
        },
        { label: 'Output', value: text(ao) },
      ],
    },
    {
      heading: 'Health',
      rows: [
        {
          label: 'Dropped frames',
          value: `${dropped ?? 0} output · ${decoderDropped ?? 0} decoder`,
          note: (dropped ?? 0) + (decoderDropped ?? 0) > 0 ? 'anything above zero is worth chasing' : undefined,
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
}
