/**
 * Videos folders (LOCAL-MEDIA.md phase 2): what is neither a film nor a show,
 * shown as it lies on disk. The commands are in `videos.rs`; what is here is
 * how a page names, dates and groups the files.
 */
import { invoke } from '@tauri-apps/api/core';
import type { PlaybackTarget, TitlePrefs } from '../player/api';
import type { LibraryRoot } from './api';

export interface VideoItem {
  id: number;
  path: string;
  parent_dir: string;
  file_name: string;
  modified_at: number;
  position_secs: number;
  duration_secs: number | null;
  completed: boolean;
  /** The cached frame from the file, once one has been taken. */
  frame: string | null;
}

export const listVideos = (rootId: number) => invoke<VideoItem[]>('list_videos', { rootId });
export const listAllVideos = () => invoke<VideoItem[]>('list_all_videos');
/** A frame from the file, taken now if need be; null where none can be. */
export const videoFrame = (fileId: number) => invoke<string | null>('video_frame', { fileId });
export const getVideoPrefs = (fileId: number) => invoke<TitlePrefs>('get_video_prefs', { fileId });
export const setVideoPrefs = (fileId: number, prefs: TitlePrefs) =>
  invoke<void>('set_video_prefs', { fileId, prefs });
export const dismissContinueVideo = (fileId: number) =>
  invoke<void>('dismiss_continue_video', { fileId });

const VIDEO_EXTENSION = /\.[a-z0-9]{2,4}$/i;

/**
 * A file's name as a tile shows it: no extension, separators as spaces.
 * Nothing else is taken away — a home video's name is whatever its owner
 * typed or the camera wrote, and there is no release name to clean up.
 */
export function videoName(fileName: string): string {
  const bare = fileName.replace(VIDEO_EXTENSION, '');
  const spaced = bare.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced || bare;
}

/**
 * When a video was made: a date in its name (2024-06-01, 20240601,
 * 2024_06_01 — what cameras and phones write) or, without one, the file's own
 * date. As a `Date` at local midnight for a name, the file's time otherwise.
 */
export function videoDate(fileName: string, modifiedSecs: number): Date | null {
  const m = /(?:^|\D)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:\D|$)/.exec(
    fileName
  );
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return modifiedSecs > 0 ? new Date(modifiedSecs * 1000) : null;
}

/** Names compared as a file manager does: numbers by value, case ignored. */
export const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export interface VideoGroup {
  /** The folder the group's files are in. */
  dir: string;
  /** Empty for the Videos folder's own files; else the sub-folder's path inside it. */
  name: string;
  items: VideoItem[];
}

/** The last part of a path, either separator. */
export function lastPart(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() ?? trimmed;
}

/**
 * Files grouped by the folder they are in: the Videos folder's own files first,
 * then each sub-folder in file-manager order, named by its path below `root`.
 * Within a group, the order a file manager lists them — the same order the
 * player's previous/next steps through (`videos::adjacent`).
 */
export function groupVideos(items: VideoItem[], root: string): VideoGroup[] {
  const byDir = new Map<string, VideoItem[]>();
  for (const item of items) {
    const list = byDir.get(item.parent_dir);
    if (list) list.push(item);
    else byDir.set(item.parent_dir, [item]);
  }
  const rootKey = root.replace(/[\\/]+$/, '');
  const groups = [...byDir.entries()].map(([dir, list]) => {
    const inside = dir.replace(/[\\/]+$/, '');
    const name =
      inside.toLowerCase() === rootKey.toLowerCase()
        ? ''
        : inside.toLowerCase().startsWith(rootKey.toLowerCase())
          ? inside.slice(rootKey.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
          : lastPart(inside);
    return {
      dir,
      name,
      items: list.sort((a, b) => naturalCompare(a.file_name, b.file_name)),
    };
  });
  return groups.sort((a, b) =>
    a.name === '' ? -1 : b.name === '' ? 1 : naturalCompare(a.name, b.name)
  );
}

/**
 * Videos whose name holds every word of `query`, case ignored; nothing for a
 * query shorter than two letters, as a title search would drown in them.
 */
export function searchVideos(videos: VideoItem[], query: string): VideoItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (query.trim().length < 2) return [];
  return videos.filter((v) => {
    const name = videoName(v.file_name).toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

/**
 * Where Play all starts in a group: the first video not yet finished, else
 * the first — as a show's Play does with its episodes.
 */
export function playAllStart(group: VideoGroup): VideoItem | null {
  return group.items.find((v) => !v.completed) ?? group.items[0] ?? null;
}

/** What a video plays as: its own name on top, steps through its folder. */
export function videoTarget(video: VideoItem): PlaybackTarget {
  return {
    path: video.path,
    label: videoName(video.file_name),
    fileId: video.id,
    titleId: null,
    video: true,
  };
}

/** The Videos folders among the library folders. */
export const videosRoots = (roots: LibraryRoot[]) => roots.filter((r) => r.kind === 'videos');
