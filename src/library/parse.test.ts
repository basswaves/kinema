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
