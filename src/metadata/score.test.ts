/**
 * The matcher's judgement, pinned.
 *
 * These numbers are a settled decision rather than a tuning knob: a wrong match
 * is worse than no match, because a wrong one looks right on the shelf and is
 * only found later, by accident, while a refusal lands in a queue that says so.
 * `MATCH_THRESHOLD = 0.75` and the 0.05 runner-up margin are what make the
 * refusals happen.
 *
 * The reason they need tests rather than a comment: both are one-character
 * changes with no visible effect on any single case. Loosening the threshold
 * does not break anything you would notice while working — it quietly converts
 * some refusals into wrong matches, in a library nobody re-checks.
 */
import { describe, expect, it } from 'vitest';
import {
  MATCH_THRESHOLD,
  normaliseTitle,
  pickBest,
  scoreCandidate,
  titleSimilarity,
  type Candidate,
} from './score';

/** A candidate with only the fields a test cares about spelled out. */
function candidate(over: Partial<Candidate> & { title: string }): Candidate {
  return {
    providerId: over.title.toLowerCase().replace(/\W+/g, '-'),
    year: null,
    popularity: null,
    voteCount: null,
    posterUrl: null,
    episodeCount: undefined,
    ...over,
  } as Candidate;
}

describe('normaliseTitle', () => {
  it('ignores punctuation, case and separators', () => {
    expect(normaliseTitle('Pride and the Fall')).toBe(normaliseTitle('pride.and.the.fall'));
    expect(normaliseTitle('WALL·E')).toBe(normaliseTitle('wall e'));
    expect(normaliseTitle('Spider-Man: No Way Home')).toBe(
      normaliseTitle('spider man no way home')
    );
  });
});

describe('titleSimilarity', () => {
  it('is 1 for the same title written differently', () => {
    expect(titleSimilarity('The Matrix', 'the.matrix')).toBe(1);
  });

  it('is low for different titles', () => {
    expect(titleSimilarity('The Matrix', 'Inception')).toBeLessThan(0.5);
  });
});

describe('scoreCandidate', () => {
  it('rewards an exact year and punishes a distant one', () => {
    const ctx = { parsedTitle: 'Heat', parsedYear: 1995 };
    const exact = scoreCandidate(candidate({ title: 'Heat', year: 1995 }), ctx);
    const off = scoreCandidate(candidate({ title: 'Heat', year: 1986 }), ctx);

    expect(exact.confidence).toBeGreaterThan(off.confidence);
    expect(exact.reason).toContain('year exact');
    expect(off.reason).toContain('year off by 9');
  });

  /**
   * Festival, theatrical and regional release dates disagree by a year all the
   * time. Treating that as evidence against a match would refuse a large slice
   * of any real library.
   */
  it('treats a one-year difference as almost harmless', () => {
    const ctx = { parsedTitle: 'Blade Runner 2049', parsedYear: 2017 };
    const near = scoreCandidate(candidate({ title: 'Blade Runner 2049', year: 2018 }), ctx);

    expect(near.confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(near.reason).toContain('year ±1');
  });

  it('never reports a confidence outside 0..1', () => {
    const ctx = { parsedTitle: 'Heat', parsedYear: 1995 };
    const perfect = scoreCandidate(candidate({ title: 'Heat', year: 1995 }), ctx);
    const awful = scoreCandidate(candidate({ title: 'Something Else', year: 1800 }), ctx);

    expect(perfect.confidence).toBeLessThanOrEqual(1);
    expect(awful.confidence).toBeGreaterThanOrEqual(0);
  });
});

describe('pickBest', () => {
  it('matches a clear winner', () => {
    const { best, matched } = pickBest(
      [candidate({ title: 'The Matrix', year: 1999 }), candidate({ title: 'Inception', year: 2010 })],
      { parsedTitle: 'The Matrix', parsedYear: 1999 }
    );

    expect(matched).toBe(true);
    expect(best?.title).toBe('The Matrix');
  });

  it('refuses when nothing clears the threshold', () => {
    const { matched, best } = pickBest([candidate({ title: 'Completely Different' })], {
      parsedTitle: 'The Matrix',
      parsedYear: 1999,
    });

    expect(matched).toBe(false);
    expect(best?.confidence).toBeLessThan(MATCH_THRESHOLD);
  });

  /**
   * The case the whole design exists for: two remakes with the same name and no
   * year to separate them. Guessing here is how the wrong film ends up on the
   * shelf, so it refuses and says which two it could not choose between.
   */
  it('refuses a genuine coin-flip between two identical titles', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'The Office', popularity: 50 }),
        candidate({ title: 'The Office', popularity: 48 }),
      ],
      { parsedTitle: 'The Office', parsedYear: null }
    );

    expect(matched).toBe(false);
    expect(best?.reason).toContain('ambiguous vs');
  });

  /**
   * But not every same-name pair is ambiguous. Providers carry stubs,
   * documentaries and regional duplicates alongside the real entry, and
   * refusing those would fill the review queue with decisions nobody needs to
   * make. Threefold popularity is treated as decisive.
   */
  it('breaks a tie when one entry is overwhelmingly the one people mean', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'The Office', popularity: 300 }),
        candidate({ title: 'The Office', popularity: 4 }),
      ],
      { parsedTitle: 'The Office', parsedYear: null }
    );

    expect(matched).toBe(true);
    expect(best?.popularity).toBe(300);
    expect(best?.reason).toContain('broken by popularity');
  });

  it('handles an empty candidate list without throwing', () => {
    const { best, matched, all } = pickBest([], { parsedTitle: 'Anything', parsedYear: null });

    expect(best).toBeNull();
    expect(matched).toBe(false);
    expect(all).toEqual([]);
  });

  /**
   * Pinned deliberately. Both constants are documented as settled in
   * CONTRIBUTING.md, and a change to either should have to be argued for in a
   * pull request rather than slipped in.
   */
  it('keeps the agreed threshold', () => {
    expect(MATCH_THRESHOLD).toBe(0.75);
  });
});
