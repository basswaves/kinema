import { describe, expect, it } from 'vitest';
import { keepSame } from './keepSame';

interface Row {
  id: number;
  name: string;
  cast: string[];
  progress: number | null;
}

const row = (id: number, fields: Partial<Row> = {}): Row => ({
  id,
  name: `Film ${id}`,
  cast: ['A', 'B'],
  progress: null,
  ...fields,
});
const byId = (r: Row) => r.id;

describe('keepSame', () => {
  it('hands back the old list when a reload brought the same thing', () => {
    const before = [row(1), row(2), row(3)];
    const after = [row(1), row(2), row(3)];
    expect(keepSame(before, after, byId)).toBe(before);
  });

  it('keeps the old rows that did not change and takes the one that did', () => {
    const before = [row(1), row(2), row(3)];
    const after = [row(1), row(2, { progress: 0.5 }), row(3)];
    const merged = keepSame(before, after, byId);
    expect(merged).not.toBe(before);
    expect(merged[0]).toBe(before[0]);
    expect(merged[1]).toBe(after[1]);
    expect(merged[2]).toBe(before[2]);
  });

  it('sees a change inside a list in a row', () => {
    const before = [row(1)];
    const merged = keepSame(before, [row(1, { cast: ['A', 'C'] })], byId);
    expect(merged).not.toBe(before);
    expect(merged[0].cast).toEqual(['A', 'C']);
  });

  it('follows the new order and length, reusing rows that moved', () => {
    const before = [row(1), row(2), row(3)];
    const merged = keepSame(before, [row(3), row(1)], byId);
    expect(merged.map((r) => r.id)).toEqual([3, 1]);
    expect(merged[0]).toBe(before[2]);
    expect(merged[1]).toBe(before[0]);
  });

  it('is not the old list when only the length differs', () => {
    const before = [row(1), row(2)];
    expect(keepSame(before, [row(1)], byId)).not.toBe(before);
    expect(keepSame([], [row(1)], byId)).toHaveLength(1);
    const none: Row[] = [];
    expect(keepSame(none, [], byId)).toBe(none);
  });

  it('matches by position when no key is given', () => {
    const before = ['a', 'b'];
    expect(keepSame(before, ['a', 'b'])).toBe(before);
    expect(keepSame(before, ['a', 'c'])).toEqual(['a', 'c']);
  });
});
