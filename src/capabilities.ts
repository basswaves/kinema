/**
 * What this build of Kinema can do on the system it runs on, asked of Rust
 * once (`capabilities.rs`).
 *
 * Show or hide things by these answers, never by the system's name: "can this
 * switch the refresh rate?" stays right when a second system learns to, where
 * "is this Windows?" would have to be found and changed everywhere it was
 * asked. `system` is for text only — "through the Windows mixer".
 *
 * Until the answer arrives nothing is claimed. It is asked for at startup, and
 * everything that depends on it (Leave, Settings) opens only when someone
 * chooses it, long after.
 */
import { invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';

export interface Capabilities {
  system: string;
  engine: string;
  /** mpv's `gpu-api` and `hwdec` for this system (see capabilities.rs). */
  mpv_video: { gpu_api: string; hwdec: string; own_window: boolean };
  equipment_detection: boolean;
  /** Sound can go straight to the receiver (Settings → Sound). */
  audio_direct: boolean;
  display_switching: boolean;
  /** Kinema runs in a window, so a desk is possible. Where it is not
   * (Android), the layout is always the TV's and nobody is asked (tv.ts). */
  windowed: boolean;
  /** The system has a folder picker; where not, Kinema shows the folders
   * itself (library/folders.ts). */
  folder_picker: boolean;
  /** The system turns HDR on and passes sound through by itself (Android):
   * Kinema only matches the screen, with one switch (player/systemOutput.ts). */
  system_output: boolean;
  /** Kinema can run programs the user installed (ffmpeg, ffprobe, Skiptro).
   * Where it cannot (Android), nothing offers them or says they are missing. */
  runs_programs: boolean;
  /** The system puts its own keyboard on screen when a field takes typing
   * (Android): it opens on OK, not on arriving at a field (ui/typing.ts). */
  screen_keyboard: boolean;
  /** The system can show a folder in a file manager (logs, safety copies). */
  opens_folders: boolean;
  /** The system can hand a file to another app (Android's share sheet). */
  shares_files: boolean;
  /** Kinema opens network shares itself, as the system does not (Android):
   * the folder browser offers the network (library/folders.ts). */
  network_shares: boolean;
  /** The system has its own Back button the page never sees as a key
   * (Android's): it is listened for and passed on (backButton.ts). */
  back_button: boolean;
  sleep: boolean;
  shut_down: boolean;
}

/**
 * Who sets the screen up, for wording: "switched off in Windows", or on Linux
 * "in the desktop" — HDR and the mode belong to GNOME, KDE and the rest there,
 * not to "Linux". Windows when not known, as everything was written for it.
 */
export function screenOwner(system?: string | null): string {
  return !system || system === 'Windows' ? 'Windows' : 'the desktop';
}

let current: Capabilities | null = null;
let asked: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Ask Rust, once; later calls wait for the same answer. */
export function loadCapabilities(): Promise<void> {
  asked ??= invoke<Capabilities>('capabilities')
    .then((answer) => {
      current = answer;
      console.log('capabilities', answer);
      listeners.forEach((listener) => listener());
    })
    .catch((e) => {
      // Nothing claimed rather than everything: a control that does nothing
      // is the failure this exists to prevent.
      console.error('capabilities: no answer, so nothing optional is offered', e);
    });
  return asked;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The answer as it stands, for code outside React; null until it arrives. */
export function capabilitiesNow(): Capabilities | null {
  return current;
}

/** The answer, or null until it has arrived. */
export function useCapabilities(): Capabilities | null {
  return useSyncExternalStore(subscribe, () => current);
}
