import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE,
  mpvStyleOptions,
  nextSize,
  parseStyles,
  styleFor,
  UNKNOWN_SCREEN,
} from './subtitleStyle';

const plain = { borderStyle: 'outline-and-shadow', backColor: '#00000000', borderColor: '#FF000000' };

describe('subtitle size and box', () => {
  it('keeps one style per screen, and a screen never set is the default', () => {
    const styles = parseStyles(
      JSON.stringify({ tv: { size: 'larger', box: true }, [UNKNOWN_SCREEN]: { size: 'small' } })
    );
    expect(styleFor(styles, 'tv')).toEqual({ size: 'larger', box: true });
    expect(styleFor(styles, null)).toEqual({ size: 'small', box: false });
    expect(styleFor(styles, 'desk')).toEqual(DEFAULT_STYLE);
  });

  it('reads a damaged value as the default, never as a guess', () => {
    expect(parseStyles('{not json')).toEqual({});
    expect(parseStyles('[1,2]')).toEqual({});
    expect(styleFor(parseStyles(JSON.stringify({ tv: { size: 'huge' } })), 'tv')).toEqual(
      DEFAULT_STYLE
    );
  });

  it('goes up a size, and from the largest back to the smallest', () => {
    expect(nextSize('normal')).toBe('large');
    expect(nextSize('larger')).toBe('small');
  });

  it("sets mpv's scale and box, and puts back what mpv had when the box goes", () => {
    expect(mpvStyleOptions({ size: 'large', box: true }, plain)).toEqual([
      ['sub-scale', '1.3'],
      ['sub-border-style', 'background-box'],
      ['sub-back-color', '#C0000000'],
    ]);
    expect(mpvStyleOptions({ size: 'large', box: true }, plain, true)).toEqual([
      ['sub-scale', '1.3'],
      ['sub-border-style', 'opaque-box'],
      ['sub-border-color', '#C0000000'],
    ]);
    expect(mpvStyleOptions(DEFAULT_STYLE, plain)).toEqual([
      ['sub-scale', '1'],
      ['sub-border-style', 'outline-and-shadow'],
      ['sub-back-color', '#00000000'],
      ['sub-border-color', '#FF000000'],
    ]);
  });
});
