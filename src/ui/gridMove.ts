/**
 * Where an arrow press goes inside a grid of cards, worked out from the index
 * alone.
 *
 * The spatial library's own answer is to measure every sibling and sort them
 * by distance, which costs more the longer the list: a shelf of a thousand
 * titles made every press a thousand `getBoundingClientRect` calls on a TV
 * box. A grid is regular, so the neighbour is just index arithmetic, and the
 * answer is the one the geometry gave — the next card along a row, the card
 * above or below in the same column, and from a column the last row does not
 * reach, the last card.
 *
 * `null` is a press that leaves the grid or goes nowhere (Left from the first
 * column, Right from the last, Down from the last row). Nothing wraps, as it
 * never did; whether the press then goes anywhere is the spatial library's
 * question one level up.
 */
export function gridMove(
  direction: string,
  index: number,
  count: number,
  columns: number
): number | null {
  if (index < 0 || index >= count || columns < 1) return null;
  const column = index % columns;
  switch (direction) {
    case 'left':
      return column > 0 ? index - 1 : null;
    case 'right':
      return column < columns - 1 && index + 1 < count ? index + 1 : null;
    case 'up':
      return index >= columns ? index - columns : null;
    case 'down': {
      if (index + columns < count) return index + columns;
      // The last row is short and this column is past its end: the nearest
      // card below is its last one. Already on the last row: nowhere.
      const lastRow = Math.floor((count - 1) / columns);
      return Math.floor(index / columns) < lastRow ? count - 1 : null;
    }
    default:
      return null;
  }
}
