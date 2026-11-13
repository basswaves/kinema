// A page lookup that never answers, or a 429 asking for a day's wait, must not
// hold the one-at-a-time queue (review A6-01, A6-06).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Fake = { status: number; retryAfter?: string; body?: unknown } | 'never';
let script: Fake[] = [];
let calls = 0;
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(() => {
    calls++;
    const next = script.shift() ?? { status: 200, body: { results: [] } };
    if (next === 'never') return new Promise(() => undefined);
    return Promise.resolve({
      ok: next.status < 300,
      status: next.status,
      headers: { get: (n: string) => (n === 'retry-after' ? (next.retryAfter ?? null) : null) },
      json: async () => next.body,
    });
  }),
}));
vi.mock('../db', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
const P = await import('./providers');

beforeEach(() => {
  vi.useFakeTimers();
  script = [];
  calls = 0;
});
afterEach(() => vi.useRealTimers());

const settle = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message);

describe('page lookup limits', () => {
  it('a TVmaze request that never answers fails after the limit and the next one runs', async () => {
    script = ['never', { status: 200, body: [] }];
    const a = settle(P.tvmazeSearch('A'));
    const b = settle(P.tvmazeSearch('B'));
    await vi.advanceTimersByTimeAsync(P.REQUEST_TIMEOUT_MS + 1_000);
    expect(await a).toMatch(/no answer/);
    expect(await b).toBe('ok');
    expect(calls).toBe(2);
  });

  it('a 429 asking for a day fails at once with a plain message', async () => {
    script = [{ status: 429, retryAfter: '86400' }];
    const r = settle(P.tvmazeSearch('A'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await r).toMatch(/asked for a wait of 86400 s/);
    expect(calls).toBe(1);
  });

  it('a short Retry-After is still waited out', async () => {
    script = [{ status: 429, retryAfter: '5' }, { status: 200, body: [] }];
    const r = settle(P.tvmazeSearch('A'));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await r).toBe('ok');
    expect(calls).toBe(2);
  });

  it('OMDb with a long wait fails plainly, not with an undefined read', async () => {
    script = [{ status: 429, retryAfter: '3600' }];
    const r = settle(P.omdbTomatometer('k', 'tt1'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await r).toMatch(/asked for a wait/);
  });

  it('OMDb with an empty body does not read undefined', async () => {
    script = [{ status: 500 }];
    const r = settle(P.omdbTomatometer('k', 'tt1'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await r).toBe('OMDb: HTTP 500');
  });
});
