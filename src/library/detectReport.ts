/**
 * The lines Settings shows under "Last scan" about intro and credits
 * detection.
 *
 * One report step per TV folder per source, so a library of three TV folders
 * with nothing new said "Markers: skipped — no new episodes since its last
 * run" three times, in words that did not say what the markers were for.
 * Nothing new anywhere is one line now. Anything else is still said, per
 * folder, because "Skiptro is not where it was" is the reason this report is
 * shown at all.
 */
import type { AutoStep } from './api';

export const NOTHING_NEW = 'Intro and credits detection: nothing new to look at.';

/** The folder's own name, which is how people tell their folders apart. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function sentence(note: string): string {
  return /[.!?]$/.test(note) ? note : `${note}.`;
}

export function detectLines(steps: AutoStep[]): string[] {
  const told = steps.filter((s) => s.step !== 'current');
  if (told.length === 0) return steps.length > 0 ? [NOTHING_NEW] : [];

  // Name the folder whenever the report covered more than one, even if only
  // one of them has anything to say: "which one?" is the first question.
  const folders = new Set(steps.map((s) => s.root_path));
  const lines = told.map((s) =>
    folders.size > 1 && s.root_path
      ? `Intro and credits detection in ${folderName(s.root_path)}: ${sentence(s.note)}`
      : `Intro and credits detection: ${sentence(s.note)}`
  );
  return [...new Set(lines)];
}
