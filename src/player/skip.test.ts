/**
 * When an episode is allowed to end early.
 *
 * Every failure in this file is silent and destructive in the same way: it cuts
 * the last minutes off something you were watching, and the only symptom is the
 * next episode starting sooner than it should have. Nobody reports that as a
 * bug; they just find the app slightly untrustworthy.
 *
 * So the guards matter more than the feature. A credits *chapter* is only
 * believed in the back half of the file, because "Opening Credits" is a real
 * chapter name. A tail guess is only made when something is known to come next.
 */
import { describe, expect, it } from 'vitest';
import {
  activeSkip,
  checkedAgainstFile,
  creditsFromChapters,
  hasAnyMarkers,
  withResolvedCredits,
} from './skip';
import type { SkipMarkers } from './api';

function markers(over: Partial<SkipMarkers> = {}): SkipMarkers {
  return {
    intro: null,
    intro_source: null,
    recap: null,
    recap_source: null,
    credits: null,
    credits_source: null,
    post_credits: null,
    post_credits_source: null,
    ...over,
  } as SkipMarkers;
}

describe('activeSkip', () => {
  it('offers an intro skip while inside the intro', () => {
    const m = markers({ intro: { start: 30, end: 90 } });
    expect(activeSkip(m, 45)?.kind).toBe('intro');
    expect(activeSkip(m, 45)?.seekTo).toBe(90);
    expect(activeSkip(m, 45)?.inSegment).toBe(true);
  });

  /**
   * Decided: when an episode has an intro, the button is there from 0:00 —
   * and pressed during a cold open it goes to the end of the intro, skipping
   * the cold open as well. `inSegment` is false there, which is what keeps
   * *automatic* mode from doing that on its own.
   */
  it('offers the intro skip from the first frame, cold open included', () => {
    const m = markers({ intro: { start: 30, end: 90 } });
    for (const position of [0, 0.1, 10, 29.9]) {
      const skip = activeSkip(m, position);
      expect(skip?.kind, `at ${position}`).toBe('intro');
      expect(skip?.seekTo).toBe(90);
      expect(skip?.inSegment).toBe(false);
    }
  });

  it('offers nothing once the intro is over', () => {
    const m = markers({ intro: { start: 30, end: 90 } });
    expect(activeSkip(m, 90)).toBeNull();
    expect(activeSkip(m, 120)).toBeNull();
  });

  /**
   * The seek would cost about as much as watching the rest, and the button
   * would appear exactly as it stopped being worth pressing.
   */
  it('does not offer a skip in the last seconds of an intro', () => {
    const m = markers({ intro: { start: 30, end: 90 } });
    expect(activeSkip(m, 88)).toBeNull();
  });

  it('ignores an intro with no end, which has nowhere to seek to', () => {
    const m = markers({ intro: { start: 30, end: null } });
    expect(activeSkip(m, 45)).toBeNull();
  });

  it('offers credits from their start to the end of the file', () => {
    const m = markers({ credits: { start: 1300, end: 1400 } });
    expect(activeSkip(m, 1350)?.kind).toBe('credits');
    expect(activeSkip(m, 1399)?.kind).toBe('credits');
  });

  it('is null with no markers or no position', () => {
    expect(activeSkip(null, 100)).toBeNull();
    expect(activeSkip(markers({ intro: { start: 0, end: 60 } }), null)).toBeNull();
  });

  /**
   * The key identifies a segment occurrence, and the prompt is dismissed by it.
   * If it changed as the position advanced, a dismissed prompt would come
   * straight back on the next tick.
   */
  it('gives one stable key for the whole segment', () => {
    const m = markers({ intro: { start: 30, end: 90 } });
    expect(activeSkip(m, 40)?.key).toBe(activeSkip(m, 70)?.key);
    // Including the stretch before the intro, where the button now also shows.
    expect(activeSkip(m, 0)?.key).toBe(activeSkip(m, 70)?.key);
  });

  it('marks credits as in-segment, since they only ever start where they start', () => {
    const m = markers({ credits: { start: 1300, end: null } });
    expect(activeSkip(m, 1300)?.inSegment).toBe(true);
    expect(activeSkip(m, 1299)).toBeNull();
  });
});

describe('hasAnyMarkers', () => {
  it('is false for null and for empty markers', () => {
    expect(hasAnyMarkers(null)).toBe(false);
    expect(hasAnyMarkers(markers())).toBe(false);
  });

  it('is true when either segment is present', () => {
    expect(hasAnyMarkers(markers({ intro: { start: 0, end: 60 } }))).toBe(true);
    expect(hasAnyMarkers(markers({ credits: { start: 1300, end: 1400 } }))).toBe(true);
  });
});

