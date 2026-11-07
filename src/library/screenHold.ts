/**
 * Android: the screen stays on while a library's first scan runs.
 *
 * A scan waits when Kinema leaves the screen (`playback.ts`), and a screen going
 * off at its timeout counts as leaving. So someone who started a first scan and
 * walked away came back to a library that had stopped soon after they left. A
 * first scan is the one case where that matters: there is nothing to watch yet.
 *
 * What asks for this is Android's own "keep this window's screen on", which only
 * counts while the window is on the screen, so leaving Kinema lets go at once.
 * Asked for a lease and renewed as the work moves on: a step that hangs, or a page
 * that dies, stops renewing, and the TV goes to sleep as usual. A film has the
 * way while it is open, and no work moves on behind it, so it lets go too.
 *
 * A desktop never hears of this. Later scans keep the rule as it was.
 */
import { invoke } from '@tauri-apps/api/core';
import { capabilitiesNow, loadCapabilities } from '../capabilities';
import { getSetting, setSetting } from '../metadata/api';
import { libraryStats } from './api';
import { isPlaybackActive, onLibraryTurn } from './playback';

/** How long the screen stays held with no sign of the work moving on. */
export const LEASE_MS = 30 * 60_000;
/** At most this often is the lease renewed. */
export const RENEW_MS = 60_000;
/**
 * Says a first scan began and has not ended, so one cut short (Kinema closed, the
 * system took it) is still a first scan when the next start carries it on, with
 * files in the library by then.
 */
export const FIRST_SCAN_KEY = 'first_scan';
const RUNNING = 'running';

let wanted = false;
let held = false;
let askedAt = 0;

function tell(on: boolean): void {
  held = on;
  askedAt = Date.now();
  try {
    void Promise.resolve(
      invoke('plugin:media3|hold_screen', { on, forMs: on ? LEASE_MS : 0 })
    ).catch((e: unknown) => console.warn('screen hold:', e));
  } catch (e) {
    console.warn('screen hold:', e);
  }
}

function settle(): void {
  const want = wanted && !isPlaybackActive();
  if (want !== held) tell(want);
  else if (want && Date.now() - askedAt >= RENEW_MS) tell(true);
}

onLibraryTurn(settle);

/** The scan has moved on, as far as this can tell. */
export function scanMovedOn(): void {
  settle();
}

/**
 * Call as a scan starts, before it adds anything. Anything unreadable means no
 * hold: the scan goes on by the old rule, which is safe and is told on return.
 */
export async function holdScreenIfFirstScan(): Promise<void> {
  try {
    await loadCapabilities();
    if (capabilitiesNow()?.engine !== 'media3') return;
    const first =
      (await libraryStats()).total === 0 || (await getSetting(FIRST_SCAN_KEY)) === RUNNING;
    if (!first) return;
    await setSetting(FIRST_SCAN_KEY, RUNNING);
    wanted = true;
    settle();
  } catch (e) {
    console.warn('screen hold: could not tell whether this is a first scan:', e);
  }
}

/** The first scan got to its end. A failed one is still to be finished. */
export async function firstScanFinished(): Promise<void> {
  if (!wanted) return;
  await setSetting(FIRST_SCAN_KEY, '').catch((e: unknown) => console.warn('screen hold:', e));
}

/** The scan is over, however it ended. */
export function letScreenGo(): void {
  wanted = false;
  settle();
}
