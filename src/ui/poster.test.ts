import { describe, expect, it } from 'vitest';
import type { Title } from './api';
import { posterState } from './poster';

const base: Title = {
  id: 1,
  kind: 'movie',
  provider: 'tmdb',
  title: 'X',
  year: 2020,
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
};

describe('posterState', () => {
  it('ticks a finished film and draws a bar under a started one', () => {
    expect(posterState({ ...base, watched: true })).toEqual({ watched: true, progress: null, badge: null });
    expect(posterState({ ...base, progress: 0.4 }).progress).toBe(0.4);
    expect(posterState({ ...base, progress: 0.005 }).progress).toBeNull();
    expect(posterState({ ...base, progress: 0.97 }).progress).toBeNull();
  });

  it('counts what is left of a show once it is started', () => {
    const show = { ...base, kind: 'series', file_count: 10, episodes_owned: 10 };
    expect(posterState(show).badge).toBe('10 ep');
    expect(posterState({ ...show, episodes_watched: 7 }).badge).toBe('3 left');
    expect(posterState({ ...show, episodes_watched: 10, watched: true })).toEqual({
      watched: true,
      progress: null,
      badge: null,
    });
  });
});
