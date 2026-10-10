/**
 * The light look — the same screens without the effects a weak device cannot
 * afford: blurs, large shadows, the zoom on the highlighted picture and the
 * gliding scroll. Layout is identical, so navigation does not change; the
 * highlight outline stays.
 *
 * `Auto` (the default) picks it on a device that looks weak, `Full` and
 * `Light` are the owner's override. This is a written exception to "no
 * quality-preset UI" (owner, 2026-10-10): the page cannot see how fast the
 * screen really draws on every box, so the person may say. It is a setting
 * about the hardware, not about taste.
 *
 * What Auto goes by is only what the page can read without native code:
 * the processor count, the memory the browser reports (where it does), and
 * how long frames took while Home was opening. The first two decide at once;
 * the frame times are measured once per launch, a moment after Home appears.
 * Nothing flips back and forth afterwards — only a change in Settings does.
 *
 * `ui.css` keys off `:root[data-look='light']` and nothing else.
 */
import { useSyncExternalStore } from 'react';
import { getSetting, setSetting } from '../metadata/api';

export const LOOK_KEY = 'look';

export type LookSetting = 'auto' | 'full' | 'light';

/** What the page could read about this device. Anything unknown is left out. */
export interface DeviceFacts {
  /** `navigator.hardwareConcurrency`. */
  cores?: number;
  /** `navigator.deviceMemory`, in GB (Chromium only; rounded by the browser). */
  memoryGb?: number;
  /** Median time between two drawn frames while Home opened, in ms. */
  medianFrameMs?: number;
  /**
   * The screen's own pace in the same sample (its quickest frames, the tenth
   * percentile): 17 ms at 60 Hz, 20 at 50 Hz, 42 at 24 Hz. Frames are only
   * slow measured against this — a 24 Hz screen is not a weak device.
   */
  screenFrameMs?: number;
}

export interface LookDecision {
  light: boolean;
  /** One plain sentence fragment, for the log and for Settings. */
  reason: string;
}

/** At or below these, Auto chooses Light. */
export const WEAK_CORES = 2;
export const WEAK_MEMORY_GB = 2;
/**
 * Frames this much slower than the screen's own pace, at the median, mean the
 * device missed about every other frame while Home opened.
 */
export const WEAK_FRAME_RATIO = 1.4;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Pure: the setting and the facts in, the choice and why out. */
export function decideLook(setting: LookSetting, facts: DeviceFacts): LookDecision {
  if (setting === 'light') return { light: true, reason: 'Light: chosen in Settings' };
  if (setting === 'full') return { light: false, reason: 'Full: chosen in Settings' };

  const { cores, memoryGb, medianFrameMs, screenFrameMs } = facts;
  if (cores !== undefined && cores <= WEAK_CORES) {
    return {
      light: true,
      reason: `Light: this device has ${plural(cores, 'processor core', 'processor cores')}`,
    };
  }
  if (memoryGb !== undefined && memoryGb <= WEAK_MEMORY_GB) {
    return { light: true, reason: `Light: this device reports ${memoryGb} GB of memory` };
  }
  if (
    medianFrameMs !== undefined &&
    screenFrameMs !== undefined &&
    medianFrameMs > WEAK_FRAME_RATIO * screenFrameMs
  ) {
    return {
      light: true,
      reason: `Light: while Kinema opened it drew a frame every ${Math.round(medianFrameMs)} ms on a screen that takes one every ${Math.round(screenFrameMs)} ms`,
    };
  }

  // Full, saying what was known (never claiming more than was read).
  const known: string[] = [];
  if (cores !== undefined) known.push(plural(cores, 'processor core', 'processor cores'));
  if (memoryGb !== undefined) known.push(`${memoryGb} GB of memory`);
  if (medianFrameMs !== undefined) known.push(`a frame every ${Math.round(medianFrameMs)} ms`);
  return {
    light: false,
    reason: known.length
      ? `Full: this device has ${known.join(' and ')}`
      : 'Full: nothing about this device looks weak',
  };
}

/** Pure: the tenth-percentile interval — the screen's own pace — or undefined if too few. */
export function screenFrameInterval(times: number[], skip = 2, minIntervals = 20): number | undefined {
  const intervals: number[] = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
  const rest = intervals.slice(skip);
  if (rest.length < minIntervals) return undefined;
  rest.sort((a, b) => a - b);
  return rest[Math.floor(rest.length / 10)];
}

