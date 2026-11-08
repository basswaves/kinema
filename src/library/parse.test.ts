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
  it('takes a year written twice out of the title', () => {
    const named = parseMediaFile(file('A Long Film Name 2017 (2017).mkv', 'D:/Films'), 'movies');
    expect([named.title, named.year]).toEqual(['A Long Film Name', 2017]);
    const folder = parseMediaFile(file('movie.mkv', 'D:/Films/Some Film 2017 (2017)'), 'movies');
    expect([folder.title, folder.year]).toEqual(['Some Film', 2017]);
  });

  /** guessit moves these out of `title`; the matcher needs them back (MATCHING.md step 4). */
  it('puts a film’s part back into its title', () => {
    const title = (name: string) => parseMediaFile(file(name, 'D:/Films'), 'movies').title;
    expect(title('Dune.Part.Two.2024.2160p.mkv')).toBe('Dune Part 2');
    expect(title('The.Hunger.Games.Mockingjay.Part.2.2015.mkv')).toBe(
      'The Hunger Games Mockingjay Part 2'
    );
  });

  it('reads F1 as a title, and leaves Film f01 alone', () => {
    const title = (name: string) => parseMediaFile(file(name, 'D:/Films'), 'movies').title;
    expect(title('F1 [2025].mkv')).toBe('F1');
    expect(title('F1 (2025).mkv')).toBe('F1');
    expect(title('F1.2025.2160p.mkv')).toBe('F1');
    expect(title('Film f01.mkv')).not.toBe('F1');
  });

  it('keeps the whole name of a title written with " - "', () => {
    const parsed = parseMediaFile(
      file('Spider-Man - Across the Spider-Verse (2023).mkv', 'D:/Films'),
      'movies'
    );
    expect([parsed.title, parsed.year]).toEqual(['Spider-Man - Across the Spider-Verse', 2023]);
  });

  it('leaves a CD number out of the title', () => {
    const parsed = parseMediaFile(file('Avatar CD1 2009.avi', 'D:/Films'), 'movies');
    expect(parsed.title).toBe('Avatar');
  });

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

/**
 * guessit reads `Spider-Man.2002.mkv` as a film called "Man" by a release group
 * called "Spider": a word, a hyphen and the rest at the start of a name looks
 * like a group's prefix to it. A title with a hyphen is far more common there.
 */
