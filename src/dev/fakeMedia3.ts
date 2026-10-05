/**
 * A stand-in for Media3, the player on Android, for running the UI without a
 * device (`kinemaMockSystem=android`).
 *
 * **Development only**, like `fakeMpv.ts`: loaded by `mockBackend.ts`, which
 * a production build never contains.
 *
 * It answers the `plugin:media3|…` commands `Media3Plugin.kt` answers, and
 * says what happened as that plugin does — one `playback` event in Kinema's
 * own terms, through a plugin listener — in the same order: `loaded` as the
 * file is accepted, `duration` each time the player is ready, `restarted` at
 * the first frame and after each seek, `position` four times a second while
 * a file is open (paused too), `paused` when playing or not changes, and
 * `reached-end` then `ended` at the end. There is no picture, only a clock;
 * `window.__fakeMedia3.speed` runs it faster, as `__fakeMpv.speed` does.
 */

const TICK_MS = 250;

export interface FakeMedia3State {
  path: string | null;
  /** Where it was read from, when not the path (`stream_address`, smb://). */
  url: string | null;
  duration: number | null;
  position: number;
  /** Whether it means to play — kept across files, as the plugin keeps it. */
  wantPlaying: boolean;
  ended: boolean;
  /** Seconds of playback per real second. */
  speed: number;
  /** Delay before the player is ready, in ms. */
  loadDelayMs: number;
  /** Every command received, newest last, for assertions. */
  commands: Array<{ name: string; args: Record<string, unknown> }>;
  /** The film's picture, as Media3 reports it once it has chosen the video. */
  video: { width: number; height: number; fps: number | null; hdr: boolean };
  /** The screen's mode now, and the modes it offers. */
  screen: { width: number; height: number; rate: number };
  modes: { width: number; height: number; rate: number }[];
}

/** How long each fixture file runs. */
export type DurationLookup = (path: string) => number;

let lookupDuration: DurationLookup = () => 1500;

const state: FakeMedia3State = {
  path: null,
  url: null,
  duration: null,
  position: 0,
  wantPlaying: true,
  ended: false,
  speed: 1,
  loadDelayMs: 300,
  commands: [],
  video: { width: 1920, height: 1080, fps: 23.976, hdr: false },
  screen: { width: 1920, height: 1080, rate: 60 },
  modes: [
    { width: 1920, height: 1080, rate: 60 },
    { width: 1920, height: 1080, rate: 50 },
    { width: 1920, height: 1080, rate: 23.976 },
    { width: 3840, height: 2160, rate: 60 },
  ],
};

/** The plugin's listeners: Channel ids, each with its own message count. */
const listeners = new Map<number, { index: number }>();

type Internals = { runCallback: (id: number, data: unknown) => void };

function emit(type: string, fields: Record<string, unknown> = {}): void {
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  for (const [id, channel] of [...listeners]) {
    // A Channel takes its messages in order, by index (@tauri-apps/api core).
    internals.runCallback(id, { index: channel.index++, message: { type, ...fields } });
  }
}

/** `plugin:media3|register_listener`: the handler is a Channel. */
export function registerListener(args: Record<string, unknown>): null {
  const handler = args.handler as { id: number } | undefined;
  if (args.event === 'playback' && handler) listeners.set(handler.id, { index: 0 });
  return null;
}

export function removeListener(args: Record<string, unknown>): null {
  listeners.delete(Number(args.channelId));
  return null;
}

let ticker: number | undefined;
let pending: number | undefined;
/** The first frame of this file has been shown. */
let started = false;

function tick(): void {
  if (state.path === null || state.duration === null) return;
  if (state.wantPlaying && !state.ended) {
    state.position = Math.min(state.duration, state.position + (TICK_MS / 1000) * state.speed);
  }
  emit('position', { value: state.position });
  if (!state.ended && state.position >= state.duration) {
    state.ended = true;
    emit('reached-end');
    emit('ended', { reason: 'eof' });
  }
}

/** The player is ready: after opening, and after each seek. */
function ready(then: () => void): void {
  window.clearTimeout(pending);
  pending = window.setTimeout(() => {
    if (state.path === null) return;
    emit('duration', { value: state.duration });
    then();
  }, state.loadDelayMs);
}

function record(name: string, args: Record<string, unknown>): void {
  state.commands.push({ name, args });
}

export function open(args: Record<string, unknown>): null {
  record('open', args);
  state.path = String(args.path);
  state.url = typeof args.url === 'string' ? args.url : null;
  state.duration = lookupDuration(state.path);
  state.position = typeof args.start === 'number' ? args.start : 0;
  state.ended = false;
  started = false;
  emit('loaded');
  window.clearInterval(ticker);
  ticker = window.setInterval(tick, TICK_MS);
  ready(() => {
    if (!started) {
      started = true;
      emit('restarted');
    }
  });
  return null;
}

export function stop(): null {
  record('stop', {});
  window.clearInterval(ticker);
  window.clearTimeout(pending);
  const wasOpen = state.path !== null;
  state.path = null;
  state.url = null;
  state.duration = null;
  state.position = 0;
  state.ended = false;
  if (wasOpen) emit('ended', { reason: 'other' });
  return null;
}

export function setPaused(args: Record<string, unknown>): null {
  record('set_paused', args);
  const playing = !args.paused;
  if (playing !== state.wantPlaying) {
    state.wantPlaying = playing;
    emit('paused', { value: !playing });
  }
  return null;
}

export function seek(args: Record<string, unknown>): null {
  record('seek', args);
  if (state.path === null || state.duration === null) throw new Error('nothing is open');
  const seconds = Number(args.seconds);
  const target = args.relative ? state.position + seconds : seconds;
  state.position = Math.max(0, Math.min(state.duration, target));
  state.ended = false;
  ready(() => emit('restarted'));
  return null;
}

export function playerState() {
  return {
    path: state.path,
    position: state.path === null ? null : state.position,
    duration: state.duration,
    paused: !state.wantPlaying,
    ended: state.ended,
    video: state.path === null || !started ? null : state.video,
  };
}

const hz = (rate: number) => Math.floor(rate + 0.001);
const mode = (m: { width: number; height: number; rate: number }) => ({
  width: m.width,
  height: m.height,
  hz: hz(m.rate),
  rate: m.rate,
});

export function screen() {
  return { ...mode(state.screen), gdi_name: 'display 0', hdr: 'unknown', modes: state.modes.map(mode) };
}

/** Kinema asked for a mode, so `restoreMode` has something to undo. */
let asked = false;

export function setMode(args: Record<string, unknown>) {
  record('set_mode', args);
  const found = state.modes.find(
    (m) => m.width === args.width && m.height === args.height && Math.abs(m.rate - Number(args.rate)) < 0.01
  );
  if (!found) throw new Error(`no ${args.width}x${args.height} at ${args.rate} Hz on this screen`);
  asked = true;
  state.screen = { ...found };
  return mode(state.screen);
}

export function restoreMode() {
  record('restore_mode', {});
  const restored = asked;
  asked = false;
  state.screen = { ...state.modes[0] };
  return { restored };
}

export function init(durations: DurationLookup): void {
  lookupDuration = durations;
}

/** Handle on the fake, for driving it from a check or the browser pane. */
export function exposeFakeMedia3(): FakeMedia3State {
  (window as unknown as { __fakeMedia3: FakeMedia3State }).__fakeMedia3 = state;
  return state;
}