/** Pure: the middle interval between frame times, or undefined if too few. */
export function medianFrameInterval(times: number[], skip = 2, minIntervals = 20): number | undefined {
  const intervals: number[] = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
  // The first frames carry the page's own start-up work, not the device's pace.
  const rest = intervals.slice(skip);
  if (rest.length < minIntervals) return undefined;
  rest.sort((a, b) => a - b);
  const mid = rest.length >> 1;
  return rest.length % 2 ? rest[mid] : (rest[mid - 1] + rest[mid]) / 2;
}

export interface LookState {
  setting: LookSetting;
  light: boolean;
  reason: string;
  /** Auto is still waiting for the frame times. */
  measuring: boolean;
}

let state: LookState = {
  setting: 'auto',
  light: false,
  reason: 'Full: nothing about this device looks weak',
  measuring: false,
};
const listeners = new Set<() => void>();

function readFacts(): DeviceFacts {
  const facts: DeviceFacts = {};
  // Read when this module loads; outside a browser (the unit tests, on a
  // Node without `navigator`) there is nothing to read.
  if (typeof navigator === 'undefined') return facts;
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0) {
    facts.cores = nav.hardwareConcurrency;
  }
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0) {
    facts.memoryGb = nav.deviceMemory;
  }
  return facts;
}

const facts: DeviceFacts = readFacts();
/** The frame probe runs at most once per launch. */
let probeStarted = false;
let probing = false;

function apply(setting: LookSetting): void {
  const decision = decideLook(setting, facts);
  const measuring = setting === 'auto' && !decision.light && probing;
  state = { setting, light: decision.light, reason: decision.reason, measuring };
  document.documentElement.dataset.look = decision.light ? 'light' : 'full';
  // Rare (start-up, the measurement, a change in Settings), so every time.
  console.info(`look: ${decision.reason}`, { setting, ...facts });
  for (const listener of listeners) listener();
}

/** Resolves when Home is on screen, or after `giveUpMs`. */
function homeAppeared(giveUpMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = performance.now();
    const look = () => {
      if (document.querySelector('.home')) return resolve(true);
      if (performance.now() - started > giveUpMs) return resolve(false);
      window.setTimeout(look, 250);
    };
    look();
  });
}

/** Frame times for about `ms`, by requestAnimationFrame. */
function sampleFrames(ms: number): Promise<number[]> {
  return new Promise((resolve) => {
    const times: number[] = [];
    const begin = performance.now();
    const tick = (t: number) => {
      times.push(t);
      if (performance.now() - begin >= ms) resolve(times);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Measure once, about 1.5 s of frames starting when Home appears. Skipped when
 * the processor or memory already said Light, and when a hidden page would
 * give no frames at all (then Auto stays on what it knows).
 */
async function probe(): Promise<void> {
  if (probeStarted) return;
  probeStarted = true;
  probing = true;
  apply(state.setting);
  try {
    if (!(await homeAppeared(30_000)) || document.hidden) return;
    const times = await sampleFrames(1500);
    const median = medianFrameInterval(times);
    if (median === undefined) {
      console.info('look: too few frames to judge the screen', { frames: times.length });
    } else {
      facts.medianFrameMs = median;
      facts.screenFrameMs = screenFrameInterval(times);
    }
  } finally {
    probing = false;
    apply(state.setting);
  }
}

/**
 * Read the setting and decide. A failure to read keeps Auto: an unreadable
 * setting is not a reason to show a worse picture, or none.
 */
export async function loadLook(): Promise<void> {
  const stored = await getSetting(LOOK_KEY).catch((e) => {
    console.warn('look: could not read setting, using Auto', e);
    return null;
  });
  const setting: LookSetting = stored === 'full' || stored === 'light' ? stored : 'auto';
  apply(setting);
  // Only Auto with nothing weak so far needs the frame times.
  if (setting === 'auto' && !state.light) void probe();
}

/** Apply at once, persist in the background. */
export function setLook(setting: LookSetting): void {
  apply(setting);
  if (setting === 'auto' && !state.light) void probe();
  void setSetting(LOOK_KEY, setting).catch((e) => console.warn('look: could not save setting', e));
}

/** For code outside React (the smooth-scroll calls in `focus.ts`). */
export function isLightLook(): boolean {
  return state.light;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLook(): LookState {
  return useSyncExternalStore(subscribe, () => state);
}
