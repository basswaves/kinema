/**
 * Matching orchestration: parsed files → real titles.
 *
 * Files are grouped by parsed title before anything is fetched, so a 12-episode
 * season costs one search and one metadata fetch rather than twelve. That
 * matters for OMDb's 1,000/day budget and for TVmaze's rate limit.
 *
 * Every group ends up either linked with a confidence score, or explicitly
 * marked unmatched with a reason — never silently skipped.
 */
import type { MediaFile } from '../library/api';
import {
  linkFileToTitle,
  saveEpisodes,
  saveTitle,
  type StoredTitle,
} from './api';
import {
  omdbGetMovie,
  omdbSearch,
  tmdbGetEpisodes,
  tmdbGetTitle,
  tmdbSearch,
  tvmazeGetEpisodes,
  tvmazeGetShow,
  tvmazeSearch,
} from './providers';
import { pickBest, type Candidate, type ScoreContext } from './score';

export interface MatchProgress {
  groupsTotal: number;
  groupsDone: number;
  matched: number;
  unmatched: number;
  currentTitle: string;
}

export interface MatchOutcome {
  matched: number;
  unmatched: number;
  errors: string[];
}

interface FileGroup {
  key: string;
  title: string;
  year: number | null;
  isSeries: boolean;
  files: MediaFile[];
  maxSeason: number | null;
}

/** Group by parsed title so each distinct show/film is resolved once. */
export function groupFiles(files: MediaFile[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();

  for (const file of files) {
    if (!file.parsed_title) continue;

    // A series is identified by having episode numbering, not by which folder
    // it came from — a mislabelled root should not force the wrong provider.
    const isSeries = file.parsed_season !== null || file.parsed_episode !== null;
    const key = `${isSeries ? 'tv' : 'movie'}::${file.parsed_title.toLowerCase()}::${
      isSeries ? '' : file.parsed_year ?? ''
    }`;

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: file.parsed_title,
        year: file.parsed_year,
        isSeries,
        files: [],
        maxSeason: null,
      };
      groups.set(key, group);
    }

    group.files.push(file);
    if (file.parsed_season !== null) {
      group.maxSeason = Math.max(group.maxSeason ?? 0, file.parsed_season);
    }
    // A movie group's year comes from whichever file has one.
    if (!group.year && file.parsed_year) group.year = file.parsed_year;
  }

  return [...groups.values()];
}

export interface ProviderKeys {
  tmdb: string | null;
  omdb: string | null;
}

/**
 * Which provider handles a group.
 *
 * TMDB first when a key exists: it is the only source here with backdrops,
 * logos and episode stills, which is what a poster-and-hero UI needs. Without
 * it, TV still works fully via keyless TVmaze, and movies fall back to OMDb
 * (poster only, no fanart).
 */
function providerFor(group: FileGroup, keys: ProviderKeys): 'tmdb' | 'tvmaze' | 'omdb' | null {
  if (keys.tmdb) return 'tmdb';
  if (group.isSeries) return 'tvmaze';
  return keys.omdb ? 'omdb' : null;
}

async function resolveGroup(
  group: FileGroup,
  keys: ProviderKeys
): Promise<{ titleId: number | null; confidence: number; reason: string; matched: boolean }> {
  const ctx: ScoreContext = {
    parsedTitle: group.title,
    parsedYear: group.year,
    maxSeason: group.maxSeason,
  };

  const provider = providerFor(group, keys);
  if (!provider) {
    return {
      titleId: null,
      confidence: 0,
      reason: 'no provider available for movies (add a TMDB or OMDb key)',
      matched: false,
    };
  }

  const kind = group.isSeries ? 'series' : 'movie';
  let candidates: Candidate[];

  if (provider === 'tmdb') {
    candidates = await tmdbSearch(keys.tmdb as string, group.title, group.year, kind);
  } else if (provider === 'tvmaze') {
    candidates = await tvmazeSearch(group.title);
  } else {
    candidates = await omdbSearch(keys.omdb as string, group.title, group.year);
  }

  if (candidates.length === 0) {
    return { titleId: null, confidence: 0, reason: 'no candidates returned', matched: false };
  }

  const { best, matched } = pickBest(candidates, ctx);
  if (!best) {
    return { titleId: null, confidence: 0, reason: 'no candidates scored', matched: false };
  }

  // Below threshold or ambiguous: record why, but do not fetch or link. The
  // file stays visible as work to review.
  if (!matched) {
    return { titleId: null, confidence: best.confidence, reason: best.reason, matched: false };
  }

  const metadata =
    provider === 'tmdb'
      ? await tmdbGetTitle(keys.tmdb as string, best.providerId, kind)
      : provider === 'tvmaze'
        ? await tvmazeGetShow(best.providerId)
        : await omdbGetMovie(keys.omdb as string, best.providerId);

  const titleId = await saveTitle(metadata);

  if (group.isSeries) {
    const episodes =
      provider === 'tmdb'
        ? await tmdbGetEpisodes(keys.tmdb as string, best.providerId)
        : await tvmazeGetEpisodes(best.providerId);
    if (episodes.length > 0) await saveEpisodes(titleId, episodes);
  }

  return { titleId, confidence: best.confidence, reason: best.reason, matched: true };
}

export async function matchFiles(
  files: MediaFile[],
  keys: ProviderKeys,
  onProgress: (progress: MatchProgress) => void
): Promise<MatchOutcome> {
  const groups = groupFiles(files);
  const outcome: MatchOutcome = { matched: 0, unmatched: 0, errors: [] };

  let done = 0;
  for (const group of groups) {
    onProgress({
      groupsTotal: groups.length,
      groupsDone: done,
      matched: outcome.matched,
      unmatched: outcome.unmatched,
      currentTitle: group.title,
    });

    try {
      const result = await resolveGroup(group, keys);

      for (const file of group.files) {
        await linkFileToTitle(
          file.id,
          result.titleId,
          result.confidence,
          result.reason,
          result.matched ? 'matched' : 'unmatched'
        );
      }

      if (result.matched) outcome.matched += group.files.length;
      else outcome.unmatched += group.files.length;
    } catch (e) {
      const message = `${group.title}: ${e instanceof Error ? e.message : String(e)}`;
      outcome.errors.push(message);

      // A provider failure must not leave files in limbo — mark them for
      // review with the reason attached.
      for (const file of group.files) {
        await linkFileToTitle(file.id, null, 0, message, 'unmatched').catch(() => undefined);
      }
      outcome.unmatched += group.files.length;
    }

    done++;
  }

  onProgress({
    groupsTotal: groups.length,
    groupsDone: done,
    matched: outcome.matched,
    unmatched: outcome.unmatched,
    currentTitle: '',
  });

  return outcome;
}

export type { StoredTitle };
