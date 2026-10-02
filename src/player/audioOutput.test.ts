import { describe, expect, it } from 'vitest';
import type { AudioDevice, Equipment, Probe } from './equipment';
import {
  channelsFor,
  goesDirect,
  mpvDeviceName,
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

const off: AudioSettings = { direct: { policy: 'off', devices: [] }, deviceId: null, overrides: {} };
const on: AudioSettings = { direct: { policy: 'all', devices: [] }, deviceId: null, overrides: {} };

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

  it('every device that can: speakers that take nothing untouched keep the system mixer', () => {
    // Straight to laptop speakers would silence the PC's other sounds for nothing.
    const speakers = device(['no', 'no', 'no', 'no', 'no']);
    expect(planAudio(on, speakers)).toMatchObject({ exclusive: false, spdif: [] });
    expect(goesDirect(on, speakers)).toBe(false);
  });

  it('only these: the listed device goes direct whatever it takes, another does not', () => {
    const listed = device(['no', 'no', 'no', 'no', 'no']);
    const these: AudioSettings = { ...off, direct: { policy: 'these', devices: [listed.id] } };
    expect(planAudio(these, listed).exclusive).toBe(true);
    const receiver = device(['yes', 'yes', 'yes', 'yes', 'yes'], { id: 'another-receiver' });
    expect(planAudio(these, receiver).exclusive).toBe(false);
  });

  it('lets an override force a format either way', () => {
    const plan = planAudio(
      { ...on, overrides: { truehd: 'on', ac3: 'off' } },
      device(['yes', 'no', 'no', 'no', 'no'])
    );
    expect(plan.spdif).toEqual(['truehd']);
    // A format forced on counts as one the device takes.
    expect(goesDirect({ ...on, overrides: { dts: 'on' } }, device(['no', 'no', 'no', 'no', 'no']))).toBe(true);
  });

  it('with no equipment answer, sound goes through the system rather than exclusive stereo', () => {
    expect(planAudio(on, null)).toEqual({
      device: 'auto',
      exclusive: false,
      spdif: [],
      channels: 'auto-safe',
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

  it('with no default (Linux), takes the one device that takes a bitstream', () => {
    const avr = device(['yes', 'yes'], { id: 'alsa/hdmi:CARD=NVidia,DEV=0', is_default: false });
    const analog = device([], { id: 'alsa/plughw:CARD=PCH,DEV=0', is_default: false });
    const linux = { gpus: [], displays: [], audio: [analog, avr], problems: [], checked_at: 0 };
    expect(targetDevice(linux as Equipment, null)?.id).toBe(avr.id);
    // Two receivers: no guess; the user chooses.
    const second = { ...avr, id: 'alsa/hdmi:CARD=NVidia,DEV=1' };
    const two = { ...linux, audio: [analog, avr, second] };
    expect(targetDevice(two as Equipment, null)).toBeNull();
  });
});

describe('on Linux', () => {
  const avr = device(['yes', 'yes', 'yes', 'yes', 'yes'], {
    id: 'alsa/hdmi:CARD=NVidia,DEV=0',
    is_default: false,
    mix_channels: 0,
    mix_layout: '',
  });

  it('sends straight to the receiver by its ALSA name, not to the sound server', () => {
    const plan = planAudio(on, avr);
    expect(plan.device).toBe('alsa/hdmi:CARD=NVidia,DEV=0');
    expect(plan.spdif).toEqual(['ac3', 'eac3', 'dts', 'dts-hd', 'truehd']);
  });

  it('through the sound server when off, whatever the receiver takes', () => {
    expect(planAudio(off, avr).device).toBe('auto');
  });

  it('keeps an ALSA name as it is', () => {
    expect(mpvDeviceName('alsa/hdmi:CARD=NVidia,DEV=0')).toBe('alsa/hdmi:CARD=NVidia,DEV=0');
  });
});

