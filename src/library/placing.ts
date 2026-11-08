/**
 * Files and title (GitHub #14, `placing.rs`): which files a title holds,
 * folder by folder and season by season, and where a person puts some of
 * them — another season (Specials too), other episode numbers, a title of
 * their own. Only the library's rows change: no file is renamed, moved or
 * written beside, so a file being seeded stays exactly as it is.
 *
 * The planning here is pure, so it is tested without a backend
 * (placing.test.ts).
 */
import { invoke } from '@tauri-apps/api/core';

/** One file of a title, with where it is now and what its name says. */
export interface TitleFile {
  file_id: number;
  path: string;
  parent_dir: string;
  file_name: string;
  root_path: string | null;
  missing: boolean;
  season: number | null;
  episode: number | null;
  episode_last: number | null;
  name_season: number | null;
  name_episode: number | null;
  name_episode_last: number | null;
  placed: boolean;
  parsed_title: string | null;
}

/** Where one file goes. `episode_last` left out keeps a two-episode file two. */
export interface Placement {
  file_id: number;
  season: number | null;
  episode: number | null;
  episode_last?: number | null;
}

/** A file to place, with the numbers its name says. */
export interface PlaceFile {
  id: number;
  file_name: string;
  season: number | null;
  episode: number | null;
  parsed_title?: string | null;
}

/** Where the hand-placed files beside a new one went. */
export interface Beside {
  title_id: number;
  title: string;
  season: number | null;
  shift: number;
}

export const titleFiles = (titleId: number) => invoke<TitleFile[]>('title_files', { titleId });
export const placeFiles = (placements: Placement[], reason: string) =>
  invoke<number>('place_files', { placements, reason });
export const unplaceFiles = (fileIds: number[]) => invoke<number>('unplace_files', { fileIds });
export const placedBeside = (fileIds: number[]) =>
  invoke<Beside | null>('placed_beside', { fileIds });
export const placeAsBeside = (fileIds: number[]) =>
  invoke<Beside>('place_as_beside', { fileIds });

/** The reason a new file beside hand-placed ones waits with (placing.rs). */
export const BESIDE_REASON = 'beside files placed by hand';

export function seasonLabel(season: number | null): string {
  if (season === null) return 'no season';
  return season === 0 ? 'Specials' : `Season ${season}`;
}

/** The last part of a folder's path, whichever separator it uses. */
export function folderName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** One row of Files and title: a folder and a season. */
export interface FolderRow {
  key: string;
  folder: string;
  parentDir: string;
  rootPath: string | null;
  season: number | null;
  files: TitleFile[];
  /** Every file of the row was missing at the last scan. */
  missing: boolean;
  placed: boolean;
}

/**
 * A row per folder and season: a folder holding three seasons loose is three
 * rows, so "one folder" and "one season" are the same action.
 */
export function folderRows(files: TitleFile[]): FolderRow[] {
  const rows = new Map<string, FolderRow>();
  for (const f of files) {
    const key = `${f.parent_dir}\u0000${f.season ?? ''}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        folder: folderName(f.parent_dir),
        parentDir: f.parent_dir,
        rootPath: f.root_path,
        season: f.season,
        files: [],
        missing: true,
        placed: false,
      };
      rows.set(key, row);
    }
    row.files.push(f);
    row.missing &&= f.missing;
    row.placed ||= f.placed;
  }
  return [...rows.values()];
}

const byName = (a: PlaceFile, b: PlaceFile) =>
  (a.episode ?? Infinity) - (b.episode ?? Infinity) || a.file_name.localeCompare(b.file_name);

/**
 * Where each file goes for a season and a first episode. The files keep their
 * gaps (E01, E02, E04 from 1 stays 1, 2, 4), a file with no number follows in
 * name order, and a row picked by hand goes where it was picked.
 */
export function planPlacements(
  files: PlaceFile[],
  season: number,
  first: number,
  picked: ReadonlyMap<number, number> = new Map()
): Placement[] {
  const sorted = [...files].sort(byName);
  const numbered = sorted.filter((f) => f.episode !== null);
  const base = numbered.length ? Math.min(...numbered.map((f) => f.episode as number)) : 0;
  let next = numbered.length
    ? first + Math.max(...numbered.map((f) => f.episode as number)) - base + 1
    : first;
  return sorted.map((f) => {
    const episode =
      picked.get(f.id) ?? (f.episode !== null ? first + (f.episode - base) : next++);
    return { file_id: f.id, season, episode };
  });
}

/** The first episode the plan starts at, to show in `First episode`. */
export const firstOf = (files: PlaceFile[]) => {
  const n = files.map((f) => f.episode).filter((e): e is number => e !== null);
  return n.length ? Math.min(...n) : 1;
};

/**
 * Seasons to offer: what the service lists, plus the seasons in the names,
 * Specials first as on the page's own tabs order of choosing.
 */
export function seasonsOffered(
  listed: ReadonlyArray<{ season: number }>,
  named: ReadonlyArray<number | null>
): number[] {
  const all = new Set<number>(listed.map((e) => e.season));
  for (const s of named) if (s !== null) all.add(s);
  return [...all].sort((a, b) => a - b);
}

const holds = (f: TitleFile, season: number | null, episode: number | null) =>
  season !== null &&
  episode !== null &&
  f.season === season &&
  f.episode !== null &&
  episode >= f.episode &&
  episode <= (f.episode_last ?? f.episode);

/** Files of the plan whose place already has a file of the title: second copies. */
export function secondCopies(plan: Placement[], title: TitleFile[]): Set<number> {
  const moving = new Set(plan.map((p) => p.file_id));
  const here = title.filter((f) => !moving.has(f.file_id) && !f.missing);
  return new Set(
    plan.filter((p) => here.some((f) => holds(f, p.season, p.episode))).map((p) => p.file_id)
  );
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * A plain link that would stack these files on episodes another, differently
 * named group already has (how #14's reporter got stuck): the seasons and how
 * many. Empty when nothing would stack, or when the files there have the same
 * name (a second copy in another quality is what a person wants).
 */
export function wouldStack(
  files: PlaceFile[],
  title: TitleFile[]
): { seasons: number[]; count: number } {
  const ours = new Set(files.map((f) => norm(f.parsed_title)));
  const ids = new Set(files.map((f) => f.id));
  const others = title.filter(
    (f) => !ids.has(f.file_id) && !f.missing && !ours.has(norm(f.parsed_title))
  );
  const stacked = files.filter((f) => others.some((o) => holds(o, f.season, f.episode)));
  return {
    seasons: [...new Set(stacked.map((f) => f.season as number))].sort((a, b) => a - b),
    count: stacked.length,
  };
}

/** The name most of these files were read as, for a title of their own. */
export function commonName(files: TitleFile[]): string {
  const votes = new Map<string, number>();
  for (const f of files) {
    const n = (f.parsed_title ?? '').trim();
    if (n) votes.set(n, (votes.get(n) ?? 0) + 1);
  }
  let best = '';
  for (const [n, v] of votes) if (v > (votes.get(best) ?? 0)) best = n;
  return best || folderName(files[0]?.parent_dir ?? '');
}
