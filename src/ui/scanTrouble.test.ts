import { describe, expect, it } from 'vitest';
import { scanTrouble, unreachableFolders } from './scanTrouble';

const away = (path: string) => `root unavailable, skipped: ${path}`;
const tmdb = 'A film: TMDB /search/movie failed: HTTP 401, the key was not accepted';

describe('scanTrouble', () => {
  it('says nothing when there was no problem', () => {
    expect(scanTrouble([])).toBeNull();
  });

  it('names a folder that could not be reached, and what that means', () => {
    expect(scanTrouble([away('\\\\nas\\Films')])).toEqual({
      text: 'Could not reach \\\\nas\\Films',
      note: 'Anything in that folder can’t be played until it is back.',
    });
  });

  it('names a folder that could not be read beside the system’s own words', () => {
    expect(scanTrouble(['could not read: D:\\Films\\Locked :: Ingen tilgang. (os error 5)'])).toEqual({
      text: 'Could not read D:\\Films\\Locked (Ingen tilgang. (os error 5))',
      note: 'Nothing in it was hidden. Kinema tries again at the next scan.',
    });
  });

  it('says how many videos went, from where, and never that they were deleted', () => {
    const gone = scanTrouble(['videos gone: 12 :: /media/films/Disk2']);
    expect(gone).toEqual({
      text: '12 videos can no longer be found in /media/films/Disk2',
      note: 'They are hidden until they are back. A disk that was only disconnected brings them back by itself.',
    });
    expect(JSON.stringify(gone)).not.toMatch(/delet/i);
  });

  it('says a folder left empty keeps its videos, and how to end that', () => {
    expect(scanTrouble(['folder now empty: 12 :: /media/films/Disk2'])).toEqual({
      text: '/media/films/Disk2 is empty where it held 12 videos',
      note: 'They stay in your library. If a disk belongs there, connect it. If you emptied it yourself, delete the folder.',
    });
  });

  it('says nothing about folders when the problem was not one', () => {
    expect(scanTrouble([tmdb])).toEqual({ text: tmdb, note: null });
    expect(scanTrouble([tmdb, '2 artwork downloads failed'])).toEqual({
      text: `${tmdb} · and 1 more`,
      note: null,
    });
  });

  it('puts an unreachable folder first, whatever came before it', () => {
    expect(scanTrouble([tmdb, away('E:\\Shows')])).toEqual({
      text: 'Could not reach E:\\Shows · and 1 more',
      note: 'Anything in that folder can’t be played until it is back.',
    });
  });

  it('says Wikipedia was busy once, in words, however many films it held up', () => {
    const busy = (title: string) =>
      `${title}: Wikimedia is busy: Wikidata query: Waiting for wdqs1014: 6.6 seconds lagged.`;
    expect(scanTrouble([busy('A film'), busy('Another film')])).toEqual({
      text: 'Wikipedia was busy, so some films wait to be matched until the next scan',
      note: null,
    });
  });

  it('drops the line about Wikipedia once nothing is left to match', () => {
    const busy = 'A film: Wikimedia is busy: Wikidata query: HTTP 503';
    expect(scanTrouble([busy], false)).toBeNull();
    expect(scanTrouble([busy, tmdb], false)).toEqual({ text: tmdb, note: null });
  });

  it('speaks of folders when more than one is away', () => {
    expect(scanTrouble([away('E:\\Shows'), away('F:\\Films')])?.note).toBe(
      'Anything in those folders can’t be played until they are back.'
    );
  });

  it('says a failed background stage in plain words, once, on Home only', () => {
    const raw = 'measuring pictures: Invalid column type Null at index: 0, name: title_id';
    expect(scanTrouble([raw])).toEqual({
      text: 'Kinema could not measure the pictures’ shape this time',
      note: 'Your library is fine; it tries again on the next scan.',
      homeOnly: true,
    });
    expect(scanTrouble([raw, 'reading files: locked', raw])).toEqual({
      text: 'Kinema could not measure the pictures’ shape this time · and 1 more',
      note: 'Your library is fine; it tries again on the next scan.',
      homeOnly: true,
    });
  });

  it('puts anything else first, and on every tab, beside a background stage', () => {
    expect(scanTrouble(['intro detection: x', tmdb])).toEqual({
      text: `${tmdb} · and 1 more`,
      note: null,
    });
  });
});

describe('unreachableFolders', () => {
  it('names only the library folders the scan could not reach', () => {
    expect(
      unreachableFolders(['root unavailable, skipped: E:/TV', 'videos gone: 3 :: E:/Films/Old', 'TMDB said no'])
    ).toEqual(['E:/TV']);
  });
});
