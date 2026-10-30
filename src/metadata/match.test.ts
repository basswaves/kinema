/**
 * How files are grouped before matching, and for the review queue.
 */
import { describe, expect, it } from 'vitest';
import { groupFiles, idsInGroupNames, searchableName, type FileGroup } from './match';
import { idsInName } from './nfo';
import type { MediaFile } from '../library/api';

function file(
  id: number,
  fileName: string,
  title: string | null,
  episode: number | null
): MediaFile {
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

describe('ids in names', () => {
  it('reads the Jellyfin, Plex and bare forms, in any case', () => {
    expect(idsInName('Film (2010) [imdbid-tt0980970].mkv')?.imdb).toBe('tt0980970');
    expect(idsInName('Film (2010) [tmdbid-27205].mkv')?.tmdb).toBe('27205');
    expect(idsInName('Film (2010) {IMDB-TT0980970}.mkv')?.imdb).toBe('tt0980970');
    expect(idsInName('Film (2010) {tmdb-27205}.mkv')?.tmdb).toBe('27205');
    expect(idsInName('Film.2010.tmdb-27205.mkv')?.tmdb).toBe('27205');
    expect(idsInName('Film.2010.imdb-tt0980970.mkv')?.imdb).toBe('tt0980970');
    expect(idsInName('Film (2010) [tmdbid=27205]')?.tmdb).toBe('27205');
  });

  it('finds none in an ordinary name', () => {
    expect(idsInName('Film (2010) 1080p.mkv')).toBeNull();
    expect(idsInName('Tmdbx 2010.mkv')).toBeNull();
  });

  const movie = (name: string, dir: string): FileGroup => ({
    key: 'k',
    title: 'Some Film',
    year: 2010,
    isSeries: false,
    files: [{ ...file(1, name, 'Some Film', null), parent_dir: dir }],
    maxSeason: null,
  });

  it('takes a film’s id from its file name, then from its own folder', () => {
    expect(idsInGroupNames(movie('Some Film [tmdbid-1].mkv', 'D:/Films'))?.tmdb).toBe('1');
    expect(idsInGroupNames(movie('Some Film.mkv', 'D:/Films/Some Film [tmdbid-2]'))?.tmdb).toBe(
      '2'
    );
  });

  /** A folder of many films must not lend its one id to all of them. */
  it('ignores the id of a folder named after something else', () => {
    expect(idsInGroupNames(movie('Some Film.mkv', 'D:/Films/Saga [tmdbid-3]'))).toBeNull();
  });

  it('takes a show’s id from its folder above a season folder', () => {
    const group: FileGroup = {
      key: 'k',
      title: 'Show',
      year: null,
      isSeries: true,
      files: [
        { ...file(1, 'Show.S01E01.mkv', 'Show', 1), parent_dir: 'D:/TV/Show {tmdb-9}/Season 1' },
      ],
      maxSeason: 1,
    };
    expect(idsInGroupNames(group)?.tmdb).toBe('9');
  });

  it('gives no id when the files of one group disagree', () => {
    const group = movie('Some Film [tmdbid-1].mkv', 'D:/Films');
    group.files.push({
      ...file(2, 'Some Film [tmdbid-5].mkv', 'Some Film', null),
      parent_dir: 'D:/Films',
    });
    expect(idsInGroupNames(group)).toBeNull();
  });
});

describe('searchableName', () => {
  /** T13: the manual search box was filled with "F1 [2025]". */
  it('cleans a file name for the manual search box', () => {
    expect(searchableName('F1 [2025].mkv')).toBe('F1');
    expect(searchableName('Some.Film.2019.1080p.BluRay.mkv')).toBe('Some Film');
    expect(searchableName('Some_Film_720p.mkv')).toBe('Some Film');
    expect(searchableName('1917.mkv')).toBe('1917');
  });
});
