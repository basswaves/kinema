/**
 * Bringing in what was watched elsewhere — the typed side of
 * `src-tauri/src/import_watched.rs`. Matched by IMDb or TMDB number only;
 * what is not is listed, never guessed.
 */
import { invoke } from '@tauri-apps/api/core';

export type ServerKind = 'jellyfin' | 'emby' | 'plex';

export interface ImportReport {
  read: number;
  watched: number;
  resume: number;
  kept: number;
  not_in_library: string[];
  unclear: string[];
  queued: number;
}

/** Kodi's video database on this computer, when Kodi is installed. */
export const kodiDatabase = () => invoke<string | null>('kodi_database');

/** Kodi's database (`MyVideos…db`) or a Trakt export file (`.json`). */
export const importWatchedFile = (path: string) =>
  invoke<ImportReport>('import_watched_file', { path });

/** A Jellyfin, Emby or Plex server, read once; the key is not kept. */
export const importWatchedServer = (kind: ServerKind, url: string, key: string, user: string) =>
  invoke<ImportReport>('import_watched_server', { kind, url, key, user });

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The result in a sentence or two. */
export function reportWords(r: ImportReport): string {
  if (r.read === 0) return 'Nothing watched or begun was found there.';
  const parts = [
    `${n(r.watched, 'film or episode', 'films and episodes')} marked watched`,
    `${n(r.resume, 'resume point', 'resume points')} taken`,
  ];
  if (r.kept > 0) parts.push(`${r.kept} already as here`);
  const missing = r.not_in_library.length + r.unclear.length;
  let words = `Read ${r.read}: ${parts.join(', ')}.`;
  if (missing > 0) words += ` ${missing} could not be matched exactly and were left alone (listed below).`;
  if (r.watched > 0 && r.queued > 0) words += ' What became watched is added to SIMKL once.';
  return words;
}
