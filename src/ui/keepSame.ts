/**
 * Keep what is already on screen when a reload brings back the same thing.
 *
 * Home, a grid and search all read the library again each time they are shown
 * (Browse.tsx, `load`), and a read always returns new objects. Handed to React
 * as they were, a thousand identical titles replaced a thousand identical
 * titles and every rail and card drew itself again, each time Home was shown.
 * So a list that has not changed is the
 * list that was already there (React then draws nothing), and when some of it
 * changed, the rows that did not are the old rows, which the memoised cards
 * can skip.
 *
 * Compares what the data says, not how it is stored: plain JSON-shaped values,
 * as the commands return them.
 */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && same(left[key], right[key]));
}

/**
 * `next`, with every row that equals one in `previous` (matched by `keyOf`)
 * replaced by that row — or `previous` itself when nothing at all changed.
 */
export function keepSame<T>(
  previous: T[],
  next: T[],
  keyOf: (item: T, index: number) => string | number = (_, index) => index
): T[] {
  const before = new Map(previous.map((item, index) => [keyOf(item, index), item]));
  let unchanged = previous.length === next.length;
  const merged = next.map((item, index) => {
    const old = before.get(keyOf(item, index));
    const kept = old !== undefined && same(old, item) ? old : item;
    if (kept !== previous[index]) unchanged = false;
    return kept;
  });
  return unchanged ? previous : merged;
}
