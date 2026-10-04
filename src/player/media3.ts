/**
 * The player on Android: Media3, in Kotlin (`Media3Plugin.kt`), drawing on a
 * surface beneath this page.
 *
 * Only `engine.ts` imports this, and only for Kinema's own terms — open,
 * pause, seek, stop, what is playing, and the `PlaybackEvent` stream, which
 * the plugin already sends in those terms. mpv's terms (the stats panel, the
 * output check, the track internals) have no Media3 counterpart here yet.
 */
import { addPluginListener, invoke } from '@tauri-apps/api/core';
import type { PlaybackEvent } from './engine';
import type { Film, Screen } from './displayMode';
import type { SystemOutput } from './systemOutput';

const call = <T = void>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(`plugin:media3|${command}`, args);

export async function listen(handle: (event: PlaybackEvent) => void): Promise<() => void> {
  const listener = await addPluginListener<PlaybackEvent>('media3', 'playback', handle);
  return () => void listener.unregister();
}

/**
 * A film on a network share Kinema opens itself (`smb://…`) is read through
 * the core (stream.rs), which hands back an address on this device for it.
 */
export async function open(path: string, start: number | null) {
  const url = /^smb:/i.test(path) ? await invoke<string>('stream_address', { path }) : null;
  return call('open', { path, start, url });
}
export const stop = () => call('stop');
export const setPaused = (paused: boolean) => call('set_paused', { paused });
export const seek = (seconds: number, relative: boolean) => call('seek', { seconds, relative });

export interface State {
  path: string | null;
  position: number | null;
  duration: number | null;
  paused: boolean;
  ended: boolean;
  /** The film's picture, once Media3 has chosen its video track. */
  video: Film | null;
}

export const state = () => call<State>('state');

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
