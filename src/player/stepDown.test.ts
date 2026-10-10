import { describe, expect, it } from 'vitest';
import { BASE_MPV_OPTIONS, TONE_MAPPING_OPTIONS } from './mpvOptions';
import {
  BEHIND_PERCENT,
  STEPS,
  deviceId,
  judgeWindow,
  nextLevel,
  optionsForLevel,
  parseMemory,
  stepsInForce,
  type Sample,
} from './stepDown';
import { describeStepDown } from './stats';

const at = (secs: number, over: Partial<Sample> = {}): Sample => ({
  at: secs * 1000,
  pos: 100 + secs,
  dropped: 0,
  delayed: 0,
  held: false,
  ...over,
});

const yesNo = (v: string | number | boolean) =>
  v === true ? 'yes' : v === false ? 'no' : String(v);

describe('the ladder', () => {
  it('puts back exactly what mpvOptions.ts sets', () => {
    const all = { ...BASE_MPV_OPTIONS, ...TONE_MAPPING_OPTIONS };
    for (const step of STEPS) {
      for (const [name, value] of Object.entries(step.base)) {
        expect(yesNo(all[name]), name).toBe(value);
      }
    }
  });

  it('is cumulative, and level 0 is the untouched picture', () => {
    expect(optionsForLevel(0)).toEqual(Object.assign({}, ...STEPS.map((s) => s.base)));
    expect(optionsForLevel(2)['hdr-compute-peak']).toBe('no');
    expect(optionsForLevel(2).cscale).toBe('bilinear');
    expect(optionsForLevel(2)['linear-downscaling']).toBe('yes');
    expect(optionsForLevel(STEPS.length)['gamut-mapping-mode']).toBe('relative');
  });

  it('goes one rung at a time, cheapest first, and then stops', () => {
    expect(nextLevel(0, true)).toBe(1);
    expect(STEPS[0].id).toBe('peak');
    expect(nextLevel(STEPS.length, true)).toBeNull();
  });

  it('passes over rungs that cannot show in an SDR film', () => {
    expect(nextLevel(0, false)).toBe(2);
    expect(nextLevel(3, false)).toBeNull();
    expect(stepsInForce(4, false).map((s) => s.id)).toEqual(['chroma', 'downscaling']);
    expect(stepsInForce(4, true)).toHaveLength(4);
  });
});

describe('judgeWindow', () => {
  it('leaves a clean window alone', () => {
    const v = judgeWindow(at(0), at(10), 23.976);
    expect(v).toEqual({ kind: 'fine', percent: 0 });
  });

  it('steps down when more than 2% of the frames were missed', () => {
    // 240 frames in 10 s; 8 dropped and 2 late is 4.2%.
    const v = judgeWindow(at(0), at(10, { dropped: 8, delayed: 2 }), 24);
    expect(v.kind).toBe('behind');
    if (v.kind === 'behind') expect(v.percent).toBeCloseTo(4.17, 1);
  });

  it('does not for 2% or less, or for fewer than three frames', () => {
    expect(judgeWindow(at(0), at(10, { dropped: 4 }), 24).kind).toBe('fine'); // 1.7%
    expect(judgeWindow(at(0), at(10, { dropped: 2 }), 24).kind).toBe('fine');
    expect(judgeWindow(at(0), at(10, { dropped: 5 }), 24).kind).toBe('behind'); // 2.08%
    expect(BEHIND_PERCENT).toBe(2);
  });

  it('measures against a guess of 24 fps when the film has none', () => {
    expect(judgeWindow(at(0), at(10, { dropped: 10 }), null).kind).toBe('behind');
  });

  it('throws away a window with a seek in it', () => {
    expect(judgeWindow(at(0), at(10, { pos: 300, dropped: 60 }), 24)).toEqual({ kind: 'skip' });
  });

  it('throws away a window with a pause or a stall in it', () => {
    expect(judgeWindow(at(0), at(10, { pos: 105.5, dropped: 40 }), 24).kind).toBe('skip');
  });

  it('throws away a window that began or ended paused', () => {
    expect(judgeWindow(at(0, { held: true }), at(10, { dropped: 40 }), 24).kind).toBe('skip');
    expect(judgeWindow(at(0), at(10, { held: true, dropped: 40 }), 24).kind).toBe('skip');
  });

  it('throws away a window whose counters went backwards (another file)', () => {
    expect(judgeWindow(at(0, { dropped: 50 }), at(10, { dropped: 2 }), 24).kind).toBe('skip');
  });

  it('throws away a window with no position', () => {
    expect(judgeWindow(at(0), at(10, { pos: null }), 24).kind).toBe('skip');
  });
});

describe('what is remembered', () => {
  it('names the device by interface and cards, in a fixed order', () => {
    expect(deviceId('d3d11', ['B Card', 'A Card'])).toBe('d3d11 · A Card + B Card');
    expect(deviceId('auto', [])).toBe('auto');
    expect(deviceId('auto', [' '])).toBe('auto');
  });

  it('reads what it wrote, and forgets anything odd', () => {
    const raw = JSON.stringify({
      a: { level: 2, percent: 3.5 },
      b: { level: 9 },
      c: { level: 0 },
      d: { level: 1 },
      e: 'x',
    });
    expect(parseMemory(raw)).toEqual({
      a: { level: 2, percent: 3.5 },
      d: { level: 1, percent: null },
    });
    for (const bad of [null, '', 'nope', '[]', '3']) expect(parseMemory(bad)).toEqual({});
  });
});

describe('the details panel', () => {
  it('says nothing while no step is down', () => {
    expect(describeStepDown({ level: 0, percent: null }, true)).toBeNull();
  });

  it('names each step given up and the share of frames dropped', () => {
    const row = describeStepDown({ level: 2, percent: 4.17 }, true);
    expect(row?.value).toBe(
      'HDR peak detection off (was on) · chroma upscaling bilinear (was spline36)'
    );
    expect(row?.note).toMatch(
      /dropped to keep up: the graphics card fell behind \(4\.2% frames dropped\)/
    );
    expect(row?.warn).toBe(true);
  });

  it('says it was an earlier film when it does not know the share', () => {
    const row = describeStepDown({ level: 2, percent: null }, true);
    expect(row?.note).toMatch(/on an earlier film/);
    expect(row?.note).not.toMatch(/% frames/);
  });

  it('leaves out what cannot show in an SDR film, and says nothing if that is all', () => {
    expect(describeStepDown({ level: 2, percent: 3 }, false)?.value).toBe(
      'chroma upscaling bilinear (was spline36)'
    );
    expect(describeStepDown({ level: 1, percent: 3 }, false)).toBeNull();
  });
});
