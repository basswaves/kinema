/**
 * The mouse on mpv's own window, given to the player's page.
 *
 * Where mpv has a window of its own (capabilities `own_window`: Linux), the
 * page is behind it and reaches the screen as a picture (overlay.ts), so the
 * mouse is on mpv's window. mpv reports what it does there (mpvMouse.ts);
 * each event is placed on the page where the picture shows that point
 * (`pageFromVideo`) and done again there as real mouse input (`pointer.rs`).
 * The page's own handlers — click to pause, double click for full screen,
 * the seek bar, the volume wheel, hover — then work as they do on Windows.
 *
 * The pointer itself is mpv's to draw. It is hidden when the controls are,
 * as the page hides its own on Windows (`.player.osd-hidden`, ui.css).
 */
import { invoke } from '@tauri-apps/api/core';
import { mpvSet } from './engine';
import { newEvents, type MouseEvent, type MouseKind } from './mpvMouse';
import { pageFromVideo } from './overlay';

/** Whether the left button is down, from what mpv reported. */
let held = false;
/** One warning in app.log, not one per mouse move. */
let warned = false;

/**
 * The last event handed to the page (mpvMouse.ts `newEvents`). Kept here, at
 * the one place events reach the page, and not by each listener: two
 * listeners once shared it in the engine, and whichever heard a change first
 * marked its events seen — in about half the film openings on a slow Linux
 * computer that was not the player's own, and the page heard no mouse at all.
 */
let lastHandedSeq = 0;

/**
 * Hand on the events of one report from mpv's script that the page has not
 * had yet; any listener may offer the same report, and each event goes to the
 * page once.
 */
export function handMouseEventsToPage(events: MouseEvent[]): void {
  for (const { seq, kind, x, y, time } of newEvents(events, lastHandedSeq)) {
    lastHandedSeq = seq;
    handMouseToPage(kind, x, y, time);
  }
}

/** Do on the page what the mouse did at `x`, `y` on mpv's window. */
export function handMouseToPage(kind: MouseKind, x: number, y: number, time: number): void {
  const at = pageFromVideo(x, y);
  // The state before this event, as GDK reports a button's: still held in
  // the release that ends a drag.
  const wasHeld = held;
  if (kind === 'down') held = true;
  if (kind === 'up') held = false;
  invoke('pointer_event', {
    kind,
    x: at.x,
    y: at.y,
    // GDK's event clock is 32 bits of milliseconds.
    time: Math.max(0, Math.round(time)) % 2 ** 32,
    held: wasHeld,
  }).catch((e) => {
    if (!warned) console.warn('mouse: an event could not be handed to the page', e);
    warned = true;
  });
}

/**
 * Keep mpv's pointer hidden while the controls are, for as long as the
 * player is open. Returns the function that stops, which leaves mpv's
 * pointer showing.
 */
export function startPointerFollowingControls(): () => void {
  const player = document.querySelector('.player');
  if (!player) return () => undefined;
  let hidden: boolean | null = null;
  const follow = () => {
    const now = player.classList.contains('osd-hidden');
    if (now === hidden) return;
    hidden = now;
    // `always` hides it, `no` never does: the page decides when, not mpv.
    void mpvSet('cursor-autohide', now ? 'always' : 'no').catch(() => undefined);
  };
  const observer = new MutationObserver(follow);
  observer.observe(player, { attributes: true, attributeFilter: ['class'] });
  follow();
  return () => {
    observer.disconnect();
    held = false;
    void mpvSet('cursor-autohide', 'no').catch(() => undefined);
  };
}
