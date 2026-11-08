import { describe, expect, it } from 'vitest';
import {
  commonName,
  folderRows,
  planPlacements,
  secondCopies,
  seasonsOffered,
  wouldStack,
  type PlaceFile,
  type TitleFile,
} from './placing';

const file = (id: number, dir: string, title: string, season: number, episode: number): TitleFile => ({
  file_id: id,
  path: `${dir}/${id}.mkv`,
  parent_dir: dir,
  file_name: `${id}.mkv`,
  root_path: 'D:/Shows',
  missing: false,
  season,
  episode,
  episode_last: null,
  name_season: season,
  name_episode: episode,
  name_episode_last: null,
  placed: false,
  parsed_title: title,
});

// The reporter's show: season 1 from one folder, a prequel named S01E01-06.
const show = [
  ...Array.from({ length: 13 }, (_, i) => file(i + 1, 'D:\\Shows\\Spartacus S01', 'Spartacus', 1, i + 1)),
];
const arena: PlaceFile[] = Array.from({ length: 6 }, (_, i) => ({
  id: 101 + i,
  file_name: `Spartacus.Gods.Of.The.Arena.S01E0${i + 1}.mkv`,
  season: 1,
  episode: i + 1,
  parsed_title: 'Spartacus Gods of the Arena',
}));

describe('placing', () => {
  it('a plain link of the prequel would stack on season 1; a second copy of the same show would not', () => {
    expect(wouldStack(arena, show)).toEqual({ seasons: [1], count: 6 });
    const copy = arena.map((f) => ({ ...f, parsed_title: 'Spartacus' }));
    expect(wouldStack(copy, show).count).toBe(0);
  });

  it('Specials from 1, or from 14, keep the gaps; a file with no number follows', () => {
    expect(planPlacements(arena, 0, 1).map((p) => p.episode)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(planPlacements(arena, 0, 14).map((p) => [p.season, p.episode])[0]).toEqual([0, 14]);
    const gaps: PlaceFile[] = [
      { id: 1, file_name: 'a E04', season: 1, episode: 4 },
      { id: 2, file_name: 'a E01', season: 1, episode: 1 },
      { id: 3, file_name: 'extra', season: null, episode: null },
    ];
    expect(planPlacements(gaps, 2, 1).map((p) => [p.file_id, p.episode])).toEqual([
      [2, 1],
      [1, 4],
      [3, 5],
    ]);
    expect(planPlacements(gaps, 2, 1, new Map([[3, 9]])).find((p) => p.file_id === 3)?.episode).toBe(9);
  });

  it('says which rows become second copies', () => {
    const plan = planPlacements(arena, 1, 1);
    expect(secondCopies(plan, show).size).toBe(6);
    expect(secondCopies(planPlacements(arena, 0, 1), show).size).toBe(0);
  });

  it('one row per folder and season', () => {
    const loose = [...show, file(50, 'D:\\Shows\\Spartacus S01', 'Spartacus', 2, 1)];
    const rows = folderRows(loose);
    expect(rows.map((r) => [r.folder, r.season, r.files.length])).toEqual([
      ['Spartacus S01', 1, 13],
      ['Spartacus S01', 2, 1],
    ]);
  });

  it('offers Specials and the listed seasons, plus the names’ own', () => {
    expect(seasonsOffered([{ season: 1 }, { season: 0 }, { season: 2 }], [1, 5, null])).toEqual([0, 1, 2, 5]);
  });

  it('names a title of its own from the files', () => {
    expect(commonName([file(1, 'D:/x/Arena', 'Spartacus Gods of the Arena', 1, 1)])).toBe(
      'Spartacus Gods of the Arena'
    );
  });
});
