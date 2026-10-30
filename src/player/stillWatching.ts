/**
 * "Still watching?" (owner, 2026-10-30; JELLYBEAM.md D): after three episodes
 * in a row that rolled on by themselves with no key, mouse or remote press,
 * the next one is asked for instead of counted down to. Settings → Playback
 * turns it off. Stopping there keeps the episode that finished as watched,
 * and never the next one.
 */
import { getSetting } from '../metadata/api';

export const STILL_WATCHING_KEY = 'still_watching';
/** Episodes rolled on untouched before the next one is asked for. */
export const STILL_WATCHING_AFTER = 3;

/** Episodes started by Up next's countdown since the last press. */
let rolledOn = 0;
/** The next target is the countdown's, not a press's. */
let rolling = false;

/** A key, a mouse button, a wheel or a remote: someone is there. */
export function notePress(): void {
  rolledOn = 0;
}

/** Up next's countdown is starting the next episode by itself. */
export function rollOn(): void {
  rolledOn++;
  rolling = true;
}

/** A file started: by the countdown, it counts; any other way, someone chose it. */
export function targetStarted(): void {
  if (!rolling) rolledOn = 0;
  rolling = false;
}

/** Whether the next episode is asked for rather than counted down to. */
export function shouldAsk(enabled: boolean): boolean {
  return enabled && rolledOn >= STILL_WATCHING_AFTER;
}

/** On unless switched off. */
export async function readStillWatching(): Promise<boolean> {
  return (await getSetting(STILL_WATCHING_KEY).catch(() => null)) !== 'off';
}

/** Every press anywhere in the window, until the returned function is called. */
export function listenForPresses(): () => void {
  const events = ['keydown', 'pointerdown', 'wheel'] as const;
  for (const e of events) window.addEventListener(e, notePress, { capture: true, passive: true });
  return () => {
    for (const e of events) window.removeEventListener(e, notePress, { capture: true });
  };
}
