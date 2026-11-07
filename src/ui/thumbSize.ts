/**
 * Which small copy of a picture a grid asks for (`thumbs.rs`, which knows the
 * same widths): the card's width on this screen, scaled for a card that grows
 * when focused, and the next size up, so 4K and high-DPI screens stay sharp.
 */
const WIDTHS = [240, 360, 480, 720, 960, 1280];

/** How much a card grows with the ring on it (`.card.focused`, `ui.css`). */
const FOCUS_GROWTH = 1.07;

/** The width to ask for, or null when even the largest is too small. */
export function thumbSize(rem: number, remPx: number, dpr: number): number | null {
  const needs = rem * remPx * dpr * FOCUS_GROWTH;
  return WIDTHS.find((width) => width >= needs) ?? null;
}

/** The root's font size in pixels: it is what TV mode scales the interface by. */
export function remPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** A picture's file name, from its path in either system's spelling. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? '';
}
