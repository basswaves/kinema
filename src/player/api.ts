/** Typed wrappers around the Rust playback commands. */
import { videoName } from '../library/videos';
import { invoke } from '@tauri-apps/api/core';

export interface Progress {
  position_secs: number;
  duration_secs: number | null;
  completed: boolean;
  /**
   * Where to resume as a share of the file (0–1), when that is all that is
   * known: a resume point from Trakt on a copy never played on this device
   * (trakt_resume.rs). The player opens the file at that share of its length.
   */
  fraction?: number | null;
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
  /** As Progress.fraction: the bar when the length is not known here. */
  fraction?: number | null;
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
  /** A video's folder (kind `video`): `episode_name` is its file name. */
  video_dir?: string | null;
}

/** What the player is asked to play: a file, its label, and where it belongs. */
export interface PlaybackTarget {
  path: string;
  label: string;
  fileId: number | null;
  titleId: number | null;
  /** Shown after the label at the top, where the caller knows it. */
  episodeName?: string | null;
  /** Ignore the stored position: "Play from start". */
  fromStart?: boolean;
  /**
   * A video opened from outside the library (opened.ts): resumed by its path
   * and size. Other targets with no file — a trailer — are not resumed.
   */
  resumeByPath?: boolean;
  /**
   * A file in a Videos folder (videos.ts): track choices are kept per folder,
   * and previous/next step through that folder.
   */
  video?: boolean;
  /**
   * Played from a playlist (playlists.ts): previous, next and Up next follow
   * the playlist from `item` instead of the show or the folder.
   */
  playlist?: { id: number; item: number };
}

/** Enough to play a neighbouring episode and label it, in either direction. */
export interface EpisodeRef {
  file_id: number;
  path: string;
  season: number;
  episode: number;
  name: string | null;
  title: string;
  /** A video in the same folder (videos.rs): `name` is its file name. */
  video?: boolean;
  /** The next item of a playlist: played as this, and named by its label. */
  target?: PlaybackTarget;
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
  /** "Previously on…", from TheIntroDB or IntroDB.app. Always has an end. */
  recap: Segment | null;
  credits: Segment | null;
  /**
   * A film's scene after the credits, from IntroDB.app. Always has an end.
   * Not yet checked against this file: `checkedAgainstFile` in `skip.ts` does
   * that once the file's length is known.
   */
  post_credits: Segment | null;
  /**
   * Which source each segment came from — `skiptro-db`, `sidecar`,
   * `analysis`, `introdb` (TheIntroDB) or `introdb-app` (IntroDB.app).
   * Diagnostic: a skip that fires somewhere surprising should be traceable to
   * the thing that claimed it, without reading the database.
   */
  intro_source: string | null;
  recap_source: string | null;
  credits_source: string | null;
  post_credits_source: string | null;
}

export interface TitlePrefs {
  audio_lang: string | null;
  sub_lang: string | null;
  sub_enabled: boolean;
  /** The second subtitles' language, drawn at the top (desktop); null: none. */
  sub2_lang?: string | null;
  /** Something was chosen in this title; false means the defaults apply. */
  chosen?: boolean;
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
  return `${showTitle} · S${s}E${e}`;
}

/** The label an episode carries into the player, shared with the browsing UI. */
export function episodeRefLabel(episode: EpisodeRef): string {
  if (episode.target) return episode.target.label;
  if (episode.video) return videoName(episode.name ?? episode.path);
  return episodeLabel(episode.title, episode.season, episode.episode);
}

/**
 * What a neighbouring episode is called where the show is already known — Up
 * next and the Next button: `S05E02 · Its name`, or a playlist item's label
 * with its episode's name. Never just the show, which says nothing about
 * which episode comes.
 */
export function episodeRefName(episode: EpisodeRef): string {
  const named = (label: string, name: string | null | undefined) =>
    name ? `${label} · ${name}` : label;
  if (episode.target) return named(episode.target.label, episode.target.episodeName);
  if (episode.video) return videoName(episode.name ?? episode.path);
  const s = String(episode.season).padStart(2, '0');
  const e = String(episode.episode).padStart(2, '0');
  return named(`S${s}E${e}`, episode.name);
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
  creditsStart: number | null = null,
  /** The player's last save as it leaves the file: Trakt hears where it stopped. */
  leaving = false
) =>
  invoke<void>('save_progress', { fileId, positionSecs, durationSecs, creditsStart, leaving });

/**
 * Take Trakt's resume points onto the library where they are newer — on a
 * title's page and Home's Continue rail. Read at most every two minutes;
 * nothing when Trakt is not connected or the switch is off. How many files
 * changed, so the page reads them again.
 */
export const traktResumeSync = () => invoke<number>('trakt_resume_sync');

export const getProgress = (fileId: number) => invoke<Progress | null>('get_progress', { fileId });

/** The resume point of a video that is not in the library, by path and size. */
export const getLooseProgress = (path: string) =>
  invoke<Progress | null>('get_loose_progress', { path });

export const saveLooseProgress = (path: string, positionSecs: number, durationSecs: number | null) =>
  invoke<void>('save_loose_progress', { path, positionSecs, durationSecs });

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

/** The video files either side of `path` in its folder (opened.rs). */
export const folderNeighbours = (path: string) =>
  invoke<{ prev: string | null; next: string | null }>('folder_neighbours', { path });

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
 * sidecar, the app's own analysis, TheIntroDB and IntroDB.app and returns the
 * winner per segment, so there is one call here regardless of how many sources
 * are configured.
 */
export const getSkipMarkers = (path: string, fileId: number | null) =>
  invoke<SkipMarkers | null>('get_skip_markers', { path, fileId });
