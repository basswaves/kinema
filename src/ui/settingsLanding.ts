/**
 * Landing on a setting Settings' search chose (SettingsSearch.tsx), found by
 * what the open section shows rather than by a key of its own, so a setting
 * needs nothing added to be found.
 */
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect } from 'react';
import { focusKeyOf } from './focus';
import type { SettingEntry } from './settingsIndex';

/** How long a section that asks something first (an account's state) is waited for. */
const LAND_WAIT_MS = 2500;
const LAND_POLL_MS = 100;

/** Lower case and single spaces, for comparing what the screen shows. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** What an element says, a logo's name included (Trakt's heading is its logo). */
function textOf(el: Element): string {
  const alts = [...el.querySelectorAll('img[alt]')].map((img) => img.getAttribute('alt'));
  return squash([el.textContent ?? '', ...alts].join(' '));
}

const CONTROL = 'button:not(:disabled), input';

/**
 * The control to land on for `text` in `root`: a row's chosen choice, a
 * field's box, the button itself, or the first control after a heading.
 */
export function controlFor(root: Element, text: string): Element | null {
  const want = squash(text);
  const named = [
    ...root.querySelectorAll('h2, h3, .choice-label, .settings-field > span, button'),
  ];
  const label =
    named.find((el) => textOf(el) === want) ?? named.find((el) => textOf(el).startsWith(want));
  if (!label) return null;
  if (label.matches(CONTROL)) return label;
  const row = label.closest('.choice-row');
  if (row) return row.querySelector('.choice.chosen:not(:disabled)') ?? row.querySelector(CONTROL);
  const field = label.closest('.settings-field');
  if (field?.querySelector('input')) return field.querySelector('input');
  // The first control after it on the page.
  return (
    [...root.querySelectorAll(CONTROL)].find(
      (el) => label.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
    ) ?? null
  );
}

/**
 * Once `target` is chosen and its section drawn, put the ring on it. A
 * section that asks something first draws its controls late, so it is looked
 * for a while; if it never comes, the section itself gets the ring. A press
 * or a click meanwhile ends the wait: the ring is the person's again.
 */
export function useLandOn(target: { entry: SettingEntry } | null, onLanded: () => void): void {
  useEffect(() => {
    if (!target) return;
    const started = Date.now();
    const text = target.entry.find ?? target.entry.label;
    const stop = () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', stop, true);
      window.removeEventListener('pointerdown', stop, true);
      onLanded();
    };
    window.addEventListener('keydown', stop, true);
    window.addEventListener('pointerdown', stop, true);
    const timer = window.setInterval(() => {
      const root = document.querySelector('.settings-content');
      const control = root && controlFor(root, text);
      const key = control && focusKeyOf(control);
      if (key) void setFocus(key);
      else if (Date.now() - started < LAND_WAIT_MS) return;
      else void setFocus('settings-content');
      stop();
    }, LAND_POLL_MS);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', stop, true);
      window.removeEventListener('pointerdown', stop, true);
    };
  }, [target, onLanded]);
}
