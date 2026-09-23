/**
 * A stand-in for mpv, for running the UI without the native player.
 *
 * **Development only.** Loaded by `mockBackend.ts`, which is itself only
 * imported when `VITE_KINEMA_MOCK=1` in a dev server — a production build
 * contains none of this.
 *
 * It answers the same plugin commands the real one does (`init`, `command`,
 * `get_property`, `set_property`) and sends the same events on the same
 * channel (`mpv-event-main`): `file-loaded`, `playback-restart`,
 * `property-change` for the observed properties, and `end-file`. What it does
 * not do is decode anything — there is no picture, only a clock.
 *
 * The clock is the point. `window.__fakeMpv.speed = 20` plays an episode in a
 * minute and a half, which makes the timing paths in the player — Skip intro,
 * the credits offer, the end-of-file countdown — testable by driving the UI
 * rather than by watching television.
 */
import { emit } from '@tauri-apps/api/event';

const CHANNEL = 'mpv-event-main';
const TICK_MS = 100;

export interface FakeMpvState {
  initialised: boolean;
  path: string | null;
  duration: number | null;
  position: number;
  paused: boolean;
  eof: boolean;
  /** Seconds of playback per real second. */
  speed: number;
  /** Delay before `file-loaded`, in ms — a NAS is not instant. */
  loadDelayMs: number;
  /** Every command received, newest last, for assertions. */
  commands: Array<{ name: string; args: unknown[] }>;
}

/** How long each fixture file runs. Unknown paths get a TV-episode length. */
export type DurationLookup = (path: string) => number;

let lookupDuration: DurationLookup = () => 1500;

const state: FakeMpvState = {
  initialised: false,
  path: null,
  duration: null,
  position: 0,
  paused: false,
  eof: false,
  speed: 1,
  loadDelayMs: 300,
  commands: [],
};

let ticker: number | undefined;

function send(payload: Record<string, unknown>): void {
  void emit(CHANNEL, payload);
}

function change(name: string, data: unknown): void {
  send({ event: 'property-change', name, data });
}

function startTicking(): void {
  window.clearInterval(ticker);
  ticker = window.setInterval(() => {
    if (state.paused || state.eof || state.path === null || state.duration === null) return;
    state.position = Math.min(state.duration, state.position + (TICK_MS / 1000) * state.speed);
    change('time-pos', state.position);
    if (state.position >= state.duration) {
      // keep-open=yes: no end-file at the natural end, only eof-reached.
      state.eof = true;
      change('eof-reached', true);
    }
  }, TICK_MS);
}

function seek(target: number): void {
  if (state.duration === null) throw new Error('seek: nothing loaded');
  state.position = Math.max(0, Math.min(state.duration, target));
  state.eof = state.position >= state.duration;
  change('time-pos', state.position);
  send({ event: 'playback-restart' });
}

/** Per-file options from `loadfile <path> <flags> <index> <options>`. */
function startOption(args: unknown[]): number | null {
  const options = typeof args[3] === 'string' ? args[3] : '';
  const match = /(?:^|,)start=([\d.]+)/.exec(options);
  return match ? Number(match[1]) : null;
}

function loadfile(args: unknown[]): void {
  const path = String(args[0]);
  const start = startOption(args);

  // The outgoing file keeps reporting until the new one is open — the
  // behaviour that GOTCHAS "Clearing an observed property" is about.
  window.setTimeout(() => {
    state.path = path;
    state.duration = lookupDuration(path);
    state.position = start ?? 0;
    state.eof = false;
    send({ event: 'start-file', playlist_entry_id: 1 });
    send({ event: 'file-loaded' });
    change('duration', state.duration);
    change('time-pos', state.position);
    change('eof-reached', false);
    send({ event: 'playback-restart' });
    startTicking();
  }, state.loadDelayMs);
}

/** `plugin:libmpv|command`. */
export function command(name: string, args: unknown[]): null {
  state.commands.push({ name, args });
  switch (name) {
    case 'loadfile':
      loadfile(args);
      break;
    case 'seek': {
      const [amount, mode] = args as [number, string];
      seek(mode === 'relative' ? state.position + Number(amount) : Number(amount));
      break;
    }
    case 'set': {
      const [property, value] = args as [string, unknown];
      setProperty(property, value);
      break;
    }
    case 'stop':
      window.clearInterval(ticker);
      if (state.path !== null) send({ event: 'end-file', reason: 'stop', error: 0 });
      state.path = null;
      state.duration = null;
      state.position = 0;
      send({ event: 'idle' });
      break;
  }
  return null;
}

/** `plugin:libmpv|set_property`, and `set` through `command`. */
export function setProperty(name: string, value: unknown): null {
  if (name === 'pause') {
    state.paused = value === true || value === 'yes';
    change('pause', state.paused);
  }
  return null;
}

/**
 * `plugin:libmpv|get_property`. Unknown properties throw, as the real one
 * does for a property that does not exist — callers are written to expect it.
 */
export function getProperty(name: string): unknown {
  switch (name) {
    case 'time-pos':
      return state.path === null ? null : state.position;
    case 'duration':
      return state.duration;
    case 'pause':
      return state.paused;
    case 'eof-reached':
      return state.eof;
    case 'sub-visibility':
      return true;
    case 'track-list/count':
    case 'chapters':
      return 0;
    default:
      throw new Error(`property unavailable: ${name}`);
  }
}

/** `plugin:libmpv|init`. */
export function init(durations: DurationLookup): string {
  lookupDuration = durations;
  state.initialised = true;
  send({ event: 'idle' });
  return 'main';
}

/** Handle on the fake, for driving it from DevTools or the browser pane. */
export function exposeFakeMpv(): FakeMpvState {
  (window as unknown as { __fakeMpv: FakeMpvState }).__fakeMpv = state;
  return state;
}
