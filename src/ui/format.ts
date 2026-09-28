/** Display formatting shared between screens. */

/** A byte count as a person reads it: `0 B`, `812 KB`, `1.4 GB`. */
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * A count with its noun: `1 file`, `3 files`, `0 files`.
 *
 * Replaces the `file(s)` pattern, which reads as a form rather than a sentence.
 * The plural is passed in when it is not simply the noun plus `s`.
 */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}
