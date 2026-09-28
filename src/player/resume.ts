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

export function resumePoint(progress: Progress | null): number | null {
  if (!progress || progress.completed) return null;
  if (progress.position_secs < MIN_RESUME_SECS) return null;
  if (
    progress.duration_secs &&
    progress.position_secs / progress.duration_secs >= RESUME_MAX_FRACTION
  ) {
    return null;
  }
  return progress.position_secs;
}
