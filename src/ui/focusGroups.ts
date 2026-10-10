/**
 * The few kinds of focus group a screen is built from, each with fixed
 * behaviour (TV-FEEL.md, "Proposal").
 *
 * Left to the spatial library, every arrow press inside a screen is answered
 * by distance between controls. Between big areas that is right; inside one it
 * is wrong often enough to be felt on every screen: Down from Back reached the
 * nearest season instead of Play, Up from an episode reached "Mark season
 * watched", focus walked out of the Audio & subtitles panel. Rather than fix
 * each move by hand, an area says what it *is*, and distance then decides only
 * which area comes next:
 *
 * - **menu** — a panel, dialog or picker. Focus cannot leave it by arrows;
 *   Up on the top item goes round to the bottom one and back (`wrap`). Back
 *   closing it stays with the component that owns it, which knows what
 *   closing means.
 * - **row** — the detail page's buttons, a season row, the top bar. Left and
 *   Right move inside it; Up and Down leave it. Arriving from anywhere lands
 *   on its `current` item (Play, the active season, the open section), never
 *   on the nearest one and never on the one last left.
 * - **list** — a list, grid or rail. Arriving lands on the item last focused
 *   there, or `current` the first time; inside, the library's own geometry
 *   (or a resolver of the caller's, like CardGrid's) as before.
 *
 * The rules of the library still apply (docs/GOTCHAS.md, "Spatial
 * navigation"): each group's children must be declared in components of their
 * own so they register inside the group's provider, and a group with nothing
 * focusable in it must say so with `focusable: false`.
 */
import {
  useFocusable,
  type Direction,
  type FocusableComponent,
  type UseFocusableResult,
} from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect } from 'react';
import { pickNext, type Box } from './navGeometry';

export type GroupKind = 'menu' | 'row' | 'list';

export type Wrap = 'vertical' | 'horizontal' | 'both' | 'none';

interface Options {
  focusKey?: string;
  /** Where arriving lands: the row's current item, a list's first-time item,
   *  a menu's selected option. */
  current?: string;
  /** False when the group has nothing to land on (an empty rail). */
  focusable?: boolean;
  /** Menus only: which arrows go round at the ends. Up/Down by default. */
  wrap?: Wrap;
}

function boxOf(component: FocusableComponent): Box | null {
  const node = component.node as HTMLElement | null | undefined;
  if (!node?.isConnected) return null;
  const r = node.getBoundingClientRect();
  // Laid out but not drawn (display: none) — nowhere a ring could show.
  if (r.width === 0 && r.height === 0) return null;
  return { key: component.focusKey, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function wraps(wrap: Wrap, direction: Direction): boolean {
  if (wrap === 'both') return true;
  if (wrap === 'vertical') return direction === 'up' || direction === 'down';
  if (wrap === 'horizontal') return direction === 'left' || direction === 'right';
  return false;
}

/**
 * The next sibling inside a group, by its own rules: a row answers only Left
 * and Right, a menu answers everything and goes round where `wrap` says.
 * `null` sends the press on to the group's parent — or, for a menu, nowhere.
 *
 * Measured fresh with `getBoundingClientRect` at the moment of the press, not
 * from the library's cached positions, which a scroll between presses makes
 * wrong (GOTCHAS, "A scroll between two presses sends focus backwards").
 */
export function resolveInGroup(
  kind: GroupKind,
  wrap: Wrap,
  direction: Direction,
  from: string,
  siblings: FocusableComponent[]
): FocusableComponent | null {
  if (kind === 'row' && (direction === 'up' || direction === 'down')) return null;
  const boxes: Box[] = [];
  let fromBox: Box | null = null;
  for (const s of siblings) {
    const box = boxOf(s);
    if (!box) continue;
    if (s.focusKey === from) fromBox = box;
    else boxes.push(box);
  }
  if (!fromBox) return null;
  const key = pickNext(fromBox, boxes, direction, kind === 'menu' && wraps(wrap, direction));
  return key === null ? null : (siblings.find((s) => s.focusKey === key) ?? null);
}

/**
 * Make a component a focus group of `kind`. Use like `useFocusable`: put
 * `ref` on the group's element and wrap its children in
 * `<FocusContext.Provider value={focusKey}>`.
 *
 * The element is marked `data-focus-group` with its kind, which the on-screen
 * rule (focus.ts, `keepOnScreen`) and the navigation checker read.
 */
export function useFocusGroup<E extends HTMLElement = HTMLDivElement>(
  kind: GroupKind,
  { focusKey, current, focusable = true, wrap = 'vertical' }: Options = {}
): UseFocusableResult<E> {
  const resolve = useCallback(
    (direction: Direction, from: string, siblings: FocusableComponent[]) =>
      resolveInGroup(kind, wrap, direction, from, siblings),
    [kind, wrap]
  );

  const result = useFocusable<object, E>({
    focusKey,
    focusable,
    trackChildren: true,
    // A row always lands on its current item; the others come back to where
    // the person was.
    saveLastFocusedChild: kind !== 'row',
    preferredChildFocusKey: current,
    isFocusBoundary: kind === 'menu',
    // A list keeps the library's own search (or the caller's resolver on a
    // container inside it): replacing it would change every move on Home.
    nextFocusResolver: kind === 'list' ? undefined : resolve,
  });

  const { ref } = result;
  useEffect(() => {
    ref.current?.setAttribute('data-focus-group', kind);
  }, [ref, kind]);

  return result;
}
