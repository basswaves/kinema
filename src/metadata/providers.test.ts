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

const { tvmazeSearch } = await import('./providers');

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
