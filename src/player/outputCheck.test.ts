import { describe, expect, it } from 'vitest';
import type { AudioDevice, DisplayMode } from './equipment';
import { DEFAULT_SWITCH_SETTINGS } from './displayMode';
import { outputCheck, type Check, type OutputFacts } from './outputCheck';

const rateOf = (hz: number) => ([23, 59].includes(hz) ? ((hz + 1) * 1000) / 1001 : hz);
const mode = (width: number, height: number, hz: number): DisplayMode => ({
  width,
  height,
  hz,
  rate: rateOf(hz),
});
const tvModes = [3840, 1920].flatMap((w) =>
  [60, 50, 24, 23].map((hz) => mode(w, w === 3840 ? 2160 : 1080, hz))
);

const receiver: AudioDevice = {
  name: 'AV receiver',
  id: 'r',
  is_default: true,
  connection: 'HDMI',
  mix_channels: 8,
  mix_layout: '7.1',
  mix_rate: 48000,
  max_pcm_channels: 8,
  spatial_objects: null,
  bitstream: ['ac3', 'eac3', 'dts', 'dts-hd', 'truehd'].map((codec) => ({
    codec,
    label: codec,
    result: 'yes',
    detail: null,
    remembered: false,
  })),
  notes: [],
  connected: true,
  first_seen: 0,
  last_seen: 0,
  new: false,
};

/** A 4K HDR TV at 60 Hz, 8-bit, sound through Windows: the first-round setup. */
const base: OutputFacts = {
  fullscreen: true,
  source: { width: 3840, height: 1600 },
  drawn: { width: 3840, height: 1600 },
  screen: {
    width: 3840,
    height: 2160,
    hdr: 'on',
    linkBits: 8,
    linkEncoding: 'RGB',
    modes: tvModes,
  },
  fps: 24000 / 1001,
  displayHz: 60,
  hdrSource: true,
  hdrOut: 'passthrough',
  switches: DEFAULT_SWITCH_SETTINGS,
  audio: {
    codec: 'truehd',
    outFormat: 'float',
    inChannels: 8,
    outChannels: 8,
    direct: false,
    device: receiver,
  },
};

const byLabel = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.label, c]));

describe('outputCheck', () => {
  it('names everything that falls short on a 4K HDR TV at 60 Hz, and how to fix it', () => {
    const c = byLabel(outputCheck(base));
    expect(c['Picture size']?.verdict).toBe('native');
    expect(c.HDR?.verdict).toBe('native');
    expect(c.Motion).toMatchObject({ verdict: 'limited', value: 'judders — 23.976 fps on 60 Hz' });
    expect(c.Motion?.fix).toMatch(/Match the refresh rate/);
    expect(c['Colour depth']).toMatchObject({ verdict: 'limited', value: 'HDR squeezed to 8-bit RGB' });
    expect(c['Colour depth']?.why).toMatch(/cable cannot carry 10-bit/);
    expect(c['Colour depth']?.fix).toMatch(/23\.976 Hz the cable has room for 10-bit/);
    expect(c.Sound).toMatchObject({ verdict: 'limited' });
    expect(c.Sound?.fix).toMatch(/straight to the receiver/);
  });

  it('is all native once the setup is right', () => {
    const facts: OutputFacts = {
      ...base,
      displayHz: 24000 / 1001,
      switches: { ...DEFAULT_SWITCH_SETTINGS, refresh: true },
      screen: { ...base.screen!, linkBits: 12, linkEncoding: 'YCbCr 4:2:2' },
      audio: { ...base.audio!, outFormat: 'spdif-truehd', direct: true },
    };
    const checks = outputCheck(facts);
    expect(checks.map((c) => c.verdict)).toEqual(['native', 'native', 'native', 'native', 'native']);
    expect(byLabel(checks).Sound?.value).toBe('untouched Dolby TrueHD → receiver');
  });

  it('calls a 1080p film on a 4K screen upscaled, and offers Match content', () => {
    const c = byLabel(
      outputCheck({
        ...base,
        source: { width: 1920, height: 800 },
        drawn: { width: 3840, height: 1600 },
      })
    );
    expect(c['Picture size']).toMatchObject({ verdict: 'info' });
    expect(c['Picture size']?.value).toMatch(/1080p film scaled up ×2\.00/);
    expect(c['Picture size']?.fix).toMatch(/Match content/);
  });

  it('calls a 4K film on a 1080p desktop shrunk, and points at Auto', () => {
    const c = byLabel(
      outputCheck({
        ...base,
        drawn: { width: 1920, height: 800 },
        screen: { ...base.screen!, width: 1920, height: 1080 },
        switches: { ...DEFAULT_SWITCH_SETTINGS, resolution: 'off' },
      })
    );
    expect(c['Picture size']).toMatchObject({ verdict: 'limited' });
    expect(c['Picture size']?.fix).toMatch(/Resolution → Auto/);
  });

  it('only notes the window size when not fullscreen', () => {
    const c = byLabel(outputCheck({ ...base, fullscreen: false, drawn: { width: 1280, height: 533 } }));
    expect(c['Picture size']).toMatchObject({ verdict: 'info' });
    expect(c['Picture size']?.fix).toMatch(/Fullscreen/);
  });

  it('separates an SDR screen (nothing to fix) from HDR switched off (fixable)', () => {
    const sdr = byLabel(
      outputCheck({ ...base, hdrOut: 'sdr', screen: { ...base.screen!, hdr: 'unsupported' } })
    );
    expect(sdr.HDR).toMatchObject({ verdict: 'info' });
    expect(sdr.HDR?.fix).toBeUndefined();
    const off = byLabel(
      outputCheck({ ...base, hdrOut: 'sdr', screen: { ...base.screen!, hdr: 'off' } })
    );
    expect(off.HDR).toMatchObject({ verdict: 'limited' });
    expect(off.HDR?.fix).toMatch(/Turn HDR on for HDR films/);
  });

  it('does not ask for a resolution drop to fix motion', () => {
    const monitor: OutputFacts = {
      ...base,
      hdrSource: false,
      hdrOut: 'sdr',
      screen: {
        width: 2560,
        height: 1600,
        hdr: 'unsupported',
        linkBits: 10,
        linkEncoding: 'RGB',
        modes: [mode(2560, 1600, 60), mode(1920, 1080, 23)],
      },
    };
    const c = byLabel(outputCheck(monitor));
    expect(c.Motion).toMatchObject({ verdict: 'info' });
    expect(c.Motion?.why).toMatch(/only at 1920×1080/);
    expect(c.Motion?.fix).toBeUndefined();
  });

  it('calls a stereo fold-down through Windows fixable', () => {
    const c = byLabel(
      outputCheck({
        ...base,
        audio: { ...base.audio!, codec: 'aac', inChannels: 6, outChannels: 2 },
      })
    );
    expect(c.Sound).toMatchObject({ verdict: 'limited', value: 'folded from 6 to 2 channels' });
    expect(c.Sound?.fix).toMatch(/speaker setup/);
  });

  it('is content with lossless PCM when the device cannot take the format', () => {
    const tvOnly: AudioDevice = {
      ...receiver,
      name: 'TV',
      bitstream: receiver.bitstream.map((b) => ({
        ...b,
        result: b.codec === 'ac3' ? 'yes' : 'no',
      })),
    };
    const c = byLabel(
      outputCheck({ ...base, audio: { ...base.audio!, direct: true, outFormat: 's32', device: tvOnly } })
    );
    expect(c.Sound).toMatchObject({ verdict: 'native', value: 'decoded, all 8 channels kept' });
    expect(c.Sound?.why).toMatch(/does not take Dolby TrueHD untouched/);
  });
});

