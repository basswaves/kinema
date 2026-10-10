/**
 * Watching a film for dropped frames, and stepping down when they come
 * (stepDown.ts says why, and what the steps are).
 *
 * mpv is polled, not observed: an observed property has to be registered when
 * mpv starts and one added later silently does nothing (docs/GOTCHAS.md), and
 * these are scalars read a few times a minute. Each film is watched from its
 * first picture for `WATCH_MS`, in windows of `WINDOW_MS`; a window that
 * missed too many frames puts one more rung down and the watch carries on,
 * after a short quiet for mpv to rebuild its shaders.
 *
 * Nothing here runs where Media3 plays.
 */
import { useEffect, type RefObject } from 'react';
import { hasMpv, readProperty } from './engine';
import type { Session } from './session';
import { isHdr } from './stats';
import {
  SAMPLE_MS,
  SETTLE_MS,
  WATCH_MS,
  WINDOW_MS,
  currentStepDown,
  judgeWindow,
  nextLevel,
  stepDownTo,
  type Sample,
} from './stepDown';

async function sample(session: Session, scrubbing: boolean): Promise<Sample> {
  return {
    at: performance.now(),
    pos: await readProperty<number>('time-pos', 'double'),
    dropped: (await readProperty<number>('frame-drop-count', 'int64')) ?? 0,
    delayed: (await readProperty<number>('vo-delayed-frame-count', 'int64')) ?? 0,
    held: session.paused || scrubbing,
  };
}

export function useStepDown({
  sessionRef,
  seq,
  watching,
}: {
  sessionRef: RefObject<Session>;
  /** Bumped on every new film, so each is watched afresh. */
  seq: number;
  /** The film is open and its first picture is up. */
  watching: boolean;
}) {
  useEffect(() => {
    if (!hasMpv() || !watching) return;
    let stopped = false;
    const startedAt = performance.now();
    /** The start of the window being measured; null while settling. */
    let base: Sample | null = null;
    let settleUntil = startedAt;
    let hdr: boolean | null = null;
    let busy = false;

    const id = window.setInterval(() => {
      if (busy || stopped) return;
      if (performance.now() - startedAt > WATCH_MS) {
        window.clearInterval(id);
        return;
      }
      if (performance.now() < settleUntil) return;
      busy = true;
      void (async () => {
        try {
          const s = sessionRef.current;
          const now = await sample(s, s.scrubbing);
          if (stopped) return;
          if (base === null || now.held) {
            base = now.held ? null : now;
            return;
          }
          if (now.at - base.at < WINDOW_MS) return;

          const fps =
            (await readProperty<number>('container-fps', 'double')) ??
            (await readProperty<number>('estimated-vf-fps', 'double'));
          const verdict = judgeWindow(base, now, fps);
          base = now;
          if (verdict.kind !== 'behind') return;

          hdr ??= isHdr(await readProperty<string>('video-params/gamma', 'string'));
          const next = nextLevel(currentStepDown().level, hdr);
          if (next === null) {
            // Everything that could be given up has been: nothing left to do.
            window.clearInterval(id);
            return;
          }
          await stepDownTo(next, verdict.percent);
          base = null;
          settleUntil = performance.now() + SETTLE_MS;
        } catch (e) {
          console.warn('step down: could not measure', e);
        } finally {
          busy = false;
        }
      })();
    }, SAMPLE_MS);

    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [sessionRef, seq, watching]);
}
