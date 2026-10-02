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
 *
 * Since the first run asks about picture and sound (2026-10-02), the notice
 * never repeats a question that has been answered there or in Settings:
 *
 *  - **never answered** (nothing stored): as before, but Choose opens
 *    Settings → Picture & sound, where each is every device, only some, or
 *    off — rather than one press switching all of it on;
 *  - **only these**: it speaks up only for equipment that can do it and is
 *    not on the list — a laptop at a new TV — and Use it too adds it;
 *  - **every device, or off**: it says nothing. The first already covers new
 *    equipment, and the second is an answer.
 */
import { getSetting, setSetting } from '../metadata/api';
import {
  AUDIO_DIRECT_KEY,
  AUDIO_DIRECT_OFFERED_KEY,
  goesDirect,
  readAudioSettings,
  targetDevice,
  type AudioSettings,
} from '../player/audioOutput';
import { covers, readPolicy, savePolicy, withDevice } from '../player/devicePolicy';
import { filmRate } from './deviceOptions';
import {
  readSwitchPolicies,
  SWITCH_HDR_KEY,
  SWITCH_REFRESH_KEY,
  type SwitchPolicies,
} from '../player/displaySwitch';
import { getEquipment, type Equipment } from '../player/equipment';
import { capabilitiesNow, loadCapabilities, type Capabilities } from '../capabilities';

export const NOTICE_DISMISSED_KEY = 'quality_notice_dismissed';

export interface Upgrade {
  kind: 'sound' | 'motion' | 'hdr';
  /** What it is about, per piece of equipment — the unit of "dismissed". */
  id: string;
  text: string;
  /** The setting it is about. */
  setting: string;
  /** Choose in Settings (never answered), or add `device` to "only these". */
  action: 'choose' | 'add';
  device: string;
}

/** Which of the three questions have an answer stored. */
export interface Answered {
  sound: boolean;
  refresh: boolean;
  hdr: boolean;
}

/** What this system can switch (capabilities.ts): only that is offered. */
export type Can = Pick<Capabilities, 'system' | 'audio_direct' | 'display_switching'>;

export function upgradesFor(
  equipment: Equipment,
  audio: AudioSettings,
  screen: SwitchPolicies,
  answered: Answered,
  oldOfferAnswered: boolean,
  can: Can
): Upgrade[] {
  const out: Upgrade[] = [];

  // Whether to mention one piece of equipment that could do it: "add" when
  // the answer was only these and it is not on the list, "choose" when there
  // is no answer yet, nothing otherwise.
  const ask = (
    isAnswered: boolean,
    policy: SwitchPolicies['hdr'],
    id: string
  ): Upgrade['action'] | null => {
    if (covers(policy, id)) return null;
    if (policy.policy === 'these') return 'add';
    return isAnswered ? null : 'choose';
  };

  const device = targetDevice(equipment, audio.deviceId);
  // Someone who answered the old one-time question has decided, for the
  // equipment they had then; only equipment new since then is mentioned.
  const decided = oldOfferAnswered && device !== null && !device.new;
  const lossless = device?.bitstream.some(
    (b) => (b.codec === 'truehd' || b.codec === 'dts-hd') && b.result === 'yes'
  );
  if (can.audio_direct && device && lossless && !goesDirect(audio, device)) {
    const action = ask(answered.sound, audio.direct, device.id);
    if (action === 'add' || (action === 'choose' && !decided)) {
      out.push({
        kind: 'sound',
        id: `${action === 'add' ? 'add:' : ''}sound:${device.id}`,
        text:
          action === 'add'
            ? `${device.name} can take Dolby Atmos and DTS:X untouched, but is not among the receivers Kinema sends sound straight to.`
            : `${device.name} can take Dolby Atmos and DTS:X untouched. Through ${can.system} the height channels are lost.`,
        setting: AUDIO_DIRECT_KEY,
        action,
        device: device.id,
      });
    }
  }

  // A switch this system does not have would be a "Turn on" that does
  // nothing — on Linux until it can change the screen's mode.
  if (!can.display_switching) return out;
  for (const display of equipment.displays.filter((d) => d.connected)) {
    const motion =
      filmRate(display) !== null ? ask(answered.refresh, screen.refresh, display.id) : null;
    if (motion) {
      out.push({
        kind: 'motion',
        id: `${motion === 'add' ? 'add:' : ''}motion:${display.id}`,
        text:
          motion === 'add'
            ? `${display.name} can show movies without judder, but is not among the screens Kinema switches to 23.976 Hz.`
            : `${display.name} can show movies without judder, by switching to 23.976 Hz while one plays.`,
        setting: SWITCH_REFRESH_KEY,
        action: motion,
        device: display.id,
      });
    }
    const hdr = display.hdr === 'off' ? ask(answered.hdr, screen.hdr, display.id) : null;
    if (hdr) {
      out.push({
        kind: 'hdr',
        id: `${hdr === 'add' ? 'add:' : ''}hdr:${display.id}`,
        text:
          hdr === 'add'
            ? `${display.name} can show HDR, but is not among the screens Kinema turns HDR on for, so HDR videos play in SDR there.`
            : `${display.name} can show HDR, but ${can.system} has it switched off, so HDR videos play in SDR.`,
        setting: SWITCH_HDR_KEY,
        action: hdr,
        device: display.id,
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
  const stored = (key: string) => getSetting(key).then((v) => v !== null).catch(() => false);
  const [equipment, audio, screen, sound, refresh, hdr, oldOffer, dismissed] = await Promise.all([
    getEquipment(),
    readAudioSettings(),
    readSwitchPolicies(),
    stored(AUDIO_DIRECT_KEY),
    stored(SWITCH_REFRESH_KEY),
    stored(SWITCH_HDR_KEY),
    getSetting(AUDIO_DIRECT_OFFERED_KEY).catch(() => null),
    dismissedIds(),
  ]);
  const answered = { sound, refresh, hdr };
  return pendingUpgrades(
    upgradesFor(equipment, audio, screen, answered, Boolean(oldOffer), can),
    dismissed
  );
}

/** "Not now": not for this equipment again. */
export async function dismissUpgrades(upgrades: Upgrade[]): Promise<void> {
  const ids = new Set([...(await dismissedIds()), ...upgrades.map((u) => u.id)]);
  await setSetting(NOTICE_DISMISSED_KEY, JSON.stringify([...ids]));
}

/**
 * "Use it too": each device added to its setting's list, then the notice
 * goes like a dismissal. Only for "add"; "choose" is answered in Settings.
 */
export async function applyUpgrades(upgrades: Upgrade[]): Promise<void> {
  for (const u of upgrades.filter((x) => x.action === 'add')) {
    await savePolicy(u.setting, withDevice(await readPolicy(u.setting), u.device));
  }
  await dismissUpgrades(upgrades);
}
