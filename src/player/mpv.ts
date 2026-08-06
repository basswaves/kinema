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
 * Both the real player and the diagnostic spike go through here, so they can
 * never race each other into a second init.
 */
import { init, setProperty, type MpvConfig } from 'tauri-plugin-libmpv-api';
import { BASE_MPV_OPTIONS, TONE_MAPPING_OPTIONS } from './mpvOptions';

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
    const config: MpvConfig = {
      initialOptions: BASE_MPV_OPTIONS,
      observedProperties: OBSERVED,
    };

    host.__mpvInit = init(config).then(async (label) => {
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
