/**
 * Keeping the resume point current: every few seconds while a file plays, and
 * once more as the player leaves it.
 */
import { useEffect, type RefObject } from 'react';
import { saveLooseProgress, saveProgress } from './api';
import { createSaveWatch } from './progressFailure';
import type { Session } from './session';

const PROGRESS_SAVE_MS = 5000;

export function useProgressSave({
  fileId,
  path,
  byPath,
  sessionRef,
  countedCreditsStart,
  say,
}: {
  /** The library's file, or null for something that is not in it. */
  fileId: number | null;
  /** The file itself: what a video outside the library is kept by. */
  path: string;
  /** Kept by path when not in the library (opened.ts); else not kept. */
  byPath: boolean;
  sessionRef: RefObject<Session>;
  /** Where the credits start, when that counts as watched (useSkipMarkers). */
  countedCreditsStart: RefObject<number | null>;
  /** Where a notice goes, when the resume point cannot be kept. */
  say: (text: string) => void;
}) {
  // ---- persist progress ---------------------------------------------------
  useEffect(() => {
    if (fileId === null && !byPath) return;
    // Not in the library: kept by path and size instead (opened.rs).
    const save = (
      position: number,
      total: number | null,
      creditsStart: number | null,
      leaving = false
    ) =>
      fileId !== null
        ? saveProgress(fileId, position, total, creditsStart, leaving)
        : saveLooseProgress(path, position, total);

    // Only a file that is open has a position of its own worth saving.
    const current = () => {
      const { open, timePos: position, duration: total } = sessionRef.current;
      return {
        position: open ? (position ?? 0) : 0,
        total,
        creditsStart: countedCreditsStart.current,
      };
    };

    const watch = createSaveWatch(say, (text, error) => console.warn(text, error ?? ''));

    const id = window.setInterval(() => {
      const { position, total, creditsStart } = current();
      if (position > 0) {
        save(position, total, creditsStart).then(watch.saved, watch.failed);
      }
    }, PROGRESS_SAVE_MS);

    return () => {
      window.clearInterval(id);
      // Reading the ref's *latest* value at cleanup is the point here: the
      // session has not been reset for the next file yet, so this is still the
      // outgoing file's position. Copying it into the effect would be stale.
      const { position, total, creditsStart } = current();
      if (position > 0) {
        // Leaving: nobody is there to read a notice, so the log only.
        save(position, total, creditsStart, true).catch((e) =>
          console.warn('progress: could not save the resume point on leaving', e)
        );
      }
    };
  }, [fileId, path, byPath, sessionRef, countedCreditsStart, say]);
}
