/**
 * A series' badges: the season on screen, summed up, and the episodes that
 * are not like the rest of it.
 *
 * One set of badges for a whole show was wrong for the first real show it
 * met: three seasons of Blu-ray encodes at 2 Mb/s and two of web releases
 * from two services at 9 Mb/s, all shown as the episode Play would start.
 * Other players avoid the question — Plex and Jellyfin show details only on
 * an episode's own page, Kodi skins for the episode under the cursor. Here
 * the badges follow the season tab: a season is nearly always alike, so its
 * summary is short, and where it is not, the difference is said twice — the
 * badge shows every version ("varies"), and each episode that differs from
 * the season's usual carries its own chip in the list. A season all alike
 * adds nothing to its episode rows.
 */
import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { initParser } from '../library/parse';
import { readRelease, type Release } from '../library/release';
import {
  bitrateLabel,
  buildBadges,
  releaseNames,
  studioBadge,
  type Badge,
  type BadgeRow,
  type FileFacts,
} from './badges';
import type { Studio } from './api';

/** One file of a season and what it holds, as Rust sends it. */
export interface EpisodeFacts extends FileFacts {
  file_id: number;
}

export const seasonFacts = (titleId: number, season: number) =>
  invoke<EpisodeFacts[]>('season_facts', { titleId, season });

export interface SeasonFile {
  fileId: number;
  facts: FileFacts;
  release: Release | null;
}

export interface SeasonBadges {
  rows: BadgeRow[];
  /** Chips for the episode rows: what a file has that its season mostly does not. */
  exceptions: Map<number, string[]>;
}

/** Badges one file has exactly one of, in the order they are shown. */
const PICTURE_LABELS = ['Resolution', 'Dolby Vision', 'HDR', 'Video', 'Frame rate', 'Aspect', 'Variable aspect'];
/** The most versions a varying badge lists before it stops. */
const MAX_VERSIONS = 3;
/** As on a film's page. */
const MAX_SOUND = 4;

