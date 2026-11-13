import { describe, expect, it } from 'vitest';
import { reviewNoticeWords } from './HomeNotices';

describe('reviewNoticeWords', () => {
  it('says "could not be identified" only about files that were not', () => {
    expect(reviewNoticeWords(3, 0).head).toMatch(/3 videos could not be identified/);
    const all = reviewNoticeWords(8, 8);
    expect(all.head).not.toMatch(/could not be identified/);
    expect(all.tail).not.toMatch(/not on Home yet/);
  });
  it('splits a mixed count', () => {
    const w = reviewNoticeWords(5, 2);
    expect(w.head).toMatch(/3 videos could not be identified/);
    expect(w.tail).toMatch(/2 other matches worth a second look/);
  });
});
