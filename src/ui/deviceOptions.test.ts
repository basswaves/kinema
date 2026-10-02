import { describe, expect, it } from 'vitest';
import type { AudioDevice, Display, Equipment } from '../player/equipment';
import { hdrOptions, refreshOptions, soundOptions } from './deviceOptions';

const seen = { connected: true, first_seen: 1, last_seen: 5, new: false };

const tv = {
  ...seen,
  id: 'tv',
  name: 'TV',
  width: 3840,
  height: 2160,
  hdr: 'off',
  modes: [
    { width: 3840, height: 2160, hz: 60, rate: 60 },
    { width: 3840, height: 2160, hz: 23, rate: 24000 / 1001 },
  ],
} as Display;

// 23.976 Hz exists only below the resolution it runs at: it does not count.
const monitor = {
  ...seen,
  id: 'monitor',
  name: 'Monitor',
  width: 2560,
  height: 1600,
  hdr: 'unsupported',
  modes: [
    { width: 2560, height: 1600, hz: 60, rate: 60 },
    { width: 1920, height: 1080, hz: 23, rate: 24000 / 1001 },
  ],
} as Display;

const yes = (codec: string) => ({ codec, label: `${codec} (long name)`, result: 'yes', detail: null, remembered: false });
const receiver = { ...seen, id: 'avr', name: 'Receiver', bitstream: [yes('truehd'), yes('dts-hd')] } as AudioDevice;
const speakers = { ...seen, id: 'spk', name: 'Speakers', bitstream: [] } as unknown as AudioDevice;

const kit = (displays: Display[], audio: AudioDevice[]) => ({ displays, audio }) as unknown as Equipment;

describe('device options', () => {
  it('says what each sound device takes, and which can use direct sound', () => {
    const options = soundOptions(kit([], [speakers, receiver]));
    expect(options.map((o) => [o.id, o.able])).toEqual([
      ['spk', false],
      ['avr', true],
    ]);
    expect(options[1].detail).toBe('takes TrueHD, DTS-HD untouched');
  });

  it('counts a film rate only at the resolution the screen runs at', () => {
    const options = refreshOptions(kit([monitor, tv], []));
    expect(options.find((o) => o.id === 'tv')).toMatchObject({ able: true, detail: 'can show films at 23.976 Hz' });
    expect(options.find((o) => o.id === 'monitor')).toMatchObject({ able: false, detail: 'no film rate at 2560×1600' });
  });

  it('knows which screens can show HDR, and lists connected ones first', () => {
    const away = { ...tv, id: 'old', connected: false, last_seen: 9 } as Display;
    const options = hdrOptions(kit([away, monitor, tv], []));
    expect(options.map((o) => o.id)).toEqual(['monitor', 'tv', 'old']);
    expect(options.map((o) => o.able)).toEqual([false, true, true]);
  });

  it('copes with no equipment answer', () => {
    expect(soundOptions(null)).toEqual([]);
    expect(refreshOptions(null)).toEqual([]);
  });
});
