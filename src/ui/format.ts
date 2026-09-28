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

/**
 * "22:40" — the wall-clock time this will finish at normal speed, in the
 * system's own clock format. Null until there is a position and a length.
 */
export function endsAtLabel(position: number | null, length: number | null, now: number): string | null {
  if (position === null || !length || length <= 0) return null;
  const end = new Date(now + Math.max(0, length - position) * 1000);
  return end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A position or length as a player shows it: `4:07`, `1:02:14`. */
export function formatTime(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return '--:--';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
