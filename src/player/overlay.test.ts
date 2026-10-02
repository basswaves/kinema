import { describe, expect, it } from 'vitest';
import { scalesOverlays, stageFor } from './overlay';

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

describe('stageFor', () => {
  const tv = 3840 / 2160;

  it('is the whole page when the page already has the film screen’s shape', () => {
    expect(stageFor(1920, 1080, tv)).toEqual({ width: 1920, height: 1080 });
  });

  it('keeps the shape of a page Sway floated 90 pixels too large', () => {
    // Seen on the test TV: asked for 1920×1080, given 2010×1170.
    expect(stageFor(2010, 1170, tv)).toEqual({ width: 2010, height: 1131 });
  });

  it('keeps the shape of a page squeezed beside the film by a tiling desktop', () => {
    // Hyprland, before Kinema's window was floated: 933 of 1920 wide.
    expect(stageFor(933, 1038, tv)).toEqual({ width: 933, height: 525 });
  });

  it('uses the full height of a page wider than the screen', () => {
    expect(stageFor(2560, 1080, tv)).toEqual({ width: 1920, height: 1080 });
  });

  it('leaves the page alone when there is no shape to fit', () => {
    expect(stageFor(1600, 900, 0)).toEqual({ width: 1600, height: 900 });
    expect(stageFor(1600, 900, NaN)).toEqual({ width: 1600, height: 900 });
  });
});
