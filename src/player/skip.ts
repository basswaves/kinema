/**
 * Intro/recap/credits skip logic, kept out of the player component so it stays
 * testable by reading rather than by watching an episode.
 *
 * Markers arrive already ranked from `src-tauri/src/skip.rs`, which picks
 * between Skiptro's database, a `.skiptro.json` sidecar, the app's own
 * analysis, TheIntroDB and IntroDB.app. Nothing here detects anything.
 *
 * Two things are decided here rather than there, because they need the file's
 * length, which only the player knows: whether a community-timed recap and a
 * film's scene after the credits actually fit *this* file
 * (`checkedAgainstFile`).
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
import type { Chapter } from './engine';
import type { Segment, SkipMarkers } from './api';

export type SkipKind = 'intro' | 'recap' | 'credits';

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
  /**
   * For credits: the skip lands on a scene after them, rather than ending the
   * file. Such a skip is a seek, never an ending, and is only ever offered —
   * automatic mode leaves it to a person (decided 2026-09-30: those timings are
   * usually one viewer's, and a film's credits were never skipped by itself).
   */
  toScene: boolean;
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

  const { intro, recap, credits, post_credits: scene } = markers;

  // A recap is offered only while it is on screen. When it comes before the
  // intro, that makes two presses — "Skip recap", then "Skip intro" — each
  // skipping one thing (decided 2026-09-30). Before the recap begins, through
  // a cold open, the intro's offer from 0:00 still stands and skips both.
  if (
    recap &&
    recap.end !== null &&
    timePos >= recap.start &&
    timePos < recap.end - MIN_WORTH_SKIPPING_SECS
  ) {
    return {
      kind: 'recap',
      seekTo: recap.end,
      key: `recap:${recap.start}`,
      inSegment: true,
      toScene: false,
    };
  }

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
      toScene: false,
    };
  }

  // Credits run to the end of the file, so only the start matters — there is
  // nothing after them to seek to.
  if (credits && timePos >= credits.start) {
    // A scene after the credits turns "skip the credits" into a seek to it.
    // `checkedAgainstFile` has already made sure it starts after them.
    if (scene && scene.end !== null) {
      if (timePos < scene.start - MIN_WORTH_SKIPPING_SECS) {
        return {
          kind: 'credits',
          seekTo: scene.start,
          key: `credits:${credits.start}`,
          inSegment: true,
          toScene: true,
        };
      }
      // Watching the scene: nothing to offer over it.
      if (timePos < scene.end) return null;
      // Past it, whatever is left is the end of the credits, as before.
      return {
        kind: 'credits',
        seekTo: scene.end,
        key: `credits:${scene.end}`,
        inSegment: true,
        toScene: false,
      };
    }
    return {
      kind: 'credits',
      seekTo: credits.start,
      key: `credits:${credits.start}`,
      inSegment: true,
      toScene: false,
    };
  }

  return null;
}

/** What decides whether the active segment gets a Skip button. */
export interface PromptInputs {
  /** Automatic mode: skips without asking where it is allowed to. */
  autoSkip: boolean;
  /** The Up next card is showing, and stands in for a credits prompt. */
  upNextShown: boolean;
  /** The segment key the viewer (or the timer) has already turned down. */
  dismissed: string | null;
  /** There is a next episode to move on to. */
  hasNext: boolean;
}

/**
 * The Skip button to show, or null for none.
 *
 * In automatic mode the button still shows during a cold open, where
 * nothing will happen by itself until the intro begins — and over credits
 * with a scene after them, which automatic mode never jumps to.
 */
export function skipPromptFor(
  active: ActiveSkip | null,
  { autoSkip, upNextShown, dismissed, hasNext }: PromptInputs
): ActiveSkip | null {
  const promptAllowed =
    active !== null && (!autoSkip || !active.inSegment || active.toScene);
  return active && promptAllowed && !upNextShown && dismissed !== active.key
    ? // A credits prompt with nothing to move on to would be a button that
      // does nothing useful.
      active.kind !== 'credits' || active.toScene || hasNext
      ? active
      : null
    : null;
}

/** What the Skip button says. */
export function skipLabel(prompt: ActiveSkip): string {
  return prompt.kind === 'intro'
    ? 'Skip intro'
    : prompt.kind === 'recap'
      ? 'Skip recap'
      : prompt.toScene
        ? 'Skip to the scene after the credits'
        : 'Next episode ›';
}

/** Whether markers are worth acting on at all. */
export function hasAnyMarkers(markers: SkipMarkers | null): boolean {
  return Boolean(
    markers && (markers.intro || markers.recap || markers.credits || markers.post_credits)
  );
}

// ---- fitting community timings to this file ------------------------------

/**
 * How far past the end of this file a community timing may reach and still be
 * believed. A few seconds covers rounding and a slightly different mux; more
 * than that and the timing was taken against a longer copy, where every number
 * in it is somewhere else.
 */
const LENGTH_TOLERANCE_SECS = 5;

/**
 * Drop a recap or a scene after the credits that does not fit this file.
 *
 * Both come only from the community services, timed against somebody's copy
 * and — for IntroDB.app — with no way to say which. A scene is kept only when
 * it starts after the credits, and before the end of this file, and ends
 * within it; a recap only when it ends within the file. Until the length is
 * known, a scene is not offered at all: a seek to a time past the end is a
 * seek to the end, which is the ending of the film, skipped.
 *
 * Returns the same object when nothing is dropped, so it can sit in a memo.
 */
export function checkedAgainstFile(
  markers: SkipMarkers | null,
  duration: number | null
): SkipMarkers | null {
  if (!markers) return markers;
  const length = duration ?? 0;
  const known = length > 0;
  const { recap, credits, post_credits: scene } = markers;

  const recapFits =
    !recap || !known || (recap.end !== null && recap.end <= length + LENGTH_TOLERANCE_SECS);
  const sceneFits =
    !scene ||
    (known &&
      credits !== null &&
      scene.end !== null &&
      scene.start > credits.start &&
      scene.start < length - MIN_WORTH_SKIPPING_SECS &&
      scene.end <= length + LENGTH_TOLERANCE_SECS);

  if (recapFits && sceneFits) return markers;
  return {
    ...markers,
    ...(recapFits ? {} : { recap: null, recap_source: null }),
    ...(sceneFits ? {} : { post_credits: null, post_credits_source: null }),
  };
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
      intro: null,
      intro_source: null,
      recap: null,
      recap_source: null,
      post_credits: null,
      post_credits_source: null,
      // Everything else the sources said is kept — a recap, and a film's
      // scene after a credits start that only a chapter supplied.
      ...markers,
      credits,
      credits_source: source,
    },
    creditsSource: source,
  };
}
