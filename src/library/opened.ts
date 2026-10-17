/**
 * A video handed to Kinema from outside (opened.rs): the file Kinema was
 * started for, one a second Kinema passed on, or one dropped on the window.
 *
 * A file a library folder holds plays as that library file — its resume
 * point, its languages, Skip intro. Anything else plays as a video of its own,
 * resumed by path and size.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { episodeLabel, type PlaybackTarget } from '../player/api';

/** What opened.rs says: a file, and whether Kinema was started for it. */
export interface Opened {
  path: string;
  launched: boolean;
  /** When Kinema started, ms since 1970. */
  started_ms: number;
}

interface LibraryFile {
  file_id: number;
  title_id: number | null;
  title: string | null;
  season: number | null;
  episode: number | null;
  episode_name: string | null;
}

/** The event opened.rs sends a second Kinema's file on. */
const EVENT = 'open-video';

/** The file's own name, without its folder or extension: `Holiday 2019`. */
export function nameOf(path: string): string {
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** What the player is given for `path`: the library's file, or the file alone. */
export async function targetFor(path: string): Promise<PlaybackTarget> {
  const found = await invoke<LibraryFile | null>('library_file', { path }).catch(() => null);
  if (!found) return { path, label: nameOf(path), fileId: null, titleId: null, resumeByPath: true };
  return {
    path,
    label: found.title ? episodeLabel(found.title, found.season, found.episode) : nameOf(path),
    fileId: found.file_id,
    titleId: found.title_id,
    episodeName: found.episode_name,
  };
}

/** A video and how it came, ready for the player. */
export interface OpenRequest {
  target: PlaybackTarget;
  /** Kinema was started for it: it closes when the video is done. */
  launched: boolean;
}

let atLaunch: OpenRequest | null = null;
/** When the Kinema started for `atLaunch` began; 0 once its frame is logged. */
let launchStarted = 0;

/**
 * Ask once, before the first view is drawn, whether Kinema was started for a
 * video — so it goes straight to the player and Home is never shown first.
 * Never fails: an answer that cannot be had is "no".
 */
export async function loadLaunchRequest(): Promise<void> {
  try {
    const opened = await invoke<Opened | null>('opened_at_launch');
    if (opened) {
      atLaunch = { target: await targetFor(opened.path), launched: true };
      launchStarted = opened.started_ms;
    }
  } catch (e) {
    console.warn('opened: could not ask for a file at launch', e);
  }
}

/** The video Kinema was started for, if any (after `loadLaunchRequest`). */
export function launchRequest(): OpenRequest | null {
  return atLaunch;
}

/**
 * The player showed its first frame of `path`. For the video Kinema was
 * started for, the log says how long that took from starting — the time from
 * a double-click to a picture, less Windows starting the program.
 */
export function noteFirstFrame(path: string): void {
  if (!launchStarted || atLaunch?.target.path !== path) return;
  console.info(`opened: first frame ${Date.now() - launchStarted} ms after Kinema started`);
  launchStarted = 0;
}

/**
 * Hear of videos opened while Kinema runs: passed on by a second Kinema, or
 * dropped on the window. Returns the way to stop listening.
 */
export function listenForVideos(play: (request: OpenRequest) => void): () => void {
  let stopped = false;
  const offs: (() => void)[] = [];
  const keep = (off: () => void) => (stopped ? off() : offs.push(off));

  const open = (path: string) =>
    void targetFor(path).then((target) => {
      if (!stopped) play({ target, launched: false });
    });

  listen<Opened>(EVENT, (e) => open(e.payload.path))
    .then(keep)
    .catch((e) => console.warn('opened: could not listen for files', e));

  getCurrentWebview()
    .onDragDropEvent((e) => {
      if (e.payload.type !== 'drop') return;
      void invoke<string | null>('playable_path', { paths: e.payload.paths })
        .then((path) => path && open(path))
        .catch((err) => console.warn('opened: dropped files not read', err));
    })
    .then(keep)
    .catch((e) => console.warn('opened: could not listen for dropped files', e));

  return () => {
    stopped = true;
    offs.forEach((off) => off());
  };
}
