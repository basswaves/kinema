import { describe, expect, it } from 'vitest';
import { averageBitrate, heavyFileNotice, likelyCodec, type DecoderLimits } from './heavyFile';

/** What the old test box reports: HEVC 35 Mbit/s. */
const LIMITS: DecoderLimits = { hevc: 35_000_000, avc: 40_000_000 };

/** A file of `mbit` Mbit/s on average over two hours. */
const TWO_HOURS = 7200;
const file = (mbit: number, extra: object = {}) => ({
  sizeBytes: (mbit * 1_000_000 * TWO_HOURS) / 8,
  durationSecs: TWO_HOURS,
  codec: 'hevc',
  ...extra,
});

describe('heavyFileNotice', () => {
  it('says the exact sentence for a file far above the limit', () => {
    expect(heavyFileNotice(file(88), LIMITS)).toBe(
      "Android says this device's video chip is made for up to 35 Mbit/s; this film averages about 88 Mbit/s. It may stutter or show no picture."
    );
  });

  it('calls an episode an episode', () => {
    expect(heavyFileNotice(file(88, { what: 'episode' }), LIMITS)).toContain('this episode averages');
  });

  it('is silent at 59 and 70, said at 80 (the test box: 59 played, 80 stuttered)', () => {
    expect(heavyFileNotice(file(59), LIMITS)).toBeNull();
    // Exactly twice the limit is not "more than twice".
    expect(heavyFileNotice(file(70), LIMITS)).toBeNull();
    expect(heavyFileNotice(file(70.5), LIMITS)).not.toBeNull();
    expect(heavyFileNotice(file(80), LIMITS)).toContain('about 80 Mbit/s');
  });

  it('rounds the average and the limit to whole Mbit/s', () => {
    expect(heavyFileNotice(file(88.4), { hevc: 34_600_000, avc: null })).toContain('up to 35 Mbit/s');
    expect(heavyFileNotice(file(88.4), LIMITS)).toContain('about 88 Mbit/s');
    expect(heavyFileNotice(file(88.6), LIMITS)).toContain('about 89 Mbit/s');
  });

  it('says nothing without a runtime or a size', () => {
    expect(heavyFileNotice(file(88, { durationSecs: null }), LIMITS)).toBeNull();
    expect(heavyFileNotice(file(88, { durationSecs: 0 }), LIMITS)).toBeNull();
    expect(heavyFileNotice(file(88, { sizeBytes: undefined }), LIMITS)).toBeNull();
    expect(heavyFileNotice(file(88, { sizeBytes: 0 }), LIMITS)).toBeNull();
  });

  it('says nothing when Android reported no limits', () => {
    expect(heavyFileNotice(file(88), null)).toBeNull();
    expect(heavyFileNotice(file(88), { hevc: null, avc: null })).toBeNull();
    // HEVC file, no HEVC decoder reported: not judged by H.264's figure.
    expect(heavyFileNotice(file(88), { hevc: null, avc: 40_000_000 })).toBeNull();
  });

  it('judges by the kind of video the file holds', () => {
    // 90 Mbit/s: over twice HEVC's 35, but not over twice a 50 for H.264.
    const limits = { hevc: 35_000_000, avc: 50_000_000 };
    expect(heavyFileNotice(file(90, { codec: 'hevc' }), limits)).toContain('up to 35 Mbit/s');
    expect(heavyFileNotice(file(90, { codec: 'h264' }), limits)).toBeNull();
    expect(heavyFileNotice(file(101, { codec: 'h264' }), limits)).toContain('up to 50 Mbit/s');
  });

  it('uses the larger limit when the kind is not known', () => {
    const limits = { hevc: 35_000_000, avc: 50_000_000 };
    const unknown = { codec: null, names: ['Example.Film.2017.mkv'] };
    expect(heavyFileNotice(file(90, unknown), limits)).toBeNull();
    expect(heavyFileNotice(file(101, unknown), limits)).toContain('up to 50 Mbit/s');
    // Only one reported: that one.
    expect(heavyFileNotice(file(90, unknown), { hevc: 35_000_000, avc: null })).toContain('35');
  });

  it('says nothing for a codec the limits do not speak of', () => {
    expect(heavyFileNotice(file(200, { codec: 'av1' }), LIMITS)).toBeNull();
  });
});

describe('likelyCodec', () => {
  it('trusts what the file says over its name', () => {
    expect(likelyCodec({ codec: 'h264', names: ['Film.2160p.HEVC.mkv'] })).toBe('avc');
    expect(likelyCodec({ codec: 'HEVC', names: ['Film.x264.mkv'] })).toBe('hevc');
    expect(likelyCodec({ codec: 'vc1' })).toBe('other');
  });

  it('reads HEVC, x265, H.265, UHD and 2160p from a name', () => {
    for (const name of [
      'Film.2017.HEVC.mkv',
      'Film.2017.x265-GRP.mkv',
      'Film.2017.H.265.mkv',
      'Film (2017) [2160p].mkv',
      'Film.2017.UHD.BluRay.REMUX.mkv',
    ]) {
      expect(likelyCodec({ names: [name] }), name).toBe('hevc');
    }
  });

  it('reads H.264, x264 and the smaller sizes as H.264, and a wide picture as HEVC', () => {
    expect(likelyCodec({ names: ['Film.2017.x264-GRP.mkv'] })).toBe('avc');
    expect(likelyCodec({ names: ['Film.2017.1080p.BluRay.mkv'] })).toBe('avc');
    expect(likelyCodec({ names: ['Film.2017.mkv'], width: 3840 })).toBe('hevc');
  });

  it('does not read a word inside a title', () => {
    expect(likelyCodec({ names: ['The.4Kids.Show.mkv', 'Lahevcx.mkv'] })).toBeNull();
  });

  it('does not know when nothing says', () => {
    expect(likelyCodec({})).toBeNull();
    expect(likelyCodec({ names: ['Film.2017.mkv'] })).toBeNull();
  });
});

describe('averageBitrate', () => {
  it('is bits over seconds', () => {
    expect(averageBitrate(1_000_000_000, 100)).toBe(80_000_000);
  });
  it('is null when either is missing', () => {
    expect(averageBitrate(null, 100)).toBeNull();
    expect(averageBitrate(100, undefined)).toBeNull();
  });
});
