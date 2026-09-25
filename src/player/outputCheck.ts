/**
 * Is this film reaching the screen and the speakers as it was made — and if
 * not, why, and what would fix it? Step 5 of the native-output plan.
 *
 * Five checks, each a plain verdict with the reason and the fix in words, for
 * the top of the stats panel:
 *
 *  - **Picture size** — 1:1, scaled up by Kinema, or shrunk.
 *  - **HDR** — sent as mastered, tone mapped for an SDR screen, or lost to a
 *    Windows setting.
 *  - **Motion** — the film's frame rate divides evenly into the screen's, or
 *    it judders.
 *  - **Colour depth** — HDR on the cable at 10 bits or more, or squeezed to 8
 *    by the link's bandwidth (4K + HDR + 60 Hz does not fit HDMI 2.0 at 10-bit;
 *    the same link carries it at 24 Hz).
 *  - **Sound** — untouched to the receiver, decoded with every channel, or
 *    folded down / stripped of Atmos and DTS:X.
 *
 * "Limited" is kept for something a person could change: a setting here, one
 * in Windows or the graphics driver, a cable. What cannot be changed — an SDR
 * screen, a TV with no 24 Hz mode — is "info", said once and not nagged about.
 *
 * Pure, so every verdict can be tested without a screen: the stats panel
 * gathers the facts, this only judges them.
 */
import type { AudioDevice, DisplayMode } from './equipment';
import { cadenceRank, type SwitchSettings } from './displayMode';
import { formatRate } from './equipment';

export type Verdict = 'native' | 'limited' | 'info';

export interface Check {
  label: string;
  verdict: Verdict;
  value: string;
  why?: string;
  fix?: string;
}

export interface OutputFacts {
  fullscreen: boolean;
  source: { width: number; height: number } | null;
  /** The film's rectangle on screen, margins excluded. */
  drawn: { width: number; height: number } | null;
  screen: {
    width: number;
    height: number;
    hdr: 'unknown' | 'unsupported' | 'off' | 'on';
    linkBits: number | null;
    linkEncoding: string | null;
    modes: DisplayMode[];
  } | null;
  /** Frames per second reaching the display (after any deinterlacing). */
  fps: number | null;
  displayHz: number | null;
  hdrSource: boolean;
  /** From `describeHdr`: what happened to the dynamic range. */
  hdrOut: 'passthrough' | 'compressed' | 'sdr' | 'unknown';
  switches: SwitchSettings;
  audio: {
    /** mpv's decoder name: truehd, dts, eac3, ac3, aac, … */
    codec: string | null;
    /** `audio-out-params/format`: `spdif-truehd` when passed through. */
    outFormat: string | null;
    inChannels: number | null;
    outChannels: number | null;
    direct: boolean;
    device: AudioDevice | null;
  } | null;
}

const res = (s: { width: number; height: number }) => `${s.width}×${s.height}`;

function sizeName(s: { width: number; height: number }): string {
  if (s.width >= 3800 || s.height >= 2000) return '4K';
  if (s.width >= 1900 || s.height >= 1000) return '1080p';
  if (s.width >= 1270 || s.height >= 700) return '720p';
  return 'SD';
}

export function checkPicture(f: OutputFacts): Check | null {
  if (!f.source || !f.drawn) return null;
  const label = 'Picture size';
  const film = sizeName(f.source);
  if (!f.fullscreen) {
    return {
      label,
      verdict: 'info',
      value: `in a window: ${res(f.source)} drawn at ${res(f.drawn)}`,
      fix: 'Fullscreen (f) shows it at the size of the screen.',
    };
  }
  // The limiting side decides: a scope film fills the width, not the height.
  const scale = Math.min(f.drawn.width / f.source.width, f.drawn.height / f.source.height);
  if (Math.abs(scale - 1) < 0.01) {
    return { label, verdict: 'native', value: `1:1 — ${res(f.source)}, every pixel as encoded` };
  }
  if (scale > 1) {
    return {
      label,
      verdict: 'info',
      value: `${film} film scaled up ×${scale.toFixed(2)} by Kinema`,
      why: 'Classical resampling (spline36): no detail invented, none sharpened in.',
      fix:
        f.switches.resolution !== 'match'
          ? 'If your TV or video processor upscales better, Settings → Screen → Resolution → Match content hands it the film at its own size.'
          : undefined,
    };
  }
  const canShow = f.screen?.modes.some(
    (m) => m.width >= f.source!.width && m.height >= f.source!.height
  );
  return {
    label,
    // Only a problem if something could change it.
    verdict: canShow ? 'limited' : 'info',
    value: `${film} film shrunk ×${scale.toFixed(2)} to fit the screen`,
    why: canShow
      ? `The desktop is set lower than the film, though the screen can show ${film}.`
      : `This screen cannot show ${film}.`,
    fix: canShow
      ? f.switches.resolution === 'off'
        ? 'Settings → Screen → Resolution → Auto switches up for films like this.'
        : 'Set the Windows desktop to the screen’s full resolution.'
      : undefined,
  };
}

