/**
 * Whether a film is playing, as far as the library's background work cares.
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

/** Resolves at once when nothing is playing; otherwise once the film is closed. */
export async function yieldToPlayback(): Promise<void> {
  while (playing) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
}
