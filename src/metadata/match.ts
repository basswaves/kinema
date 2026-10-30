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
  ignoreFileIds,
  adoptProvider,
  listStaleTitles,
  listTitlesNeedingDetail,
  listFallbackTitles,
  markUpgradeChecked,
  recordMatch,
  recordProviderFailure,
  recordRefusal,
  returnToReview,
  saveEpisodes,
  saveTitle,
  type FallbackTitle,
  type StoredTitle,
} from './api';
import {
  omdbGetMovie,
  omdbSearch,
  tmdbAltTitles,
  tmdbFindByImdb,
  tmdbFindByTvdb,
  tmdbGetEpisodes,
  tmdbGetTitle,
  tmdbSearch,
  TmdbKeyRejected,
  Unreachable,
  tvmazeGetEpisodes,
  tvmazeGetShow,
  tvmazeSearch,
  tvmazeTvdbId,
} from './providers';
import {
  BUILTIN_REJECTED_KEY,
  BUILTIN_TMDB_KEY,
  chooseTmdbKey,
  usableBuiltinKey,
  type TmdbKeySource,
} from './builtinKey';
import {
  normaliseTitle,
  pickBest,
  type Candidate,
  type ScoreContext,
  type ScoredCandidate,
} from './score';
import { withoutQueries } from '../ui/errors';
import { explainUnreachable } from './reach';
import { wikidataGetMovie, wikidataSearch } from './wikidata';
import { idsInName, nfoForGroup, resolveIds, resolveNfoIds, sourceName, type NfoIds } from './nfo';
import { yieldToPlayback } from '../library/playback';

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
 * A file name as words to search with, for a file the parser found no title
 * in: no extension, no brackets, dots and underscores as spaces, and nothing
 * from the year or the first release tag on. "F1 [2025]" was sent to TMDB as
 * it was, brackets and year as words. The whole name when that leaves nothing.
 */
export function searchableName(fileName: string): string {
  const bare = fileName.replace(/\.[a-z0-9]{2,4}$/i, '');
  const words = bare
    .replace(/[[({][^\])}]*[\])}]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(
      /\s(?:19|20)\d{2}(?!\d)[\s\S]*$|\s(?:2160p|1080p|720p|480p|4k|uhd|bluray|blu ray|remux|web ?dl|webrip|hdtv|x26[45]|h ?26[45]|hevc)\b[\s\S]*$/i,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
  return words || bare;
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
          year: file.parsed_year,
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
      isSeries ? '' : (file.parsed_year ?? '')
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
  /** Whose TMDB key that is: one entered in Settings, or the app's own. */
  tmdbSource: TmdbKeySource | null;
  omdb: string | null;
}

export type Provider = 'tmdb' | 'tvmaze' | 'omdb' | 'wikidata';

/**
 * Read the provider keys from the database, at the moment they are needed.
 *
 * Never take these from component state: a key captured in a closure before it
 * was entered once made matching fall back to OMDb while the UI showed TMDB as
 * active, with no error anywhere. State also reflects unsaved edits in the
 * input boxes, and only what was saved should be used.
 */
export async function loadProviderKeys(): Promise<ProviderKeys> {
  const [own, omdb, rejected] = await Promise.all([
    getSetting('tmdb_api_key'),
    getSetting('omdb_api_key'),
    getSetting(BUILTIN_REJECTED_KEY),
  ]);
  const tmdb = chooseTmdbKey(own, usableBuiltinKey(BUILTIN_TMDB_KEY, rejected));
  return { tmdb: tmdb?.key ?? null, tmdbSource: tmdb?.source ?? null, omdb: omdb?.trim() || null };
}

/**
 * Which provider handles a title of this kind.
 *
 * TMDB first when a key exists — one from Settings, or the app's own
 * (builtinKey.ts): it is the only source here with backdrops,
 * logos and episode stills, which is what a poster-and-hero UI needs. Without
 * it, TV still works fully via keyless TVmaze, and movies fall back to OMDb
 * (a poster, but only with a key of the user's own) and then to keyless
 * Wikidata (everything but pictures).
 */
