import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Screen } from './displayMode';

// The system's way (Android): Kinema asks the system for a mode and the
// system answers. Everything outside displaySwitch.ts is stood in for.
const screen = vi.hoisted(() => ({ now: null as Screen | null }));
const asked = vi.hoisted(() => [] as number[]);

vi.mock('../capabilities', () => ({ capabilitiesNow: () => ({ system_output: true }) }));
vi.mock('../metadata/api', () => ({ getSetting: async () => null }));
vi.mock('./engine', () => ({
  systemScreen: async () => screen.now,
  askScreenMode: async (width: number, height: number, rate: number) => {
    asked.push(rate);
    return { width, height, hz: Math.floor(rate), rate };
  },
  restoreScreenMode: async () => false,
  isPictureFullscreen: async () => true,
  mpvGet: async () => null,
  mpvSet: async () => undefined,
  videoFacts: async () => null,
}));

import { switchForFilm } from './displaySwitch';

const mode = (width: number, height: number, rate: number) => ({
  width,
  height,
  hz: Math.floor(rate + 0.001),
  rate,
});
const film = { width: 3840, height: 1920, fps: 23.976, hdr: true };

describe('matching the screen through the system', () => {
  beforeEach(() => {
    asked.length = 0;
    // The settling wait is window.setTimeout; these tests run without a page.
    vi.stubGlobal('window', globalThis);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('says nothing and changes nothing when the screen offers one mode', async () => {
    // A TV box that gives apps 1920×1080 at 50 Hz and nothing else.
    const only = mode(1920, 1080, 50);
    screen.now = { ...only, gdi_name: 'display 0', hdr: 'unknown', modes: [only] };
    const said = vi.fn();
    await expect(switchForFilm(film, said)).resolves.toBe(false);
    expect(said).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('says it is matching once there is a mode to switch to', async () => {
    const now = mode(3840, 2160, 50);
    const cinema = mode(3840, 2160, 23.976);
    screen.now = { ...now, gdi_name: 'display 0', hdr: 'unknown', modes: [now, cinema] };
    const said = vi.fn();
    const done = switchForFilm(film, said);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe(true);
    expect(said).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([23.976]);
  });
});
