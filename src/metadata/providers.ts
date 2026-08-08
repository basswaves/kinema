/**
 * Metadata providers.
 *
 * Requests go through Tauri's HTTP plugin rather than the webview's fetch, so
 * they are made from Rust: no CORS, and the reachable hosts are allow-listed
 * in the capability file.
 *
 * Provider roles:
 *   TMDB    — Preferred for both. The only source here with backdrops, title
 *             logos, episode stills, cast and trailer keys, and it returns all
 *             of them on one detail request.
 *   TVmaze  — TV fallback. No API key at all, and the only *keyless* source
 *             that supplies background art as well as episode-level data.
 *   OMDb    — Movie fallback. Plot, genres, runtime, ratings and a poster.
 *             No backdrop, no logo, no usable cast.
 */
import { fetch } from '@tauri-apps/plugin-http';
import type { Candidate } from './score';

export interface TitleMetadata {
  kind: 'movie' | 'series';
  provider: string;
  provider_id: string;
  imdb_id: string | null;
  tmdb_id: string | null;
  title: string;
  year: number | null;
  overview: string | null;
  genres: string | null;
  runtime_mins: number | null;
  rating: number | null;
  poster_url: string | null;
  backdrop_url: string | null;
  /**
   * The title treatment — the film's name as designed, on transparency. What a
   * streaming service puts over its hero image instead of setting the title in
   * the UI font. Null for providers that have none, which is all but TMDB.
   */
  logo_url: string | null;
  /** YouTube video id for the trailer, when the provider knows one. */
  trailer_key: string | null;
  trailer_site: string | null;
  /** Billed cast, in order, capped by the provider client. */
  cast: CastMember[];
}

export interface CastMember {
  name: string;
  character: string | null;
  profile_url: string | null;
}

/**
 * How many cast members to keep.
 *
 * TMDB returns the full billed cast, which runs to dozens on a big film. Each
 * one is another face in the artwork cache, so an unbounded list would grow the
 * cache by an order of magnitude for names nobody scrolls to. The first ten are
 * the ones anyone recognises.
 */
const CAST_LIMIT = 10;

export interface Trailer {
  /** The site's own video id — a YouTube key, not a URL. */
  key: string;
  site: string;
}

/** One entry from TMDB's `/images` lists. */
interface TmdbImage {
  file_path: string;
  iso_639_1?: string | null;
  vote_average?: number;
  width?: number;
}

/** One entry from TMDB's `/credits` cast list. */
interface TmdbCastMember {
  name?: string;
  character?: string;
  profile_path?: string | null;
  order?: number;
}

/**
 * Pick the logo to draw over the hero.
 *
 * PNG over SVG deliberately. TMDB serves `.svg` logos through the same image
 * host, but the size-prefixed CDN path (`/t/p/original/…`) returns them
 * unrasterised, and an `<img>` pointed at one inherits no intrinsic size — it
 * collapses or fills its container depending on the CSS, neither of which is
 * the logo's real aspect ratio.
 *
 * English before language-neutral before anything else: a neutral logo is
 * usually the original-language one, which is right when there is no English
 * treatment and wrong when there is.
 */
function pickLogo(logos: TmdbImage[] | undefined): string | null {
  if (!logos?.length) return null;

  const rank = (logo: TmdbImage): number => {
    const isPng = !logo.file_path.toLowerCase().endsWith('.svg');
    if (!isPng) return 3;
    if (logo.iso_639_1 === 'en') return 0;
    if (!logo.iso_639_1) return 1;
    return 2;
  };

  const best = [...logos].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return (b.vote_average ?? 0) - (a.vote_average ?? 0);
  })[0];

  // Every candidate was an SVG. Better none than one that renders at the wrong
  // size over the hero image.
  return rank(best) === 3 ? null : `${TMDB_IMAGE}${best.file_path}`;
}

