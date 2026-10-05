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
 * Nothing here is observed from the engine. Only this app changes the volume,
 * so the state it sets is the state there is — and an observed mpv property
 * would only start arriving after a full restart (docs/GOTCHAS.md). Setting it
 * is the engine's (engine.ts `setVolume`, `setMuted`).
 */
import { getSetting, setSetting } from '../metadata/api';

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

export async function persistVolume(level: number): Promise<void> {
  await setSetting(VOLUME_KEY, String(level));
}
