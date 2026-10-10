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
 *
 * Where the field sits while it is typed into is one rule for every field
 * (focus.ts, `placeForTyping`): in the upper part of the visible area, so a
 * keyboard on screen cannot cover it (TV-FEEL.md, N10). It is applied when
 * OK opens the system's keyboard — on the Android 9 box the page is never
 * told the keyboard is there, so this is the only moment it can be — and
 * again whenever the visible area shrinks while the field has the caret,
 * which is how a system that does report its keyboard says so.
 */
import { useEffect, type KeyboardEvent, type RefObject } from 'react';
import { useCapabilities } from '../capabilities';
import { placeForTyping, releaseTypingRoom } from './focus';

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
      // A keyboard handed on is already up.
      if (screenKeyboard && carried) placeForTyping(input);
    } else {
      // Give the caret back when the remote moves on, or this field keeps
      // taking keystrokes — Enter included — while the ring is somewhere else.
      if (document.activeElement === input) input.blur();
      input.inputMode = '';
      releaseTypingRoom(input);
    }
  }, [focused, ref, screenKeyboard]);

  // The visible area shrinking while this field has the caret: a keyboard
  // came up over the page.
  useEffect(() => {
    const input = ref.current;
    if (!focused || !input) return;
    const visual = window.visualViewport;
    const height = () => visual?.height ?? window.innerHeight;
    let last = height();
    const check = () => {
      const now = height();
      if (now < last - 1 && document.activeElement === input) placeForTyping(input);
      last = now;
    };
    visual?.addEventListener('resize', check);
    window.addEventListener('resize', check);
    return () => {
      visual?.removeEventListener('resize', check);
      window.removeEventListener('resize', check);
      releaseTypingRoom(input);
    };
  }, [focused, ref]);

  return (event) => {
    const input = ref.current;
    if (!screenKeyboard || !input || !event.shiftKey) return false;
    event.preventDefault();
    input.inputMode = 'text';
    // The system shows its keyboard as a field takes focus, and a key press
    // counts as the person's own act, which it needs to allow that.
    input.blur();
    input.focus({ preventScroll: true });
    placeForTyping(input);
    return true;
  };
}
