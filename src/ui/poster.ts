/**
 * What a poster says about watching it.
 *
 * Nothing on Home or in a grid used to say whether you had seen something, so
 * picking a film meant opening it to find out. Now: a tick when it is done, a
 * thin bar under a film you are part-way through, and for a show you have
 * started, how many episodes are left.
 */
import type { Title } from './api';

export interface PosterState {
  watched: boolean;
  /** 0–1, for a started film. */
  progress: number | null;
  /** The corner badge text, or null for none. */
  badge: string | null;
}

/** Under this is a stray press, over the upper one is effectively finished. */
const MIN_PROGRESS = 0.01;
const MAX_PROGRESS = 0.94;

export function posterState(title: Title): PosterState {
  if (title.kind === 'series') {
    const owned = title.episodes_owned || title.file_count;
    if (title.watched) return { watched: true, progress: null, badge: null };
    const left = owned - title.episodes_watched;
    const badge = title.episodes_watched > 0 ? `${left} left` : `${owned} ep`;
    return { watched: false, progress: null, badge };
  }
  const p = title.progress;
  const progress =
    !title.watched && p !== null && p >= MIN_PROGRESS && p < MAX_PROGRESS ? p : null;
  return { watched: title.watched, progress, badge: null };
}
