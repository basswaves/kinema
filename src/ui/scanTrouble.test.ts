import { describe, expect, it } from 'vitest';
import { scanTrouble } from './scanTrouble';

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

  it('speaks of folders when more than one is away', () => {
    expect(scanTrouble([away('E:\\Shows'), away('F:\\Films')])?.note).toBe(
      'Anything in those folders can’t be played until they are back.'
    );
  });
});
