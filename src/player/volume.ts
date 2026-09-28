/**
 * Volume and mute.
 *
 * There was none: the app assumed a receiver or the Windows mixer would do it,
 * which holds on a sofa and fails the first time someone on a laptop reaches
 * for a slider that is not there.
 *
 * The level is remembered across launches (settings key `volume`), because
 * a volume that resets to full every time the app opens is its own complaint.
 * Mute is not: coming back to a silent film you have forgotten muting is worse.
 *
 * Nothing here is observed from mpv. Only this app changes the volume, so the
 * state it sets is the state there is — and an observed property would only
 * start arriving after a full restart (docs/GOTCHAS.md).
 */
import { command } from 'tauri-plugin-libmpv-api';
import { getSetting, setSetting } from '../metadata/api';
import { readProperty } from './property';

export const VOLUME_KEY = 'volume';
export const VOLUME_STEP = 5;
const DEFAULT_VOLUME = 100;

/** Clamp to what the control offers: 0–100 in steps. */
export function clampVolume(value: number): number {
  const stepped = Math.round(value / VOLUME_STEP) * VOLUME_STEP;
  return Math.min(100, Math.max(0, stepped));
}

export async function savedVolume(): Promise<number> {
  const raw = await getSetting(VOLUME_KEY).catch(() => null);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? clampVolume(parsed) : DEFAULT_VOLUME;
}

/**
 * Through `set` rather than `setProperty`: the command takes a string and lets
 * mpv parse it, which sidesteps the typed-number trouble some properties have
 * with the plugin (docs/GOTCHAS.md, `sid` / `aid`).
 */
export async function applyVolume(level: number): Promise<void> {
  await command('set', ['volume', String(level)]);
}

export async function persistVolume(level: number): Promise<void> {
  await setSetting(VOLUME_KEY, String(level));
}

export async function applyMute(muted: boolean): Promise<void> {
  await command('set', ['mute', muted ? 'yes' : 'no']);
}

/**
 * Whether the sound is going to the receiver as an untouched bitstream, where
 * this app's volume does nothing — the receiver's own control is the one.
 */
export async function bitstreaming(): Promise<boolean> {
  const format = await readProperty<string>('audio-out-params/format', 'string');
  return format?.startsWith('spdif-') ?? false;
}
