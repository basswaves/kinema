/**
 * Where an arrow goes, from the structure of the screen alone (round 7,
 * notes FOCUS-REWORK.md): a pure function of the tree of areas, the control
 * holding the ring, the key and what each area remembers.
 *
 * The spatial library this replaces answered every press by measuring every
 * control on screen and taking the nearest one that way. Anything that moved a
 * control a few pixels — a button added, a row wrapping on a narrower window,
 * a font that renders differently on Linux — changed where arrows went, on
 * screens nobody touched (docs/GOTCHAS.md, "Spatial navigation"). Here a
 * control's place is its position in the tree, in document order, as on the
 * TV platforms: nothing is measured, so nothing on screen can change an
 * answer, and every rule below can be tested without a browser
 * (focusModel.test.ts).
 *
 * The areas:
 *
 * - **row** — controls side by side: Left and Right move along it, Up and
 *   Down leave it. Arriving lands on its `current` (Play, the open section,
 *   the chosen order), else its first; a rail is a row that `remember`s.
 * - **column** — areas or controls one above the other: Up and Down move,
 *   Left and Right leave. A page is a column of rows.
 * - **grid** — cards in rows of `columns`, moved by index (gridMove.ts).
 * - **menu** — a column (or a row, `axis: 'x'`) that holds every arrow and
 *   goes round where `wrap` says.
 *
 * A press is answered by the nearest area, walking up from the control, whose
 * axis it is: Right in a column goes on up to the row that holds it, and a
 * press no area answers goes nowhere. That alone is the owner's "neighbours
 * only" (NAV-MAP, 2026-10-11): Right from the end of a rail cannot jump to
 * whatever is nearest a row lower, because nothing above the rail moves
 * sideways.
 */

export type Arrow = 'up' | 'down' | 'left' | 'right';

export type AreaKind = 'row' | 'column' | 'grid' | 'menu';

export type Wrap = 'vertical' | 'horizontal' | 'both' | 'none';

export interface AreaSpec {
  kind: AreaKind;
  /** Where arriving lands: a key of a child or of anything inside one. */
  current?: string | null;
  /** Arriving comes back to the child last held (a rail, a list, a grid). */
  remember?: boolean;
  /** A grid's cards across. */
  columns?: number;
  /** A menu's axis; `y` unless said. */
  axis?: 'x' | 'y';
  /** Menus: which arrows go round at the ends. Up and Down unless said. */
  wrap?: Wrap;
  /** Arrows that stop at this area's edge instead of leaving it. A menu
   *  holds all four by itself. */
  hold?: readonly Arrow[];
}

export interface NavNode {
  key: string;
  parent: string | null;
  /** In document order. A control has none. */
  children: readonly string[];
  /** An area's rules; absent on a control. */
  area?: AreaSpec;
  /** A control that cannot hold the ring now (disabled), or an area that
   *  is no place to go (one that shows nothing). */
  disabled?: boolean;
}

/** The tree, by key: a Map, or the live registry (focusEngine.tsx). */
export interface NavTree {
  get(key: string): NavNode | undefined;
}

/** Per area, the child last on the way to the ring. */
export type Memory = ReadonlyMap<string, string>;

const ALL: readonly Arrow[] = ['up', 'down', 'left', 'right'];

function axisOf(spec: AreaSpec): 'x' | 'y' | 'grid' {
  if (spec.kind === 'row') return 'x';
  if (spec.kind === 'grid') return 'grid';
  if (spec.kind === 'menu') return spec.axis ?? 'y';
  return 'y';
}

function holds(spec: AreaSpec, arrow: Arrow): boolean {
  return (spec.kind === 'menu' ? ALL : (spec.hold ?? [])).includes(arrow);
}

function wraps(spec: AreaSpec, arrow: Arrow): boolean {
  if (spec.kind !== 'menu') return false;
  const wrap = spec.wrap ?? 'vertical';
  if (wrap === 'both') return true;
  if (wrap === 'vertical') return arrow === 'up' || arrow === 'down';
  if (wrap === 'horizontal') return arrow === 'left' || arrow === 'right';
  return false;
}

