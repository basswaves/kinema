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
import {
  availableMonitors,
  getCurrentWindow,
  PhysicalPosition,
  primaryMonitor,
} from '@tauri-apps/api/window';
import {
  addSubtitle,
  chooseTrack,
  listenMpvEvents,
  mpvCommand,
  mpvGet,
  onPlaybackEvent,
  playerFacts,
  readChapters,
  readTracks,
  seekTo,
  setVolume,
  showSubtitles,
  startEngine,
} from './player/engine';
import { capabilitiesNow } from './capabilities';
import { countCallbacks, expandActions } from './selftestPlan';
import { setTvMode } from './ui/tv';
import { simklStatus, traktStatus } from './metadata/tracking';
import { findSubtitles } from './player/onlineSubtitles';
import {
  addLibraryRoot,
  listLibraryRoots,
  measurePictures,
  probeLibrary,
  refreshImdbRatings,
  scanLibrary,
} from './library/api';
import { fileFacts } from './ui/badges';
import { seasonFacts } from './ui/seasonBadges';
import { runScanPipeline } from './library/pipeline';
import { saveShareLogin } from './library/folders';
import { refreshTomatometer } from './metadata/scores';
import {
  cacheArtwork,
  ignoreFileIds,
  listUnmatched,
  recordMatch,
  recordProviderFailure,
  recordRefusal,
  returnToReview,
  setSetting,
  unlinkFiles,
} from './metadata/api';
import {
  backfillTitleDetails,
  loadProviderKeys,
  matchFiles,
  refreshStaleTitles,
  upgradeWikidataFilms,
} from './metadata/match';

/**
 * The webview's own wrappers for the file lifecycle, callable from a plan —
 * so a test proves the real argument names reach the real commands, which no
 * mock can. Read the copied library afterwards to check what they did.
 */
/**
 * What this webview and process hold right now, for a leak run: sampled
 * again and again, a number that only climbs is something not let go.
 * Whatever a platform cannot answer is null, never zero.
 */
function tauriCallbacks(): number {
  const map = (window as { __TAURI_INTERNALS__?: { callbacks?: Map<unknown, unknown> } })
    .__TAURI_INTERNALS__?.callbacks;
  return map instanceof Map ? map.size : countCallbacks(Object.getOwnPropertyNames(window));
}

const nextFrame = () => new Promise<number>((done) => requestAnimationFrame(done));

/**
 * How long a key press takes to show, as a person holding the remote feels
 * it: the press, then two frames (the one that handles it and the one that
 * draws it). Pressed `times` times, each after the last has shown.
 */
async function navTiming(key: string, times = 10) {
  const ms: number[] = [];
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    await nextFrame();
    await nextFrame();
    ms.push(Math.round(performance.now() - start));
  }
  const sorted = [...ms].sort((a, b) => a - b);
  return { key, ms, median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] };
}

/** How long the library's whole title list takes to come, and how big it is. */
async function homeTiming() {
  const start = performance.now();
  const titles = await invoke<unknown[]>('list_titles');
  const ms = Math.round(performance.now() - start);
  return { titles: titles.length, ms, kb: Math.round(JSON.stringify(titles).length / 1024) };
}

async function leakSample() {
  const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  return {
    jsHeapMb: heap === undefined ? null : Math.round(heap / 1048.576) / 1000,
    domNodes: document.getElementsByTagName('*').length,
    // Tauri's registered callbacks: one for each listener and channel, kept
    // until it is unregistered. Tauri 2 keeps them in a map of its own
    // (`__TAURI_INTERNALS__.callbacks`); older ones put `_123` on window.
    callbacks: tauriCallbacks(),
    process: await invoke('process_stats').catch((e) => ({ error: String(e) })),
    // Media3's own counts (the plugin's `perf`), where it is the engine.
    media3:
      capabilitiesNow()?.engine === 'media3'
        ? await playerFacts().then(
            (facts) => facts.perf ?? null,
            () => null
          )
        : null,
  };
}

/**
 * Browse's way of opening the plan's file — the same call `openAfter` makes —
 * for the `play` action. Set while Browse is up; the page owns the screens.
 */
