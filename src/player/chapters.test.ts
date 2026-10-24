import { describe, expect, it } from 'vitest';
import { chapterAt, chapterName } from './chapters';

const chapters = [
  { time: 0, title: 'Opening' },
  { time: 300, title: null },
  { time: 900, title: '  ' },
];

describe('chapterAt', () => {
  it('is the last chapter to have started', () => {
    expect(chapterAt(chapters, 0)).toBe(0);
    expect(chapterAt(chapters, 299)).toBe(0);
    expect(chapterAt(chapters, 300)).toBe(1);
    expect(chapterAt(chapters, 5000)).toBe(2);
  });

  it('counts a jump that lands just short as there', () => {
    expect(chapterAt(chapters, 299.8)).toBe(1);
  });

  it('is -1 before a first chapter that starts late', () => {
    expect(chapterAt([{ time: 10, title: null }], 2)).toBe(-1);
  });
});

describe('chapterName', () => {
  it("uses the file's name, else the number", () => {
    expect(chapterName(chapters[0], 0)).toBe('Opening');
    expect(chapterName(chapters[1], 1)).toBe('Chapter 2');
    expect(chapterName(chapters[2], 2)).toBe('Chapter 3');
  });
});
