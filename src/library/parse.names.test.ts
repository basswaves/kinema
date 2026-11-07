/**
 * What names a file: its own name or a folder's (review 2026-11). A folder with a year used to
 * win over any file without one, so sequels kept in the first film's folder
 * all became the first film, at full confidence (review 2026-11, finding 10).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initParser, parseMediaFile } from './parse';
import type { MediaFile } from './api';

const ROOT = 'D:/Movies';

function parse(path: string, kind: 'movies' | 'tv' = 'movies', root = ROOT) {
  const cut = path.lastIndexOf('/');
  const file = {
    id: 1,
    path,
    parent_dir: path.slice(0, cut),
    file_name: path.slice(cut + 1),
  } as MediaFile;
  return parseMediaFile(file, kind, root);
}

describe('a folder with a year and a file with a name', () => {
  beforeAll(initParser);

  it.each([
    ['Back to the Future (1985)/Back to the Future Part II.mkv', 'Back to the Future Part 2'],
    ['Back to the Future (1985)/Back to the Future Part III.mkv', 'Back to the Future Part 3'],
    ['Alien (1979)/Alien Resurrection.mkv', 'Alien Resurrection'],
    ['Best of 2019/Heat.mkv', 'Heat'],
    ['Best of 2019/Up.mkv', 'Up'],
  ])('%s keeps its own title and takes no year', (name, title) => {
    expect(parse(`${ROOT}/${name}`)).toMatchObject({ title, year: null, from: 'file' });
  });

  it.each([
    ['Heat (1995)/Heat.mkv', 'Heat', 1995],
    ['Blade Runner 2049 (2017)/Blade Runner 2049.mkv', 'Blade Runner 2049', 2017],
    ['The Matrix (1999)/Matrix.mkv', 'The Matrix', 1999],
    ['WALL-E (2008)/wall-e.mkv', 'WALL-E', 2008],
    ['Blade Runner (1982)/bladerunner.mkv', 'Blade Runner', 1982],
    ['Mission Impossible - Fallout (2018)/Fallout.mkv', 'Mission Impossible - Fallout', 2018],
  ])('%s fits the folder, which lends its year', (name, title, year) => {
    expect(parse(`${ROOT}/${name}`)).toMatchObject({ title, year });
  });

  it.each([
    ['Heat (1995)/1080p.BluRay.x264-GROUP.mkv', 'Heat', 1995],
    ['Heat (1995)/movie.mkv', 'Heat', 1995],
    ['Heat (1995)/main.mkv', 'Heat', 1995],
    ['Heat (1995)/title_t00.mkv', 'Heat', 1995],
    ['Heat (1995)/abc123.mkv', 'Heat', 1995],
    ['Heat (1995)/a.mkv', 'Heat', 1995],
    ['Inception (2010)/grp-inception-1080p.mkv', 'Inception', 2010],
    ['Inception (2010)/grp.inception.1080p.mkv', 'Inception', 2010],
  ])('%s is no title of its own: the folder names it', (name, title, year) => {
    expect(parse(`${ROOT}/${name}`)).toMatchObject({ title, year, from: 'parent' });
  });

  it('a year of its own stays, whatever the folder says', () => {
    expect(parse(`${ROOT}/Best of 2019/Heat (1995).mkv`)).toMatchObject({
      title: 'Heat',
      year: 1995,
    });
  });

  it('a show in a folder of another name takes no year from it', () => {
    expect(parse('D:/TV/Mix 2019/Lost S01E01.mkv', 'tv', 'D:/TV')).toMatchObject({
      title: 'Lost',
      year: null,
      season: 1,
      episode: 1,
    });
    expect(parse('D:/TV/Lost (2004)/Lost S01E01.mkv', 'tv', 'D:/TV')).toMatchObject({
      title: 'Lost',
      year: 2004,
    });
  });
});

describe('names only in digits or in other alphabets', () => {
  beforeAll(initParser);

  it.each([
    ['D:/Movies/1917 (2019).mkv', '1917', 2019],
    ['D:/Movies/Action/1917 (2019).mkv', '1917', 2019],
    ['D:/Movies/2012.2009.1080p.BluRay.mkv', '2012', 2009],
    ['D:/Movies/300 (2006)/300.mkv', '300', 2006],
    ['D:/Movies/300 (2006)/movie.mkv', '300', 2006],
    ['D:/Movies/Action/七人の侍 (1954).mkv', '七人の侍', 1954],
    ['D:/Movies/七人の侍 (1954)/七人の侍.mkv', '七人の侍', 1954],
    ['D:/Movies/Action/Брат (1997).mkv', 'Брат', 1997],
  ])('%s', (path, title, year) => {
    expect(parse(path)).toMatchObject({ title, year });
  });

  it('a Japanese file keeps its name in a folder of another name', () => {
    expect(parse('D:/Movies/Action/七人の侍.mkv')).toMatchObject({ title: '七人の侍', year: null });
  });

  it.each([
    ['D:/TV/24/Season 1/S01E01.mkv', '24', null],
    ['D:/TV/1923 (2022)/Season 1/S01E01.mkv', '1923', 2022],
    ['D:/TV/24/S01E01.mkv', '24', null],
  ])('%s is a show named with a number', (path, title, year) => {
    expect(parse(path, 'tv', 'D:/TV')).toMatchObject({ title, year, season: 1, episode: 1 });
  });

  it('a number that is the season folder is not the show', () => {
    expect(parse('D:/TV/1/S01E01.mkv', 'tv', 'D:/TV').title).toBeNull();
    expect(parse('D:/TV/Lost/1/S01E01.mkv', 'tv', 'D:/TV').title).toBe('Lost');
  });
});

describe('the library folder', () => {
  beforeAll(initParser);

  it('never names a file or lends it a year', () => {
    expect(parse('D:/Movies 2019/S01E01.mkv', 'tv', 'D:/Movies 2019')).toMatchObject({
      title: null,
      year: null,
    });
    expect(parse('D:/Films 2019/Heat.mkv', 'movies', 'D:/Films 2019')).toMatchObject({
      title: 'Heat',
      year: null,
    });
    expect(parse('//nas/Movies/00001.mkv', 'movies', '//nas/Movies/').title).not.toBe('Movies');
  });
});
