/**
 * The player engine: the one file that talks to mpv.
 *
 * Everything else in Kinema reaches the player through here, in two layers.
 *
 * **Kinema's own terms** — open a file, pause, seek, stop, and the events that
 * say what happened. This is what any engine has to provide; the player's own
 * files (Player.tsx and its `use…` hooks) use nothing else, but for frame
 * timing, which is mpv's own setting and says so where it is set. On Android
 * the engine will be Media3, not mpv (see the porting notes), and this layer
 * is what it will implement.
 *
 * **mpv's terms** — `mpvCommand`, `mpvGet`, `mpvSet`, `readProperty`. For the
 * parts that are about this engine rather than about playing: the stats
 * panel, the output check, how sound is routed, the HDR hint, frame timing.
 * A different engine replaces those modules rather than imitating mpv, which
 * is why they say `mpv` in their names: a mistranslated property is exactly
 * the silent, error-free failure this codebase specialises in.
 *
 * The plugin (`tauri-plugin-libmpv-api`) is imported here and nowhere else, so
 * replacing it would touch one file.
 *
 * **On Android the engine is Media3** (`media3.ts`, capabilities `engine`).
 * Kinema's terms go to it instead; mpv's terms are not there to call.
 */
import {
  command,
  getProperty,
  init,
  listenEvents,
  observeProperties,
  setProperty,
  type MpvConfig,
} from 'tauri-plugin-libmpv-api';
import { BASE_MPV_OPTIONS, IDLE_SURFACE_OPTIONS, TONE_MAPPING_OPTIONS } from './mpvOptions';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { logPaths } from '../metadata/api';
import { capabilitiesNow, loadCapabilities } from '../capabilities';
import { keyCommand, keyFromValue, KEY_PROPERTY, MPV_KEYS } from './mpvKeys';
import { MOUSE_PROPERTY, newEvents, parseMouse, type MouseKind } from './mpvMouse';
import * as media3 from './media3';
import type { Film } from './displayMode';

/** Whether this system plays through Media3 rather than mpv. */
const isMedia3 = () => capabilitiesNow()?.engine === 'media3';

// ---- starting mpv ------------------------------------------------------------
//
// mpv must be initialised exactly once per window, ever. Calling init() twice
// against a live instance corrupts native state and takes the process down with
// STATUS_ACCESS_VIOLATION. Two things in development cause repeat calls: React
// StrictMode double-invoking effects, and HMR remounting components. Module
// scope is not enough of a guard — Vite replaces the module on HMR — so the
// promise is parked on `window`, which survives both.
//
// Every caller goes through here, so they can never race each other into a
// second init.

/**
 * The init options, with `log-file` made absolute.
 *
 * mpv opens a relative `log-file` against the current directory, which is
 * wherever the exe happened to be launched from — so the log was only where
 * the docs said when the app was started from its shortcut. The key already
 * exists in `BASE_MPV_OPTIONS`, so overriding it keeps it **first**, which is
 * load-bearing: a later rejected option must still be logged.
 */
async function initialOptions(): Promise<MpvConfig['initialOptions']> {
  // The graphics interface this system has (capabilities.rs). Without an
  // answer mpv chooses for itself, which is safe everywhere.
  await loadCapabilities();
  const video = capabilitiesNow()?.mpv_video;
  const graphics: Record<string, string> = video
    ? { 'gpu-api': video.gpu_api, hwdec: video.hwdec }
    : {};
  // A window of its own (capabilities.rs, `own_window`): full screen, and
  // only while something plays — no idle surface waiting over the library.
  // Its window is then the one with the keyboard, so mpv listens to it — for
  // the keys bound in `bindKeys` only; its own bindings stay off.
  if (video?.own_window) {
    Object.assign(graphics, { 'force-window': 'no', fs: 'yes', 'input-vo-keyboard': 'yes' });
  }
  try {
    const { mpv_log } = await logPaths();
    return { ...BASE_MPV_OPTIONS, 'log-file': mpv_log, ...graphics };
  } catch (e) {
    console.warn('mpv: could not resolve the log folder, logging beside the exe', e);
    return { ...BASE_MPV_OPTIONS, ...graphics };
  }
}

/**
 * Registered with mpv at init, once per window: adding one later does nothing
 * until the app restarts (docs/GOTCHAS.md). Each becomes a `PlaybackEvent`.
 */
