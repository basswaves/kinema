/**
 * The menu on cards (AFTER-0.10.0.md "Later", owner 2026-10-18): what a card
 * can do without opening its page — play, mark watched, My list, a playlist,
 * the page, the file's folder.
 *
 * Mouse and remote are equal, so it opens four ways: right-click, the "⋯" a
 * pointer finds on a card, the keyboard's Menu key (or Shift+F10), and OK
 * held on a remote. One menu for the whole interface (CardMenu.tsx, drawn by
 * Browse), opened from any card through this store.
 */
import { useSyncExternalStore } from 'react';
import type { Title } from './api';

export interface CardMenuRequest {
  title: Title;
  /** The card's focus key, for the ring to go back to. */
  returnTo: string | null;
  /** Opened by OK held: the same OK is still down and must not choose. */
  held: boolean;
}

let request: CardMenuRequest | null = null;
const listeners = new Set<() => void>();

function publish(next: CardMenuRequest | null) {
  request = next;
  for (const listener of listeners) listener();
}

export function openCardMenu(title: Title, returnTo: string | null, held = false) {
  publish({ title, returnTo, held });
}

export function closeCardMenu() {
  publish(null);
}

export function useCardMenu(): CardMenuRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => request
  );
}

/** OK held this long is the menu, not the title's page. */
export const HOLD_MS = 500;
/**
 * A remote that sends no key release and no repeats while held cannot hold:
 * its press is a press, decided this long after it went down.
 */
export const NO_RELEASE_MS = 1500;

/** The keyboard's menu keys: the Menu key, and Shift+F10 where there is none. */
export function isMenuKey(e: KeyboardEvent): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}
