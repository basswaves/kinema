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
 * How far a move from `from` to `other` is: the gap along the arrow, with any
 * sideways step counting double, so the control straight ahead wins over a
 * nearer one off to the side. Ties go to the closer middle.
 */
function cost(from: Box, other: Box, dir: Direction): [number, number] {
  const f = spans(from, dir);
  const o = spans(other, dir);
  const along = gap(f.from, f.to, o.from, o.to);
  const across = gap(f.crossFrom, f.crossTo, o.crossFrom, o.crossTo);
  const mid = Math.abs((f.crossFrom + f.crossTo) / 2 - (o.crossFrom + o.crossTo) / 2);
  return [along + 2 * across, mid];
}

function cheapest(from: Box, candidates: Box[], dir: Direction): Box | null {
  let best: Box | null = null;
  let bestCost: [number, number] = [Infinity, Infinity];
  for (const c of candidates) {
    const k = cost(from, c, dir);
    if (k[0] < bestCost[0] || (k[0] === bestCost[0] && k[1] < bestCost[1])) {
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
