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

const { tmdbGetEpisodes, tvmazeSearch } = await import('./providers');

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