/** Whether `key` is a control that can hold the ring, or an area with one in it. */
export function canHold(tree: NavTree, key: string): boolean {
  const node = tree.get(key);
  if (!node || node.disabled) return false;
  if (!node.area) return true;
  return node.children.some((child) => canHold(tree, child));
}

/** Whether `inner` is `outer` or inside it. */
export function within(tree: NavTree, inner: string, outer: string): boolean {
  for (let key: string | null = inner; key !== null; key = tree.get(key)?.parent ?? null) {
    if (key === outer) return true;
  }
  return false;
}

/** The child of `area` that holds `key`, or null when `key` is not inside it. */
function childHolding(tree: NavTree, area: string, key: string): string | null {
  for (let at: string | null = key; at !== null; ) {
    const parent: string | null = tree.get(at)?.parent ?? null;
    if (parent === area) return at;
    at = parent;
  }
  return null;
}

/**
 * The control arriving at `key` lands on. `from` is the arrow that brought
 * the ring here, when one did: an area entered along its own axis without a
 * `current` or a memory lands on the end nearest the ring (Up into a column
 * of notices is its last one, as it is on screen).
 */
export function enter(tree: NavTree, key: string, memory: Memory, from?: Arrow): string | null {
  const node = tree.get(key);
  if (!node || node.disabled) return null;
  if (!node.area) return key;
  const spec = node.area;

  if (spec.remember) {
    const last = memory.get(key);
    if (last && node.children.includes(last)) {
      const landed = enter(tree, last, memory);
      if (landed) return landed;
    }
  }
  if (spec.current) {
    if (spec.current !== key && within(tree, spec.current, key)) {
      // A control named directly is landed on directly; an area by its own rules.
      const landed = enter(tree, spec.current, memory);
      if (landed) return landed;
      // A current that cannot hold the ring now: its branch, by its rules.
      const branch = childHolding(tree, key, spec.current);
      if (branch) {
        const fallback = enter(tree, branch, memory);
        if (fallback) return fallback;
      }
    }
  }
  const axis = axisOf(spec);
  const fromEnd =
    (from === 'up' && axis === 'y') || (from === 'left' && axis === 'x');
  const order = fromEnd ? [...node.children].reverse() : node.children;
  for (const child of order) {
    const landed = enter(tree, child, memory);
    if (landed) return landed;
  }
  return null;
}

/** The indices to try, in order, for `arrow` from `index` in an area of `count`. */
function steps(spec: AreaSpec, arrow: Arrow, index: number, count: number): number[] {
  const axis = axisOf(spec);
  if (axis === 'grid') {
    const to = gridStep(arrow, index, count, Math.max(1, spec.columns ?? 1));
    return to === null ? [] : [to];
  }
  const forward = axis === 'x' ? arrow === 'right' : arrow === 'down';
  const backward = axis === 'x' ? arrow === 'left' : arrow === 'up';
  if (!forward && !backward) return [];
  const out: number[] = [];
  const by = forward ? 1 : -1;
  for (let i = index + by; i >= 0 && i < count; i += by) out.push(i);
  if (wraps(spec, arrow)) {
    for (let i = forward ? 0 : count - 1; i !== index && i >= 0 && i < count; i += by) out.push(i);
  }
  return out;
}

/**
 * Inside a grid of `columns`: the next card along a row, the card above or
 * below in the same column, and from a column the last row does not reach,
 * the last card. `null` leaves the grid (Up from the first row) or goes
 * nowhere. Nothing wraps.
 */
export function gridStep(arrow: Arrow, index: number, count: number, columns: number): number | null {
  if (index < 0 || index >= count || columns < 1) return null;
  const column = index % columns;
  switch (arrow) {
    case 'left':
      return column > 0 ? index - 1 : null;
    case 'right':
      return column < columns - 1 && index + 1 < count ? index + 1 : null;
    case 'up':
      return index >= columns ? index - columns : null;
    case 'down': {
      if (index + columns < count) return index + columns;
      const lastRow = Math.floor((count - 1) / columns);
      return Math.floor(index / columns) < lastRow ? count - 1 : null;
    }
  }
}

/**
 * Where `arrow` takes the ring from `focused`: a control's key, or null for
 * a press that goes nowhere (an edge, a menu's end that does not go round).
 */
