/**
 * TV mode — the 10-foot layout switch.
 *
 * One boolean drives `--ui-scale` in `ui.css` through a `data-tv` attribute on
 * the root element. Everything in that stylesheet is expressed in `rem`, so the
 * scale is a single knob rather than a parallel set of TV styles: a second
 * stylesheet would drift out of step with the first the moment either changed.
 *
 * It is a **manual** setting, not a viewport heuristic. The webview can measure
 * the panel but not how far away you are sitting, and a 4K monitor at arm's
 * length is indistinguishable from a 4K TV across the room. Guessing wrong
 * either shrinks the couch UI to nothing or makes the desk UI absurd, and there
 * is nothing to notice it by — so the app asks once and remembers.
 *
 * Like the rendering settings, this is one switch and not a slider. The choice
 * is "where am I sitting", which has two answers; a percentage control would be
 * a preset UI by another name.
 *
 * Where Kinema has no window (Android: an app is the whole screen of a TV
 * box), there is only the sofa: TV mode is always on, never asked, and cannot
 * be switched off (owner, 2026-10-04).
 */
import { useSyncExternalStore } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { capabilitiesNow, loadCapabilities } from '../capabilities';
import { getSetting, setSetting } from '../metadata/api';

export const TV_MODE_KEY = 'tv_mode';

let enabled = false;
const listeners = new Set<() => void>();

/**
 * An attribute rather than a class: `ui.css` keys its overrides off
 * `:root[data-tv='on']` and nothing else competes for it. It goes on `html`
 * because `rem` resolves against the root element and nothing else.
 */
function apply(on: boolean): void {
  document.documentElement.dataset.tv = on ? 'on' : 'off';
}

/**
 * TV mode also means the whole screen, the way a TV app has it.
 *
 * On a TV nobody wants a title bar and a taskbar round the library, and the
 * display switching in Settings → Screen only acts while the window is
 * fullscreen — so a TV-mode library in a window meant every one of those
 * switches did nothing until someone found the Fullscreen button. The player
 * leaves the window fullscreen on the way out while this is on.
 *
 * Only ever *leaves* fullscreen when TV mode is being switched off: at a desk
 * launch there is nothing to undo, and doing it anyway would pull a film the
 * user made fullscreen themselves back into a window.
 */
async function fillScreen(on: boolean): Promise<void> {
  try {
    const win = getCurrentWindow();
    if ((await win.isFullscreen()) !== on) await win.setFullscreen(on);
  } catch (e) {
    console.warn('tv mode: could not change fullscreen', e);
  }
}

/**
 * No window, so always the TV layout. Only a clear "no" counts: a system that
 * gave no answer keeps the choice, as every desktop has always had it.
 */
export function alwaysTv(): boolean {
  return capabilitiesNow()?.windowed === false;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read the persisted choice at startup. A failure here must leave the desk
 * layout in place rather than throwing: an unreadable setting is not a reason
 * to show no UI at all.
 */
export async function loadTvMode(): Promise<void> {
  // Asked alongside the setting, so a TV box never shows the desk layout first.
  const [stored] = await Promise.all([
    getSetting(TV_MODE_KEY).catch((e) => {
      console.warn('tv mode: could not read setting, staying on the desk layout', e);
      return null;
    }),
    loadCapabilities(),
  ]);
  const fixed = alwaysTv();
  enabled = fixed || stored === 'on';
  // The layout drawn for a 1080p TV, scaled to whatever the screen is (ui.css).
  document.documentElement.toggleAttribute('data-tv-only', fixed);
  apply(enabled);
  emit();
  // Nothing to fill where there is no window: the app is the screen already.
  if (enabled && !fixed) await fillScreen(true);
}

/**
 * Apply immediately, persist in the background. The layout change is the
 * feedback, so making it wait on SQLite would only add latency to a switch the
 * user is watching.
 *
 * Without a window it stays on (`alwaysTv`): a keyboard's F11 on a TV box
 * must not shrink everything to a desk's size with no desk to switch back at.
 */
export function setTvMode(on: boolean): void {
  if (alwaysTv()) return;
  const was = enabled;
  enabled = on;
  apply(on);
  emit();
  if (on !== was) void fillScreen(on);
  void setSetting(TV_MODE_KEY, on ? 'on' : 'off').catch((e) =>
    console.warn('tv mode: could not save setting', e)
  );
}

/** For code outside React that needs to know, such as the player's exit path. */
export function isTvMode(): boolean {
  return enabled;
}

export function useTvMode(): boolean {
  return useSyncExternalStore(subscribe, () => enabled);
}
