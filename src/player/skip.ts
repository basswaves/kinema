/**
 * Intro/credits skip logic, kept out of the player component so it stays
 * testable by reading rather than by watching an episode.
 *
 * Markers come from a `.skiptro.json` sidecar produced separately; nothing here
 * detects anything. See `src-tauri/src/skip.rs`.
 */
import type { SkipMarkers } from './api';

export type SkipKind = 'intro' | 'credits';

export interface ActiveSkip {
  kind: SkipKind;
  /** Where "skip" should land, for an intro. */
  seekTo: number;
  /**
   * Identifies this segment occurrence. Used to dismiss a prompt once and to
   * act on a segment once — both need to survive the position changing every
   * second while staying inside the same segment.
   */
  key: string;
}

/**
 * Skipping less than this is not worth a button: the seek costs about as much
 * as watching it, and the prompt would appear just as it becomes pointless.
 */
const MIN_WORTH_SKIPPING_SECS = 3;

/** Which segment, if any, the current position falls inside. */
export function activeSkip(
  markers: SkipMarkers | null,
  timePos: number | null
): ActiveSkip | null {
  if (!markers || timePos === null) return null;

  const { intro, credits } = markers;

  if (
    intro &&
    timePos >= intro.start &&
    timePos < intro.end - MIN_WORTH_SKIPPING_SECS
  ) {
    return { kind: 'intro', seekTo: intro.end, key: `intro:${intro.start}` };
  }

  // Credits run to the end of the file, so only the start matters — there is
  // nothing after them to seek to.
  if (credits && timePos >= credits.start) {
    return { kind: 'credits', seekTo: credits.start, key: `credits:${credits.start}` };
  }

  return null;
}

/** Whether markers are worth acting on at all. */
export function hasAnyMarkers(markers: SkipMarkers | null): boolean {
  return Boolean(markers && (markers.intro || markers.credits));
}
