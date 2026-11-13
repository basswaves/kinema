/**
 * Stepping down on a weak graphics card — the only place Kinema lowers the
 * picture, and only because the alternative is worse.
 *
 * mpvOptions.ts picks every rendering option for the picture, never for the
 * speed, and has no quality selector on purpose: the right settings depend
 * on the film and the screen, not on taste. A graphics card too slow for
 * them is the one thing that cannot be told in advance, and a film that
 * drops frames is further from the creator's intent than a chroma scaler a
 * notch simpler. So when — and only when — frames are measurably being
 * dropped, Kinema gives up the cheapest part of the picture first, one rung
 * at a time, and says exactly which in the details panel (stats.ts).
 *
 * The ladder (`STEPS`) is ordered by what it costs the picture, least first.
 * A level is how many rungs are down, and it is cumulative: level 2 has
 * given up the first two. Level 0 is mpvOptions.ts untouched, which is what
 * every card that keeps up stays at forever.
 *
 * Only frames the graphics card lost count (`judgeWindow`). mpv also drops
 * frames for reasons no rung can help: a film faster than the screen (59.94
 * fps on a 30 Hz screen shows every second frame, by design), and a decoder
 * that cannot keep up (software decoding a film too big for the processor).
 * Counting those once put a strong card and a weak processor down for good
 * (docs/GOTCHAS.md, "Dropped frames the graphics card did not cause").
 *
 * Remembered per device: the graphics card and the graphics interface, so
 * the same PC starts the next film at the level it needed, instead of
 * dropping frames for ten seconds each time to find out. A level is not for
 * good: a rung whose drops did not fall is put back at once (`decide`), and
 * after `CLEAN_FILMS` films that played clean at a level, the next film tries
 * one rung back up (`recordCleanFilm`). Settings → Advanced can forget every
 * level (`forgetStepDown`).
 *
 * This file is the decision and the memory; `useStepDown.ts` is the part that
 * watches mpv. Nothing here runs on Android, where Media3 draws the picture.
 */
import { capabilitiesNow, loadCapabilities } from '../capabilities';
import { getSetting, setSetting } from '../metadata/api';
import { mpvCommand } from './engine';
import { getEquipment } from './equipment';

/** One rung: what is given up, and the value to give back when it is not. */
export interface Step {
  id: string;
  /** What it is called in the details panel, naming what it was. */
  label: string;
  /** Only changes the picture of an HDR film, so it is skipped for an SDR one. */
  hdrOnly: boolean;
  /** The value of each option once this rung is down. */
  down: Record<string, string>;
  /**
   * The value of each option when it is not. Must equal what mpvOptions.ts
   * sets (a test says so), since this is what level 0 puts back.
   */
  base: Record<string, string>;
}

export const STEPS: readonly Step[] = [
  {
    // Measuring the real peak of every frame is a compute pass over the
    // whole picture. Without it the film's own metadata is used, which is
    // what the display gets in `source` mode anyway.
    id: 'peak',
    label: 'HDR peak detection off (was on)',
    hdrOnly: true,
    down: { 'hdr-compute-peak': 'no' },
    base: { 'hdr-compute-peak': 'yes' },
  },
  {
    // spline36 on chroma runs on every frame of every subsampled film.
    id: 'chroma',
    label: 'chroma upscaling bilinear (was spline36)',
    hdrOnly: false,
    down: { cscale: 'bilinear' },
    base: { cscale: 'spline36' },
  },
  {
    // Resampling in linear light costs a conversion each way; it matters only
    // where the picture is shrunk to fit the screen.
    id: 'downscaling',
    label: 'downscaling not in linear light (was linear)',
    hdrOnly: false,
    down: { 'linear-downscaling': 'no', 'correct-downscaling': 'no' },
    base: { 'linear-downscaling': 'yes', 'correct-downscaling': 'yes' },
  },
  {
    // Perceptual mapping is the costly one of libplacebo's gamut mappers.
    // It acts only where the film's colours must be converted to the
    // screen's, which for practical purposes is HDR.
    id: 'gamut',
    label: 'gamut mapping relative (was perceptual)',
    hdrOnly: true,
    down: { 'gamut-mapping-mode': 'relative' },
    base: { 'gamut-mapping-mode': 'perceptual' },
  },
];

