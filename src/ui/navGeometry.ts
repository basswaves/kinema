/**
 * Which control an arrow goes to, inside one group (focusGroups.ts).
 *
 * The spatial library answers "where next" by distance between every control
 * on the page. Between big areas that is right; inside one it sent Down from
 * Back past Play to the season nearest below, and Up from an episode to
 * whatever button happened to be closest (TV-FEEL.md, N5–N7). A group that
 * knows its own shape answers for itself with this, and leaves the page's
 * geometry to choose only which group is next.
 *
 * Pure: boxes in, a key out, so it is tested without a browser.
 */

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Box {
  key: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const vertical = (dir: Direction) => dir === 'up' || dir === 'down';

const OPPOSITE: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

/** Where a box starts and ends along the arrow's axis, and across it. */
function spans(box: Box, dir: Direction) {
  return vertical(dir)
    ? { from: box.top, to: box.bottom, crossFrom: box.left, crossTo: box.right }
    : { from: box.left, to: box.right, crossFrom: box.top, crossTo: box.bottom };
}

/**
 * Whether `other` lies in direction `dir` from `from`: its middle beyond
 * `from`'s middle, and its near edge not behind `from`'s near edge. The
 * second half keeps a tall neighbour that only starts a little lower from
 * counting as "below" a short one beside it.
 */
function beyond(from: Box, other: Box, dir: Direction): boolean {
  const f = spans(from, dir);
  const o = spans(other, dir);
  const fMid = (f.from + f.to) / 2;
  const oMid = (o.from + o.to) / 2;
  const forward = dir === 'down' || dir === 'right';
  return forward ? oMid > fMid + 0.5 && o.from > f.from + 0.5 : oMid < fMid - 0.5 && o.to < f.to - 0.5;
}

/** The gap between two intervals; 0 when they overlap. */
function gap(aFrom: number, aTo: number, bFrom: number, bTo: number): number {
  return Math.max(0, bFrom - aTo, aFrom - bTo);
}

/**
 * How a move from `from` to `other` ranks, best first:
 *
 * 1. The nearest row that way (the gap along the arrow): Up and Down go to
 *    the next row or group, never past one to a control more in line further
 *    on (the owner's "neighbours only", NAV-MAP 2026-10-11). Controls a few
 *    pixels apart along the arrow count as one row.
 * 2. In that row, the one under the start of this one (near its left edge,
 *    going up or down): rows of choices start at the same edge whatever the
 *    text, so this is the same in every browser engine, where the width of a
 *    word is not. A quarter in from the edge, not the edge itself, which can
 *    sit a pixel inside the neighbour in one engine and outside in another;
 *    and a neighbour whose edge is within a few pixels of that point does
 *    not count as under it, for the same reason.
 * 3. The one more squarely ahead (the larger overlap), a near tie counting
 *    as a tie; then the nearer sideways; then the first in reading order.
 */
type Cost = [number, number, number, number, number];

function cost(from: Box, other: Box, dir: Direction): Cost {
  const f = spans(from, dir);
  const o = spans(other, dir);
  const along = gap(f.from, f.to, o.from, o.to);
  const across = gap(f.crossFrom, f.crossTo, o.crossFrom, o.crossTo);
  const overlap = Math.max(0, Math.min(f.crossTo, o.crossTo) - Math.max(f.crossFrom, o.crossFrom));
  const start = f.crossFrom + (f.crossTo - f.crossFrom) / 4;
  const underStart = o.crossFrom <= start - EDGE_PX && o.crossTo >= start + EDGE_PX ? 0 : 1;
  return [along, underStart, -overlap, across, o.crossFrom];
}

/** An edge this close to the point measured from counts as not under it. */
const EDGE_PX = 4;
/** Within this many pixels along the arrow, two controls are in one row. */
const ROW_PX = 8;
/** Within a pixel, or this share of the larger overlap, is a tie. */
const NEAR_PX = 1;
const NEAR_OVERLAP = 0.15;

function better(a: Cost, b: Cost): boolean {
  if (Math.abs(a[0] - b[0]) > ROW_PX) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  const most = Math.max(-a[2], -b[2]);
  if (Math.abs(a[2] - b[2]) > Math.max(NEAR_PX, most * NEAR_OVERLAP)) return a[2] < b[2];
  if (Math.abs(a[3] - b[3]) > NEAR_PX) return a[3] < b[3];
  return a[4] < b[4];
}

function cheapest(from: Box, candidates: Box[], dir: Direction): Box | null {
  let best: Box | null = null;
  let bestCost: Cost = [Infinity, Infinity, Infinity, Infinity, Infinity];
  for (const c of candidates) {
    const k = cost(from, c, dir);
    if (better(k, bestCost)) {
      best = c;
      bestCost = k;
    }
  }
  return best;
}

/**
 * The control an arrow goes to from `from` among `others`, or null when there
 * is none that way.
 *
 * `wrap`: with nothing that way, go round to the far end instead — the
 * control furthest the other way, preferring one in line with `from` (Up on a
 * menu's top item lands on its bottom item, not on the bottom of a column
 * beside it).
 */
export function pickNext(from: Box, others: Box[], dir: Direction, wrap = false): string | null {
  const rest = others.filter((o) => o.key !== from.key);
  const ahead = rest.filter((o) => beyond(from, o, dir));
  const next = cheapest(from, ahead, dir);
  if (next) return next.key;
  if (!wrap) return null;

  const behind = rest.filter((o) => beyond(from, o, OPPOSITE[dir]));
  if (behind.length === 0) return null;
  const f = spans(from, dir);
  const inLine = behind.filter((o) => {
    const s = spans(o, dir);
    return gap(f.crossFrom, f.crossTo, s.crossFrom, s.crossTo) === 0;
  });
  const pool = inLine.length > 0 ? inLine : behind;
  // The far end: the smallest leading edge for Down/Right, the largest
  // trailing edge for Up/Left; then the one most in line.
  const forward = dir === 'down' || dir === 'right';
  const edge = (b: Box) => (forward ? spans(b, dir).from : -spans(b, dir).to);
  const fMid = (f.crossFrom + f.crossTo) / 2;
  const crossMid = (b: Box) => {
    const s = spans(b, dir);
    return Math.abs((s.crossFrom + s.crossTo) / 2 - fMid);
  };
  pool.sort((a, b) => edge(a) - edge(b) || crossMid(a) - crossMid(b));
  return pool[0].key;
}
