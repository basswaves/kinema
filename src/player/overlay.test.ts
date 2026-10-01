import { describe, expect, it } from 'vitest';
import { scalesOverlays } from './overlay';

describe('scalesOverlays', () => {
  it('reads the versions that take a size to scale to', () => {
    // The test stick's, and a development build's.
    expect(scalesOverlays('mpv v0.41.0')).toBe(true);
    expect(scalesOverlays('mpv v0.38.0-dev-g1234567')).toBe(true);
    // Ubuntu 24.04's (WSL here): the page has to match the screen instead.
    expect(scalesOverlays('mpv 0.37.0')).toBe(false);
  });

  it('does not blame a failure on age when the version cannot be read', () => {
    expect(scalesOverlays(null)).toBe(true);
    expect(scalesOverlays('unknown')).toBe(true);
  });
});
