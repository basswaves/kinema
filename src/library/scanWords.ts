import type { ScanStage, ScanStatus } from './pipeline';

/**
 * What a scan is doing, in plain words. The stage names in `pipeline.ts` are
 * the code's own ("parsing", "matching"); these are what the screen says.
 */
const STAGE_WORDS: Record<ScanStage, string> = {
  scanning: 'Looking for files',
  parsing: 'Reading file names',
  matching: 'Finding the titles',
  details: 'Getting details',
  artwork: 'Getting pictures',
  examining: 'Looking inside the files',
  detecting: 'Finding intros and credits',
  measuring: 'Measuring each picture',
  rereading: 'Reading matched names again',
};

/** Said for a moment on coming back to a scan that waited (`ScanStatus.waited`). */
const PICKED_UP = 'Picked up after a pause';

/** For the top bar: the stage, and that it waited if it has just done so. */
export function scanBarWords(scan: ScanStatus): string {
  return scan.waited ? `${PICKED_UP} · ${scanStageWords(scan.stage)}` : scanStageWords(scan.stage);
}

/** The stage alone, for a button: "Finding the titles…". */
export function scanStageWords(stage: ScanStage): string {
  return `${STAGE_WORDS[stage]}…`;
}

/** The stage with its progress: "Finding the titles · 348 of 397 · <title>". */
export function scanWords(scan: ScanStatus): string {
  const detail = scan.detail.replace(/^(\d+)\/(\d+)/, '$1 of $2');
  const words = detail ? `${STAGE_WORDS[scan.stage]} · ${detail}` : `${STAGE_WORDS[scan.stage]}…`;
  return scan.waited ? `${PICKED_UP} · ${words}` : words;
}
