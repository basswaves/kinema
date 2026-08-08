/**
 * Whether the controls overlay is showing.
 *
 * A module-level store rather than a prop, for the same reason `tv.ts` is one:
 * the overlay is rendered at the top of the tree, in `App`, and the two places
 * that need to open it — the nav bar and the player's on-screen controls — are
 * on opposite sides of the shell, with the player rendered *instead of* the
 * browsing views rather than beside them. Threading a callback to both would
 * mean a prop on every component in between, for a boolean neither of them
 * otherwise cares about.
 *
 * There is nothing to persist here. Whether you had the key list open is not a
 * fact worth surviving a restart.
 *
 * Named `shortcutsState` rather than `shortcuts` because Windows filesystems
 * are case-insensitive: `shortcuts.ts` and `Shortcuts.tsx` are the same file
 * name here, and TypeScript refuses the pair outright.
 */
import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setShortcutsOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  emit();
}

export function useShortcutsOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}
