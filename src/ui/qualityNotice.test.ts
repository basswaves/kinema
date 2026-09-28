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

const off = { refresh: false, resolution: 'auto' as const, hdr: false };
const soundOff = { direct: false, deviceId: null, overrides: {} };

describe('upgradesFor', () => {
  it('says nothing on a setup that can take nothing better', () => {
    expect(upgradesFor(kit([monitor], [speakers]), soundOff, off, false)).toEqual([]);
  });

  it('names what a TV and a receiver could do that is switched off', () => {
    const kinds = upgradesFor(kit([monitor, tv], [receiver]), soundOff, off, false).map((u) => u.id);
    expect(kinds).toEqual(['sound:avr', 'motion:tv', 'hdr:tv']);
  });

  it('says nothing about what is already on', () => {
    const all = { refresh: true, resolution: 'auto' as const, hdr: true };
    const direct = { ...soundOff, direct: true };
    expect(upgradesFor(kit([tv], [receiver]), direct, all, false)).toEqual([]);
  });

  it('leaves out a receiver whose owner already answered the old question', () => {
    const ids = upgradesFor(kit([], [receiver]), soundOff, off, true).map((u) => u.id);
    expect(ids).toEqual([]);
    const newReceiver = { ...receiver, new: true };
    expect(upgradesFor(kit([], [newReceiver]), soundOff, off, true).map((u) => u.id)).toEqual([
      'sound:avr',
    ]);
  });

  it('stays away for dismissed equipment, and speaks up for new equipment', () => {
    const upgrades = upgradesFor(kit([tv], [receiver]), soundOff, off, false);
    expect(pendingUpgrades(upgrades, ['sound:avr', 'motion:tv', 'hdr:tv'])).toEqual([]);
    const later = upgradesFor(kit([tv, { ...tv, id: 'tv2' }], [receiver]), soundOff, off, false);
    expect(pendingUpgrades(later, ['sound:avr', 'motion:tv', 'hdr:tv']).map((u) => u.id)).toEqual([
      'motion:tv2',
      'hdr:tv2',
    ]);
  });
});
