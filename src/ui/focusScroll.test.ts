/**
 * The scroll spring (focusScroll.ts `glide`) without a browser: frames are
 * handed out by hand, as a busy machine or a slow TV box gives them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { glide, gliding } from './focusScroll';

let clock = 0;
let queued: ((now: number) => void)[] = [];

/** One frame, `ms` after the last. */
function frame(ms: number): void {
  clock += ms;
  const run = queued;
  queued = [];
  for (const f of run) f(clock);
}

function page(): HTMLElement {
  return { scrollTop: 0, scrollLeft: 0, scrollHeight: 5000, clientHeight: 800 } as unknown as HTMLElement;
}

beforeEach(() => {
  clock = 0;
  queued = [];
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('requestAnimationFrame', (f: (now: number) => void) => queued.push(f));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  for (let i = 0; i < 1000 && gliding(); i++) frame(16);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Frames every `every` ms until the spring rests; the time it took. */
function settleTime(every: number): number {
  const start = clock;
  for (let i = 0; i < 1000 && gliding(); i++) frame(every);
  return clock - start;
}

describe('glide', () => {
  it('settles in about its duration at 60 frames a second, and lands exactly', () => {
    const el = page();
    glide(el, 'y', 900, 220);
    const took = settleTime(16);
    expect(took).toBeGreaterThan(150);
    expect(took).toBeLessThan(450);
    expect(el.scrollTop).toBe(900);
  });

  it('starts gently: the first frame is a small part of the way', () => {
    const el = page();
    glide(el, 'y', 900, 220);
    frame(16);
    frame(16);
    expect(el.scrollTop).toBeGreaterThan(0);
    expect(el.scrollTop).toBeLessThan(900 * 0.4);
  });

  it('keeps to the clock when frames come slowly: a starved page still settles in time', () => {
    // A busy CI machine or a weak box: a frame every half second. The
    // spring is solved exactly for any step, so it may take the time that
    // passed; capping each step made a 220 ms scroll take seconds per press
    // (the WebKit CI flake, 2026-10-31).
    const el = page();
    glide(el, 'y', 900, 220);
    expect(settleTime(500)).toBeLessThanOrEqual(1000);
    expect(el.scrollTop).toBe(900);
  });

  it('never goes past its target, at any frame rate', () => {
    for (const every of [8, 16, 33, 100, 250]) {
      const el = page();
      glide(el, 'y', 900, 220);
      let highest = 0;
      for (let i = 0; i < 1000 && gliding(); i++) {
        frame(every);
        highest = Math.max(highest, el.scrollTop);
      }
      expect(highest, `every ${every} ms`).toBeLessThanOrEqual(900);
    }
  });
});
