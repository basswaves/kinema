import { afterEach, describe, expect, it, vi } from 'vitest';

const told: boolean[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: { on: boolean }) => {
    if (command === 'set_playing') told.push(args.on);
    return null;
  }),
}));

const { isPlaybackActive, setPlaybackActive, yieldToPlayback } = await import('./playback');

afterEach(() => {
  setPlaybackActive(false);
  told.length = 0;
  vi.useRealTimers();
});

describe('yielding to playback', () => {
  it('passes straight through when nothing is playing', async () => {
    await yieldToPlayback();
    expect(isPlaybackActive()).toBe(false);
  });

  it('waits while a film is open and goes on once it is closed', async () => {
    vi.useFakeTimers();
    setPlaybackActive(true);
    let resumed = false;
    const waiting = yieldToPlayback().then(() => (resumed = true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(resumed).toBe(false);
    setPlaybackActive(false);
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(resumed).toBe(true);
  });

  it('tells the native side once per change', () => {
    setPlaybackActive(true);
    setPlaybackActive(true);
    setPlaybackActive(false);
    expect(told).toEqual([true, false]);
  });
});