const OBSERVED = [
  ['pause', 'flag'],
  ['time-pos', 'double', 'none'],
  ['duration', 'double', 'none'],
  ['filename', 'string', 'none'],
  // `keep-open=yes` holds the last frame instead of closing the file, which
  // means mpv never emits `end-file` at the end of playback. `eof-reached` is
  // the signal that actually fires under that option.
  ['eof-reached', 'flag', 'none'],
  // A key pressed on mpv's own window (mpvKeys.ts). Never changes where mpv
  // has no window of its own.
  [KEY_PROPERTY, 'string', 'none'],
  // The mouse on mpv's own window (mpvMouse.ts), written by Kinema's script
  // there. Never changes where mpv has no window of its own.
  [MOUSE_PROPERTY, 'string', 'none'],
] as const;

/** Start the engine, or wait for the start already under way. */
export function startEngine(): Promise<string> {
  const host = window as unknown as { __mpvInit?: Promise<string> };

  if (!host.__mpvInit) {
    host.__mpvInit = loadCapabilities()
      .then(() => {
        // Media3 starts with the first file; there is nothing to start here.
        if (isMedia3()) return null;
        // A build with no engine at all says so instead of failing inside
        // the plugin.
        if (capabilitiesNow()?.engine === 'none') {
          throw new Error('This version of Kinema cannot play films on this device yet.');
        }
        return initialOptions();
      })
      .then((options) => {
        if (options === null) return 'main';
        return startMpv(options);
      });
  }

  return host.__mpvInit;
}

async function startMpv(options: MpvConfig['initialOptions']): Promise<string> {
  const label = await init({ initialOptions: options, observedProperties: OBSERVED });
  // Applied individually and after startup: if a build rejects one of these
  // option names, we lose that refinement rather than the whole player.
  // `tone-mapping-mode` is exactly such a case — this libplacebo build
  // returns M_PROPERTY_UNKNOWN for it, and as an init option it aborted
  // startup entirely.
  const optional = { ...TONE_MAPPING_OPTIONS, ...IDLE_SURFACE_OPTIONS };
  for (const [key, value] of Object.entries(optional)) {
    try {
      await setProperty(key, value);
    } catch {
      console.warn(`mpv rejected optional setting ${key}=${value}`);
    }
  }
  if (capabilitiesNow()?.mpv_video.own_window) {
    await bindKeys();
    await watchMouse();
  }
  return label;
}

/**
 * Bind every key Kinema uses to a message back to Kinema (mpvKeys.ts). One
 * refused key — a name this mpv does not know — costs that key only.
 */
async function bindKeys(): Promise<void> {
  // A known starting value, so the first `cycle-values` has one to leave.
  await command('set', [KEY_PROPERTY, 'none']);
  for (const [index, [mpvKey]] of MPV_KEYS.entries()) {
    try {
      await command('keybind', [mpvKey, keyCommand(index)]);
    } catch (e) {
      console.warn(`mpv: could not bind ${mpvKey}`, e);
    }
  }
}

/**
 * Load Kinema's mouse script into mpv (mpvMouse.ts), and keep mpv from
 * moving its window when the film is dragged on: a drag there is the seek
 * bar's. Either failing costs that part only, and says so in app.log.
 */
async function watchMouse(): Promise<void> {
  try {
    const script = await invoke<string>('pointer_script');
    await command('load-script', [script]);
  } catch (e) {
    console.warn('mpv: the mouse script did not load; the mouse will do nothing in the player', e);
  }
  await setProperty('window-dragging', 'no').catch((e) =>
    console.warn('mpv: window-dragging could not be switched off', e)
  );
}

/** The last mouse event handed on (mpvMouse.ts → `newEvents`). */
let lastMouseSeq = 0;

// ---- Kinema's terms ----------------------------------------------------------