export function checkHdr(f: OutputFacts): Check {
  const label = 'HDR';
  if (!f.hdrSource) return { label, verdict: 'native', value: 'SDR film, shown as SDR' };
  switch (f.hdrOut) {
    case 'passthrough':
      return { label, verdict: 'native', value: 'HDR10 as mastered — the screen tone maps it' };
    case 'compressed':
      return {
        label,
        verdict: 'limited',
        value: 'HDR, compressed to the peak Windows reports',
        why: 'The film is remapped before it reaches the screen.',
      };
    case 'sdr':
      if (f.screen?.hdr === 'off') {
        return {
          label,
          verdict: 'limited',
          value: 'HDR film shown in SDR',
          why: 'The screen can show HDR, but Windows has it switched off.',
          fix: f.switches.hdr
            ? 'Go fullscreen: HDR is switched on then (Settings → Screen).'
            : 'Settings → Screen → Turn HDR on for HDR films, or switch HDR on in Windows.',
        };
      }
      return {
        label,
        verdict: 'info',
        value: 'HDR film tone mapped for an SDR screen',
        why: 'This screen cannot show HDR; the conversion keeps the film’s look as closely as SDR allows.',
      };
    default:
      return { label, verdict: 'info', value: 'not known yet' };
  }
}

/**
 * The same rule the mode switch uses to choose a rate, so the check never
 * calls a mode "even" that the switch would not pick — a looser tolerance
 * here once named a monitor's 72 Hz mode (at 800×600) a fit for 23.976 fps.
 */
function evenCadence(fps: number, hz: number): boolean {
  return cadenceRank(hz, fps) !== null;
}

export function checkMotion(f: OutputFacts): Check | null {
  if (!f.fps || !f.displayHz) return null;
  const label = 'Motion';
  const pair = `${formatRate(f.fps)} fps on ${formatRate(f.displayHz)} Hz`;
  if (evenCadence(f.fps, f.displayHz)) {
    return { label, verdict: 'native', value: `even — ${pair}` };
  }
  const fps = f.fps;
  const fitting = (f.screen?.modes ?? [])
    .filter((m) => evenCadence(fps, m.rate))
    .sort((a, b) => b.width * b.height - a.width * a.height);
  const here = fitting.some(
    (m) => f.screen && m.width === f.screen.width && m.height === f.screen.height
  );
  const why = 'The screen’s refresh rate does not divide evenly by the film’s, so pans judder.';
  if (here) {
    return {
      label,
      verdict: 'limited',
      value: `judders — ${pair}`,
      why,
      fix: !f.switches.refresh
        ? 'Settings → Screen → Match the refresh rate: this screen has an even mode at its current resolution.'
        : !f.fullscreen
          ? 'Go fullscreen: the refresh rate is only matched there.'
          : undefined,
    };
  }
  if (fitting.length > 0) {
    const m = fitting[0]!;
    return {
      label,
      verdict: 'info',
      value: `judders — ${pair}`,
      why: `${why} This screen offers an even rate only at ${m.width}×${m.height}, and Kinema will not lower the resolution to get it.`,
    };
  }
  return {
    label,
    verdict: 'info',
    value: `judders — ${pair}`,
    why: `${why} This screen has no mode that fits the film.`,
  };
}

