/**
 * How the provider clients pace themselves against rate limits.
 *
 * The HTTP plugin is replaced with a recording stand-in, so these check what
 * would go over the wire and when, without a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { url: string; at: number }[] = [];
let responses: Array<{ status: number; body: unknown; retryAfter?: string }> = [];

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async (url: string) => {
    calls.push({ url, at: Date.now() });
    const next = responses.shift() ?? { status: 200, body: [] };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name: string) => (name === 'retry-after' ? (next.retryAfter ?? null) : null) },
      json: async () => next.body,
    };
  }),
}));

const {
  OmdbStop,
  omdbTomatometer,
  pickStudios,
  tmdbGetEpisodes,
  tmdbGetTitle,
  tvmazeSearch,
  usCertification,
} = await import(
  './providers'
);

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  responses = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TVmaze pacing', () => {
  /** TVmaze allows about 20 calls per 10 s; 120 ms apart was four times that. */
  it('spaces requests at least half a second apart', async () => {
    const both = Promise.all([tvmazeSearch('One'), tvmazeSearch('Two')]);
    await vi.runAllTimersAsync();
    await both;
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(500);
  });

  /** A 429 is waited out and retried, not turned into an unmatched show. */
  it('waits out a 429 and tries again', async () => {
    responses = [
      { status: 429, body: null, retryAfter: '2' },
      { status: 200, body: [{ show: { id: 1, name: 'Show', premiered: '2001-01-01' } }] },
    ];
    const result = tvmazeSearch('Show');
    await vi.runAllTimersAsync();
    const candidates = await result;
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(2000);
    expect(candidates[0].title).toBe('Show');
  });
});

describe('TMDB episodes', () => {
  const episode = (season: number, n: number) => ({
    season_number: season,
    episode_number: n,
    name: `E${n}`,
    overview: '',
    air_date: null,
    runtime: 25,
    still_path: null,
  });

  /** Twenty-two seasons: one show request, then two batched ones — not 23. */
  it('fetches seasons twenty to a request', async () => {
    const seasons = Array.from({ length: 22 }, (_, i) => ({ season_number: i + 1 }));
    const batch = (from: number, to: number) =>
      Object.fromEntries(
        Array.from({ length: to - from + 1 }, (_, i) => [
          `season/${from + i}`,
          { episodes: [episode(from + i, 1), episode(from + i, 2)] },
        ])
      );
    responses = [
      { status: 200, body: { seasons } },
      { status: 200, body: batch(1, 20) },
      { status: 200, body: batch(21, 22) },
    ];
    const result = tmdbGetEpisodes('key', '105');
    await vi.runAllTimersAsync();
    const episodes = await result;

    expect(calls).toHaveLength(3);
    const appended = new URL(calls[1].url).searchParams.get('append_to_response');
    expect(appended?.split(',')).toHaveLength(20);
    expect(appended?.startsWith('season/1,season/2')).toBe(true);
    expect(episodes).toHaveLength(44);
    expect(episodes[43]).toMatchObject({ season: 22, episode: 2, runtime_mins: 25 });
  });

  /** A reply that leaves a season out gets that season asked for directly. */
  it('fetches a season the batch left out on its own', async () => {
    responses = [
      { status: 200, body: { seasons: [{ season_number: 1 }, { season_number: 2 }] } },
      { status: 200, body: { 'season/1': { episodes: [episode(1, 1)] } } },
      { status: 200, body: { episodes: [episode(2, 1), episode(2, 2)] } },
    ];
    const result = tmdbGetEpisodes('key', '105');
    await vi.runAllTimersAsync();
    const episodes = await result;

    expect(calls).toHaveLength(3);
    expect(calls[2].url).toContain('/tv/105/season/2');
    expect(episodes.map((e) => `${e.season}x${e.episode}`)).toEqual(['1x1', '2x1', '2x2']);
  });
});

