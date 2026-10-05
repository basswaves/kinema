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
 */
import { useCallback, useEffect, useRef, type Dispatch, type RefObject } from 'react';
import { seekTo } from './engine';
import { COMMIT_IDLE_MS, scrubStep, type Scrub } from './scrub';
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
      if (!scrubRef.current) {
        dispatch({ type: 'scrub-start' });
        held.current = false;
      }
      if (repeat) held.current = true;
      const next = scrubStep(
        scrubRef.current ?? lastScrub.current,
        performance.now(),
        dir,
        repeat,
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

  /** The key let go: the seek now after a hold; after a tap, when presses stop. */
  const releaseScrub = useCallback(() => {
    if (held.current) commitScrub();
  }, [commitScrub]);

  useEffect(() => () => window.clearTimeout(scrubTimer.current), []);

  return { scrubBy, releaseScrub };
}
