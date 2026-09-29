/**
 * The detail page's badges: what a file holds, in three rows — picture, sound,
 * file — the way a Kodi skin or a Zidoo player shows them, in Kinema's own
 * lettering rather than the brands' logos (see HISTORY.md, "Picture and sound
 * badges").
 *
 * Everything but the source is the file's own account of itself, read by
 * ffprobe at scan time (`probe.rs`) and measured (`aspect.rs`). The source is
 * read from the release name (`release.ts`), because nothing inside a video
 * says whether it was remuxed or re-encoded.
 *
 * A badge describes the **file**, not what reaches the screen. Windows cannot
 * send Dolby Vision, so a profile 7 film plays as its HDR10 base layer; the
 * stats panel (`i`) says what is actually sent.
 */
import { invoke } from '@tauri-apps/api/core';
import type { Release } from '../library/release';
import type { Studio } from './api';
import { sourceLabel } from '../library/release';

// ---- what Rust sends (probe.rs → MediaDetails, FileFacts) ------------------

export interface DolbyVision {
  profile: number;
  level: number | null;
  compatibility: number | null;
  enhancement_layer: 'FEL' | 'MEL' | null;
}

export interface VideoDetails {
  stream_index: number | null;
  codec: string;
  profile: string | null;
  width: number;
  height: number;
  bit_depth: number | null;
  frame_rate: number | null;
  interlaced: boolean;
  aspect_ratio: number | null;
  transfer: 'sdr' | 'pq' | 'hlg';
  hdr10_plus: boolean;
  dolby_vision: DolbyVision | null;
  mastering_peak_nits: number | null;
  max_cll: number | null;
  max_fall: number | null;
}

export interface AudioTrack {
  codec: string;
  profile: string | null;
  channels: number | null;
  layout: string | null;
  language: string | null;
  title: string | null;
  default: boolean;
  commentary: boolean;
}

export interface SubtitleTrack {
  codec: string;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  hearing_impaired: boolean;
}

export interface MediaDetails {
  container: string | null;
  duration_secs: number | null;
  bit_rate: number | null;
  video: VideoDetails | null;
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
}

export interface FileFacts {
  details: MediaDetails | null;
  picture_aspect: number | null;
  picture_aspect_alt: number | null;
  file_name: string;
  parent_dir: string;
  extension: string;
  root_path: string;
}

/** The badges' facts for one file, or null for a file the library lacks. */
export const fileFacts = (fileId: number) => invoke<FileFacts | null>('file_facts', { fileId });

// ---- the names the source is read from --------------------------------------

function comparable(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

/**
 * The file's name, then its folder and the folder above that — stopping at
 * the library folder, which is "Movies" or "TV", never a release name.
 */
export function releaseNames(facts: Pick<FileFacts, 'file_name' | 'parent_dir' | 'root_path'>): string[] {
  const names = [facts.file_name];
  const root = comparable(facts.root_path);
  let dir = facts.parent_dir.replace(/[\\/]+$/, '');
  for (let i = 0; i < 2; i++) {
    if (!dir || comparable(dir) === root || !comparable(dir).startsWith(root + '/')) break;
    const cut = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'));
    names.push(dir.slice(cut + 1));
    dir = cut > 0 ? dir.slice(0, cut) : '';
  }
  return names;
}

// ---- the badges --------------------------------------------------------------

/** One tile: a small heading over the value, `DOLBY VISION` / `Profile 7 · FEL`. */
export interface Badge {
  label: string;
  value: string;
  /** Logos drawn in place of the value, which is then their names in words. */
  logos?: Studio[];
}

export interface BadgeRow {
  heading: 'Picture' | 'Sound' | 'File';
  badges: Badge[];
}

/** `4K UHD`, `1080p`, `576i`. By width first: a scope film cropped to 3840×1600 is still 4K. */
export function resolutionLabel(width: number, height: number, interlaced: boolean): string {
  const scan = interlaced ? 'i' : 'p';
  if (width >= 7000 || height >= 4000) return '8K';
  if (width >= 3200 || height >= 2000) return '4K UHD';
  if (width >= 1800 || height >= 1000) return `1080${scan}`;
  if (width >= 1200 || height >= 700) return `720${scan}`;
  return `${height}${scan}`;
}

const CODECS: Record<string, string> = {
  hevc: 'HEVC',
  h264: 'AVC',
  av1: 'AV1',
  vp9: 'VP9',
  vc1: 'VC-1',
  mpeg2video: 'MPEG-2',
  mpeg4: 'MPEG-4',
};

/** Rates as the industry names them; anything else to three decimals. */
const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120];