describe('TMDB age rating and studios', () => {
  /** A film's US rating is its theatrical one; a premiere is often unrated. */
  it('takes the theatrical US rating', () => {
    const dates = {
      results: [
        { iso_3166_1: 'GB', release_dates: [{ certification: '15', type: 3 }] },
        {
          iso_3166_1: 'US',
          release_dates: [
            { certification: '', type: 1 },
            { certification: 'NC-17', type: 4 },
            { certification: 'R', type: 3 },
          ],
        },
      ],
    };
    expect(usCertification('movie', dates, undefined)).toBe('R');
  });

  it('says none, not a guess, when there is no US rating', () => {
    const dates = { results: [{ iso_3166_1: 'GB', release_dates: [{ certification: '15', type: 3 }] }] };
    expect(usCertification('movie', dates, undefined)).toBe('');
    expect(usCertification('movie', undefined, undefined)).toBe('');
    expect(
      usCertification('series', undefined, { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] })
    ).toBe('TV-MA');
  });

  it('names a series by its network and a film by its companies', () => {
    const networks = [{ name: 'Example Network', logo_path: '/n.png' }];
    const companies = [
      { name: 'Co-producer', logo_path: '/c.png' },
      { name: 'No Logo Partnership', logo_path: null },
      { name: 'Vector Pictures', logo_path: '/v.svg' },
    ];
    expect(pickStudios('series', networks, companies)).toEqual([
      { name: 'Example Network', logo_url: 'https://image.tmdb.org/t/p/w300/n.png' },
    ]);
    // Order kept; an SVG logo is dropped for the reason pickLogo gives.
    expect(pickStudios('movie', networks, companies)).toEqual([
      { name: 'Co-producer', logo_url: 'https://image.tmdb.org/t/p/w300/c.png' },
      { name: 'No Logo Partnership', logo_url: null },
      { name: 'Vector Pictures', logo_url: null },
    ]);
  });

  /** In the same request as everything else: a new match stays one round trip. */
  it('asks for the rating in the title request', async () => {
    responses = [
      {
        status: 200,
        body: {
          id: 603,
          title: 'A Film',
          release_date: '1999-03-31',
          overview: '',
          genres: [],
          vote_average: 8,
          poster_path: null,
          backdrop_path: null,
          production_companies: [{ name: 'A Studio', logo_path: '/s.png' }],
          release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R', type: 3 }] }] },
        },
      },
    ];
    const result = tmdbGetTitle('key', '603', 'movie');
    await vi.runAllTimersAsync();
    const title = await result;

    expect(calls).toHaveLength(1);
    const appended = new URL(calls[0].url).searchParams.get('append_to_response');
    expect(appended?.split(',')).toContain('release_dates');
    expect(title.certification).toBe('R');
    expect(title.studios).toEqual([{ name: 'A Studio', logo_url: 'https://image.tmdb.org/t/p/w300/s.png' }]);
  });
});

describe('OMDb Rotten Tomatoes score', () => {
  const ask = async (status: number, body: unknown) => {
    responses = [{ status, body }];
    const result = omdbTomatometer('key', 'tt0133093').catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    return result;
  };

  /** The shape OMDb documents: Ratings as source/value pairs. */
  it('reads the Tomatometer out of the ratings list', async () => {
    const body = {
      Response: 'True',
      Ratings: [
        { Source: 'Internet Movie Database', Value: '8.7/10' },
        { Source: 'Rotten Tomatoes', Value: '83%' },
        { Source: 'Metacritic', Value: '73/100' },
      ],
    };
    expect(await ask(200, body)).toBe(83);
  });

  it('says none when OMDb has none, as for most series', async () => {
    expect(await ask(200, { Response: 'True', Ratings: [] })).toBeNull();
    expect(await ask(200, { Response: 'False', Error: 'Incorrect IMDb ID.' })).toBeNull();
  });

  it('stops the pass on a wrong key or a spent allowance', async () => {
    const wrongKey = await ask(401, { Response: 'False', Error: 'Invalid API key!' });
    expect(wrongKey).toBeInstanceOf(OmdbStop);
    const spent = await ask(401, { Response: 'False', Error: 'Request limit reached!' });
    expect(spent).toBeInstanceOf(OmdbStop);
    expect((spent as Error).message).toContain('limit');
  });
});
