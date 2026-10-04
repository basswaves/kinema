/**
 * Web pages Kinema points to: a free TMDB key, a trailer, a sign-in page.
 *
 * On a desktop the system's browser opens them. A TV box may have nothing
 * that opens a web page at all — an operator's box had only what its owner
 * had installed — and then the button did nothing, silently. So when the
 * system cannot open the address, Kinema shows it instead, with a QR code to
 * open it on a phone (owner, 2026-10-04). The card is `LinkCard.tsx`, shown
 * once, at the top of the tree (App.tsx).
 */
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useSyncExternalStore } from 'react';
import { qrSource } from '../metadata/tracking';

/** An address the system could not open, and its QR code (a data URL). */
export interface ShownLink {
  url: string;
  qr: string | null;
}

let shown: ShownLink | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Open `url` in the system's browser, or show it where there is none. */
export async function openLink(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (e) {
    console.warn('link: the system could not open it, so it is shown instead', e);
    const svg = await invoke<string | null>('link_qr', { url }).catch(() => null);
    shown = { url, qr: qrSource(svg) };
    emit();
  }
}

export function closeLink(): void {
  shown = null;
  emit();
}

/** The address on show, for the one place that shows it (App.tsx). */
export function useShownLink(): ShownLink | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown
  );
}
