import { describe, expect, it } from 'vitest';
import type { AudioDevice, Display, Equipment } from '../player/equipment';
import { pendingUpgrades, upgradesFor } from './qualityNotice';

const seen = { connected: true, first_seen: 1, last_seen: 2, new: false };

const tv: Display = {
  ...seen,
  id: 'tv',
  name: 'Living room TV',
  gdi_name: '',
  connection: 'HDMI',
  width: 3840,
  height: 2160,
  refresh_num: 60,
  refresh_den: 1,
  hdr: 'off',
  peak_nits: 800,
  full_frame_nits: null,
  min_nits: null,
  bits_per_color: 10,
  modes: [
    { width: 3840, height: 2160, hz: 60, rate: 60 },
    { width: 3840, height: 2160, hz: 23, rate: 24000 / 1001 },
  ],
  notes: [],
};

const monitor: Display = {
  ...tv,
  id: 'monitor',
  name: 'Desk monitor',
  hdr: 'unsupported',
  width: 2560,
  height: 1600,
  modes: [{ width: 2560, height: 1600, hz: 60, rate: 60 }],
};

const receiver: AudioDevice = {
  ...seen,
  name: 'Receiver',
  id: 'avr',
  is_default: true,
  connection: 'HDMI',
  mix_channels: 8,
  mix_layout: '7.1',
  mix_rate: 48000,
  max_pcm_channels: 8,
  spatial_objects: null,
  bitstream: [{ codec: 'truehd', label: 'Dolby TrueHD', result: 'yes', detail: null, remembered: false }],
  notes: [],
};

const speakers: AudioDevice = { ...receiver, id: 'speakers', name: 'Speakers', bitstream: [] };

const kit = (displays: Display[], audio: AudioDevice[]): Equipment => ({
  gpus: [],
  displays,
  audio,
  problems: [],
  checked_at: 0,
});

const none = { policy: 'off' as const, devices: [] };
const every = { policy: 'all' as const, devices: [] };
const off = { refresh: none, resolution: 'auto' as const, hdr: none };
const soundOff = { direct: none, deviceId: null, overrides: {} };
/** Nothing stored yet for any of the three: never answered. */
const fresh = { sound: false, refresh: false, hdr: false };
const windows = { system: 'Windows', audio_direct: true, display_switching: true };

describe('upgradesFor', () => {
  it('says nothing on a setup that can take nothing better', () => {
    expect(upgradesFor(kit([monitor], [speakers]), soundOff, off, fresh, false, windows)).toEqual([]);
  });

  it('names what a TV and a receiver could do that is switched off', () => {
    const kinds = upgradesFor(kit([monitor, tv], [receiver]), soundOff, off, fresh, false, windows).map((u) => u.id);
    expect(kinds).toEqual(['sound:avr', 'motion:tv', 'hdr:tv']);
  });

  it('says nothing about what is already on', () => {
    const all = { refresh: every, resolution: 'auto' as const, hdr: every };
    const direct = { ...soundOff, direct: every };
    expect(upgradesFor(kit([tv], [receiver]), direct, all, fresh, false, windows)).toEqual([]);
  });

  it('with only these, speaks up for equipment that is not on the list', () => {
    const these = (devices: string[]) => ({ policy: 'these' as const, devices });
    const screens = { refresh: these(['tv']), resolution: 'auto' as const, hdr: these(['tv']) };
    const sound = { ...soundOff, direct: these(['avr']) };
    const second = { ...tv, id: 'tv2' };
    const ids = upgradesFor(kit([tv, second], [receiver]), sound, screens, fresh, false, windows).map((u) => u.id);
    expect(ids).toEqual(['add:motion:tv2', 'add:hdr:tv2']);
    const offered = upgradesFor(kit([tv, second], [receiver]), sound, screens, fresh, false, windows);
    expect(offered.every((u) => u.action === 'add' && u.device === 'tv2')).toBe(true);
  });

  it('never asks again what has been answered, even with off', () => {
    const answered = { sound: true, refresh: true, hdr: true };
    expect(upgradesFor(kit([tv], [receiver]), soundOff, off, answered, false, windows)).toEqual([]);
    // One answered, the others still open.
    const some = upgradesFor(kit([tv], [receiver]), soundOff, off, { ...fresh, hdr: true }, false, windows);
    expect(some.map((u) => u.id)).toEqual(['sound:avr', 'motion:tv']);
    expect(some.every((u) => u.action === 'choose')).toBe(true);
  });

  it('leaves out a receiver whose owner already answered the old question', () => {
    const ids = upgradesFor(kit([], [receiver]), soundOff, off, fresh, true, windows).map((u) => u.id);
    expect(ids).toEqual([]);
    const newReceiver = { ...receiver, new: true };
    expect(upgradesFor(kit([], [newReceiver]), soundOff, off, fresh, true, windows).map((u) => u.id)).toEqual([
      'sound:avr',
    ]);
  });

  it('offers only what the system can switch', () => {
    // Linux today: the equipment is seen, nothing can be switched yet.
    const linux = { system: 'Linux', audio_direct: false, display_switching: false };
    expect(upgradesFor(kit([tv], [receiver]), soundOff, off, fresh, false, linux)).toEqual([]);
    const soundOnly = { ...linux, audio_direct: true };
    const offered = upgradesFor(kit([tv], [receiver]), soundOff, off, fresh, false, soundOnly);
    expect(offered.map((u) => u.id)).toEqual(['sound:avr']);
    expect(offered[0].text).toContain('Through Linux');
  });

  it('stays away for dismissed equipment, and speaks up for new equipment', () => {
    const upgrades = upgradesFor(kit([tv], [receiver]), soundOff, off, fresh, false, windows);
    expect(pendingUpgrades(upgrades, ['sound:avr', 'motion:tv', 'hdr:tv'])).toEqual([]);
    const later = upgradesFor(kit([tv, { ...tv, id: 'tv2' }], [receiver]), soundOff, off, fresh, false, windows);
    expect(pendingUpgrades(later, ['sound:avr', 'motion:tv', 'hdr:tv']).map((u) => u.id)).toEqual([
      'motion:tv2',
      'hdr:tv2',
    ]);
  });
});
