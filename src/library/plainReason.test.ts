import { describe, expect, it } from 'vitest';
import { plainReason } from './plainReason';

describe('plainReason', () => {
  it('says a score and a runner-up in plain words', () => {
    expect(plainReason('title 52%, year exact; ambiguous vs "Beast"')).toBe(
      'The name is 52 % alike, the year is the same; “Beast” looked just as likely'
    );
  });

  it('says each year case', () => {
    expect(plainReason('title 80%, year ±1')).toBe('The name is 80 % alike, the year is one off');
    expect(plainReason('title 90%, year off by 3')).toBe(
      'The name is 90 % alike, the year is 3 years off'
    );
    expect(plainReason('title 90%, no candidate year, candidate has no episodes')).toBe(
      'The name is 90 % alike, it has no year to compare, it lists no episodes'
    );
  });

  it('keeps the searched-as note', () => {
    expect(plainReason('no candidates returned · searched as “X” from a .nfo')).toBe(
      'Nothing came back for this name · searched as “X” from a .nfo'
    );
    expect(plainReason('no candidates scored')).toBe('Nothing that came back was close');
  });

  it('passes other reasons through', () => {
    expect(plainReason('unlinked by hand')).toBe('unlinked by hand');
  });
});
