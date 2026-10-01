/**
 * "Your equipment can do better" — the notice on Home.
 *
 * The point of Kinema's native output is that nobody should have to know
 * which switches make a receiver get Atmos or a TV stop juddering. The checks
 * already know what the connected equipment can do; this compares that with
 * what is switched on and says so, once per piece of equipment:
 *
 *  - on a setup that can take nothing better, nothing is shown;
 *  - dismissed, it stays away for that equipment;
 *  - a receiver or TV connected later is new equipment, and is mentioned.
 *
 * It replaces a dialog that stood between Play and the film the first time,
 * and whose "Not now" meant never. Settings still has every switch.
 */
import { getSetting, setSetting } from '../metadata/api';
import {
  AUDIO_DIRECT_KEY,
  AUDIO_DIRECT_OFFERED_KEY,
  readAudioSettings,
  targetDevice,
  type AudioSettings,
} from '../player/audioOutput';
import { cadenceRank, type SwitchSettings } from '../player/displayMode';
import { readSwitchSettings, SWITCH_HDR_KEY, SWITCH_REFRESH_KEY } from '../player/displaySwitch';
import { getEquipment, type Equipment } from '../player/equipment';
import { capabilitiesNow, loadCapabilities, type Capabilities } from '../capabilities';

export const NOTICE_DISMISSED_KEY = 'quality_notice_dismissed';

export interface Upgrade {
  kind: 'sound' | 'motion' | 'hdr';
  /** What it is about, per piece of equipment — the unit of "dismissed". */
  id: string;
  text: string;
  /** The setting that turns it on. */
  setting: string;
}

const FILM_FPS = 24000 / 1001;

/** What this system can switch (capabilities.ts): only that is offered. */
export type Can = Pick<Capabilities, 'system' | 'audio_direct' | 'display_switching'>;

export function upgradesFor(
  equipment: Equipment,
  audio: AudioSettings,
  screen: SwitchSettings,
  oldOfferAnswered: boolean,
  can: Can
): Upgrade[] {
  const out: Upgrade[] = [];

  const device = targetDevice(equipment, audio.deviceId);
  // Someone who answered the old one-time question has decided, for the
  // equipment they had then; only equipment new since then is mentioned.
  const decided = oldOfferAnswered && device !== null && !device.new;
  if (can.audio_direct && !audio.direct && device && !decided) {
    const lossless = device.bitstream.some(
      (b) => (b.codec === 'truehd' || b.codec === 'dts-hd') && b.result === 'yes'
    );
    if (lossless) {
      out.push({
        kind: 'sound',
        id: `sound:${device.id}`,
        text: `${device.name} can take Dolby Atmos and DTS:X untouched. Through ${can.system} the height channels are lost.`,
        setting: AUDIO_DIRECT_KEY,
      });
    }
  }

  // A switch this system does not have would be a "Turn on" that does
  // nothing — on Linux until it can change the screen's mode.
  if (!can.display_switching) return out;
  for (const display of equipment.displays.filter((d) => d.connected)) {
    const atItsSize = display.modes.filter(
      (m) => m.width === display.width && m.height === display.height
    );
    if (!screen.refresh && atItsSize.some((m) => cadenceRank(m.rate, FILM_FPS) === 0)) {
      out.push({
        kind: 'motion',
        id: `motion:${display.id}`,
        text: `${display.name} can show movies without judder, by switching to 23.976 Hz while one plays.`,
        setting: SWITCH_REFRESH_KEY,
      });
    }
    if (!screen.hdr && display.hdr === 'off') {
      out.push({
        kind: 'hdr',
        id: `hdr:${display.id}`,
        text: `${display.name} can show HDR, but ${can.system} has it switched off, so HDR videos play in SDR.`,
        setting: SWITCH_HDR_KEY,
      });
    }
  }
  return out;
}

export function pendingUpgrades(upgrades: Upgrade[], dismissed: string[]): Upgrade[] {
  return upgrades.filter((u) => !dismissed.includes(u.id));
}

async function dismissedIds(): Promise<string[]> {
  const raw = await getSetting(NOTICE_DISMISSED_KEY).catch(() => null);
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** What to show on Home now; empty when the setup is already at its best. */
export async function readUpgrades(): Promise<Upgrade[]> {
  await loadCapabilities();
  const can = capabilitiesNow();
  // Nothing is offered until it is known what this system can switch.
  if (!can) return [];
  const [equipment, audio, screen, answered, dismissed] = await Promise.all([
    getEquipment(),
    readAudioSettings(),
    readSwitchSettings(),
    getSetting(AUDIO_DIRECT_OFFERED_KEY).catch(() => null),
    dismissedIds(),
  ]);
  return pendingUpgrades(upgradesFor(equipment, audio, screen, Boolean(answered), can), dismissed);
}

/** "OK": not for this equipment again. */
export async function dismissUpgrades(upgrades: Upgrade[]): Promise<void> {
  const ids = new Set([...(await dismissedIds()), ...upgrades.map((u) => u.id)]);
  await setSetting(NOTICE_DISMISSED_KEY, JSON.stringify([...ids]));
}

/** "Turn on": the switches, then the notice goes like a dismissal. */
export async function applyUpgrades(upgrades: Upgrade[]): Promise<void> {
  for (const setting of new Set(upgrades.map((u) => u.setting))) {
    await setSetting(setting, 'on');
  }
  await dismissUpgrades(upgrades);
}
