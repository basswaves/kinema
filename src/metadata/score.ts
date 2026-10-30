/**
 * Match scoring.
 *
 * The governing rule: a *wrong* match is far worse than no match. An unmatched
 * file is visible work; a confidently wrong one silently corrupts the library
 * and is only noticed later, by accident. So everything here is biased toward
 * refusing to answer rather than guessing, and anything below the confidence
 * threshold is surfaced for manual review instead of being applied.
 */

/** Articles that carry no identifying information across naming conventions. */
const LEADING_ARTICLES = /^(the|a|an)\s+/i;

const NUMBER_WORDS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
};

/**
 * "Part Two", "Part II" and "Part 2" are one name: a number after "part",
 * "chapter" or "volume" is written as a digit. Only after those words —
 * "Ocean's Eleven" and "Apollo 13" keep their own spelling.
 */
const NUMBERED =
  /\b(part|chapter|vol|volume)\s+(one|two|three|four|five|six|seven|eight|nine|ten|viii|vii|vi|iv|v|ix|x|iii|ii|i)\b/g;

/**
 * Normalise a title for comparison: strip diacritics, punctuation, articles
 * and case, then collapse whitespace. "Marvel's Daredevil" and
 * "Marvel s Daredevil" must land on the same string.
 */
export function normaliseTitle(raw: string): string {
  return literalTitle(raw).replace(LEADING_ARTICLES, '');
}

/** The same, keeping a leading article — for telling "Strays" from "The Strays". */
function literalTitle(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(NUMBERED, (_, word: string, n: string) => `${word} ${NUMBER_WORDS[n] ?? n}`);
}

/** The part number a title names ("Dune: Part Two" → 2), or null. */
export function partOf(title: string): number | null {
  const found = /\bpart (\d+)\b/.exec(literalTitle(title));
  return found ? Number(found[1]) : null;
}

/** The part of a title before its first ": " — "Batman v Superman" — or null. */
function beforeColon(title: string): string | null {
  const cut = title.indexOf(': ');
  return cut > 0 ? title.slice(0, cut) : null;
}

/** Levenshtein distance, iterative with a single row buffer. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr.slice();
  }
  return prev[b.length];
}

/** 0..1 similarity, edit-distance based. */
function editSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** 0..1 token overlap (Jaccard), which tolerates word order and extra words. */
function tokenSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

export function titleSimilarity(a: string, b: string): number {
  const na = normaliseTitle(a);
  const nb = normaliseTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  // Both measures matter: edit distance catches typos and small differences,
  // token overlap catches subtitle/word-order variation. Taking the max means
  // a strong signal from either is enough.
  return Math.max(editSimilarity(na, nb), tokenSimilarity(na, nb));
}

export interface Candidate {
  providerId: string;
  title: string;
  year: number | null;
  /** For series: how many episodes the provider knows about, if available. */
  episodeCount?: number | null;
  /**
   * Provider's own popularity signal (TMDB `popularity`, TVmaze `weight`).
   * Used only to break ties between identically-titled candidates.
   */
  popularity?: number | null;
  /** Number of user votes, a proxy for "this is the entry people mean". */
  voteCount?: number | null;
  /** The title in its own language, when the provider gives one. */
  originalTitle?: string | null;
  /**
   * The provider's other names for it ("Star Wars: Episode IV - A New Hope"),
   * fetched only for close candidates when the plain names did not decide.
   */
  altTitles?: string[] | null;
  /**
   * Display only, for the manual fix-match picker — scoring ignores both.
   * Choosing between two same-named entries by hand is far easier with the
   * poster and one line of plot than with a title and a year.
   */
  posterUrl?: string | null;
  overview?: string | null;
}

export interface ScoredCandidate extends Candidate {
  /** 0..1: what is stored and shown. */
  confidence: number;
  /**
   * The same before it is held to 0..1, which is what candidates are compared
   * by. Clamping first made a year-exact 1.12 and a year-±1 1.04 both 1.0 —
   * a tie between two films that were not alike at all.
   */
  score: number;
  reason: string;
}

export interface ScoreContext {
  parsedTitle: string;
  parsedYear: number | null;
  /**
   * Other ways the file names the same thing — "Spider-Man" beside
   * "Spider-Man - Across the Spider-Verse". A candidate is scored against
   * each and keeps its best.
   */
  otherParsedTitles?: string[];
  /** Highest season/episode seen for this title in the library, if series. */
  maxSeason?: number | null;
}

