/**
 * Metadata providers.
 *
 * Requests go through Tauri's HTTP plugin rather than the webview's fetch, so
 * they are made from Rust: no CORS, and the reachable hosts are allow-listed
 * in the capability file.
 *
 * Provider roles:
 *   TVmaze  — TV. No API key at all, and the only source here that supplies
 *             background/backdrop art as well as episode-level data.
 *   OMDb    — Movies. Plot, genres, runtime, ratings and a poster. No backdrop.
 *   MDBList — Ratings aggregation and ID cross-referencing.
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
  /** YouTube video id for the trailer, when the provider knows one. */
  trailer_key: string | null;
  trailer_site: string | null;
}

export interface Trailer {
  /** The site's own video id — a YouTube key, not a URL. */
  key: string;
  site: string;
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
 * TVmaze asks for at least 10 seconds between every 20 calls. Serialising
 * requests with a small gap keeps us well under that without needing a proper
 * token bucket — matching is not latency sensitive.
 */
const TVMAZE_GAP_MS = 120;
let tvmazeChain: Promise<unknown> = Promise.resolve();

function tvmazeQueued<T>(work: () => Promise<T>): Promise<T> {
  const result = tvmazeChain.then(async () => {
    const value = await work();
    await new Promise((r) => setTimeout(r, TVMAZE_GAP_MS));
    return value;
  });
  tvmazeChain = result.catch(() => undefined);
  return result;
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
      // TVmaze carries no video links at all.
      trailer_key: null,
      trailer_site: null,
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

async function tmdbGet<T>(key: string, path: string, params?: Record<string, string>): Promise<T> {
  const response = await fetch(tmdbUrl(key, path, params), { method: 'GET' });
  if (!response.ok) throw new Error(`TMDB ${path} failed: HTTP ${response.status}`);
  return (await response.json()) as T;
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
    // Appending videos to the detail request keeps a new match at one round
    // trip instead of two — the trailer key arrives with everything else.
  }>(key, kind === 'movie' ? `/movie/${id}` : `/tv/${id}`, {
    append_to_response: 'external_ids,videos',
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
    trailer_key: trailer?.key ?? null,
    trailer_site: trailer?.site ?? null,
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

  const response = await fetch(omdbUrl(key, params), { method: 'GET' });
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
  const response = await fetch(omdbUrl(key, { i: imdbId, plot: 'full' }), { method: 'GET' });
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
    // OMDb has no backdrop/fanart of any kind, and no video links either.
    backdrop_url: null,
    trailer_key: null,
    trailer_site: null,
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