export function move(tree: NavTree, focused: string, arrow: Arrow, memory: Memory): string | null {
  let child = focused;
  let parent = tree.get(focused)?.parent ?? null;
  while (parent !== null) {
    const area = tree.get(parent);
    if (!area?.area) return null;
    const index = area.children.indexOf(child);
    if (index < 0) return null;
    for (const i of steps(area.area, arrow, index, area.children.length)) {
      const landed = enter(tree, area.children[i], memory, arrow);
      if (landed) return landed;
      // A grid's step is one card; any other area tries the next one along
      // (an empty rail is passed over, not a wall).
      if (area.area.kind === 'grid') break;
    }
    if (holds(area.area, arrow)) return null;
    child = parent;
    parent = area.parent;
  }
  return null;
}

/** What remembering the ring on `focused` sets: each area on its way, the child it came through. */
export function remembered(tree: NavTree, focused: string): [area: string, child: string][] {
  const out: [string, string][] = [];
  let child = focused;
  for (let parent = tree.get(focused)?.parent ?? null; parent !== null; ) {
    out.push([parent, child]);
    child = parent;
    parent = tree.get(parent)?.parent ?? null;
  }
  return out;
}

/**
 * The stops Tab goes through, in document order: one per row, grid or menu
 * (its landing control, as a composite widget is on the web), and each
 * control standing alone in a column.
 */
export function tabStops(tree: NavTree, root: string): string[] {
  const out: string[] = [];
  const walk = (key: string) => {
    const node = tree.get(key);
    if (!node || !canHold(tree, key)) return;
    if (!node.area || node.area.kind !== 'column') out.push(key);
    else for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** Tab (or Shift+Tab, `back`): the next stop's landing control, or null past the last. */
export function tabMove(
  tree: NavTree,
  root: string,
  focused: string,
  back: boolean,
  memory: Memory
): string | null {
  const stops = tabStops(tree, root);
  const at = stops.findIndex((stop) => within(tree, focused, stop));
  const next = at < 0 ? (back ? stops.length - 1 : 0) : at + (back ? -1 : 1);
  if (next < 0 || next >= stops.length) return null;
  return enter(tree, stops[next], memory);
}

/**
 * The part of the screen the one scroll rule lines up below the top bar:
 * the area holding the ring within the nearest column — a rail, the hero, a
 * notice — or, in a grid, the card itself (its row), except on the first row,
 * where it is the grid (whose heading then stays in sight).
 */
export function scrollAnchor(tree: NavTree, focused: string): string {
  // The child of the lowest column with no row between it and the page: a
  // Continue card is a column of its own, inside its rail.
  let anchor: string | null = null;
  let child = focused;
  for (let parent = tree.get(focused)?.parent ?? null; parent !== null; ) {
    const area = tree.get(parent)?.area;
    if (area?.kind === 'grid') {
      // The first row with the grid's own heading above it; any other, the row.
      const index = tree.get(parent)?.children.indexOf(child) ?? 0;
      return index < Math.max(1, area.columns ?? 1) ? parent : child;
    }
    const vertical = area && (area.kind === 'column' || (area.kind === 'menu' && (area.axis ?? 'y') === 'y'));
    if (!vertical) anchor = null;
    else if (anchor === null) anchor = child;
    child = parent;
    parent = tree.get(parent)?.parent ?? null;
  }
  return anchor ?? child;
}

/**
 * Where the ring goes when the control holding it has gone: the nearest area
 * on its old way (`path`, nearest first, each with the index the ring's
 * branch had there) that is still here and holds something, at that index —
 * the card that slid into its place, else the one before — and from there by
 * that area's rules. Null when nothing on the way is left.
 */
export function recover(
  tree: NavTree,
  path: readonly { area: string; index: number }[],
  memory: Memory
): string | null {
  for (const { area, index } of path) {
    const node = tree.get(area);
    if (!node?.area || !canHold(tree, area)) continue;
    const count = node.children.length;
    const at = Math.min(index, count - 1);
    for (let i = at; i < count; i++) {
      const landed = enter(tree, node.children[i], memory);
      if (landed) return landed;
    }
    for (let i = at - 1; i >= 0; i--) {
      const landed = enter(tree, node.children[i], memory);
      if (landed) return landed;
    }
  }
  return null;
}