/** How many rungs are down: 0 (none) to `STEPS.length`. */
export type Level = number;

/** Where the ladder stands, and what made it go there. */
export interface StepState {
  level: Level;
  /** The share of frames missed when the last rung went down; null if an earlier film's. */
  percent: number | null;
  /** Films played clean at this level since it was reached (memory only; 0 if not known). */
  clean?: number;
}

/** Every option on the ladder with the value it has at `level`. */
export function optionsForLevel(level: Level): Record<string, string> {
  const out: Record<string, string> = {};
  STEPS.forEach((step, i) => Object.assign(out, i < level ? step.down : step.base));
  return out;
}

/**
 * The level to go to when frames are being dropped at `level`, or null when
 * there is nothing left to give up. A rung that cannot change this film's
 * picture is passed over (peak detection on an SDR film is already moot);
 * going past it still puts it down, which costs nothing.
 */
export function nextLevel(level: Level, hdr: boolean): Level | null {
  for (let next = level + 1; next <= STEPS.length; next++) {
    if (!STEPS[next - 1].hdrOnly || hdr) return next;
  }
  return null;
}

/** The rungs that are down and would show in this film's picture. */
export function stepsInForce(level: Level, hdr: boolean): Step[] {
  return STEPS.slice(0, Math.max(0, level)).filter((s) => hdr || !s.hdrOnly);
}

// ---- deciding whether frames are being dropped ------------------------------

/** How often mpv is looked at, ms. */
export const SAMPLE_MS = 2000;
/** How long one measurement lasts, ms. */
export const WINDOW_MS = 10_000;
/**
 * How long a film is watched from its first picture, ms. After this it is
 * taken to be what the card can do; a later start will have the level the
 * earlier film reached.
 */
export const WATCH_MS = 45_000;
/**
 * The quiet after a rung goes down, ms: mpv rebuilds its shaders, and the
 * frames that rebuild delays say nothing about the new level. The same quiet
 * follows the first picture, when the player is still opening (shaders built,
 * the screen's mode switched).
 */
export const SETTLE_MS = 4000;
/**
 * The share of the film's frames, in percent, that may be missed in a window
 * before a rung goes down. One in fifty is a stutter every two seconds at
 * 24 fps: seen on any screen, and far above the odd frame a healthy start or a
 * busy moment costs.
 */
export const BEHIND_PERCENT = 2;
/** And never fewer frames than this, however few frames the window held. */
export const BEHIND_MIN_FRAMES = 3;

/** What mpv said at one moment. */
export interface Sample {
  /** Milliseconds, from any clock that does not jump. */
  at: number;
  /** `time-pos` in seconds; null when mpv has none. */
  pos: number | null;
  /** `frame-drop-count`: frames the video output dropped, for any reason. */
  dropped: number;
  /** `decoder-frame-drop-count`: frames the decoder dropped to catch up. */
  decoderDropped: number;
  /** `vo-delayed-frame-count`: frames it showed late. */
  delayed: number;
  /** Paused, scrubbed, waiting for data, ended or closing at that moment. */
  held: boolean;
}

/** What mpv says about the window as a whole, read at its end. */
export interface Rates {
  /** The film's frame rate (`container-fps`, else `estimated-vf-fps`); null if unknown. */
  fps: number | null;
  /** The screen's refresh rate (`display-fps`); null if unknown. */
  displayFps: number | null;
  /** `hwdec-current`: the hardware decoder in use, `no` (or empty) for software. */
  hwdec: string | null;
}

/** Why frames were missed that the graphics card did not lose. */
export type NotGpu = 'decoder' | 'software-decode';

export type Verdict =
  | { kind: 'skip' }
  | { kind: 'not-gpu'; why: NotGpu; percent: number }
  | { kind: 'fine' | 'behind'; percent: number };

/** True when the decoder is the processor, not the graphics card. */
export const softwareDecode = (hwdec: string | null): boolean =>
  hwdec === null || hwdec === '' || hwdec === 'no';

