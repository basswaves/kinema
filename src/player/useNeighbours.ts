/**
 * The episodes either side of the one playing, for the previous/next buttons,
 * `n` and `p`, and whether there is anything for Up next to offer.
 */
import { useEffect, useState } from 'react';
import { nextEpisode, previousEpisode, type EpisodeRef } from './api';

export function useNeighbours(fileId: number | null) {
  /** The episodes either side of this file, or null where there is none. */
  const [neighbours, setNeighbours] = useState<{
    prev: EpisodeRef | null;
    next: EpisodeRef | null;
  }>({ prev: null, next: null });

  /**
   * What is either side of this episode.
   *
   * Fetched once per file rather than on demand, because it decides whether the
   * previous/next buttons are drawn at all — a button that appears and then
   * turns out to lead nowhere is worse than one that was never offered.
   */
  useEffect(() => {
    // Cleared first: until the answer for *this* file arrives, the previous
    // file's neighbours are wrong, and a button that jumps somewhere unrelated
    // is worse than one that appears a moment late.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setNeighbours({ prev: null, next: null });
    if (fileId === null) return;

    let cancelled = false;
    void Promise.all([previousEpisode(fileId), nextEpisode(fileId)])
      .then(([prev, next]) => {
        if (!cancelled) setNeighbours({ prev, next });
      })
      .catch((e) => console.warn('neighbouring episodes unavailable', e));

    return () => {
      cancelled = true;
    };
  }, [fileId]);

  return neighbours;
}
