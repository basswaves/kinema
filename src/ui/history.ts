/**
 * Where Back goes: the screens you came through, newest last.
 *
 * Back used to mean Home from everywhere, so opening a title from search or a
 * See-all grid and pressing Back threw away the results you were working
 * through. Each entry also remembers which control held focus when it was
 * left, so arriving back lands on the card you picked rather than at the top.
 *
 * Kept pure so the rules can be tested without a DOM. `Browse` holds the
 * stack and does the focusing.
 */

export interface Entry<V> {
  view: V;
  /** The focus key held on this view when it was left, if any. */
  returnFocus: string | null;
}

/**
 * Open a view on top of the current one (a detail page, a grid, the player),
 * remembering what was focused on the view being left.
 */
export function open<V>(stack: Entry<V>[], view: V, focused: string | null): Entry<V>[] {
  const top = stack[stack.length - 1];
  const below = stack.slice(0, -1);
  return [...below, { ...top, returnFocus: focused }, { view, returnFocus: null }];
}

/**
 * A top-bar destination. These are places, not steps: choosing one starts
 * again from Home, so Back from any of them goes Home and never back through
 * whatever was open before.
 */
export function navigate<V>(home: V, view: V, isHome: boolean): Entry<V>[] {
  const root: Entry<V> = { view: home, returnFocus: null };
  return isHome ? [root] : [root, { view, returnFocus: null }];
}

/** Swap the current view for another without adding a step — next episode. */
export function replace<V>(stack: Entry<V>[], view: V): Entry<V>[] {
  return [...stack.slice(0, -1), { view, returnFocus: null }];
}

/** One step back. The bottom entry — Home — stays put. */
export function back<V>(stack: Entry<V>[]): Entry<V>[] {
  return stack.length > 1 ? stack.slice(0, -1) : stack;
}

/** The view on screen. */
export function current<V>(stack: Entry<V>[]): V {
  return stack[stack.length - 1].view;
}
