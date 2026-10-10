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
 * Remembered per device (`rememberedLevel`): the graphics card and the
 * graphics interface, so the same PC starts the next film at the level it
 * needed, instead of dropping frames for ten seconds each time to find out.
 * It does **not** step back up by itself. A film that plays clean at a level
 * says nothing about whether the level above would have — only trying it
 * would, and trying it is exactly the dropped frames this exists to avoid.
 * (Settings has no reset: the section that would hold it is read-only.)
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
 * frames that rebuild delays say nothing about the new level.
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
  /** `frame-drop-count`: frames the video output dropped. */
  dropped: number;
  /** `vo-delayed-frame-count`: frames it showed late. */
  delayed: number;
  /** Paused, or being scrubbed, at that moment. */
  held: boolean;
}

export type Verdict = { kind: 'skip' } | { kind: 'fine' | 'behind'; percent: number };

/**
 * Whether the frames of the window from `start` to `end` were missed because
 * the card fell behind.
 *
 * A window is thrown away (`skip`) when something else could have cost the
 * frames: paused at either end; the counters going backwards (a new file); or
 * the film's position not having moved by as much as the clock did, which is
 * a seek, a pause and resume, a stall for the cache, or a changed speed.
 * Seeks and the display switching leave frames behind that are nobody's fault
 * but the moment's, and stepping down for them would punish a card that keeps
 * up. `fps` is the film's frame rate; without one, 24.
 */
export function judgeWindow(start: Sample, end: Sample, fps: number | null): Verdict {
  if (start.held || end.held || start.pos === null || end.pos === null) return { kind: 'skip' };
  const elapsed = (end.at - start.at) / 1000;
  const played = end.pos - start.pos;
  if (elapsed <= 0 || end.dropped < start.dropped || end.delayed < start.delayed) {
    return { kind: 'skip' };
  }
  if (Math.abs(played - elapsed) > Math.max(1, elapsed * 0.15)) return { kind: 'skip' };

  const missed = end.dropped - start.dropped + (end.delayed - start.delayed);
  const frames = (fps !== null && fps > 0 ? fps : 24) * played;
  const percent = Math.min(100, (100 * missed) / Math.max(1, frames));
  return {
    kind: missed >= BEHIND_MIN_FRAMES && percent > BEHIND_PERCENT ? 'behind' : 'fine',
    percent,
  };
}

// ---- what is in force, and what is remembered -------------------------------

let current: StepState = { level: 0, percent: null };
/** The level mpv has actually been given; 0 until something is applied. */
let applied: Level = 0;
let loading: Promise<void> | null = null;
let deviceKey = '';

/** Where the ladder stands for the film now playing. */
export const currentStepDown = (): StepState => current;

/** Settings key: the remembered levels, as JSON `{ "<device>": { level, percent } }`. */
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
      const e = entry as { level?: unknown; percent?: unknown } | null;
      const level = e && typeof e.level === 'number' ? Math.trunc(e.level) : NaN;
      if (!Number.isFinite(level) || level < 1 || level > STEPS.length) continue;
      out[key] = {
        level,
        percent: typeof e?.percent === 'number' && Number.isFinite(e.percent) ? e.percent : null,
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

/**
 * Put this device's remembered level on mpv before a film shows. Reads the
 * memory once per run; after that the level in force is the one in memory
 * here. Never throws: no memory is level 0.
 */
export function applyRememberedStepDown(): Promise<void> {
  loading ??= (async () => {
    try {
      deviceKey = await thisDevice();
      const found = parseMemory(await getSetting(STEP_DOWN_KEY))[deviceKey];
      if (found) current = found;
    } catch (e) {
      console.warn('step down: could not read what was remembered', e);
    }
  })();
  return loading.then(() => applyLevel(current.level)).catch(() => undefined);
}

/** Take the next rung down, say so in the log, and remember it. */
export async function stepDownTo(level: Level, percent: number): Promise<void> {
  current = { level, percent };
  const names = STEPS.slice(0, level).map((s) => s.label).join('; ');
  console.warn(
    `step down: ${percent.toFixed(1)}% of frames missed; level ${level} (${names}) on ${deviceKey || 'this device'}`
  );
  await applyLevel(level);
  try {
    const memory = parseMemory(await getSetting(STEP_DOWN_KEY));
    memory[deviceKey] = current;
    await setSetting(STEP_DOWN_KEY, JSON.stringify(memory));
  } catch (e) {
    console.warn('step down: could not remember the level', e);
  }
}
