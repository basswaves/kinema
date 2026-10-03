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

const call = <T = void>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(`plugin:media3|${command}`, args);

export async function listen(handle: (event: PlaybackEvent) => void): Promise<() => void> {
  const listener = await addPluginListener<PlaybackEvent>('media3', 'playback', handle);
  return () => void listener.unregister();
}

export const open = (path: string, start: number | null) => call('open', { path, start });
export const stop = () => call('stop');
export const setPaused = (paused: boolean) => call('set_paused', { paused });
export const seek = (seconds: number, relative: boolean) => call('seek', { seconds, relative });

export interface State {
  path: string | null;
  position: number | null;
  duration: number | null;
  paused: boolean;
  ended: boolean;
}

export const state = () => call<State>('state');
