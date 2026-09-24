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
  trailer_key: string | null;
  trailer_site: string | null;
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

/** A title that could carry a trailer key but has none stored yet. */
export interface TrailerTarget {
  id: number;
  tmdb_id: string;
  kind: string;
}

export const getSetting = (key: string) => invoke<string | null>('get_setting', { key });

export const setSetting = (key: string, value: string) =>
  invoke<void>('set_setting', { key, value });

/** Where the logs live: `<app data>/logs`, with mpv's log beside `app.log`. */
export interface LogPaths {
  dir: string;
  mpv_log: string;
}

export const logPaths = () => invoke<LogPaths>('log_paths');

/** Show the log folder in Explorer, for attaching logs to a bug report. */
export const openLogFolder = () => invoke<void>('open_log_folder');


export const saveTitle = (title: TitleMetadata) => invoke<number>('save_title', { title });

export const saveEpisodes = (titleId: number, episodes: EpisodeMetadata[]) =>
  invoke<number>('save_episodes', { titleId, episodes });

/*
 * What happened to a group of files — never which status that means. The
 * backend owns the file's lifecycle (`src-tauri/src/lifecycle.rs`): what a
 * match, a refusal or an unlink does to the hold and to the queues is decided
 * there, in one place. Each takes a list, because every caller has a group.
 */

/** The matcher, or a person in Fix match, chose this title. Ends any hold. */
export const recordMatch = (
  fileIds: number[],
  titleId: number,
  confidence: number | null,
  reason: string | null
) => invoke<number>('record_match', { fileIds, titleId, confidence, reason });

/** The scorer refused. Waits in Needs attention until a provider key changes. */
export const recordRefusal = (fileIds: number[], confidence: number | null, reason: string) =>
  invoke<number>('record_refusal', { fileIds, confidence, reason });

/** The provider did not answer. Nothing was decided; the next scan asks again. */
export const recordProviderFailure = (fileIds: number[], reason: string) =>
  invoke<number>('record_provider_failure', { fileIds, reason });

/** Out of the queue by hand — trailers, samples, extras. Reversible. */
export const ignoreFileIds = (fileIds: number[]) => invoke<number>('ignore_files', { fileIds });

/** Back into the queue: un-ignoring. */
export const returnToReview = (fileIds: number[]) =>
  invoke<number>('return_to_review', { fileIds });

/**
 * Take a wrong match off some files and hold them for a decision by hand.
 *
 * Not the same as returning them to review: those go back as `parsed`, which
 * the automatic matcher takes up again — and it made the same wrong choice at
 * the next launch, undoing the unlink. Held files wait in Needs attention.
 */
export const unlinkFiles = (fileIds: number[], reason: string) =>
  invoke<number>('unlink_files', { fileIds, reason });

export const listTitles = () => invoke<StoredTitle[]>('list_titles');

export const listUnmatched = (limit: number) => invoke<MediaFile[]>('list_unmatched', { limit });

/** Everything the review queue works on — refused matches plus ignored files. */
export const listNeedsReview = (limit: number) =>
  invoke<MediaFile[]>('list_needs_review', { limit });

/** Just the number, for the button that opens the queue. */
export const countNeedsReview = () => invoke<number>('count_needs_review');

export const resetMatches = () => invoke<number>('reset_matches');

/**
 * Download every artwork URL that is not cached yet. Takes no arguments: what
 * the library needs is a property of the database, not of the calling screen.
 */
export const cacheArtwork = () => invoke<CacheResult>('cache_artwork');

export const artworkStats = () => invoke<ArtworkStats>('artwork_stats');

export const clearArtworkCache = () => invoke<number>('clear_artwork_cache');

/** Titles matched before trailers, logos or cast were being stored. */
export const listTitlesNeedingDetail = () =>
  invoke<TrailerTarget[]>('list_titles_needing_detail');

