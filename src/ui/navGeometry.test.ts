import { describe, expect, it } from 'vitest';
import { pickNext, type Box } from './navGeometry';

const box = (key: string, left: number, top: number, width = 100, height = 40): Box => ({
  key,
  left,
  top,
  right: left + width,
  bottom: top + height,
});

// A menu of four options in a column, 50 px apart.
const menu = ['a', 'b', 'c', 'd'].map((key, i) => box(key, 0, i * 50));
const at = (key: string) => menu.find((b) => b.key === key)!;

describe('pickNext in a column', () => {
  it('moves to the neighbour', () => {
    expect(pickNext(at('b'), menu, 'down')).toBe('c');
    expect(pickNext(at('b'), menu, 'up')).toBe('a');
  });

  it('stops at the ends without wrap', () => {
    expect(pickNext(at('a'), menu, 'up')).toBeNull();
    expect(pickNext(at('d'), menu, 'down')).toBeNull();
  });

  it('goes round with wrap', () => {
    expect(pickNext(at('a'), menu, 'up', true)).toBe('d');
    expect(pickNext(at('d'), menu, 'down', true)).toBe('a');
  });

  it('has nowhere sideways, wrap or not', () => {
    expect(pickNext(at('b'), menu, 'left', true)).toBeNull();
    expect(pickNext(at('b'), menu, 'right', true)).toBeNull();
  });
});

describe('pickNext in a row', () => {
  // Back, Play, Trailer side by side; a wide one starting a little lower.
  const row = [box('back', 0, 0), box('play', 120, 0), box('trailer', 240, 0)];

  it('moves along the row', () => {
    expect(pickNext(row[0], row, 'right')).toBe('play');
    expect(pickNext(row[2], row, 'left')).toBe('play');
    expect(pickNext(row[2], row, 'right')).toBeNull();
  });

  // Never past a row (NAV-MAP 2026-10-11, "neighbours only"): the next row
  // down wins even off to the side; straight ahead decides only within it.
  it('goes to the next row down before one more in line further on', () => {
    const near = box('near', 0, 60); // the next row, off to the left
    const ahead = box('ahead', 240, 90); // a row further, straight below
    const from = box('from', 240, 0);
    expect(pickNext(from, [near, ahead], 'down')).toBe('near');
  });

  it('within the next row, prefers the one straight below', () => {
    const left = box('left', 0, 60);
    const below = box('below', 240, 62);
    expect(pickNext(box('from', 240, 0), [left, below], 'down')).toBe('below');
  });
});

describe('pickNext wrapping in two columns', () => {
  // Audio | Subtitles, three options each.
  const left = [0, 1, 2].map((i) => box(`audio${i}`, 0, i * 50));
  const right = [0, 1, 2].map((i) => box(`sub${i}`, 200, i * 50));
  const all = [...left, ...right];

  it('wraps within its own column, not to the bottom of the other', () => {
    expect(pickNext(right[0], all, 'up', true)).toBe('sub2');
    expect(pickNext(left[2], all, 'down', true)).toBe('audio0');
  });

  it('goes across between columns', () => {
    expect(pickNext(left[1], all, 'right')).toBe('sub1');
    expect(pickNext(right[1], all, 'left')).toBe('audio1');
  });
});

describe('pickNext edge cases', () => {
  it('ignores the box it starts from among the others', () => {
    expect(pickNext(at('a'), [at('a')], 'down', true)).toBeNull();
  });

  it('does not count a tall neighbour starting at the same top as below', () => {
    const short = box('short', 0, 0, 100, 40);
    const tall = box('tall', 120, 0, 100, 200);
    expect(pickNext(short, [tall], 'down')).toBeNull();
  });
});

describe('pickNext between rows of choices', () => {
  // Settings → Playback: a wide "As the file sets it" under Auto | Full.
  const auto = box('auto', 443, 563, 107);
  const full = box('full', 562, 563, 73);
  const wide = box('wide', 443, 826, 214);

  it('goes to the one most squarely above, not the nearer middle', () => {
    expect(pickNext(wide, [auto, full], 'up')).toBe('auto');
  });
});

describe('pickNext under a row aligned to the right', () => {
  // Settings → a video to review: "Add without a match" right-aligned under
  // Search | Ignore these. Measured from the left, the point fell on Search's
  // edge in one engine and inside it in the other.
  it('measures from the edge the two line up on, in both engines', () => {
    const edge = [box('search', 1298.6, 662, 97.7), box('ignore', 1407.9, 662, 136.4)];
    const webkit = [box('search', 1276.8, 662, 107.0), box('ignore', 1395.4, 662, 148.8)];
    expect(pickNext(box('add', 1347.0, 809, 197.3), edge, 'up')).toBe('ignore');
    expect(pickNext(box('add', 1323.3, 837, 221.0), webkit, 'up')).toBe('ignore');
  });

  // The player's track panel: a track across the panel, over the sound delay's
  // −10 ms | +10 ms set in from the left. Wider than the row: from the left.
  it('measures from the left for one wider than the row', () => {
    const row = [box('earlier', 60, 300, 100), box('later', 260, 300, 100)];
    expect(pickNext(box('track', 0, 200, 360), row, 'down')).toBe('earlier');
  });
});

describe('pickNext with a near tie', () => {
  // Settings → Playback: "On a TV" over Full | Light, overlapping each by a
  // few pixels' difference that the two browser engines draw differently.
  const onTv = box('tv', 576, 321, 135);
  const full = box('full', 562, 563, 73);
  const light = box('light', 647, 563, 83);

  it('goes to the first in reading order', () => {
    expect(pickNext(onTv, [full, light], 'down')).toBe('full');
    expect(pickNext(onTv, [light, full], 'down')).toBe('full');
  });
});
