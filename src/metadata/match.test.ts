/**
 * How files are grouped before matching, and for the review queue.
 */
import { describe, expect, it } from 'vitest';
import { groupFiles, groupName, idsInGroupNames, searchableName, type FileGroup } from './match';
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

/** A show's file with a year, as the parser leaves it. */
function shown(id: number, path: string, title: string, year: number | null, season = 1): MediaFile {
  const cut = path.lastIndexOf('/');
  return {
    ...file(id, path.slice(cut + 1), title, id),
    path,
    parent_dir: path.slice(0, cut),
    parsed_year: year,
    parsed_season: season,
  };
}

describe('groupFiles: shows of one name', () => {
  const FIRST = 'D:/TV/Battlestar Galactica (1978)/Season 1/S01E01.mkv';
  const SECOND = 'D:/TV/Battlestar Galactica (2003)/Season 1/S01E01.mkv';

  it('different years are different shows', () => {
    const groups = groupFiles([
      shown(1, FIRST, 'Battlestar Galactica', 1978),
      shown(2, SECOND, 'Battlestar Galactica', 2003),
    ]);
    expect(groups.map((g) => g.year)).toEqual([1978, 2003]);
    expect(groups.every((g) => g.isSeries && g.files.length === 1)).toBe(true);
  });

  it('files with no year join the one year there is, whichever comes first', () => {
    const groups = groupFiles([
      shown(1, 'D:/TV/Lost/Lost S01E01.mkv', 'Lost', null),
      shown(2, 'D:/TV/Lost (2004)/S01E02.mkv', 'Lost', 2004),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ year: 2004, key: 'tv::lost::' });
    expect(groups[0].files).toHaveLength(2);
  });

  it('with two years, a file with none stays on its own', () => {
    const groups = groupFiles([
      shown(1, FIRST, 'Battlestar Galactica', 1978),
      shown(2, SECOND, 'Battlestar Galactica', 2003),
      shown(3, 'D:/TV/Battlestar Galactica/S01E03.mkv', 'Battlestar Galactica', null),
    ]);
    expect(groups.map((g) => g.year)).toEqual([1978, 2003, null]);
  });

  it('a year after the episode number is when it aired, not another show', () => {
    const groups = groupFiles([
      shown(1, 'D:/TV/Show/Season 1/Show S01E01 (2019).mkv', 'Show', 2019),
      shown(2, 'D:/TV/Show/Season 2/Show S02E01 (2020).mkv', 'Show', 2020, 2),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].maxSeason).toBe(2);
  });

  it('a year before the episode number names the show', () => {
    const groups = groupFiles([
      shown(1, 'D:/TV/Doctor.Who.1963.S01E01.mkv', 'Doctor Who', 1963),
      shown(2, 'D:/TV/Doctor.Who.2005.S01E01.mkv', 'Doctor Who', 2005),
    ]);
    expect(groups.map((g) => g.year)).toEqual([1963, 2005]);
  });
});

describe('groupFiles: dates', () => {
  it('a dated file is a series, and every date one show', () => {
    const dated = (id: number, day: string): MediaFile => ({
      ...file(id, `The Daily Show ${day}.mkv`, 'The Daily Show', null),
      parsed_kind: 'dated',
    });
    const groups = groupFiles([dated(1, '2023-01-15'), dated(2, '2023-01-16')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ isSeries: true, maxSeason: null });
  });
});

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

describe('groupFiles: a country in the show folder', () => {
  it('The Office (US) and (UK) are two groups, each named with its country', () => {
    const groups = groupFiles([
      shown(1, 'D:/TV/The Office (US)/Season 01/The Office S01E01.mkv', 'The Office', null),
      shown(2, 'D:/TV/The Office (UK)/Series 1/The Office S01E01.mkv', 'The Office', null),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map(groupName)).toEqual(['The Office (US)', 'The Office (UK)']);
    expect(groups.map((g) => g.title)).toEqual(['The Office', 'The Office']);
  });

  it('a show with one folder keeps its plain name, and a year in brackets is not a country', () => {
    const groups = groupFiles([
      shown(1, 'D:/TV/The Office (US)/Season 01/The Office S01E01.mkv', 'The Office', null),
      shown(2, 'D:/TV/The Office (US)/Season 01/The Office S01E02.mkv', 'The Office', null),
      shown(3, 'D:/TV/Lost (2004)/Lost S01E01.mkv', 'Lost', 2004),
    ]);
    expect(groups.map(groupName)).toEqual(['The Office (US)', 'Lost']);
    expect(groups[0].files).toHaveLength(2);
  });
});
