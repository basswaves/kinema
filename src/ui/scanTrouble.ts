/**
 * Home's quiet line about the startup scan's problems.
 *
 * The scan's `errors` hold every kind of problem — an unreachable folder, a
 * rejected TMDB key, a failed artwork download — and the line used to end
 * every one of them with a sentence about a folder being away. Under a TMDB
 * error that was simply false. Only a folder that could not be reached gets a
 * word about what that means, and it is put first so "and 2 more" never hides
 * it behind a lesser problem.
 */

/**
 * What `scan_root` in scanner.rs reports for a folder that is not there — or
 * is there but empty where it used to hold films, the way an unmounted share
 * looks on Linux. Both are left as they were.
 */
const UNREACHABLE = /^root unavailable, skipped: (.+)$/;

export interface ScanTrouble {
  /** The first problem, plus how many more there were. */
  text: string;
  /** What an unreachable folder means for the library; null for anything else. */
  note: string | null;
}

export function scanTrouble(errors: string[]): ScanTrouble | null {
  if (errors.length === 0) return null;
  const folders = errors.flatMap((e) => UNREACHABLE.exec(e)?.[1] ?? []);
  const others = errors.filter((e) => !UNREACHABLE.test(e));
  const lines = [...folders.map((path) => `Could not reach ${path}`), ...others];
  const text = lines.length === 1 ? lines[0] : `${lines[0]} · and ${lines.length - 1} more`;
  // The scanner leaves a missing folder's files as they were, so they stay on
  // the shelves; what does not work is playing them (scanner.rs,
  // an_unreachable_folder_hides_nothing, an_empty_folder_that_had_files_hides_nothing).
  const note =
    folders.length === 0
      ? null
      : folders.length === 1
        ? 'Anything in that folder can’t be played until it is back.'
        : 'Anything in those folders can’t be played until they are back.';
  return { text, note };
}
