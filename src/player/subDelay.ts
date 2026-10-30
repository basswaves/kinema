/**
 * Subtitle timing, per file (PLAN phase 2, AFTER-0.10.0 "Subtitle timing").
 *
 * A subtitle made for another release of the film — another cut, another
 * intro — comes early or late by the same amount all through. Nothing Kinema
 * reads says by how much, so it is asked: earlier or later in steps of 0.1 s
 * and 0.5 s, from the player (keys, remote, mouse), and kept **per file**:
 * the next film's subtitles are timed differently. Moved by mpv's
 * `sub-delay`, a plain runtime property that mpv keeps from one file to the
 * next — so it is put on as every file starts, 0 included.
 *
 * Desktop only: Media3 has no subtitle offset (Android, later). Finding the
 * amount by itself from the speech is the automatic half, not built yet.
 */
import { getSetting, setSetting } from '../metadata/api';
import { hasMpv, mpvCommand } from './engine';

/** Where the amounts live: one JSON object, milliseconds by file path. */
export const SUB_DELAY_KEY = 'subtitle_delay';
export const SUB_STEP_MS = 100;
export const SUB_BIG_STEP_MS = 500;
/** Ten minutes: past any intro or cut; a held key stops here. */
export const MAX_SUB_DELAY_MS = 600_000;
/** The files remembered; the oldest go first, so the setting stays small. */
export const MAX_FILES = 500;

type Delays = Record<string, number>;

const clamp = (ms: number) =>
  Math.max(
    -MAX_SUB_DELAY_MS,
    Math.min(MAX_SUB_DELAY_MS, Math.round(ms / SUB_STEP_MS) * SUB_STEP_MS)
  );

/** The stored amounts; anything damaged is left out, which is no delay. */
export function parseSubDelays(value: string | null): Delays {
  const out: Delays = {};
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && clamp(v) !== 0) out[key] = clamp(v);
      }
    }
  } catch {
    // Damaged: every file as it is.
  }
  return out;
}

/** The amounts with this file's set (last, as the newest), 0 removing it. */
export function withSubDelay(delays: Delays, path: string, ms: number): Delays {
  const next = { ...delays };
  delete next[path];
  if (ms !== 0) next[path] = ms;
  const paths = Object.keys(next);
  for (const old of paths.slice(0, Math.max(0, paths.length - MAX_FILES))) delete next[old];
  return next;
}

/** The amount as the controls show it: "+0.5 s", "−2.3 s", "0 s". */
export function subDelayLabel(ms: number): string {
  const s = (Math.abs(ms) / 1000).toFixed(1).replace(/\.0$/, '');
  return ms > 0 ? `+${s} s` : ms < 0 ? `−${s} s` : '0 s';
}

/** In words. mpv's sign: positive shows the subtitles later. */
export function describeSubDelay(ms: number): string {
  if (ms === 0) return 'Subtitles at their own timing';
  const s = (Math.abs(ms) / 1000).toFixed(1).replace(/\.0$/, '');
  return ms > 0 ? `Subtitles ${s} s later` : `Subtitles ${s} s earlier`;
}

/** The file the amount now applied belongs to, and the amount. */
let applied: { path: string | null; ms: number } = { path: null, ms: 0 };
export const appliedSubDelay = () => applied;

/** Tell mpv. A refusal costs only the timing, said in the log. */
async function setMpv(ms: number): Promise<void> {
  if (!hasMpv()) return;
  try {
    await mpvCommand('set', ['sub-delay', (ms / 1000).toFixed(3)]);
  } catch (e) {
    console.warn(`subtitles: mpv refused sub-delay=${ms} ms`, e);
  }
}

/** As each file starts: the amount kept for it, or none. */
export async function applySubDelay(path: string): Promise<number> {
  const ms = parseSubDelays(await getSetting(SUB_DELAY_KEY).catch(() => null))[path] ?? 0;
  if (ms !== 0) console.log(`subtitles: ${describeSubDelay(ms).toLowerCase()}, kept for this file`);
  applied = { path, ms };
  await setMpv(ms);
  return ms;
}

/** Saves one after another, so the last press is the one kept. */
let saving: Promise<unknown> = Promise.resolve();

/**
 * From the player: a step (`delta` in ms), or 0 with `reset`. The amount
 * moves on the press, before the save, so every repeat of a held key counts.
 */
export async function changeSubDelay(delta: number, reset = false): Promise<number> {
  const { path, ms } = applied;
  const next = clamp(reset ? 0 : ms + delta);
  applied = { path, ms: next };
  await setMpv(next);
  if (path === null) return next;
  const saved = saving.then(async () => {
    const delays = parseSubDelays(await getSetting(SUB_DELAY_KEY).catch(() => null));
    await setSetting(SUB_DELAY_KEY, JSON.stringify(withSubDelay(delays, path, next)));
  });
  saving = saved.catch(() => undefined);
  await saved;
  return next;
}
