/**
 * Keys pressed on mpv's own window, handed on to Kinema.
 *
 * Where mpv has a window of its own (Linux: capabilities `own_window`), that
 * window is in front and has the keyboard — a desktop will not let Kinema's
 * window take it back (docs/GOTCHAS.md). So mpv binds each key the player and
 * the focus navigation use, tells Kinema which was pressed, and Kinema presses
 * the matching key on its page, exactly as the self-test does: every handler
 * stays as it is.
 *
 * Not through `script-message`, which would be the obvious way: the libmpv
 * wrapper reads a client message's arguments past their end and takes the
 * whole program down (docs/GOTCHAS.md). Each binding instead flips a text
 * property between two spellings of the key's number (`9a`, `9b`), which
 * Kinema observes like any other: every press is a change, the same key twice
 * included. Numbers, not names, so no key needs quoting.
 *
 * The property is `term-status-msg` — mpv's status line for a terminal, which
 * Kinema switches off (`terminal=no`), so it is never shown. `user-data`,
 * made for this, does not work: its values come back as JSON (`"9a"`, quotes
 * and all), so `cycle-values` never recognises the current one and a key
 * pressed twice is one change. A counter does not work either: mpv refuses
 * `add` on user-data.
 *
 * mpv reports presses, not releases. The one handler that wants a release —
 * the accelerating seek — already commits on its own half a second after the
 * last press.
 */

/** mpv's name for a key, and the DOM `key` Kinema's handlers already know. */
export const MPV_KEYS: ReadonlyArray<readonly [mpv: string, dom: string]> = [
  ['UP', 'ArrowUp'],
  ['DOWN', 'ArrowDown'],
  ['LEFT', 'ArrowLeft'],
  ['RIGHT', 'ArrowRight'],
  ['ENTER', 'Enter'],
  ['KP_ENTER', 'Enter'],
  ['ESC', 'Escape'],
  ['BS', 'Backspace'],
  ['GO_BACK', 'BrowserBack'],
  ['SPACE', ' '],
  ['PLAYPAUSE', 'MediaPlayPause'],
  ['PLAY', 'MediaPlay'],
  ['PAUSE', 'MediaPause'],
  ['STOP', 'MediaStop'],
  ['NEXT', 'MediaTrackNext'],
  ['PREV', 'MediaTrackPrevious'],
  ['FORWARD', 'MediaFastForward'],
  ['REWIND', 'MediaRewind'],
  // The player's letter and number keys (usePlayerKeys.ts), and the controls list.
  ...['i', 'f', 'm', 'n', 'p', '0', '9', '-', '+', '=', '?'].map((k) => [k, k] as const),
];

/** mpv's property the bindings write (see above). */
export const KEY_PROPERTY = 'term-status-msg';

/** The mpv command bound to key number `index`. */
export function keyCommand(index: number): string {
  return `cycle-values ${KEY_PROPERTY} ${index}a ${index}b`;
}

/** The DOM key for a value the bindings wrote, or null if it is not one. */
export function keyFromValue(value: unknown): string | null {
  const match = typeof value === 'string' ? /^(\d+)[ab]$/.exec(value) : null;
  return match ? (MPV_KEYS[Number(match[1])]?.[1] ?? null) : null;
}
