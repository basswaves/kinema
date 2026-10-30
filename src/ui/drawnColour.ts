/**
 * The colour of a drawn poster (DrawnPoster.tsx): from the title and year, so
 * the same film is the same colour on every screen and every launch.
 */
import type { CSSProperties } from 'react';

/**
 * Deep, quiet colours, each dark enough for white lettering to pass WCAG AA
 * (4.5:1) — `DrawnPoster.test.ts` checks every one.
 */
export const DRAWN_COLOURS = [
  '#7a2b2b', // brick
  '#2b4a7a', // night blue
  '#2a5a4c', // pine
  '#563a7a', // plum
  '#6e4f16', // bronze
  '#2f5468', // slate
  '#6e2f55', // berry
  '#45503a', // olive
] as const;

/** FNV-1a over the name and year, then mixed: stable and cheap. */
export function drawnColour(title: string, year?: number | null): string {
  let hash = 0x811c9dc5;
  for (const ch of `${title.trim().toLowerCase()}|${year ?? ''}`) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  // FNV's low bits barely mix, and a palette of eight reads only those.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b);
  hash ^= hash >>> 16;
  return DRAWN_COLOURS[(hash >>> 0) % DRAWN_COLOURS.length];
}

/** The colour as a style, for a backdrop that has only the colour to show. */
export function drawnStyle(title: string, year?: number | null): CSSProperties {
  return { '--drawn': drawnColour(title, year) } as CSSProperties;
}
