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
import { activeSkip, creditsFromChapters, hasAnyMarkers, withResolvedCredits } from './skip';
import type { SkipMarkers } from './api';

function markers(over: Partial<SkipMarkers> = {}): SkipMarkers {
  return {
    intro: null,
    intro_source: null,
    credits: null,
    credits_source: null,
    ...over,
  } as SkipMarkers;
}

describe('activeSkip', () => {
  it('offers an intro skip while inside the intro', () => {
    const m = markers({ intro: { start: 30, end: 90 } });
    expect(activeSkip(m, 45)?.kind).toBe('intro');
    expect(activeSkip(m, 45)?.seekTo).toBe(90);
  });

  it('offers nothing before or after the intro', () => {
    const m = markers({ intro: { start: 30, end: 90 } });
    expect(activeSkip(m, 10)).toBeNull();
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
