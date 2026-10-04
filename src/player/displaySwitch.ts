/**
 * When and how the screen is switched for a film — step 4 of the plan. What
 * mode to switch to is `displayMode.ts`; doing it is `display.rs`.
 *
 * Only while the window is fullscreen (2026-09-24, as MPC-HC and madVR do
 * it): a mode change is a whole-desktop change, and in a window the picture is
 * scaled to the window anyway. The film waits, paused, until the screen has
 * switched and the TV is showing a picture again — a TV re-syncing its HDMI
 * input is blank for a second or two, and starting on time into a black screen
 * loses the opening.
 *
 * Refresh matching and HDR each apply to every screen, to the screens listed,
 * or to none (`devicePolicy.ts`); the screen is known by the name the system
 * gives it now, matched to the stable id the equipment check found for it.
 *
 * Where the system does picture and sound itself (capabilities
 * `system_output`, Android) it is one switch instead, on unless switched off
 * (`systemOutput.ts`), the app is always the whole screen, and the mode is
 * asked of Android through the engine; the rule choosing it is the same.
 */
import { invoke } from '@tauri-apps/api/core';
import { getSetting } from '../metadata/api';
import { capabilitiesNow } from '../capabilities';
import {
  chooseTarget,
  DEFAULT_SWITCH_SETTINGS,
  type Film,
  type ResolutionMode,
  type Screen,
  type SwitchSettings,
} from './displayMode';
import { formatRate, getEquipment, type Equipment } from './equipment';
import { covers, readPolicy, type DevicePolicy } from './devicePolicy';
import {
  askScreenMode,
  isPictureFullscreen,
  mpvGet,
  mpvSet,
  restoreScreenMode,
  systemScreen,
  videoFacts,
} from './engine';
import { DISPLAY_MATCH_KEY, matchOn, switchSettings } from './systemOutput';

/** Android's way (`systemOutput.ts`) rather than Kinema's own. */
const bySystem = () => capabilitiesNow()?.system_output === true;

export const SWITCH_REFRESH_KEY = 'display_switch_refresh';
export const SWITCH_RESOLUTION_KEY = 'display_switch_resolution';
export const SWITCH_HDR_KEY = 'display_switch_hdr';

/**
 * After the switch, how long the TV gets to show a picture again. HDMI re-sync
 * is typically one to two seconds; this errs long, because a film that starts
 * into a blank screen has lost its first moment.
 */
const SETTLE_MS = 2000;
/**
 * The longest to wait for the first frame's video parameters. The film is
 * held paused for the switch meanwhile, so waiting costs only a later start;
 * giving up costs the switch. 5 s was too short: a test machine whose mpv
 * first tried a graphics decoder for a card no longer in it took 5.05 s to its
 * first frame, and the film played in the wrong mode with nothing said.
 */
const PARAMS_WAIT_MS = 15000;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function poll<T>(read: () => Promise<T | null>, ok: (value: T) => boolean, ms: number) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => null);
    if (value !== null && value !== undefined && ok(value)) return value;
    if (Date.now() > until) return null;
    await sleep(150);
  }
}

/** The screen settings as stored: two of them per screen. */
export interface SwitchPolicies {
  refresh: DevicePolicy;
  resolution: ResolutionMode;
  hdr: DevicePolicy;
}

export async function readSwitchPolicies(): Promise<SwitchPolicies> {
  const [refresh, resolution, hdr] = await Promise.all([
    readPolicy(SWITCH_REFRESH_KEY),
    getSetting(SWITCH_RESOLUTION_KEY),
    readPolicy(SWITCH_HDR_KEY),
  ]);
  const res: ResolutionMode =
    resolution === 'off' || resolution === 'match' || resolution === 'auto'
      ? resolution
      : DEFAULT_SWITCH_SETTINGS.resolution;
  return { refresh, resolution: res, hdr };
}

/** The settings for one screen, by its equipment id (null: not known). */
export function switchSettingsFor(p: SwitchPolicies, screenId: string | null): SwitchSettings {
  return {
    refresh: covers(p.refresh, screenId),
    resolution: p.resolution,
    hdr: covers(p.hdr, screenId),
  };
}

/**
 * The equipment id of the connected screen the system now calls `name`.
 * Null for a screen plugged in since the check: "only these" then leaves it
 * as it is, which is the safe way to be unsure.
 */
export function screenIdOf(equipment: Equipment | null, name: string): string | null {
  return equipment?.displays.find((d) => d.connected && d.gdi_name === name)?.id ?? null;
}

/** The settings for the screen the picture is on now. */
export async function switchSettingsHere(screen: { gdi_name: string }): Promise<SwitchSettings> {
  const [policies, equipment] = await Promise.all([
    readSwitchPolicies(),
    getEquipment().catch(() => null),
  ]);
  return switchSettingsFor(policies, screenIdOf(equipment, screen.gdi_name));
}

