/** Browsing data for the UI. */
import { invoke } from '@tauri-apps/api/core';

export interface Title {
  id: number;
  kind: 'movie' | 'series' | string;
  provider: string;
  title: string;
  year: number | null;
  overview: string | null;
  genres: string | null;
  runtime_mins: number | null;
  poster_url: string | null;
  backdrop_url: string | null;
  /** Cached copy in app data, when one has been downloaded. */
  poster_path: string | null;
  backdrop_path: string | null;
  /** YouTube video id, empty string once checked and none exists. */
  trailer_key: string | null;
  trailer_site: string | null;
  rating: number | null;
  file_count: number;
  added_at: number | null;
}

export interface Episode {
  id: number;
  season: number;
  episode: number;
  name: string | null;
  overview: string | null;
  air_date: string | null;
  runtime_mins: number | null;
  still_url: string | null;
  still_path: string | null;
  file_path: string | null;
  file_id: number | null;
  /** Played to the end, or marked watched by hand — the same flag either way. */
  watched: boolean;
  /** Resume point. Both null until the file has actually been played. */
  position_secs: number | null;
  duration_secs: number | null;
}

export interface TitleDetail {
  title: Title;
  episodes: Episode[];
  movie_path: string | null;
  movie_file_id: number | null;
  movie_watched: boolean;
}

export const listTitles = () => invoke<Title[]>('list_titles');

export const getTitleDetail = (titleId: number) =>
  invoke<TitleDetail>('get_title_detail', { titleId });

/** Path of a trailer file sitting next to the video, or null. */
export const findLocalTrailer = (videoPath: string) =>
  invoke<string | null>('find_local_trailer', { videoPath });

/** Genres arrive as a JSON array string, or null. */
export function parseGenres(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}