/**
 * Whether the frames of the window from `start` to `end` were missed because
 * the graphics card fell behind.
 *
 * A window is thrown away (`skip`) when the moment could have cost the
 * frames: paused, scrubbed, waiting, ended or closing at either end; the
 * counters going backwards (a new file); or the film's position not having
 * moved by as much as the clock did, which is a seek, a pause and resume, a
 * stall for the cache, or a changed speed.
 *
 * What is left is counted only as far as the graphics card caused it:
 * - A film faster than the screen: mpv can show only `displayFps` frames a
 *   second and drops the rest on purpose. Those expected drops come off
 *   `frame-drop-count` first, and the share is of the frames the screen
 *   could show. (59.94 fps on a 30 Hz screen: half the frames, not 50 %
 *   missed.)
 * - The decoder: when it dropped frames itself, or when the film is decoded
 *   in software, the frames reach the video output late and it drops them;
 *   no rung can speed up a processor (`not-gpu`).
 * `fps` defaults to 24 when the film has none. A screen rate mpv does not
 * know cannot be taken off; `decide` puts back a rung that did not help.
 */
export function judgeWindow(start: Sample, end: Sample, rates: Rates): Verdict {
  if (start.held || end.held || start.pos === null || end.pos === null) return { kind: 'skip' };
  const elapsed = (end.at - start.at) / 1000;
  const played = end.pos - start.pos;
  if (
    elapsed <= 0 ||
    end.dropped < start.dropped ||
    end.delayed < start.delayed ||
    end.decoderDropped < start.decoderDropped
  ) {
    return { kind: 'skip' };
  }
  if (Math.abs(played - elapsed) > Math.max(1, elapsed * 0.15)) return { kind: 'skip' };

  const fps = rates.fps !== null && rates.fps > 0 ? rates.fps : 24;
  const display = rates.displayFps !== null && rates.displayFps > 0 ? rates.displayFps : null;
  const frames = fps * played;
  // Frames the screen could show, and the ones mpv drops by design to fit.
  const faster = display !== null && fps > display;
  const shown = faster ? display * played : frames;
  const byDesign = frames - shown;
  const voDropped = Math.max(0, end.dropped - start.dropped - byDesign);
  const missed = voDropped + (end.delayed - start.delayed);
  const percent = Math.min(100, (100 * missed) / Math.max(1, shown));
  if (missed < BEHIND_MIN_FRAMES || percent <= BEHIND_PERCENT) return { kind: 'fine', percent };
  if (end.decoderDropped > start.decoderDropped) return { kind: 'not-gpu', why: 'decoder', percent };
  if (softwareDecode(rates.hwdec)) return { kind: 'not-gpu', why: 'software-decode', percent };
  return { kind: 'behind', percent };
}

// ---- deciding what to do about it ------------------------------------------

/**
 * A rung "helped" when the next window measured after it missed at most this
 * share of what the window that put it down did. Less than a quarter fewer is
 * within what two windows of the same film differ by, which says the rung
 * did not touch what was dropping the frames.
 */
export const FELL_SHARE = 0.75;
/** Windows judged fine for a film to count as clean (20 s of playing measured). */
export const CLEAN_WINDOWS = 2;
/**
 * Clean films at a level before the next film tries one rung back up.
 *
 * Both levels seen stored in the field were wrong (A3-03): a wrong level costs
 * picture on every film until it is climbed back, while trying the level above
 * on a card that does need it costs about ten seconds of dropped frames in one
 * film's first minute, and then the rung goes down again. Three keeps a wrong
 * level to three films per rung, and a card that really needs it to one short
 * stutter in four films.
 */
export const CLEAN_FILMS = 3;

/** What one film's watch has seen so far. */
export interface Watch {
  /** Windows judged fine. */
  fine: number;
  /** A rung went down this film. */
  behind: boolean;
  /** The rung last put down and the share that put it down, until a window says whether it helped. */
  stepped: { from: Level; percent: number } | null;
  /** Nothing more to do for this film. */
  done: boolean;
}

export const newWatch = (): Watch => ({ fine: 0, behind: false, stepped: null, done: false });

export type Action =
  | { kind: 'none' }
  | { kind: 'down'; to: Level; percent: number }
  | { kind: 'undo'; to: Level; before: number; after: number };

