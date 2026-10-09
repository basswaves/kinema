import { describe, expect, it } from 'vitest';
import { countCallbacks, expandActions, type Timed } from './selftestPlan';

type Step = Timed & { key?: string; actions?: Step[] };

const act = (at: number, key: string): Step => ({ at, do: 'key', key });

describe('expandActions', () => {
  it('leaves a plan without repeats as it was', () => {
    const plan = [act(1, 'a'), act(5, 'b')];
    expect(expandActions(plan)).toEqual(plan);
  });

  it('plays a repeat out round by round, each timed from the round start', () => {
    const plan: Step[] = [
      act(0, 'first'),
      { at: 10, do: 'repeat', times: 3, every: 30, actions: [act(0, 'open'), act(5, 'leave')] },
    ];
    expect(expandActions(plan).map((a) => [a.at, a.key, a.round])).toEqual([
      [0, 'first', undefined],
      [10, 'open', 0],
      [15, 'leave', 0],
      [40, 'open', 1],
      [45, 'leave', 1],
      [70, 'open', 2],
      [75, 'leave', 2],
    ]);
  });

  it('does nothing for no rounds, and runs once without an interval', () => {
    const body = [act(2, 'x')];
    expect(expandActions([{ at: 0, do: 'repeat', times: 0, every: 5, actions: body }])).toEqual([]);
    expect(expandActions([{ at: 3, do: 'repeat', actions: body }]).map((a) => a.at)).toEqual([5]);
  });

  it('nests, and refuses a runaway', () => {
    const inner: Step = { at: 1, do: 'repeat', times: 2, every: 10, actions: [act(0, 'k')] };
    const out = expandActions([{ at: 0, do: 'repeat', times: 2, every: 100, actions: [inner] } as Step]);
    expect(out.map((a) => a.at)).toEqual([1, 11, 101, 111]);
    // The innermost round is the one recorded.
    expect(out.map((a) => a.round)).toEqual([0, 1, 0, 1]);

    let deep: Step = act(0, 'k');
    for (let i = 0; i < 5; i++) deep = { at: 0, do: 'repeat', times: 1, actions: [deep] };
    expect(() => expandActions([deep])).toThrow(/nested/);
  });
});

describe('countCallbacks', () => {
  it('counts only the callbacks Tauri registers', () => {
    expect(countCallbacks(['_1', '_20', 'fetch', '__TAURI__', '_abc', '_', '1_2', '_3x'])).toBe(2);
    expect(countCallbacks([])).toBe(0);
  });
});
