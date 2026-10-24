/**
 * Whether a stored position is worth going back to.
 *
 * One rule for two places: the player, which opens the file there, and the
 * detail page, which offers "Resume" beside "Play from start". If they
 * disagreed, the page would promise a resume the player did not do.
 */
import type { Progress } from './api';

/** Don't offer to resume a file that barely started. */
export const MIN_RESUME_SECS = 30;
/** Or one that is effectively finished. */
export const RESUME_MAX_FRACTION = 0.94;
/**
 * A watched file stays watched while it is watched again (playback.rs), so a
 * position on one is where a re-watch stopped, which is offered below this
 * share (where it finished is stored as 0). Trakt counts a play from 80 % for
 * the same reason.
 */
export const REWATCH_MAX_FRACTION = 0.8;

export function resumePoint(progress: Progress | null): number | null {
  if (!progress) return null;
  if (
    progress.completed &&
    !(progress.duration_secs && progress.position_secs / progress.duration_secs < REWATCH_MAX_FRACTION)
  ) {
    return null;
  }
  if (progress.position_secs < MIN_RESUME_SECS) return null;
  if (
    progress.duration_secs &&
    progress.position_secs / progress.duration_secs >= RESUME_MAX_FRACTION
  ) {
    return null;
  }
  return progress.position_secs;
}

/**
 * Where to resume as a share of the file, when only the share is known — a
 * resume point from Trakt on a copy never played here. Null whenever
 * `resumePoint` has seconds to offer instead.
 */
export function resumeShare(progress: Progress | null): number | null {
  if (!progress || progress.completed || resumePoint(progress) !== null) return null;
  const share = progress.fraction;
  if (share === null || share === undefined || !(share > 0.005) || share >= RESUME_MAX_FRACTION) {
    return null;
  }
  return share;
}
