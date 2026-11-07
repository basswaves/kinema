/**
 * Starting again after the page's own process ended (`page_life.rs`).
 *
 * The page is gone and everything it knew with it, but on a computer mpv is
 * another matter: it never stopped, and the film is still playing behind a
 * new, empty page that knows nothing of it. So the new page asks mpv what it is
 * playing and goes back to that, where it was — and when there is nothing to go
 * back to, puts away what the old page left set: the sound, the screen's mode,
 * the background work held back for a film.
 */
import { invoke } from '@tauri-apps/api/core';
import type { PlaybackTarget } from './api';
import { releaseAudioDevice } from './audioOutput';
import { restoreScreen } from './displaySwitch';
import { filmPlayingNow, fitWindowForPlayer, stopPlayback } from './engine';

/** What to say, set once at the start; null on an ordinary start. */
let said: string | null = null;

/** The words for what happened, after `recoverFromPageEnd`. */
export function pageEndedNotice(): string | null {
  return said;
}

/** What the person is told. */
export function noticeFor(why: string, filmBack: boolean): string {
  const cause = why === 'memory' ? 'used too much memory' : 'stopped unexpectedly';
  const film = filmBack ? ' Your film went on from where it was.' : '';
  return (
    `The part of Kinema that draws this window ${cause}, so it was started again.${film} ` +
    'Your library is not affected. If this keeps happening, the computer may be short of memory.'
  );
}

/**
 * If the last page ended by itself: decide what this one opens on, and what it
 * says. Never fails: an answer that cannot be had is an ordinary start.
 */
export async function recoverFromPageEnd(
  targetFor: (path: string) => Promise<PlaybackTarget>
): Promise<PlaybackTarget | null> {
  const why = await invoke<string | null>('page_recovery').catch(() => null);
  if (!why) return null;
  const film = await filmPlayingNow().catch(() => null);
  console.warn(`page: the last page ended (${why}); ${film ? 'going back to the film' : 'no film to go back to'}`);
  said = noticeFor(why, film !== null);
  if (film) {
    const target = await targetFor(film.path);
    return { ...target, resumeAt: film.position, startPaused: film.paused };
  }
  await stopPlayback().catch(() => undefined);
  await releaseAudioDevice();
  await restoreScreen();
  await fitWindowForPlayer('close').catch(() => undefined);
  // Directly: this page has not told it anything, so it thinks it is already off.
  await invoke('set_playing', { on: false }).catch(() => undefined);
  return null;
}