/** One entry from TMDB's `/videos` list. */
interface TmdbVideo {
  key: string;
  site: string;
  type: string;
  official?: boolean;
  size?: number;
  iso_639_1?: string;
  published_at?: string;
}

/**
 * Pick the trailer worth showing.
 *
 * Only YouTube is considered: it is what TMDB overwhelmingly carries, and a
 * second embed host would be a second failure mode for one or two titles.
 * Preference order is official over fan-uploaded, a real trailer over a teaser,
 * and English over other languages — a teaser is still better than nothing,
 * which is why it is a fallback rather than a filter.
 */
function pickTrailer(videos: TmdbVideo[] | undefined): Trailer | null {
  const youtube = (videos ?? []).filter((v) => v.site === 'YouTube' && v.key);
  if (youtube.length === 0) return null;

  const score = (v: TmdbVideo): number =>
    (v.type === 'Trailer' ? 4 : v.type === 'Teaser' ? 2 : 0) +
    (v.official ? 2 : 0) +
    (v.iso_639_1 === 'en' ? 1 : 0);

  const best = [...youtube].sort((a, b) => score(b) - score(a))[0];
  // Everything that is neither a trailer nor a teaser — featurettes, clips,
  // behind-the-scenes — is not what "play trailer" promises.
  if (best.type !== 'Trailer' && best.type !== 'Teaser') return null;

  return { key: best.key, site: best.site };
}

export interface EpisodeMetadata {
  season: number;
  episode: number;
  name: string | null;
  overview: string | null;
  air_date: string | null;
  runtime_mins: number | null;
  still_url: string | null;
}

/** Strip the HTML TVmaze puts in summaries. */
function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  return html.replace(/<[^>]*>/g, '').trim() || null;
}

function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

// ---------------------------------------------------------------------------
// TVmaze — TV, keyless
// ---------------------------------------------------------------------------

interface TvmazeShow {
  id: number;
  name: string;
  premiered: string | null;
  summary: string | null;
  genres: string[];
  runtime: number | null;
  averageRuntime: number | null;
  rating: { average: number | null };
  weight?: number;
  image: { medium: string; original: string } | null;
  externals: { imdb: string | null; thetvdb: number | null };
}

/**
 * Serialise requests to one provider, with a minimum gap between them.
 *
 * Not a token bucket: matching is not latency sensitive, and a chain of
 * promises with a delay is both obviously correct and impossible to get subtly
 * wrong. Each provider gets its own chain, so a slow TVmaze cannot hold up TMDB.
 */
function makeQueue(gapMs: number) {
  let chain: Promise<unknown> = Promise.resolve();
  return function queued<T>(work: () => Promise<T>): Promise<T> {
    const result = chain.then(async () => {
      const value = await work();
      await new Promise((r) => setTimeout(r, gapMs));
      return value;
    });
    // Swallowed so one failed request does not poison every request behind it.
    chain = result.catch(() => undefined);
    return result;
  };
}

/** TVmaze asks for at least 10 seconds between every 20 calls. */
const TVMAZE_GAP_MS = 120;
const tvmazeQueued = makeQueue(TVMAZE_GAP_MS);

/**
 * TMDB and OMDb had no throttle at all, which mattered most on exactly the run
 * a new user makes first: a full library, matched as fast as the pipeline could
 * drive it. There is no retry in the matcher — a failed request leaves the file
 * `unmatched` for later, deliberately — so a burst of 429s did not break
 * anything, it just quietly left a pile of unmatched files behind and looked
 * like the app not recognising your films.
 */
const TMDB_GAP_MS = 30;
const tmdbQueued = makeQueue(TMDB_GAP_MS);

/** OMDb's free tier is 1,000 requests a day, so pace it rather than sprint. */
const OMDB_GAP_MS = 120;
const omdbQueued = makeQueue(OMDB_GAP_MS);

/** How many times to wait out a 429 before giving up and letting it throw. */
const RATE_LIMIT_RETRIES = 2;