export function providerForKind(isSeries: boolean, keys: ProviderKeys): Provider {
  if (keys.tmdb) return 'tmdb';
  if (isSeries) return 'tvmaze';
  return keys.omdb ? 'omdb' : 'wikidata';
}

function providerFor(group: FileGroup, keys: ProviderKeys): Provider {
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
  if (provider === 'wikidata') return wikidataSearch(title);
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
    throw new Error('OMDb has no TV data. Use TMDB or TVmaze for a series.');
  }
  if (!isSeries && provider === 'tvmaze') {
    throw new Error('TVmaze has no movie data. Use TMDB or OMDb for a movie.');
  }
  if (isSeries && provider === 'wikidata') {
    throw new Error('Kinema reads only movies from Wikidata. Use TMDB or TVmaze for a series.');
  }

  const metadata =
    provider === 'tmdb'
      ? await tmdbGetTitle(keys.tmdb as string, providerId, kind)
      : provider === 'tvmaze'
        ? await tvmazeGetShow(providerId)
        : provider === 'wikidata'
          ? await wikidataGetMovie(providerId)
          : await omdbGetMovie(keys.omdb as string, providerId);

  const titleId = await saveTitle(metadata);

  if (isSeries) {
    const episodes =
      provider === 'tmdb'
        ? await tmdbGetEpisodes(keys.tmdb as string, providerId)
        : await tvmazeGetEpisodes(providerId);
    if (episodes.length > 0) await saveEpisodes(titleId, episodes);
  }

  await recordMatch(
    files.map((f) => f.id),
    titleId,
    confidence,
    reason
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
    await yieldToPlayback();
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

/** How many out-of-date titles one scan fetches again. */
const REFRESH_PER_SCAN = 40;

/**
 * Fetch again the titles whose TMDB data is older than TMDB lets it be kept.
 *
 * TMDB's terms allow caching their data for six months (`TMDB_MAX_AGE_SECS`
 * in metadata.rs). A few titles per scan, oldest first, each by the same path
 * a match takes — the title with its cast, and a series' episodes — so a
 * library catches up over a few launches instead of re-fetching itself at
 * once. Without a working key nothing can be refreshed, and what is stored
 * stays: deleting a library's posters would help nobody.
 */
export async function refreshStaleTitles(): Promise<DetailBackfill> {
  const result: DetailBackfill = { found: 0, none: 0, errors: [] };
  const keys = await loadProviderKeys();
  if (!keys.tmdb) return result;

  for (const target of await listStaleTitles(REFRESH_PER_SCAN)) {
    await yieldToPlayback();
    const kind = target.kind === 'series' ? 'series' : 'movie';
    try {
      const titleId = await saveTitle(await tmdbGetTitle(keys.tmdb, target.tmdb_id, kind));
      if (kind === 'series') {
        const episodes = await tmdbGetEpisodes(keys.tmdb, target.tmdb_id);
        if (episodes.length > 0) await saveEpisodes(titleId, episodes);
      }
      result.found++;
    } catch (e) {
      result.errors.push(`${target.tmdb_id}: ${e instanceof Error ? e.message : String(e)}`);
      // A refused key will be refused for every other title too.
      if (e instanceof TmdbKeyRejected) break;
    }
  }
  return result;
}

/** What one scan's move of fallback matches to TMDB did. */
export interface FallbackUpgrade {
  /** Films and shows now on TMDB, with its pictures. */
  films: number;
  shows: number;
  /** Asked about with no confident answer: left matched as they were. */
  left: number;
  errors: string[];
}

/**
 * The TMDB id of a title matched through a fallback, or null.
 *
 * Ids first, each a lookup rather than a guess: the TMDB id Wikidata holds,
 * then TMDB's `/find` by the IMDb id (OMDb's own key, Wikidata's and
 * TVmaze's), then by the TheTVDB id TVmaze holds. Only then a search, scored
 * by the same rules as any match (0.75, a 0.05 margin, the year) — and never
 * for a title matched by hand, which moves only by an id.
 */
async function tmdbIdFor(key: string, target: FallbackTitle): Promise<string | null> {
  const isSeries = target.kind === 'series';
  if (target.tmdb_id) return target.tmdb_id;
  if (target.imdb_id) {
    const found = await tmdbFindByImdb(key, target.imdb_id, isSeries);
    if (found) return found;
  }
  if (target.provider === 'tvmaze') {
    const tvdb = await tvmazeTvdbId(target.provider_id);
    const found = tvdb ? await tmdbFindByTvdb(key, tvdb, isSeries) : null;
    if (found) return found;
  }
  if (target.by_hand) return null;
  const candidates = await tmdbSearch(
    key,
    target.title,
    target.year,
    isSeries ? 'series' : 'movie'
  );
  const { best, matched } = pickBest(candidates, {
    parsedTitle: target.title,
    parsedYear: target.year,
  });
  return matched && best ? best.providerId : null;
}

/**
 * Move titles matched through a fallback — Wikidata or OMDb for films,
 * TVmaze for shows — to TMDB, once there is a key to ask with.
 *
 * The fallbacks are used only when no TMDB key works, and they have no
 * pictures (Wikidata), only a poster (OMDb), or a smaller set (TVmaze). When a
 * key is back, each is looked up on TMDB (`tmdbIdFor`), fetched before
 * anything changes, so a failure leaves the row as it was, and re-keyed in
 * place: files, resume points, playlists, track choices, watch history and My
 * list stay with it (`adopt` in metadata.rs). A title with no confident answer
 * stays matched as it is — never sent to Needs attention: a wrong match is
 * worse than none, and it was already matched — and is asked about again a
 * month later. A few per scan, like the six-month refresh, so a big library is
 * not asked about at once.
 */
export async function upgradeFallbackTitles(): Promise<FallbackUpgrade> {
  const result: FallbackUpgrade = { films: 0, shows: 0, left: 0, errors: [] };
  const keys = await loadProviderKeys();
  if (!keys.tmdb) return result;

  for (const target of await listFallbackTitles(REFRESH_PER_SCAN)) {
    await yieldToPlayback();
    const kind = target.kind === 'series' ? 'series' : 'movie';
    try {
      const tmdbId = await tmdbIdFor(keys.tmdb, target);
      const metadata = tmdbId ? await tmdbGetTitle(keys.tmdb, tmdbId, kind) : null;
      const episodes = tmdbId && kind === 'series' ? await tmdbGetEpisodes(keys.tmdb, tmdbId) : [];
      if (!tmdbId || !metadata || !(await adoptProvider(target.id, 'tmdb', tmdbId))) {
        await markUpgradeChecked(target.id);
        result.left++;
        continue;
      }
      const titleId = await saveTitle(metadata);
      if (episodes.length > 0) await saveEpisodes(titleId, episodes);
      if (kind === 'series') result.shows++;
      else result.films++;
    } catch (e) {
      result.errors.push(`${target.title}: ${e instanceof Error ? e.message : String(e)}`);
      // A refused key will be refused for every other title too.
      if (e instanceof TmdbKeyRejected) break;
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
  await ignoreFileIds(files.map((f) => f.id));
}

/**
 * Put ignored files back into the review queue. A wrong *match* is not undone
 * this way — that is an unlink (`unlinkFiles`), which holds the files so the
 * matcher cannot make the same choice again.
 */
export async function returnFilesToReview(files: MediaFile[]): Promise<void> {
  await returnToReview(files.map((f) => f.id));
}

/** The last part of a folder path. */
function folderName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * The id a group's names carry, or null. A film's own file name first, then
 * its folder; a show's folder and the one above it (`Show [tmdbid-1]/Season
 * 1`), never an episode's file name, whose id would be the episode's. When the
 * files of one group disagree, there is no id: it is not ours to choose.
 */
export function idsInGroupNames(group: FileGroup): NfoIds | null {
  let found: NfoIds | null = null;
  for (const file of group.files) {
    const folder = file.parent_dir;
    const above = folder.replace(/[\\/]+[^\\/]*[\\/]*$/, '');
    // A folder's id counts only for the title the folder is named after: a
    // folder of many films must not lend its one id to all of them.
    const named = (dir: string) => {
      const name = folderName(dir);
      return normaliseTitle(name).includes(normaliseTitle(group.title)) ? name : '';
    };
    const names = group.isSeries ? [named(folder), named(above)] : [file.file_name, named(folder)];
    const ids = names.map(idsInName).find((x) => x !== null) ?? null;
    if (!ids) continue;
    if (found && (found.imdb !== ids.imdb || found.tmdb !== ids.tmdb)) return null;
    found = ids;
  }
  return found;
}

/** How many close candidates have their alternative titles asked for. */
const ALT_TITLE_CANDIDATES = 3;

/**
 * The scorer did not decide on plain names: ask TMDB for the other names of
 * the few best candidates with the year exact or one off, and score again.
 * "Indiana Jones and the Raiders of the Lost Ark" is one of those names, not
 * the title. Never without a year: a name shared across decades is not
 * evidence.
 */
async function withAltTitles(
  key: string,
  candidates: Candidate[],
  scored: ScoredCandidate[],
  ctx: ScoreContext,
  isSeries: boolean
): Promise<Candidate[]> {
  const year = ctx.parsedYear;
  if (!year) return candidates;
  const ask = scored
    .filter((c) => c.year !== null && Math.abs(c.year - year) <= 1)
    .slice(0, ALT_TITLE_CANDIDATES)
    .map((c) => c.providerId);
  if (ask.length === 0) return candidates;
  const names = new Map<string, string[]>();
  for (const id of ask) {
    names.set(id, await tmdbAltTitles(key, id, isSeries ? 'series' : 'movie').catch(() => []));
  }
  return candidates.map((c) =>
    names.has(c.providerId) ? { ...c, altTitles: names.get(c.providerId) } : c
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

  // An id in the file or folder name: the same decision written into a name
  // instead of a file beside it. An NFO's id came first and wins.
  const named = idsInGroupNames(group);
  if (named) {
    const resolved = await resolveIds(named, group.isSeries, keys);
    if (resolved) {
      return {
        provider: resolved.provider,
        providerId: resolved.providerId,
        confidence: 1,
        reason: `name: ${resolved.via}`,
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

  // "Spider-Man - Across the Spider-Verse": the whole name is searched, and so
  // is the part before " - ", which is sometimes all of the title.
  const cut = searchTitle.indexOf(' - ');
  const shorter = cut > 0 ? searchTitle.slice(0, cut).trim() : '';

  const ctx: ScoreContext = {
    parsedTitle: searchTitle,
    parsedYear: searchYear,
    otherParsedTitles: shorter ? [shorter] : undefined,
    maxSeason: group.maxSeason,
  };

  const provider = providerFor(group, keys);

  let candidates = await searchProvider(provider, keys, searchTitle, searchYear, group.isSeries);
  if (shorter) {
    const more = await searchProvider(provider, keys, shorter, searchYear, group.isSeries);
    const seen = new Set(candidates.map((c) => c.providerId));
    candidates = [...candidates, ...more.filter((c) => !seen.has(c.providerId))];
  }

  if (candidates.length === 0) {
    return {
      provider,
      providerId: null,
      confidence: 0,
      reason: `no candidates returned${nfoNote}`,
      matched: false,
    };
  }

  let { best, matched } = pickBest(candidates, ctx);
  if (!matched && provider === 'tmdb' && keys.tmdb) {
    const plain = pickBest(candidates, ctx).all;
    candidates = await withAltTitles(keys.tmdb, candidates, plain, ctx, group.isSeries);
    ({ best, matched } = pickBest(candidates, ctx));
  }
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

/**
 * How many titles are matched at once: the device's cores, between two and
 * four. The providers' own queues (`makeQueue`) still send their requests one
 * at a time with a gap between them, so this overlaps what a title does
 * *around* the network — reading its NFO, the database writes, scoring — with
 * the next title's request, and never asks a service faster than before.
 */
export function matchConcurrency(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  return Math.min(4, Math.max(2, Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 2));
}

export async function matchFiles(
  files: MediaFile[],
  startingKeys: ProviderKeys,
  onProgress: (progress: MatchProgress) => void
): Promise<MatchOutcome> {
  let keys = startingKeys;
  const groups = groupFiles(files);
  const outcome: MatchOutcome = { matched: 0, unmatched: 0, errors: [] };
  // Kept per group and joined in group order, so the list reads the same
  // whichever title finished first.
  const errorsByGroup: Array<string | undefined> = new Array<string | undefined>(groups.length);

  let done = 0;
  // Two groups of one title (a film and a series called the same, or two years
  // of a remake) are never in flight together: each waits for the one before.
  const titleChains = new Map<string, Promise<void>>();
  // Asked once per run: the same network says the same thing for every title.
  let unreachable: Promise<string> | null = null;

  const matchGroup = async (group: FileGroup, index: number): Promise<void> => {
    await yieldToPlayback();
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
        await recordRefusal(
          group.files.map((f) => f.id),
          result.confidence,
          result.reason ?? 'no confident match'
        );
        outcome.unmatched += group.files.length;
      }
    } catch (e) {
      const why =
        e instanceof Unreachable
          ? await (unreachable ??= explainUnreachable(e).then((sentence) => {
              console.warn(`matching: ${sentence}`);
              // A passing drop is not kept for the run: the next title with no
              // answer asks again rather than saying "answers now" once TMDB
              // has gone for good (0.13.1 review).
              if (sentence.includes('answers now')) unreachable = null;
              return sentence;
            }))
          : withoutQueries(e instanceof Error ? e.message : String(e));
      const message = `${group.title}: ${why}`;
      errorsByGroup[index] = message;

      // TMDB refused the built-in key: it has been set aside (builtinKey.ts),
      // and the rest of this run uses what works without it rather than
      // collecting the same refusal once per title.
      if (e instanceof TmdbKeyRejected && keys.tmdbSource === 'builtin') {
        keys = await loadProviderKeys();
      }

      // A provider failure must not leave files in limbo — record it with the
      // reason attached. Not a refusal: nothing was decided, so the next scan
      // asks again, where a refusal waits until a key changes.
      await recordProviderFailure(
        group.files.map((f) => f.id),
        message
      ).catch(() => undefined);
      outcome.unmatched += group.files.length;
    }

    done++;
  };

  const inTitleOrder = (group: FileGroup, index: number): Promise<void> => {
    const titleKey = group.title.toLowerCase();
    const run = (titleChains.get(titleKey) ?? Promise.resolve()).then(() =>
      matchGroup(group, index)
    );
    titleChains.set(
      titleKey,
      run.catch(() => undefined)
    );
    return run;
  };

  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= groups.length) return;
      await inTitleOrder(groups[index], index);
    }
  };

  // With the app's own key the first title goes alone: if TMDB refuses that
  // key, the answer must be known before the others are sent with it.
  if (keys.tmdbSource === 'builtin' && groups.length > 0) {
    next = 1;
    await inTitleOrder(groups[0], 0);
  }
  await Promise.all(Array.from({ length: Math.min(matchConcurrency(), groups.length) }, lane));

  for (const message of errorsByGroup) if (message) outcome.errors.push(message);

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
