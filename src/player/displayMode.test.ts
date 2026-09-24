import { describe, expect, it } from 'vitest';
import type { DisplayMode as Mode } from './equipment';
import {
  cadenceRank,
  chooseResolution,
  chooseTarget,
  DEFAULT_SWITCH_SETTINGS,
  type Film,
  type Screen,
} from './displayMode';

const rateOf = (hz: number) => ([23, 29, 47, 59, 119].includes(hz) ? ((hz + 1) * 1000) / 1001 : hz);
const mode = (width: number, height: number, hz: number): Mode => ({
  width,
  height,
  hz,
  rate: rateOf(hz),
});

/** the test TV, as its equipment line reads. */
const lgModes = [3840, 1920].flatMap((w) =>
  [60, 59, 50, 30, 24, 23].map((hz) => mode(w, w === 3840 ? 2160 : 1080, hz))
);
const lg = (width: number, height: number, hz: number, hdr: Screen['hdr'] = 'off'): Screen => ({
  width,
  height,
  hz,
  rate: rateOf(hz),
  hdr,
  modes: lgModes,
});

/** The development monitor here: 23.976 only at 1080p and below. */
const devMonitor: Screen = {
  width: 2560,
  height: 1600,
  hz: 60,
  rate: 60,
  hdr: 'unsupported',
  modes: [mode(2560, 1600, 60), mode(1920, 1080, 60), mode(1920, 1080, 24), mode(1920, 1080, 23)],
};

const film4k: Film = { width: 3840, height: 1600, fps: 24000 / 1001, hdr: true };
const film1080: Film = { width: 1920, height: 800, fps: 24000 / 1001, hdr: false };

describe('cadenceRank', () => {
  it('prefers the exact rate, then its multiples, then 24 for 23.976', () => {
    const fps = 24000 / 1001;
    expect(cadenceRank(rateOf(23), fps)).toBe(0);
    expect(cadenceRank(rateOf(47), fps)).toBe(1);
    expect(cadenceRank(rateOf(119), fps)).toBe(4);
    expect(cadenceRank(24, fps)).toBe(10);
    expect(cadenceRank(60, fps)).toBeNull();
    expect(cadenceRank(rateOf(59), fps)).toBeNull();
  });

  it('matches PAL and NTSC video too', () => {
    expect(cadenceRank(50, 25)).toBe(1);
    expect(cadenceRank(rateOf(59), 30000 / 1001)).toBe(1);
  });
});

describe('chooseResolution', () => {
  it('Auto switches a 1080p desktop up for a 4K film', () => {
    expect(chooseResolution(lg(1920, 1080, 60), film4k, 'auto')).toEqual({
      width: 3840,
      height: 2160,
    });
  });

  it('Auto never switches down', () => {
    expect(chooseResolution(lg(3840, 2160, 60), film1080, 'auto')).toEqual({
      width: 3840,
      height: 2160,
    });
  });

  it("Match content uses the film's own resolution, for the TV to upscale", () => {
    expect(chooseResolution(lg(3840, 2160, 60), film1080, 'match')).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('Off never changes anything', () => {
    expect(chooseResolution(lg(1920, 1080, 60), film4k, 'off')).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('a film bigger than any mode gets the screen at its largest', () => {
    expect(chooseResolution(devMonitor, film4k, 'auto')).toEqual({ width: 2560, height: 1600 });
  });
});

describe('chooseTarget', () => {
  const refresh = { ...DEFAULT_SWITCH_SETTINGS, refresh: true };

  it("defaults do nothing on the test TV at 4K", () => {
    expect(chooseTarget(lg(3840, 2160, 60), film4k, DEFAULT_SWITCH_SETTINGS)).toBeNull();
  });

  it('with refresh on, a 23.976 film gets 23.976 Hz at the same resolution', () => {
    expect(chooseTarget(lg(3840, 2160, 60), film4k, refresh)).toEqual({
      width: 3840,
      height: 2160,
      hz: 23,
      rate: 24000 / 1001,
      hdr: null,
    });
  });

  it('never gives up resolution for a refresh rate (the development monitor)', () => {
    expect(chooseTarget(devMonitor, film1080, refresh)).toBeNull();
  });

  it('keeps the current rate when only the resolution changes', () => {
    expect(chooseTarget(lg(1920, 1080, 60), film4k, DEFAULT_SWITCH_SETTINGS)).toMatchObject({
      width: 3840,
      height: 2160,
      hz: 60,
    });
  });

  it('turns HDR on for an HDR film only when asked and only if the screen can', () => {
    const hdr = { ...DEFAULT_SWITCH_SETTINGS, hdr: true };
    expect(chooseTarget(lg(3840, 2160, 60), film4k, hdr)).toMatchObject({ hdr: true, hz: 60 });
    expect(chooseTarget(lg(3840, 2160, 60, 'on'), film4k, hdr)).toBeNull();
    expect(chooseTarget(lg(3840, 2160, 60), { ...film4k, hdr: false }, hdr)).toBeNull();
    expect(chooseTarget(devMonitor, film4k, hdr)).toBeNull();
  });

  it('does nothing when the frame rate is unknown and nothing else applies', () => {
    expect(chooseTarget(lg(3840, 2160, 60), { ...film4k, fps: null }, refresh)).toBeNull();
  });
});
