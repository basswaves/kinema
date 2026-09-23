/**
 * Intro/credits skip logic, kept out of the player component so it stays
 * testable by reading rather than by watching an episode.
 *
 * Markers arrive already ranked from `src-tauri/src/skip.rs`, which picks
 * between Skiptro's database, a `.skiptro.json` sidecar and TheIntroDB. Nothing
 * here detects anything.
 *
 * What is still resolved here is the **fallback** for a credits segment,
 * because a marker is not guaranteed: Skiptro cannot detect credits at all, and
 * TheIntroDB only has them where somebody has submitted them. So the ladder
 * continues, in strict order of how much each rung is worth trusting:
 *
 *  1. **A marker**, from `skip.rs`. Somebody measured or timed this; it wins.
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
  /**
   * Whether the position is inside the segment itself. For an intro the skip
   * is offered from 0:00, before the intro starts — through a cold open — and
   * this is false there. Automatic mode acts only when it is true, so it never
   * skips a cold open on its own; a person pressing the button may.
   */
  inSegment: boolean;
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

  // Offered from the very start of the file, not from where the intro begins.
  // That is the decided behaviour: an episode with a known intro shows Skip
  // from 0:00, and pressing it during a cold open goes to the end of the intro
  // — the cold open included, knowingly. Waiting for the intro to begin made
  // the button look missing on exactly the episodes that open on a scene.
  //
  // An intro with no end has nowhere to seek to, so there is no skip to offer.
  // Every source drops one, but the type allows it because credits genuinely
  // have no end, and a check costs less than two segment types would.
  if (intro && intro.end !== null && timePos < intro.end - MIN_WORTH_SKIPPING_SECS) {
    return {
      kind: 'intro',
      seekTo: intro.end,
      key: `intro:${intro.start}`,
      inSegment: timePos >= intro.start,
    };
  }

  // Credits run to the end of the file, so only the start matters — there is
  // nothing after them to seek to.
  if (credits && timePos >= credits.start) {
    return {
      kind: 'credits',
      seekTo: credits.start,
      key: `credits:${credits.start}`,
      inSegment: true,
    };
  }

  return null;
}

/** Whether markers are worth acting on at all. */
export function hasAnyMarkers(markers: SkipMarkers | null): boolean {
  return Boolean(markers && (markers.intro || markers.credits));
}

// ---- resolving a credits segment ------------------------------------------

/**
 * Where a credits segment came from, so the player can say.
 *
 * `introdb` and `sidecar` are decided in Rust and arrive on the markers;
 * `chapter` and `tail` are resolved below. `skiptro-db` cannot appear — Skiptro
 * has no credits type to report.
 */
export type CreditsSource = 'introdb' | 'sidecar' | 'chapter' | 'tail';

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
 * Fold a guessed credits segment into the markers, when nothing supplied one.
 *
 * Returns the markers unchanged when a real marker is already there, and
 * reports which source won so the player can log it rather than leaving the
 * user to guess why an episode ended when it did.
 */
export function withResolvedCredits(
  markers: SkipMarkers | null,
  inputs: CreditsInputs
): { markers: SkipMarkers | null; creditsSource: CreditsSource | null } {
  if (markers?.credits) {
    // Rust already said where it came from. Fall back to 'sidecar' only for a
    // marker with no source recorded, which is what a pre-existing cache row
    // looks like.
    const source = (markers.credits_source as CreditsSource | null) ?? 'sidecar';
    return { markers, creditsSource: source };
  }

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
      intro_source: markers?.intro_source ?? null,
      credits,
      credits_source: source,
    },
    creditsSource: source,
  };
}
