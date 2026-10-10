import { describe, expect, it } from 'vitest';
import { decideLook, medianFrameInterval } from './lightLook';

describe('decideLook', () => {
  it('does what Settings says, whatever the device', () => {
    expect(decideLook('light', { cores: 16 })).toEqual({
      light: true,
      reason: 'Light: chosen in Settings',
    });
    expect(decideLook('full', { cores: 1, memoryGb: 1, medianFrameMs: 80 })).toEqual({
      light: false,
      reason: 'Full: chosen in Settings',
    });
  });

  it('Auto: two cores or fewer is Light, and says so', () => {
    expect(decideLook('auto', { cores: 2 })).toEqual({
      light: true,
      reason: 'Light: this device has 2 processor cores',
    });
    expect(decideLook('auto', { cores: 1 }).reason).toBe('Light: this device has 1 processor core');
    expect(decideLook('auto', { cores: 3 }).light).toBe(false);
  });

  it('Auto: 2 GB of memory or less is Light', () => {
    expect(decideLook('auto', { cores: 4, memoryGb: 2 })).toEqual({
      light: true,
      reason: 'Light: this device reports 2 GB of memory',
    });
    expect(decideLook('auto', { cores: 4, memoryGb: 4 }).light).toBe(false);
  });

  it('Auto: frames slow for the screen are Light; a slow screen alone is not', () => {
    const slow = decideLook('auto', { cores: 4, memoryGb: 4, medianFrameMs: 33.3, screenFrameMs: 16.7 });
    expect(slow.light).toBe(true);
    expect(slow.reason).toBe(
      'Light: while Kinema opened it drew a frame every 33 ms on a screen that takes one every 17 ms'
    );
    // A 24 Hz or 30 Hz screen keeping its own pace is not a weak device.
    expect(decideLook('auto', { cores: 4, medianFrameMs: 41.7, screenFrameMs: 41.7 }).light).toBe(false);
    expect(decideLook('auto', { cores: 4, medianFrameMs: 33.3, screenFrameMs: 33.3 }).light).toBe(false);
    expect(decideLook('auto', { cores: 4, medianFrameMs: 16.7, screenFrameMs: 16.7 }).light).toBe(false);
    // Without the screen's pace there is nothing to measure against.
    expect(decideLook('auto', { cores: 4, medianFrameMs: 50 }).light).toBe(false);
  });

  it('Auto: the processor count wins over the other reasons', () => {
    expect(decideLook('auto', { cores: 2, memoryGb: 1, medianFrameMs: 50 }).reason).toContain(
      'processor cores'
    );
  });

  it('Auto: Full names only what was read', () => {
    expect(decideLook('auto', { cores: 8, memoryGb: 8, medianFrameMs: 16.7 })).toEqual({
      light: false,
      reason: 'Full: this device has 8 processor cores and 8 GB of memory and a frame every 17 ms',
    });
    expect(decideLook('auto', { cores: 6 }).reason).toBe('Full: this device has 6 processor cores');
    expect(decideLook('auto', {})).toEqual({
      light: false,
      reason: 'Full: nothing about this device looks weak',
    });
  });
});

describe('medianFrameInterval', () => {
  const steady = (ms: number, n: number) => Array.from({ length: n }, (_, i) => i * ms);

  it('is the middle frame interval', () => {
    expect(medianFrameInterval(steady(16, 40))).toBe(16);
    expect(medianFrameInterval(steady(33, 40))).toBe(33);
  });

  it('shrugs off a few hitches', () => {
    const times = steady(16, 40);
    for (let i = 20; i < 30; i++) times[i] += 200; // one long stall, then steady again
    expect(medianFrameInterval(times)).toBe(16);
  });

  it('ignores the first frames, which carry start-up work', () => {
    const times = [0, 400, 800, ...steady(16, 40).map((t) => t + 800 + 16)];
    expect(medianFrameInterval(times)).toBe(16);
  });

  it('says nothing without enough frames', () => {
    expect(medianFrameInterval(steady(16, 10))).toBeUndefined();
    expect(medianFrameInterval([])).toBeUndefined();
  });
});
