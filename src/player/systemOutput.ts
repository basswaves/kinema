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

/** What the system reports about the TV and the receiver (Media3Plugin.kt `output`). */
export interface SystemOutput {
  /** HDR kinds the screen shows: "HDR10", "HLG", "Dolby Vision", "HDR10+". */
  hdr: string[];
  /** Sound formats the HDMI output takes untouched, by name. */
  sound: string[];
  /** The system's own surround setting, where it has one. */
  surround: 'auto' | 'never' | 'always' | 'manual' | null;
  /** How many modes the screen offers: one means nothing can be switched. */
  modes: number;
}

const list = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export function matchNote(out: SystemOutput | null): string | null {
  if (out && out.modes <= 1) {
    return 'This device offers its screen only one mode, so there is nothing to switch to: films play in the mode it is set to.';
  }
  return null;
}

export function pictureNote(out: SystemOutput | null, system: string): string {
  if (!out) return `${system} turns HDR on for an HDR film by itself.`;
  if (out.hdr.length === 0) {
    return `The screen does not report HDR, so HDR films are shown in SDR by ${system}.`;
  }
  return `The screen shows ${list(out.hdr)}. ${system} turns it on for such a film by itself, and back off after.`;
}

export function soundNote(out: SystemOutput | null, system: string): string {
  if (out?.surround === 'never') {
    return `${system}'s own sound setting is set never to pass surround sound through, so films' surround sound is turned into ordinary sound here. To send it to an AV receiver untouched, change the surround sound setting in ${system}'s display and sound settings.`;
  }
  if (!out || out.sound.length === 0) {
    return `The sound is played through ${system}. Nothing connected says it takes surround formats untouched.`;
  }
  return `${list(out.sound)} go to the TV or receiver untouched, as ${system} reports what it takes. Where that fails, Kinema plays the sound through ${system} instead.`;
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