/**
 * Confidence threshold. Below this a file is left unmatched and surfaced for
 * review rather than linked. Deliberately strict.
 */
export const MATCH_THRESHOLD = 0.75;

/** The margin the best must have over every other candidate. Settled. */
export const MATCH_MARGIN = 0.05;

/**
 * How much a name other than the candidate's own title counts. Less than the
 * title itself, so a film called just that beats one only also known by it:
 * "Alien" is "Alien", not "Alien: Covenant" before its colon.
 */
const BEFORE_COLON_WEIGHT = 0.9;
const OTHER_NAME_WEIGHT = 0.95;

/**
 * A literal match including the leading article ("Strays" for "Strays", not
 * "The Strays"). Smaller than the margin: it puts the literal one first, but
 * on its own never decides — "The Strays" against two films called "The
 * Strays" is still a tie.
 */
const ARTICLE_BONUS = 0.02;

/** A candidate naming another part than the file, or none when the file names one. */
const OTHER_PART_PENALTY = 0.15;

interface NameMatch {
  similarity: number;
  /** The candidate's name that matched best. */
  name: string;
  /** Why that name, when it is not the candidate's title. */
  via: string;
}

/** The best of one parsed name against every name a candidate goes by. */
function bestName(parsed: string, candidate: Candidate): NameMatch {
  let best: NameMatch = {
    similarity: titleSimilarity(parsed, candidate.title),
    name: candidate.title,
    via: '',
  };
  const others: Array<[string | null | undefined, number, string]> = [
    [beforeColon(candidate.title), BEFORE_COLON_WEIGHT, 'before ":"'],
    [candidate.originalTitle, OTHER_NAME_WEIGHT, 'original title'],
    ...(candidate.altTitles ?? []).map((t): [string, number, string] => [
      t,
      OTHER_NAME_WEIGHT,
      `also "${t}"`,
    ]),
  ];
  for (const [name, weight, via] of others) {
    if (!name) continue;
    const similarity = titleSimilarity(parsed, name) * weight;
    if (similarity > best.similarity + 0.001) best = { similarity, name, via };
  }
  return best;
}

export function scoreCandidate(candidate: Candidate, ctx: ScoreContext): ScoredCandidate {
  let parsed = ctx.parsedTitle;
  let match = bestName(parsed, candidate);
  for (const other of ctx.otherParsedTitles ?? []) {
    const alt = bestName(other, candidate);
    if (alt.similarity > match.similarity + 0.001) {
      match = alt;
      parsed = other;
    }
  }
  const { similarity, name, via } = match;
  const reasons: string[] = [`title ${(similarity * 100).toFixed(0)}%${via ? ` (${via})` : ''}`];

  // Title similarity is the backbone; nothing else can rescue a poor title.
  let confidence = similarity;

  if (!via && similarity === 1 && literalTitle(parsed) === literalTitle(name)) {
    confidence += ARTICLE_BONUS;
  }

  // "Dune Part 2" is not "The Dune", nor "Dune" before a colon.
  const part = partOf(parsed);
  const theirs = partOf(name);
  if (part !== null && theirs !== part) {
    confidence -= OTHER_PART_PENALTY;
    reasons.push(theirs === null ? `no part ${part}` : `part ${theirs}, not ${part}`);
  }

  if (ctx.parsedYear && candidate.year) {
    const delta = Math.abs(ctx.parsedYear - candidate.year);
    if (delta === 0) {
      confidence += 0.12;
      reasons.push('year exact');
    } else if (delta === 1) {
      // Release-year disagreements of one year are extremely common between
      // festival/theatrical/regional dates — not evidence against a match.
      confidence += 0.04;
      reasons.push('year ±1');
    } else {
      confidence -= 0.3;
      reasons.push(`year off by ${delta}`);
    }
  } else if (ctx.parsedYear && !candidate.year) {
    reasons.push('no candidate year');
  }

  // A series that claims fewer seasons than we have files for is suspicious.
  if (ctx.maxSeason && candidate.episodeCount === 0) {
    confidence -= 0.15;
    reasons.push('candidate has no episodes');
  }

  return {
    ...candidate,
    confidence: Math.max(0, Math.min(1, confidence)),
    score: confidence,
    reason: reasons.join(', '),
  };
}