/**
 * `fetch`, but a 429 is waited out rather than treated as a failure.
 *
 * Honours `Retry-After` when the server sends one, and backs off exponentially
 * when it does not. Everything else — 404, 401, a dead network — is handed
 * straight back to the caller, which already knows what to do with it.
 */
async function fetchPolitely(url: string, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { method: 'GET' });
    if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return response;

    const header = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(header) && header > 0 ? header * 1000 : 1000 * 2 ** attempt;
    console.warn(`${label}: rate limited, waiting ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

export async function tvmazeSearch(title: string): Promise<Candidate[]> {
  return tvmazeQueued(async () => {
    const url = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) throw new Error(`TVmaze search failed: HTTP ${response.status}`);

    const results = (await response.json()) as Array<{ show: TvmazeShow }>;
    return results.slice(0, 8).map(({ show }) => ({
      providerId: String(show.id),
      title: show.name,
      year: yearOf(show.premiered),
      // TVmaze's `weight` (0-100) is its own popularity ranking.
      popularity: show.weight ?? null,
      voteCount: null,
      posterUrl: show.image?.medium ?? null,
      overview: stripHtml(show.summary),
    }));
  });
}

export async function tvmazeGetShow(id: string): Promise<TitleMetadata> {
  return tvmazeQueued(async () => {
    const response = await fetch(`https://api.tvmaze.com/shows/${id}`, { method: 'GET' });
    if (!response.ok) throw new Error(`TVmaze show failed: HTTP ${response.status}`);
    const show = (await response.json()) as TvmazeShow;

    // Backdrop art lives on a separate endpoint and is the reason TVmaze is
    // worth using over OMDb for series.
    let backdrop: string | null = null;
    try {
      const imagesRes = await fetch(`https://api.tvmaze.com/shows/${id}/images`, { method: 'GET' });
      if (imagesRes.ok) {
        const images = (await imagesRes.json()) as Array<{
          type: string | null;
          resolutions: { original: { url: string } };
        }>;
        const background = images.find((i) => i.type === 'background');
        backdrop = background?.resolutions.original.url ?? null;
      }
    } catch {
      /* artwork is optional — never fail a match over it */
    }

    return {
      kind: 'series',
      provider: 'tvmaze',
      provider_id: String(show.id),
      imdb_id: show.externals?.imdb ?? null,
      tmdb_id: null,
      title: show.name,
      year: yearOf(show.premiered),
      overview: stripHtml(show.summary),
      genres: show.genres?.length ? JSON.stringify(show.genres) : null,
      runtime_mins: show.averageRuntime ?? show.runtime ?? null,
      rating: show.rating?.average ?? null,
      poster_url: show.image?.original ?? null,
      backdrop_url: backdrop,
      // TVmaze carries no logos and no video links at all. Cast is available
      // from a separate endpoint, but a second request per title for the one
      // provider that is the keyless fallback is the wrong trade.
      logo_url: null,
      trailer_key: null,
      trailer_site: null,
      cast: [],
    };
  });
}

export async function tvmazeGetEpisodes(id: string): Promise<EpisodeMetadata[]> {
  return tvmazeQueued(async () => {
    const response = await fetch(`https://api.tvmaze.com/shows/${id}/episodes`, { method: 'GET' });
    if (!response.ok) throw new Error(`TVmaze episodes failed: HTTP ${response.status}`);

    const episodes = (await response.json()) as Array<{
      season: number;
      number: number | null;
      name: string;
      summary: string | null;
      airdate: string | null;
      runtime: number | null;
      image: { original: string } | null;
    }>;

    return episodes
      .filter((e) => e.number !== null)
      .map((e) => ({
        season: e.season,
        episode: e.number as number,
        name: e.name ?? null,
        overview: stripHtml(e.summary),
        air_date: e.airdate || null,
        runtime_mins: e.runtime ?? null,
        still_url: e.image?.original ?? null,
      }));
  });
}