export function frameRateLabel(fps: number): string {
  const named = FRAME_RATES.find((r) => Math.abs(r - fps) < 0.01);
  if (named !== undefined) return String(named);
  return String(Math.round(fps * 1000) / 1000);
}

/** Ratios as films are described, when the measurement is within a hair. */
const ASPECTS = [1.33, 1.37, 1.43, 1.66, 1.78, 1.85, 1.9, 2.0, 2.2, 2.35, 2.39, 2.55, 2.76];

export function aspectLabel(ratio: number): string {
  const named = ASPECTS.find((a) => Math.abs(a - ratio) <= 0.015);
  return `${(named ?? ratio).toFixed(2)}:1`;
}

/** `Profile 7 · FEL`, `Profile 8.1`, `Profile 5`. */
export function dolbyVisionLabel(dv: DolbyVision): string {
  // Profile 8's compatibility is its sub-profile: 8.1 falls back to HDR10,
  // 8.2 to SDR, 8.4 to HLG.
  const profile =
    dv.profile === 8 && dv.compatibility !== null && [1, 2, 4].includes(dv.compatibility)
      ? `8.${dv.compatibility}`
      : String(dv.profile);
  return dv.enhancement_layer ? `Profile ${profile} · ${dv.enhancement_layer}` : `Profile ${profile}`;
}

/** `7.1`, `5.1`, `2.0`. ffprobe's `5.1(side)` is still 5.1 to anyone reading it. */
export function channelLabel(track: Pick<AudioTrack, 'layout' | 'channels'>): string | null {
  const layout = track.layout?.replace(/\(.*\)$/, '') ?? null;
  if (layout === 'stereo') return '2.0';
  if (layout === 'mono') return '1.0';
  if (layout && /^\d\.\d(\.\d)?$/.test(layout)) return layout;
  return track.channels ? `${track.channels} ch` : null;
}

/**
 * One audio track as a badge. The heading is the format, the value what it
 * carries: `DOLBY TRUEHD` / `Atmos · 7.1`, `DTS-HD MA` / `DTS:X · 7.1`.
 *
 * ffprobe names object audio in the track's profile itself ("Dolby TrueHD +
 * Dolby Atmos", "DTS-HD MA + DTS:X"), so Atmos and DTS:X are read from there
 * and nowhere else.
 */
export function audioBadge(track: AudioTrack): Badge {
  const profile = track.profile ?? '';
  const channels = channelLabel(track);
  const value = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || '—';
  const atmos = profile.includes('Atmos') ? 'Atmos' : null;

  switch (track.codec) {
    case 'truehd':
      return { label: 'Dolby TrueHD', value: value(atmos, channels) };
    case 'eac3':
      return { label: 'Dolby Digital+', value: value(atmos, channels) };
    case 'ac3':
      return { label: 'Dolby Digital', value: value(channels) };
    case 'dts': {
      // "DTS-HD MA + DTS:X IMAX", "DTS-HD MA + DTS:X", "DTS-HD MA", "DTS-HD HRA",
      // "DTS Express", "DTS-ES", "DTS 96/24", or none for core DTS.
      const [base, extension] = profile.split(' + ');
      const objects = extension?.startsWith('DTS:X') ? extension : null;
      return { label: base || 'DTS', value: value(objects, channels) };
    }
    case 'flac':
      return { label: 'FLAC', value: value(channels) };
    case 'alac':
      return { label: 'ALAC', value: value(channels) };
    case 'aac':
      return { label: 'AAC', value: value(channels) };
    case 'opus':
      return { label: 'Opus', value: value(channels) };
    case 'mp3':
      return { label: 'MP3', value: value(channels) };
    default:
      if (track.codec.startsWith('pcm_')) return { label: 'PCM', value: value(channels) };
      return { label: track.codec.toUpperCase(), value: value(channels) };
  }
}

/** Sound tiles beyond this many say more about the file than anyone reads. */
const MAX_SOUND_BADGES = 4;

/** Hearing-impaired subtitles, by flag or, since few files set it, by name. */
function isSdh(track: SubtitleTrack): boolean {
  return track.hearing_impaired || /\b(sdh|cc|hearing)\b/i.test(track.title ?? '');
}

