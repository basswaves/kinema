/**
 * The library scan pipeline: scan → parse → match → artwork → trailers.
 *
 * One sequence with two callers — the automatic scan at startup and the manual
 * "Scan now" button — because two copies of an ordering this fiddly would drift,
 * and the drift would show up as "the automatic scan doesn't find what the
 * button finds", which is a miserable thing to debug.
 *
 * Each stage stays independently runnable underneath (see the developer tools
 * in Settings). That is deliberate: re-matching after changing an API key or a
 * scoring rule should not mean re-walking a NAS, and re-parsing should not mean
 * re-scanning. This module is the *usual* path, not the only one.
 *
 * Progress is published through a small store rather than returned, because two
 * unrelated places need it — the nav bar, which shows that something is
 * happening, and the settings screen, which shows what.
 */
import { useSyncExternalStore } from 'react';
import {
  libraryStats,
  listLibraryRoots,
  listUnparsed,
  saveParseResults,
  scanLibrary,
  type LibraryKind,
  type LibraryRoot,
} from './api';
import { clearParseError, lastParseError, parseMediaFile, toPayload } from './parse';
import { cacheArtwork, listUnmatched } from '../metadata/api';
import { backfillTrailers, loadProviderKeys, matchFiles } from '../metadata/match';

/** Batched so a large library reports progress and never builds one huge IPC payload. */
const PARSE_BATCH = 500;

export type ScanStage = 'scanning' | 'parsing' | 'matching' | 'artwork' | 'trailers';

export interface ScanStatus {
  stage: ScanStage;
  /** What it is working on right now — a count, or the title being matched. */
  detail: string;
}

export interface ScanSummary {
  filesAdded: number;
  filesParsed: number;
  matched: number;
  unmatched: number;
  artworkStored: number;
  trailersFound: number;
  /** Non-fatal problems: an unreachable root, a provider error on one title. */
  errors: string[];
  /** The parser throwing is its own category — it means every file failed. */
  parseError: string | null;
  finishedAt: number;
}

export type ScanOutcome =
  | { status: 'done'; summary: ScanSummary }
  | { status: 'skipped'; reason: 'no-roots' | 'already-running' }
  | { status: 'failed'; error: string };

let status: ScanStatus | null = null;
let lastSummary: ScanSummary | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setStatus(next: ScanStatus | null): void {
  status = next;
  emit();
}

export function subscribeScan(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getScanStatus(): ScanStatus | null {
  return status;
}

export function getLastScanSummary(): ScanSummary | null {
  return lastSummary;
}

/** Live scan status, or null when idle. */
export function useScanStatus(): ScanStatus | null {
  return useSyncExternalStore(subscribeScan, getScanStatus);
}

/** Longest matching root wins, so nested roots resolve predictably. */
function kindForPath(roots: LibraryRoot[], path: string): LibraryKind {
  let best: LibraryRoot | null = null;
  for (const root of roots) {
    if (path.startsWith(root.path) && (!best || root.path.length > best.path.length)) {
      best = root;
    }
  }
  return best?.kind ?? 'movies';
}

/**
 * Run the whole pipeline.
 *
 * Refuses to start a second run rather than queueing one: both callers mean
 * "make the library current", and two concurrent walks of the same NAS would
 * only fight over the same rows.
 */
export async function runScanPipeline(): Promise<ScanOutcome> {
  if (status !== null) return { status: 'skipped', reason: 'already-running' };

  let roots: LibraryRoot[];
  try {
    roots = await listLibraryRoots();
  } catch (e) {
    return { status: 'failed', error: String(e) };
  }
  // Nothing to scan is not a failure — it is a library nobody has pointed at a
  // folder yet, which the settings screen says far better than an error would.
  if (roots.length === 0) return { status: 'skipped', reason: 'no-roots' };

  const errors: string[] = [];
  let filesParsed = 0;
  // Only these two are conditional — nothing to match means they stay at zero.
  let matched = 0;
  let unmatched = 0;

  try {
    setStatus({ stage: 'scanning', detail: `${roots.length} folder(s)` });
    const report = await scanLibrary();
    errors.push(...report.errors);

    setStatus({ stage: 'parsing', detail: '' });
    clearParseError();
    for (;;) {
      const batch = await listUnparsed(PARSE_BATCH);
      if (batch.length === 0) break;
      await saveParseResults(
        batch.map((file) => toPayload(file, parseMediaFile(file, kindForPath(roots, file.path))))
      );
      filesParsed += batch.length;
      setStatus({ stage: 'parsing', detail: `${filesParsed} file(s)` });
      if (batch.length < PARSE_BATCH) break;
    }

    const pending = await listUnmatched(2000);
    if (pending.length > 0) {
      setStatus({ stage: 'matching', detail: '' });
      // Keys come from the database at the moment they are needed, never from
      // component state — see loadProviderKeys.
      const outcome = await matchFiles(pending, await loadProviderKeys(), (progress) =>
        setStatus({
          stage: 'matching',
          detail: `${progress.groupsDone}/${progress.groupsTotal} · ${progress.currentTitle}`,
        })
      );
      matched = outcome.matched;
      unmatched = outcome.unmatched;
      errors.push(...outcome.errors);
    }

    // Straight after matching: that is the moment the artwork URLs become
    // known, and browsing should not need the network afterwards.
    setStatus({ stage: 'artwork', detail: '' });
    const art = await cacheArtwork();
    if (art.failed > 0) errors.push(`${art.failed} artwork download(s) failed`);

    setStatus({ stage: 'trailers', detail: '' });
    const trailers = await backfillTrailers();
    errors.push(...trailers.errors);

    lastSummary = {
      filesAdded: report.files_added,
      filesParsed,
      matched,
      unmatched,
      artworkStored: art.stored,
      trailersFound: trailers.found,
      errors,
      parseError: lastParseError,
      finishedAt: Date.now(),
    };
    return { status: 'done', summary: lastSummary };
  } catch (e) {
    return { status: 'failed', error: String(e) };
  } finally {
    setStatus(null);
  }
}

/** Whether there is anything worth scanning — used to explain an empty library. */
export async function hasRoots(): Promise<boolean> {
  try {
    return (await listLibraryRoots()).length > 0;
  } catch {
    return false;
  }
}

/** How many files are on disk but not yet matched, for the settings screen. */
export async function pendingCounts(): Promise<{ total: number; unparsed: number }> {
  const stats = await libraryStats();
  return { total: stats.total, unparsed: stats.unparsed };
}
