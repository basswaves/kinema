import { describe, expect, it } from 'vitest';
import { delayLabel, describeDelay, MAX_DELAY_MS, parseDelays } from './audioDelay';

describe('parseDelays', () => {
  it('keeps each device its own amount, in 10 ms steps', () => {
    expect(parseDelays('{"{0.0.0}.{a}": 40, "*": -23}')).toEqual({ '{0.0.0}.{a}': 40, '*': -20 });
  });

  it('leaves out what is damaged, and clamps a stray amount', () => {
    expect(parseDelays('not json')).toEqual({});
    expect(parseDelays('[1]')).toEqual({});
    expect(parseDelays('{"a": "40", "b": 0, "c": 99999}')).toEqual({ c: MAX_DELAY_MS });
    expect(parseDelays(null)).toEqual({});
  });
});

describe('describeDelay', () => {
  it('says which way the sound moves', () => {
    expect(describeDelay(40)).toBe('Sound delayed by 40 ms');
    expect(describeDelay(-20)).toBe('Sound 20 ms earlier');
    expect(describeDelay(0)).toBe('Sound in step, no delay');
    expect(delayLabel(40)).toBe('+40 ms');
    expect(delayLabel(-20)).toBe('−20 ms');
  });
});
