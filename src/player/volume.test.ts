import { describe, expect, it } from 'vitest';
import { wheelVolumeSteps } from './volume';

describe('wheelVolumeSteps', () => {
  it('takes one step per mouse notch, up louder', () => {
    expect(wheelVolumeSteps(0, -100, 0)).toEqual({ steps: 1, carried: 0 });
    expect(wheelVolumeSteps(0, 100, 0)).toEqual({ steps: -1, carried: 0 });
    expect(wheelVolumeSteps(0, -300, 0)).toEqual({ steps: 3, carried: 0 });
  });

  it('adds up a touchpad before stepping', () => {
    let carried = 0;
    let steps = 0;
    for (let i = 0; i < 9; i++) ({ steps, carried } = wheelVolumeSteps(carried, -10, 0));
    expect(steps).toBe(0);
    ({ steps, carried } = wheelVolumeSteps(carried, -10, 0));
    expect(steps).toBe(1);
    expect(carried).toBeCloseTo(0);
  });

  it('turns lines and pages into pixels', () => {
    expect(wheelVolumeSteps(0, -3, 1).steps).toBe(0);
    expect(wheelVolumeSteps(-1, -3, 1).steps).toBe(1);
    expect(wheelVolumeSteps(0, 1, 2).steps).toBe(-8);
  });
});
