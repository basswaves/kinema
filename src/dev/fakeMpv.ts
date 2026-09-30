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
  volume: number;
  mute: boolean;
  subVisible: boolean;
  /** Set to e.g. 'spdif-truehd' to stand in for sound going to a receiver. */
  audioOutFormat: string | null;
  /**
   * Set to mpv's words for a failure (e.g. 'no such file or directory') and
   * the next `loadfile` fails with them, as a file on a share that went away
   * does. Cleared once used.
   */
  failNextLoad: string | null;
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
  volume: 100,
  mute: false,
  subVisible: true,
  audioOutFormat: 'float',
  failNextLoad: null,
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
    if (state.failNextLoad !== null) {
      // mpv accepted the command; the failure only arrives as the file closes.
      send({ event: 'start-file', playlist_entry_id: 1 });
      send({ event: 'end-file', reason: 'error', error: -13, file_error: state.failNextLoad });
      state.failNextLoad = null;
      return;
    }
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
      added.length = 0;
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
    case 'sub-add': {
      // A subtitle file loaded from outside the video, as OpenSubtitles'
      // are: a new track, selected when asked to be.
      const [, flags, title, lang] = args as [string, string?, string?, string?];
      const id = Math.max(0, ...tracks().filter((t) => t.type === 'sub').map((t) => t.id)) + 1;
      added.push({ type: 'sub', id, lang: lang ?? null, codec: 'subrip', title: title ?? null, external: true });
      if (flags === 'select') selectedTrack.sid = id;
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

/**
 * The tracks every fixture file has: what an English film with Norwegian
 * subtitles typically carries, so the track panel and the language defaults
 * can be driven. `selected` follows `aid` / `sid` as they are set.
 */
const TRACKS = [
  { type: 'video', id: 1, codec: 'hevc' },
  { type: 'audio', id: 1, lang: 'eng', codec: 'truehd', channels: 8, profile: 'Dolby TrueHD + Dolby Atmos' },
  { type: 'audio', id: 2, lang: 'eng', codec: 'ac3', channels: 2, title: 'Commentary with the director' },
  { type: 'sub', id: 1, lang: 'eng', codec: 'hdmv_pgs_subtitle', title: 'English SDH' },
  { type: 'sub', id: 2, lang: 'nor', codec: 'subrip' },
  { type: 'sub', id: 3, lang: 'nor', codec: 'subrip', forced: true },
] as const;

const selectedTrack = { aid: 1, sid: 1 };

/** Subtitles added with `sub-add` while a file is open; gone with the file. */
const added: Record<string, unknown>[] = [];

function tracks(): { type: string; id: number }[] {
  return [...TRACKS, ...added] as { type: string; id: number }[];
}

function trackField(name: string): unknown {
  const match = /^track-list\/(\d+)\/(.+)$/.exec(name);
  if (!match) return undefined;
  const track = tracks()[Number(match[1])] as Record<string, unknown> | undefined;
  if (!track) throw new Error(`property unavailable: ${name}`);
  switch (match[2]) {
    case 'selected':
      return (
        (track.type === 'audio' && track.id === selectedTrack.aid) ||
        (track.type === 'sub' && track.id === selectedTrack.sid) ||
        track.type === 'video'
      );
    case 'demux-channel-count':
      return track.channels ?? null;
    case 'codec-profile':
      return track.profile ?? null;
    case 'forced':
    case 'external':
    case 'default':
    case 'hearing-impaired':
      return Boolean(track[match[2]]);
    default:
      return track[match[2]] ?? null;
  }
}

/** `plugin:libmpv|set_property`, and `set` through `command`. */
export function setProperty(name: string, value: unknown): null {
  if (name === 'pause') {
    state.paused = value === true || value === 'yes';
    change('pause', state.paused);
  }
  if (name === 'volume') state.volume = Number(value);
  if (name === 'aid' || name === 'sid') selectedTrack[name] = Number(value);
  if (name === 'sub-visibility') state.subVisible = value === true || value === 'yes';
  if (name === 'mute') state.mute = value === true || value === 'yes';
  return null;
}

/**
 * `plugin:libmpv|get_property`. Unknown properties throw, as the real one
 * does for a property that does not exist — callers are written to expect it.
 */
export function getProperty(name: string): unknown {
  switch (name) {
    case 'path':
      return state.path;
    case 'time-pos':
      return state.path === null ? null : state.position;
    case 'duration':
      return state.duration;
    case 'pause':
      return state.paused;
    case 'eof-reached':
      return state.eof;
    case 'sub-visibility':
      return state.subVisible;
    case 'volume':
      return state.volume;
    case 'mute':
      return state.mute;
    // As a real mpv: no sound output, so no format, until a file is open.
    case 'audio-out-params/format':
      return state.path === null ? null : state.audioOutFormat;
    // Answered, or the player's never-silent check reads a playing file as mute.
    case 'current-ao':
      return state.path === null ? null : 'wasapi';
    case 'track-list/count':
      return state.path === null ? 0 : tracks().length;
    case 'chapters':
      return 0;
    default: {
      const field = trackField(name);
      if (field !== undefined) return field;
      throw new Error(`property unavailable: ${name}`);
    }
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