describe('a hyphen in a title', () => {
  const cases: [string, string, number | null][] = [
    ['Spider-Man.2002.mkv', 'Spider-Man', 2002],
    ['Spider-Man.2002.1080p.mkv', 'Spider-Man', 2002],
    ['Spider-Man.2.2004.mkv', 'Spider-Man 2', 2004],
    ['Spider-Man.Homecoming.2017.mkv', 'Spider-Man Homecoming', 2017],
    ['Ant-Man.and.the.Wasp.2018.mkv', 'Ant-Man and the Wasp', 2018],
    ['Iron-Man.2008.mkv', 'Iron-Man', 2008],
    ['Mission-Impossible.1996.mkv', 'Mission-Impossible', 1996],
    ['Man-Thing.2005.mkv', 'Man-Thing', 2005],
    ['Jean-Claude.2010.mkv', 'Jean-Claude', 2010],
    ['X-Men.2000.mkv', 'X-Men', 2000],
  ];
  it.each(cases)('keeps %s whole', (name, title, year) => {
    const parsed = parseMediaFile(file(name, 'D:/Films'), 'movies', 'D:/Films');
    expect([parsed.title, parsed.year]).toEqual([title, year]);
    expect(parsed.raw.release_group).toBeUndefined();
  });

  it('wins over a release folder, as a name of its own should', () => {
    const parsed = parseMediaFile(file('Spider-Man.2002.mkv', 'D:/Films/Some Other Film (1999)'), 'movies');
    expect(parsed.title).toBe('Spider-Man');
  });

  it('still finds a real release group at the end', () => {
    const parsed = parseMediaFile(file('Movie.2010.1080p.BluRay-GROUP.mkv', 'D:/Films'), 'movies', 'D:/Films');
    expect([parsed.title, parsed.year, parsed.raw.release_group]).toEqual(['Movie', 2010, 'GROUP']);
    const hyphened = parseMediaFile(
      file('Ant-Man.2015.1080p.BluRay.x264-GROUP.mkv', 'D:/Films'),
      'movies',
      'D:/Films'
    );
    expect([hyphened.title, hyphened.raw.release_group]).toEqual(['Ant-Man', 'GROUP']);
  });

  it('still reads -sample and -trailer as what they are', () => {
    const sample = parseMediaFile(file('Movie.2010-sample.mkv', 'D:/Films'), 'movies', 'D:/Films');
    expect([sample.title, sample.raw.other]).toEqual(['Movie', 'Sample']);
    const trailer = parseMediaFile(file('Movie-trailer.mkv', 'D:/Films'), 'movies', 'D:/Films');
    expect([trailer.title, trailer.raw.other]).toEqual(['Movie', 'Trailer']);
  });

  it('leaves a scene file named after the group its folder names', () => {
    const parsed = parseMediaFile(
      file('grp-film.2016.1080p.bluray.x264.mkv', 'D:/Films/Film.2016.1080p.BluRay.x264-GRP[tag]'),
      'movies',
      'D:/Films'
    );
    expect([parsed.title, parsed.year]).toEqual(['film', 2016]);
  });

  it('leaves a bracketed group in front alone', () => {
    const parsed = parseMediaFile(file('[GROUP] Movie 2010.mkv', 'D:/Films'), 'movies', 'D:/Films');
    expect([parsed.title, parsed.raw.release_group]).toEqual(['Movie', 'GROUP']);
  });

  it('keeps a show whole too', () => {
    const parsed = parseMediaFile(file('Spider-Man.2002.mkv', 'D:/TV/Spider-Man'), 'tv', 'D:/TV');
    expect(parsed.title).toBe('Spider-Man');
  });
});

describe('a title from the show folder', () => {
  /**
   * The case that vanished: neither the file name nor its season folder has a
   * title, so the file was saved untitled and appeared nowhere at all.
   */
  it('comes from the folder above a season folder', () => {
    const parsed = parseMediaFile(file('S01E01.mkv', 'D:/TV/Show Name/Season 1'), 'tv', 'D:/TV');
    expect(parsed.title).toBe('Show Name');
    expect(parsed.season).toBe(1);
    expect(parsed.episode).toBe(1);
  });

  /** Never from the library folder itself: "TV" is not a show. */
  it('never climbs to the library folder', () => {
    const parsed = parseMediaFile(file('S01E01.mkv', 'D:/TV/Season 1'), 'tv', 'D:/TV');
    expect(parsed.title).toBeNull();
    expect(parsed.needsAttention).toBe(true);
  });

  /**
   * The climb once dropped a path's leading `\\` or `/`, so the show folder was
   * never "inside" a network share or a Linux folder and the title was lost.
   */
  it.each([
    ['a drive', String.raw`D:\TV`],
    ['a network share', String.raw`\\NAS\TV`],
    ['a Linux folder', '/media/TV'],
  ])('works under %s', (_, root) => {
    const sep = root.startsWith('/') ? '/' : '\\';
    const season = [root, 'Show Name', 'Season 1'].join(sep);
    const parsed = parseMediaFile(file('S01E01.mkv', season), 'tv', root);
    expect(parsed.title).toBe('Show Name');

    const top = parseMediaFile(file('S01E01.mkv', [root, 'Season 1'].join(sep)), 'tv', root);
    expect(top.title).toBeNull();
  });

  it('is not used when the file already names the show', () => {
    const parsed = parseMediaFile(
      file('Other.Show.S01E01.mkv', 'D:/TV/Show Name/Season 1'),
      'tv',
      'D:/TV'
    );
    expect(parsed.title).toBe('Other Show');
  });
});
