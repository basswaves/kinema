/**
 * The library scan pipeline: scan → parse → match → artwork → details → detect.
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
import { listen } from '@tauri-apps/api/event';
import {
  autoDetect,
  libraryStats,
  listLibraryRoots,
  listUnparsed,
  saveParseResults,
  scanLibrary,
  type AutoStep,
  type DetectProgress,
  type LibraryKind,
  type LibraryRoot,
  type MediaFile,
  type ParseResultPayload,
} from './api';
import { clearParseError, initParser, lastParseError, parseMediaFile, toPayload } from './parse';
import { cacheArtwork, listUnmatched } from '../metadata/api';
import { backfillTitleDetails, loadProviderKeys, matchFiles } from '../metadata/match';

/** Batched so a large library reports progress and never builds one huge IPC payload. */
const PARSE_BATCH = 500;

export type ScanStage = 'scanning' | 'parsing' | 'matching' | 'artwork' | 'details' | 'detecting';

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
  /** Titles that gained a trailer key, logo or cast on this pass. */
  detailsFilled: number;
  /**
   * What the automatic intro/credits pass did, or declined to do.
   *
   * Kept separate from `errors` on purpose: "Skiptro is not installed" and
   * "3 episode(s) are waiting because you turned this off" are both things
   * worth saying and neither is a problem with the scan.
   */
  detectNotes: AutoStep[];
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

/** The library folder a file was found under; the longest match wins. */
function rootForPath(roots: LibraryRoot[], path: string): LibraryRoot | null {
  let best: LibraryRoot | null = null;
  for (const root of roots) {
    if (path.startsWith(root.path) && (!best || root.path.length > best.path.length)) {
      best = root;
    }
  }
  return best;
}

/**
 * Parse one file as the library it lives in: that library's kind decides
 * movie-or-episode, and its folder bounds how far up a title may be looked
 * for. Shared by the scan and the developer tools so the two cannot differ.
 */
export function parseForLibrary(file: MediaFile, roots: LibraryRoot[]): ParseResultPayload {
  const root = rootForPath(roots, file.path);
  const kind: LibraryKind = root?.kind ?? 'movies';
  return toPayload(file, parseMediaFile(file, kind, root?.path));
}

/**
 * The detection stage: Skiptro, then this app's own analysis.
 *
 * Minutes of subprocess work, so its output is streamed into the scan status —
 * the nav bar is the only thing on screen during a startup scan, and "detecting"
 * with nothing after it for four minutes looks exactly like a hang.
 *
 * Never throws. A failure here means some episodes have no markers yet, which
 * is the state the library was already in a moment ago; letting it fail the
 * whole scan would turn a missing Skip button into a missing library.
 */
async function runAutoDetect(errors: string[]): Promise<AutoStep[]> {
  setStatus({ stage: 'detecting', detail: '' });

  const off = listen<DetectProgress>('skiptro-progress', (event) =>
    setStatus({ stage: 'detecting', detail: event.payload.line })
  );

  try {
    return (await autoDetect()).steps;
  } catch (e) {
    errors.push(`intro detection: ${String(e)}`);
    return [];
  } finally {
    void off.then((stop) => stop());
  }
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
    // guessit-js is fetched here rather than at startup — it is only needed for
    // this stage, and it is the largest thing in the bundle.
    await initParser();
    for (;;) {
      const batch = await listUnparsed(PARSE_BATCH);
      if (batch.length === 0) break;
      await saveParseResults(
        batch.map((file) => parseForLibrary(file, roots))
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

    // Details before artwork. The details pass is what finds logos and cast
    // photos for titles matched before those were stored, and it used to run
    // *after* the artwork download — so everything it found waited for the
    // next launch to be cached, and the UI fetched it from TMDB meanwhile.
    setStatus({ stage: 'details', detail: '' });
    const details = await backfillTitleDetails();
    errors.push(...details.errors);

    // After matching and details: every artwork URL is known now, and
    // browsing should not need the network afterwards.
    setStatus({ stage: 'artwork', detail: '' });
    const art = await cacheArtwork();
    if (art.failed > 0) errors.push(`${art.failed} artwork download(s) failed`);

    // Last, and deliberately part of the same sequence rather than something the
    // user has to go and press afterwards. Everything before this decides *what*
    // is in the library; this decides whether the Skip button will be there when
    // one of the new episodes is played. It works out for itself whether there
    // is anything to do, so calling it unconditionally costs two queries.
    const detectNotes = await runAutoDetect(errors);

    lastSummary = {
      filesAdded: report.files_added,
      filesParsed,
      matched,
      unmatched,
      artworkStored: art.stored,
      detailsFilled: details.found,
      detectNotes,
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
