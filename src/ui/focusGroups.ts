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
 *   Up on the top item goes round to the bottom one and back (`wrap`), and
 *   an arrow that does not go round stays level (Right from a track is
 *   nothing, not the close button above it). Back
 *   closing it stays with the component that owns it, which knows what
 *   closing means.
 * - **row** — the detail page's buttons, a season row, the top bar. Left and
 *   Right move inside it and stop at its ends (the owner's "neighbours only",
 *   NAV-MAP 2026-10-11: Right from the last button is nothing, not a jump to
 *   whatever is nearest a row lower); Up and Down leave it. Arriving from
 *   anywhere lands on its `current` item (Play, the active season, the open
 *   section, a setting's chosen choice), never on the nearest one and never
 *   on the one last left.
 * - **panel** — an area laid out in rows of its own: a Settings section, the
 *   player's controls. Left and Right go only to a control beside it in the
 *   same row, otherwise nothing; Up and Down to the nearest control that way
 *   (the owner's "neighbours only", 2026-10-11). Which arrows may leave it
 *   is `stopAt` (none held by default; the player holds all four).
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

export type GroupKind = 'menu' | 'row' | 'panel' | 'list';

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
  /** Rows and panels: the arrows that stop at the group's edge instead of
   *  leaving it. A row holds Left and Right by default, a panel nothing. */
  stopAt?: Direction[];
}

const ROW_STOPS: Direction[] = ['left', 'right'];
/** For a group nothing leaves by arrows: the player, a page of its own. */
export const ALL_ARROWS: Direction[] = ['up', 'down', 'left', 'right'];
const NO_STOPS: Direction[] = [];

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
  // A row marked so (ChoiceRow) is left from the control the ring is on, not
  // from the whole row: Down from its last choice goes to what is under that.
  const fromNode = siblings.find((s) => s.focusKey === from)?.node as HTMLElement | undefined;
  const ring = document.querySelector('.focused');
  if (fromBox && fromNode?.dataset.leaveFromRing !== undefined && ring && fromNode.contains(ring)) {
    const r = ring.getBoundingClientRect();
    fromBox = { key: from, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  if (!fromBox) return null;
  const sideways = direction === 'left' || direction === 'right';
  const f = fromBox;
  // Left and Right stay in the row: only controls level with this one. (A
  // menu's track list is a column; Right from a track went up to "close".)
  const level = sideways && (kind === 'panel' || (kind === 'menu' && !wraps(wrap, direction)));
  const pool = level ? boxes.filter((b) => b.top < f.bottom && b.bottom > f.top) : boxes;
  const key = pickNext(fromBox, pool, direction, kind === 'menu' && wraps(wrap, direction));
  if (key !== null) return siblings.find((s) => s.focusKey === key) ?? null;
  // A row too wide for the window wraps onto a second line, and nothing is
  // further right of its line's last button: Right goes on in reading order
  // (Left back), as text does, or the wrapped buttons are out of a remote's
  // reach. Up and Down still leave the row.
  if (kind !== 'row' || !sideways) return null;
  const order = siblings
    .filter((s) => s.focusKey === from || boxes.some((b) => b.key === s.focusKey))
    .sort((a, b) =>
      (a.node as Node).compareDocumentPosition(b.node as Node) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1
    );
  const at = order.findIndex((s) => s.focusKey === from);
  return order[direction === 'right' ? at + 1 : at - 1] ?? null;
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
  { focusKey, current, focusable = true, wrap = 'vertical', stopAt }: Options = {}
): UseFocusableResult<E> {
  const stops = stopAt ?? (kind === 'row' ? ROW_STOPS : NO_STOPS);
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
    // A menu holds every arrow; a row or a panel the ones in `stopAt`.
    isFocusBoundary: kind === 'menu' || stops.length > 0,
    focusBoundaryDirections: kind === 'menu' ? undefined : stops,
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
