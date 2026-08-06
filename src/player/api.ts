/** Typed wrappers around the Rust playback commands. */
import { invoke } from '@tauri-apps/api/core';

export interface Progress {
  position_secs: number;
  duration_secs: number | null;
  completed: boolean;
}

export interface ContinueItem {
  file_id: number;
  path: string;
  title_id: number;
  title: string;
  kind: string;
  season: number | null;
  episode: number | null;
  episode_name: string | null;
  position_secs: number;
  duration_secs: number | null;
  image_url: string | null;
  /** Cached copy of exactly the image `image_url` points at. */
  image_path: string | null;
  updated_at: number;
}

/** Enough to play a neighbouring episode and label it, in either direction. */
export interface EpisodeRef {
  file_id: number;
  path: string;
  season: number;
  episode: number;
  name: string | null;
  title: string;
}

export interface Segment {
  start: number;
  end: number;
}

export interface SkipMarkers {
  intro: Segment | null;
  credits: Segment | null;
  /** Which sidecar these came from, for diagnostics. */
  sidecar: string | null;
}

export interface TitlePrefs {
  audio_lang: string | null;
  sub_lang: string | null;
  sub_enabled: boolean;
}

export const saveProgress = (fileId: number, positionSecs: number, durationSecs: number | null) =>
  invoke<void>('save_progress', { fileId, positionSecs, durationSecs });

export const getProgress = (fileId: number) => invoke<Progress | null>('get_progress', { fileId });

/**
 * Mark a file watched or unwatched by hand.
 *
 * Unwatching clears the resume point as well: "not watched" and "no history"
 * are the same state, so a file declared unseen must not then resume.
 */
export const setWatched = (fileId: number, watched: boolean) =>
  invoke<void>('set_watched', { fileId, watched });

/**
 * Drop a file's resume point, taking it out of Continue Watching.
 *
 * Deliberately the same operation as un-watching rather than a second command
 * beside it: the resume row *is* the history, so "stop offering me this" and
 * "forget where I was" cannot sensibly disagree. Naming it separately is only
 * so the call site reads as what the user asked for.
 */
export const forgetProgress = (fileId: number) => setWatched(fileId, false);

export const continueWatching = (limit: number) =>
  invoke<ContinueItem[]>('continue_watching', { limit });

export const nextEpisode = (fileId: number) =>
  invoke<EpisodeRef | null>('next_episode', { fileId });

export const previousEpisode = (fileId: number) =>
  invoke<EpisodeRef | null>('previous_episode', { fileId });

export const getTitlePrefs = (titleId: number) =>
  invoke<TitlePrefs>('get_title_prefs', { titleId });

export const setTitlePrefs = (titleId: number, prefs: TitlePrefs) =>
  invoke<void>('set_title_prefs', { titleId, prefs });

/** Null when the file has no `.skiptro.json` sidecar beside it. */
export const getSkipMarkers = (path: string, fileId: number | null) =>
  invoke<SkipMarkers | null>('get_skip_markers', { path, fileId });
