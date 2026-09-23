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
  /**
   * `null` means "to the end of the file". Credits do exactly that, and
   * TheIntroDB states it with a null of its own rather than a number, so
   * storing one here would be inventing data.
   *
   * An **intro** always has a real end — every source drops one that does not,
   * since there would be nowhere for Skip to seek to.
   */
  end: number | null;
}

export interface SkipMarkers {
  intro: Segment | null;
  credits: Segment | null;
  /**
   * Which source each segment came from — `skiptro-db`, `sidecar` or
   * `introdb`. Diagnostic: a skip that fires somewhere surprising should be
   * traceable to the thing that claimed it, without reading the database.
   */
  intro_source: string | null;
  credits_source: string | null;
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

/**
 * Store a resume point. `creditsStart` is where the credits begin when that is
 * known from a marker or a named chapter — never from the tail guess — so a
 * position inside them counts as watched even short of 94%.
 */
export const saveProgress = (
  fileId: number,
  positionSecs: number,
  durationSecs: number | null,
  creditsStart: number | null = null
) => invoke<void>('save_progress', { fileId, positionSecs, durationSecs, creditsStart });

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
 * Take a title out of Continue Watching until something of it is watched again.
 *
 * This used to be "forget the resume point", on the reasoning that "stop
 * offering me this" and "forget where I was" were the same thing. They are
 * not: a "Next episode" card has no resume point to forget, so Remove did
 * nothing to it, and forgetting a part-watched episode's position just turned
 * its card into a "Next episode" card. The resume point is now kept.
 */
export const dismissContinue = (titleId: number) =>
  invoke<void>('dismiss_continue', { titleId });

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

/**
 * Intro and credits markers, from whichever source has them.
 *
 * Null when no source does. Rust ranks Skiptro's database, a `.skiptro.json`
 * sidecar and TheIntroDB and returns the winner per segment, so there is one
 * call here regardless of how many sources are configured.
 */
export const getSkipMarkers = (path: string, fileId: number | null) =>
  invoke<SkipMarkers | null>('get_skip_markers', { path, fileId });
