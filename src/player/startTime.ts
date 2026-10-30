/**
 * Play → first picture (JELLYBEAM.md B): how long the open file took from
 * being asked for to its first frame on screen, as the engine reported it.
 * Measured in the session (session.ts), logged once per file, and shown in
 * the details panel — and only what was measured: a file whose cover came
 * off by timeout says so rather than a number.
 */
import type { StatRow } from './stats';

let last: { ms: number | null; shown: boolean } = { ms: null, shown: false };

/** What the session knows now; the log line once a figure arrives. */
export function noteStart(ms: number | null, shown: boolean, path: string): void {
  if (ms !== null && last.ms !== ms) {
    const name = path.split(/[\\/]/).pop() ?? path;
    console.info(`player: first picture ${ms} ms after opening ${name}`);
  }
  last = { ms, shown };
}

/** "0.42 s" from milliseconds. */
export function startWords(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms / 1000)} s`;
}

/** The details panel's row. */
export function startRow(): StatRow {
  if (last.ms !== null) {
    return {
      label: 'Start',
      value: `${startWords(last.ms)} to the first picture`,
      note: 'measured from opening the file to the engine reporting its first frame',
    };
  }
  return {
    label: 'Start',
    value: last.shown ? 'not measured' : 'waiting for the first picture',
    note: last.shown ? 'the engine did not report its first frame in time' : undefined,
  };
}