/**
 * One window's verdict, applied to the film's watch at `level`. A window that
 * is not the card's (`skip`, `not-gpu`) changes nothing; a rung whose drops
 * did not fall is put back and the watch ends, since the next rung is the
 * same kind of graphics work; otherwise behind takes the next rung, until
 * there are none.
 */
export function decide(
  watch: Watch,
  verdict: Verdict,
  level: Level,
  hdr: boolean
): { watch: Watch; action: Action } {
  const none: Action = { kind: 'none' };
  if (watch.done || verdict.kind === 'skip' || verdict.kind === 'not-gpu') {
    return { watch, action: none };
  }
  if (verdict.kind === 'fine') {
    return { watch: { ...watch, fine: watch.fine + 1, stepped: null }, action: none };
  }
  const { stepped } = watch;
  if (stepped !== null && verdict.percent > stepped.percent * FELL_SHARE) {
    return {
      watch: { ...watch, stepped: null, done: true },
      action: { kind: 'undo', to: stepped.from, before: stepped.percent, after: verdict.percent },
    };
  }
  const next = nextLevel(level, hdr);
  if (next === null) return { watch: { ...watch, behind: true, done: true }, action: none };
  return {
    watch: { ...watch, behind: true, stepped: { from: level, percent: verdict.percent } },
    action: { kind: 'down', to: next, percent: verdict.percent },
  };
}

/** A watched film was clean: measured long enough, and no rung went down. */
export const cleanFilm = (watch: Watch): boolean =>
  !watch.behind && watch.fine >= CLEAN_WINDOWS;

/**
 * The remembered state after one more clean film at `state`'s level: after
 * `CLEAN_FILMS` of them, one rung back up with the count started again.
 */
export function afterCleanFilm(state: StepState): StepState {
  if (state.level <= 0) return { level: 0, percent: null, clean: 0 };
  const clean = (state.clean ?? 0) + 1;
  if (clean < CLEAN_FILMS) return { ...state, clean };
  return { level: state.level - 1, percent: null, clean: 0 };
}

// ---- what is in force, and what is remembered -------------------------------

/** In force for the film now playing. */
let current: StepState = { level: 0, percent: null };
/** This device's memory, as last read or written. */
let remembered: StepState = { level: 0, percent: null, clean: 0 };
/** The level mpv has actually been given; 0 until something is applied. */
let applied: Level = 0;
let loading: Promise<void> | null = null;
let deviceKey = '';

/** Where the ladder stands for the film now playing. */
export const currentStepDown = (): StepState => current;

/** Settings key: the remembered levels, as JSON `{ "<device>": { level, percent, clean } }`. */
export const STEP_DOWN_KEY = 'player_step_down';

/**
 * Which graphics device a level belongs to: the graphics interface and the
 * cards by name, in a fixed order. Where the cards cannot be named (every
 * system but Windows, for now) it is the interface alone, which is one
 * remembered level for the machine rather than for a card.
 */
export function deviceId(gpuApi: string, gpus: string[]): string {
  const cards = [...gpus].map((g) => g.trim()).filter(Boolean).sort();
  return cards.length > 0 ? `${gpuApi} · ${cards.join(' + ')}` : gpuApi;
}

/** The remembered levels, read defensively: anything odd is no memory. */
export function parseMemory(raw: string | null): Record<string, StepState> {
  const out: Record<string, StepState> = {};
  if (!raw) return out;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const e = entry as { level?: unknown; percent?: unknown; clean?: unknown } | null;
      const level = e && typeof e.level === 'number' ? Math.trunc(e.level) : NaN;
      if (!Number.isFinite(level) || level < 1 || level > STEPS.length) continue;
      const clean = typeof e?.clean === 'number' && e.clean >= 0 ? Math.trunc(e.clean) : 0;
      out[key] = {
        level,
        percent: typeof e?.percent === 'number' && Number.isFinite(e.percent) ? e.percent : null,
        clean,
      };
    }
  } catch {
    // Not JSON: forgotten, as if never remembered.
  }
  return out;
}

