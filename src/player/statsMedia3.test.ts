import { describe, expect, it } from 'vitest';
import type { PlayerFacts } from './engine';
import { media3Groups } from './statsMedia3';

const film: PlayerFacts = {
  video: {
    codec: 'hevc',
    described: 'HEVC, 3840×2160, 10-bit HDR',
    codecs: 'hvc1.2.4.L153',
    width: 3840,
    height: 2160,
    fps: 23.976,
    bitrate: 52_000_000,
    transfer: 'pq',
    dolbyVision: false,
    decoder: 'c2.vendor.hevc.decoder',
    hardware: true,
  },
  frames: { rendered: 2400, dropped: 0, skipped: 0 },
  audio: { name: 'Dolby TrueHD 7.1', channels: 8, sampleRate: 48000, way: 'untouched', decoder: null },
  bufferedSeconds: 30,
  screen: { width: 3840, height: 2160, hz: 23, rate: 23.976, hdr: ['HDR10', 'HLG'] },
};

/** Every row as "Heading / Label: value". */
const rows = (facts: PlayerFacts) =>
  media3Groups(facts).flatMap((g) => g.rows.map((r) => `${g.heading} / ${r.label}: ${r.value}`));

const row = (facts: PlayerFacts, heading: string, label: string) =>
  media3Groups(facts)
    .find((g) => g.heading === heading)
    ?.rows.find((r) => r.label === label);

describe('media3Groups', () => {
  it('says what Media3 does in its own rows', () => {
    expect(rows(film)).toEqual([
      'Source / Resolution: 3840 × 2160',
      'Source / Video: HEVC, 3840×2160, 10-bit HDR',
      'Source / Frame rate: 23.976 fps',
      'Source / Video bitrate: 52.00 Mb/s',
      'Source / Dynamic range: HDR10 (PQ)',
      'Decoding / Video decoder: c2.vendor.hevc.decoder',
      'Decoding / Frames: 2400 shown · 0 dropped',
      'Decoding / Buffered: 30.0 s ahead',
      'Display / Screen mode: 3840 × 2160 @ 23.976 Hz',
      'Display / Screen HDR: HDR10 · HLG',
      'Display / Cadence: 1:1, even',
      'Sound / Format: Dolby TrueHD 7.1',
      'Sound / Path: sent on untouched',
      'Sound / Sample rate: 48.0 kHz',
    ]);
  });

  it('warns of what costs the picture: 24p on a 60 Hz screen, software decoding, dropped frames', () => {
    const worse: PlayerFacts = {
      ...film,
      video: { ...film.video!, hardware: false },
      frames: { rendered: 2400, dropped: 12, skipped: 0 },
      screen: { width: 3840, height: 2160, hz: 60, rate: 60 },
    };
    expect(row(worse, 'Display', 'Cadence')).toMatchObject({ value: '3:2 pulldown, uneven', warn: true });
    expect(row(worse, 'Decoding', 'Video decoder')).toMatchObject({ warn: true, note: 'in software, on the processor' });
    expect(row(worse, 'Decoding', 'Frames')).toMatchObject({ value: '2400 shown · 12 dropped', warn: true });
  });

  it('with nothing open, or no sound that will play, says so rather than leaving holes', () => {
    expect(media3Groups({ screen: film.screen }).map((g) => g.heading)).toEqual(['Decoding', 'Display', 'Sound']);
    expect(row({ ...film, audio: undefined }, 'Sound', 'Format')?.value).toBe('none');
    const untagged: PlayerFacts = { ...film, video: { ...film.video!, transfer: null, fps: null } };
    expect(row(untagged, 'Source', 'Dynamic range')?.value).toBe('SDR, not tagged in the file');
    expect(row(untagged, 'Source', 'Frame rate')).toMatchObject({ value: '—', note: 'not read from this file' });
    expect(row({ ...film, audio: { ...film.audio!, way: 'decoded', decoder: 'c2.android.aac.decoder' } }, 'Sound', 'Path'))
      .toMatchObject({ value: 'decoded on this device', note: 'c2.android.aac.decoder' });
  });

  it('with one mode, says the device decides what the TV gets, and where the cadence comes from', () => {
    const one: PlayerFacts = { ...film, screen: { ...film.screen, modes: 1 } };
    expect(row(one, 'Display', 'Screen mode')?.note).toBe(
      'the only mode Android is given; the device itself decides what the TV gets, which can be more'
    );
    expect(row(one, 'Display', 'Cadence')?.note).toContain('worked out from the rate Android is given');
    expect(row({ ...film, screen: { ...film.screen, modes: 4 } }, 'Display', 'Screen mode')?.note).toBe(
      'as Android reports it'
    );
    expect(row({ ...film, screen: { ...film.screen, modes: 4 } }, 'Display', 'Cadence')?.note).not.toContain(
      'Android is given'
    );
  });

  it('says what Android says of HDR on this screen, never more', () => {
    const range = (screenHdr: string[] | undefined, video = film.video!) =>
      row({ ...film, video, screen: { ...film.screen, hdr: screenHdr } }, 'Source', 'Dynamic range');
    expect(range(['HDR10', 'HLG'])).toMatchObject({ value: 'HDR10 (PQ)', note: 'the screen takes HDR10, Android says' });
    // The box that read its TV while the TV was off (2026-10-05).
    expect(range([])).toMatchObject({
      note: 'Android says the screen takes no HDR, so the picture is turned into ordinary colour (SDR)',
      warn: true,
    });
    expect(range(['HDR10'], { ...film.video!, transfer: 'hlg' })).toMatchObject({
      value: 'HLG',
      note: 'Android says the screen takes HDR10, not HLG, so the picture is turned into ordinary colour (SDR)',
      warn: true,
    });
    expect(range(['HDR10'], { ...film.video!, dolbyVision: true })).toMatchObject({
      value: 'Dolby Vision',
      note: 'the screen takes HDR10 but not Dolby Vision, Android says',
    });
    expect(range(['HDR10'], { ...film.video!, dolbyVision: true })?.warn).toBeFalsy();
    // An SDR film asks nothing of the screen; a plugin that does not say leaves it unsaid.
    expect(range([], { ...film.video!, transfer: 'sdr' })?.note).toBeUndefined();
    expect(range(undefined)?.note).toBeUndefined();
    expect(row({ ...film, screen: { ...film.screen, hdr: [] } }, 'Display', 'Screen HDR')?.value).toBe('none');
  });
});
