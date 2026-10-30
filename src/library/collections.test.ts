import { describe, expect, it } from 'vitest';
import { fits, readyMadeRails, ruleName, type TraitMap } from './collections';
import type { Title } from '../ui/api';

const title = (id: number, over: Partial<Title> = {}): Title =>
  ({
    id,
    kind: 'movie',
    title: `Film ${id}`,
    year: 1994,
    rating: 7.5,
    genres: '["Drama"]',
    watched: false,
    ...over,
  }) as Title;

const traits: TraitMap = new Map([
  [1, new Set(['4k', 'atmos', 'dv', 'dv:7'])],
  [2, new Set(['4k'])],
]);

describe('smart collections', () => {
  it('needs every measured trait chosen, and nothing a file was not read to have', () => {
    expect(fits(title(1), traits, { traits: ['4k', 'atmos'] })).toBe(true);
    expect(fits(title(2), traits, { traits: ['4k', 'atmos'] })).toBe(false);
    // Never read: no trait at all.
    expect(fits(title(3), traits, { traits: ['4k'] })).toBe(false);
    expect(fits(title(3), traits, { traits: [] })).toBe(true);
  });

  it('reads decade, rating, genre, kind and watched from the title', () => {
    const t = title(1);
    expect(fits(t, traits, { traits: [], decade: 1990 })).toBe(true);
    expect(fits(t, traits, { traits: [], decade: 2000 })).toBe(false);
    expect(fits(t, traits, { traits: [], minRating: 8 })).toBe(false);
    expect(fits(t, traits, { traits: [], genre: 'Comedy' })).toBe(false);
    expect(fits(t, traits, { traits: [], kind: 'series' })).toBe(false);
    expect(fits(title(1, { watched: true }), traits, { traits: [], unwatched: true })).toBe(false);
    expect(fits(title(1, { year: null }), traits, { traits: [], decade: 1990 })).toBe(false);
  });

  it('names a collection by its choices', () => {
    expect(ruleName({ traits: ['dv:7', 'atmos'], kind: 'movie', decade: 1990, minRating: 7 })).toBe(
      'Dolby Vision profile 7 · Dolby Atmos · Films · 1990s · ★ 7+'
    );
  });

  it('shows a ready-made rail only for two titles or more, and not the whole library', () => {
    const library = [title(1), title(2), title(3)];
    expect(readyMadeRails(library, traits).map((r) => r.name)).toEqual(['4K']);
    expect(readyMadeRails([title(1), title(2)], traits)).toEqual([]);
  });
});
