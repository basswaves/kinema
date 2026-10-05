/**
 * Seeking with Left/Right: an accelerating seek steered on the bar while the
 * key is held, sent to the player when it is let go — or when presses stop,
 * for a remote that never sends a release. See scrub.ts for the steps.
 *
 * Letting go sends the seek only after a hold. After a tap it waits for the
 * presses to stop: a remote that sends a press and a release for every step
 * of a hold, as an Android box's did, made 13 seeks in 1.3 seconds, each one
 * re-opening the film, refilling and restarting the decoder — pauses on a
 * weak box, and wasted work everywhere. Now a run of taps is one seek, half
 * a second after the last.
 *
 * A hold is told from taps here, not by the key event's own `repeat` alone.
 * Android's WebView marks none of a held key's repeats as repeats, and a
 * remote may send a press and a release for every step of a hold: either
 * way every step looked like a tap, taps speed up the most, and two seconds
 * of holding Right went to the end of the film (measured on a box,
 * 2026-10-05). A press while the key is still down, or hard on the heels of
 * the last one, is the key held.
 */
import { useCallback, useEffect, useRef, type Dispatch, type RefObject } from 'react';
import { seekTo } from './engine';
import {
  CHAIN_MS,
  COMMIT_IDLE_MS,
  HOLD_GAP_MS,
  RELEASE_GRACE_MS,
  scrubStep,
  type Scrub,
} from './scrub';
import type { Event, Session } from './session';

export function useScrub({
  sessionRef,
  dispatch,
  fail,
  showOsd,
}: {
  sessionRef: RefObject<Session>;
  dispatch: Dispatch<Event>;
  fail: (e: unknown) => void;
  showOsd: () => void;
}) {
  /** The seek being steered right now, shown on the bar until committed. */
  const scrubRef = useRef<Scrub | null>(null);
  /** The last committed one, so quick taps keep accelerating across commits. */
  const lastScrub = useRef<Scrub | null>(null);
  const scrubTimer = useRef<number | undefined>(undefined);
  /** Whether the seek being steered had the key's own repeats: held, not tapped. */
  const held = useRef(false);
  /** When the last press arrived, and whether its key has been let go since. */
  const lastPressAt = useRef(Number.NEGATIVE_INFINITY);
  const keyDown = useRef(false);

  /** Send the seek to mpv. Called on key release, or when presses stop. */
  const commitScrub = useCallback(() => {
    window.clearTimeout(scrubTimer.current);
    const s = scrubRef.current;
    if (!s) return;
    scrubRef.current = null;
    lastScrub.current = s;
    dispatch({ type: 'scrub-end' });
    void seekTo(s.target).catch(fail);
    showOsd();
  }, [dispatch, fail, showOsd]);

  const scrubBy = useCallback(
    (dir: 1 | -1, repeat: boolean) => {
      const { timePos: position, duration: length } = sessionRef.current;
      const now = performance.now();
      const since = now - lastPressAt.current;
      // A release missed (the ring moved between the two key handlers) must
      // not make every later press a hold: a key still down is believed
      // only while the presses keep coming.
      const isHold = repeat || (keyDown.current && since <= CHAIN_MS) || since < HOLD_GAP_MS;
      lastPressAt.current = now;
      keyDown.current = true;
      if (!scrubRef.current) {
        dispatch({ type: 'scrub-start' });
        held.current = false;
      }
      if (isHold) held.current = true;
      const next = scrubStep(
        scrubRef.current ?? lastScrub.current,
        now,
        dir,
        isHold,
        position ?? 0,
        length
      );
      scrubRef.current = next;
      dispatch({ type: 'scrub', timePos: next.target });
      showOsd();
      // A remote that never sends a key release still gets its seek.
      window.clearTimeout(scrubTimer.current);
      scrubTimer.current = window.setTimeout(commitScrub, COMMIT_IDLE_MS);
    },
    [sessionRef, dispatch, commitScrub, showOsd]
  );

  /**
   * The key let go: after a hold the seek goes in a moment, unless the next
   * step of the hold comes first; after a tap, when presses stop.
   */
  const releaseScrub = useCallback(() => {
    keyDown.current = false;
    if (!held.current || !scrubRef.current) return;
    window.clearTimeout(scrubTimer.current);
    scrubTimer.current = window.setTimeout(commitScrub, RELEASE_GRACE_MS);
  }, [commitScrub]);

  useEffect(() => () => window.clearTimeout(scrubTimer.current), []);

  return { scrubBy, releaseScrub };
}
