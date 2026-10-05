/**
 * Subtitles from OpenSubtitles — the typed side of `src-tauri/src/opensubtitles.rs`.
 *
 * Two ways in, decided 2026-09-30: "Find subtitles online" in the Audio &
 * subtitles panel, which takes the best match and offers the rest; and, when
 * switched on, forced subtitles fetched by themselves for a file that has none.
 * Everything that talks to OpenSubtitles is in Rust; this loads what it
 * fetched into mpv.
 */
import { invoke } from '@tauri-apps/api/core';
import { canonicalLang, languageName } from './language';
import { addSubtitle } from './engine';

/** Setting key: `'on'` fetches forced subtitles by themselves. Off by default. */
export const AUTO_FORCED_KEY = 'opensubtitles_forced';

export interface SubtitleStatus {
  /** This copy of Kinema has an OpenSubtitles app key. */
  available: boolean;
  user: string | null;
  /** Downloads left today, as OpenSubtitles last said. */
  remaining: number | null;
  reset: string | null;
  auto_forced: boolean;
}

/** One subtitle OpenSubtitles offers. */
export interface Offer {
  file_id: number;
  language: string;
  release: string;
  downloads: number;
  /** Timed for this exact file. */
  matches_file: boolean;
  hearing_impaired: boolean;
  forced: boolean;
  /** Made by a machine or an AI, not a person. */
  translated: boolean;
  trusted: boolean;
}

export interface Found {
  path: string;
  chosen: Offer;
  offers: Offer[];
}

export const subtitleStatus = () => invoke<SubtitleStatus>('opensubtitles_status');
export const signInOpenSubtitles = (username: string, password: string) =>
  invoke<void>('opensubtitles_sign_in', { username, password });
export const signOutOpenSubtitles = () => invoke<void>('opensubtitles_sign_out');

/** Search, and fetch the best. Null when nothing was found. */
export const findSubtitles = (fileId: number, path: string, language: string) =>
  invoke<Found | null>('find_subtitles', { fileId, path, language });

/** Fetch one particular subtitle from the list. */
export const fetchSubtitle = (fileId: number, offerFileId: number, language: string) =>
  invoke<string>('fetch_subtitle', { fileId, offerFileId, language });

/** Forced subtitles for a file that has none — null when there are none. */
export const forcedSubtitle = (fileId: number, path: string, language: string) =>
  invoke<string | null>('forced_subtitle', { fileId, path, language });

/**
 * Put a fetched subtitle into the player and show it. The title says where it
 * came from and, when known, which release it was made for — so two fetched
 * for the same film can be told apart in the panel.
 */
export async function loadSubtitle(
  path: string,
  language: string,
  forced: boolean,
  release?: string
): Promise<void> {
  await addSubtitle(path, language, subtitleTitle(forced, release));
}

/**
 * The languages to offer when searching, first choice first: the one asked
 * for, then the one being spoken, then English. Two-letter codes; never
 * twice the same.
 */
export function searchLanguages(wanted: string | null, spoken: string | null): string[] {
  const all = [wanted, spoken, 'en'].map((l) => canonicalLang(l)).filter((l): l is string => !!l);
  return [...new Set(all)];
}

/** The track title a fetched subtitle gets, release names cut to fit a panel. */
export function subtitleTitle(forced: boolean, release?: string): string {
  const source = forced ? 'Forced · OpenSubtitles' : 'OpenSubtitles';
  const name = release?.trim();
  if (!name) return source;
  return `${source} · ${name.length > 32 ? `${name.slice(0, 31)}…` : name}`;
}

/** One line for the "Choose another" list. */
export function describeOffer(offer: Offer): string {
  const parts = [
    languageName(offer.language) ?? offer.language,
    offer.matches_file ? 'timed for this file' : null,
    offer.hearing_impaired ? 'SDH' : null,
    offer.translated ? 'machine translated' : null,
  ].filter(Boolean);
  return `${parts.join(' · ')} — ${offer.release || 'no release name'}`;
}