/** What the engine says happened. */
export type PlaybackEvent =
  /** A file is open and its tracks can be read. */
  | { type: 'loaded' }
  /** Playback (re)started after a load or a seek. */
  | { type: 'restarted' }
  /**
   * The file closed. `eof` is the end of the film; `error` a file that could
   * not be played (moved, deleted, a share that went away), with the engine's
   * own words when it gave any; `other` is a stop, a replacement, a quit.
   */
  | { type: 'ended'; reason: 'eof' | 'error' | 'other'; detail?: string }
  /** The last frame is on screen and held there. */
  | { type: 'reached-end' }
  | { type: 'paused'; value: boolean }
  | { type: 'position'; value: number | null }
  | { type: 'duration'; value: number | null }
  /**
   * A key pressed on the engine's own window, by its DOM name — only where
   * the engine has one (capabilities `own_window`).
   */
  | { type: 'key'; key: string }
  /**
   * The mouse on the engine's own window, at `x`, `y` in that window's
   * pixels, `time` on the engine's clock in milliseconds — only where the
   * engine has one (capabilities `own_window`).
   */
  | { type: 'mouse'; kind: MouseKind; x: number; y: number; time: number }
  /**
   * The sound would not play the way it was opened, and the engine took the
   * next way (Media3 only): `step` 1 decoded on the device — `chosen` is the
   * track playing now, another one when the film's own could not be decoded
   * — and 2 without sound.
   */
  | { type: 'audio-fallback'; step: number; format: string; chosen: string | null };

/**
 * Hear every `PlaybackEvent`, until the returned function is called.
 *
 * Two of mpv's channels feed it — its events and its observed properties —
 * and the caller no longer needs to know which says what.
 */
export async function onPlaybackEvent(handle: (event: PlaybackEvent) => void): Promise<() => void> {
  await loadCapabilities();
  if (isMedia3()) return media3.listen(handle);
  const offEvents = await listenEvents((event) => {
    switch (event.event) {
      case 'file-loaded':
        handle({ type: 'loaded' });
        break;
      case 'playback-restart':
        handle({ type: 'restarted' });
        break;
      case 'end-file': {
        const { reason, file_error } = event as { reason?: string; file_error?: string };
        handle({
          type: 'ended',
          reason: reason === 'eof' ? 'eof' : reason === 'error' ? 'error' : 'other',
          detail: file_error,
        });
        break;
      }
    }
  });
  const offProperties = await observeProperties(OBSERVED, ({ name, data }) => {
    switch (name) {
      case 'pause':
        handle({ type: 'paused', value: data as boolean });
        break;
      case 'time-pos':
        handle({ type: 'position', value: data as number | null });
        break;
      case 'duration':
        handle({ type: 'duration', value: data as number | null });
        break;
      case 'eof-reached':
        if (data === true) handle({ type: 'reached-end' });
        break;
      case KEY_PROPERTY: {
        const key = keyFromValue(data);
        if (key !== null) handle({ type: 'key', key });
        break;
      }
      case MOUSE_PROPERTY: {
        const events = newEvents(parseMouse(data), lastMouseSeq);
        for (const { seq, kind, x, y, time } of events) {
          lastMouseSeq = seq;
          handle({ type: 'mouse', kind, x, y, time });
        }
        break;
      }
    }
  });
  return () => {
    offEvents();
    offProperties();
  };
}

/**
 * Open `path`, replacing whatever was playing, at `start` seconds if given.
 *
 * Resolves as soon as the engine has *accepted* the file, not when it opened:
 * a file that cannot be played says so later, as an `ended` event with
 * reason `error`.
 */
export async function openFile(path: string, start: number | null): Promise<void> {
  if (isMedia3()) return media3.open(path, start);
  // `loadfile <url> <flags> <index> <options>`: the per-file `start` option
  // opens the file at the resume point. The index argument (-1, "no playlist
  // position") is required before options since mpv 0.38.
  await command('loadfile', start === null ? [path] : [path, 'replace', '-1', `start=${start}`]);
}

/** Close the file. Nothing plays afterwards; the engine stays up. */
export async function stopPlayback(): Promise<void> {
  if (isMedia3()) return media3.stop();
  await command('stop');
}

export async function setPaused(paused: boolean): Promise<void> {
  if (isMedia3()) return media3.setPaused(paused);
  await setProperty('pause', paused);
}

/** Whether it is paused, as the engine says; throws if it cannot say. */
export async function isPaused(): Promise<boolean> {
  if (isMedia3()) return (await media3.state()).paused;
  return (await getProperty('pause', 'flag')) as boolean;
}

export async function seekTo(seconds: number): Promise<void> {
  if (isMedia3()) return media3.seek(seconds, false);
  await command('seek', [seconds, 'absolute']);
}

