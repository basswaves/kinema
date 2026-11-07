import { describe, expect, it } from 'vitest';
import { fileName, thumbSize } from './thumbSize';

describe('thumbSize', () => {
  it('takes the next size up from what the card needs on this screen', () => {
    expect(thumbSize(9.5, 16, 1)).toBe(240); // 1080p
    expect(thumbSize(9.5, 16, 2)).toBe(360); // high DPI
    expect(thumbSize(9.5, 32, 2)).toBe(720); // 4K TV, scaled up
    expect(thumbSize(16.75, 16, 2)).toBe(720); // a wide card
  });

  it('has no answer past the largest, and then the picture itself is used', () => {
    expect(thumbSize(16.75, 64, 2)).toBeNull();
  });
});

describe('fileName', () => {
  it('reads both spellings of a path', () => {
    expect(fileName('C:\\data\\artwork\\52.jpg')).toBe('52.jpg');
    expect(fileName('/home/x/artwork/local-7.webp')).toBe('local-7.webp');
  });
});
