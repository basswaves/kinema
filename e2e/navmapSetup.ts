/**
 * Global setup for the navigation checker (playwright.nav.config.ts).
 *
 * Each system's walk is split into parts that run side by side and share out
 * the screens between them as they go: the part that gets to a screen first
 * claims it with a file in navmap-results/parts/ (see `claim` in
 * navmap.nav.ts), and writes what it walked there too. Those files belong to
 * one run, so they are removed before every run; the merged
 * `<engine>.<system>.json` beside them is kept, as before.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

export const PARTS_DIR = join(process.cwd(), 'navmap-results', 'parts');

export default function setup(): void {
  rmSync(PARTS_DIR, { recursive: true, force: true });
}