export async function seekBy(seconds: number): Promise<void> {
  if (isMedia3()) return media3.seek(seconds, true);
  await command('seek', [seconds, 'relative']);
}

/** The file that is open, or null. */
export async function openPath(): Promise<string | null> {
  if (isMedia3()) return (await media3.state()).path;
  return ((await getProperty('path', 'string')) as string | null) ?? null;
}

/**
 * What is open and where it is, asked for rather than waited for. The path is
 * null if the engine cannot say; a failure to read either number throws.
 */
export async function nowPlaying(): Promise<{
  path: string | null;
  position: number | null;
  duration: number | null;
}> {
  if (isMedia3()) {
    const { path, position, duration } = await media3.state();
    return { path, position, duration };
  }
  const [path, position, duration] = await Promise.all([
    openPath().catch(() => null),
    getProperty('time-pos', 'double') as Promise<number | null>,
    getProperty('duration', 'double') as Promise<number | null>,
  ]);
  return { path, position, duration };
}

/**
 * Whether the picture fills the screen. Where the engine has a window of its
 * own (Linux), that window is the picture and Kinema's is hidden behind it —
 * and may be full screen for reasons of its own (overlay.ts) — so the
 * engine's window is the one asked. Elsewhere the picture is in Kinema's.
 */
export async function isPictureFullscreen(): Promise<boolean> {
  // Android has no windows: the picture always fills the screen, and there is
  // no smaller size for Back to step down to first.
  if (isMedia3()) return false;
  if (capabilitiesNow()?.mpv_video.own_window) {
    // Unreadable counts as not fullscreen: Back asks this first, and an error
    // here would otherwise leave Back doing nothing at all.
    return (await getProperty('fullscreen', 'flag').catch(() => false)) === true;
  }
  return getCurrentWindow().isFullscreen();
}

export async function setPictureFullscreen(on: boolean): Promise<void> {
  if (isMedia3()) return;
  if (capabilitiesNow()?.mpv_video.own_window) {
    // Kinema's window floats only while the picture is full screen: over a
    // windowed film it would sit on top of it (seen in a nested Sway).
    if (!on) await fitWindowForPlayer('tile');
    await setProperty('fullscreen', on);
    if (on) await fitWindowForPlayer('float');
    return;
  }
  await getCurrentWindow().setFullscreen(on);
}

/**
 * Where mpv has a window of its own, keep Kinema's window the screen's size
 * while the picture is full screen — its photo is the player's controls — by
 * floating it on a tiling desktop (Sway, Hyprland), where it would otherwise
 * be squeezed beside the film's window (`display.rs` → `player_window`).
 * Nothing happens elsewhere; never throws.
 */
export async function fitWindowForPlayer(how: 'float' | 'tile' | 'close'): Promise<void> {
  if (!capabilitiesNow()?.mpv_video.own_window) return;
  await invoke('player_window', { how }).catch((e) =>
    console.warn('display: Kinema’s window not fitted for the player', e)
  );
}

// ---- the screen and the sound, where the system does them -------------------
//
// Media3 only (capabilities `system_output`): the screen's modes and the
// film's picture as Android has them, for `displaySwitch.ts` to choose from
// by the same rule as everywhere else, and what the TV and the receiver
// take, for Settings. mpv's systems answer these through `display.rs`.

/** The film's picture once the engine knows it, else null. */
export async function videoFacts(): Promise<Film | null> {
  return isMedia3() ? (await media3.state()).video : null;
}

export const systemScreen = () => media3.screen();
export const askScreenMode = (width: number, height: number, rate: number) =>
  media3.setMode(width, height, rate);
export const restoreScreenMode = () => media3.restoreMode();
export const systemOutput = () => media3.output();

/** Whether the last frame has been reached; false while nothing is open. */
export async function hasReachedEnd(): Promise<boolean> {
  try {
    if (isMedia3()) return (await media3.state()).ended;
    return (await getProperty('eof-reached', 'flag')) === true;
  } catch {
    return false;
  }
}

// ---- tracks, subtitles, volume, chapters --------------------------------------
//
// Still Kinema's terms: what the track panel, the volume control and the
// credits ladder need, said the same way whichever engine plays. Formats are
// named as FFmpeg names them — `truehd`, `eac3`, "DTS-HD MA" — which is
// Kinema's own vocabulary for them already (ffprobe's badges speak it too),
// so an engine that says them otherwise translates into it.

