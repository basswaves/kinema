import { describe, expect, it } from 'vitest';
import { BASE_MPV_OPTIONS, TONE_MAPPING_OPTIONS } from './mpvOptions';
import {
  BEHIND_PERCENT,
  CLEAN_FILMS,
  STEPS,
  afterCleanFilm,
  cleanFilm,
  decide,
  deviceId,
  judgeWindow as judge,
  newWatch,
  nextLevel,
  optionsForLevel,
  parseMemory,
  stepsInForce,
  type Rates,
  type Sample,
  type StepState,
  type Verdict,
} from './stepDown';
import { describeStepDown } from './stats';

const at = (secs: number, over: Partial<Sample> = {}): Sample => ({
  at: secs * 1000,
  pos: 100 + secs,
  dropped: 0,
  decoderDropped: 0,
  delayed: 0,
  held: false,
  ...over,
});

/** Hardware decoding on a screen faster than any film: only the card can lose frames. */
const judgeWindow = (start: Sample, end: Sample, fps: number | null, over: Partial<Rates> = {}) =>
  judge(start, end, { fps, displayFps: 120, hwdec: 'd3d11va', ...over });

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

describe('only frames the graphics card lost count', () => {
  it('does not count what mpv drops by design for a film faster than the screen', () => {
    // TV PC, 2026-11-13: 59.94 fps on a 30 Hz screen, hardware decoding.
    // frame-drop-count 1786 with decoder and late counts 0, which the old
    // count called 49.9% missed. Per 10 s window: about 300 dropped.
    const v = judgeWindow(at(0), at(10, { dropped: 300 }), 59.94, { displayFps: 30 });
    expect(v.kind).toBe('fine');
    if (v.kind === 'fine') expect(v.percent).toBeLessThan(1);
  });

  it('still counts what the card loses on top of the frames the screen cannot show', () => {
    // 300 by design and 20 more: 20 of the 300 frames the screen could show.
    const v = judgeWindow(at(0), at(10, { dropped: 320 }), 59.94, { displayFps: 30 });
    expect(v.kind).toBe('behind');
    if (v.kind === 'behind') expect(v.percent).toBeCloseTo(6.67, 0);
  });

  it('takes nothing off when the film is slower than the screen', () => {
    expect(judgeWindow(at(0), at(10, { dropped: 8 }), 23.976, { displayFps: 60 }).kind).toBe(
      'behind'
    );
  });

  it('cannot take off a screen rate mpv does not know', () => {
    // Counted as before; decide() puts the rung back when it does not help.
    const v = judgeWindow(at(0), at(10, { dropped: 300 }), 59.94, { displayFps: null });
    expect(v.kind).toBe('behind');
  });

  it('does not count a film the processor decodes too slowly', () => {
    // Linux test PC, A3-03: 4K H.264 with hwdec-current=no, decoder drops 0,
    // the video output dropped 45 in about 35 s, which was called 13.8% missed.
    const v = judgeWindow(at(0), at(10, { dropped: 33 }), 23.976, { hwdec: 'no' });
    expect(v).toMatchObject({ kind: 'not-gpu', why: 'software-decode' });
    for (const hwdec of ['', null]) {
      expect(judgeWindow(at(0), at(10, { dropped: 33 }), 23.976, { hwdec }).kind).toBe('not-gpu');
    }
  });

  it('does not count a window in which the decoder dropped frames', () => {
    const v = judgeWindow(at(0), at(10, { dropped: 20, decoderDropped: 5 }), 24);
    expect(v).toMatchObject({ kind: 'not-gpu', why: 'decoder' });
  });

  it('takes a clean window decoded in software as the card keeping up', () => {
    expect(judgeWindow(at(0), at(10), 23.976, { hwdec: 'no' }).kind).toBe('fine');
  });

  it('throws away a window that ended with the player closing, or another file', () => {
    expect(judgeWindow(at(0), at(10, { held: true, dropped: 60 }), 24).kind).toBe('skip');
    const v = judgeWindow(at(0, { decoderDropped: 9 }), at(10, { decoderDropped: 0 }), 24);
    expect(v.kind).toBe('skip');
  });
});

