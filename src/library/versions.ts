/**
 * Versions: the same film or episode in more than one file (owner,
 * 2026-10-24: one title with versions). versions.rs lists the files and keeps
 * the choice; this names each version in Kinema's own words and decides which
 * one Play means.
 *
 * Which one: the version picked last time for the title; the first time, the
 * one that best fits the screen the picture is on — one it can show whole
 * (not more pixels than its biggest mode, not HDR on a screen that cannot
 * show HDR), then HDR where the screen can show it, then the most pixels,
 * then the bigger file. Where the screen is not known, that is the biggest
 * picture, as Play always did. Never a matter of taste: an edition is never
 * preferred over another by itself.
 */
import { invoke } from '@tauri-apps/api/core';
import { fileFacts, releaseNames, resolutionLabel, type FileFacts } from '../ui/badges';
import { initParser } from './parse';
import { readRelease, sourceLabel, type Release } from './release';

export interface VersionFile {
  file_id: number;
  path: string;
  size_bytes: number;
  season: number | null;
  episode: number | null;
  episode_last: number | null;
}

export interface VersionChoice {
  path: string;
  key: string;
}

export interface Duplicate {
  title_id: number;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  file_ids: number[];
  size_bytes: number;
}

export const titleVersions = (titleId: number) =>
  invoke<VersionFile[]>('title_versions', { titleId });
export const versionChoice = (titleId: number) =>
  invoke<VersionChoice | null>('version_choice', { titleId });
export const chooseVersion = (titleId: number, path: string, key: string) =>
  invoke<void>('choose_version', { titleId, path, key });
export const duplicateTitles = () => invoke<Duplicate[]>('duplicate_titles');

/** A version as Play and the Version list see it. */
export interface Version {
  file_id: number;
  path: string;
  size_bytes: number;
  width: number;
  height: number;
  hdr: boolean;
  /** "4K UHD · HDR10 · Director's Cut" — the words without the size. */
  key: string;
  /** The key and the size: "4K UHD · HDR10 · Director's Cut · 58 GB". */
  words: string;
}

export interface ScreenCan {
  width: number;
  height: number;
  /** Whether it can show HDR; null where that is not known. */
  hdr: boolean | null;
}

/** One file's facts and what its name says, as far as they are known. */
export interface FileRead {
  file: Pick<VersionFile, 'file_id' | 'path' | 'size_bytes'>;
  facts: FileFacts | null;
  release: Release | null;
}

export function sizeWords(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function hdrWord(facts: FileFacts | null): string | null {
  const video = facts?.details?.video;
  if (!video) return null;
  if (video.dolby_vision) return 'Dolby Vision';
  if (video.hdr10_plus) return 'HDR10+';
  if (video.transfer === 'pq') return 'HDR10';
  if (video.transfer === 'hlg') return 'HLG';
  return null;
}

const CODEC_WORDS: Record<string, string> = { hevc: 'HEVC', h264: 'AVC', av1: 'AV1', vp9: 'VP9' };

/**
 * Names each file in Kinema's words, from the badges' facts: resolution, HDR
 * and edition; where two would read the same, the video codec, then the
 * source, then the file's name are added; then the size.
 */
export function nameVersions(files: FileRead[]): Version[] {
  const parts = files.map(({ file, facts, release }) => {
    const video = facts?.details?.video;
    const base: string[] = [];
    if (video && video.width > 0 && video.height > 0) {
      base.push(resolutionLabel(video.width, video.height, video.interlaced));
    }
    const hdr = hdrWord(facts);
    if (hdr) base.push(hdr);
    base.push(...(release?.editions ?? []));
    const codec = video ? (CODEC_WORDS[video.codec] ?? video.codec.toUpperCase()) : null;
    const source = release ? sourceLabel(release) : null;
    // Last, the file's own name: what tells two apart when nothing Kinema
    // reads does (an edition guessit does not know, two alike encodes).
    const name = file.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? null;
    return { base, extra: [codec, source, name] };
  });
  const keys = parts.map((p) => [...p.base]);
  for (const extra of [0, 1, 2]) {
    const seen = new Map<string, number>();
    for (const k of keys) seen.set(k.join(' · '), (seen.get(k.join(' · ')) ?? 0) + 1);
    keys.forEach((k, i) => {
      const add = parts[i].extra[extra];
      if ((seen.get(k.join(' · ')) ?? 0) > 1 && add) k.push(add);
    });
  }
  return files.map(({ file, facts }, i) => {
    const video = facts?.details?.video;
    const key = keys[i].join(' · ') || 'Version';
    return {
      file_id: file.file_id,
      path: file.path,
      size_bytes: file.size_bytes,
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      hdr: hdrWord(facts) !== null,
      key,
      words: `${key} · ${sizeWords(file.size_bytes)}`,
    };
  });
}

/** The version that best fits the screen; the rule is at the top of the file. */
export function bestFit(versions: Version[], screen: ScreenCan | null): Version | null {
  const score = (v: Version): number[] => {
    // A little room: a 3840×1600 film is "4K" on a 3840×2160 screen, and a
    // mode list a few pixels short should not count against a file.
    const fits = !screen || (v.width <= screen.width * 1.05 && v.height <= screen.height * 1.05);
    const hdrShown = !v.hdr || screen?.hdr !== false;
    return [
      (fits ? 1 : 0) + (hdrShown ? 1 : 0),
      screen?.hdr === true && v.hdr ? 1 : 0,
      v.width * v.height,
      v.size_bytes,
    ];
  };
  let best: Version | null = null;
  let bestScore: number[] = [];
  for (const v of versions) {
    const s = score(v);
    const at = s.findIndex((x, i) => x !== bestScore[i]);
    if (best === null || (at !== -1 && s[at] > bestScore[at])) {
      best = v;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Which version Play means: the file picked last time (a film), else the
 * version with the same words (a show's next episode), else the best fit.
 */
export function pickVersion(
  versions: Version[],
  choice: VersionChoice | null,
  screen: ScreenCan | null
): Version | null {
  if (choice) {
    const same =
      versions.find((v) => v.path === choice.path) ?? versions.find((v) => v.key === choice.key);
    if (same) return same;
  }
  return bestFit(versions, screen);
}

/** Reads each file's facts and name, as the badges do. */
export async function readVersions(files: VersionFile[]): Promise<Version[]> {
  const facts = await Promise.all(files.map((f) => fileFacts(f.file_id).catch(() => null)));
  await initParser().catch(() => undefined);
  const read = files.map((file, i): FileRead => {
    const f = facts[i];
    let release: Release | null;
    try {
      release = f ? readRelease(releaseNames(f), f.extension) : null;
    } catch {
      release = null;
    }
    return { file, facts: f, release };
  });
  return nameVersions(read);
}

/** The files of each episode or film that is here more than once, by "season:episode" ("film" for a film). */
export function groupVersions(files: VersionFile[]): Map<string, VersionFile[]> {
  const groups = new Map<string, VersionFile[]>();
  for (const f of files) {
    const key = f.episode === null ? 'film' : `${f.season ?? 0}:${f.episode}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const [key, list] of groups) if (list.length < 2) groups.delete(key);
  return groups;
}