describe('outputCheck motion', () => {
  it('does not count a near-miss mode as even (72 Hz is not 3 × 23.976)', () => {
    const c = byLabel(
      outputCheck({
        ...base,
        hdrSource: false,
        hdrOut: 'sdr',
        screen: {
          width: 1920,
          height: 1080,
          hdr: 'unsupported',
          linkBits: 8,
          linkEncoding: 'RGB',
          modes: [mode(1920, 1080, 60), mode(800, 600, 72)],
        },
      })
    );
    expect(c.Motion?.why).toMatch(/no mode that fits the film/);
  });
});

describe('outputCheck picture', () => {
  it('calls a 4K film on a 1080p-only screen info, not a problem', () => {
    const c = byLabel(
      outputCheck({
        ...base,
        drawn: { width: 1920, height: 800 },
        screen: { ...base.screen!, width: 1920, height: 1080, modes: [mode(1920, 1080, 60)] },
      })
    );
    expect(c['Picture size']).toMatchObject({ verdict: 'info' });
    expect(c['Picture size']?.fix).toBeUndefined();
  });
});

describe('outputCheck Dolby Vision', () => {
  it('says a Dolby Vision film goes out as HDR10, and why, without calling it a fault', () => {
    const p7 = byLabel(outputCheck({ ...base, dolbyVision: 7 })).HDR;
    expect(p7).toMatchObject({ verdict: 'info', value: 'Dolby Vision profile 7, sent as HDR10' });
    expect(p7?.why).toMatch(/HDR10 layer is sent as mastered/);
    expect(p7?.fix).toBeUndefined();
    expect(byLabel(outputCheck({ ...base, dolbyVision: 5 })).HDR?.why).toMatch(/no HDR10 layer/);
    expect(byLabel(outputCheck({ ...base, dolbyVision: null })).HDR?.verdict).toBe('native');
  });
});

describe('outputCheck colour depth', () => {
  it('blames the driver setting, not the cable, for 8-bit HDR at 4K 23.976 Hz', () => {
    const c = byLabel(
      outputCheck({
        ...base,
        displayHz: 24000 / 1001,
        switches: { ...DEFAULT_SWITCH_SETTINGS, refresh: true },
      })
    );
    expect(c['Colour depth']).toMatchObject({ verdict: 'limited', value: 'HDR squeezed to 8-bit RGB' });
    expect(c['Colour depth']?.why).toMatch(/driver is set to send 8 bits/);
    expect(c['Colour depth']?.fix).toMatch(/10 or 12 bpc/);
    expect(c['Colour depth']?.fix).toMatch(/YCbCr 4:2:2 first/);
  });
});
