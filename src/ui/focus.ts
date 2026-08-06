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
  ROOT_FOCUS_KEY,
} from '@noriginmedia/norigin-spatial-navigation';

/**
 * Claim focus for `focusKey` once `ready`, unless something live already holds
 * it. The liveness test is the point: a plain "is it root" check misses the
 * common case, where focus is still pointing confidently at an unmounted card.
 *
 * Pointing this at a *container* is usually right — the spatial system then
 * descends to its last focused child, or its `preferredChildFocusKey`, which
 * keeps the choice of landing spot next to the markup that knows about it.
 */
export function useClaimFocus(focusKey: string, ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const current = getCurrentFocusKey();
    if (current !== ROOT_FOCUS_KEY && doesFocusableExist(current)) return;
    void setFocus(focusKey);
  }, [focusKey, ready]);
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
