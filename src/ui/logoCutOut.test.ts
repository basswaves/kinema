import { describe, expect, it } from 'vitest';
import { cutOut, letteringSplit } from './logoCutOut';

type Rgba = [number, number, number, number];

/** A logo as pixels: so many of each colour. */
function logo(...parts: [Rgba, number][]): Uint8ClampedArray {
  const pixels = parts.flatMap(([rgba, count]) => Array.from({ length: count }, () => rgba).flat());
  return new Uint8ClampedArray(pixels);
}

const CLEAR: Rgba = [0, 0, 0, 0];
const WHITE: Rgba = [255, 255, 255, 255];
const RED: Rgba = [230, 36, 41, 255];
const BLACK: Rgba = [10, 10, 10, 255];
const BLUE: Rgba = [30, 60, 200, 255];

describe('letteringSplit', () => {
  it('finds white lettering on a red plate', () => {
    expect(letteringSplit(logo([RED, 600], [WHITE, 300], [CLEAR, 400]))).not.toBeNull();
  });

  it('leaves a logo of one colour alone', () => {
    expect(letteringSplit(logo([BLACK, 600], [CLEAR, 400]))).toBeNull();
  });

  it('leaves two dark colours alone: a red mark beside black lettering', () => {
    expect(letteringSplit(logo([BLACK, 600], [RED, 200], [CLEAR, 400]))).toBeNull();
  });

  it('leaves a shaded mark alone', () => {
    const greys = Array.from({ length: 40 }, (_, i): [Rgba, number] => {
      const v = Math.round(20 + i * 5.5);
      return [[v, v, v, 255], 20];
    });
    expect(letteringSplit(logo(...greys, [CLEAR, 300]))).toBeNull();
  });

  it('leaves a logo that is mostly white alone', () => {
    expect(letteringSplit(logo([WHITE, 900], [BLUE, 100]))).toBeNull();
  });

  it('ignores see-through pixels whatever their colour', () => {
    expect(letteringSplit(logo([BLACK, 600], [[255, 255, 255, 0], 600]))).toBeNull();
  });
});

describe('cutOut', () => {
  it('turns the plate white and the lettering see-through', () => {
    const pixels = logo([RED, 1], [WHITE, 1], [CLEAR, 1]);
    cutOut(pixels, letteringSplit(logo([RED, 600], [WHITE, 300])) as number);
    expect([...pixels]).toEqual([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 0]);
  });
});
