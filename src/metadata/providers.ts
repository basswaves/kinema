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
  }>(key, kind === 'movie' ? `/movie/${id}` : `/tv/${id}`, { append_to_response: 'external_ids' });

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
  };
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
    // OMDb has no backdrop/fanart of any kind.
    backdrop_url: null,
  };
}