/**
 * Votes that settle a tie: the best has at least ten times the other's and at
 * least this many. TMDB keeps stubs beside the real film under the same name
 * and year — 1828 votes against 95, 613 against 2 — where popularity, this
 * week's traffic, can be as close as 5 against 2. Two real films have votes of
 * the same order, and stay a coin-flip.
 */
const VOTES_DECISIVE = 50;
const VOTES_RATIO = 10;
const POPULARITY_RATIO = 3;

/** What the exact year is worth over one a year off (0.12 against 0.04). */
const YEAR_BAND = 0.08 + 0.001;

function morePopular(a: Candidate, b: Candidate): boolean {
  const pa = a.popularity ?? 0;
  return pa > 0 && pa >= Math.max((b.popularity ?? 0) * POPULARITY_RATIO, 1);
}

function moreVoted(a: Candidate, b: Candidate): boolean {
  const va = a.voteCount ?? 0;
  return va >= VOTES_DECISIVE && va >= (b.voteCount ?? 0) * VOTES_RATIO;
}

/**
 * Pick the best candidate, but only if it is both good enough *and* clearly
 * better than every other. Two near-identical scores mean genuine ambiguity
 * (remakes, series with the same name), which is precisely when guessing does
 * the most damage.
 */
export function pickBest(
  candidates: Candidate[],
  ctx: ScoreContext
): { best: ScoredCandidate | null; matched: boolean; all: ScoredCandidate[] } {
  const scored = candidates
    .map((c) => scoreCandidate(c, ctx))
    .sort((a, b) => {
      const byScore = b.score - a.score;
      if (Math.abs(byScore) > 0.001) return byScore;
      // Equal score: the more popular entry first, so `best` is the one
      // people actually mean rather than whatever the API happened to list.
      return (b.popularity ?? 0) - (a.popularity ?? 0);
    });

  if (scored.length === 0) return { best: null, matched: false, all: [] };

  // A file's year is often a release a year after the film's: "Film 2020"
  // for a film of 2019. When the same name also exists as a stub with the
  // exact year, the year alone (0.08) would pick the stub. An entry one year
  // off that is overwhelmingly the one people mean — by votes *and*
  // popularity — goes first instead, as the plain tie-break did when scores
  // were clamped.
  const top = scored[0];
  const outweighed = scored.filter(
    (c) =>
      c !== top &&
      top.score - c.score <= YEAR_BAND &&
      normaliseTitle(c.title) === normaliseTitle(top.title) &&
      moreVoted(c, top) &&
      morePopular(c, top)
  );
  if (outweighed.length === 1) {
    const [c] = outweighed;
    scored.splice(scored.indexOf(c), 1);
    scored.unshift({ ...c, score: top.score, reason: `${c.reason}; over "${top.title}" by votes` });
  }

  const best = scored[0];
  // Every candidate within the margin, not only the second: a third as close
  // is as much reason to doubt.
  const close = scored.slice(1).filter((c) => best.score - c.score < MATCH_MARGIN);

  if (close.length > 0) {
    // Databases routinely hold several entries with the same name — the real
    // film plus stubs, documentaries or regional duplicates. That is not
    // genuine ambiguity if one is overwhelmingly the entry people mean, so
    // popularity or votes break the tie, as long as neither points the other
    // way. Only a genuine coin-flip is refused.
    const runnerUp = close[0];
    const contradicted = close.some((c) => morePopular(c, best) || moreVoted(c, best));
    const popular = close.every((c) => morePopular(best, c));
    const voted = close.every((c) => moreVoted(best, c));

    if (!contradicted && (popular || voted)) {
      return {
        best: {
          ...best,
          reason: `${best.reason}; tie vs "${runnerUp.title}" broken by ${
            popular ? 'popularity' : 'votes'
          }`,
        },
        matched: best.confidence >= MATCH_THRESHOLD,
        all: scored,
      };
    }

    return {
      best: { ...best, reason: `${best.reason}; ambiguous vs "${runnerUp.title}"` },
      matched: false,
      all: scored,
    };
  }

  return { best, matched: best.confidence >= MATCH_THRESHOLD, all: scored };
}
