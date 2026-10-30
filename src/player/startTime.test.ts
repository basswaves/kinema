import { describe, expect, it } from 'vitest';
import { noteStart, startRow, startWords } from './startTime';

describe('the Start row', () => {
  it('says the measured figure, and nothing it did not measure', () => {
    noteStart(null, false, 'a.mkv');
    expect(startRow().value).toBe('waiting for the first picture');
    noteStart(null, true, 'a.mkv');
    expect(startRow().value).toBe('not measured');
    noteStart(420, true, 'a.mkv');
    expect(startRow().value).toBe('0.42 s to the first picture');
  });

  it('reads long starts in whole seconds', () => {
    expect(startWords(12_400)).toBe('12 s');
  });
});
