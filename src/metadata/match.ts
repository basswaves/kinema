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
  getSetting,
  linkFilesToTitle,
  listTitlesNeedingDetail,
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
import { nfoForGroup, resolveNfoIds, sourceName } from './nfo';

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

export interface FileGroup {
  key: string;
  title: string;
  year: number | null;
  isSeries: boolean;
  files: MediaFile[];
  maxSeason: number | null;
  /**
   * No title could be read from the file name or any folder above it. Only
   * the review queue asks for these (`includeUntitled`); there is nothing to
   * search a provider for, so the matcher never sees them.
   */
  untitled?: boolean;
}

/**
 * Group by parsed title so each distinct show/film is resolved once.
 *
 * `includeUntitled` makes a group of one for each file with no title at all,
 * named after the file — for the review queue, which is the one place such a
 * file can be seen and fixed by hand. They used to be skipped everywhere,
 * so a file the parser could not name was in the library and on no screen.
 */
export function groupFiles(
  files: MediaFile[],
  { includeUntitled = false }: { includeUntitled?: boolean } = {}
): FileGroup[] {
  const groups = new Map<string, FileGroup>();

  for (const file of files) {
    if (!file.parsed_title) {
      if (includeUntitled) {
        groups.set(`untitled::${file.id}`, {
          key: `untitled::${file.id}`,
          title: file.file_name.replace(/\.[^.]+$/, ''),
          year: null,
          isSeries: file.parsed_season !== null || file.parsed_episode !== null,
          files: [file],
          maxSeason: file.parsed_season,
          untitled: true,
        });
      }
      continue;
    }

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

export type Provider = 'tmdb' | 'tvmaze' | 'omdb';

/**
 * Read the provider keys from the database, at the moment they are needed.
 *
 * Never take these from component state: a key captured in a closure before it
 * was entered once made matching fall back to OMDb while the UI showed TMDB as
 * active, with no error anywhere. State also reflects unsaved edits in the
 * input boxes, and only what was saved should be used.
 */
export async function loadProviderKeys(): Promise<ProviderKeys> {
  const [tmdb, omdb] = await Promise.all([
    getSetting('tmdb_api_key'),
    getSetting('omdb_api_key'),
  ]);
  return { tmdb: tmdb?.trim() || null, omdb: omdb?.trim() || null };
}

/**
 * Which provider handles a title of this kind.
 *
 * TMDB first when a key exists: it is the only source here with backdrops,
 * logos and episode stills, which is what a poster-and-hero UI needs. Without
 * it, TV still works fully via keyless TVmaze, and movies fall back to OMDb
 * (poster only, no fanart).
 */
export function providerForKind(isSeries: boolean, keys: ProviderKeys): Provider | null {
  if (keys.tmdb) return 'tmdb';
  if (isSeries) return 'tvmaze';
  return keys.omdb ? 'omdb' : null;
}

function providerFor(group: FileGroup, keys: ProviderKeys): Provider | null {
  return providerForKind(group.isSeries, keys);
}

/** Search one provider. Shared so manual and automatic matching cannot diverge. */
export function searchProvider(
  provider: Provider,
  keys: ProviderKeys,
  title: string,
  year: number | null,
  isSeries: boolean
): Promise<Candidate[]> {
  if (provider === 'tmdb') {
    return tmdbSearch(keys.tmdb as string, title, year, isSeries ? 'series' : 'movie');
  }
  if (provider === 'tvmaze') return tvmazeSearch(title);
  return omdbSearch(keys.omdb as string, title, year);
}

/**
 * Fetch a chosen title and its episodes, store both, and point every file in
 * the group at it.
 *
 * Both the automatic and the manual path end here, so a title picked by hand is
 * stored exactly like one picked by the scorer — only the confidence and reason
 * differ, which is what makes a manual fix auditable afterwards.
 */
export async function applyMatch(
  files: MediaFile[],
  provider: Provider,
  providerId: string,
  isSeries: boolean,
  keys: ProviderKeys,
  confidence: number,
  reason: string
): Promise<number> {
  const kind = isSeries ? 'series' : 'movie';

  // OMDb has no series data and TVmaze has no films. Either mismatch would
  // happily store a title of the wrong kind instead of failing, so refuse the
  // combination rather than rely on callers picking the provider correctly.
  if (isSeries && provider === 'omdb') {
    throw new Error('OMDb has no TV data — use TMDB or TVmaze for a series.');
  }
  if (!isSeries && provider === 'tvmaze') {
    throw new Error('TVmaze has no film data — use TMDB or OMDb for a movie.');
  }

  const metadata =
    provider === 'tmdb'
      ? await tmdbGetTitle(keys.tmdb as string, providerId, kind)
      : provider === 'tvmaze'
        ? await tvmazeGetShow(providerId)
        : await omdbGetMovie(keys.omdb as string, providerId);

  const titleId = await saveTitle(metadata);

  if (isSeries) {
    const episodes =
      provider === 'tmdb'
        ? await tmdbGetEpisodes(keys.tmdb as string, providerId)
        : await tvmazeGetEpisodes(providerId);
    if (episodes.length > 0) await saveEpisodes(titleId, episodes);
  }

  await linkFilesToTitle(
    files.map((f) => f.id),
    titleId,
    confidence,
    reason,
    'matched'
  );

  return titleId;
}

export interface DetailBackfill {
  found: number;
  none: number;
  errors: string[];
}

/**
 * Re-fetch titles matched before some part of the TMDB response was being used.
 *
 * A fresh match gets its trailer key, logo and cast from the detail fetch for
 * free; this exists only for titles that predate each of those. It re-requests
 * the whole detail rather than one field, because TMDB returns all of it in a
 * single response anyway — asking separately would be three round trips for the
 * data of one.
 *
 * Self-limiting: `list_titles_needing_detail` only returns rows where a field is
 * still `NULL`, and this pass writes an empty string where TMDB genuinely has
 * nothing. Without that, every title without a logo would be re-fetched forever.
 */
export async function backfillTitleDetails(): Promise<DetailBackfill> {
  const result: DetailBackfill = { found: 0, none: 0, errors: [] };
  const keys = await loadProviderKeys();
  if (!keys.tmdb) return result;

  for (const target of await listTitlesNeedingDetail()) {
    const kind = target.kind === 'series' ? 'series' : 'movie';
    try {
      const metadata = await tmdbGetTitle(keys.tmdb, target.tmdb_id, kind);
      // Straight back through `saveTitle`, so a backfilled title is stored by
      // exactly the same path as a freshly matched one — including the cast
      // rows, which nothing else writes.
      await saveTitle(metadata);
      if (metadata.logo_url || metadata.trailer_key) result.found++;
      else result.none++;
    } catch (e) {
      result.errors.push(`${target.tmdb_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

/**
 * Take files out of the review queue without matching them — trailers, samples
 * and extras are not work, and leaving them in the list forever would make
 * "needs attention" meaningless. Reversible: the files keep their parse data.
 */
export async function ignoreFiles(files: MediaFile[]): Promise<void> {
  await linkFilesToTitle(
    files.map((f) => f.id),
    null,
    null,
    'ignored by hand',
    'ignored'
  );
}

/**
 * Put files back into the review queue: un-ignoring, and undoing a match that
 * turned out to be wrong. Both are the same operation — drop the link and the
 * verdict, keep the parse data — so they share one implementation.
 */
export async function returnFilesToReview(files: MediaFile[]): Promise<void> {
  await linkFilesToTitle(
    files.map((f) => f.id),
    null,
    null,
    null,
    'parsed'
  );
}

/**
 * Decide which provider entry a group refers to. Deliberately fetches nothing
 * beyond the search: a group that fails to match should cost one request, and
 * the decision stays separate from the act of storing it.
 */
async function resolveGroup(
  group: FileGroup,
  keys: ProviderKeys
): Promise<{
  provider: Provider | null;
  providerId: string | null;
  confidence: number;
  reason: string;
  matched: boolean;
}> {
  /**
   * An NFO beside the files outranks everything below.
   *
   * With an id there is nothing to score: somebody already decided, usually by
   * hand, and the whole class of confidently-wrong matches disappears for this
   * group. Without an id, its title and year still replace the ones guessit
   * took off the filename — a curated title is a better question to ask the
   * provider, though the answer still has to clear the normal threshold.
   */
  const nfo = await nfoForGroup(group).catch(() => null);

  if (nfo) {
    const resolved = await resolveNfoIds(nfo, group.isSeries, keys).catch(() => null);
    if (resolved) {
      return {
        provider: resolved.provider,
        providerId: resolved.providerId,
        confidence: 1,
        reason: `nfo: ${resolved.via} from ${sourceName(nfo.source)}`,
        matched: true,
      };
    }
  }

  // The NFO's own title, when it has one, is what gets searched from here on.
  // Recorded in the reason either way: a match made against a different title
  // from the one on the filename should be obvious when reading it back.
  let searchTitle = group.title;
  let searchYear = group.year;
  let nfoNote = '';
  if (nfo?.title?.trim()) {
    searchTitle = nfo.title.trim();
    searchYear = nfo.year ?? group.year;
    nfoNote = ` · searched as “${searchTitle}” from ${sourceName(nfo.source)}`;
  }

  const ctx: ScoreContext = {
    parsedTitle: searchTitle,
    parsedYear: searchYear,
    maxSeason: group.maxSeason,
  };

  const provider = providerFor(group, keys);
  if (!provider) {
    return {
      provider: null,
      providerId: null,
      confidence: 0,
      reason: 'no provider available for movies (add a TMDB or OMDb key)',
      matched: false,
    };
  }

  const candidates = await searchProvider(provider, keys, searchTitle, searchYear, group.isSeries);

  if (candidates.length === 0) {
    return {
      provider,
      providerId: null,
      confidence: 0,
      reason: `no candidates returned${nfoNote}`,
      matched: false,
    };
  }

  const { best, matched } = pickBest(candidates, ctx);
  if (!best) {
    return {
      provider,
      providerId: null,
      confidence: 0,
      reason: `no candidates scored${nfoNote}`,
      matched: false,
    };
  }

  // Below threshold or ambiguous: report why, but fetch nothing. The caller
  // marks the files for review and they stay visible as work.
  return {
    provider,
    providerId: best.providerId,
    confidence: best.confidence,
    reason: `${best.reason}${nfoNote}`,
    matched,
  };
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

      if (result.matched && result.provider && result.providerId) {
        await applyMatch(
          group.files,
          result.provider,
          result.providerId,
          group.isSeries,
          keys,
          result.confidence,
          result.reason
        );
        outcome.matched += group.files.length;
      } else {
        await linkFilesToTitle(
          group.files.map((f) => f.id),
          null,
          result.confidence,
          result.reason,
          'unmatched'
        );
        outcome.unmatched += group.files.length;
      }
    } catch (e) {
      const message = `${group.title}: ${e instanceof Error ? e.message : String(e)}`;
      outcome.errors.push(message);

      // A provider failure must not leave files in limbo — mark them for
      // review with the reason attached.
      await linkFilesToTitle(
        group.files.map((f) => f.id),
        null,
        0,
        message,
        'unmatched'
      ).catch(() => undefined);
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