describe('creditsFromChapters', () => {
  it('finds a named end-credits chapter', () => {
    const found = creditsFromChapters(
      [
        { time: 0, title: 'Cold Open' },
        { time: 1300, title: 'End Credits' },
      ],
      1400
    );
    expect(found).toBe(1300);
  });

  /**
   * The guard that matters most. "Opening Credits" is a real chapter name, and
   * taking it would end the episode at the title sequence.
   */
  it('ignores a credits chapter in the first half of the file', () => {
    const found = creditsFromChapters([{ time: 30, title: 'Opening Credits' }], 1400);
    expect(found).toBeNull();
  });

  it('takes the closing one when a file names both', () => {
    const found = creditsFromChapters(
      [
        { time: 30, title: 'Opening Credits' },
        { time: 1300, title: 'Closing Credits' },
      ],
      1400
    );
    expect(found).toBe(1300);
  });

  it('ignores a chapter too close to the end to be worth skipping', () => {
    expect(creditsFromChapters([{ time: 1399, title: 'Credits' }], 1400)).toBeNull();
  });

  it('needs a duration to judge against', () => {
    expect(creditsFromChapters([{ time: 1300, title: 'End Credits' }], null)).toBeNull();
    expect(creditsFromChapters([{ time: 1300, title: 'End Credits' }], 0)).toBeNull();
  });

  it('ignores chapters with unrelated names', () => {
    expect(creditsFromChapters([{ time: 1300, title: 'Act Four' }], 1400)).toBeNull();
  });
});

describe('withResolvedCredits', () => {
  const inputs = { chapters: [], duration: 1400, tailSecs: 60, allowTailGuess: true };

  it('leaves a real marker alone and reports where it came from', () => {
    const m = markers({ credits: { start: 1200, end: 1400 }, credits_source: 'introdb' });
    const result = withResolvedCredits(m, inputs);

    expect(result.markers?.credits?.start).toBe(1200);
    expect(result.creditsSource).toBe('introdb');
  });

  it('prefers a chapter over the tail guess', () => {
    const result = withResolvedCredits(markers(), {
      ...inputs,
      chapters: [{ time: 1250, title: 'End Credits' }],
    });

    expect(result.creditsSource).toBe('chapter');
    expect(result.markers?.credits?.start).toBe(1250);
  });

  it('falls back to the tail guess when nothing else knows', () => {
    const result = withResolvedCredits(markers(), inputs);

    expect(result.creditsSource).toBe('tail');
    expect(result.markers?.credits?.start).toBe(1340);
  });

  /**
   * False for a film and for the last episode of a run. Acting on a guess with
   * nowhere to move on to can only cut the ending off for nothing.
   */
  it('never guesses when there is nothing to move on to', () => {
    const result = withResolvedCredits(markers(), { ...inputs, allowTailGuess: false });
    expect(result.creditsSource).toBeNull();
    expect(result.markers?.credits ?? null).toBeNull();
  });

  it('does not guess when the setting is off', () => {
    const result = withResolvedCredits(markers(), { ...inputs, tailSecs: 0 });
    expect(result.creditsSource).toBeNull();
  });

  /** A 90-second clip with a 60-second tail is all credits, which is nonsense. */
  it('does not guess on a file barely longer than the tail', () => {
    const result = withResolvedCredits(markers(), { ...inputs, duration: 90 });
    expect(result.creditsSource).toBeNull();
  });

  it('does not guess without a duration', () => {
    const result = withResolvedCredits(markers(), { ...inputs, duration: null });
    expect(result.creditsSource).toBeNull();
  });

  it('keeps an existing intro when adding guessed credits', () => {
    const m = markers({ intro: { start: 30, end: 90 }, intro_source: 'skiptro-db' });
    const result = withResolvedCredits(m, inputs);

    expect(result.markers?.intro?.start).toBe(30);
    expect(result.markers?.intro_source).toBe('skiptro-db');
    expect(result.creditsSource).toBe('tail');
  });
});

/**
 * "Previously on…". Decided: a recap before the intro is its own press —
 * "Skip recap", then "Skip intro" — so each press skips one thing.
 */
describe('recaps', () => {
  it('offers the recap while it is on screen, then the intro', () => {
    const m = markers({ recap: { start: 0, end: 60 }, intro: { start: 60, end: 90 } });
    const inRecap = activeSkip(m, 20);
    expect(inRecap?.kind).toBe('recap');
    expect(inRecap?.seekTo).toBe(60);
    expect(inRecap?.inSegment).toBe(true);
    expect(activeSkip(m, 60)?.kind).toBe('intro');
  });

  /** Before the recap begins, the intro's offer from 0:00 still stands. */
  it('keeps offering the intro through a cold open before the recap', () => {
    const m = markers({ recap: { start: 10, end: 60 }, intro: { start: 60, end: 90 } });
    expect(activeSkip(m, 5)?.kind).toBe('intro');
    expect(activeSkip(m, 5)?.seekTo).toBe(90);
  });

  it('offers a recap that comes after the intro once the intro is over', () => {
    const m = markers({ intro: { start: 0, end: 40 }, recap: { start: 40, end: 100 } });
    expect(activeSkip(m, 10)?.kind).toBe('intro');
    expect(activeSkip(m, 50)?.kind).toBe('recap');
    expect(activeSkip(m, 50)?.seekTo).toBe(100);
  });

  it('offers nothing in the last seconds of a recap', () => {
    const m = markers({ recap: { start: 0, end: 60 } });
    expect(activeSkip(m, 58)).toBeNull();
  });

  it('counts a recap alone as markers', () => {
    expect(hasAnyMarkers(markers({ recap: { start: 0, end: 60 } }))).toBe(true);
  });
});

