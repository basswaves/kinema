/**
 * The frontend half of the playback self-test — see `src-tauri/src/selftest.rs`.
 *
 * Dormant unless the app was started with `KINEMA_SELFTEST` pointing at a
 * plan. Then Browse opens the player on the plan's file instead of Home, skips
 * the startup scan, and this module follows the plan's script and records
 * what the player did, with timestamps:
 *
 *  - every mpv event that matters for starting and ending a file,
 *  - every change in what is on screen: the Skip button, Up next, an error,
 *    the clock,
 *  - the position mpv reports at the end.
 *
 * It observes from the outside — the DOM and the mpv event stream — rather
 * than reaching into the player, so what it reports is what a viewer would
 * have seen, and it keeps working whatever the player looks like inside.
 */
import { invoke } from '@tauri-apps/api/core';
import { command, getProperty, listenEvents } from 'tauri-plugin-libmpv-api';
import { ensureMpvInitialised } from './player/mpv';
import { readTracks } from './player/tracks';
import { readChapters } from './player/chapters';
import { scanLibrary } from './library/api';
import {
  ignoreFileIds,
  recordMatch,
  recordProviderFailure,
  recordRefusal,
  returnToReview,
  unlinkFiles,
} from './metadata/api';

/**
 * The webview's own wrappers for the file lifecycle, callable from a plan —
 * so a test proves the real argument names reach the real commands, which no
 * mock can. Read the copied library afterwards to check what they did.
 */
const CALLABLE: Record<string, (...args: never[]) => Promise<unknown>> = {
  ignoreFileIds,
  recordMatch,
  recordProviderFailure,
  recordRefusal,
  returnToReview,
  unlinkFiles,
};

export interface SelfTestAction {
  /** Seconds after the test started. */
  at: number;
  /**
   * `key` presses a key on the window, `seek` jumps, `mark` just notes the
   * time. `detect` starts Detect on the library folder `root` and records how
   * it ended — for checking that a second one is refused, and that quitting
   * mid-run ends what it started. Point the copied library's Skiptro setting
   * at something harmless first: this runs whatever is configured there.
   */
  do: 'key' | 'seek' | 'mark' | 'detect' | 'call';
  key?: string;
  to?: number;
  root?: string;
  /** For `call`: one of the lifecycle wrappers in `CALLABLE`, and its arguments. */
  fn?: string;
  args?: unknown[];
  note?: string;
}

export interface SelfTestPlan {
  path: string;
  fileId: number | null;
  titleId: number | null;
  label?: string;
  /** How long to run before writing the report and quitting. */
  seconds: number;
  /** Defaults to true: a test run should not play sound through the speakers. */
  mute?: boolean;
  /**
   * Start a library scan at the same moment as playback, and record when it
   * finishes. Proves playback does not wait behind a scan. The scan writes
   * only to the copied library, and walks the media folders read-only.
   */
  scan?: boolean;
  /**
   * Seconds to stay on Home before opening the player. Zero (the default)
   * opens it at once — which conflates the app starting with a video
   * starting. A few seconds measures what a viewer does: press Play on a Home
   * that is already up.
   */
  openAfter?: number;
  actions?: SelfTestAction[];
}

interface Entry {
  /** Seconds since the test started. */
  t: number;
  kind: string;
  detail?: unknown;
}

let planPromise: Promise<SelfTestPlan | null> | null = null;

/** The plan, or null outside self-test mode. Asked once and remembered. */
export function selfTestPlan(): Promise<SelfTestPlan | null> {
  planPromise ??= invoke<SelfTestPlan | null>('selftest_plan').catch((e) => {
    console.warn('selftest: could not read the plan', e);
    return null;
  });
  return planPromise;
}

/** What is on screen that the test cares about, as one comparable value. */
function screen(): Record<string, string | null> {
  const text = (selector: string) =>
    document.querySelector(selector)?.textContent?.trim() ?? null;
  return {
    skip: text('.skip-button'),
    upNext: text('.up-next'),
    error: text('.player-error'),
    label: text('.player-label'),
  };
}

