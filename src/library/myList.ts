/**
 * My list (my_list.rs): titles kept handy, to watch or loved — one list, not
 * separate favourites and a watchlist (owner, 2026-10-24).
 *
 * One store for the whole interface, because the same title shows its mark
 * on a card in several rails, on its page and on Home's rail at once, and a
 * press in one place has to show in all of them. Read once, then changed
 * here first and written behind: the mark appears on the press, not when the
 * database has answered. A write that fails reads the list back, so the
 * screen never claims what was not kept.
 *
 * Local only: nothing here goes to SIMKL or Trakt.
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useSyncExternalStore } from 'react';

interface ListEntry {
  title_id: number;
  added_at: number;
}

/** Newest first. */
let ids: number[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: number[]) {
  ids = next;
  for (const listener of listeners) listener();
}

/** Read the list from the library (again). */
export function reloadMyList(): Promise<void> {
  loading = invoke<ListEntry[]>('my_list')
    .then((entries) => {
      loaded = true;
      publish(entries.map((e) => e.title_id));
    })
    .catch((e: unknown) => console.warn('my list: could not be read', e))
    .finally(() => {
      loading = null;
    });
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => ids;

/** The ids on My list, newest first; read on first use. */
export function useMyList(): number[] {
  useEffect(() => {
    if (!loaded && !loading) void reloadMyList();
  }, []);
  return useSyncExternalStore(subscribe, snapshot);
}

/** Whether one title is on My list. */
export function useOnMyList(titleId: number): boolean {
  const list = useMyList();
  return list.includes(titleId);
}

export function isOnMyList(titleId: number): boolean {
  return ids.includes(titleId);
}

/** Put a title on My list or take it off; `on` defaults to the other way. */
export function toggleMyList(titleId: number, on = !isOnMyList(titleId)): Promise<void> {
  publish(on ? [titleId, ...ids.filter((id) => id !== titleId)] : ids.filter((id) => id !== titleId));
  return invoke<void>('set_in_my_list', { titleId, on }).catch((e: unknown) => {
    console.warn('my list: could not be kept', e);
    return reloadMyList();
  });
}

/** The key that puts the focused card or the open page's title on My list. */
export const MY_LIST_KEY = 'l';

/** Whether a key press is the My list key, and not typing. */
export function isMyListKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.key.toLowerCase() !== MY_LIST_KEY) return false;
  const target = e.target as HTMLElement | null;
  return !(target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable);
}
