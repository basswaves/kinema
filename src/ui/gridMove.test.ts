import { describe, expect, it } from 'vitest';
import { gridMove } from './gridMove';

// Seven cards, three wide:
//   0 1 2
//   3 4 5
//   6
describe('gridMove', () => {
  const move = (direction: string, index: number) => gridMove(direction, index, 7, 3);

  it('moves along a row and stops at its ends', () => {
    expect(move('right', 0)).toBe(1);
    expect(move('right', 2)).toBeNull();
    expect(move('right', 6)).toBeNull();
    expect(move('left', 4)).toBe(3);
    expect(move('left', 3)).toBeNull();
  });

  it('moves down a column, and up it until the first row', () => {
    expect(move('down', 1)).toBe(4);
    expect(move('down', 0)).toBe(3);
    expect(move('up', 4)).toBe(1);
    expect(move('up', 1)).toBeNull();
  });

  it('goes to the last card from a column a short last row does not reach', () => {
    expect(move('down', 4)).toBe(6);
    expect(move('down', 5)).toBe(6);
    expect(move('down', 3)).toBe(6);
    expect(move('down', 6)).toBeNull();
  });

  it('goes nowhere from the last row, or from a cell that is not there', () => {
    expect(gridMove('down', 5, 6, 3)).toBeNull();
    expect(move('down', 9)).toBeNull();
    expect(move('up', -1)).toBeNull();
    expect(gridMove('right', 0, 1, 3)).toBeNull();
    expect(gridMove('down', 0, 1, 3)).toBeNull();
  });

  it('is one long row when only one column fits', () => {
    expect(gridMove('down', 0, 3, 1)).toBe(1);
    expect(gridMove('right', 0, 3, 1)).toBeNull();
  });
});
