/**
 * Whether a film is playing or Kinema has left the screen, as far as the
 * library's background work cares.
 *
 * A scan, a match and the pictures after it all compete with the film for a
 * weak box's processor and its network. They wait instead: the scan pipeline
 * and the matcher call {@link yieldToPlayback} between their steps and sit
 * there while the player is open. The Rust side is told too (`set_playing`),
 * so the subprocess stages it runs itself can give way in the same moment.
 */
import { invoke } from '@tauri-apps/api/core';

/** How often a waiting step looks again. */
const POLL_MS = 1000;

let playing = false;
let behind = false;
const whenBack = new Set<() => void>();

/** The player screen opened (`true`) or closed (`false`). */
export function setPlaybackActive(on: boolean): void {
  if (playing === on) return;
  playing = on;
  // Told to the native side as well; a failure there changes nothing here,
  // and a build without the command (a test, the mock) must not notice.
  try {
    void Promise.resolve(invoke('set_playing', { on })).catch(() => undefined);
  } catch {
    // no backend to tell
  }
}

export function isPlaybackActive(): boolean {
  return playing;
}

/**
 * Kinema left the screen (`true`) or came back (`false`) — Android only
 * (`presence.ts`). The library's work advances only while Kinema is in front:
 * behind another app it would take that app's processor and line, and nothing
 * on screen would say why the box had gone slow.
 */
export function setBehindScreen(on: boolean): void {
  if (behind === on) return;
  behind = on;
  try {
    void Promise.resolve(invoke('set_behind', { on })).catch(() => undefined);
  } catch {
    // no backend to tell
  }
  if (!on) for (const listener of [...whenBack]) listener();
}

export function isBehindScreen(): boolean {
  return behind;
}

/** Called each time Kinema comes back to the screen. */
export function onBackOnScreen(listener: () => void): () => void {
  whenBack.add(listener);
  return () => {
    whenBack.delete(listener);
  };
}

/**
 * Resolves at once when the way is clear; otherwise once the film is closed
 * and Kinema is on the screen.
 */
export async function yieldToPlayback(): Promise<void> {
  while (playing || behind) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
}
