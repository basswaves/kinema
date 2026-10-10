/**
 * "This file is far heavier than this device's video chip is made for" — the
 * line under Play on Android.
 *
 * Android reports, per kind of video, the highest bitrate its hardware
 * decoders are made for (`MediaCodecInfo` → `getBitrateRange().upper`). A file
 * far above that may stutter or show no picture while its sound and subtitles
 * play on; on a test box a 4K remux averaging about 88 Mbit/s showed grey, one
 * near 80 dropped a third of its frames, and one at 59 played cleanly, with
 * Android reporting 35 for the HEVC decoder. It is a warning, not a refusal:
 * Play still works, nothing is asked, and the line says only what Android
 * reported and what the file averages (owner, 2026-10-10).
 *
 * Only well over the limit — more than twice — because Android's figure is a
 * general one for the chip, and a file a little above it may still play. What
 * the TV or the chip then does is not claimed.
 *
 * The file's average is its size over its length, sound and subtitles
 * included, so it runs a little above the picture's own; that is why the line
 * says the film averages, not that its picture does.
 */

/** Bits a second, per kind of video, as Android reports them; null when it did not. */
export interface DecoderLimits {
  hevc: number | null;
  avc: number | null;
}

export interface HeavyFile {
  /** The file's size on disk, in bytes. */
  sizeBytes: number | null | undefined;
  /** How long it runs. Without it nothing is said. */
  durationSecs: number | null | undefined;
  /** The codec the file itself reports (ffprobe's name: `hevc`, `h264`), if read. */
  codec?: string | null;
  /** The picture's width in pixels, if read. */
  width?: number | null;
  /** The file's name and the folders above it, for a codec the file did not say. */
  names?: string[];
  /** What the notice calls it: a film or an episode. */
  what?: 'film' | 'episode';
}

/** More than this many times the limit is "far above". */
export const HEAVY_FACTOR = 2;

const EDGE = String.raw`(?:^|[\s._\-\[\]()])`;
const END = String.raw`(?=$|[\s._\-\[\]()])`;
const HEVC_NAME = new RegExp(`${EDGE}(?:hevc|x\\.?265|h\\.?265|uhd|2160p|4k)${END}`, 'i');
const AVC_NAME = new RegExp(`${EDGE}(?:avc|x\\.?264|h\\.?264|1080[pi]|720p|576[pi]|480[pi])${END}`, 'i');

/**
 * Which kind of video the file most likely holds: what it says of itself
 * first, then its name (x265, H.265, 2160p and UHD mean HEVC; x264, H.264
 * and the smaller sizes mean H.264), else null — not known. A codec the file
 * reports that is neither (AV1, VC-1…) is `'other'`: the limits above say
 * nothing about it.
 */
export function likelyCodec(file: Pick<HeavyFile, 'codec' | 'width' | 'names'>): 'hevc' | 'avc' | 'other' | null {
  const codec = file.codec?.toLowerCase();
  if (codec) {
    if (codec === 'hevc' || codec === 'h265') return 'hevc';
    if (codec === 'h264' || codec === 'avc') return 'avc';
    return 'other';
  }
  const names = file.names ?? [];
  if (names.some((n) => HEVC_NAME.test(n))) return 'hevc';
  if (file.width && file.width >= 3000) return 'hevc';
  if (names.some((n) => AVC_NAME.test(n))) return 'avc';
  return null;
}

/** A file's average bitrate in bits a second, or null when its size or length is not known. */
export function averageBitrate(sizeBytes: number | null | undefined, durationSecs: number | null | undefined) {
  if (!sizeBytes || sizeBytes <= 0 || !durationSecs || durationSecs <= 0) return null;
  return (sizeBytes * 8) / durationSecs;
}

const mbit = (bitsPerSecond: number) => Math.round(bitsPerSecond / 1_000_000);

/**
 * The sentence for a file, or null when there is nothing to say: no limit
 * reported, a size or length not known, or the file within twice the limit.
 */
export function heavyFileNotice(file: HeavyFile, limits: DecoderLimits | null): string | null {
  if (!limits) return null;
  const average = averageBitrate(file.sizeBytes, file.durationSecs);
  if (average === null) return null;

  const kind = likelyCodec(file);
  let limit: number | null;
  if (kind === 'other') limit = null;
  else if (kind === 'hevc' || kind === 'avc') limit = limits[kind];
  else {
    // Not known which: the more forgiving of the two, so a file is never
    // called heavy for a chip that would take it.
    const known = [limits.hevc, limits.avc].filter((l): l is number => typeof l === 'number' && l > 0);
    limit = known.length > 0 ? Math.max(...known) : null;
  }
  if (!limit || limit <= 0 || average <= HEAVY_FACTOR * limit) return null;

  return (
    `Android says this device's video chip is made for up to ${mbit(limit)} Mbit/s; ` +
    `this ${file.what ?? 'film'} averages about ${mbit(average)} Mbit/s. ` +
    `It may stutter or show no picture.`
  );
}
