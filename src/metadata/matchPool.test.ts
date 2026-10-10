/**
 * Matching several titles at once: how many, in what order, and never one
 * title twice together. The provider is answered "no candidates" for every
 * title, so what is measured is the matcher, not the scoring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaFile } from '../library/api';

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ results: [] }),
  })),
}));

let reading = 0;
let mostReading = 0;
const readingTitles = new Set<string>();
let sameTitleTogether = false;
const refused: number[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'read_nfo') {
      const path = String(args.path);
      if (readingTitles.has(path.toLowerCase())) sameTitleTogether = true;
      readingTitles.add(path.toLowerCase());
      reading++;
      mostReading = Math.max(mostReading, reading);
      await new Promise((r) => setTimeout(r, 20));
      reading--;
      readingTitles.delete(path.toLowerCase());
      return null;
    }
    if (command === 'record_refusal') {
      refused.push(...(args.fileIds as number[]));
      return 1;
    }
    return null;
  }),
}));

const { matchFiles, matchConcurrency } = await import('./match');

function movie(id: number, title: string, year = 2001): MediaFile {
  return {
    id,
    path: `D:/Movies/${title}.mkv`,
    parent_dir: 'D:/Movies',
    file_name: `${title}.mkv`,
    size_bytes: 1,
    missing: false,
    match_status: 'parsed',
    parsed_title: title,
    parsed_year: year,
    parsed_season: null,
    parsed_episode: null,
    parsed_kind: 'movie',
    parsed_from: null,
    title_id: null,
    match_confidence: null,
    match_reason: null,
    matched_title: null,
    episode_name: null,
  };
}

const keys = { tmdb: 'own', tmdbSource: 'own' as const, omdb: null };

beforeEach(() => {
  vi.useFakeTimers();
  reading = 0;
  mostReading = 0;
  readingTitles.clear();
  sameTitleTogether = false;
  refused.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle<T>(promise: Promise<T>): Promise<T> {
  const done = promise.then((value) => ({ value }));
  await vi.runAllTimersAsync();
  return (await done).value;
}

describe('matchConcurrency', () => {
  it('follows the cores, between two and four', () => {
    for (const [cores, expected] of [
      [1, 2],
      [2, 2],
      [3, 3],
      [8, 4],
      [0, 2],
    ] as const) {
      vi.stubGlobal('navigator', { hardwareConcurrency: cores });
      expect(matchConcurrency()).toBe(expected);
    }
  });
});

describe('matchFiles with several titles in flight', () => {
  it('works on no more than the allowed number at once, and on more than one', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    const files = Array.from({ length: 12 }, (_, i) => movie(i + 1, `Film ${i + 1}`));
    const outcome = await settle(matchFiles(files, keys, () => undefined));
    expect(outcome.unmatched).toBe(12);
    expect(mostReading).toBe(4);
    expect([...refused].sort((a, b) => a - b)).toEqual(files.map((f) => f.id));
  });

  it('never has one title twice in flight', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    // The same name in two years: two groups, one title.
    const files = [movie(1, 'Same Name', 1990), movie(2, 'Same Name', 2010), movie(3, 'Other')];
    // Both of the first two read the same NFO path, so overlap would show.
    await settle(
      matchFiles(
        files.map((f) => ({ ...f, path: f.path.replace(/\d+/g, '') })),
        keys,
        () => undefined
      )
    );
    expect(sameTitleTogether).toBe(false);
  });

  it('reports progress to the end', async () => {
    const seen: number[] = [];
    await settle(
      matchFiles([movie(1, 'A Film'), movie(2, 'B Film'), movie(3, 'C Film')], keys, (p) =>
        seen.push(p.groupsDone)
      )
    );
    expect(Math.max(...seen)).toBe(3);
  });
});
