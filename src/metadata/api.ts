/** Typed wrappers around the Rust metadata and settings commands. */
import { invoke } from '@tauri-apps/api/core';
import type { MediaFile } from '../library/api';
import type { EpisodeMetadata, TitleMetadata } from './providers';

export interface StoredTitle {
  id: number;
  kind: string;
  provider: string;
  title: string;
  year: number | null;
  overview: string | null;
  poster_url: string | null;
  backdrop_url: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  rating: number | null;
  file_count: number;
}

/** Outcome of one artwork caching pass. */
export interface CacheResult {
  stored: number;
  failed: number;
}

export interface ArtworkStats {
  files: number;
  bytes: number;
  failed: number;
}

export const getSetting = (key: string) => invoke<string | null>('get_setting', { key });

export const setSetting = (key: string, value: string) =>
  invoke<void>('set_setting', { key, value });

export const providerStatus = () => invoke<Array<[string, boolean]>>('provider_status');

export const saveTitle = (title: TitleMetadata) => invoke<number>('save_title', { title });

export const saveEpisodes = (titleId: number, episodes: EpisodeMetadata[]) =>
  invoke<number>('save_episodes', { titleId, episodes });

/**
 * `status` mirrors the `match_status` lifecycle: 'parsed' puts a file back in
 * the review queue, 'ignored' takes it out without pretending it was matched.
 */
export const linkFileToTitle = (
  fileId: number,
  titleId: number | null,
  confidence: number | null,
  reason: string | null,
  status: 'matched' | 'unmatched' | 'ignored' | 'parsed'
) => invoke<void>('link_file_to_title', { fileId, titleId, confidence, reason, status });

export const listTitles = () => invoke<StoredTitle[]>('list_titles');

export const listUnmatched = (limit: number) => invoke<MediaFile[]>('list_unmatched', { limit });

export const resetMatches = () => invoke<number>('reset_matches');

/**
 * Download every artwork URL that is not cached yet. Takes no arguments: what
 * the library needs is a property of the database, not of the calling screen.
 */
export const cacheArtwork = () => invoke<CacheResult>('cache_artwork');

export const artworkStats = () => invoke<ArtworkStats>('artwork_stats');

export const clearArtworkCache = () => invoke<number>('clear_artwork_cache');