describe('deciding', () => {
  const behind = (percent: number): Verdict => ({ kind: 'behind', percent });
  const fine: Verdict = { kind: 'fine', percent: 0 };

  it('takes a rung when the card falls behind, and the next when it helped but not enough', () => {
    let r = decide(newWatch(), behind(8), 0, true);
    expect(r.action).toEqual({ kind: 'down', to: 1, percent: 8 });
    r = decide(r.watch, behind(4), 1, true);
    expect(r.action).toEqual({ kind: 'down', to: 2, percent: 4 });
  });

  it('puts back a rung whose drops did not fall, and stops', () => {
    // TV PC: the drops stayed at 49.9% after level 2 and after level 3.
    let r = decide(newWatch(), behind(49.9), 0, false);
    expect(r.action).toEqual({ kind: 'down', to: 2, percent: 49.9 });
    r = decide(r.watch, behind(49.9), 2, false);
    expect(r.action).toEqual({ kind: 'undo', to: 0, before: 49.9, after: 49.9 });
    expect(r.watch.done).toBe(true);
    expect(decide(r.watch, behind(50), 0, false).action).toEqual({ kind: 'none' });
  });

  it('keeps a rung after which the film played clean', () => {
    let r = decide(newWatch(), behind(5), 0, true);
    r = decide(r.watch, fine, 1, true);
    expect(r.action).toEqual({ kind: 'none' });
    expect(r.watch.stepped).toBeNull();
    expect(cleanFilm(r.watch)).toBe(false); // a rung went down in this film
  });

  it('waits for a window that is the card’s before judging a rung', () => {
    let r = decide(newWatch(), behind(5), 0, true);
    r = decide(r.watch, { kind: 'not-gpu', why: 'decoder', percent: 30 }, 1, true);
    expect(r.action).toEqual({ kind: 'none' });
    expect(r.watch.stepped).not.toBeNull();
    r = decide(r.watch, { kind: 'skip' }, 1, true);
    expect(r.watch.stepped).not.toBeNull();
  });

  it('stops when nothing is left to give up', () => {
    const r = decide(newWatch(), behind(9), STEPS.length, true);
    expect(r.action).toEqual({ kind: 'none' });
    expect(r.watch.done).toBe(true);
  });

  it('counts a film as clean only when measured long enough without a rung', () => {
    let w = newWatch();
    expect(cleanFilm(w)).toBe(false);
    w = decide(w, fine, 2, true).watch;
    expect(cleanFilm(w)).toBe(false);
    w = decide(w, fine, 2, true).watch;
    expect(cleanFilm(w)).toBe(true);
    // Windows that were not the card's do not make a film clean.
    let n = newWatch();
    const soft: Verdict = { kind: 'not-gpu', why: 'software-decode', percent: 13.8 };
    for (let i = 0; i < 5; i++) n = decide(n, soft, 2, true).watch;
    expect(cleanFilm(n)).toBe(false);
  });

  it(`tries one rung up after ${CLEAN_FILMS} clean films, and counts again from there`, () => {
    let s: StepState = { level: 3, percent: 2.1, clean: 0 };
    for (let i = 1; i < CLEAN_FILMS; i++) {
      s = afterCleanFilm(s);
      expect(s).toMatchObject({ level: 3, clean: i });
    }
    expect(afterCleanFilm(s)).toEqual({ level: 2, percent: null, clean: 0 });
    expect(afterCleanFilm({ level: 0, percent: null })).toEqual({
      level: 0,
      percent: null,
      clean: 0,
    });
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
      a: { level: 2, percent: 3.5, clean: 0 },
      d: { level: 1, percent: null, clean: 0 },
    });
    expect(parseMemory(JSON.stringify({ a: { level: 2, clean: 2 } })).a.clean).toBe(2);
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
