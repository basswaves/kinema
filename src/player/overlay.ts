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
 * Once a photo has come back empty — the controls hidden, which is most of a
 * film — no more are taken until the page changes (`watchForChanges`): at 4K
 * each photo is 33 MB to copy and compare, for a picture of nothing.
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
 * Page (CSS) pixels per pixel of mpv's window, as the page was last drawn —
 * what `pageFromVideo` needs. Null before the first drawing.
 */
let drawnScale: { x: number; y: number } | null = null;

/**
 * Where on the page a point of mpv's window is, in CSS pixels: the mouse
 * lands on mpv's window, and is handed on to the page there (pageMouse.ts).
 * Before anything has been drawn, the two are taken to be the same size.
 */
export function pageFromVideo(x: number, y: number): { x: number; y: number } {
  const ratio = window.devicePixelRatio || 1;
  const scale = drawnScale ?? { x: 1 / ratio, y: 1 / ratio };
  return { x: x * scale.x, y: y * scale.y };
}

/**
 * The scale `pageFromVideo` uses, for a picture `drawn` device pixels of the
 * page shown across `shown` pixels of mpv's window.
 */
export function videoToPageScale(
  drawn: { width: number; height: number },
  shown: { width: number; height: number },
  ratio: number
): { x: number; y: number } {
  return { x: drawn.width / ratio / shown.width, y: drawn.height / ratio / shown.height };
}

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

/**
 * The largest box of the film's shape (`aspect`, width ÷ height) that fits in
 * a page of `width` × `height`, at its top left.
 *
 * Kinema's window is whatever size the desktop gives it — floated at the
 * screen's size where that works (display.rs `player_window`), but a tiling
 * desktop may squeeze it beside the film's window, and Sway 1.11 floated it
 * 90 pixels larger than asked. Scaling a page of another shape to mpv's
 * stretches the controls, so the player is laid out in this box instead and
 * only the box is drawn: the controls keep their shape on any desktop, and
 * the only thing a desktop can cost is sharpness.
 */
export function stageFor(width: number, height: number, aspect: number): { width: number; height: number } {
  if (!(aspect > 0) || width <= 0 || height <= 0) return { width, height };
  return width / height > aspect
    ? { width: Math.round(height * aspect), height }
    : { width, height: Math.round(width / aspect) };
}

/**
 * Lay the player out in `stage` (device pixels), or across the whole page
 * when null. The box is in CSS pixels on the root; ui.css sizes `.player`
 * from it.
 */
function setStage(stage: { width: number; height: number } | null): void {
  const root = document.documentElement;
  if (!stage) {
    delete root.dataset.stage;
    root.style.removeProperty('--stage-w');
    root.style.removeProperty('--stage-h');
    return;
  }
  const ratio = window.devicePixelRatio || 1;
  root.dataset.stage = 'fit';
  root.style.setProperty('--stage-w', `${stage.width / ratio}px`);
  root.style.setProperty('--stage-h', `${stage.height / ratio}px`);
}

/**
 * The parts the player hides by fading them out rather than removing them.
 * They go on changing while hidden — the seek bar and the clock follow the
 * film — and nothing in them can be seen, so a change there needs no photo.
 * The class that hides them changes on `.player` itself, outside this, so
 * showing them again is always noticed.
 */
const HIDDEN = '.player.osd-hidden .player-top, .player.osd-hidden .player-controls';

/**
 * Call `changed` whenever the page may look different: anything added,
 * removed or altered outside the hidden parts, focus moving, an animation or
 * transition starting or ending, the window resizing. Events rather than a
 * comparison, so it costs nothing while nothing happens. Returns the
 * function that stops watching.
 */
