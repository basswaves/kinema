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
 */
import { useSyncExternalStore } from 'react';
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
  try {
    enabled = (await getSetting(TV_MODE_KEY)) === 'on';
  } catch (e) {
    console.warn('tv mode: could not read setting, staying on the desk layout', e);
    enabled = false;
  }
  apply(enabled);
  emit();
}

/**
 * Apply immediately, persist in the background. The layout change is the
 * feedback, so making it wait on SQLite would only add latency to a switch the
 * user is watching.
 */
export function setTvMode(on: boolean): void {
  enabled = on;
  apply(on);
  emit();
  void setSetting(TV_MODE_KEY, on ? 'on' : 'off').catch((e) =>
    console.warn('tv mode: could not save setting', e)
  );
}

export function useTvMode(): boolean {
  return useSyncExternalStore(subscribe, () => enabled);
}
