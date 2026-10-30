/**
 * The lines a title's page adds under its overview (details page round 1):
 * who made it, whether a show goes on, and what the file is. Each from what
 * TMDB or the file says; with nothing known the line is left out, never
 * guessed — a Wikidata film has no credits line at all.
 */
import type { About } from './api';
import type { FileFacts } from './badges';
import { formatBytes } from './format';
import { languageName } from '../player/language';

/** "Directed by A and B", "Written by C", or for a show "Created by D". */
export function creditLines(about: About, kind: string): string[] {
  const list = (names: string[]) =>
    names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const lines: string[] = [];
  if (about.directors.length > 0) {
    lines.push(`${kind === 'series' ? 'Created' : 'Directed'} by ${list(about.directors)}`);
  }
  if (about.writers.length > 0) lines.push(`Written by ${list(about.writers)}`);
  return lines;
}

/** TMDB's `YYYY-MM-DD` as a date in the system's words: "12 Nov 2026". */
function dateWords(day: string): string | null {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * A show's state: "Ended", "Season 3 airs 12 Nov 2026", "S2 E5 airs …".
 * `today` is `YYYY-MM-DD`. A date already past says nothing about the next
 * one (the scan fetches the show again for it), so it is not shown.
 */
export function showStatusLine(about: About, today: string): string | null {
  const status = about.show_status;
  const date = about.next_air_date;
  if (date && date >= today) {
    const when = dateWords(date);
    const season = about.next_air_season;
    const episode = about.next_air_episode;
    if (when && season && episode === 1) return `Season ${season} airs ${when}`;
    if (when && season && episode) return `S${season} E${episode} airs ${when}`;
    if (when) return `Next episode airs ${when}`;
  }
  switch (status) {
    case 'Ended':
      return 'Ended';
    case 'Canceled':
      return 'Cancelled';
    case 'Returning Series':
      return 'Returning series';
    case 'In Production':
    case 'Planned':
    case 'Pilot':
      return 'In production';
    default:
      return null;
  }
}

/** Today as TMDB writes dates, in the system's own time zone. */
export function todayString(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The seconds left to watch: the runtime, less where Play would resume. */
export function secondsLeft(
  runtimeMins: number | null,
  resumeAt: number | null,
  resumeShare: number | null
): number | null {
  if (!runtimeMins) return null;
  const total = runtimeMins * 60;
  if (resumeAt !== null) return Math.max(0, total - resumeAt);
  if (resumeShare !== null) return Math.max(0, total * (1 - resumeShare));
  return total;
}

/** One line of the file's details: a heading and what the file says. */
export interface FileInfoRow {
  heading: string;
  value: string;
}

/** Each language once, named, in the file's order; unknowns left out. */
function languages(codes: (string | null)[]): string {
  const names: string[] = [];
  for (const code of codes) {
    const name = languageName(code);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(', ');
}

/** The container as a person names it: ffprobe's `matroska,webm` is MKV. */
function containerWords(container: string | null, extension: string): string {
  const ext = extension.replace(/^\./, '').toUpperCase();
  if (!container) return ext;
  if (container.startsWith('matroska')) return 'Matroska (MKV)';
  if (container.startsWith('mov,mp4')) return ext === 'MOV' ? 'QuickTime (MOV)' : 'MPEG-4 (MP4)';
  if (container === 'mpegts') return `MPEG transport stream (${ext})`;
  if (container === 'avi') return 'AVI';
  return ext || container;
}

/** The file's details, as the expandable File info lists them. */
export function fileInfoRows(facts: FileFacts): FileInfoRow[] {
  const rows: FileInfoRow[] = [
    { heading: 'File', value: facts.file_name },
    { heading: 'Folder', value: facts.parent_dir },
  ];
  if (facts.size_bytes) rows.push({ heading: 'Size', value: formatBytes(facts.size_bytes) });
  const details = facts.details;
  rows.push({ heading: 'Container', value: containerWords(details?.container ?? null, facts.extension) });
  if (details?.bit_rate) {
    rows.push({ heading: 'Bitrate', value: `${(details.bit_rate / 1_000_000).toFixed(1)} Mb/s` });
  }
  const audio = languages(details?.audio.map((a) => a.language) ?? []);
  if (audio) rows.push({ heading: 'Audio', value: audio });
  const subtitles = languages(details?.subtitles.map((s) => s.language) ?? []);
  if (subtitles) rows.push({ heading: 'Subtitles', value: subtitles });
  return rows;
}
