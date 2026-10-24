import { describe, expect, it } from 'vitest';
import type { Title } from './api';
import { candidates, pick, remember, whyLine, RECENT_PICKS } from './somethingPick';

function title(id: number, over: Partial<Title> = {}): Title {
  return {
    id,
    kind: 'movie',
    provider: 'tmdb',
    title: `T${id}`,
    year: null,
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
    added_at: null,
    episodes_owned: 0,
    episodes_watched: 0,
    watched: false,
    progress: null,
    cast: [],
    ...over,
  };
}

describe('candidates', () => {
  it('takes unwatched films and shows in the middle, not finished or unstarted ones', () => {
    const list = [
      title(1),
      title(2, { watched: true }),
      title(3, { kind: 'series', episodes_owned: 10, episodes_watched: 3 }),
      title(4, { kind: 'series', episodes_owned: 10, episodes_watched: 0 }),
      title(5, { kind: 'series', episodes_owned: 2, episodes_watched: 2, watched: true }),
    ];
    expect(candidates(list, new Set()).map((t) => t.id)).toEqual([1, 3]);
  });

  it('counts a show with a resume point as in the middle', () => {
    const list = [title(4, { kind: 'series', episodes_owned: 10 })];
    expect(candidates(list, new Set([4])).map((t) => t.id)).toEqual([4]);
  });

  it('counts a film started and not finished, by its own progress', () => {
    const film = title(6, { progress: 0.64 });
    expect(candidates([film], new Set()).map((t) => t.id)).toEqual([6]);
  });

  it('falls back to anything unwatched when there is nothing else', () => {
    const list = [title(1, { watched: true }), title(4, { kind: 'series', episodes_owned: 10 })];
    expect(candidates(list, new Set()).map((t) => t.id)).toEqual([4]);
  });

  it('has nothing when everything is watched', () => {
    expect(candidates([title(1, { watched: true })], new Set())).toEqual([]);
  });
});

describe('pick', () => {
  it('never repeats the last few while there are others', () => {
    const list = Array.from({ length: 8 }, (_, i) => title(i + 1));
    const recent: number[] = [];
    const seen: number[] = [];
    for (let n = 0; n < 6; n++) {
      const t = pick(list, recent, Math.random);
      expect(t).not.toBeNull();
      expect(recent.slice(0, RECENT_PICKS)).not.toContain(t!.id);
      remember(t!, recent);
      seen.push(t!.id);
    }
    expect(new Set(seen).size).toBe(6);
  });

  it('gives another of two each time', () => {
    const list = [title(1), title(2)];
    const recent: number[] = [];
    const first = pick(list, recent, () => 0)!;
    remember(first, recent);
    const second = pick(list, recent, () => 0)!;
    expect(second.id).not.toBe(first.id);
  });

  it('gives the only one again rather than nothing', () => {
    const only = [title(1)];
    expect(pick(only, [1], () => 0)?.id).toBe(1);
  });

  it('gives nothing from nothing', () => {
    expect(pick([], [], () => 0)).toBeNull();
  });
});

describe('whyLine', () => {
  it('says why, and where from', () => {
    expect(whyLine(title(1, { runtime_mins: 130 }), false, null, null)).toBe(
      'A film you have not seen · 2 h 10 min'
    );
    expect(whyLine(title(1), true, null, 'Drama')).toBe('From Drama: a film you stopped part-way through');
    expect(
      whyLine(title(3, { kind: 'series', episodes_owned: 10, episodes_watched: 3 }), false, 'S01E04', null)
    ).toBe('You are in the middle of it · 3 of 10 episodes watched · next S01E04');
  });
});
