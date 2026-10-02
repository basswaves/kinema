/**
 * The devices each picture-and-sound setting can be about, and what each of
 * them can do for it — for Settings' "only these" lists and for the first
 * run's "this setup".
 *
 * "Can" is read from the equipment check, the same way the Home notice reads
 * it (`qualityNotice.ts`): a sound device that takes some of a film's own
 * formats untouched, a screen with a film rate at the resolution it runs at,
 * a screen that can show HDR.
 */
import { cadenceRank } from '../player/displayMode';
import type { AudioDevice, Display, Equipment } from '../player/equipment';
import type { DeviceOption } from './DeviceChoice';

const FILM_FPS = 24000 / 1001;

/** Connected first, then the rest by when they were last seen. */
function ordered<T extends { connected: boolean; last_seen: number }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => Number(b.connected) - Number(a.connected) || b.last_seen - a.last_seen
  );
}

/** Short names, for a list that has to fit beside a device's name. */
const SHORT: Record<string, string> = {
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital Plus',
  dts: 'DTS',
  'dts-hd': 'DTS-HD',
  truehd: 'TrueHD',
};

/** The formats `device` takes untouched, by short name. */
export function untouched(device: AudioDevice): string[] {
  return device.bitstream.filter((b) => b.result === 'yes').map((b) => SHORT[b.codec] ?? b.label);
}

export function soundOptions(equipment: Equipment | null): DeviceOption[] {
  return ordered(equipment?.audio ?? []).map((a) => {
    const formats = untouched(a);
    return {
      id: a.id,
      name: a.name,
      detail: formats.length ? `takes ${formats.join(', ')} untouched` : 'takes nothing untouched',
      connected: a.connected,
      able: formats.length > 0,
    };
  });
}

/** The film rate a screen offers at the resolution it runs at, if any. */
export function filmRate(d: Display): number | null {
  const atItsSize = d.modes.filter((m) => m.width === d.width && m.height === d.height);
  return atItsSize.find((m) => cadenceRank(m.rate, FILM_FPS) === 0)?.rate ?? null;
}

export function refreshOptions(equipment: Equipment | null): DeviceOption[] {
  return ordered(equipment?.displays ?? []).map((d) => {
    const rate = filmRate(d);
    return {
      id: d.id,
      name: d.name,
      detail: rate
        ? `can show films at ${Number(rate.toFixed(3))} Hz`
        : `no film rate at ${d.width}×${d.height}`,
      connected: d.connected,
      able: rate !== null,
    };
  });
}

export function canShowHdr(d: Display): boolean {
  return d.hdr === 'off' || d.hdr === 'on';
}

export function hdrOptions(equipment: Equipment | null): DeviceOption[] {
  return ordered(equipment?.displays ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    detail: canShowHdr(d) ? 'can show HDR' : 'SDR only',
    connected: d.connected,
    able: canShowHdr(d),
  }));
}