/** One audio, subtitle or video track of the open file. */
export interface Track {
  /** The engine's number for it, good until the file is opened again. */
  id: number;
  type: 'video' | 'audio' | 'sub' | string;
  title?: string;
  lang?: string;
  /** FFmpeg's name for the format: `truehd`, `eac3`, `subrip`, `hdmv_pgs_subtitle`. */
  codec?: string;
  selected: boolean;
  forced: boolean;
  /** From a file of its own beside the film, or fetched, not inside the film. */
  external: boolean;
  default: boolean;
  /** Audio only: channels as the file carries them. */
  channels?: number;
  /** FFmpeg's profile name — where "DTS-HD MA" and "Atmos" are said. */
  profile?: string;
  /** Subtitles for the deaf and hard of hearing (SDH). */
  hearingImpaired?: boolean;
}

/**
 * Every track, read field by field as scalars — **all at once**. Never
 * `getProperty('track-list', 'node')`: the node format deserialises a
 * nested array-of-maps across the FFI boundary and reliably crashed the
 * process with STATUS_ACCESS_VIOLATION on file load. Each read is an IPC
 * round trip, and they used to be awaited one after another: nine per track,
 * so a release with twelve audio and subtitle tracks spent over a hundred
 * sequential round trips on it, twice per file. Order is kept by index.
 */
export async function readTracks(): Promise<Track[]> {
  if (isMedia3()) return [];
  const count = (await readProperty<number>('track-list/count', 'int64')) ?? 0;

  const read = async (i: number): Promise<Track | null> => {
    const at = (field: string) => `track-list/${i}/${field}`;
    const [
      type,
      id,
      title,
      lang,
      codec,
      selected,
      forced,
      external,
      isDefault,
      channels,
      profile,
      hearingImpaired,
    ] = await Promise.all([
      readProperty<string>(at('type'), 'string'),
      readProperty<number>(at('id'), 'int64'),
      readProperty<string>(at('title'), 'string'),
      readProperty<string>(at('lang'), 'string'),
      readProperty<string>(at('codec'), 'string'),
      readProperty<boolean>(at('selected'), 'flag'),
      readProperty<boolean>(at('forced'), 'flag'),
      readProperty<boolean>(at('external'), 'flag'),
      readProperty<boolean>(at('default'), 'flag'),
      readProperty<number>(at('demux-channel-count'), 'int64'),
      readProperty<string>(at('codec-profile'), 'string'),
      readProperty<boolean>(at('hearing-impaired'), 'flag'),
    ]);
    if (!type) return null;
    return {
      id: id ?? i,
      type,
      title: title ?? undefined,
      lang: lang ?? undefined,
      codec: codec ?? undefined,
      selected: selected ?? false,
      forced: forced ?? false,
      external: external ?? false,
      default: isDefault ?? false,
      channels: channels ?? undefined,
      profile: profile ?? undefined,
      hearingImpaired: hearingImpaired ?? false,
    };
  };

  const tracks = await Promise.all(Array.from({ length: count }, (_, i) => read(i)));
  return tracks.filter((t): t is Track => t !== null);
}

/**
 * Play this audio track, or show this subtitle track. Through mpv's `set`
 * input command, not `setProperty`: the typed setter sends JS numbers as
 * MPV_FORMAT_DOUBLE, and sid/aid are choice-style properties ("auto" / "no"
 * / an integer) whose handlers do not implement that format — they return
 * M_PROPERTY_NOT_IMPLEMENTED.
 */
export async function chooseTrack(kind: 'audio' | 'sub', id: number): Promise<void> {
  if (isMedia3()) throw new Error('Choosing a track is not here yet on this device.');
  await command('set', [kind === 'audio' ? 'aid' : 'sid', String(id)]);
}

/** Show or hide the subtitles, keeping the track chosen. */
export async function showSubtitles(visible: boolean): Promise<void> {
  if (isMedia3()) throw new Error('Subtitles are not here yet on this device.');
  await command('set', ['sub-visibility', visible ? 'yes' : 'no']);
}

/** Whether subtitles are showing, as the engine says; showing when it cannot say. */
export async function subtitlesShown(): Promise<boolean> {
  if (isMedia3()) return true;
  return (await readProperty<boolean>('sub-visibility', 'flag')) ?? true;
}

