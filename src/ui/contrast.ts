/**
 * High contrast (PLAN phase 2, Accessibility): for eyes that need it, every
 * quiet line of text at full strength, the player's panels on solid black
 * rather than see-through, and a thicker ring on what is highlighted. A need
 * of the person watching, not a look: nothing moves or changes size.
 *
 * `ui.css` keys off `:root[data-contrast='high']` and nothing else.
 */
import { getSetting, setSetting } from '../metadata/api';

export const CONTRAST_KEY = 'high_contrast';

function apply(on: boolean): void {
  if (on) document.documentElement.dataset.contrast = 'high';
  else delete document.documentElement.dataset.contrast;
}

export async function loadContrast(): Promise<boolean> {
  const on = (await getSetting(CONTRAST_KEY).catch(() => null)) === 'on';
  apply(on);
  return on;
}

/** Apply at once, persist in the background. */
export function setContrast(on: boolean): void {
  apply(on);
  void setSetting(CONTRAST_KEY, on ? 'on' : 'off').catch((e) =>
    console.warn('contrast: could not save setting', e)
  );
}

export const highContrast = () => document.documentElement.dataset.contrast === 'high';
