/**
 * Intro/credits skip logic, kept out of the player component so it stays
 * testable by reading rather than by watching an episode.
 *
 * Intro markers come from a `.skiptro.json` sidecar produced separately;
 * nothing here detects one. See `src-tauri/src/skip.rs`.
 *
 * Credits are different, because **Skiptro 1.2.0 does not detect them at all**
 * — it emits an intro segment and nothing else. So the closing segment is
 * resolved here from whatever the file itself can be made to admit, in strict
 * order of how much it is worth trusting:
 *
 *  1. **The sidecar**, if some producer ever writes one. Measured, so it wins.
 *  2. **A chapter that says so.** Many remuxes carry a named "End Credits"
 *     chapter. That is the author of the file stating where the credits are,
 *     which is evidence rather than inference.
 *  3. **A fixed tail.** `duration − N seconds`. This one is a guess, and it is
 *     fenced accordingly: it never fires without somewhere to go next, and by
 *     default it only *offers*. A guess that shows a card costs a card on
 *     screen; a guess that seeks costs content the user never saw.
 */
import type { Chapter } from './chapters';
import type { Segment, SkipMarkers } from './api';

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

// ---- resolving a credits segment ------------------------------------------

/** Where a credits segment came from, so the player can say. */
export type CreditsSource = 'sidecar' | 'chapter' | 'tail';

/** Setting key: seconds before the end to assume credits. `'0'` turns it off. */
export const CREDITS_TAIL_KEY = 'credits_tail_secs';

/**
 * Long enough to cover the closing titles of most modern episodic TV, short
 * enough that a file which simply ends on a scene loses only its last minute —
 * and only if the offer is actually taken.
 */
export const DEFAULT_CREDITS_TAIL_SECS = 60;

/**
 * The lengths the setting offers. A cycling button rather than a free number:
 * this is a coarse judgement about how a library's shows are cut, not a value
 * worth typing, and a remote has no comfortable way to type one anyway.
 */
export const CREDITS_TAIL_CHOICES = [0, 30, 45, 60, 90, 120];

/**
 * Chapter names that mean "the credits start here".
 *
 * Deliberately narrow. A chapter list is user-visible text with no schema, and
 * a false positive here ends an episode early — the same class of silent
 * wrongness as a bad metadata match, and the reason the tail guess below is
 * fenced too.
 */
const CREDITS_CHAPTER = /(^|\W)(end\s?credits?|credits?|outro|ending|closing)(\W|$)/i;

/**
 * The earliest point a credits chapter is believed. "Opening Credits" is a real
 * chapter name, and taking it would end the episode at the title sequence — the
 * one failure severe enough to be worth a blunt guard.
 */
const EARLIEST_CREDITS_FRACTION = 0.5;

/** A tail guess needs the file to be comfortably longer than the tail itself. */
const MIN_TAIL_MULTIPLE = 2;

export interface CreditsInputs {
  /** The file's chapters, empty when it has none. */
  chapters: Chapter[];
  /** mpv's duration for this file, null until it is known. */
  duration: number | null;
  /** Seconds before the end to fall back to. 0 disables the guess entirely. */
  tailSecs: number;
  /**
   * Whether the guess is allowed at all. False for a film, or the last episode
   * of a run: acting on a guess with nowhere to go can only cut the ending off.
   */
  allowTailGuess: boolean;
}

/** A named end-credits chapter in the back half of the file, if there is one. */
export function creditsFromChapters(chapters: Chapter[], duration: number | null): number | null {
  if (!duration || duration <= 0) return null;
  const earliest = duration * EARLIEST_CREDITS_FRACTION;

  // Last match wins: a file can legitimately name both an opening and a closing
  // sequence, and only the closing one is the end.
  let found: number | null = null;
  for (const chapter of chapters) {
    if (!chapter.title || chapter.time < earliest) continue;
    if (chapter.time >= duration - MIN_WORTH_SKIPPING_SECS) continue;
    if (CREDITS_CHAPTER.test(chapter.title)) found = chapter.time;
  }
  return found;
}

/**
 * Fold a resolved credits segment into the sidecar's markers.
 *
 * Returns the markers unchanged when the sidecar already carries credits, and
 * reports which source won so the player can show it rather than leaving the
 * user to guess why an episode ended when it did.
 */
export function withResolvedCredits(
  markers: SkipMarkers | null,
  inputs: CreditsInputs
): { markers: SkipMarkers | null; creditsSource: CreditsSource | null } {
  if (markers?.credits) return { markers, creditsSource: 'sidecar' };

  const { chapters, duration, tailSecs, allowTailGuess } = inputs;

  let start = creditsFromChapters(chapters, duration);
  let source: CreditsSource | null = start !== null ? 'chapter' : null;

  if (
    start === null &&
    allowTailGuess &&
    tailSecs > 0 &&
    duration !== null &&
    duration > tailSecs * MIN_TAIL_MULTIPLE
  ) {
    start = duration - tailSecs;
    source = 'tail';
  }

  if (start === null || duration === null) {
    return { markers, creditsSource: null };
  }

  const credits: Segment = { start, end: duration };
  return {
    markers: {
      intro: markers?.intro ?? null,
      credits,
      sidecar: markers?.sidecar ?? null,
    },
    creditsSource: source,
  };
}
