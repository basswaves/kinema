import { beforeEach, describe, expect, it, vi } from 'vitest';

// A scan store the test can move through its stages, and a count it can set.
const scan = vi.hoisted(() => {
  let status: { stage: string; detail: string } | null = null;
  const listeners = new Set<() => void>();
  return {
    set(stage: string | null) {
      status = stage === null ? null : { stage, detail: '' };
      for (const l of listeners) l();
    },
    getScanStatus: () => status,
    subscribeScan: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
});
const db = vi.hoisted(() => ({ count: 0 }));

vi.mock('../library/pipeline', () => ({
  getScanStatus: scan.getScanStatus,
  subscribeScan: scan.subscribeScan,
}));
vi.mock('./api', () => ({ countNeedsReview: () => Promise.resolve(db.count) }));

const { refreshReviewCount, reviewCountNow: shown } = await import('./reviewCount');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the Needs attention count', () => {
  beforeEach(async () => {
    scan.set(null);
    db.count = 0;
    await refreshReviewCount();
  });

  it('follows the database outside a scan', async () => {
    db.count = 4;
    await refreshReviewCount();
    expect(shown()).toBe(4);
  });

  it('holds while a scan is still matching, and is read when matching ends', async () => {
    db.count = 2;
    await refreshReviewCount();

    scan.set('parsing');
    scan.set('matching');
    db.count = 40; // refusals arriving one by one
    await refreshReviewCount();
    expect(shown()).toBe(2);

    db.count = 7;
    scan.set('details'); // matching is over; the rest of the scan goes on
    await settle();
    expect(shown()).toBe(7);
  });

  it('is read again when a scan fails part-way through matching', async () => {
    scan.set('matching');
    db.count = 3;
    scan.set(null);
    await settle();
    expect(shown()).toBe(3);
  });
});