/** Whether a switch could happen at all right now — before a file is opened. */
export async function mayswitch(): Promise<boolean> {
  if (bySystem()) return matchOn(await getSetting(DISPLAY_MATCH_KEY));
  const s = await readSwitchPolicies();
  if (s.refresh.policy === 'off' && s.resolution === 'off' && s.hdr.policy === 'off') return false;
  // The picture's fullscreen, not necessarily this window's: on Linux the
  // picture is mpv's own window (engine.ts).
  return isPictureFullscreen().catch(() => false);
}

/**
 * The screen mpv's picture is on, where the picture is mpv's own window
 * (Linux): mpv's `display-names`, "HDMI-1". Null where the picture is in
 * Kinema's window, whose screen the backend finds itself.
 */
async function pictureScreen(): Promise<string | null> {
  if (!capabilitiesNow()?.mpv_video.own_window) return null;
  const names = (await mpvGet('display-names', 'string').catch(() => null)) as string | null;
  return names?.split(',')[0]?.trim() || null;
}

/** The film as mpv decodes it. Waits for the first frame's parameters. */
export async function filmNow(): Promise<Film | null> {
  if (bySystem()) return poll(videoFacts, (v) => v.width > 0 && v.height > 0, PARAMS_WAIT_MS);
  const gamma = await poll(
    () => mpvGet('video-params/gamma', 'string') as Promise<string | null>,
    (v) => v.length > 0,
    PARAMS_WAIT_MS
  );
  if (gamma === null) return null;
  const [width, height, fps] = await Promise.all([
    mpvGet('video-params/w', 'int64').catch(() => null) as Promise<number | null>,
    mpvGet('video-params/h', 'int64').catch(() => null) as Promise<number | null>,
    mpvGet('container-fps', 'double').catch(() => null) as Promise<number | null>,
  ]);
  if (!width || !height) return null;
  return { width, height, fps: fps || null, hdr: gamma === 'pq' || gamma === 'hlg' };
}

/**
 * Switch the screen for this film if the settings and the screen call for it.
 * Returns whether anything changed; the caller re-applies the colour-space
 * hint when it did, since HDR may now be on.
 */
export async function switchForFilm(film: Film, onSwitching?: () => void): Promise<boolean> {
  if (bySystem()) return switchBySystem(film, onSwitching);
  if (!(await isPictureFullscreen().catch(() => false))) return false;
  const name = await pictureScreen();
  const screen = await invoke<Screen>('screen_now', { screen: name });
  const settings = await switchSettingsHere(screen);
  const target = chooseTarget(screen, film, settings);
  if (!target) return false;
  onSwitching?.();
  console.log(
    `display: ${film.width}×${film.height} @ ${film.fps ? formatRate(film.fps) : '?'} fps${
      film.hdr ? ' HDR' : ''
    } → ${target.width}×${target.height}@${formatRate(target.rate)}${target.hdr ? ' + HDR on' : ''}`
  );
  const after = await invoke<Screen & { exact_rate: number }>('switch_screen', {
    width: target.width,
    height: target.height,
    hz: target.hz,
    hdr: target.hdr,
    screen: name,
  });
  // mpv does not notice the change: its window is a child of ours, and it kept
  // reporting 59.972 Hz for a monitor switched to 23.976 (selftest, 2026-09-25).
  // Its display-timed frame pacing and the stats panel's cadence both depend
  // on the number, so it is told — the exact rate Windows reports, since mpv
  // warns that even a slightly wrong one spoils display-sync.
  await mpvSet('display-fps-override', after.exact_rate).catch((e) =>
    console.warn('display: could not tell mpv the new refresh rate', e)
  );
  await sleep(SETTLE_MS);
  return true;
}

/** The same, on a system whose app is the whole screen (Android). */
async function switchBySystem(film: Film, onSwitching?: () => void): Promise<boolean> {
  if (!matchOn(await getSetting(DISPLAY_MATCH_KEY))) return false;
  const screen = await systemScreen();
  const target = chooseTarget(screen, film, switchSettings(true));
  if (!target) return false;
  onSwitching?.();
  console.log(
    `display: ${film.width}×${film.height} @ ${film.fps ? formatRate(film.fps) : '?'} fps → ${
      target.width
    }×${target.height}@${formatRate(target.rate)}`
  );
  const after = await askScreenMode(target.width, target.height, target.rate);
  console.log(`display: now ${after.width}×${after.height}@${formatRate(after.rate)}`);
  await sleep(SETTLE_MS);
  return true;
}

/** Put the screen back as it was before the first switch. */
export async function restoreScreen(): Promise<void> {
  if (bySystem()) {
    await restoreScreenMode().catch((e) => console.warn('display: restore failed', e));
    return;
  }
  const restored = await invoke<boolean>('restore_screen').catch((e) => {
    console.warn('display: restore failed', e);
    return false;
  });
  // Back to mpv's own detection, which never saw the switch and so still has
  // the desktop's rate.
  if (restored) await mpvSet('display-fps-override', 0).catch(() => undefined);
}
