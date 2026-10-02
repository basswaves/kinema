/**
 * Keeping the resume point current: every few seconds while a file plays, and
 * once more as the player leaves it.
 */
import { useEffect, type RefObject } from 'react';
import { saveProgress } from './api';
import type { Session } from './session';

const PROGRESS_SAVE_MS = 5000;

export function useProgressSave({
  fileId,
  sessionRef,
  countedCreditsStart,
}: {
  /** The library's file, or null for something that is not in it. */
  fileId: number | null;
  sessionRef: RefObject<Session>;
  /** Where the credits start, when that counts as watched (useSkipMarkers). */
  countedCreditsStart: RefObject<number | null>;
}) {
  // ---- persist progress ---------------------------------------------------
  useEffect(() => {
    if (fileId === null) return;

    // Only a file that is open has a position of its own worth saving.
    const current = () => {
      const { open, timePos: position, duration: total } = sessionRef.current;
      return {
        position: open ? (position ?? 0) : 0,
        total,
        creditsStart: countedCreditsStart.current,
      };
    };

    const id = window.setInterval(() => {
      const { position, total, creditsStart } = current();
      if (position > 0) {
        void saveProgress(fileId, position, total, creditsStart).catch(() => undefined);
      }
    }, PROGRESS_SAVE_MS);

    return () => {
      window.clearInterval(id);
      // Reading the ref's *latest* value at cleanup is the point here: the
      // session has not been reset for the next file yet, so this is still the
      // outgoing file's position. Copying it into the effect would be stale.
      const { position, total, creditsStart } = current();
      if (position > 0) {
        void saveProgress(fileId, position, total, creditsStart).catch(() => undefined);
      }
    };
  }, [fileId, sessionRef, countedCreditsStart]);
}
