/**
 * The few helpers around the focus engine (focusStore.ts) that pages use by
 * name: put the ring on a control, ask where it is, come back to it after
 * Back, find a drawn control's key, and the room a text box needs while it
 * is typed into.
 *
 * Before round 7 this file was mostly timers: the spatial library it worked
 * around kept a focus of its own, updated it later (300 ms after an unmount)
 * and was corrected from here — a second look 450 ms after every claim, a
 * watchdog for a ring left on nothing, a poll for two seconds for a control
 * to come back to (docs/HISTORY.md, round 7). The engine answers each press
 * in the same event, so none of that is left.
 */
import { navExpectReturn, navFocus, navFocused } from './focusStore';
import { barBottom, pageOf, stopGlide } from './focusScroll';

/** The control holding the ring, or null. */
export function currentFocusKey(): string | null {
  return navFocused();
}

/** Put the ring on `focusKey` (an area: by its rules). */
export function focusTo(focusKey: string): void {
  navFocus(focusKey);
}

/**
 * Back is returning to `focusKey`, with the page at `scrollTop`: the screen
 * coming back takes it as soon as the control is drawn, else its landing.
 */
export function returnFocusTo(focusKey: string | null, scrollTop?: number): void {
  navExpectReturn(focusKey, scrollTop);
}

/** The focus key a drawn control was registered under, for landing on it by what it shows. */
export function focusKeyOf(node: Element): string | null {
  return node.getAttribute('data-nav-key');
}

/**
 * A text box being typed into sits in the upper part of what is visible:
 * below the top bar, its bottom no lower than this share of the visible
 * height. An on-screen keyboard takes the lower part — Android's half the
 * screen or more, Windows' touch keyboard about as much.
 */
const TYPING_ZONE = 0.45;
/** Where a box that had to move is put, as a share below the top bar. */
const TYPING_SPOT = 0.08;

/** Pages given extra room at the bottom so a box near the end can rise. */
const typingRoom = new WeakMap<HTMLElement, string>();

/** The page a text box scrolls in: the nearest ancestor that scrolls, or could. */
function scrollParent(node: HTMLElement): HTMLElement | null {
  const page = pageOf(node);
  if (page) return page;
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'auto' || overflowY === 'scroll') return el;
  }
  return null;
}

/**
 * Put a text box being typed into where a keyboard on screen cannot cover it
 * (TV-FEEL.md, N10): in the upper part of the visible area, measured from
 * `visualViewport`, which shrinks when a system keyboard opens on systems
 * that report it. A box too near the end of the page to rise that far gets
 * room added under the page until `releaseTypingRoom`.
 *
 * Called by typing.ts when the keyboard is opened on purpose and whenever the
 * visible area shrinks; never on mere arrival, so arrowing past a field moves
 * the page no more than any other control.
 */
export function placeForTyping(node: HTMLElement | null): void {
  if (!node?.isConnected) return;
  const page = scrollParent(node);
  if (!page) return;
  const visual = window.visualViewport;
  const visibleTop = visual?.offsetTop ?? 0;
  const visibleHeight = visual?.height ?? window.innerHeight;
  // A glide the ring caused would pull the page on from under this move.
  stopGlide(page);
  const view = page.getBoundingClientRect();
  // The bars over the page, read from it (focusScroll.ts), not a constant.
  const clear = Math.max(view.top, visibleTop) + barBottom(page);
  const box = node.getBoundingClientRect();
  if (box.top >= clear && box.bottom <= visibleTop + visibleHeight * TYPING_ZONE) return;

  const by = box.top - (clear + visibleHeight * TYPING_SPOT);
  const room = page.scrollHeight - page.clientHeight - page.scrollTop;
  if (by > room) {
    if (!typingRoom.has(page)) typingRoom.set(page, page.style.paddingBottom);
    const current = parseFloat(getComputedStyle(page).paddingBottom) || 0;
    page.style.paddingBottom = `${current + by - room}px`;
  }
  // At once: the keyboard is already coming up, and a smooth scroll behind
  // it leaves the box covered for its whole length.
  page.scrollBy({ top: by, behavior: 'auto' });
}

/** Take back the room `placeForTyping` added under the page, if any. */
export function releaseTypingRoom(node: HTMLElement | null): void {
  const page = node && scrollParent(node);
  if (!page || !typingRoom.has(page)) return;
  page.style.paddingBottom = typingRoom.get(page) ?? '';
  typingRoom.delete(page);
}

/**
 * Tells the stylesheet how wide a control is, in rem, as `--w`.
 *
 * A highlighted button grows by a share of its size, which is a few pixels on
 * an ordinary button and nearly thirty either side on one as wide as a version
 * name — wider than the gap, so it ran into its neighbours. The CSS caps the
 * growth at a fixed amount with `min(share, 1 + fixed / var(--w))`; it cannot
 * read an element's own width, so this hands it over. Read when the highlight
 * arrives (focus or pointer), before the transform applies; without it the CSS
 * falls back to the plain share.
 */
export function noteWidth(node: HTMLElement | null): void {
  if (!node) return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  node.style.setProperty('--w', String(node.offsetWidth / rem));
}
