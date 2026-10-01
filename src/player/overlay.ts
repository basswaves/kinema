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
 * An older mpv cannot, so Kinema's window — hidden behind mpv's anyway — is
 * made full screen for as long as the player is open, and the two sizes
 * match; it is put back afterwards.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
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

/**
 * Whether this mpv's `overlay-add` takes a size to scale to (0.38 and later).
 * True when the version cannot be read: a failure is then not blamed on age.
 */
export function scalesOverlays(version: string | null): boolean {
  const m = version?.match(/(\d+)\.(\d+)/);
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 0 || minor >= 38;
}

async function canScale(): Promise<boolean> {
  const version = await readProperty<string>('mpv-version', 'string').catch(() => null);
  return scalesOverlays(version);
}

/** Start drawing the page into mpv; returns the function that stops it. */
export function startOverlay(): () => void {
  let stopped = false;
  let busy = false;
  let shown = false;
  let warned = false;
  let scaled = true;
  // Whether this pump made Kinema's window full screen, to undo it.
  let madeFullscreen = false;

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
        } catch (e) {
          // mpv before 0.38 takes no size to scale to ("has only 9
          // arguments" in mpv.log; the error itself just says the command
          // failed): drawn at the page's own size, which matches as long as
          // Kinema's window is the size of the screen. Decided by mpv's
          // version, not by the failure: mpv shutting down as the player
          // closes fails it too (seen on the test stick with mpv 0.41), and
          // concluding "old mpv" from that would make Kinema's window full
          // screen after the player had gone.
          if (stopped || (await canScale())) throw e;
          scaled = false;
          console.warn('overlay: this mpv cannot scale the page; matching the window to the screen');
          const win = getCurrentWindow();
          if (!(await win.isFullscreen())) {
            await win.setFullscreen(true);
            madeFullscreen = true;
          }
          // The next photo is taken at the new size, and counts as new even
          // if the window already was full screen and nothing changed.
          await invoke('overlay_reset');
          return;
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
    if (madeFullscreen) void getCurrentWindow().setFullscreen(false).catch(() => undefined);
    void invoke('overlay_reset').catch(() => undefined);
  };
}
