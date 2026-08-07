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
  /**
   * True when this card is the *next* episode to start rather than one already
   * part-watched. `position_secs` is 0 on these, so the progress bar and the
   * "x min left" line have to be suppressed — a bar sitting at 0% reads as a
   * bug, not as "not started yet".
   */
  is_next_up: boolean;
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

/**
 * How a playable file is named on screen: `Show — S01E04`, or just the title
 * when there is no episode numbering.
 *
 * Shared because the same expression was being rebuilt at five call sites, and
 * a label that formats differently depending on which screen launched playback
 * is the kind of inconsistency nobody reports and everybody notices.
 */
export function episodeLabel(
  showTitle: string,
  season: number | null,
  episode: number | null
): string {
  if (season === null || episode === null) return showTitle;
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return `${showTitle} — S${s}E${e}`;
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

/**
 * What pressing Play on a series should start: the earliest episode not yet
 * seen, or the first one if the whole run has been.
 *
 * Asked of the database rather than worked out from a loaded episode list,
 * because the list comes from the provider and a title can be matched with no
 * episode data at all. This reads the files themselves, so it answers even then.
 */
export const firstUnwatchedEpisode = (titleId: number) =>
  invoke<EpisodeRef | null>('first_unwatched_episode', { titleId });

export const getTitlePrefs = (titleId: number) =>
  invoke<TitlePrefs>('get_title_prefs', { titleId });

export const setTitlePrefs = (titleId: number, prefs: TitlePrefs) =>
  invoke<void>('set_title_prefs', { titleId, prefs });

/** Null when the file has no `.skiptro.json` sidecar beside it. */
export const getSkipMarkers = (path: string, fileId: number | null) =>
  invoke<SkipMarkers | null>('get_skip_markers', { path, fileId });
