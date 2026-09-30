/**
 * The player's page drawn over the video by mpv, where mpv has a window of
 * its own (capabilities `own_window`: Linux). See `overlay.rs` for why.
 *
 * While the player is open, the page is photographed ten times a second —
 * enough for a clock and a moving focus ring — and each photo that differs
 * from the last is handed to mpv's `overlay-add`; a photo with nothing
 * visible removes the overlay instead. A photo takes a millisecond or two,
 * and never more than one is asked for at a time.
 *
 * The photo is the size of Kinema's window; mpv 0.38 and later scale it to
 * their own (`dw`/`dh`), so the controls land where they would on the screen.
 */
import { invoke } from '@tauri-apps/api/core';
import { mpvCommand, readProperty } from './engine';

interface OverlayFrame {
  changed: boolean;
  empty: boolean;
  path: string;
  width: number;
  height: number;
  stride: number;
}

const INTERVAL_MS = 100;
const ID = 0;

/** Start drawing the page into mpv; returns the function that stops it. */
export function startOverlay(): () => void {
  let stopped = false;
  let busy = false;
  let shown = false;
  let warned = false;
  let scaled = true;

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const frame = await invoke<OverlayFrame>('overlay_frame');
      if (stopped || !frame.changed) return;
      if (frame.empty) {
        if (shown) await mpvCommand('overlay-remove', [ID]);
        shown = false;
        return;
      }
      const picture = [ID, 0, 0, frame.path, 0, 'bgra', frame.width, frame.height, frame.stride];
      if (scaled) {
        const w = (await readProperty<number>('osd-width', 'int64')) || frame.width;
        const h = (await readProperty<number>('osd-height', 'int64')) || frame.height;
        try {
          await mpvCommand('overlay-add', [...picture, w, h]);
          shown = true;
          return;
        } catch {
          // mpv before 0.38 takes no size to scale to ("has only 9
          // arguments"): drawn at the page's own size, which matches as
          // long as Kinema's window is the size of the screen.
          scaled = false;
          console.warn('overlay: this mpv cannot scale the page; drawing it at its own size');
        }
      }
      await mpvCommand('overlay-add', picture);
      shown = true;
    } catch (e) {
      // Once: a failure here repeats ten times a second.
      if (!warned) console.warn('overlay: the page could not be drawn over the video', e);
      warned = true;
    } finally {
      busy = false;
    }
  };

  const timer = window.setInterval(() => void tick(), INTERVAL_MS);
  void tick();

  return () => {
    stopped = true;
    window.clearInterval(timer);
    if (shown) void mpvCommand('overlay-remove', [ID]).catch(() => undefined);
    void invoke('overlay_reset').catch(() => undefined);
  };
}
