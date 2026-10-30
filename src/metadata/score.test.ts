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
      [
        candidate({ title: 'The Matrix', year: 1999 }),
        candidate({ title: 'Inception', year: 2010 }),
      ],
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

  /** Clamped to 1 before comparing, 1.12 and 1.04 were a tie (2026-10-25). */
  it('lets the exact year beat a year off by one when both titles are perfect', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'The Courier', year: 2019, popularity: 9 }),
        candidate({ title: 'The Courier', year: 2020, popularity: 8 }),
      ],
      { parsedTitle: 'The Courier', parsedYear: 2020 }
    );
    expect(matched).toBe(true);
    expect(best?.year).toBe(2020);
    expect(best?.confidence).toBe(1);
    expect(best?.score).toBeGreaterThan(1);
  });

  /** "Film 2020" for a film of 2019, beside a stub of 2020 with the same name. */
  it('does not let the exact year pick a stub over the film people mean', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'Marriage Story', year: 2020, popularity: 0.5, voteCount: 1 }),
        candidate({ title: 'Marriage Story', year: 2019, popularity: 20, voteCount: 8000 }),
      ],
      { parsedTitle: 'Marriage Story', parsedYear: 2020 }
    );
    expect(matched).toBe(true);
    expect(best?.year).toBe(2019);
  });

  it('lets a perfect title beat a near one once both have the year', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'The Outsiders', year: 2018, popularity: 9 }),
        candidate({ title: 'The Outsider', year: 2018, popularity: 3 }),
      ],
      { parsedTitle: 'The Outsider', parsedYear: 2018 }
    );
    expect(matched).toBe(true);
    expect(best?.title).toBe('The Outsider');
  });

  /** The article bonus orders the two; votes then decide. */
  it('puts the literal title first when only an article differs', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'The Strays', year: 2023, popularity: 6, voteCount: 300 }),
        candidate({ title: 'Strays', year: 2023, popularity: 5, voteCount: 900 }),
      ],
      { parsedTitle: 'Strays', parsedYear: 2023 }
    );
    expect(best?.title).toBe('Strays');
    expect(matched).toBe(false); // 900 is not ten times 300: still a coin-flip
  });

  it('keeps two films with the same article a tie', () => {
    const { matched } = pickBest(
      [
        candidate({ title: 'The Strays', year: 2023, voteCount: 300 }),
        candidate({ title: 'The Strays', year: 2023, voteCount: 280 }),
      ],
      { parsedTitle: 'The Strays', parsedYear: 2023 }
    );
    expect(matched).toBe(false);
  });

  /** Same name, same year: the real film and a stub (TMDB, 2026-10-25). */
  it('breaks a tie by votes when popularity is close', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'Beast', year: 2022, popularity: 4, voteCount: 95 }),
        candidate({ title: 'Beast', year: 2022, popularity: 11, voteCount: 1828 }),
      ],
      { parsedTitle: 'Beast', parsedYear: 2022 }
    );
    expect(matched).toBe(true);
    expect(best?.voteCount).toBe(1828);
    expect(best?.reason).toContain('broken by votes');
  });

  it('breaks a tie by votes against an entry with none', () => {
    const { matched } = pickBest(
      [
        candidate({ title: 'Hacker', year: 2016, popularity: 4, voteCount: 358 }),
        candidate({ title: 'Hacker', year: 2016, popularity: 2, voteCount: 0 }),
      ],
      { parsedTitle: 'Hacker', parsedYear: 2016 }
    );
    expect(matched).toBe(true);
  });

  it('does not let a few votes decide', () => {
    const { matched } = pickBest(
      [
        candidate({ title: 'Hacker', year: 2016, voteCount: 40 }),
        candidate({ title: 'Hacker', year: 2016, voteCount: 0 }),
      ],
      { parsedTitle: 'Hacker', parsedYear: 2016 }
    );
    expect(matched).toBe(false);
  });

  it('refuses when popularity and votes point at different entries', () => {
    const { matched } = pickBest(
      [
        candidate({ title: 'Beast', year: 2022, popularity: 30, voteCount: 50 }),
        candidate({ title: 'Beast', year: 2022, popularity: 5, voteCount: 2000 }),
      ],
      { parsedTitle: 'Beast', parsedYear: 2022 }
    );
    expect(matched).toBe(false);
  });

  it('refuses two real films with votes of the same order', () => {
    const { matched } = pickBest(
      [
        candidate({ title: 'The Father', year: 2020, popularity: 20, voteCount: 2500 }),
        candidate({ title: 'The Father', year: 2020, popularity: 3, voteCount: 400 }),
      ],
      { parsedTitle: 'The Father', parsedYear: 2020 }
    );
    expect(matched).toBe(true); // popularity 20 vs 3 still decides, as before
    const coin = pickBest(
      [
        candidate({ title: 'The Father', year: 2020, popularity: 20, voteCount: 2500 }),
        candidate({ title: 'The Father', year: 2020, popularity: 12, voteCount: 900 }),
      ],
      { parsedTitle: 'The Father', parsedYear: 2020 }
    );
    expect(coin.matched).toBe(false);
  });

  it('doubts a third candidate as close as the second', () => {
    const { matched } = pickBest(
      [
        candidate({ title: 'Beast', year: 2022, voteCount: 1828 }),
        candidate({ title: 'Beast', year: 2022, voteCount: 2 }),
        candidate({ title: 'Beast', year: 2022, voteCount: 1500 }),
      ],
      { parsedTitle: 'Beast', parsedYear: 2022 }
    );
    expect(matched).toBe(false);
  });

  it('does not match a sequel for its original, by the year', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'Alien: Covenant', year: 2017, popularity: 40 }),
        candidate({ title: 'Alien', year: 1979, popularity: 30 }),
      ],
      { parsedTitle: 'Alien', parsedYear: 1979 }
    );
    expect(matched).toBe(true);
    expect(best?.title).toBe('Alien');
  });

  it('does not match a sequel for its original without a year either', () => {
    const { best } = pickBest(
      [
        candidate({ title: 'Alien: Covenant', year: 2017, popularity: 40 }),
        candidate({ title: 'Alien', year: 1979, popularity: 30 }),
      ],
      { parsedTitle: 'Alien', parsedYear: null }
    );
    expect(best?.title).toBe('Alien');
  });

  it('matches the part of a title before its colon', () => {
    const { matched, best } = pickBest(
      [candidate({ title: 'Batman v Superman: Dawn of Justice', year: 2016 })],
      { parsedTitle: 'Batman v Superman', parsedYear: 2016 }
    );
    expect(matched).toBe(true);
    expect(best?.reason).toContain('before ":"');
  });

  it('matches by an alternative title', () => {
    const { matched, best } = pickBest(
      [
        candidate({
          title: 'Raiders of the Lost Ark',
          year: 1981,
          altTitles: ['Indiana Jones and the Raiders of the Lost Ark'],
        }),
      ],
      { parsedTitle: 'Indiana Jones and the Raiders of the Lost Ark', parsedYear: 1981 }
    );
    expect(matched).toBe(true);
    expect(best?.reason).toContain('also');
  });

  it('matches the whole name of a title cut at " - "', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'Spider-Man', year: 2002, popularity: 50 }),
        candidate({ title: 'Spider-Man: Across the Spider-Verse', year: 2023, popularity: 40 }),
      ],
      {
        parsedTitle: 'Spider-Man - Across the Spider-Verse',
        otherParsedTitles: ['Spider-Man'],
        parsedYear: 2023,
      }
    );
    expect(matched).toBe(true);
    expect(best?.year).toBe(2023);
  });

  /** guessit took "Part Two" out of the title, and "Dune" 2024 matched "The Dune". */
  it('matches the part a file names, and not a film without it', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'The Dune', year: 2025, popularity: 2 }),
        candidate({ title: 'Dune', year: 2021, popularity: 80 }),
        candidate({ title: 'Dune: Part Two', year: 2024, popularity: 90 }),
      ],
      { parsedTitle: 'Dune Part 2', parsedYear: 2024 }
    );
    expect(matched).toBe(true);
    expect(best?.title).toBe('Dune: Part Two');
  });

  it('does not match another part of the same title', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'The Hunger Games: Mockingjay - Part 1', year: 2014 }),
        candidate({ title: 'The Hunger Games: Mockingjay - Part 2', year: 2015 }),
      ],
      { parsedTitle: 'The Hunger Games Mockingjay Part 2', parsedYear: null }
    );
    expect(matched).toBe(true);
    expect(best?.title).toContain('Part 2');
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
