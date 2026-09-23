/**
 * Shared mpv lifecycle.
 *
 * mpv must be initialised exactly once per window, ever. Calling init() twice
 * against a live instance corrupts native state and takes the process down with
 * STATUS_ACCESS_VIOLATION. Two things in development cause repeat calls: React
 * StrictMode double-invoking effects, and HMR remounting components. Module
 * scope is not enough of a guard — Vite replaces the module on HMR — so the
 * promise is parked on `window`, which survives both.
 *
 * Every caller goes through here, so they can
 * never race each other into a second init.
 */
import { init, setProperty, type MpvConfig } from 'tauri-plugin-libmpv-api';
import { BASE_MPV_OPTIONS, TONE_MAPPING_OPTIONS } from './mpvOptions';
import { logPaths } from '../metadata/api';

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
  try {
    const { mpv_log } = await logPaths();
    return { ...BASE_MPV_OPTIONS, 'log-file': mpv_log };
  } catch (e) {
    console.warn('mpv: could not resolve the log folder, logging beside the exe', e);
    return BASE_MPV_OPTIONS;
  }
}

const OBSERVED = [
  ['pause', 'flag'],
  ['time-pos', 'double', 'none'],
  ['duration', 'double', 'none'],
  ['filename', 'string', 'none'],
  // `keep-open=yes` holds the last frame instead of closing the file, which
  // means mpv never emits `end-file` at the end of playback. `eof-reached` is
  // the signal that actually fires under that option.
  ['eof-reached', 'flag', 'none'],
] as const;

export const OBSERVED_PROPERTIES = OBSERVED;

export function ensureMpvInitialised(): Promise<string> {
  const host = window as unknown as { __mpvInit?: Promise<string> };

  if (!host.__mpvInit) {
    host.__mpvInit = initialOptions()
      .then((options) => init({ initialOptions: options, observedProperties: OBSERVED }))
      .then(async (label) => {
        // Applied individually and after startup: if a build rejects one of these
        // option names, we lose that refinement rather than the whole player.
        // `tone-mapping-mode` is exactly such a case — this libplacebo build
        // returns M_PROPERTY_UNKNOWN for it, and as an init option it aborted
        // startup entirely.
        for (const [key, value] of Object.entries(TONE_MAPPING_OPTIONS)) {
          try {
            await setProperty(key, value);
          } catch {
            console.warn(`mpv rejected optional setting ${key}=${value}`);
          }
        }
        return label;
      });
  }

  return host.__mpvInit;
}
