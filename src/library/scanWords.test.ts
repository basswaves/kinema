import { describe, expect, it } from 'vitest';
import { scanBarWords, scanStageWords, scanWords } from './scanWords';

describe('scanWords', () => {
  it('says a stage in plain words', () => {
    expect(scanStageWords('parsing')).toBe('Reading file names…');
    expect(scanWords({ stage: 'matching', detail: '' })).toBe('Finding the titles…');
  });

  it('says a count as "of"', () => {
    expect(scanWords({ stage: 'matching', detail: '348/397 · A Title' })).toBe(
      'Finding the titles · 348 of 397 · A Title'
    );
    expect(scanWords({ stage: 'examining', detail: '3/10' })).toBe(
      'Looking inside the files · 3 of 10'
    );
    expect(scanWords({ stage: 'parsing', detail: '120 files' })).toBe(
      'Reading file names · 120 files'
    );
  });
});

describe('a scan coming back from a pause', () => {
  const waited = { stage: 'artwork', detail: '3/9', waited: true } as const;

  it('says so where the progress is', () => {
    expect(scanWords(waited)).toBe('Picked up after a pause · Getting pictures · 3 of 9');
  });

  it('says so in the top bar', () => {
    expect(scanBarWords(waited)).toBe('Picked up after a pause · Getting pictures…');
    expect(scanBarWords({ stage: 'artwork', detail: '' })).toBe('Getting pictures…');
  });
});
