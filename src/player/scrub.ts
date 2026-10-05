/**
 * Seeking with Left/Right the way a streaming app does it.
 *
 * One press is ten seconds. Holding the key, or tapping it again quickly, goes
 * further each time — so getting an hour into a film is a few seconds of
 * holding rather than 360 presses, while one tap is still the fine control.
 *
 * Nothing seeks while the key is moving: the target moves on the seek bar, and
 * the player is asked once — when a held key is let go, or half a second after
 * the last of a run of taps (useScrub.ts). A seek per key repeat would be
 * thirty seeks a second into a 4K remux, each one decoding from the nearest
 * keyframe for a frame nobody sees.
 *
 * Pure, so the acceleration can be tested without a player.
 */

/** A seek in progress: where it is heading, and how it got there. */
export interface Scrub {
  target: number;
  dir: 1 | -1;
  /** When this run of presses began (ms). */
  startedAt: number;
  /** When the last press or repeat arrived (ms). */
  lastAt: number;
  /** Separate presses in this run, for a remote that repeats by re-sending. */
  taps: number;
}

/** A press this long after the last one starts a new seek rather than extending it. */
export const CHAIN_MS = 700;
/** With no press for this long, the seek is committed even without a key release. */
export const COMMIT_IDLE_MS = 500;

const FIRST_STEP_SECS = 10;

/** Seconds per tap, by how many taps the run has had. */
function tapStep(taps: number): number {
  if (taps <= 4) return 10;
  if (taps <= 8) return 30;
  return 60;
}

/** Seconds of video per second held, by how long the key has been down. */
function holdRate(heldSecs: number): number {
  if (heldSecs < 2) return 20;
  if (heldSecs < 4) return 90;
  if (heldSecs < 7) return 300;
  return 900;
}

/**
 * The key's own repeats arrive every ~33 ms, but the first comes after the
 * keyboard's repeat delay, around half a second. Measuring each step from the
 * previous event, capped, keeps that pause from turning into a jump.
 */
const MAX_REPEAT_GAP_MS = 150;

function clamp(value: number, duration: number | null): number {
  const end = duration && duration > 1 ? duration - 1 : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(0, value), end);
}

/**
 * Advance a seek by one key event.
 *
 * `repeat` is true for the key's own auto-repeat while held. `position` is
 * where playback is, used only when this press starts a new seek.
 */
export function scrubStep(
  prev: Scrub | null,
  now: number,
  dir: 1 | -1,
  repeat: boolean,
  position: number,
  duration: number | null
): Scrub {
  const continues = prev !== null && prev.dir === dir && now - prev.lastAt <= CHAIN_MS;

  if (!continues) {
    return {
      target: clamp(position + dir * FIRST_STEP_SECS, duration),
      dir,
      startedAt: now,
      lastAt: now,
      taps: 1,
    };
  }

  if (repeat) {
    const gap = Math.min(now - prev.lastAt, MAX_REPEAT_GAP_MS) / 1000;
    const held = (now - prev.startedAt) / 1000;
    return {
      ...prev,
      target: clamp(prev.target + dir * holdRate(held) * gap, duration),
      lastAt: now,
    };
  }

  const taps = prev.taps + 1;
  return {
    ...prev,
    target: clamp(prev.target + dir * tapStep(taps), duration),
    lastAt: now,
    taps,
  };
}
