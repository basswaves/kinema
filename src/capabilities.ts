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
  sleep: boolean;
  shut_down: boolean;
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
