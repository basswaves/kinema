/**
 * Watching a film for frames the graphics card drops, and stepping down when
 * they come (stepDown.ts says why, what the steps are, and which drops count).
 *
 * mpv is polled, not observed: an observed property has to be registered when
 * mpv starts and one added later silently does nothing (docs/GOTCHAS.md), and
 * these are scalars read a few times a minute. Each film is watched from a
 * short quiet after its first picture for `WATCH_MS`, in windows of
 * `WINDOW_MS`; a window where the card missed too many frames puts one more
 * rung down and the watch carries on, after a short quiet for mpv to rebuild
 * its shaders. A rung that did not help is put back and the watch ends; a film
 * watched through clean counts towards trying the level above.
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
  cleanFilm,
  currentStepDown,
  decide,
  judgeWindow,
  newWatch,
  recordCleanFilm,
  stepBackTo,
  stepDownTo,
  type Rates,
  type Sample,
} from './stepDown';

const count = async (name: string) => (await readProperty<number>(name, 'int64')) ?? 0;

async function sample(session: Session): Promise<Sample> {
  return {
    at: performance.now(),
    pos: await readProperty<number>('time-pos', 'double'),
    dropped: await count('frame-drop-count'),
    decoderDropped: await count('decoder-frame-drop-count'),
    delayed: await count('vo-delayed-frame-count'),
    // Anything but a film playing on: its frames are the moment's, not the card's.
    held:
      session.paused || session.scrubbing || session.waiting || session.ended || !session.open,
  };
}

async function rates(): Promise<Rates> {
  return {
    fps:
      (await readProperty<number>('container-fps', 'double')) ??
      (await readProperty<number>('estimated-vf-fps', 'double')),
    displayFps: await readProperty<number>('display-fps', 'double'),
    hwdec: await readProperty<string>('hwdec-current', 'string'),
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
    // The player is still opening for a moment after the first picture.
    let settleUntil = startedAt + SETTLE_MS;
    let hdr: boolean | null = null;
    let busy = false;
    let watch = newWatch();
    let toldNotGpu = false;

    const id = window.setInterval(() => {
      if (busy || stopped) return;
      if (watch.done || performance.now() - startedAt > WATCH_MS) {
        window.clearInterval(id);
        // Only a film watched to the end of the watch, still open, counts.
        if (!stopped && !watch.done && cleanFilm(watch)) {
          void recordCleanFilm().catch((e) => console.warn('step down: could not count', e));
        }
        return;
      }
      if (performance.now() < settleUntil) return;
      busy = true;
      void (async () => {
        try {
          const now = await sample(sessionRef.current);
          if (stopped) return;
          if (base === null || now.held) {
            base = now.held ? null : now;
            return;
          }
          if (now.at - base.at < WINDOW_MS) return;

          const verdict = judgeWindow(base, now, await rates());
          base = now;
          if (stopped) return;
          if (verdict.kind === 'not-gpu' && !toldNotGpu) {
            toldNotGpu = true;
            console.info(
              `step down: ${verdict.percent.toFixed(1)}% of frames missed, not counted: ${
                verdict.why === 'decoder' ? 'the decoder dropped frames' : 'decoded in software'
              }, which no rung can help`
            );
          }
          if (verdict.kind === 'behind' || verdict.kind === 'fine') {
            hdr ??= isHdr(await readProperty<string>('video-params/gamma', 'string'));
          }
          if (stopped) return;
          const { watch: next, action } = decide(watch, verdict, currentStepDown().level, hdr ?? false);
          watch = next;
          if (action.kind === 'down') await stepDownTo(action.to, action.percent);
          else if (action.kind === 'undo') await stepBackTo(action.to, action.before, action.after);
          else return;
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
