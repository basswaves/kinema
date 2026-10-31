/**
 * A trailer with no file beside the film: where its YouTube video plays.
 *
 * The order is the owner's (2026-10-18). A local file comes first and never
 * reaches here (TitleDetail.tsx plays it through mpv). Then: where the system
 * opens videos in an app of its own (Android), the YouTube app gets the id;
 * where the page is served over http(s) (Windows' `http://tauri.localhost`),
 * YouTube's embedded player plays it in Kinema's overlay (TrailerOverlay.tsx);
 * anywhere else, and whenever YouTube refuses, the browser gets the page, as
 * before. Linux serves the page from a scheme of its own (`tauri://`), which
 * YouTube's embed does not take as an address it may play for ("Error 153",
 * no Referer), so Linux keeps the browser.
 *
 * The overlay talks to YouTube's player the way YouTube's IFrame API does, by
 * messages to its frame, without loading YouTube's script into Kinema's own
 * page: nothing of YouTube's runs where it could reach the library. Ads are
 * YouTube's to show; nothing here blocks them (notes on this in CONTRIBUTING).
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { useSyncExternalStore } from 'react';
import { capabilitiesNow } from '../capabilities';
import { openLink } from './links';

/** The embed's own host: the privacy-enhanced one, no cookies before playing. */
export const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/** A trailer on screen in the overlay. */
export interface ShownTrailer {
  key: string;
  title: string;
}

let shown: ShownTrailer | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const watchUrl = (key: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(key)}`;

/** The embed's address: the API switched on, told which page it plays for. */
export function embedUrl(key: string, origin: string): string {
  const query = new URLSearchParams({
    enablejsapi: '1',
    autoplay: '1',
    playsinline: '1',
    rel: '0',
    origin,
    widget_referrer: origin,
  });
  return `${EMBED_ORIGIN}/embed/${encodeURIComponent(key)}?${query.toString()}`;
}

/** Whether YouTube's embed can play for this page: an http(s) address. */
export function pageCanEmbed(protocol: string = window.location.protocol): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

/** Play the YouTube trailer `key` for `title`, wherever this system plays one. */
export async function playTrailer(key: string, title: string): Promise<void> {
  if (capabilitiesNow()?.video_apps) {
    try {
      await openUrl(`vnd.youtube:${key}`);
      return;
    } catch (e) {
      console.warn('trailer: no app took the YouTube id, so the browser gets it', e);
    }
  } else if (pageCanEmbed()) {
    shown = { key, title };
    emit();
    return;
  }
  await openLink(watchUrl(key));
}

/** Put the overlay away; with `why`, the trailer goes to the browser instead. */
export function closeTrailer(why?: string): void {
  const was = shown;
  shown = null;
  emit();
  if (was && why) {
    console.warn(`trailer: ${why}, so it opens in the browser`);
    void openLink(watchUrl(was.key));
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useShownTrailer(): ShownTrailer | null {
  return useSyncExternalStore(subscribe, () => shown);
}

/**
 * YouTube's error numbers (its IFrame API): every one sends the trailer to the
 * browser, where YouTube says itself what is wrong.
 */
const ERRORS: Record<number, string> = {
  2: 'YouTube refused the video id',
  5: 'YouTube could not play it in this window',
  100: 'YouTube has no such video, or it is private',
  101: 'its owner does not allow it to play outside YouTube',
  150: 'its owner does not allow it to play outside YouTube',
  153: 'YouTube did not accept the page it was asked to play for',
};

export function errorText(code: unknown): string {
  return ERRORS[Number(code)] ?? `YouTube reported error ${String(code)}`;
}

/** What one message from YouTube's frame says, or null for anything else. */
export interface PlayerNews {
  event: string;
  info?: unknown;
}

export function readNews(data: unknown): PlayerNews | null {
  let parsed: unknown = data;
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const event = (parsed as { event?: unknown }).event;
  return typeof event === 'string' ? { event, info: (parsed as { info?: unknown }).info } : null;
}
