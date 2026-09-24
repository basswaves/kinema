import { describe, expect, it } from 'vitest';
import { hintFor } from './displayHdr';

describe('hintFor', () => {
  it('sends HDR only to a screen showing HDR', () => {
    expect(hintFor('on')).toBe('yes');
    expect(hintFor('off')).toBe('no');
    expect(hintFor('unsupported')).toBe('no');
  });

  it('keeps HDR possible when the screen could not be asked', () => {
    expect(hintFor('unknown')).toBe('yes');
  });
});
