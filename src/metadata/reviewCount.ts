/**
 * How many videos wait in Needs attention — one number for the whole app.
 *
 * The top bar's badge, Home's notice and Settings' Review button each used to
 * read the count for themselves, at their own moments. Fixing a match in
 * Settings brought its button down and left the badge above it where it was
 * until another tab was opened. Now there is one copy, and every place that
 * shows it follows it.
 *
 * **Held while a scan is still deciding.** From the walk of the folders until
 * the matcher has been through every new file, the number stays what it was
 * before the scan began; it is read again the moment matching ends. A
 * refusal is only worth a person's attention once the machine has finished
 * trying — a big folder added at once used to show its refusals arriving one
 * by one, and the count rising and falling with them.
 */
import { useSyncExternalStore } from 'react';
import { countNeedsReview } from './api';
import { getScanStatus, subscribeScan, type ScanStage } from '../library/pipeline';

/** The stages before matching has finished. */
const DECIDING: ReadonlySet<ScanStage> = new Set(['scanning', 'parsing', 'matching']);

let shown = 0;
const listeners = new Set<() => void>();

function deciding(): boolean {
  const status = getScanStatus();
  return status !== null && DECIDING.has(status.stage);
}

/**
 * Read the count again and tell everything showing it. Does nothing while a
 * scan is deciding; the end of matching reads it then. Throws what the read
 * throws, for the caller to log.
 */
export async function refreshReviewCount(): Promise<void> {
  if (deciding()) return;
  const n = await countNeedsReview();
  // A scan may have started while the answer was on its way.
  if (deciding() || n === shown) return;
  shown = n;
  for (const listener of listeners) listener();
}

let wasDeciding = false;
subscribeScan(() => {
  const now = deciding();
  if (wasDeciding && !now) {
    void refreshReviewCount().catch((e) => console.warn('review count:', e));
  }
  wasDeciding = now;
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The count as last read outside a scan's matching. */
export function reviewCountNow(): number {
  return shown;
}

/** The same, for a component, which is drawn again when it changes. */
export function useReviewCount(): number {
  return useSyncExternalStore(subscribe, reviewCountNow);
}