async function thisDevice(): Promise<string> {
  await loadCapabilities();
  const caps = capabilitiesNow();
  const gpus = caps?.equipment_detection ? await getEquipment().then((e) => e.gpus, () => []) : [];
  return deviceId(caps?.mpv_video.gpu_api ?? 'auto', gpus);
}

/** Send `level` to mpv; each option separately, so one refusal costs only itself. */
async function applyLevel(level: Level): Promise<void> {
  if (level === applied) return;
  for (const [name, value] of Object.entries(optionsForLevel(level))) {
    try {
      await mpvCommand('set', [name, value]);
    } catch (e) {
      console.warn(`step down: mpv rejected ${name}=${value}`, e);
    }
  }
  applied = level;
}

/** Write this device's state into the memory (level 0: its entry removed). */
async function remember(state: StepState): Promise<void> {
  remembered = state;
  try {
    const memory = parseMemory(await getSetting(STEP_DOWN_KEY));
    if (state.level > 0) memory[deviceKey] = state;
    else delete memory[deviceKey];
    await setSetting(STEP_DOWN_KEY, JSON.stringify(memory));
  } catch (e) {
    console.warn('step down: could not remember the level', e);
  }
}

const rungNames = (level: Level) =>
  STEPS.slice(0, level)
    .map((s) => s.label)
    .join('; ');

/**
 * Put this device's remembered level on mpv before a film shows. Reads the
 * memory once per run; after that the memory here is the one in force. The
 * share of frames is an earlier film's, so it is not carried over. Never
 * throws: no memory is level 0.
 */
export function applyRememberedStepDown(): Promise<void> {
  loading ??= (async () => {
    try {
      deviceKey = await thisDevice();
      const found = parseMemory(await getSetting(STEP_DOWN_KEY))[deviceKey];
      if (found) remembered = found;
    } catch (e) {
      console.warn('step down: could not read what was remembered', e);
    }
  })();
  return loading
    .then(() => {
      current = { level: remembered.level, percent: null };
      return applyLevel(current.level);
    })
    .catch(() => undefined);
}

/** Take the next rung down, say so in the log, and remember it. */
export async function stepDownTo(level: Level, percent: number): Promise<void> {
  current = { level, percent };
  console.warn(
    `step down: ${percent.toFixed(1)}% of frames missed by the graphics card; level ${level} (${rungNames(level)}) on ${deviceKey || 'this device'}`
  );
  await applyLevel(level);
  await remember({ level, percent, clean: 0 });
}

/** Put back a rung whose drops did not fall, say so, and remember the level before it. */
export async function stepBackTo(level: Level, before: number, after: number): Promise<void> {
  current = { level, percent: null };
  console.warn(
    `step down undone: ${after.toFixed(1)}% of frames still missed (was ${before.toFixed(1)}%), so the last rung did not help; back to level ${level} on ${deviceKey || 'this device'}`
  );
  await applyLevel(level);
  await remember({ level, percent: null, clean: 0 });
}

/**
 * A film played clean at the level in force: counted, and after
 * `CLEAN_FILMS` the next film starts one rung up. The film playing keeps its
 * level, so the details panel stays true for it.
 */
export async function recordCleanFilm(): Promise<void> {
  if (remembered.level <= 0 || current.level !== remembered.level) return;
  const next = afterCleanFilm(remembered);
  if (next.level < remembered.level) {
    console.warn(
      `step up: ${CLEAN_FILMS} clean films at level ${remembered.level}; the next film tries level ${next.level} on ${deviceKey || 'this device'}`
    );
  }
  await remember(next);
}

/** What is remembered, for every graphics device this computer has had. */
export async function rememberedStepDowns(): Promise<Record<string, StepState>> {
  return parseMemory(await getSetting(STEP_DOWN_KEY));
}

/**
 * Settings → Advanced: forget every remembered level. The next film starts at
 * level 0; a film playing now keeps what it has. Returns how many devices had
 * one.
 */
export async function forgetStepDown(): Promise<number> {
  const had = Object.keys(await rememberedStepDowns()).length;
  await setSetting(STEP_DOWN_KEY, '{}');
  remembered = { level: 0, percent: null, clean: 0 };
  if (had > 0) console.warn(`step down: forgot the levels of ${had} graphics device(s) (Settings)`);
  return had;
}