let openPlanFile: (() => void) | null = null;
export function registerSelfTestPlay(open: (() => void) | null) {
  openPlanFile = open;
}

const CALLABLE: Record<string, (...args: never[]) => Promise<unknown>> = {
  // A library built from nothing: a folder added as Settings adds it, and a
  // whole scan — so a plan on an empty copy checks the library side end to end:
  // `runScanPipeline` is the app's own scan → parse → match → details →
  // ratings → artwork → read files → intro detection.
  addLibraryRoot,
  listLibraryRoots,
  // A network share Kinema opens itself, signed in to before it is added.
  saveShareLogin,
  scanLibrary,
  runScanPipeline,
  ignoreFileIds,
  recordMatch,
  recordProviderFailure,
  recordRefusal,
  returnToReview,
  unlinkFiles,
  // Settings the player reads when a file opens — sound, display — so a plan
  // can set them on the copied library before opening the player (`openAfter`).
  setSetting,
  // The scan's refresh of out-of-date TMDB data, and the artwork pass after it,
  // without the rest of a scan (which would also start intro detection).
  refreshStaleTitles,
  // The details pass: titles missing something TMDB has, fetched once more.
  backfillTitleDetails,
  // What SIMKL and Trakt look like from here — which, under a self-test, must
  // be "not available": a self-test never talks to either.
  simklStatus,
  traktStatus,
  // OpenSubtitles end to end on the copy: search, download, the file on disk.
  findSubtitles,
  cacheArtwork,
  upgradeWikidataFilms,
  // The scan's reading of files for the detail page's badges, on its own.
  probeLibrary,
  measurePictures,
  // What the detail page's badges are made from, for one file.
  fileFacts,
  // And for a whole season of a series.
  seasonFacts,
  // The scan's IMDb step: fetches IMDb's ratings file if it is due.
  refreshImdbRatings,
  // The scan's Rotten Tomatoes step, with whatever OMDb key the copy has.
  refreshTomatometer: () => refreshTomatometer(),
  // A scan's matching step on its own: whatever is waiting to be matched,
  // with whichever keys the copied library has.
  matchUnmatched: async () =>
    matchFiles(await listUnmatched(2000), await loadProviderKeys(), () => {}),
  // The engine's tracks, subtitles and volume in Kinema's terms (engine.ts),
  // whichever engine plays — so a plan can choose and read them back on a
  // device the way the track panel does.
  readTracks,
  chooseTrack,
  showSubtitles,
  addSubtitle,
  setVolume,
  // What the process and the page hold (see above); one sample, on demand.
  leakSample,
  // How a key press and the title list feel on this device (above).
  navTiming,
  homeTiming,
  // The share's own reading speed, apart from the player (procstats.rs).
  readRate: (path: string, mb: number, seeks: number) =>
    invoke('read_rate', { path, mb, seeks }),
  // Display switching only happens fullscreen, and Browse has no key for it.
  setFullscreen: (on: boolean) => getCurrentWindow().setFullscreen(on),
  // TV mode is read at launch, before a plan's first action; this switches it
  // the way the setting and Ctrl+Shift+T do — layout and fullscreen together.
  setTvMode: async (on: boolean) => setTvMode(on),
  // Put the window on another screen before going fullscreen — so a test can
  // switch a second monitor while the main one stays in use. -1 means the
  // first screen that is not the primary; otherwise an index into Windows'
  // own list.
  moveToScreen: async (index: number) => {
    const screens = await availableMonitors();
    const primary = await primaryMonitor();
    const screen =
      index === -1 ? screens.find((m) => m.name !== primary?.name) : screens[index];
    if (!screen) throw new Error(`no screen ${index}; there are ${screens.length}`);
    await getCurrentWindow().setPosition(
      new PhysicalPosition(screen.position.x + 50, screen.position.y + 50)
    );
    return screen.name;
  },
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
  do: 'key' | 'seek' | 'mark' | 'detect' | 'call' | 'mpv' | 'probe' | 'repeat' | 'play' | 'leak';
  key?: string;
  to?: number;
  root?: string;
  /** For `call`: one of the lifecycle wrappers in `CALLABLE`, and its arguments. */
  fn?: string;
  /**
   * For `call`, the wrapper's arguments. For `mpv`, an mpv command and its
   * arguments, e.g. `["set", "audio-device", "wasapi/{…}"]` then
   * `["ao-reload"]` — how an audio output that fails mid-file is staged.
   * For `probe`, the mpv properties to read as text at that moment; the
   * plan's own `probe` list is read when the run ends, after the player has
   * closed, which is too late for anything about the file that was playing.
   */
  args?: unknown[];
  note?: string;
  /**
   * `play` opens the plan's file on the real player screen, as `openAfter`
   * does — use it after Back (`key` Escape) has left the player. `leak`
   * records one sample of what the process holds (`leakSample`), as a
   * `leak` entry in the timeline, labelled with `note`.
   *
   * `repeat` runs `actions` `times` times, a round starting every `every`
   * seconds; inside, `at` counts from the round's start. For example, open,
   * watch, leave and sample, ten times:
   * `{"at":20,"do":"repeat","times":10,"every":30,"actions":[
   *    {"at":0,"do":"play"},{"at":15,"do":"key","key":"Escape"},
   *    {"at":20,"do":"leak"}]}`
   */
  times?: number;
  every?: number;
  actions?: SelfTestAction[];
  /** Set by the runner on an action that came from a `repeat`: its round, from 0. */
  round?: number;
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
  /** Take a leak sample every this many seconds, from the start to the end. */
  leakEvery?: number;
  actions?: SelfTestAction[];
  /**
   * mpv options set once mpv is up, before the file's first frame is likely
   * to be drawn — for standing in for hardware this machine does not have.
   * `{ "target-trc": "pq", "target-prim": "bt.2020" }` makes mpv render as if
   * for an HDR10 screen, which is how the HDR path is checked on an SDR one.
   */
  mpv?: Record<string, string>;
  /**
   * mpv properties to read, as text, when the run ends — what mpv actually
   * did rather than what it was asked: `video-target-params/gamma`,
   * `current-ao`, `audio-out-params/channel-count` and so on.
   */
  probe?: string[];
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
    notice: text('.player-notice'),
    label: text('.player-label'),
    volume: text('.volume-control'),
    // Where the remote's ring is: its label, or its text when it has none.
    focus:
      document.querySelector('.focused')?.getAttribute('aria-label') ?? text('.focused'),
    // What the mouse is over, as the page itself sees it: its label, else its
    // class. On Linux this proves the mouse on mpv's window reached the page
    // (pageMouse.ts), since only real mouse input sets `:hover`.
    hover: (() => {
      const all = document.querySelectorAll(':hover');
      const el = all[all.length - 1];
      if (!el) return null;
      // getAttribute, not className, which an SVG icon gives as an object.
      return el.getAttribute('aria-label') ?? el.getAttribute('class') ?? el.tagName.toLowerCase();
    })(),
    // The Close / Sleep / Shut down dialog on Home, in TV mode.
    leave: document.querySelector('.leave') ? 'open' : null,
    controls: document.querySelector('.player')
      ? document.querySelector('.player.osd-hidden')
        ? 'hidden'
        : 'shown'
      : null,
  };
}

