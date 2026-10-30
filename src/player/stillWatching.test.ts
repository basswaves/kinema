import { describe, expect, it } from 'vitest';
import { notePress, rollOn, shouldAsk, targetStarted } from './stillWatching';

/** The countdown starting the next episode, as useUpNext does. */
function rolled(times: number): void {
  for (let i = 0; i < times; i++) {
    rollOn();
    targetStarted();
  }
}

describe('Still watching?', () => {
  it('asks after three episodes rolled on with no press', () => {
    targetStarted(); // the first one, chosen
    rolled(2);
    expect(shouldAsk(true)).toBe(false);
    rolled(1);
    expect(shouldAsk(true)).toBe(true);
    expect(shouldAsk(false)).toBe(false);
  });

  it('starts counting again at any press, or a file someone chose', () => {
    rolled(3);
    notePress();
    expect(shouldAsk(true)).toBe(false);
    rolled(3);
    targetStarted();
    expect(shouldAsk(true)).toBe(false);
  });
});
