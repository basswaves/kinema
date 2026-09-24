/**
 * Which screen mode suits a film — step 4 of the native-output plan. Pure:
 * the switching itself is `display.rs`, the timing is `displaySwitch.ts`.
 *
 * Three settings, each describing the equipment rather than a taste:
 *
 *  - **Refresh** (off by default): a rate the film's frame rate divides into
 *    evenly — 23.976 fps on 23.976 Hz, else 47.952, else 119.88 — so every
 *    frame is held for the same time and 3:2 judder is gone. Plain 24 Hz for a
 *    23.976 film is the fallback: one repeated frame every ~42 s is invisible
 *    next to 3:2 on every frame.
 *  - **Resolution** (Auto by default): Auto only ever switches *up*, when the
 *    desktop has fewer pixels than the film and the screen can show more — a
 *    1080p desktop on a 4K TV playing a 4K film, where staying put means Kinema
 *    shrinks the film and the TV blows it back up. Match content always uses
 *    the film's own resolution, for a TV or a video processor (a madVR Envy)
 *    that should do the upscaling.
 *  - **HDR** (off by default): Windows HDR on for an HDR film, back off after.
 *
 * A resolution is never lowered to get a refresh rate: on the development monitor here,
 * 23.976 Hz exists only at 1080p, and giving up 2560×1600 for it would trade a
 * visible loss for a subtler gain. Step 5 says so instead.
 */
import type { DisplayMode as Mode } from './equipment';

export type ResolutionMode = 'off' | 'auto' | 'match';

export interface SwitchSettings {
  refresh: boolean;
  resolution: ResolutionMode;
  hdr: boolean;
}

export const DEFAULT_SWITCH_SETTINGS: SwitchSettings = {
  refresh: false,
  resolution: 'auto',
  hdr: false,
};

export interface Film {
  width: number;
  height: number;
  /** Frames per second; 0 or null when mpv does not know. */
  fps: number | null;
  hdr: boolean;
}

export interface Screen {
  width: number;
  height: number;
  hz: number;
  rate: number;
  hdr: 'unknown' | 'unsupported' | 'off' | 'on';
  modes: Mode[];
}

export interface Target {
  width: number;
  height: number;
  hz: number;
  rate: number;
  /** Turn HDR on (true) or leave it (null). Never turned *off* for a film. */
  hdr: boolean | null;
}

const area = (m: { width: number; height: number }) => m.width * m.height;

/** The smallest mode that shows the film without shrinking it, if any. */
function fitting(modes: Mode[], film: Film): { width: number; height: number } | null {
  const fits = modes
    .filter((m) => m.width >= film.width && m.height >= film.height)
    .sort((a, b) => area(a) - area(b));
  return fits[0] ? { width: fits[0].width, height: fits[0].height } : null;
}

function largest(modes: Mode[]): { width: number; height: number } | null {
  const top = [...modes].sort((a, b) => area(b) - area(a))[0];
  return top ? { width: top.width, height: top.height } : null;
}

export function chooseResolution(
  screen: Screen,
  film: Film,
  setting: ResolutionMode
): { width: number; height: number } {
  const here = { width: screen.width, height: screen.height };
  if (setting === 'off' || film.width <= 0 || film.height <= 0) return here;
  if (setting === 'match') return fitting(screen.modes, film) ?? largest(screen.modes) ?? here;
  // Auto: only up, and only when the film has more pixels than the desktop.
  const smaller = film.width > screen.width || film.height > screen.height;
  if (!smaller) return here;
  const up = fitting(screen.modes, film) ?? largest(screen.modes);
  return up && area(up) > area(here) ? up : here;
}

/**
 * How well a refresh rate carries a frame rate: 0 is a whole multiple
 * (within 0.05 %), lower multiples first; 10 is the 24-for-23.976 fallback;
 * null means it judders.
 */
export function cadenceRank(rate: number, fps: number): number | null {
  for (let k = 1; k <= 5; k++) {
    if (Math.abs(rate - fps * k) / (fps * k) < 0.0005) return k - 1;
  }
  if (Math.abs(rate - fps) / fps < 0.002) return 10;
  return null;
}

export function chooseTarget(screen: Screen, film: Film, settings: SwitchSettings): Target | null {
  const res = chooseResolution(screen, film, settings.resolution);
  const atRes = screen.modes.filter((m) => m.width === res.width && m.height === res.height);
  if (atRes.length === 0) return null;

  let pick: Mode | undefined;
  if (settings.refresh && film.fps) {
    const fps = film.fps;
    pick = atRes
      .map((m) => ({ m, rank: cadenceRank(m.rate, fps) }))
      .filter((c): c is { m: Mode; rank: number } => c.rank !== null)
      .sort((a, b) => a.rank - b.rank)[0]?.m;
  }
  // No refresh match wanted or found: keep the current rate if this
  // resolution has it, else the nearest one.
  pick ??= [...atRes].sort(
    (a, b) => Math.abs(a.rate - screen.rate) - Math.abs(b.rate - screen.rate)
  )[0];
  if (!pick) return null;

  const hdr = settings.hdr && film.hdr && screen.hdr === 'off' ? true : null;
  const sameMode =
    pick.width === screen.width && pick.height === screen.height && pick.hz === screen.hz;
  if (sameMode && hdr === null) return null;
  return { width: pick.width, height: pick.height, hz: pick.hz, rate: pick.rate, hdr };
}
