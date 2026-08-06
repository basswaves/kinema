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

export interface NextEpisode {
  file_id: number;
  path: string;
  season: number;
  episode: number;
  name: string | null;
  title: string;
}

export interface TitlePrefs {
  audio_lang: string | null;
  sub_lang: string | null;
  sub_enabled: boolean;
}

export const saveProgress = (fileId: number, positionSecs: number, durationSecs: number | null) =>
  invoke<void>('save_progress', { fileId, positionSecs, durationSecs });

export const getProgress = (fileId: number) => invoke<Progress | null>('get_progress', { fileId });

export const continueWatching = (limit: number) =>
  invoke<ContinueItem[]>('continue_watching', { limit });

export const nextEpisode = (fileId: number) =>
  invoke<NextEpisode | null>('next_episode', { fileId });

export const getTitlePrefs = (titleId: number) =>
  invoke<TitlePrefs>('get_title_prefs', { titleId });

export const setTitlePrefs = (titleId: number, prefs: TitlePrefs) =>
  invoke<void>('set_title_prefs', { titleId, prefs });
