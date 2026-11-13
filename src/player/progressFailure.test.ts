import { describe, expect, it, vi } from 'vitest';
import { createSaveWatch, saveFailureNotice } from './progressFailure';

describe('saveFailureNotice', () => {
  it('names a full disk and a folder that cannot be written, nothing else', () => {
    expect(saveFailureNotice('database or disk is full')).toContain('disk is full');
    expect(saveFailureNotice('attempt to write a readonly database')).toContain('cannot be written');
    expect(saveFailureNotice('something odd')).not.toMatch(/full|written/);
  });
});

describe('createSaveWatch', () => {
  it('says and logs once per run of failures, and logs the recovery', () => {
    const say = vi.fn();
    const log = vi.fn();
    const w = createSaveWatch(say, log);
    w.saved();
    expect(log).not.toHaveBeenCalled();
    w.failed('database or disk is full');
    w.failed('database or disk is full');
    expect(say).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    w.saved();
    expect(log).toHaveBeenCalledTimes(2);
    w.failed('readonly');
    expect(say).toHaveBeenCalledTimes(2);
  });
});
