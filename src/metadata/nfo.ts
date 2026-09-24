/**
 * NFO sidecars as an authoritative override during matching.
 *
 * An NFO beside a video is somebody having already answered the question the
 * matcher is about to guess at. When it carries a provider id, that id *is* the
 * answer: no search, no scoring, no ambiguity guard, and no way to land on a
 * confidently wrong title. This is the strongest possible version of "a wrong
 * match is worse than no match" — the case where there is nothing to get wrong.
 *
 * When there is no id, the NFO still usually beats the filename. A hand-curated
 * `<title>` and `<year>` replace the guessit-parsed ones as the *search*, and
 * the normal threshold and margin still apply to whatever comes back. The
 * override is on the question asked, not on the standard of proof.
 *
 * Reading and parsing happen in Rust (`src-tauri/src/nfo.rs`), which already
 * walks these paths. Doing it here would mean granting the webview filesystem
 * scope over the whole library, including NAS shares.
 */
import { invoke } from '@tauri-apps/api/core';
import type { MediaFile } from '../library/api';
import { parseGenres } from '../ui/api';
import {
  tmdbFindByImdb,
  tvmazeLookupByImdb,
  tvmazeLookupByTvdb,
} from './providers';
import type { FileGroup, Provider, ProviderKeys } from './match';

export interface NfoIds {
  tmdb: string | null;
  imdb: string | null;
  tvdb: string | null;
}

export interface Nfo {
  kind: 'movie' | 'tvshow' | 'episode' | 'url';
  title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  ids: NfoIds;
  source: string;
}

/** The NFO belonging to one video file, if there is one. */
export const readNfo = (path: string) => invoke<Nfo | null>('read_nfo', { path });

/** The show-level NFO for an episode file (`tvshow.nfo`, up to two levels up). */
export const readShowNfo = (path: string) => invoke<Nfo | null>('read_show_nfo', { path });

export interface NfoExport {
  video_path: string;
  kind: 'movie' | 'tvshow' | 'episodedetails';
  title: string;
  original_title: string | null;
  year: number | null;
  plot: string | null;
  runtime_mins: number | null;
  rating: number | null;
  genres: string[];
  season: number | null;
  episode: number | null;
  tmdb_id: string | null;
  imdb_id: string | null;
}

export interface NfoWriteReport {
  written: number;
  skipped: number;
  errors: string[];
}

export const writeNfo = (exports: NfoExport[], overwrite: boolean) =>
  invoke<NfoWriteReport>('write_nfo', { exports, overwrite });

/**
 * The NFO that speaks for a whole group.
 *
 * A series is matched as a unit, so the id that resolves twelve episodes is the
 * show's. An `<episodedetails>` id identifies one episode and would link the
 * entire season to it, so episode-level files are only consulted for a movie.
 */
export async function nfoForGroup(group: FileGroup): Promise<Nfo | null> {
  const anchor: MediaFile | undefined = group.files[0];
  if (!anchor) return null;

  if (group.isSeries) {
    const show = await readShowNfo(anchor.path).catch(() => null);
    // A `<movie>` NFO found while looking for a show is somebody's mistake or a
    // stray file; using it would link a season to a film.
    return show && (show.kind === 'tvshow' || show.kind === 'url') ? show : null;
  }

  const movie = await readNfo(anchor.path).catch(() => null);
  return movie && (movie.kind === 'movie' || movie.kind === 'url') ? movie : null;
}

export interface NfoResolution {
  provider: Provider;
  providerId: string;
  /** Human-readable, for the stored match reason. */
  via: string;
}

/**
 * Turn the ids in an NFO into a provider and an id this app can fetch.
 *
 * Order is by how much the result carries, not by how direct the lookup is:
 * TMDB first because it is the only source here with backdrops and episode
 * stills, which the browsing UI is built around. A TVDB id is worth a TVmaze
 * lookup, and an IMDb id is worth a TMDB `/find` before falling back to OMDb.
 *
 * Returns null when nothing resolves, which is not a failure — the caller falls
 * through to searching by the NFO's title.
 */
