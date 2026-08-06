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
  file_path: string | null;
  file_id: number | null;
}

export interface TitleDetail {
  title: Title;
  episodes: Episode[];
  movie_path: string | null;
  movie_file_id: number | null;
}

export const listTitles = () => invoke<Title[]>('list_titles');

export const getTitleDetail = (titleId: number) =>
  invoke<TitleDetail>('get_title_detail', { titleId });

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
