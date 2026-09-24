import { describe, expect, it } from 'vitest';
import type { AudioDevice, Equipment, Probe } from './equipment';
import {
  channelsFor,
  mpvDeviceName,
  offerFor,
  planAudio,
  targetDevice,
  type AudioSettings,
} from './audioOutput';

const CODECS = ['ac3', 'eac3', 'dts', 'dts-hd', 'truehd'];

function device(results: Probe[], extra: Partial<AudioDevice> = {}): AudioDevice {
  return {
    name: 'AV receiver',
    id: '{0.0.0.00000000}.{11111111-2222-4333-8444-555555555555}',
    is_default: true,
    connection: 'HDMI',
    mix_channels: 8,
    mix_layout: '7.1',
    mix_rate: 48000,
    max_pcm_channels: 8,
    spatial_objects: null,
    bitstream: CODECS.map((codec, i) => ({
      codec,
      label: codec,
      result: results[i] ?? 'no',
      detail: null,
      remembered: false,
    })),
    notes: [],
    connected: true,
    first_seen: 0,
    last_seen: 0,
    new: false,
    ...extra,
  };
}

const off: AudioSettings = { direct: false, deviceId: null, overrides: {} };
const on: AudioSettings = { direct: true, deviceId: null, overrides: {} };

describe('planAudio', () => {
  it('through Windows: shared, nothing passed through, Windows decides the layout', () => {
    expect(planAudio(off, device(['yes', 'yes', 'yes', 'yes', 'yes']))).toEqual({
      device: 'auto',
      exclusive: false,
      spdif: [],
      channels: 'auto-safe',
    });
  });

  it("straight to the test receiver: every format it took, 7.1 PCM for the rest", () => {
    const plan = planAudio(on, device(['yes', 'yes', 'yes', 'yes', 'yes']));
    expect(plan.exclusive).toBe(true);
    expect(plan.spdif).toEqual(['ac3', 'eac3', 'dts', 'dts-hd', 'truehd']);
    expect(plan.channels).toBe('7.1,5.1(side),5.1,stereo');
  });

  it('passes through only what the device said yes to — never on a guess', () => {
    // A TV that takes the lossy formats only. TrueHD must decode, not be sent
    // for mpv to relabel as AC3.
    const plan = planAudio(on, device(['yes', 'yes', 'no', 'no', 'no']));
    expect(plan.spdif).toEqual(['ac3', 'eac3']);
  });

  it('treats busy or unknown answers as no', () => {
    expect(planAudio(on, device(['busy', 'unknown', 'not_allowed', 'no', 'no'])).spdif).toEqual([]);
  });

  it('lets an override force a format either way', () => {
    const plan = planAudio(
      { ...on, overrides: { truehd: 'on', ac3: 'off' } },
      device(['yes', 'no', 'no', 'no', 'no'])
    );
    expect(plan.spdif).toEqual(['truehd']);
  });

  it('still goes direct with no equipment answer, as stereo and no passthrough', () => {
    expect(planAudio(on, null)).toEqual({
      device: 'auto',
      exclusive: true,
      spdif: [],
      channels: 'stereo',
    });
  });

  it('names the chosen device the way mpv does', () => {
    const d = device(['yes']);
    const plan = planAudio({ ...off, deviceId: d.id }, d);
    expect(plan.device).toBe('wasapi/{11111111-2222-4333-8444-555555555555}');
  });
});

describe('channelsFor', () => {
  it('offers every layout the device takes, largest first', () => {
    expect(channelsFor(8)).toBe('7.1,5.1(side),5.1,stereo');
    expect(channelsFor(6)).toBe('5.1(side),5.1,stereo');
    expect(channelsFor(2)).toBe('stereo');
    expect(channelsFor(null)).toBe('stereo');
  });
});

describe('mpvDeviceName', () => {
  it('drops the endpoint prefix mpv does not use', () => {
    expect(mpvDeviceName('{0.0.0.00000000}.{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}')).toBe(
      'wasapi/{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}'
    );
  });
});

describe('targetDevice', () => {
  const a = device(['yes'], { id: 'a', is_default: false });
  const b = device(['yes'], { id: 'b', is_default: true });
  const gone = device(['yes'], { id: 'c', is_default: false, connected: false });
  const eq = { gpus: [], displays: [], audio: [a, b, gone], problems: [], checked_at: 0 } as Equipment;

  it('uses the chosen device when it is connected', () => {
    expect(targetDevice(eq, 'a')?.id).toBe('a');
  });

  it("falls back to Windows' default when the chosen one is unplugged", () => {
    expect(targetDevice(eq, 'c')?.id).toBe('b');
    expect(targetDevice(eq, null)?.id).toBe('b');
  });
});

describe('offerFor', () => {
  const yamaha = device(['yes', 'yes', 'yes', 'yes', 'yes']);

  it("offers once for a receiver that takes the lossless formats", () => {
    expect(offerFor(off, false, yamaha)).toEqual({
      device: 'AV receiver',
      formats: ['dts-hd', 'truehd'],
    });
  });

  it('never again once answered, and never when already on', () => {
    expect(offerFor(off, true, yamaha)).toBeNull();
    expect(offerFor(on, false, yamaha)).toBeNull();
  });

  it('not for a device where it would change nothing you can hear', () => {
    expect(offerFor(off, false, device(['yes', 'yes', 'no', 'no', 'no']))).toBeNull();
    expect(offerFor(off, false, null)).toBeNull();
  });
});

describe('offerFor wording', () => {
  it('names the formats without their "incl." notes', () => {
    const d = device(['no', 'no', 'no', 'yes', 'yes']);
    d.bitstream[3].label = 'DTS-HD Master Audio (incl. DTS:X)';
    d.bitstream[4].label = 'Dolby TrueHD (incl. Atmos)';
    expect(offerFor(off, false, d)?.formats).toEqual(['DTS-HD Master Audio', 'Dolby TrueHD']);
  });
});
