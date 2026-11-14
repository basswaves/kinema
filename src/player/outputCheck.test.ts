import { describe, expect, it } from 'vitest';
import type { AudioDevice, DisplayMode } from './equipment';
import { DEFAULT_SWITCH_SETTINGS } from './displayMode';
import { checkHdr, checkSound, outputCheck, type Check, type OutputFacts } from './outputCheck';

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
    expect(c.Motion).toMatchObject({ verdict: 'limited', value: 'judders, 23.976 fps on 60 Hz' });
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

  it('calls a 1080p film on a 4K screen upscaled, and offers Match the video', () => {
    const c = byLabel(
      outputCheck({
        ...base,
        source: { width: 1920, height: 800 },
        drawn: { width: 3840, height: 1600 },
      })
    );
    expect(c['Picture size']).toMatchObject({ verdict: 'info' });
    expect(c['Picture size']?.value).toMatch(/1080p video scaled up ×2\.00/);
    expect(c['Picture size']?.fix).toMatch(/Match the video/);
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

  it('says a full-screen window smaller than its screen is the window, not the desktop', () => {
    // A switch to 4K left the window at the 1080p desktop's size.
    const c = byLabel(
      outputCheck({
        ...base,
        drawn: { width: 1920, height: 1080 },
        screen: { ...base.screen!, width: 3840, height: 2160 },
      })
    );
    expect(c['Picture size']).toMatchObject({ verdict: 'limited' });
    expect(c['Picture size']?.value).toMatch(/to fit the window/);
    expect(c['Picture size']?.why).not.toMatch(/desktop is set lower/);
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
    expect(sdr.HDR?.why).toMatch(/cannot show HDR/);
    // An HDR TV on a desktop with no HDR is not called an SDR screen.
    const noHdrDesktop = byLabel(
      outputCheck({
        ...base,
        hdrOut: 'sdr',
        screen: { ...base.screen!, hdr: 'unsupported', screenHdr: true },
      })
    );
    expect(noHdrDesktop.HDR).toMatchObject({ verdict: 'info', value: 'HDR video tone mapped to SDR' });
    expect(noHdrDesktop.HDR?.why).toMatch(/desktop offers no HDR/);
    const off = byLabel(
      outputCheck({ ...base, hdrOut: 'sdr', screen: { ...base.screen!, hdr: 'off' } })
    );
    expect(off.HDR).toMatchObject({ verdict: 'limited' });
    expect(off.HDR?.fix).toMatch(/Turn HDR on for HDR videos/);
  });

  it('blames the graphics driver, not the screen, when HDR is on and the video still left as SDR', () => {
    // The test stick: GNOME and Plasma in HDR, NVIDIA's 580 driver offering
    // the player's window only SDR formats.
    const on = { ...base, hdrOut: 'sdr' as const, screen: { ...base.screen!, hdr: 'on' as const } };
    const linux = byLabel(outputCheck({ ...on, system: 'Linux' })).HDR;
    expect(linux).toMatchObject({ verdict: 'limited', value: 'HDR video shown in SDR' });
    expect(linux?.why).toMatch(/graphics driver offers the player no HDR output/);
    expect(linux?.why).not.toMatch(/cannot show HDR/);
    expect(linux?.fix).toMatch(/NVIDIA needs driver 595 or newer/);
    expect(linux?.fix).toMatch(/Mesa 25\.1 or newer/);
    const windows = byLabel(outputCheck({ ...on, system: 'Windows' })).HDR;
    expect(windows).toMatchObject({ verdict: 'limited' });
    expect(windows?.why).toMatch(/Windows has HDR on/);
    expect(windows?.fix).not.toMatch(/Mesa/);
  });

  it('does not call a screen SDR when the desktop does not say whether HDR is on', () => {
    // Hyprland: the TV's EDID says HDR, the desktop reports nothing.
    const c = byLabel(
      outputCheck({
        ...base,
        hdrOut: 'sdr',
        system: 'Linux',
        screen: { ...base.screen!, hdr: 'unknown' },
      })
    ).HDR;
    expect(c).toMatchObject({ verdict: 'limited', value: 'HDR video shown in SDR' });
    expect(c?.why).toMatch(/The screen can show HDR/);
    expect(c?.why).not.toMatch(/cannot show HDR/);
    expect(c?.fix).toMatch(/full-screen HDR video/);
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
    expect(c.Motion?.why).toMatch(/no mode that fits the video/);
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

describe('output check: what is not known', () => {
  it('gives no SDR verdict before mpv has reported the source', () => {
    const c = checkHdr({ ...base, hdrSource: false, sourceKnown: false });
    expect(c).toMatchObject({ verdict: 'info', value: 'not known yet' });
  });

  it('says mono plainly', () => {
    const a = { ...base.audio!, inChannels: 1, outChannels: 2, codec: 'aac', outFormat: 'float', direct: false, device: null };
    expect(checkSound({ ...base, audio: a })?.value).toBe('decoded, mono on both speakers');
    expect(checkSound({ ...base, audio: { ...a, outChannels: 1 } })?.value).toBe(
      'decoded, mono kept'
    );
  });
});

// A TV PC (2026-11-14): desktop at 4K 30 Hz, 10-bit YCbCr 4:2:2; a 59.94 fps
// clip asked for 4K 59.94 Hz, which the link had room for only at 8-bit 4:2:0.
describe('outputCheck: what the switch asked for and got', () => {
  const sdr60: OutputFacts = {
    ...base,
    source: { width: 3840, height: 2160 },
    drawn: { width: 3840, height: 2160 },
    hdrSource: false,
    hdrOut: 'sdr',
    fps: 60000 / 1001,
    screen: {
      ...base.screen!,
      hdr: 'off',
      linkBits: 10,
      linkEncoding: 'YCbCr 4:2:2',
      modes: [...tvModes, mode(3840, 2160, 30)],
    },
  };
  const asked = { width: 3840, height: 2160, rate: 60000 / 1001 };

  it('a refused mode is said, with the frames left out and what stands in the way', () => {
    const c = byLabel(
      outputCheck({
        ...sdr60,
        displayHz: 30000 / 1001,
        switched: {
          asked,
          got: null,
          error: 'not supported',
          linkBefore: '10-bit YCbCr 4:2:2',
          linkAfter: null,
        },
      })
    );
    expect(c.Motion).toMatchObject({
      verdict: 'limited',
      value: '50 % of frames left out, 59.94 fps on 29.97 Hz',
    });
    expect(c.Motion?.why).toMatch(/asked the screen for 3840×2160 at 59.94 Hz.*refused it/);
    expect(c.Motion?.fix).toMatch(/18 Gbps/);
  });

  it('a mode kept at another rate is said as kept', () => {
    const c = byLabel(
      outputCheck({
        ...sdr60,
        displayHz: 30,
        switched: {
          asked,
          got: { width: 3840, height: 2160, rate: 30 },
          error: null,
          linkBefore: null,
          linkAfter: null,
        },
      })
    );
    expect(c.Motion?.why).toMatch(/kept 30 Hz/);
  });

  it('a link lowered to fit the rate is said under colour depth, and motion is even', () => {
    const c = byLabel(
      outputCheck({
        ...sdr60,
        displayHz: 60000 / 1001,
        screen: { ...sdr60.screen!, linkBits: 8, linkEncoding: 'YCbCr 4:2:0' },
        switched: {
          asked,
          got: asked,
          error: null,
          linkBefore: '10-bit YCbCr 4:2:2',
          linkAfter: '8-bit YCbCr 4:2:0',
        },
      })
    );
    expect(c.Motion).toMatchObject({ verdict: 'native', value: 'even, 59.94 fps on 59.94 Hz' });
    expect(c['Colour depth']).toMatchObject({
      verdict: 'info',
      value: '8-bit YCbCr 4:2:0 to the screen',
    });
    expect(c['Colour depth']?.why).toMatch(
      /lowered the link from 10-bit YCbCr 4:2:2 to 8-bit YCbCr 4:2:0 to fit 59.94 Hz/
    );
  });

  it('HDR on a lowered link says why it is 8 bits', () => {
    const c = byLabel(
      outputCheck({
        ...sdr60,
        hdrSource: true,
        hdrOut: 'passthrough',
        displayHz: 60000 / 1001,
        screen: { ...sdr60.screen!, hdr: 'on', linkBits: 8, linkEncoding: 'YCbCr 4:2:0' },
        switched: {
          asked,
          got: asked,
          error: null,
          linkBefore: '10-bit YCbCr 4:2:2',
          linkAfter: '8-bit YCbCr 4:2:0',
        },
      })
    );
    expect(c['Colour depth']).toMatchObject({
      verdict: 'limited',
      value: 'HDR squeezed to 8-bit YCbCr 4:2:0',
    });
    expect(c['Colour depth']?.why).toMatch(/lowered the link/);
  });
});

// TV PC (2026-11-14): "Send sound straight to the receiver" on, but Windows'
// exclusive control switched off for the receiver — the panel said nothing.
describe('outputCheck sound: Windows blocks exclusive control', () => {
  it('says the block and where to lift it, not that the device cannot take it', () => {
    const blockedReceiver: AudioDevice = {
      ...receiver,
      bitstream: receiver.bitstream.map((b) => ({ ...b, result: 'not_allowed' })),
    };
    const c = checkSound({
      ...base,
      audio: { ...base.audio!, direct: true, outFormat: 'floatp', device: blockedReceiver },
    });
    expect(c).toMatchObject({ verdict: 'limited', value: 'decoded by Kinema' });
    expect(c?.why).toMatch(/does not let programs take exclusive control of AV receiver/);
    expect(c?.why).not.toMatch(/does not take/);
    expect(c?.fix).toMatch(/More sound settings → Playback .* Advanced/);
  });
});
