import { describe, expect, it } from 'vitest';
import { DRAWN_COLOURS, drawnColour } from './drawnColour';

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('drawn posters', () => {
  it('white lettering passes WCAG AA on every colour', () => {
    for (const colour of DRAWN_COLOURS) {
      expect((1 + 0.05) / (luminance(colour) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the same title and year are always the same colour', () => {
    expect(drawnColour('A Film', 2011)).toBe(drawnColour('a film ', 2011));
    expect(DRAWN_COLOURS).toContain(drawnColour('Another', null));
  });

  it('spreads titles over the palette', () => {
    const used = new Set(Array.from({ length: 40 }, (_, i) => drawnColour(`Title ${i}`, 2000 + i)));
    expect(used.size).toBeGreaterThanOrEqual(6);
  });
});