/** Values by how many files have them, most first; ties in first-seen order. */
function byCount(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/** `8.6–10 Mb/s`: one unit for the pair. */
function rangeLabel(low: string, high: string, unit: string): string {
  return `${low.replace(` ${unit}`, '')}–${high}`;
}

/**
 * One badge summing up a value each file has at most one of — resolution,
 * source — across a season of `n` files.
 */
function summarise(label: string, values: Array<string | undefined>, n: number): Badge | null {
  const present = values.filter((v): v is string => v !== undefined);
  if (present.length === 0) return null;
  const versions = byCount(present);
  if (versions.length === 1) {
    const [value, count] = versions[0];
    return count === n ? { label, value } : { label: `${label} · ${count} of ${n}`, value };
  }
  const shown = versions.slice(0, MAX_VERSIONS).map(([v]) => v);
  const more = versions.length > MAX_VERSIONS ? ' / …' : '';
  return { label: `${label} · varies`, value: shown.join(' / ') + more };
}

/**
 * Sum up a season. `files` in episode order; `studio` is the show's network
 * tile, which belongs to the show rather than to any file.
 */
export function buildSeasonBadges(files: SeasonFile[], studio: Badge | null): SeasonBadges {
  const n = files.length;
  const exceptions = new Map<number, string[]>();
  const perFile = files.map((f) => {
    const rows = buildBadges(f.facts, f.release, null);
    const row = (heading: BadgeRow['heading']) => rows.find((r) => r.heading === heading)?.badges ?? [];
    const one = (badges: Badge[], label: string) => badges.find((b) => b.label === label)?.value;
    return { file: f, picture: row('Picture'), sound: row('Sound'), fileRow: row('File'), one };
  });

  // ---- picture, and source: one value per file ------------------------------
  const picture: Badge[] = [];
  const singles: Array<{ label: string; of: (p: (typeof perFile)[number]) => string | undefined }> = [
    ...PICTURE_LABELS.map((label) => ({ label, of: (p: (typeof perFile)[number]) => p.one(p.picture, label) })),
  ];
  const sourceOf = (p: (typeof perFile)[number]) => p.one(p.fileRow, 'Source');

  const noteExceptions = (label: string, of: (p: (typeof perFile)[number]) => string | undefined) => {
    if (n < 2) return;
    const values = perFile.map(of);
    const usual = byCount(values.map((v) => v ?? ''))[0]?.[0] ?? '';
    perFile.forEach((p, i) => {
      const value = values[i] ?? '';
      if (value === usual) return;
      // An HDR season with one SDR episode: the SDR one has no HDR badge to
      // show, so it says what it is instead. Anything else missing is not
      // worth a chip.
      const chip = value || (label === 'HDR' ? 'SDR' : '');
      if (!chip) return;
      const list = exceptions.get(p.file.fileId) ?? [];
      list.push(chip);
      exceptions.set(p.file.fileId, list);
    });
  };

  for (const { label, of } of singles) {
    const badge = summarise(label, perFile.map(of), n);
    if (badge) picture.push(badge);
    // The aspect is measured once a season, so it cannot differ by episode.
    if (label !== 'Aspect' && label !== 'Variable aspect') noteExceptions(label, of);
  }

  // ---- sound: several per file ----------------------------------------------
  const soundKeys = perFile.map((p) => p.sound.map((b) => `${b.label}\u0000${b.value}`));
  const sound: Badge[] = byCount(soundKeys.flat())
    .slice(0, MAX_SOUND)
    .map(([key, count]) => {
      const [label, value] = key.split('\u0000');
      return count === n ? { label, value } : { label: `${label} · ${count} of ${n}`, value };
    });
  if (n > 1 && sound.length > 0) {
    // An episode without the season's main sound format says what it has.
    const main = byCount(soundKeys.flat())[0][0];
    perFile.forEach((p, i) => {
      if (soundKeys[i].includes(main) || p.sound.length === 0) return;
      const first = p.sound[0];
      const list = exceptions.get(p.file.fileId) ?? [];
      list.push(`${first.label} ${first.value}`);
      exceptions.set(p.file.fileId, list);
    });
  }

  // ---- file -------------------------------------------------------------------
  const file: Badge[] = [];
  const source = summarise('Source', perFile.map(sourceOf), n);
  if (source) file.push(source);
  noteExceptions('Source', sourceOf);

  const editions = byCount(perFile.flatMap((p) => p.fileRow.filter((b) => b.label === 'Edition').map((b) => b.value)));
  for (const [value, count] of editions) {
    file.push({ label: count === n ? 'Edition' : `Edition · ${count} of ${n}`, value });
  }

  const subtitleCounts = files
    .map((f) => f.facts.details?.subtitles.length)
    .filter((c): c is number => c !== undefined && c > 0);
  if (subtitleCounts.length > 0) {
    const low = Math.min(...subtitleCounts);
    const high = Math.max(...subtitleCounts);
    const sdh = perFile.some((p) => p.one(p.fileRow, 'Subtitles')?.includes('SDH'));
    const count = low === high ? String(low) : `${low}–${high}`;
    file.push({ label: 'Subtitles', value: sdh ? `${count} · SDH` : count });
  }

  const rates = files.map((f) => f.facts.details?.bit_rate).filter((r): r is number => Boolean(r));
  if (rates.length > 0) {
    const low = bitrateLabel(Math.min(...rates));
    const high = bitrateLabel(Math.max(...rates));
    file.push({ label: 'Bitrate', value: low === high ? low : rangeLabel(low, high, 'Mb/s') });
  }
  if (studio) file.push(studio);

  const rows: BadgeRow[] = [
    { heading: 'Picture', badges: picture },
    { heading: 'Sound', badges: sound },
    { heading: 'File', badges: file },
  ];
  return { rows: rows.filter((r) => r.badges.length > 0), exceptions };
}

/** What has been loaded, and for which season, so another season's never shows as this one's. */
interface Loaded {
  titleId: number;
  season: number;
  files: SeasonFile[];
}

/**
 * The badges for one season of a series, loaded as the season tab changes.
 * While the next season loads the previous one stays, headed with its own
 * number, so the page does not jump under the remote.
 */
export function useSeasonBadges(
  titleId: number,
  season: number | null,
  studios: Studio[]
): (SeasonBadges & { season: number; files: number }) | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (season === null) return;
    let cancelled = false;
    seasonFacts(titleId, season)
      .then(async (found) => {
        await initParser();
        if (cancelled) return;
        setLoaded({
          titleId,
          season,
          files: found.map((f) => ({
            fileId: f.file_id,
            facts: f,
            release: readRelease(releaseNames(f), f.extension),
          })),
        });
      })
      .catch((e) => console.warn('season badge lookup failed', e));
    return () => {
      cancelled = true;
    };
  }, [titleId, season]);

  return useMemo(() => {
    if (!loaded || loaded.titleId !== titleId || loaded.files.length === 0) return null;
    return {
      ...buildSeasonBadges(loaded.files, studioBadge('series', studios)),
      season: loaded.season,
      files: loaded.files.length,
    };
  }, [loaded, titleId, studios]);
}
