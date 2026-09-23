/**
 * How files are grouped before matching, and for the review queue.
 */
import { describe, expect, it } from 'vitest';
import { groupFiles } from './match';
import type { MediaFile } from '../library/api';

function file(id: number, fileName: string, title: string | null, episode: number | null): MediaFile {
  return {
    id,
    path: `D:/TV/${fileName}`,
    parent_dir: 'D:/TV',
    file_name: fileName,
    size_bytes: 1,
    missing: false,
    match_status: 'parsed',
    parsed_title: title,
    parsed_year: null,
    parsed_season: episode === null ? null : 1,
    parsed_episode: episode,
    parsed_kind: null,
    parsed_from: null,
    title_id: null,
    match_confidence: null,
    match_reason: null,
    matched_title: null,
    episode_name: null,
  };
}

const files = [
  file(1, 'Show.S01E01.mkv', 'Show', 1),
  file(2, 'Show.S01E02.mkv', 'Show', 2),
  file(3, 'S01E05.mkv', null, 5),
];

describe('groupFiles', () => {
  /** The matcher has nothing to search for with no title, so it never sees one. */
  it('leaves untitled files out by default', () => {
    const groups = groupFiles(files);
    expect(groups.map((g) => g.title)).toEqual(['Show']);
    expect(groups[0].files).toHaveLength(2);
  });

  /** The review queue is where an untitled file can finally be seen and named. */
  it('gives each untitled file a group of its own for the review queue', () => {
    const groups = groupFiles(files, { includeUntitled: true });
    const untitled = groups.find((g) => g.untitled);
    expect(untitled?.title).toBe('S01E05');
    expect(untitled?.files.map((f) => f.id)).toEqual([3]);
    expect(untitled?.isSeries).toBe(true);
  });
});
