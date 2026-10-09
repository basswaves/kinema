/**
 * Picture and sound where the system does most of it (capabilities
 * `system_output` — Android, through Media3).
 *
 * There, Android turns the TV's HDR on for an HDR film by itself, and Media3
 * sends the sound to a receiver untouched wherever Android says the HDMI
 * output takes it. Kinema adds one thing, matching the screen's mode to the
 * film — the same rule as on Windows and Linux (`displayMode.ts`: the film's
 * frame rate, and the resolution only ever upwards) — behind one switch, on
 * unless switched off (owner, 2026-10-04: nobody watches anything else on a
 * TV box while a film plays, and that is what TV apps do). Nothing is asked
 * per device and nothing at the first run.
 *
 * The rest is what Settings says about it, worded here so it can be tested.
 */
import type { SwitchSettings } from './displayMode';

/** "on" or "off"; anything else, nothing stored included, is on. */
export const DISPLAY_MATCH_KEY = 'display_match';

export function matchOn(stored: string | null): boolean {
  return stored !== 'off';
}

/** The switch as `displayMode.ts` takes it. HDR is never Kinema's here. */
export function switchSettings(on: boolean): SwitchSettings {
  return { refresh: on, resolution: on ? 'auto' : 'off', hdr: false };
}

/**
 * What the system reports about the TV and the receiver (Media3Plugin.kt
 * `output`), and what the player did with the last film's sound.
 *
 * Only what is known goes in. Android's own surround setting is left out on
 * purpose: on an operator's box it read "never" one night and "always" the
 * next while the box's own menu decided, so it proved nothing (2026-10-04).
 */
export interface SystemOutput {
  /** HDR kinds the screen reports showing: "HDR10", "HLG", "Dolby Vision", "HDR10+". */
  hdr: string[];
  /** Sound formats Android says the HDMI output takes untouched, by name. */
  sound: string[];
  /** How many modes the screen offers: one means nothing can be switched. */
  modes: number;
  /**
   * The last film's sound as the player opened it on this device: its
   * format, and whether it went out untouched, was decoded here, or could
   * not be played at all. Null until a film's sound has opened.
   */
  lastSound: { format: string; way: 'untouched' | 'decoded' | 'none' } | null;
}

const list = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export function matchNote(out: SystemOutput | null): string | null {
  if (out && out.modes <= 1) {
    return "This device shows apps only one screen mode, so there is nothing for Kinema to switch. What the TV gets is up to the device's own display settings.";
  }
  return null;
}

/**
 * The HDR kinds are what the system was told about the screen, which is not
 * always what the TV can do: an operator's box that restarted while the TV
 * was off told Android none, and showed HDR films in ordinary colour until it
 * was restarted with the TV on (2026-10-05, and again the next night).
 */
export function pictureNote(out: SystemOutput | null, system: string): string {
  if (!out) return `${system} turns HDR on for an HDR film by itself.`;
  if (out.hdr.length === 0) {
    return `${system} says this screen takes no HDR, so ${system} shows HDR films in ordinary colour (SDR). If the TV can show HDR, restart this device with the TV on, so it checks the TV again.`;
  }
  return `${system} says this screen takes ${list(out.hdr)}. ${system} sends such a film to it as it is; Kinema leaves that to it.`;
}

export function soundNote(out: SystemOutput | null, system: string): string {
  if (!out || out.sound.length === 0) {
    return `${system} does not report that the TV or receiver takes any surround format untouched, so films' sound is played through ${system}.`;
  }
  return `${system} reports that the TV or receiver takes ${list(out.sound)} untouched, so Kinema sends those on as they are. The device's own sound settings can still decide otherwise; where it refuses, Kinema plays the sound through ${system} instead.`;
}

/** What happened to the last film's sound, as the player opened it; null before any film. */
export function lastSoundNote(out: SystemOutput | null): string | null {
  const last = out?.lastSound;
  if (!last) return null;
  if (last.way === 'untouched') {
    return `Last film: its ${last.format} sound went to the TV or receiver untouched.`;
  }
  if (last.way === 'decoded') {
    return `Last film: its ${last.format} sound was turned into ordinary sound on this device.`;
  }
  return `Last film: its ${last.format} sound could not be played on this device, so it played without sound.`;
}

/**
 * What the player says when the sound had to take another way
 * (Media3Plugin.kt `fallBack`): decoded on the device, another of the film's
 * sound tracks (`chosen`, when it is not the one that failed), or none.
 */
export function audioFallbackNotice(
  step: number,
  format: string,
  chosen: string | null,
  system: string
): string {
  const what = format ? `This film's sound (${format})` : "This film's sound";
  if (step >= 2) return `${what} cannot be played on this device, so the film is playing without sound.`;
  if (chosen && chosen !== format) {
    return `${what} cannot be played on this device, so its other sound track (${chosen}) is playing instead.`;
  }
  return `${what} could not be sent on untouched, so ${system} is playing it instead.`;
}
