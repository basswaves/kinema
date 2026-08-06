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

/**
 * Normalise a title for comparison: strip diacritics, punctuation, articles
 * and case, then collapse whitespace. "Marvel's Daredevil" and
 * "Marvel s Daredevil" must land on the same string.
 */
export function normaliseTitle(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_ARTICLES, '');
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
}

export interface ScoredCandidate extends Candidate {
  confidence: number;
  reason: string;
}

export interface ScoreContext {
  parsedTitle: string;
  parsedYear: number | null;
  /** Highest season/episode seen for this title in the library, if series. */
  maxSeason?: number | null;
}

/**
 * Confidence threshold. Below this a file is left unmatched and surfaced for
 * review rather than linked. Deliberately strict.
 */
export const MATCH_THRESHOLD = 0.75;

export function scoreCandidate(candidate: Candidate, ctx: ScoreContext): ScoredCandidate {
  const similarity = titleSimilarity(ctx.parsedTitle, candidate.title);
  const reasons: string[] = [`title ${(similarity * 100).toFixed(0)}%`];

  // Title similarity is the backbone; nothing else can rescue a poor title.
  let confidence = similarity;

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
    reason: reasons.join(', '),
  };
}

/**
 * Pick the best candidate, but only if it is both good enough *and* clearly
 * better than the runner-up. Two near-identical scores mean genuine ambiguity
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
      const byConfidence = b.confidence - a.confidence;
      if (Math.abs(byConfidence) > 0.001) return byConfidence;
      // Equal confidence: the more popular entry first, so `best` is the one
      // people actually mean rather than whatever the API happened to list.
      return (b.popularity ?? 0) - (a.popularity ?? 0);
    });

  if (scored.length === 0) return { best: null, matched: false, all: [] };

  const best = scored[0];
  const runnerUp = scored[1];
  const tooClose = runnerUp !== undefined && best.confidence - runnerUp.confidence < 0.05;

  if (tooClose) {
    // Databases routinely hold several entries with the same name — the real
    // series plus stubs, documentaries or regional duplicates. That is not
    // genuine ambiguity if one is overwhelmingly the entry people mean, so
    // popularity breaks the tie. Only a genuine coin-flip is refused.
    const bestPopularity = best.popularity ?? 0;
    const runnerPopularity = runnerUp.popularity ?? 0;
    const decisive = bestPopularity > 0 && bestPopularity >= Math.max(runnerPopularity * 3, 1);

    if (decisive) {
      return {
        best: {
          ...best,
          reason: `${best.reason} — tie vs "${runnerUp.title}" broken by popularity`,
        },
        matched: best.confidence >= MATCH_THRESHOLD,
        all: scored,
      };
    }

    return {
      best: { ...best, reason: `${best.reason} — ambiguous vs "${runnerUp.title}"` },
      matched: false,
      all: scored,
    };
  }

  return { best, matched: best.confidence >= MATCH_THRESHOLD, all: scored };
}
