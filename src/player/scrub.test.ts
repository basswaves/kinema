import { describe, expect, it } from 'vitest';
import { CHAIN_MS, scrubStep, type Scrub } from './scrub';

const HOUR = 3600;

/** Hold a key for `ms`, with the keyboard's repeat delay and rate. */
function hold(dir: 1 | -1, ms: number, position = 600, duration = 2 * HOUR): Scrub {
  let s = scrubStep(null, 0, dir, false, position, duration);
  for (let t = 500; t <= ms; t += 33) s = scrubStep(s, t, dir, true, position, duration);
  return s;
}

describe('scrubStep', () => {
  it('moves ten seconds on a single press', () => {
    expect(scrubStep(null, 0, 1, false, 600, HOUR).target).toBe(610);
    expect(scrubStep(null, 0, -1, false, 600, HOUR).target).toBe(590);
  });

  it('goes further the longer the key is held', () => {
    const one = hold(1, 1000).target - 600;
    const three = hold(1, 3000).target - 600;
    const twelve = hold(1, 12000).target - 600;
    expect(one).toBeLessThan(30);
    expect(three / 3).toBeGreaterThan(one);
    // An hour away is reachable in well under a quarter of a minute.
    expect(twelve).toBeGreaterThan(HOUR);
  });

  it('does not jump across the keyboard repeat delay', () => {
    const first = scrubStep(null, 0, 1, false, 0, HOUR);
    const afterDelay = scrubStep(first, 500, 1, true, 0, HOUR);
    expect(afterDelay.target - first.target).toBeLessThanOrEqual(3);
  });

  it('grows the step for quick separate taps, as some remotes send', () => {
    let s: Scrub | null = null;
    const targets: number[] = [];
    for (let i = 0; i < 10; i++) {
      s = scrubStep(s, i * 200, 1, false, 0, HOUR);
      targets.push(s.target);
    }
    expect(targets.slice(0, 4)).toEqual([10, 20, 30, 40]);
    expect(targets[5] - targets[4]).toBe(30);
    expect(targets[9] - targets[8]).toBe(60);
  });

  it('starts again after a pause or a change of direction', () => {
    const first = scrubStep(null, 0, 1, false, 100, HOUR);
    expect(scrubStep(first, CHAIN_MS + 1, 1, false, 100, HOUR).target).toBe(110);
    expect(scrubStep(first, 100, -1, false, 100, HOUR).target).toBe(90);
  });

  it('stays inside the file', () => {
    expect(scrubStep(null, 0, -1, false, 4, HOUR).target).toBe(0);
    expect(hold(1, 20000, 0, 600).target).toBe(599);
  });
});