/**
 * Add a subtitle file to the open film, choose it and show it. `title` is
 * the name the track panel gives it.
 */
export async function addSubtitle(path: string, language: string, title: string): Promise<void> {
  if (isMedia3()) throw new Error('Subtitles are not here yet on this device.');
  await command('sub-add', [path, 'select', title, language]);
  await command('set', ['sub-visibility', 'yes']);
}

/**
 * The volume, 0–100. Through `set` rather than `setProperty`: the command
 * takes a string and lets mpv parse it, which sidesteps the typed-number
 * trouble some properties have with the plugin (docs/GOTCHAS.md, `sid` /
 * `aid`).
 */
export async function setVolume(level: number): Promise<void> {
  if (isMedia3()) throw new Error('Volume is not here yet on this device.');
  await command('set', ['volume', String(level)]);
}

export async function setMuted(muted: boolean): Promise<void> {
  if (isMedia3()) throw new Error('Volume is not here yet on this device.');
  await command('set', ['mute', muted ? 'yes' : 'no']);
}

/**
 * Whether the sound is going to the receiver as an untouched bitstream, where
 * Kinema's volume does nothing — the receiver's own control is the one.
 */
export async function soundGoesUntouched(): Promise<boolean> {
  if (isMedia3()) return false;
  const format = await readProperty<string>('audio-out-params/format', 'string');
  return format?.startsWith('spdif-') ?? false;
}

/** One chapter of the open file. */
export interface Chapter {
  /** Seconds from the start of the file. */
  time: number;
  title: string | null;
}

/**
 * The file's chapters in order, or an empty list when it has none. Same rule
 * as `readTracks`: never `chapter-list` as a node, every field a flat
 * indexed scalar.
 *
 * Media3 reads no chapters from a file, so on Android there are none and
 * the credits ladder goes by its other rungs (skip.ts).
 */
export async function readChapters(): Promise<Chapter[]> {
  if (isMedia3()) return [];
  const count = (await readProperty<number>('chapters', 'int64')) ?? 0;

  // All at once, in index order — see `readTracks` for why.
  const read = async (i: number): Promise<Chapter | null> => {
    const [time, title] = await Promise.all([
      readProperty<number>(`chapter-list/${i}/time`, 'double'),
      readProperty<string>(`chapter-list/${i}/title`, 'string'),
    ]);
    // A chapter with no start time is not usable for anything here. Its title
    // may still be missing, which is ordinary — most remuxes number chapters
    // rather than naming them.
    if (time === null || Number.isNaN(time)) return null;
    return { time, title };
  };

  const chapters = await Promise.all(Array.from({ length: count }, (_, i) => read(i)));
  return chapters.filter((c): c is Chapter => c !== null);
}

// ---- mpv's terms -------------------------------------------------------------

export type ScalarFormat = 'string' | 'int64' | 'double' | 'flag';

/** Whether mpv's terms are there to call at all: not where Media3 plays. */
export const hasMpv = () => !isMedia3();

/** An mpv input command, as mpv's own `input.conf` would spell it. */
export async function mpvCommand(
  name: string,
  args: (string | number | boolean)[] = []
): Promise<void> {
  await command(name, args);
}

/** Read an mpv property; throws where mpv refuses. See `readProperty`. */
export async function mpvGet<T>(name: string, format: ScalarFormat): Promise<T | null> {
  return ((await getProperty(name, format)) ?? null) as T | null;
}

/**
 * Set an mpv property. Sends numbers as doubles: `sid` and `aid` reject that
 * in both directions, so tracks are chosen with `mpvCommand('set', …)`.
 */
export async function mpvSet(name: string, value: string | number | boolean): Promise<void> {
  await setProperty(name, value);
}

/**
 * Read one mpv property as a flat scalar, or null when it is unavailable.
 *
 * Shared by the track list, the chapter list and the stats panel, which each
 * used to carry their own copy. Scalars only, on purpose: the `node` format is
 * the one that takes the process down (docs/GOTCHAS.md).
 */
export async function readProperty<T>(name: string, format: ScalarFormat): Promise<T | null> {
  try {
    return await mpvGet<T>(name, format);
  } catch {
    return null;
  }
}

/** mpv's own event stream, unfiltered — for the self-test's timeline only. */
export const listenMpvEvents = listenEvents;
