import { describe, expect, it } from 'vitest';
import { resumePoint, resumeShare } from './resume';

describe('resumePoint', () => {
  it('resumes a file stopped part-way', () => {
    expect(resumePoint({ position_secs: 3734, duration_secs: 6000, completed: false })).toBe(3734);
  });

  it('starts again when it had barely started, was finished, or was watched', () => {
    expect(resumePoint({ position_secs: 12, duration_secs: 6000, completed: false })).toBeNull();
    expect(resumePoint({ position_secs: 5900, duration_secs: 6000, completed: false })).toBeNull();
    // Watched: finished at the credits, nothing to resume; a re-watch stopped half-way is.
    expect(resumePoint({ position_secs: 5500, duration_secs: 6000, completed: true })).toBeNull();
    expect(resumePoint({ position_secs: 3000, duration_secs: 6000, completed: true })).toBe(3000);
    expect(resumePoint({ position_secs: 3000, duration_secs: null, completed: true })).toBeNull();
    expect(resumePoint(null)).toBeNull();
  });

  it('resumes when the length is not known', () => {
    expect(resumePoint({ position_secs: 600, duration_secs: null, completed: false })).toBe(600);
  });
});

describe('resumeShare', () => {
  const trakt = (fraction: number | null, position = 0) => ({
    position_secs: position,
    duration_secs: null,
    completed: false,
    fraction,
  });

  it('is the share when only Trakt’s percentage is known', () => {
    expect(resumeShare(trakt(0.4))).toBe(0.4);
  });

  it('gives way to seconds whenever there are any', () => {
    expect(resumeShare(trakt(0.4, 600))).toBeNull();
  });

  it('offers nothing for a finished, barely started or nearly done file', () => {
    expect(resumeShare({ ...trakt(0.4), completed: true })).toBeNull();
    expect(resumeShare(trakt(0.001))).toBeNull();
    expect(resumeShare(trakt(0.97))).toBeNull();
    expect(resumeShare(trakt(null))).toBeNull();
    expect(resumeShare(null)).toBeNull();
  });
});
