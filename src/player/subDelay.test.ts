import { describe, expect, it } from 'vitest';
import {
  MAX_FILES,
  describeSubDelay,
  parseSubDelays,
  subDelayLabel,
  withSubDelay,
} from './subDelay';

describe('subtitle timing', () => {
  it('reads what was stored, and drops what is damaged or none', () => {
    expect(parseSubDelays('{"a.mkv":1500,"b.mkv":0,"c.mkv":"x","d.mkv":149}')).toEqual({
      'a.mkv': 1500,
      'd.mkv': 100,
    });
    expect(parseSubDelays('[1]')).toEqual({});
    expect(parseSubDelays('not json')).toEqual({});
    expect(parseSubDelays(null)).toEqual({});
    expect(parseSubDelays('{"a.mkv":99999999}')).toEqual({ 'a.mkv': 600_000 });
  });

  it('keeps one amount per file, newest last, and forgets the oldest past the limit', () => {
    expect(withSubDelay({ 'a.mkv': 500, 'b.mkv': 200 }, 'a.mkv', 700)).toEqual({ 'b.mkv': 200, 'a.mkv': 700 });
    expect(withSubDelay({ 'a.mkv': 500 }, 'a.mkv', 0)).toEqual({});
    const many = Object.fromEntries(Array.from({ length: MAX_FILES }, (_, i) => [`${i}.mkv`, 100]));
    const next = withSubDelay(many, 'new.mkv', 300);
    expect(Object.keys(next)).toHaveLength(MAX_FILES);
    expect(next['0.mkv']).toBeUndefined();
    expect(next['new.mkv']).toBe(300);
  });

  it('says the amount the way mpv means it: positive is later', () => {
    expect(subDelayLabel(500)).toBe('+0.5 s');
    expect(subDelayLabel(-2300)).toBe('−2.3 s');
    expect(subDelayLabel(1000)).toBe('+1 s');
    expect(subDelayLabel(0)).toBe('0 s');
    expect(describeSubDelay(-2300)).toBe('Subtitles 2.3 s earlier');
    expect(describeSubDelay(1000)).toBe('Subtitles 1 s later');
    expect(describeSubDelay(0)).toBe('Subtitles at their own timing');
  });
});
