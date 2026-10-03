import { describe, expect, it } from 'vitest';
import { hdrLabel, type Display } from './equipment';

const screen = (fields: Partial<Display>) => ({ peak_nits: null, ...fields }) as Display;

describe('hdrLabel', () => {
  it('calls a screen with no HDR SDR', () => {
    expect(hdrLabel(screen({ hdr: 'unsupported' }), 'Linux')).toBe('SDR');
    // Remembered before 0.9.1, without the field.
    expect(hdrLabel(screen({ hdr: 'unsupported', screen_hdr: undefined }), 'Linux')).toBe('SDR');
  });

  it('does not call an HDR TV SDR because the desktop has no HDR', () => {
    expect(hdrLabel(screen({ hdr: 'unsupported', screen_hdr: true }), 'Linux')).toBe(
      'HDR capable · the desktop offers no HDR'
    );
  });

  it('names where HDR is switched off', () => {
    expect(hdrLabel(screen({ hdr: 'off', screen_hdr: true }), 'Windows')).toBe(
      'HDR capable · off in Windows'
    );
  });
});
