import { describe, expect, it } from 'vitest';
import type { Title } from './api';
import { searchTitles } from './search';

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

const library = [
  title(1, 'The Matrix', { year: 1999, genres: '["Action","Science Fiction"]', cast: ['Keanu Reeves'] }),
  title(2, 'Amélie', { year: 2001, genres: '["Comedy","Romance"]', cast: ['Audrey Tautou'] }),
  title(3, 'Speed', { year: 1994, genres: '["Action"]', cast: ['Keanu Reeves', 'Sandra Bullock'] }),
  title(4, 'Matrix Resurrections', { year: 2021 }),
];

const names = (query: string) => searchTitles(library, query).map((h) => h.title.title);

describe('searchTitles', () => {
  it('puts titles that start with the query first', () => {
    expect(names('matrix')).toEqual(['Matrix Resurrections', 'The Matrix']);
  });

  it('ignores case and accents', () => {
    expect(names('amelie')).toEqual(['Amélie']);
  });

  it('finds a film by an actor, and says so', () => {
    const hits = searchTitles(library, 'keanu');
    expect(hits.map((h) => h.title.title)).toEqual(['Speed', 'The Matrix']);
    expect(hits[0].why).toBe('with Keanu Reeves');
  });

  it('finds by year and by genre', () => {
    expect(names('1999')).toEqual(['The Matrix']);
    const romance = searchTitles(library, 'roman');
    expect(romance.map((h) => [h.title.title, h.why])).toEqual([['Amélie', 'Romance']]);
  });

  it('does not match cast or genres on a couple of letters', () => {
    expect(names('sa')).toEqual([]);
  });

  it('shows everything for an empty query', () => {
    expect(names('  ')).toHaveLength(4);
  });
});
