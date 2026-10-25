/**
 * Sound delay, per sound device (PLAN phase 2).
 *
 * Equipment, not taste: a receiver that decodes Atmos, or a TV that works on
 * the picture, adds its own delay, and the sound and the lips drift apart by
 * the same amount on every film. Nothing Kinema can read says by how much, so
 * it is asked — in steps of 10 ms, from the player (keys, remote, mouse) and
 * from Settings — and kept **per device**, by the same endpoint id the
 * per-device policies use (`devicePolicy.ts`): headphones on the desk and the
 * receiver in the living room want different amounts.
 *
 * mpv's `audio-delay` is a plain runtime property: set as each file starts
 * and whenever it is changed, nothing to restart. Desktop only: on Android
 * Media3 plays the sound, and this does not reach it (said in Settings).
 */
import { getSetting, setSetting } from '../metadata/api';
import { hasMpv, mpvCommand } from './engine';

/** Where the delays live: one JSON object, milliseconds by device id. */
export const AUDIO_DELAY_KEY = 'audio_delay';
/**
 * The key for sound with no known device — the sound server picks (Linux),
 * or a fallback is playing. One shared entry, as `subtitleStyle.ts` does.
 */
export const UNKNOWN_DEVICE = '*';
export const DELAY_STEP_MS = 10;
/** Far beyond any receiver's; a stray held key stops here. */
export const MAX_DELAY_MS = 2000;

type Delays = Record<string, number>;

const clamp = (ms: number) =>
  Math.max(-MAX_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(ms / DELAY_STEP_MS) * DELAY_STEP_MS));

/** The stored delays; anything damaged is left out, which is no delay. */
export function parseDelays(value: string | null): Delays {
  const out: Delays = {};
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v !== 0) out[key] = clamp(v);
      }
    }
  } catch {
    // Damaged: no delay anywhere.
  }
  return out;
}

const keyOf = (deviceId: string | null) => deviceId ?? UNKNOWN_DEVICE;

export async function readDelay(deviceId: string | null): Promise<number> {
  return parseDelays(await getSetting(AUDIO_DELAY_KEY).catch(() => null))[keyOf(deviceId)] ?? 0;
}

export async function saveDelay(deviceId: string | null, ms: number): Promise<number> {
  const delays = parseDelays(await getSetting(AUDIO_DELAY_KEY).catch(() => null));
  const next = clamp(ms);
  if (next === 0) delete delays[keyOf(deviceId)];
  else delays[keyOf(deviceId)] = next;
  await setSetting(AUDIO_DELAY_KEY, JSON.stringify(delays));
  return next;
}

/**
 * The delay in words. mpv's sign: positive plays the sound later (for a
 * picture that arrives late), negative earlier (for a receiver that is slow).
 */
export function describeDelay(ms: number): string {
  if (ms === 0) return 'Sound in step, no delay';
  return ms > 0 ? `Sound delayed by ${ms} ms` : `Sound ${-ms} ms earlier`;
}

/** The delay as the controls show it: "+40 ms", "−20 ms", "0 ms". */
export const delayLabel = (ms: number) =>
  ms > 0 ? `+${ms} ms` : ms < 0 ? `−${-ms} ms` : '0 ms';

/** The device the delay now applied is kept for, and the amount. */
let applied: { deviceId: string | null; ms: number } = { deviceId: null, ms: 0 };
export const appliedDelay = () => applied;

/** Tell mpv. A refusal costs only the delay, said in the log. */
async function setMpv(ms: number): Promise<void> {
  if (!hasMpv()) return;
  try {
    await mpvCommand('set', ['audio-delay', (ms / 1000).toFixed(3)]);
  } catch (e) {
    console.warn(`audio: mpv refused audio-delay=${ms} ms`, e);
  }
}

/** As each file starts: the delay kept for the device the sound goes to. */
export async function applyAudioDelay(deviceId: string | null): Promise<number> {
  const ms = await readDelay(deviceId);
  if (ms !== applied.ms || deviceId !== applied.deviceId)
    console.log(`audio: ${describeDelay(ms).toLowerCase()} for ${deviceId ?? 'the default sound'}`);
  applied = { deviceId, ms };
  await setMpv(ms);
  return ms;
}

/** Saves one after another, so the last press is the one kept. */
let saving: Promise<unknown> = Promise.resolve();

/**
 * From the player: a step later or earlier (`delta` in ms), or 0 with `reset`.
 * The amount moves on the press, before the save: a held key repeats faster
 * than the setting is written, and every repeat must count.
 */
export async function changeAudioDelay(delta: number, reset = false): Promise<number> {
  const { deviceId, ms } = applied;
  const next = clamp(reset ? 0 : ms + delta);
  applied = { deviceId, ms: next };
  const saved = saving.then(() => saveDelay(deviceId, next));
  saving = saved.catch(() => undefined);
  await setMpv(next);
  await saved;
  return next;
}
