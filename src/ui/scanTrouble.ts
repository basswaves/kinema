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

/**
 * What `mark_missing` in scanner.rs says when part of a folder goes. The first
 * is known to be unknown, the other two cannot be told from someone deleting
 * things, so nothing here says deleted. The system's own words come in the
 * person's language, so they sit beside a sentence of ours.
 */
const UNREAD = /^could not read: (.+) :: (.*)$/s;
const EMPTIED = /^folder now empty: (\d+) :: (.+)$/;
const GONE = /^videos gone: (\d+) :: (.+)$/;
const UNREAD_NOTE = 'Nothing in it was hidden. Kinema tries again at the next scan.';
const EMPTIED_NOTE =
  'They stay in your library. If a disk belongs there, connect it. If you emptied it yourself, delete the folder.';
const GONE_NOTE =
  'They are hidden until they are back. A disk that was only disconnected brings them back by itself.';

/**
 * Wikidata still busy after waiting (wikidata.ts), once per film it held up:
 * one plain line for all of them, never Wikimedia's own sentence.
 */
const BUSY = /Wikimedia is busy/;
const BUSY_LINE = 'Wikipedia was busy, so some films wait to be matched until the next scan';

/**
 * The scan's last stages (pipeline.ts runProbe, runAutoDetect, runMeasure)
 * work on what is already in the library: one failing costs some badges or a
 * Skip button, never a film. It used to be said as the database's own words
 * ("measuring pictures: Invalid column type Null …", owner 2026-11-01), on
 * every tab. Now one plain line each, on Home only; the raw words stay in
 * app.log (Browse's "startup scan problems").
 */
const BACKGROUND: [RegExp, string][] = [
  [/^reading files: /, 'Kinema could not read the details of some files this time'],
  [/^intro detection: /, 'Kinema could not look for intros this time'],
  [/^measuring pictures: /, 'Kinema could not measure the pictures’ shape this time'],
];
const BACKGROUND_NOTE = 'Your library is fine; it tries again on the next scan.';

export interface ScanTrouble {
  /** The first problem, plus how many more there were. */
  text: string;
  /** What an unreachable folder means for the library; null for anything else. */
  note: string | null;
  /** Only background stages failed: said once on Home, not on every tab. */
  homeOnly?: true;
}

/**
 * `waiting` is whether anything is still left to match. The line about
 * Wikipedia is only true while something is: matched later — by hand, or
 * with a TMDB key added since — it went on saying films were waiting, on
 * Home, until the next start (owner, 2026-10-09).
 */
/** The library folders a scan could not reach: Settings offers "It moved…" on them. */
export function unreachableFolders(errors: string[]): string[] {
  return errors.flatMap((e) => UNREACHABLE.exec(e)?.[1] ?? []);
}

export function scanTrouble(errors: string[], waiting = true): ScanTrouble | null {
  const folders = errors.flatMap((e) => UNREACHABLE.exec(e)?.[1] ?? []);
  const lineFor = (pattern: RegExp, line: (first: string, second: string) => string) =>
    errors.flatMap((e) => {
      const found = pattern.exec(e);
      return found ? [line(found[1], found[2])] : [];
    });
  const unread = lineFor(UNREAD, (path, why) => `Could not read ${path} (${why})`);
  const emptied = lineFor(EMPTIED, (n, path) => `${path} is empty where it held ${n} videos`);
  const gone = lineFor(GONE, (n, path) => `${n} videos can no longer be found in ${path}`);
  const busy = waiting && errors.some((e) => BUSY.test(e)) ? [BUSY_LINE] : [];
  const backgroundOf = (e: string) => BACKGROUND.find(([raw]) => raw.test(e))?.[1];
  const background = [...new Set(errors.flatMap((e) => backgroundOf(e) ?? []))];
  const others = errors.filter(
    (e) =>
      ![UNREACHABLE, UNREAD, EMPTIED, GONE, BUSY].some((pattern) => pattern.test(e)) &&
      !backgroundOf(e)
  );
  const lines = [
    ...folders.map((path) => `Could not reach ${path}`),
    ...unread,
    ...emptied,
    ...gone,
    ...busy,
    ...others,
    ...background,
  ];
  if (lines.length === 0) return null;
  const text = lines.length === 1 ? lines[0] : `${lines[0]} · and ${lines.length - 1} more`;
  // The scanner leaves a missing folder's files as they were, so they stay on
  // the shelves; what does not work is playing them (scanner.rs,
  // an_unreachable_folder_hides_nothing, an_empty_folder_that_had_files_hides_nothing).
  const partNote = unread.length ? UNREAD_NOTE : emptied.length ? EMPTIED_NOTE : gone.length ? GONE_NOTE : null;
  const note =
    folders.length === 0
      ? (partNote ?? (background.length === lines.length ? BACKGROUND_NOTE : null))
      : folders.length === 1
        ? 'Anything in that folder can’t be played until it is back.'
        : 'Anything in those folders can’t be played until they are back.';
  return background.length === lines.length ? { text, note, homeOnly: true } : { text, note };
}
