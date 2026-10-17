import { describe, expect, it } from 'vitest';
import { isSoundLostNotice, soundLost, soundLostNotice } from './soundWatch';
import { deviceInUse, type AudioPlan } from './audioOutput';
import type { AudioDevice } from './equipment';

const RECEIVER = 'wasapi/{aaaa}';
const both = { devices: ['wasapi/{spk}', RECEIVER], ao: 'wasapi' };

describe('soundLost', () => {
  it('sees the watched device leave the list', () => {
    expect(soundLost(RECEIVER, both, { devices: ['wasapi/{spk}'], ao: 'wasapi' })).toBe('device');
  });

  it('never counts a device it never saw', () => {
    expect(soundLost('wasapi/{other}', both, { devices: ['wasapi/{spk}'], ao: 'wasapi' })).toBe(
      null
    );
  });

  it('does nothing when the list cannot be read', () => {
    expect(soundLost(RECEIVER, both, { devices: null, ao: 'wasapi' })).toBe(null);
  });

  it('sees the output close, with or without a known device', () => {
    expect(soundLost(null, both, { devices: both.devices, ao: null })).toBe('output');
  });

  it('ignores a file that never had an output', () => {
    const silent = { devices: both.devices, ao: null };
    expect(soundLost(RECEIVER, silent, silent)).toBe(null);
  });

  it('leaves an unchanged picture alone', () => {
    expect(soundLost(RECEIVER, both, both)).toBe(null);
  });
});

describe('deviceInUse', () => {
  const device = {
    name: 'Receiver',
    id: '{0.0.0.00000000}.{aaaa}',
    is_default: true,
  } as AudioDevice;
  const plan = (name: string): AudioPlan => ({
    device: name,
    exclusive: false,
    spdif: [],
    channels: 'auto-safe',
  });

  it('names the device the plan names', () => {
    expect(deviceInUse(plan(RECEIVER), { ...device, is_default: false })).toEqual({
      mpv: RECEIVER,
      name: 'Receiver',
    });
  });

  it("names Windows' default for auto", () => {
    expect(deviceInUse(plan('auto'), device)?.mpv).toBe(RECEIVER);
  });

  it('knows nothing when auto is a sound server that picks for itself', () => {
    expect(deviceInUse(plan('auto'), { ...device, is_default: false })).toBe(null);
    expect(deviceInUse(plan('auto'), null)).toBe(null);
  });
});

describe('soundLostNotice', () => {
  it('names the device when known and says the film is paused', () => {
    expect(soundLostNotice('Receiver')).toContain('(Receiver)');
    expect(soundLostNotice(null)).toMatch(/^The sound output went away, so the film is paused/);
  });

  it('is told apart from the other sound notices', () => {
    expect(isSoundLostNotice(soundLostNotice('Receiver'))).toBe(true);
    expect(isSoundLostNotice('Windows would not take surround sound, so this is playing in stereo.')).toBe(false);
  });
});
