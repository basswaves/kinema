/**
 * Where a text field's typed characters go, and when the system's own
 * keyboard comes up.
 *
 * A field the remote lands on takes typing focus, so a keyboard types into
 * it at once. On a desktop that is all. Where the system puts its own
 * keyboard on screen the moment a field takes typing (capability
 * `screen_keyboard`, Android), that keyboard came up on mere arrival: moving
 * down past a field opened it over the page, and in Search it sat on top of
 * Kinema's own letters (owner, 2026-10-04). There, a field takes typing with
 * `inputmode="none"` — a plugged-in keyboard still types, nothing appears —
 * and OK on the field opens the system's keyboard, as TV apps do.
 *
 * The remote's OK reaches the page as Shift+Enter (MainActivity.kt sends it
 * on as one; the system's keyboard never sends Shift with Enter), and on a
 * field it always opens the keyboard — never saves, searches or signs in (owner,
 * 2026-10-04). Any other Enter, the on-screen keyboard's own or a plugged-in
 * keyboard's, is the field's (`onEnter`). The page cannot tell when the
 * system's keyboard closes (on an Android 9 box neither the page's size nor
 * Chrome's VirtualKeyboard events changed), which is why OK is not "open it
 * if it is closed".
 *
 * A form whose Enter moves on to its next field (a user name, then a
 * password) hands the open keyboard over with `carryKeyboard`: the next
 * field takes typing with it still up rather than closing it.
 */
import { useEffect, type KeyboardEvent, type RefObject } from 'react';
import { useCapabilities } from '../capabilities';

/** When a field last handed the open keyboard to the next one. */
let carriedAt = 0;
/** Long enough for the next field to be drawn and reached. */
const CARRY_MS = 1500;

/** The field that takes typing next keeps the system's keyboard open. */
export function carryKeyboard(): void {
  carriedAt = Date.now();
}

/**
 * Give `ref` typing focus while `focused` (the remote's focus), and take it
 * back when the remote moves on. Returns the field's Enter handler: true when
 * the press was the remote's OK, spent opening the system's keyboard.
 */
export function useTypingFocus(
  ref: RefObject<HTMLInputElement | null>,
  focused: boolean
): (event: KeyboardEvent<HTMLInputElement>) => boolean {
  const screenKeyboard = Boolean(useCapabilities()?.screen_keyboard);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    if (focused) {
      // Before focus(): the system decides whether to show its keyboard as
      // the field takes focus. Handed on from the field before, it stays.
      const carried = Date.now() - carriedAt < CARRY_MS;
      carriedAt = 0;
      if (screenKeyboard) input.inputMode = carried ? 'text' : 'none';
      // `preventScroll`: callers scroll the field into view themselves.
      input.focus({ preventScroll: true });
    } else {
      // Give the caret back when the remote moves on, or this field keeps
      // taking keystrokes — Enter included — while the ring is somewhere else.
      if (document.activeElement === input) input.blur();
      input.inputMode = '';
    }
  }, [focused, ref, screenKeyboard]);

  return (event) => {
    const input = ref.current;
    if (!screenKeyboard || !input || !event.shiftKey) return false;
    event.preventDefault();
    input.inputMode = 'text';
    // The system shows its keyboard as a field takes focus, and a key press
    // counts as the person's own act, which it needs to allow that.
    input.blur();
    input.focus({ preventScroll: true });
    return true;
  };
}