export async function resolveNfoIds(
  nfo: Nfo,
  isSeries: boolean,
  keys: ProviderKeys
): Promise<NfoResolution | null> {
  const { tmdb, imdb, tvdb } = nfo.ids;

  if (keys.tmdb) {
    if (tmdb) {
      return { provider: 'tmdb', providerId: tmdb, via: `tmdb:${tmdb}` };
    }
    if (imdb) {
      const found = await tmdbFindByImdb(keys.tmdb, imdb, isSeries);
      if (found) return { provider: 'tmdb', providerId: found, via: `imdb:${imdb}` };
    }
  }

  if (isSeries) {
    if (tvdb) {
      const found = await tvmazeLookupByTvdb(tvdb);
      if (found) return { provider: 'tvmaze', providerId: found, via: `tvdb:${tvdb}` };
    }
    if (imdb) {
      const found = await tvmazeLookupByImdb(imdb);
      if (found) return { provider: 'tvmaze', providerId: found, via: `imdb:${imdb}` };
    }
    return null;
  }

  // OMDb is keyed by IMDb id directly, so no lookup step is needed.
  if (imdb && keys.omdb) {
    return { provider: 'omdb', providerId: imdb, via: `imdb:${imdb}` };
  }

  return null;
}

/** Just the filename, for a reason string that has to stay readable. */
export function sourceName(source: string): string {
  const parts = source.split(/[\\/]/);
  return parts[parts.length - 1] ?? source;
}

// ---- export ---------------------------------------------------------------

/** One matched file with everything its NFO needs. Assembled by Rust. */
export interface NfoTarget {
  path: string;
  title_id: number;
  kind: string;
  title: string;
  year: number | null;
  overview: string | null;
  genres: string | null;
  runtime_mins: number | null;
  rating: number | null;
  imdb_id: string | null;
  tmdb_id: string | null;
  season: number | null;
  episode: number | null;
  episode_name: string | null;
  episode_overview: string | null;
  episode_runtime: number | null;
}

const nfoTargets = () => invoke<NfoTarget[]>('nfo_targets');

/**
 * Build the export set for the whole library.
 *
 * A movie is one file and one NFO. A series is one `tvshow.nfo` for the show
 * plus an `<episodedetails>` beside each episode — which is what MediaElch and
 * tinyMediaManager expect to find, and the layout Kodi reads. The show entry is
 * emitted once per title and anchored on its first episode, since the folder is
 * derived from the file rather than stored anywhere.
 *
 * Episodes we hold but the provider never described still get an NFO, using the
 * numbering from the filename. It is thin, but it carries the show's ids, which
 * is the part another tool actually needs.
 */
export async function buildNfoExports(): Promise<NfoExport[]> {
  const targets = await nfoTargets();
  const exports: NfoExport[] = [];
  const showsSeen = new Set<number>();

  for (const t of targets) {
    const isSeries = t.kind === 'series';

    if (!isSeries) {
      exports.push({
        video_path: t.path,
        kind: 'movie',
        title: t.title,
        original_title: null,
        year: t.year,
        plot: t.overview,
        runtime_mins: t.runtime_mins,
        rating: t.rating,
        genres: parseGenres(t.genres),
        season: null,
        episode: null,
        tmdb_id: t.tmdb_id,
        imdb_id: t.imdb_id,
      });
      continue;
    }

    if (!showsSeen.has(t.title_id)) {
      showsSeen.add(t.title_id);
      exports.push({
        video_path: t.path,
        kind: 'tvshow',
        title: t.title,
        original_title: null,
        year: t.year,
        plot: t.overview,
        runtime_mins: t.runtime_mins,
        rating: t.rating,
        genres: parseGenres(t.genres),
        season: null,
        episode: null,
        tmdb_id: t.tmdb_id,
        imdb_id: t.imdb_id,
      });
    }

    exports.push({
      video_path: t.path,
      kind: 'episodedetails',
      // Falling back to the show's title would name every episode after the
      // series, which reads as a bug in whatever opens it next.
      title: t.episode_name ?? `Episode ${t.episode ?? ''}`.trim(),
      original_title: null,
      year: null,
      plot: t.episode_overview,
      runtime_mins: t.episode_runtime,
      rating: null,
      genres: [],
      season: t.season,
      episode: t.episode,
      // Episode-level ids are deliberately absent: the ids we hold identify the
      // show, and writing them here would claim the episode is the series.
      tmdb_id: null,
      imdb_id: null,
    });
  }

  return exports;
}
