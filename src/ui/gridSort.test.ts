import { describe, expect, it } from 'vitest';
import type { Title } from './api';
import { arrangeGrid, parseGridSetting } from './gridSort';

const title = (id: number, name: string, fields: Partial<Title> = {}): Title => ({
  id,
  kind: 'movie',
  provider: 'tmdb',
  title: name,
  year: 2000,
  overview: null,
  genres: null,
  runtime_mins: null,
  poster_url: null,
  backdrop_url: null,
  poster_path: null,
  backdrop_path: null,
  logo_url: null,
  logo_path: null,
  trailer_key: null,
  trailer_site: null,
  rating: null,
  file_count: 1,
  added_at: 0,
  episodes_owned: 0,
  episodes_watched: 0,
  watched: false,
  progress: null,
  cast: [],
  ...fields,
});

const shelf = [
  title(1, 'The Matrix', { year: 1999, rating: 8.2, added_at: 10 }),
  title(2, 'Amélie', { year: 2001, rating: 7.9, added_at: 30, watched: true }),
  title(3, 'Brazil', { year: 1985, rating: 7.8, added_at: 20 }),
];
const names = (list: Title[]) => list.map((t) => t.title);

describe('arrangeGrid', () => {
  it('sorts the ways a shelf is read', () => {
    expect(names(arrangeGrid(shelf, 'added', false))).toEqual(['Amélie', 'Brazil', 'The Matrix']);
    expect(names(arrangeGrid(shelf, 'az', false))).toEqual(['Amélie', 'Brazil', 'The Matrix']);
    expect(names(arrangeGrid(shelf, 'year', false))).toEqual(['Amélie', 'The Matrix', 'Brazil']);
    expect(names(arrangeGrid(shelf, 'rating', false))).toEqual(['The Matrix', 'Amélie', 'Brazil']);
  });

  it('files "The Matrix" under M', () => {
    const list = [title(1, 'The Matrix'), title(2, 'Lost'), title(3, 'Zodiac')];
    expect(names(arrangeGrid(list, 'az', false))).toEqual(['Lost', 'The Matrix', 'Zodiac']);
  });

  it('can leave out what has been watched', () => {
    expect(names(arrangeGrid(shelf, 'az', true))).toEqual(['Brazil', 'The Matrix']);
  });

  it('reads back what was remembered, and defaults sensibly', () => {
    expect(parseGridSetting('rating:unwatched')).toEqual({ sort: 'rating', unwatched: true });
    expect(parseGridSetting(null)).toEqual({ sort: 'added', unwatched: false });
    expect(parseGridSetting('nonsense')).toEqual({ sort: 'added', unwatched: false });
  });
});
