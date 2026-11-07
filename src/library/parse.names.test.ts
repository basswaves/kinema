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