/**
 * A film's scene after the credits: "skip the credits" becomes a seek to it,
 * never an ending, and is only ever offered.
 */
describe('the scene after the credits', () => {
  const film = markers({
    credits: { start: 7000, end: null },
    credits_source: 'introdb',
    post_credits: { start: 7500, end: 7560 },
    post_credits_source: 'introdb-app',
  });

  it('turns the credits skip into a seek to the scene', () => {
    const skip = activeSkip(film, 7100);
    expect(skip?.kind).toBe('credits');
    expect(skip?.toScene).toBe(true);
    expect(skip?.seekTo).toBe(7500);
  });

  it('offers nothing over the scene itself', () => {
    expect(activeSkip(film, 7520)).toBeNull();
  });

  it('goes back to the ordinary credits once the scene is over', () => {
    const skip = activeSkip(film, 7570);
    expect(skip?.kind).toBe('credits');
    expect(skip?.toScene).toBe(false);
  });

  it('leaves ordinary credits as they were', () => {
    const skip = activeSkip(markers({ credits: { start: 1300, end: null } }), 1350);
    expect(skip?.toScene).toBe(false);
  });

  it('counts a scene as markers', () => {
    expect(hasAnyMarkers(markers({ post_credits: { start: 7500, end: 7560 } }))).toBe(true);
  });
});

/**
 * Community timings are taken against somebody's copy. What does not fit this
 * file is dropped rather than seeked to — a seek past the end is a seek to the
 * end, which skips the ending of the film.
 */
describe('checkedAgainstFile', () => {
  const film = markers({
    credits: { start: 7000, end: null },
    post_credits: { start: 7500, end: 7560 },
    post_credits_source: 'introdb-app',
  });

  it('keeps a scene that fits, and returns the same object', () => {
    expect(checkedAgainstFile(film, 7600)).toBe(film);
  });

  it('drops a scene timed against a longer copy', () => {
    expect(checkedAgainstFile(film, 7400)?.post_credits).toBeNull();
    expect(checkedAgainstFile(film, 7540)?.post_credits).toBeNull();
    expect(checkedAgainstFile(film, 7400)?.post_credits_source).toBeNull();
  });

  it('allows a few seconds of rounding at the end', () => {
    expect(checkedAgainstFile(film, 7557)?.post_credits).not.toBeNull();
  });

  /** Seen in real data: a "post-credits" scene timed before the credits. */
  it('drops a scene that starts before the credits', () => {
    const m = markers({
      credits: { start: 8155, end: null },
      post_credits: { start: 8107, end: 8155 },
    });
    expect(checkedAgainstFile(m, 8700)?.post_credits).toBeNull();
  });

  it('drops a scene when nothing says where the credits are', () => {
    const m = markers({ post_credits: { start: 7500, end: 7560 } });
    expect(checkedAgainstFile(m, 7600)?.post_credits).toBeNull();
  });

  it('offers no scene until the length is known', () => {
    expect(checkedAgainstFile(film, null)?.post_credits).toBeNull();
    expect(checkedAgainstFile(film, 0)?.post_credits).toBeNull();
  });

  it('drops a recap that ends past the end of the file, and keeps one that fits', () => {
    const m = markers({ recap: { start: 0, end: 60 } });
    expect(checkedAgainstFile(m, 40)?.recap).toBeNull();
    expect(checkedAgainstFile(m, 1400)).toBe(m);
    // Until the length is known a recap stays: it is near the start, where a
    // wrong end costs seconds rather than an ending.
    expect(checkedAgainstFile(m, null)).toBe(m);
  });

  it('keeps everything else it was given', () => {
    const m = { ...film, intro: { start: 0, end: 40 }, intro_source: 'analysis' };
    expect(checkedAgainstFile(m, 7400)?.intro_source).toBe('analysis');
  });
});

describe('withResolvedCredits and the new segments', () => {
  /** A chapter supplying the credits must not throw the recap or scene away. */
  it('keeps a recap and a scene when the credits come from a chapter', () => {
    const m = markers({
      recap: { start: 0, end: 30 },
      recap_source: 'introdb',
      post_credits: { start: 7500, end: 7560 },
    });
    const result = withResolvedCredits(m, {
      chapters: [{ time: 7000, title: 'End Credits' }],
      duration: 7600,
      tailSecs: 60,
      allowTailGuess: false,
    });
    expect(result.creditsSource).toBe('chapter');
    expect(result.markers?.recap_source).toBe('introdb');
    expect(result.markers?.post_credits?.start).toBe(7500);
  });
});
