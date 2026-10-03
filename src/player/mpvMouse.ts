/**
 * The mouse on mpv's own window, handed on to Kinema.
 *
 * Where mpv has a window of its own (Linux: capabilities `own_window`), the
 * mouse lands on that window, not on Kinema's page behind it. A small script
 * Kinema loads into mpv (`src-tauri/src/pointer/mouse.lua`) reports every
 * press, release, move and wheel turn there; the player maps each onto the
 * page (`overlay.ts` → `pageFromVideo`) and Rust does it again on the page as
 * real mouse input (`pointer.rs`), so every handler is the Windows one.
 *
 * A script, not key bindings like the keys (mpvKeys.ts): mpv runs a binding
 * on a mouse button when the button is *released*, so a binding never hears
 * one go down, and the seek bar could not be dragged. Only a script's
 * bindings are told both.
 *
 * The script writes its last few events to one property, which Kinema
 * observes — mpv reports a property's latest value, not every value it had,
 * so a quick click's press and release must both still be in the latest.
 * Each event carries a number, and `newEvents` keeps those not yet seen.
 */

/** The property the script writes (mouse.lua). */
export const MOUSE_PROPERTY = 'user-data/kinema/mouse';

export type MouseKind = 'move' | 'down' | 'up' | 'wheel-up' | 'wheel-down' | 'leave';

const KINDS: ReadonlySet<string> = new Set<MouseKind>([
  'move',
  'down',
  'up',
  'wheel-up',
  'wheel-down',
  'leave',
]);

/** One thing the mouse did on mpv's window, at `x`, `y` in mpv's pixels. */
export interface MouseEvent {
  seq: number;
  kind: MouseKind;
  x: number;
  y: number;
  /** mpv's clock, in milliseconds. */
  time: number;
}

/**
 * The events in a value the script wrote. A `user-data` value comes back as
 * JSON — the text in quotes (mpvKeys.ts) — so both spellings are taken.
 * Anything that is not an event is skipped.
 */
export function parseMouse(value: unknown): MouseEvent[] {
  if (typeof value !== 'string') return [];
  let text = value;
  if (text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'string') return [];
      text = parsed;
    } catch {
      return [];
    }
  }
  const events: MouseEvent[] = [];
  for (const line of text.split(';')) {
    const [seq, kind, x, y, time] = line.trim().split(' ');
    const numbers = [seq, x, y, time].map(Number);
    if (!KINDS.has(kind) || numbers.some((n) => !Number.isFinite(n))) continue;
    events.push({ seq: numbers[0], kind: kind as MouseKind, x: numbers[1], y: numbers[2], time: numbers[3] });
  }
  return events;
}

/**
 * The events after `lastSeq`, in order. A value whose numbers are all lower
 * than `lastSeq` comes from a script started again (mpv's numbering begins
 * anew), and all of it is new.
 */
export function newEvents(events: MouseEvent[], lastSeq: number): MouseEvent[] {
  const latest = events[events.length - 1]?.seq ?? 0;
  if (latest < lastSeq) return events;
  return events.filter((e) => e.seq > lastSeq);
}
