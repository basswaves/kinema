/**
 * Honest buffering (JELLYBEAM.md D): a note only when the film is really
 * waiting for data — mpv's `paused-for-cache`, playback held because the
 * cache ran dry — and in plain words for what it waits on. Never for a
 * start or a seek: mpv refills its cache after one of those as a matter of
 * course, so the note waits WAIT_SHOW_MS before it says anything, and a
 * refill that finishes first is never mentioned.
 */
import { useEffect, useState } from 'react';
import { readProperty } from './engine';

/** How long the film must have been held for data before the note shows. */
export const WAIT_SHOW_MS = 1500;
const POLL_MS = 500;

/** What the file comes from, as far as its path says. */
export function sourceKind(path: string): 'share' | 'stream' | 'drive' {
  if (/^(\\\\|\/\/|smb:|nfs:)/i.test(path)) return 'share';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return 'stream';
  return 'drive';
}

/** "Waiting for the network share — 40 %": what it waits on, and how far the refill is. */
export function waitWords(path: string, percent: number | null): string {
  const what = {
    share: 'Waiting for the network share to send more of the film',
    stream: 'Waiting for the stream to send more of the film',
    drive: 'Waiting for the drive to read more of the film',
  }[sourceKind(path)];
  return percent !== null && percent >= 0 && percent < 100 ? `${what} — ${percent} %` : what;
}

/**
 * The note while the engine is held for data (`waiting`), once that has
 * lasted WAIT_SHOW_MS and the file's first picture is up; null otherwise.
 */
export function useBuffering(waiting: boolean, frameShown: boolean, path: string): string | null {
  const [shown, setShown] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setShown(false);
    setPercent(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!waiting || !frameShown) return;
    let live = true;
    const read = () =>
      void readProperty<number>('cache-buffering-state', 'int64').then((p) => {
        if (live) setPercent(p);
      });
    const show = window.setTimeout(() => {
      setShown(true);
      read();
    }, WAIT_SHOW_MS);
    const poll = window.setInterval(read, POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(show);
      window.clearInterval(poll);
    };
  }, [waiting, frameShown, path]);

  return shown ? waitWords(path, percent) : null;
}
