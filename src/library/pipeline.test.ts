import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LibraryRoot, MediaFile } from './api';
import { initParser } from './parse';
import { parseBatchForLibrary } from './pipeline';

function episode(n: number): MediaFile {
  const parentDir = 'D:/TV/Show Name/Season 1';
  const fileName = `Show.Name.S01E${String(n).padStart(2, '0')}.1080p.mkv`;
  return {
    id: n,
    path: `${parentDir}/${fileName}`,
    parent_dir: parentDir,
    file_name: fileName,
    size_bytes: 1,
    missing: false,
    match_status: 'unparsed',
    parsed_title: null,
    parsed_year: null,
    parsed_season: null,
    parsed_episode: null,
    parsed_kind: null,
    parsed_from: null,
    title_id: null,
    match_confidence: null,
    match_reason: null,
    matched_title: null,
    episode_name: null,
  };
}

const roots: LibraryRoot[] = [{ id: 1, path: 'D:/TV', kind: 'tv', file_count: 0 }];

beforeAll(async () => {
  await initParser();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseBatchForLibrary', () => {
  it('parses every file as the library it is in', async () => {
    const parsed = await parseBatchForLibrary([episode(1), episode(2)], roots);
    expect(parsed.map((p) => [p.id, p.kind, p.episode])).toEqual([
      [1, 'episode', 1],
      [2, 'episode', 2],
    ]);
  });

  it('gives the page a turn while a slow device works through a batch', async () => {
    // An old Android box: a tenth of a second a name by the clock.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
    const order: string[] = [];
    // A key press waiting for the page, as the remote's would.
    setTimeout(() => order.push('key handled'), 0);
    const batch = Array.from({ length: 20 }, (_, i) => episode(i + 1));
    await parseBatchForLibrary(batch, roots).then(() => order.push('batch parsed'));
    expect(order).toEqual(['key handled', 'batch parsed']);
  });
});
