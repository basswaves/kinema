/**
 * Focus recovery for the browsing views.
 *
 * Every view here replaces the last one entirely — opening a detail page
 * unmounts every card on Home, and going back unmounts every episode row. The
 * spatial system keeps pointing at whatever was focused, so after each of those
 * transitions the current focus key names a component that no longer exists.
 *
 * With a mouse this is invisible: hovering re-establishes focus. With a remote
 * there is no such recovery, and focus parked on a dead key is indistinguishable
 * from a frozen app — no rings anywhere, and no arrow press does anything. Every
 * top-level view therefore claims focus when it arrives, if nothing live holds
 * it.
 */
import { useEffect } from 'react';
import {
  doesFocusableExist,
  getCurrentFocusKey,
  setFocus,
  SpatialNavigation,
  ROOT_FOCUS_KEY,
} from '@noriginmedia/norigin-spatial-navigation';

/**
 * Whether nothing live holds focus, judged the way a viewer would: is a focus
 * ring showing anywhere?
 *
 * The key test alone is not enough, twice over. A plain "is it root" check
 * misses focus still pointing confidently at an unmounted card — hence
 * `doesFocusableExist`. And that misses the opposite case: a view that comes
 * back re-registers its controls under the *same* stable keys (`hero-play`),
 * so the dead key the spatial system was left holding suddenly "exists" again —
 * but the new component was never told it is focused, so no ring is drawn and
 * the view skips its claim. Coming back from the player landed exactly there.
 *
 * Every leaf focusable here (`FocusButton`, `FocusInput`, cards, episode rows)
 * renders a `focused` class when it holds focus, so "no element has it" is the
 * honest test that the remote has nothing on screen to act from.
 */
function focusIsDead(): boolean {
  const current = getCurrentFocusKey();
  if (current === ROOT_FOCUS_KEY || !doesFocusableExist(current)) return true;
  return document.querySelector('.focused') === null;
}

/**
 * Where focus should go for each claiming view that is mounted, newest last —
 * what the watchdog below falls back to.
 */
const landingSpots: string[] = [];

/**
 * How long after a claim to look again.
 *
 * The spatial library restores focus by itself when a focused component
 * unmounts, but it does so **300 ms later** (`AUTO_RESTORE_FOCUS_DELAY`), and
 * it restores to the component's *parent* — which, when a whole view is
 * replaced, has unmounted too. Its `setFocus` is also asynchronous, so a claim
 * started by a view that is about to disappear can finish after the next
 * view's claim. Either way the last word can go to a key that no longer
 * exists. At launch that is exactly what happened: the first-run panel shows
 * for the moment before titles arrive, claims focus, and is replaced by Home —
 * whose claim was then overwritten, leaving a remote's presses going nowhere.
 * Looking again once that window has passed catches it.
 */
const SECOND_LOOK_MS = 450;

/**
 * Claim focus for `focusKey` once `ready`, unless something live already holds
 * it — and look again after the library's own delayed restore has had its
 * turn, since that can land on a dead key after this claim succeeded.
 *
 * Pointing this at a *container* is usually right — the spatial system then
 * descends to its last focused child, or its `preferredChildFocusKey`, which
 * keeps the choice of landing spot next to the markup that knows about it.
 */
export function useClaimFocus(focusKey: string, ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    landingSpots.push(focusKey);
    if (focusIsDead()) void setFocus(focusKey);

    const second = window.setTimeout(() => {
      if (focusIsDead() && doesFocusableExist(focusKey)) void setFocus(focusKey);
    }, SECOND_LOOK_MS);

    return () => {
      window.clearTimeout(second);
      const index = landingSpots.lastIndexOf(focusKey);
      if (index >= 0) landingSpots.splice(index, 1);
    };
  }, [focusKey, ready]);
}

/**
 * Put focus back on the current view's landing spot if the control holding it
 * has just gone away — after the library's own restore window, so it gets the
 * first chance.
 *
 * For actions that remove the very control they were pressed on: Remove in
 * Continue Watching takes its whole card with it, and the ring would otherwise
 * be nowhere until the next key press woke the watchdog.
 */
export function recoverFocusSoon(): void {
  window.setTimeout(() => {
    if (!focusIsDead()) return;
    const spot = [...landingSpots].reverse().find((key) => doesFocusableExist(key));
    if (spot) void setFocus(spot);
  }, SECOND_LOOK_MS);
}

const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']);

let watchdogInstalled = false;

/**
 * The last line of defence against focus parked on nothing.
 *
 * Every entry about dead focus in GOTCHAS is a way for this state to arise,
 * and each was fixed where it was found. This catches the ones not found yet:
 * a navigation key pressed while no live component holds focus is spent on
 * putting focus on the current view's landing spot, instead of vanishing. The
 * first press after a glitch then shows a focus ring where the remote expects
 * one, which is what a TV app does, rather than doing nothing forever.
 *
 * Registered in the **capture** phase on `window`, which runs before the
 * spatial library's own listener there, so a press it spends on recovery is
 * not also acted on. It stands aside whenever the library is paused — the
 * player owns the arrows then.
 */
export function installFocusWatchdog(): void {
  if (watchdogInstalled) return;
  watchdogInstalled = true;

  window.addEventListener(
    'keydown',
    (event) => {
      if (!NAVIGATION_KEYS.has(event.key)) return;
      if ((SpatialNavigation as unknown as { paused?: boolean }).paused) return;
      if (!focusIsDead()) return;

      const spot = [...landingSpots].reverse().find((key) => doesFocusableExist(key));
      if (!spot) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      console.warn(`focus: recovered from a dead focus key onto ${spot}`);
      void setFocus(spot);
    },
    true
  );
}

/**
 * The scrolling ancestor a node actually lives in — `.browse` in practice,
 * found by looking rather than by hard-coding the selector, so this keeps
 * working if the shell moves.
 */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'auto' || overflowY === 'scroll') return el;
  }
  return null;
}

/**
 * Bring the page back to the top when focus lands on a control in the top row.
 *
 * `scrollIntoView({ block: 'nearest' })` is the right behaviour everywhere else,
 * but it is a no-op once the element is on screen — so arrowing back up from
 * the rails would leave the page where the rails had scrolled it, with the hero
 * cropped and the nav floating over half an image. The top row is the one place
 * where the correct scroll position is absolute rather than relative.
 */
export function scrollPageToTop(node: HTMLElement | null): void {
  scrollParent(node)?.scrollTo({ top: 0, behavior: 'smooth' });
}
