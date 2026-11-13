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
        candidate({ title: 'The Office', popularity: 300, voteCount: 3000 }),
        candidate({ title: 'The Office', popularity: 4, voteCount: 3 }),
      ],
      { parsedTitle: 'The Office', parsedYear: null }
    );

    expect(matched).toBe(true);
    expect(best?.popularity).toBe(300);
    expect(best?.reason).toContain('broken by popularity');
  });

  /** A7-05: a rival of another name is not a stub; popularity must not pick between them. */
  it('does not break a tie by popularity against a differently named rival', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'The Piper', year: 2015, popularity: 12, voteCount: 40 }),
        candidate({ title: 'Piper', year: null, popularity: 2, voteCount: 1 }),
      ],
      { parsedTitle: 'Piper', parsedYear: 2016 }
    );

    expect(matched).toBe(false);
    expect(best?.reason).not.toContain('broken by');
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
    expect(matched).toBe(false); // popularity decides only against a stub (owner, 2026-11-07)
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

describe('other alphabets', () => {
  it.each(['七人の侍', 'Брат', 'Ζ', 'शोले', 'พี่มาก'])('%s is itself', (name) => {
    expect(titleSimilarity(name, name)).toBe(1);
  });

  it('a title in another alphabet matches by its original title', () => {
    const { matched, best } = pickBest(
      [candidate({ title: 'Seven Samurai', originalTitle: '七人の侍', year: 1954 })],
      { parsedTitle: '七人の侍', parsedYear: 1954 }
    );
    expect(matched).toBe(true);
    expect(best?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('names sharing only a number do not match', () => {
    expect(titleSimilarity('Брат 2', 'Сестра 2')).toBeLessThan(0.5);
    expect(titleSimilarity('七人の侍 2', '東京物語 2')).toBeLessThan(0.75);
    const { matched } = pickBest([candidate({ title: 'Сестра 2', year: 2000 })], {
      parsedTitle: 'Брат 2',
      parsedYear: 2000,
    });
    expect(matched).toBe(false);
  });

  it('accents on Latin letters still do not count', () => {
    expect(titleSimilarity('Amélie', 'Amelie')).toBe(1);
  });
});

describe('numbers at the end of a title', () => {
  const one = (parsedTitle: string, title: string) =>
    pickBest([candidate({ title })], { parsedTitle, parsedYear: null }).matched;

  it.each([
    ['Toy Story 2', 'Toy Story 3'],
    ['Rocky IV', 'Rocky V'],
    ['Toy Story', 'Toy Story 2'],
    ['Ocean 12', 'Ocean 13'],
    ['1917', '1918'],
    ['2012', '2010'],
  ])('%s is not %s', (parsed, title) => {
    expect(one(parsed, title)).toBe(false);
  });

  it.each([
    ['Toy Story 2', 'Toy Story 2'],
    ['Rocky 4', 'Rocky IV'],
    ['Rocky IV', 'Rocky 4'],
    ['Terminator 2', 'Terminator 2: Judgment Day'],
    ['Alien 3', 'Alien³'],
    ['Malcolm X', 'Malcolm X'],
    ['Dune Part Two', 'Dune: Part 2'],
  ])('%s is %s', (parsed, title) => {
    expect(one(parsed, title)).toBe(true);
  });

  it('another name of the right number still counts', () => {
    const { matched } = pickBest(
      [candidate({ title: 'Toy Story 3', altTitles: ['Toy Story 2'] })],
      { parsedTitle: 'Toy Story 2', parsedYear: null }
    );
    expect(matched).toBe(true);
  });

  it('the right number beats the wrong one with no doubt', () => {
    const { best, matched } = pickBest(
      [candidate({ title: 'Toy Story 3', year: 2010 }), candidate({ title: 'Toy Story 2', year: 1999 })],
      { parsedTitle: 'Toy Story 2', parsedYear: null }
    );
    expect(matched).toBe(true);
    expect(best?.title).toBe('Toy Story 2');
  });
});

/**
 * The owner's choice (review 2026-11, finding 18): `Dune.mkv` with the film of
 * 1984 and the film of 2021 in the answers went to the more popular one.
 */
describe('two real films of one name', () => {
  const dune = [
    candidate({ title: 'Dune', year: 1984, popularity: 20, voteCount: 2000 }),
    candidate({ title: 'Dune', year: 2021, popularity: 300, voteCount: 11000 }),
  ];

  it('with no year in the file, go to Needs attention', () => {
    const { matched, best } = pickBest(dune, { parsedTitle: 'Dune', parsedYear: null });
    expect(matched).toBe(false);
    expect(best?.reason).toContain('ambiguous');
  });

  it('with no year, even ten times the votes do not settle it', () => {
    const { matched } = pickBest(
      [
        candidate({ title: 'Solaris', year: 1972, popularity: 10, voteCount: 1500 }),
        candidate({ title: 'Solaris', year: 2002, popularity: 40, voteCount: 15000 }),
      ],
      { parsedTitle: 'Solaris', parsedYear: null }
    );
    expect(matched).toBe(false);
  });

  it('with a year in the file, the year decides', () => {
    const { matched, best } = pickBest(dune, { parsedTitle: 'Dune', parsedYear: 1984 });
    expect(matched).toBe(true);
    expect(best?.year).toBe(1984);
  });

  it('popularity alone never decides between two with real votes', () => {
    const { matched } = pickBest(
      [
        candidate({ title: 'The Father', year: 2020, popularity: 20, voteCount: 2500 }),
        candidate({ title: 'The Father', year: 2020, popularity: 3, voteCount: 400 }),
      ],
      { parsedTitle: 'The Father', parsedYear: 2020 }
    );
    expect(matched).toBe(false);
  });

  it('with no year, a stub beside the film does not get in the way', () => {
    for (const stub of [0, 2, 49]) {
      const { matched, best } = pickBest(
        [
          candidate({ title: 'Heat', year: 1995, popularity: 40, voteCount: 8000 }),
          candidate({ title: 'Heat', year: 1972, popularity: 1, voteCount: stub }),
        ],
        { parsedTitle: 'Heat', parsedYear: null }
      );
      expect(matched).toBe(true);
      expect(best?.year).toBe(1995);
    }
  });

  it('with no year, one real film and one stub and a second real film is refused', () => {
    const { matched } = pickBest(
      [
        candidate({ title: 'Heat', year: 1995, popularity: 40, voteCount: 8000 }),
        candidate({ title: 'Heat', year: 1972, popularity: 1, voteCount: 2 }),
        candidate({ title: 'Heat', year: 1986, popularity: 5, voteCount: 300 }),
      ],
      { parsedTitle: 'Heat', parsedYear: null }
    );
    expect(matched).toBe(false);
  });

  it('a film called just that is not sharing its name with one with an article', () => {
    const { matched, best } = pickBest(
      [
        candidate({ title: 'Heat', year: 1995, popularity: 60, voteCount: 8868 }),
        candidate({ title: 'The Heat', year: 2013, popularity: 15, voteCount: 4313 }),
      ],
      { parsedTitle: 'Heat', parsedYear: null }
    );
    expect(matched).toBe(true);
    expect(best?.year).toBe(1995);
  });

  it('votes we were not told are no sign of a stub', () => {
    const { matched } = pickBest(
      [
        candidate({ title: 'The Office', popularity: 300 }),
        candidate({ title: 'The Office', popularity: 4 }),
      ],
      { parsedTitle: 'The Office', parsedYear: null }
    );
    expect(matched).toBe(false);
  });
});