/** Studio logos shown at most. More is a row of logos nobody reads. */
const MAX_STUDIOS = 3;

/**
 * The studio tile: the companies (or a series' networks) that have a logo,
 * up to three, drawn as logos; the first two by name when none has one.
 * TMDB's order is kept. It names no company first, so none is chosen.
 */
export function studioBadge(kind: string, studios: Studio[]): Badge | null {
  const label = kind === 'series' ? 'Network' : 'Studio';
  const withLogos = studios.filter((s) => s.logo_url || s.logo_path).slice(0, MAX_STUDIOS);
  if (withLogos.length > 0) {
    return { label, value: withLogos.map((s) => s.name).join(' · '), logos: withLogos };
  }
  const named = studios.slice(0, 2);
  return named.length > 0 ? { label, value: named.map((s) => s.name).join(' · ') } : null;
}

/**
 * The rows for one file. `release` is what its name says (`readRelease`), or
 * null while that is still being read; `studio` is the title's studio tile,
 * if it has one. A row with nothing in it is left out.
 */
export function buildBadges(
  facts: FileFacts | null,
  release: Release | null,
  studio: Badge | null = null
): BadgeRow[] {
  const details = facts?.details ?? null;
  const video = details?.video ?? null;
  const picture: Badge[] = [];
  const sound: Badge[] = [];
  const file: Badge[] = [];

  if (video && video.width > 0 && video.height > 0) {
    picture.push({
      label: 'Resolution',
      value: resolutionLabel(video.width, video.height, video.interlaced),
    });
    if (video.dolby_vision) {
      picture.push({ label: 'Dolby Vision', value: dolbyVisionLabel(video.dolby_vision) });
    }
    const hdr = video.hdr10_plus
      ? 'HDR10+'
      : video.transfer === 'pq'
        ? 'HDR10'
        : video.transfer === 'hlg'
          ? 'HLG'
          : null;
    if (hdr) {
      const nits = video.transfer === 'pq' && video.mastering_peak_nits;
      picture.push({
        label: 'HDR',
        value: nits ? `${hdr} · ${Math.round(nits)} nits` : hdr,
      });
    }
    const codec = CODECS[video.codec] ?? video.codec.toUpperCase();
    picture.push({
      label: 'Video',
      value: video.bit_depth ? `${codec} ${video.bit_depth}-bit` : codec,
    });
    if (video.frame_rate) {
      picture.push({ label: 'Frame rate', value: frameRateLabel(video.frame_rate) });
    }
    // The measured shape when there is one; otherwise the file's own figure,
    // as every other player shows it.
    const main = facts?.picture_aspect ?? video.aspect_ratio;
    if (main) {
      const alt = facts?.picture_aspect_alt;
      picture.push(
        alt
          ? { label: 'Variable aspect', value: `${aspectLabel(main)} · ${aspectLabel(alt)}` }
          : { label: 'Aspect', value: aspectLabel(main) }
      );
    }
  }

  const seen = new Set<string>();
  for (const track of details?.audio ?? []) {
    if (track.commentary || /commentary/i.test(track.title ?? '')) continue;
    const badge = audioBadge(track);
    const key = `${badge.label}|${badge.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (sound.length < MAX_SOUND_BADGES) sound.push(badge);
  }
  if (release?.auro3d) sound.push({ label: 'Immersive', value: 'Auro-3D' });

  const source = release ? sourceLabel(release) : null;
  if (source) file.push({ label: 'Source', value: source });
  for (const edition of release?.editions ?? []) file.push({ label: 'Edition', value: edition });
  const subtitles = details?.subtitles ?? [];
  if (subtitles.length > 0) {
    file.push({
      label: 'Subtitles',
      value: subtitles.some(isSdh) ? `${subtitles.length} · SDH` : String(subtitles.length),
    });
  }
  if (details?.bit_rate) {
    file.push({ label: 'Bitrate', value: `${Math.round(details.bit_rate / 1_000_000)} Mb/s` });
  }
  if (studio) file.push(studio);

  const rows: BadgeRow[] = [
    { heading: 'Picture', badges: picture },
    { heading: 'Sound', badges: sound },
    { heading: 'File', badges: file },
  ];
  return rows.filter((row) => row.badges.length > 0);
}