export function checkColourDepth(f: OutputFacts): Check | null {
  const bits = f.screen?.linkBits;
  if (!bits) return null;
  const label = 'Colour depth';
  const link = `${bits}-bit ${f.screen?.linkEncoding ?? ''}`.trim();
  if (f.hdrOut !== 'passthrough') {
    return { label, verdict: 'native', value: `${link} to the screen` };
  }
  if (bits >= 10) return { label, verdict: 'native', value: `HDR at ${link}` };
  // Whether the cable is the limit or the driver's setting. 10-bit RGB at 4K
  // does not fit HDMI 2.0 above 30 Hz; at 30 Hz and below it does, and an
  // 8-bit link there is the graphics driver's colour-depth setting — a test
  // TV at 4K 23.976 Hz stayed at 8-bit RGB with room to spare.
  const fourK = (f.screen?.width ?? 0) >= 3800;
  if (fourK && (f.displayHz ?? 0) > 31) {
    return {
      label,
      verdict: 'limited',
      value: `HDR squeezed to ${link}`,
      why:
        'HDR is made for 10 bits. At 4K above 30 Hz the cable cannot carry 10-bit RGB ' +
        '(more than HDMI 2.0 has), so the driver sends 8 bits with dithering.',
      fix: f.switches.refresh
        ? 'In the graphics driver’s settings, choose YCbCr 4:2:2 at 10 or 12 bits for this refresh rate.'
        : 'Settings → Screen → Match the refresh rate: at 23.976 Hz the cable has room for 10-bit ' +
          '(then set 10 or 12 bpc in the graphics driver’s settings). Or choose YCbCr 4:2:2 at 10/12-bit.',
    };
  }
  return {
    label,
    verdict: 'limited',
    value: `HDR squeezed to ${link}`,
    why:
      'HDR is made for 10 bits, and at this refresh rate the cable has room for it — the graphics ' +
      'driver is set to send 8 bits.',
    // Seen on a test PC: at 4K the driver offered only 8 bpc while the output
    // colour format was RGB, and 10/12 bpc once it was set to YCbCr 4:2:2 —
    // after which this check read "HDR at 10-bit YCbCr 4:2:2".
    fix:
      'In the graphics driver’s settings, set the output colour depth to 10 or 12 bpc. If only 8 is ' +
      'offered, set the output colour format to YCbCr 4:2:2 first — some drivers offer more than ' +
      '8 bits at 4K only then. Kinema cannot change either: there is no way to do that which works ' +
      'the same on every make of graphics card.',
  };
}

/** mpv's decoder name → the bitstream the device would need to take it untouched. */
function bitstreamFor(codec: string | null, device: AudioDevice | null): string | null {
  if (!codec) return null;
  const takes = (c: string) =>
    device?.bitstream.some((b) => b.codec === c && b.result === 'yes') ?? false;
  if (codec === 'truehd' || codec === 'eac3' || codec === 'ac3') return codec;
  // DTS in a file does not say whether it is core or HD MA; the device's HD
  // answer is what passthrough would use.
  if (codec === 'dts' || codec === 'dca') return takes('dts-hd') ? 'dts-hd' : 'dts';
  return null;
}

const CODEC_NAME: Record<string, string> = {
  truehd: 'Dolby TrueHD',
  eac3: 'Dolby Digital Plus',
  ac3: 'Dolby Digital',
  'dts-hd': 'DTS-HD',
  dts: 'DTS',
};

export function checkSound(f: OutputFacts): Check | null {
  const a = f.audio;
  if (!a || (!a.codec && !a.outFormat)) return null;
  const label = 'Sound';
  if (a.outFormat?.startsWith('spdif-')) {
    return {
      label,
      verdict: 'native',
      value: `untouched ${CODEC_NAME[bitstreamFor(a.codec, a.device) ?? ''] ?? a.codec} → receiver`,
      why: 'The receiver decodes it — Atmos and DTS:X included.',
    };
  }
  const stream = bitstreamFor(a.codec, a.device);
  const couldPass =
    stream !== null &&
    (a.device?.bitstream.some((b) => b.codec === stream && b.result === 'yes') ?? false);
  const folded = a.inChannels !== null && a.outChannels !== null && a.outChannels < a.inChannels;
  if (couldPass && !a.direct) {
    return {
      label,
      verdict: 'limited',
      value: `decoded by Kinema${folded ? `, folded from ${a.inChannels} to ${a.outChannels} channels` : ''}`,
      why: `${a.device?.name ?? 'The device'} takes ${CODEC_NAME[stream!] ?? stream} untouched, but the sound goes through Windows — any Atmos or DTS:X height sound is lost.`,
      fix: 'Settings → Sound → Send sound straight to the receiver.',
    };
  }
  if (folded) {
    return {
      label,
      verdict: 'limited',
      value: `folded from ${a.inChannels} to ${a.outChannels} channels`,
      why: a.direct
        ? `${a.device?.name ?? 'The device'} takes only ${a.outChannels} channels.`
        : 'Windows’ speaker setup for this device has fewer channels than the film.',
      fix: a.direct
        ? undefined
        : 'Settings → Sound → Send sound straight to the receiver, or set the speaker setup in Windows.',
    };
  }
  return {
    label,
    verdict: 'native',
    value: `decoded, all ${a.outChannels ?? ''} channels kept`.replace('all  ', 'all '),
    why:
      stream && !couldPass
        ? `${a.device?.name ?? 'The device'} does not take ${CODEC_NAME[stream] ?? stream} untouched, so it gets lossless PCM instead.`
        : undefined,
  };
}

export function outputCheck(f: OutputFacts): Check[] {
  return [checkPicture(f), checkHdr(f), checkMotion(f), checkColourDepth(f), checkSound(f)].filter(
    (c): c is Check => c !== null
  );
}
