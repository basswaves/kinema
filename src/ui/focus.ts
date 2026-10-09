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
import { useEffect, useState } from 'react';
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
 * A control to put focus back on, once it exists — set when Back returns to a
 * view, naming whatever was focused there when it was left.
 *
 * The returning view has to mount and usually load before that control exists
 * (Home's rails, a detail page's episodes), so this waits for it rather than
 * trying once. While it waits, views do not make their own landing claim: a
 * claim that won would scroll Home to the hero and then back down to the card,
 * which reads as the page jumping.
 */
let pendingReturn: string | null = null;
let returnTimer = 0;

/** How long to wait for the control before settling for the landing spot. */
const RETURN_WAIT_MS = 2000;
const RETURN_POLL_MS = 50;

export function hasPendingReturn(): boolean {
  return pendingReturn !== null;
}

export function returnFocusTo(focusKey: string | null): void {
  window.clearInterval(returnTimer);
  pendingReturn = focusKey;
  if (!focusKey) return;

  const started = Date.now();
  returnTimer = window.setInterval(() => {
    if (doesFocusableExist(focusKey)) {
      window.clearInterval(returnTimer);
      pendingReturn = null;
      void setFocus(focusKey);
    } else if (Date.now() - started > RETURN_WAIT_MS) {
      // Gone for good — the card was removed, the episode is no longer in the
      // list. Fall back to the view's own landing spot.
      window.clearInterval(returnTimer);
      pendingReturn = null;
      if (!focusIsDead()) return;
      const spot = [...landingSpots].reverse().find((key) => doesFocusableExist(key));
      if (spot) void setFocus(spot);
    }
  }, RETURN_POLL_MS);
}

/**
 * Presses, clicks and pointer moves so far — so a view can tell whether the
 * person has done anything since it arrived.
 */
let inputs = 0;
let inputCounting = false;

function countInputs(): void {
  if (inputCounting) return;
  inputCounting = true;
  const count = () => {
    inputs++;
  };
  for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel']) {
    window.addEventListener(type, count, { capture: true, passive: true });
  }
}

/** Whether the ring is on `focusKey` or something inside it. */
function focusWithin(focusKey: string): boolean {
  const components = (
    SpatialNavigation as unknown as { focusableComponents?: Record<string, { node?: HTMLElement }> }
  ).focusableComponents;
  const node = components?.[focusKey]?.node;
  const ring = document.querySelector('.focused');
  return Boolean(node && ring && node.contains(ring));
}

/**
 * Claim focus for `focusKey` once `ready`, unless something live already holds
 * it — and look again after the library's own delayed restore has had its
 * turn, since that can land on a dead key after this claim succeeded.
 *
 * Stands aside while Back is waiting to put focus back somewhere specific.
 *
 * Pointing this at a *container* is usually right — the spatial system then
 * descends to its last focused child, or its `preferredChildFocusKey`, which
 * keeps the choice of landing spot next to the markup that knows about it.
 *
 * `page`: this view replaces the whole screen, and takes focus when it is
 * ready even from a live control, as long as the person has not pressed,
 * clicked or moved anything since it arrived. A page that waits for its data
 * otherwise lost its landing: the button that opened it is gone, the spatial
 * library restores focus by itself 300 ms later to whatever it can find —
 * the top bar — and "something live holds it" then kept the page off its own
 * Play (a series on a slow box, 2026-10-09). Not for parts of a page: one
 * whose data arrives while the person is browsing the list beside it would
 * pull the ring out of their hands.
 */
export function useClaimFocus(focusKey: string, ready: boolean, page = false): void {
  // The count when the view arrived, before it was ready.
  const [arrivedAt] = useState(() => {
    countInputs();
    return inputs;
  });

  useEffect(() => {
    if (!ready) return;
    landingSpots.push(focusKey);
    const shouldClaim = () =>
      !pendingReturn &&
      (focusIsDead() || (page && inputs === arrivedAt && !focusWithin(focusKey)));
    if (shouldClaim()) void setFocus(focusKey);

    const second = window.setTimeout(() => {
      if (shouldClaim() && doesFocusableExist(focusKey)) void setFocus(focusKey);
    }, SECOND_LOOK_MS);

    return () => {
      window.clearTimeout(second);
      const index = landingSpots.lastIndexOf(focusKey);
      if (index >= 0) landingSpots.splice(index, 1);
    };
  }, [focusKey, ready, page, arrivedAt]);
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
export function scrollPageToTop(
  node: HTMLElement | null,
  behavior: ScrollBehavior = 'smooth'
): void {
  scrollParent(node)?.scrollTo({ top: 0, behavior });
}

/**
 * The ancestor that scrolls the page up and down. A rail's track counts as
 * scrollable to `scrollParent` (overflow on one axis makes the other `auto`),
 * but it never has anything to scroll vertically, so it is passed over here.
 */
function pageScroller(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1)
      return el;
  }
  return null;
}

