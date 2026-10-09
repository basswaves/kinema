/**
 * The player on Android: Media3, in Kotlin (`Media3Plugin.kt`), drawing on a
 * surface beneath this page.
 *
 * Only `engine.ts` imports this, and only for Kinema's own terms — open,
 * pause, seek, stop, volume, tracks, what is playing, and the `PlaybackEvent` stream, which
 * the plugin already sends in those terms. mpv's terms (the stats panel, the
 * output check, the track internals) have no Media3 counterpart here yet.
 */
import { addPluginListener, invoke } from '@tauri-apps/api/core';
import type { PlaybackEvent, Track } from './engine';
import type { Film, Screen } from './displayMode';
import type { SystemOutput } from './systemOutput';

/**
 * A refusal from the plugin, in its own words: it arrives as an object, which
 * the page would otherwise show as "[object Object]".
 */
function inWords(e: unknown): Error {
  if (e instanceof Error) return e;
  if (typeof e === 'string') return new Error(e);
  const message = (e as { message?: unknown } | null)?.message;
  return new Error(typeof message === 'string' ? message : JSON.stringify(e));
}

const call = <T = void>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(`plugin:media3|${command}`, args).catch((e: unknown) => {
    throw inWords(e);
  });

export async function listen(handle: (event: PlaybackEvent) => void): Promise<() => void> {
  const listener = await addPluginListener<PlaybackEvent>('media3', 'playback', handle);
  return () => void listener.unregister();
}

/** A subtitle file beside the film, as the core finds them (subtitle_files.rs). */
interface SubtitleFile {
  path: string;
  language: string | null;
  forced: boolean;
  hearing_impaired: boolean;
}

/**
 * A file on a network share Kinema opens itself (`smb://…`) is read through
 * the core (stream.rs), which hands back an address on this device for it.
 */
const isShare = (path: string) => /^smb:/i.test(path);
const readable = (path: string) =>
  isShare(path) ? invoke<string>('stream_address', { path }) : Promise.resolve(path);

/**
 * Open a film, with the subtitle files beside it: Media3 takes them only as
 * a film opens, and does not look for them itself as mpv does. A folder that
 * cannot be read means none, never a film that will not open.
 */
export async function open(path: string, start: number | null) {
  const url = isShare(path) ? await readable(path) : null;
  const found = await invoke<SubtitleFile[]>('subtitle_files', { path }).catch((e) => {
    console.warn('media3: subtitle files beside the film not looked for', e);
    return [];
  });
  const subtitles = await Promise.all(
    found.map(async (f) => ({
      uri: await readable(f.path),
      language: f.language,
      forced: f.forced,
      hearingImpaired: f.hearing_impaired,
    }))
  );
  return call('open', { path, start, url, subtitles });
}

/**
 * A subtitle file for the film that is open — the film is opened again with
 * it, at the same moment. Answers once it is chosen and showing.
 */
export const addSubtitle = (path: string, language: string, label: string) =>
  call('add_subtitle', { uri: path, language, label });
export const stop = () => call('stop');
export const setPaused = (paused: boolean) => call('set_paused', { paused });
export const seek = (seconds: number, relative: boolean) => call('seek', { seconds, relative });
/** 0–100, on the same curve as mpv's; kept by the plugin across files. */
export const setVolume = (level: number) => call('set_volume', { level });
export const setMuted = (muted: boolean) => call('set_muted', { muted });

/** The open file's tracks, already in Kinema's terms (FFmpeg's format names). */
export const tracks = () => call<{ tracks: Track[] }>('tracks').then((r) => r.tracks);
/** Answers once Media3 has made the choice, so tracks read after it say so. */
export const selectTrack = (kind: 'audio' | 'sub', id: number) => call('select_track', { kind, id });
export const showSubtitles = (visible: boolean) => call('show_subtitles', { visible });

export interface State {
  path: string | null;
  position: number | null;
  duration: number | null;
  paused: boolean;
  ended: boolean;
  /** The film's picture, once Media3 has chosen its video track. */
  video: Film | null;
  /** The sound leaves untouched for the receiver, once it has opened. */
  untouched: boolean;
  /** Whether subtitles show (the chosen track stays chosen when they do not). */
  subtitlesShown: boolean;
}

export const state = () => call<State>('state');

/** What Media3 says it is doing, for the details panel (statsMedia3.ts). */
export interface Facts {
  video?: {
    /** FFmpeg's name, as everywhere in Kinema. */
    codec: string | null;
    /** "HEVC, 3840×2160, 10-bit HDR". */
    described: string;
    /** The codec string the file gives ("hvc1.2.4.L153"). */
    codecs: string | null;
    width: number;
    height: number;
    fps: number | null;
    bitrate: number | null;
    transfer: 'pq' | 'hlg' | 'sdr' | null;
    dolbyVision: boolean;
    /** The decoder Media3 opened, by its system name. */
    decoder: string | null;
    /** The device's own video hardware, rather than software. */
    hardware: boolean | null;
  };
  /** The video decoder's count of frames since the file opened. */
  frames?: { rendered: number; dropped: number; skipped: number };
  audio?: {
    /** "Dolby Digital Plus 5.1", as Media3Plugin.kt names it. */
    name: string;
    channels: number | null;
    sampleRate: number | null;
    way: 'untouched' | 'decoded';
    decoder: string | null;
  };
  bufferedSeconds?: number;
  /**
   * The screen's mode now, and the HDR kinds Android says it takes
   * ("HDR10", "HLG", "Dolby Vision", "HDR10+") — Android's word, not the TV's.
   */
  screen: {
    width: number;
    height: number;
    hz: number;
    rate: number;
    hdr?: string[];
    /** How many modes Android is given; with one, the device decides what the TV gets. */
    modes?: number;
  };
}

export const facts = () => call<Facts>('facts');

/** The screen and the modes Android offers for it. */
export const screen = () => call<Screen>('screen');
/** Ask Android for a mode; answers with the mode the screen is in after. */
export const setMode = (width: number, height: number, rate: number) =>
  call<{ width: number; height: number; hz: number; rate: number }>('set_mode', {
    width,
    height,
    rate,
  });
export const restoreMode = () =>
  call<{ restored: boolean }>('restore_mode').then((r) => r.restored);
/** What the TV and the receiver take, as Android reports it. */
export const output = () => call<SystemOutput>('output');
