/**
 * The episodes either side of the one playing, for the previous/next buttons,
 * `n` and `p`, and whether there is anything for Up next to offer; and for a
 * video played from outside the library, the files either side in its folder.
 */
import { useEffect, useState } from 'react';
import { folderNeighbours, nextEpisode, previousEpisode, type EpisodeRef } from './api';

/** Where previous or next goes: an episode, or a file in the same folder. */
export interface Step {
  kind: 'episode' | 'file';
  name: string;
  play: () => void;
}

export interface Steps {
  prev: Step | null;
  next: Step | null;
}

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

/**
 * The video files either side of `path` in its own folder, in the order a
 * file manager lists them; `null` for a library file, which has episodes
 * instead. Cleared on every change of file, as above.
 */
export function useFolderNeighbours(path: string | null) {
  const [files, setFiles] = useState<{ prev: string | null; next: string | null }>({
    prev: null,
    next: null,
  });

  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setFiles({ prev: null, next: null });
    if (path === null) return;

    let cancelled = false;
    void folderNeighbours(path)
      .then((found) => {
        if (!cancelled) setFiles(found);
      })
      .catch((e) => console.warn('files beside the video unavailable', e));

    return () => {
      cancelled = true;
    };
  }, [path]);

  return files;
}