/** Carry out the plan, then hand the report to Rust, which writes it and quits. */
export async function runSelfTest(plan: SelfTestPlan): Promise<void> {
  const started = performance.now();
  const now = () => Math.round((performance.now() - started) / 10) / 100;
  const timeline: Entry[] = [];
  const note = (kind: string, detail?: unknown) => timeline.push({ t: now(), kind, detail });

  note('start', { path: plan.path, openAfter: plan.openAfter ?? 0 });

  const unlisten = await listenEvents((event) => {
    const e = event as { event: string; name?: string; data?: unknown; reason?: string };
    if (e.event === 'property-change') {
      if (e.name === 'eof-reached' && e.data === true) note('mpv:eof-reached');
      return;
    }
    if (['start-file', 'file-loaded', 'playback-restart', 'end-file', 'idle'].includes(e.event)) {
      note(`mpv:${e.event}`, e.reason ? { reason: e.reason } : undefined);
    }
  });

  if (plan.scan) {
    note('scan:start');
    void scanLibrary()
      .then((report) =>
        note('scan:done', { ms: report.duration_ms, files: report.files_seen, errors: report.errors.length })
      )
      .catch((e) => note('scan:failed', String(e)));
  }

  if (plan.mute !== false) {
    void ensureMpvInitialised()
      .then(() => command('set', ['mute', 'yes']))
      .then(() => note('muted'))
      .catch((e) => note('mute-failed', String(e)));
  }

  // On-screen changes, sampled. Only changes are recorded; the clock at most
  // once a second so the report stays readable.
  let last = '';
  let lastClock = -1;
  const sampler = window.setInterval(() => {
    const current = screen();
    const serialised = JSON.stringify(current);
    if (serialised !== last) {
      last = serialised;
      note('screen', current);
    }
    const second = Math.floor(now());
    if (second !== lastClock) {
      lastClock = second;
      const clock = [...document.querySelectorAll('.player-time')].map((el) => el.textContent);
      if (clock.length) note('clock', clock.join(' / '));
    }
  }, 100);

  const timers = (plan.actions ?? []).map((action) =>
    window.setTimeout(() => {
      note(`action:${action.do}`, action);
      if (action.do === 'key' && action.key) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true }));
      } else if (action.do === 'seek' && action.to !== undefined) {
        void command('seek', [action.to, 'absolute']).catch((e) => note('seek-failed', String(e)));
      } else if (action.do === 'call' && action.fn) {
        const target = CALLABLE[action.fn];
        if (!target) note('call:unknown', action.fn);
        else
          (target as (...args: unknown[]) => Promise<unknown>)(...(action.args ?? [])).then(
            (result) => note('call:done', { fn: action.fn, result }),
            (e) => note('call:failed', { fn: action.fn, error: String(e) })
          );
      } else if (action.do === 'detect' && action.root) {
        invoke('detect_intros', { rootPath: action.root }).then(
          (report) => note('detect:done', report),
          (e) => note('detect:refused', String(e))
        );
      }
    }, action.at * 1000)
  );

  await new Promise((resolve) => window.setTimeout(resolve, plan.seconds * 1000));

  window.clearInterval(sampler);
  timers.forEach((id) => window.clearTimeout(id));
  unlisten();

  const read = async (name: string) => {
    try {
      return await getProperty(name, 'double');
    } catch {
      return null;
    }
  };
  const report = {
    plan,
    finishedAfter: now(),
    final: { timePos: await read('time-pos'), duration: await read('duration') },
    // What the player itself reads, through the same code — so a report shows
    // the tracks and chapters a viewer would have been offered.
    tracks: await readTracks().catch((e) => String(e)),
    chapters: await readChapters().catch((e) => String(e)),
    timeline,
  };

  await invoke('selftest_finish', { report });
}