/**
 * Room left for the sticky top bar, in rem, when deciding what still fits —
 * the same 4.5rem as the `scroll-margin` on `.browse *` in ui.css, plus TV
 * mode's overscan inset.
 */
const TOP_BAR_REM = 4.5;
const TV_SAFE_TOP_REM = 1.25;

/** The room the top bar takes, in pixels, at the current scale and layout. */
function topBarPx(): number {
  const root = document.documentElement;
  const rem = parseFloat(getComputedStyle(root).fontSize);
  return (TOP_BAR_REM + (root.dataset.tv === 'on' ? TV_SAFE_TOP_REM : 0)) * rem;
}

/**
 * Keep a control the remote just moved to on screen.
 *
 * `scrollIntoView({ block: 'nearest' })` stops as soon as the control itself
 * is visible, so whatever sits under the last control on a page — a card's
 * title and year, the notes under the last setting — stayed below the edge,
 * and nothing a remote could press would ever scroll to it. So when
 * everything below the control fits on screen together with it, the page goes
 * all the way to the bottom instead.
 */
export function keepOnScreen(node: HTMLElement | null, inline: 'center' | 'nearest' = 'center'): void {
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline });
  const page = pageScroller(node);
  if (!page) return;
  const box = node.getBoundingClientRect();
  const view = page.getBoundingClientRect();
  // Measured from the content's top, so a scroll already under way does not
  // change the answer.
  const bottom = page.scrollTop + box.bottom - view.top;
  const below = page.scrollHeight - bottom;
  if (below > 0 && below + box.height + topBarPx() < page.clientHeight) {
    page.scrollTo({ top: page.scrollHeight, behavior: 'smooth' });
  }
}

/** How far one press reads on, as a share of the visible page. */
const READ_STEP = 0.6;

/**
 * Down with nothing further down reads on; Up reads back.
 *
 * Some pages end in text below their last control — the notes under the last
 * setting, a long description — and `keepOnScreen` can only bring that into
 * view when it fits on one screen together with the control. Longer than
 * that, a remote had no way to reach it (owner, 2026-10-04: "you can't see
 * everything"). So a Down press that the spatial library could not spend on a
 * move scrolls the page on by most of a screen, as a TV app does with text;
 * and while the control reading on left behind is above the top of the
 * screen, Up scrolls back before it moves anywhere.
 *
 * The focused control is never left half under the top bar, which is see-
 * through, so the ring showed through it (owner, 2026-10-05: keep it clear,
 * moving the page only when needed). Reading on stops where the control is
 * still clear of the bar, or takes it off the screen entirely when it is
 * already near the top; reading back ends with it clear, not part-way.
 *
 * Capture phase on `window`, like the watchdog: Up has to be answered before
 * the spatial library moves; Down is only judged once it has had its turn.
 */
let readOnInstalled = false;
/** The control reading on scrolled away from, until focus moves. */
let leftBehind: HTMLElement | null = null;

export function installReadOn(): void {
  if (readOnInstalled) return;
  readOnInstalled = true;

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if ((SpatialNavigation as unknown as { paused?: boolean }).paused) return;
      const node = document.querySelector<HTMLElement>('.focused');
      const page = node && pageScroller(node);
      if (!node || !page) return;
      const step = page.clientHeight * READ_STEP;
      const pageTop = page.getBoundingClientRect().top;
      const clear = pageTop + topBarPx();
      if (leftBehind !== node) leftBehind = null;

      if (event.key === 'ArrowUp') {
        const box = node.getBoundingClientRect();
        // Left above the bar by reading on, wholly or partly. Only then: a
        // control the remote has just moved to is above it too until the page
        // has scrolled to it, and on a slow computer a quick second Up was
        // spent scrolling instead of moving on (the first run's setup pages,
        // on CI).
        const hidden = node === leftBehind && box.top < clear - 1;
        if (hidden && page.scrollTop > 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
          page.scrollBy({ top: -Math.min(step, clear - box.top), behavior: 'smooth' });
        }
        return;
      }

      // Held down, the spatial library skips presses (it throttles them), and
      // a skipped press would look like the end of the page.
      if (event.repeat) return;
      // After the spatial library's own listener: the same control still
      // focused means there was nothing below it to move to.
      window.setTimeout(() => {
        if (document.querySelector('.focused') !== node) return;
        const remaining = page.scrollHeight - page.clientHeight - page.scrollTop;
        const box = node.getBoundingClientRect();
        let by = Math.min(step, remaining);
        const top = box.top - by;
        if (top < clear && top + box.height > pageTop) {
          // A full step would leave it half under the bar: stop with it just
          // clear, unless that is hardly a step — then past it altogether,
          // where the page goes that far. (Short of that, what stays out of
          // sight is less than the bar's height, most of it the page's own
          // bottom padding.)
          const keep = Math.max(0, box.top - clear);
          const past = box.bottom - pageTop;
          by = keep >= step / 3 || past > remaining ? keep : past;
        }
        if (by < 1) return;
        leftBehind = node;
        page.scrollBy({ top: by, behavior: 'smooth' });
      }, 0);
    },
    true
  );
}