/** Carry out the plan, then hand the report to Rust, which writes it and quits. */
export async function runSelfTest(plan: SelfTestPlan): Promise<void> {
  const started = performance.now();
  const now = () => Math.round((performance.now() - started) / 10) / 100;
  const timeline: Entry[] = [];
  const note = (kind: string, detail?: unknown) => timeline.push({ t: now(), kind, detail });

  note('start', { path: plan.path, openAfter: plan.openAfter ?? 0 });

  // On top for the length of the run. Started from a script while someone is
  // using the PC, Windows keeps a new window behind the one they are in, and
  // every screenshot is of their screen instead (docs/GOTCHAS.md).
  void getCurrentWindow()
    .setAlwaysOnTop(true)
    .then(() => note('on-top'))
    .catch((e) => note('on-top-failed', String(e)));

  // The engine's events in Kinema's own terms, from whichever engine plays
  // (Media3 on Android has none of mpv's below). Not the position: the clock
  // entries already say where it is.
  const offEngine = await onPlaybackEvent((event) => {
    if (['position', 'duration', 'key', 'mouse'].includes(event.type)) return;
    const { type, ...detail } = event;
    note(`engine:${type}`, Object.keys(detail).length ? detail : undefined);
  });

  const unlisten = await listenMpvEvents((event) => {
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

  if (plan.mpv) {
    const options = plan.mpv;
    void startEngine().then(async () => {
      for (const [key, value] of Object.entries(options)) {
        await mpvCommand('set', [key, value]).then(
          () => note('mpv:set', { key, value }),
          (e) => note('mpv:set-failed', { key, value, error: String(e) })
        );
      }
    });
  }

  if (plan.mute !== false) {
    void startEngine()
      .then(() => mpvCommand('set', ['mute', 'yes']))
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

  const timers: number[] = [];
  const sampleLeak = (label?: string, round?: number) =>
    leakSample().then(
      (sample) => note('leak', { ...sample, label, round }),
      (e) => note('leak-failed', String(e))
    );
  if (plan.leakEvery) {
    void sampleLeak('start');
    timers.push(window.setInterval(() => void sampleLeak(), plan.leakEvery * 1000));
  }

  const actions = expandActions(plan.actions ?? []);
  for (const action of actions) {
    timers.push(
      window.setTimeout(() => {
        note(`action:${action.do}`, action);
        if (action.do === 'play') {
          if (openPlanFile) openPlanFile();
          else note('play:unavailable');
        } else if (action.do === 'leak') {
          void sampleLeak(action.note, action.round);
        } else if (action.do === 'key' && action.key) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true }));
        } else if (action.do === 'seek' && action.to !== undefined) {
          void seekTo(action.to).catch((e) => note('seek-failed', String(e)));
        } else if (action.do === 'call' && action.fn) {
          const target = CALLABLE[action.fn];
          if (!target) note('call:unknown', action.fn);
          else
            (target as (...args: unknown[]) => Promise<unknown>)(...(action.args ?? [])).then(
              (result) => note('call:done', { fn: action.fn, result }),
              (e) => note('call:failed', { fn: action.fn, error: String(e) })
            );
        } else if (action.do === 'mpv' && action.args?.length) {
          const [name, ...rest] = action.args.map(String);
          void mpvCommand(name, rest).then(
            () => note('mpv:done', action.args),
            (e) => note('mpv:failed', { args: action.args, error: String(e) })
          );
        } else if (action.do === 'probe' && action.args?.length) {
          void Promise.all(
            action.args.map(String).map((name) =>
              mpvGet(name, 'string').then(
                (value) => [name, value] as const,
                () => [name, null] as const
              )
            )
          ).then((pairs) => note('probed', Object.fromEntries(pairs)));
        } else if (action.do === 'detect' && action.root) {
          invoke('detect_intros', { rootPath: action.root }).then(
            (report) => note('detect:done', report),
            (e) => note('detect:refused', String(e))
          );
        }
      }, action.at * 1000)
    );
  }

  await new Promise((resolve) => window.setTimeout(resolve, plan.seconds * 1000));

  window.clearInterval(sampler);
  // Timeouts and the leak interval share one id space; clearing both ways is harmless.
  timers.forEach((id) => {
    window.clearTimeout(id);
    window.clearInterval(id);
  });
  if (plan.leakEvery) await sampleLeak('end');
  unlisten();
  offEngine();

  const read = async (name: string) => {
    try {
      return await mpvGet(name, 'double');
    } catch {
      return null;
    }
  };
  const probed: Record<string, string | null> = {};
  for (const name of plan.probe ?? []) {
    try {
      probed[name] = await mpvGet(name, 'string');
    } catch {
      probed[name] = null;
    }
  }

  const report = {
    plan,
    probed,
    // The stats panel as a viewer would read it, when a plan opened it (`i`).
    stats: (document.querySelector('.stats-panel') as HTMLElement | null)?.innerText ?? null,
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
