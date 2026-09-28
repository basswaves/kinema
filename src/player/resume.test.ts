import { describe, expect, it } from 'vitest';
import { resumePoint } from './resume';

describe('resumePoint', () => {
  it('resumes a file stopped part-way', () => {
    expect(resumePoint({ position_secs: 3734, duration_secs: 6000, completed: false })).toBe(3734);
  });

  it('starts again when it had barely started, was finished, or was watched', () => {
    expect(resumePoint({ position_secs: 12, duration_secs: 6000, completed: false })).toBeNull();
    expect(resumePoint({ position_secs: 5900, duration_secs: 6000, completed: false })).toBeNull();
    expect(resumePoint({ position_secs: 3000, duration_secs: 6000, completed: true })).toBeNull();
    expect(resumePoint(null)).toBeNull();
  });

  it('resumes when the length is not known', () => {
    expect(resumePoint({ position_secs: 600, duration_secs: null, completed: false })).toBe(600);
  });
});
