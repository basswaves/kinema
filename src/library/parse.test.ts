/**
 * What the parser makes of a filename — run against the real guessit-js, not a
 * stand-in, because the failures here were always the parser's actual output.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initParser, parseMediaFile } from './parse';
import type { MediaFile } from './api';

function file(fileName: string, parentDir: string): MediaFile {
  return {
    id: 1,
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

beforeAll(async () => {
  await initParser();
});

describe('parseMediaFile', () => {
  it('keeps both ends of a double-episode file', () => {
    const parsed = parseMediaFile(file('Show.Name.S01E01E02.1080p.mkv', 'D:/TV/Show Name'), 'tv');
    expect(parsed.title).toBe('Show Name');
    expect(parsed.episode).toBe(1);
    expect(parsed.episodeLast).toBe(2);
  });

  it('leaves the range empty for a single episode', () => {
    const parsed = parseMediaFile(file('Show.Name.S01E03.mkv', 'D:/TV/Show Name'), 'tv');
    expect(parsed.episode).toBe(3);
    expect(parsed.episodeLast).toBeNull();
  });
});