function watchForChanges(changed: () => void): () => void {
  const seen = (node: Node) => {
    const el = node instanceof Element ? node : node.parentElement;
    return !el?.closest(HIDDEN);
  };
  const observer = new MutationObserver((records) => {
    if (records.some((r) => seen(r.target))) changed();
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const events = [
    'focusin',
    'focusout',
    'animationstart',
    'animationend',
    'animationcancel',
    'transitionrun',
    'transitionend',
    'transitioncancel',
  ];
  for (const name of events) document.addEventListener(name, changed, true);
  window.addEventListener('resize', changed);
  return () => {
    observer.disconnect();
    for (const name of events) document.removeEventListener(name, changed, true);
    window.removeEventListener('resize', changed);
  };
}

/** Start drawing the page into mpv; returns the function that stops it. */
export function startOverlay(): () => void {
  let stopped = false;
  let busy = false;
  let shown = false;
  let warned = false;
  let scaled = true;
  // Whether the page may have changed since the last photo. While nothing is
  // shown, a photo is only taken when it has.
  let dirty = true;
  const stopWatching = watchForChanges(() => {
    dirty = true;
  });
  // How many photos were taken, said when the player closes: the measure of
  // whether the pause above is working.
  let photos = 0;
  const opened = performance.now();
  // The page's size against mpv's, said whenever either changes: a page of
  // another shape is drawn stretched (a tiling desktop squeezing Kinema's
  // window — display.rs `player_window`), and app.log is where that shows.
  let lastSizes = '';
  // Whether this pump made Kinema's window full screen, to undo it.
  let madeFullscreen = false;

  const tick = async () => {
    if (busy || stopped) return;
    if (!shown && !dirty) return;
    busy = true;
    // Cleared before the photo, so a change while it is taken asks for another.
    dirty = false;
    try {
      photos += 1;
      const frame = await invoke<OverlayFrame>('overlay_frame');
      if (stopped || !frame.changed) return;
      if (frame.empty) {
        if (shown) await mpvCommand('overlay-remove', [ID]);
        shown = false;
        return;
      }
      const picture = [ID, 0, 0, frame.path, 0, 'bgra', frame.width, frame.height, frame.stride];
      const w = (await readProperty<number>('osd-width', 'int64')) || frame.width;
      const h = (await readProperty<number>('osd-height', 'int64')) || frame.height;
      // Laid out in the film's shape, and only that drawn — the same rows
      // (stride) of the same photo, fewer of them, narrower.
      const box = stageFor(frame.width, frame.height, w / h);
      const whole = Math.abs(box.width - frame.width) <= 1 && Math.abs(box.height - frame.height) <= 1;
      if (scaled) setStage(whole ? null : box);
      const sizes = `${frame.width}×${frame.height}${whole ? '' : `, drawn ${box.width}×${box.height}`} on mpv's ${w}×${h}`;
      if (sizes !== lastSizes) {
        lastSizes = sizes;
        console.log(`overlay: page ${sizes}`);
      }
      if (scaled) {
        const drawn = whole ? picture : [ID, 0, 0, frame.path, 0, 'bgra', box.width, box.height, frame.stride];
        try {
          await mpvCommand('overlay-add', [...drawn, w, h]);
          shown = true;
          drawnScale = videoToPageScale(box, { width: w, height: h }, window.devicePixelRatio || 1);
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
          setStage(null);
          console.warn('overlay: this mpv cannot scale the page; matching the window to the screen');
          const win = getCurrentWindow();
          if (!(await win.isFullscreen())) {
            await win.setFullscreen(true);
            madeFullscreen = true;
          }
          // The next photo is taken at the new size, and counts as new even
          // if the window already was full screen and nothing changed.
          await invoke('overlay_reset');
          dirty = true;
          return;
        }
      }
      await mpvCommand('overlay-add', picture);
      shown = true;
      // Drawn at its own size: one device pixel of the page per pixel of mpv's.
      drawnScale = videoToPageScale(frame, frame, window.devicePixelRatio || 1);
    } catch (e) {
      // Once: a failure here repeats ten times a second.
      if (!warned) console.warn('overlay: the page could not be drawn over the video', e);
      warned = true;
      // Tried again next tick, as if the page had changed.
      dirty = true;
    } finally {
      busy = false;
    }
  };

  const timer = window.setInterval(() => void tick(), INTERVAL_MS);
  void tick();

  return () => {
    stopped = true;
    window.clearInterval(timer);
    stopWatching();
    const secs = Math.round((performance.now() - opened) / 1000);
    console.log(`overlay: ${photos} photos in ${secs} s`);
    setStage(null);
    drawnScale = null;
    if (shown) void mpvCommand('overlay-remove', [ID]).catch(() => undefined);
    if (madeFullscreen) void getCurrentWindow().setFullscreen(false).catch(() => undefined);
    void invoke('overlay_reset').catch(() => undefined);
  };
}
