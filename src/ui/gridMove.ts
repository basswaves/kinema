/**
 * Where an arrow press goes inside a grid of cards, worked out from the index
 * alone — for grids still on the spatial library (search). Kinema's own
 * engine moves its grids by the same arithmetic (focusModel.ts, `gridStep`).
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
import { gridStep, type Arrow } from './focusModel';

const ARROWS = new Set(['up', 'down', 'left', 'right']);

export function gridMove(
  direction: string,
  index: number,
  count: number,
  columns: number
): number | null {
  return ARROWS.has(direction) ? gridStep(direction as Arrow, index, count, columns) : null;
}
