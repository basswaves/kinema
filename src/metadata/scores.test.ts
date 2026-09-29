/**
 * How Rotten Tomatoes lookups spend the user's OMDb allowance.
 */
import { describe, expect, it } from 'vitest';
import { DAILY_BUDGET, PER_SCAN, refreshTomatometer, type ScoreDeps, type ScoreResult } from './scores';
import { OmdbStop } from './providers';

/** A day's stand-ins: `due` titles waiting, OMDb answering `answer`. */
function world(
  due: string[],
  answer: (id: string) => number | null | Error = () => 90,
  budget: string | null = null,
  key: string | null = 'own-key'
) {
  const state = {
    budget,
    asked: [] as string[],
    saved: [] as ScoreResult[],
    listedWith: 0,
  };
  const deps: ScoreDeps = {
    omdbKey: async () => key,
    today: () => '2026-09-29',
    readBudget: async () => state.budget,
    writeBudget: async (v) => {
      state.budget = v;
    },
    listDue: async (limit) => {
      state.listedWith = limit;
      return due.slice(0, limit);
    },
    lookup: async (_key, id) => {
      state.asked.push(id);
      const a = answer(id);
      if (a instanceof Error) throw a;
      return a;
    },
    save: async (scores) => {
      state.saved.push(...scores);
    },
  };
  return { deps, state };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `tt${String(i).padStart(7, '0')}`);

describe('refreshTomatometer', () => {
  it('does nothing without a key of the user’s own', async () => {
    const { deps, state } = world(ids(3), () => 90, null, null);
    expect(await refreshTomatometer(deps)).toEqual({ looked_up: 0, stopped: null });
    expect(state.asked).toEqual([]);
  });

  it('looks up at most one scan’s worth, and counts it against today', async () => {
    const { deps, state } = world(ids(PER_SCAN + 50));
    const report = await refreshTomatometer(deps);
    expect(report.looked_up).toBe(PER_SCAN);
    expect(state.saved).toHaveLength(PER_SCAN);
    expect(JSON.parse(state.budget!)).toEqual({ day: '2026-09-29', used: PER_SCAN });
  });

  it('stops at the day’s budget, and starts again the next day', async () => {
    const spent = JSON.stringify({ day: '2026-09-29', used: DAILY_BUDGET - 10 });
    const { deps, state } = world(ids(50), () => 90, spent);
    await refreshTomatometer(deps);
    expect(state.listedWith).toBe(10);
    expect(state.asked).toHaveLength(10);

    const yesterday = JSON.stringify({ day: '2026-09-28', used: DAILY_BUDGET });
    const next = world(ids(50), () => 90, yesterday);
    await refreshTomatometer(next.deps);
    expect(next.state.asked).toHaveLength(50);
  });

  it('asks nothing once the day is spent', async () => {
    const spent = JSON.stringify({ day: '2026-09-29', used: DAILY_BUDGET });
    const { deps, state } = world(ids(5), () => 90, spent);
    await refreshTomatometer(deps);
    expect(state.asked).toEqual([]);
  });

  /** A wrong key fails for every title; one failure is enough to know. */
  it('stops at the first refusal of the key, keeping what came before', async () => {
    const { deps, state } = world(ids(5), (id) =>
      id === 'tt0000002' ? new OmdbStop('OMDb: Invalid API key!') : 75
    );
    const report = await refreshTomatometer(deps);
    expect(report.stopped).toBe('OMDb: Invalid API key!');
    expect(state.asked).toEqual(['tt0000000', 'tt0000001', 'tt0000002']);
    expect(state.saved.map((s) => s.imdb_id)).toEqual(['tt0000000', 'tt0000001']);
    // The refused lookup still counted against the day.
    expect(JSON.parse(state.budget!).used).toBe(3);
  });

  /** One bad answer is that title's problem, not the pass's. */
  it('carries on past a failure that is not the key’s', async () => {
    const { deps, state } = world(ids(3), (id) => (id === 'tt0000001' ? new Error('timeout') : null));
    const report = await refreshTomatometer(deps);
    expect(report.stopped).toBeNull();
    expect(state.asked).toHaveLength(3);
    // No score is an answer too, kept so the title waits its month.
    expect(state.saved).toEqual([
      { imdb_id: 'tt0000000', tomatometer: null },
      { imdb_id: 'tt0000002', tomatometer: null },
    ]);
  });
});