// ---------------------------------------------------------------------------
// TMDB — movies and TV, best artwork of any provider here
// ---------------------------------------------------------------------------

const TMDB_IMAGE = 'https://image.tmdb.org/t/p/original';

function tmdbUrl(key: string, path: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ api_key: key, ...params });
  return `https://api.themoviedb.org/3${path}?${query.toString()}`;
}

/** Every TMDB request goes through here, which is what makes one queue enough. */
async function tmdbGet<T>(key: string, path: string, params?: Record<string, string>): Promise<T> {
  return tmdbQueued(async () => {
    const response = await fetchPolitely(tmdbUrl(key, path, params), `TMDB ${path}`);
    if (!response.ok) throw new Error(`TMDB ${path} failed: HTTP ${response.status}`);
    return (await response.json()) as T;
  });
}

interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
  vote_count?: number;
  poster_path?: string | null;
  overview?: string;
}

export async function tmdbSearch(
  key: string,
  title: string,
  year: number | null,
  kind: 'movie' | 'series'
): Promise<Candidate[]> {
  const params: Record<string, string> = { query: title };
  if (year) params[kind === 'movie' ? 'year' : 'first_air_date_year'] = String(year);

  const data = await tmdbGet<{ results: TmdbSearchResult[] }>(
    key,
    kind === 'movie' ? '/search/movie' : '/search/tv',
    params
  );

  return (data.results ?? []).slice(0, 8).map((r) => ({
    providerId: String(r.id),
    title: (r.title ?? r.name ?? '') as string,
    year: yearOf(r.release_date ?? r.first_air_date ?? null),
    popularity: r.popularity ?? null,
    voteCount: r.vote_count ?? null,
    // A smaller size than the detail fetch uses: these are thumbnails in a
    // picker, and eight originals would be tens of megabytes.
    posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w185${r.poster_path}` : null,
    overview: r.overview || null,
  }));
}

export async function tmdbGetTitle(
  key: string,
  id: string,
  kind: 'movie' | 'series'
): Promise<TitleMetadata> {
  const detail = await tmdbGet<{
    id: number;
    title?: string;
    name?: string;
    release_date?: string;
    first_air_date?: string;
    overview: string;
    genres: Array<{ name: string }>;
    runtime?: number;
    episode_run_time?: number[];
    vote_average: number;
    poster_path: string | null;
    backdrop_path: string | null;
    external_ids?: { imdb_id: string | null };
    videos?: { results: TmdbVideo[] };
    images?: { logos?: TmdbImage[] };
    credits?: { cast?: TmdbCastMember[] };
    // Everything is appended to the one detail request, so a new match stays a
    // single round trip however much of it we use. `include_image_language`
    // is what makes `images` useful: without it TMDB returns only images
    // tagged with the request language, which for logos is usually none.
  }>(key, kind === 'movie' ? `/movie/${id}` : `/tv/${id}`, {
    append_to_response: 'external_ids,videos,images,credits',
    include_image_language: 'en,null',
  });

  const trailer = pickTrailer(detail.videos?.results);

  return {
    kind,
    provider: 'tmdb',
    provider_id: String(detail.id),
    imdb_id: detail.external_ids?.imdb_id ?? null,
    tmdb_id: String(detail.id),
    title: (detail.title ?? detail.name ?? '') as string,
    year: yearOf(detail.release_date ?? detail.first_air_date ?? null),
    overview: detail.overview || null,
    genres: detail.genres?.length ? JSON.stringify(detail.genres.map((g) => g.name)) : null,
    runtime_mins: detail.runtime ?? detail.episode_run_time?.[0] ?? null,
    rating: detail.vote_average || null,
    poster_url: detail.poster_path ? `${TMDB_IMAGE}${detail.poster_path}` : null,
    backdrop_url: detail.backdrop_path ? `${TMDB_IMAGE}${detail.backdrop_path}` : null,
    // Empty string, not null, when TMDB has no logo for this title. Null means
    // "never asked" and is what the other providers send, so `save_title` can
    // COALESCE theirs away without also re-asking TMDB forever about a title
    // that genuinely has none. Same convention as `trailer_key`.
    logo_url: pickLogo(detail.images?.logos) ?? '',
    trailer_key: trailer?.key ?? null,
    trailer_site: trailer?.site ?? null,
    cast: (detail.credits?.cast ?? [])
      .filter((c) => c.name?.trim())
      .slice(0, CAST_LIMIT)
      .map((c) => ({
        name: (c.name as string).trim(),
        character: c.character?.trim() || null,
        // A smaller size than posters use: these are drawn at about 5rem, and
        // originals would be several megabytes each for a face on a card.
        profile_url: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
      })),
  };
}

/**
 * Trailer for a title already in the database. Used to backfill titles matched
 * before trailers were stored; a fresh match gets one from `tmdbGetTitle` for
 * free.
 */
export async function tmdbGetTrailer(
  key: string,
  id: string,
  kind: 'movie' | 'series'
): Promise<Trailer | null> {
  const data = await tmdbGet<{ results: TmdbVideo[] }>(
    key,
    kind === 'movie' ? `/movie/${id}/videos` : `/tv/${id}/videos`
  );
  return pickTrailer(data.results);
}

export async function tmdbGetEpisodes(key: string, id: string): Promise<EpisodeMetadata[]> {
  const show = await tmdbGet<{ seasons: Array<{ season_number: number }> }>(key, `/tv/${id}`);
  const episodes: EpisodeMetadata[] = [];

  for (const season of show.seasons ?? []) {
    // Season 0 is specials; include it, since files often reference it.
    const data = await tmdbGet<{
      episodes: Array<{
        season_number: number;
        episode_number: number;
        name: string;
        overview: string;
        air_date: string | null;
        runtime: number | null;
        still_path: string | null;
      }>;
    }>(key, `/tv/${id}/season/${season.season_number}`);

    for (const e of data.episodes ?? []) {
      episodes.push({
        season: e.season_number,
        episode: e.episode_number,
        name: e.name || null,
        overview: e.overview || null,
        air_date: e.air_date || null,
        runtime_mins: e.runtime ?? null,
        still_url: e.still_path ? `${TMDB_IMAGE}${e.still_path}` : null,
      });
    }
  }

  return episodes;
}

// ---------------------------------------------------------------------------
// OMDb — movies
// ---------------------------------------------------------------------------

interface OmdbSearchItem {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
}

function omdbUrl(key: string, params: Record<string, string>): string {
  const query = new URLSearchParams({ apikey: key, ...params });
  return `https://www.omdbapi.com/?${query.toString()}`;
}

export async function omdbSearch(
  key: string,
  title: string,
  year: number | null
): Promise<Candidate[]> {
  const params: Record<string, string> = { s: title, type: 'movie' };
  if (year) params.y = String(year);

  const response = await omdbQueued(() => fetchPolitely(omdbUrl(key, params), 'OMDb search'));
  if (!response.ok) throw new Error(`OMDb search failed: HTTP ${response.status}`);

  const data = (await response.json()) as { Response: string; Error?: string; Search?: OmdbSearchItem[] };
  if (data.Response === 'False') {
    // "Movie not found" is an ordinary outcome, not an error worth throwing.
    if (data.Error && /not found/i.test(data.Error)) return [];
    throw new Error(`OMDb: ${data.Error ?? 'unknown error'}`);
  }

  return (data.Search ?? []).slice(0, 8).map((item) => ({
    providerId: item.imdbID,
    title: item.Title,
    year: Number(item.Year?.slice(0, 4)) || null,
    posterUrl: item.Poster && item.Poster !== 'N/A' ? item.Poster : null,
    // OMDb's search endpoint returns no plot; only the detail lookup has one.
    overview: null,
  }));
}

export async function omdbGetMovie(key: string, imdbId: string): Promise<TitleMetadata> {
  const response = await omdbQueued(() =>
    fetchPolitely(omdbUrl(key, { i: imdbId, plot: 'full' }), 'OMDb lookup')
  );
  if (!response.ok) throw new Error(`OMDb lookup failed: HTTP ${response.status}`);

  const d = (await response.json()) as Record<string, string>;
  if (d.Response === 'False') throw new Error(`OMDb: ${d.Error ?? 'unknown error'}`);

  const runtime = Number((d.Runtime ?? '').replace(/[^0-9]/g, ''));
  const rating = Number(d.imdbRating);

  return {
    kind: 'movie',
    provider: 'omdb',
    provider_id: imdbId,
    imdb_id: imdbId,
    tmdb_id: null,
    title: d.Title,
    year: Number((d.Year ?? '').slice(0, 4)) || null,
    overview: d.Plot && d.Plot !== 'N/A' ? d.Plot : null,
    genres: d.Genre && d.Genre !== 'N/A' ? JSON.stringify(d.Genre.split(',').map((g) => g.trim())) : null,
    runtime_mins: Number.isFinite(runtime) && runtime > 0 ? runtime : null,
    rating: Number.isFinite(rating) ? rating : null,
    poster_url: d.Poster && d.Poster !== 'N/A' ? d.Poster : null,
    // OMDb has no backdrop/fanart of any kind, no logos and no video links.
    // Its `Actors` field is a comma-joined string with no photos or roles,
    // which is not enough to build a cast row worth showing.
    backdrop_url: null,
    logo_url: null,
    trailer_key: null,
    trailer_site: null,
    cast: [],
  };
}

// ---------------------------------------------------------------------------
// External-id lookups
//
// Only used when an NFO hands over a provider id. There is no scoring here on
// purpose: an id is an answer, not a candidate, so these either resolve to
// exactly one entry or to nothing at all.
// ---------------------------------------------------------------------------

/**
 * Resolve an IMDb id to a TMDB id.
 *
 * `/find` returns per-kind buckets, so the kind asked for is the kind checked —
 * an IMDb id for a series must not come back as a movie result that then gets
 * stored with no episodes.
 */
export async function tmdbFindByImdb(
  key: string,
  imdbId: string,
  isSeries: boolean
): Promise<string | null> {
  const data = await tmdbGet<{
    movie_results?: Array<{ id: number }>;
    tv_results?: Array<{ id: number }>;
  }>(key, `/find/${encodeURIComponent(imdbId)}`, { external_source: 'imdb_id' });

  const hit = (isSeries ? data.tv_results : data.movie_results)?.[0];
  return hit ? String(hit.id) : null;
}

/**
 * Resolve a TheTVDB id to a TVmaze show id.
 *
 * TVmaze answers 404 for an id it does not carry, which is an ordinary outcome
 * rather than a failure — an older library can easily hold TVDB ids for shows
 * TVmaze never indexed.
 */
export async function tvmazeLookupByTvdb(tvdbId: string): Promise<string | null> {
  return tvmazeQueued(async () => {
    const response = await fetch(
      `https://api.tvmaze.com/lookup/shows?thetvdb=${encodeURIComponent(tvdbId)}`,
      { method: 'GET' }
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`TVmaze lookup failed: HTTP ${response.status}`);
    const show = (await response.json()) as { id?: number };
    return show.id ? String(show.id) : null;
  });
}

/** Same, for an IMDb id, when TMDB is unavailable but the show is on TVmaze. */
export async function tvmazeLookupByImdb(imdbId: string): Promise<string | null> {
  return tvmazeQueued(async () => {
    const response = await fetch(
      `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdbId)}`,
      { method: 'GET' }
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`TVmaze lookup failed: HTTP ${response.status}`);
    const show = (await response.json()) as { id?: number };
    return show.id ? String(show.id) : null;
  });
}
