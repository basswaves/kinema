import { describe, expect, it } from 'vitest';
import {
  CONFIRM_MS,
  cannotDecodeNotice,
  confirmNoFrames,
  isNoPictureNotice,
  otherSoundPlays,
  parseDecoders,
  parseReaderPts,
  pictureVerdict,
  soundGap,
  type TrackFacts,
} from './decodeCheck';

const track = (t: Partial<TrackFacts> & { type: string; id: number }): TrackFacts => ({
  selected: false,
  codec: null,
  albumart: false,
  profile: null,
  ...t,
});

// A system's own "free" build: no HEVC, no E-AC-3, H.264 through OpenH264.
const FREE = new Set(['h264', 'aac', 'flac', 'opus', 'ac3', 'vp9', 'av1']);
const FULL = new Set([...FREE, 'hevc', 'eac3', 'dts', 'truehd']);

const at = (over: Partial<Parameters<typeof pictureVerdict>[0]>) =>
  pictureVerdict({ tracks: [], gamma: null, timePos: 0, readerPts: 0.2, decoders: FREE, ...over });

describe('parseDecoders', () => {
  it("reads mpv's decoder-list as it prints it", () => {
    const text = JSON.stringify([
      { codec: 'aasc', driver: 'aasc', description: 'Autodesk RLE' },
      { codec: 'h264', driver: 'libopenh264', description: 'OpenH264' },
    ]);
    expect([...(parseDecoders(text) ?? [])]).toEqual(['aasc', 'h264']);
  });

  it('knows nothing from nothing', () => {
    expect(parseDecoders(null)).toBeNull();
    expect(parseDecoders('')).toBeNull();
    expect(parseDecoders('not json')).toBeNull();
    expect(parseDecoders('[]')).toBeNull();
    expect(parseDecoders('{"codec":"h264"}')).toBeNull();
  });
});

describe('parseReaderPts', () => {
  it('reads the reader position, and nothing else', () => {
    expect(parseReaderPts('{"reader-pts":39.958,"cache-end":39.958}')).toBe(39.958);
    expect(parseReaderPts('{"cache-end":3}')).toBeNull();
    expect(parseReaderPts(null)).toBeNull();
    expect(parseReaderPts('{')).toBeNull();
  });
});

describe('pictureVerdict', () => {
  const hevc = track({ type: 'video', id: 1, codec: 'hevc' });
  const aac = track({ type: 'audio', id: 1, codec: 'aac', selected: true });

  it('waits while the file is not open yet', () => {
    expect(at({ tracks: [] })).toEqual({ state: 'coming' });
  });

  it('a picture that came wins over everything', () => {
    expect(at({ tracks: [hevc, aac], gamma: 'bt.1886' })).toEqual({ state: 'shown' });
  });

  it('a file with no video track has no picture to wait for (A3-05)', () => {
    expect(at({ tracks: [aac] })).toEqual({ state: 'none', gap: null });
  });

  it('a cover picture is a picture', () => {
    const cover = track({ type: 'video', id: 1, codec: 'mjpeg', albumart: true, selected: true });
    expect(at({ tracks: [cover, aac] })).toEqual({ state: 'coming' });
  });

  it('a dropped track with no decoder for it is said (A3-01)', () => {
    expect(at({ tracks: [hevc, aac] })).toEqual({
      state: 'none',
      gap: { kind: 'video', codec: 'hevc', profile: null, why: 'no-decoder' },
    });
  });

  it('a dropped track whose decoder exists ends the wait, with no reason made up', () => {
    expect(at({ tracks: [hevc, aac], decoders: FULL })).toEqual({ state: 'none', gap: null });
    expect(at({ tracks: [hevc, aac], decoders: null })).toEqual({ state: 'none', gap: null });
  });

  it('a decoder that turns out nothing shows as the reader running away (A3-01)', () => {
    const hi10 = track({ type: 'video', id: 1, codec: 'h264', profile: 'High 10', selected: true });
    expect(at({ tracks: [hi10, aac], timePos: 0, readerPts: 39.958 })).toEqual({
      state: 'none',
      gap: { kind: 'video', codec: 'h264', profile: 'High 10', why: 'no-frames' },
    });
    // From a resume point, the distance counts, not the position.
    expect(at({ tracks: [hi10, aac], timePos: 600, readerPts: 600.6 })).toEqual({ state: 'coming' });
  });

  it('a short file shows it as the reader reaching the end with no picture', () => {
    const tenBit = track({ type: 'video', id: 1, codec: 'h264', selected: true });
    expect(at({ tracks: [tenBit, aac], timePos: 0, readerPts: 3.958, duration: 4.021 })).toEqual({
      state: 'none',
      gap: { kind: 'video', codec: 'h264', profile: null, why: 'no-frames' },
    });
    // Resumed in the last second: the reader is at the end, but not ahead.
    expect(at({ tracks: [tenBit, aac], timePos: 3.5, readerPts: 3.958, duration: 4.021 })).toEqual({
      state: 'coming',
    });
  });

  it('a decoder still waiting for its first frame is left to wait', () => {
    const h264 = track({ type: 'video', id: 1, codec: 'h264', selected: true });
    expect(at({ tracks: [h264, aac], readerPts: 0.19 })).toEqual({ state: 'coming' });
    expect(at({ tracks: [h264, aac], readerPts: null })).toEqual({ state: 'coming' });
    expect(at({ tracks: [h264, aac], timePos: null, readerPts: 40 })).toEqual({ state: 'coming' });
  });
});

describe('soundGap', () => {
  const eac3 = track({ type: 'audio', id: 1, codec: 'eac3' });
  const aac = track({ type: 'audio', id: 2, codec: 'aac' });

  it('names a track with no decoder (A3-02)', () => {
    expect(soundGap([eac3, aac], 1, FREE)).toEqual({
      kind: 'audio',
      codec: 'eac3',
      profile: null,
      why: 'no-decoder',
    });
    expect(otherSoundPlays([eac3, aac], 1, FREE)).toBe(true);
    expect(otherSoundPlays([eac3], 1, FREE)).toBe(false);
  });

  it('leaves a decodable track to the output fallbacks', () => {
    expect(soundGap([eac3, aac], 2, FREE)).toBeNull();
    expect(soundGap([eac3], 1, FULL)).toBeNull();
    expect(soundGap([eac3], 1, null)).toBeNull();
  });
});

describe('cannotDecodeNotice', () => {
  const hevc = { kind: 'video', codec: 'hevc', profile: null, why: 'no-decoder' } as const;
  const hi10 = { kind: 'video', codec: 'h264', profile: 'High 10', why: 'no-frames' } as const;
  const eac3 = { kind: 'audio', codec: 'eac3', profile: null, why: 'no-decoder' } as const;

  it('says what cannot be decoded, plainly', () => {
    const words = cannotDecodeNotice([hevc], 'Linux') ?? '';
    expect(words).toMatch(/^This system cannot decode HEVC video, so there is no picture\./);
    expect(words).toContain('RPM Fusion');
    expect(isNoPictureNotice(words)).toBe(true);
  });

  it('names the profile a decoder failed on, and does not call the format left out', () => {
    const words = cannotDecodeNotice([hi10], 'Linux') ?? '';
    expect(words).toContain('could not decode this H.264 video (High 10), so there is no picture.');
    expect(words).toContain('decode H.264 only in part');
    expect(words).not.toContain('leave H.264 out');
    expect(isNoPictureNotice(words)).toBe(true);
    const plain = cannotDecodeNotice([{ ...hi10, profile: null }], 'Linux') ?? '';
    expect(plain).toMatch(/^This system could not decode this H\.264 video, so there is no picture\./);
    expect(isNoPictureNotice(plain)).toBe(true);
  });

  it('says picture and sound in one notice', () => {
    const words = cannotDecodeNotice([hevc, eac3], 'Linux') ?? '';
    expect(words).toContain('It cannot decode the E-AC-3 sound either.');
    expect(words).toContain('leave HEVC and E-AC-3 out');
  });

  it('sound alone is not a no-picture notice, and points to another track', () => {
    const words = cannotDecodeNotice([eac3], 'Linux', true) ?? '';
    expect(words).toContain('cannot decode E-AC-3 sound, so this track plays silent.');
    expect(words).toContain('Another sound track');
    expect(isNoPictureNotice(words)).toBe(false);
    expect(isNoPictureNotice('Linux would not take surround sound, so this is playing in stereo.')).toBe(false);
  });

  it('points to a full build only where the libraries are the system’s and the format is one left out', () => {
    expect(cannotDecodeNotice([hevc], 'Windows')).not.toContain('RPM Fusion');
    const vp9 = { kind: 'video', codec: 'vp9', profile: null, why: 'no-decoder' } as const;
    expect(cannotDecodeNotice([vp9], 'Linux')).toBe(
      'This system cannot decode VP9 video, so there is no picture.'
    );
  });

  it('says nothing when nothing is missing', () => {
    expect(cannotDecodeNotice([], 'Linux')).toBeNull();
  });
});

describe('confirmNoFrames', () => {
  const noFrames = {
    state: 'none',
    gap: { kind: 'video', codec: 'h264', profile: null, why: 'no-frames' },
  } as const;
  const noDecoder = {
    state: 'none',
    gap: { kind: 'video', codec: 'hevc', profile: null, why: 'no-decoder' },
  } as const;

  it('believes "no frames" only once it has held, so a skip to a keyframe is not taken for it', () => {
    let s = confirmNoFrames(noFrames, 'a.ts', null, 1000);
    expect(s.verdict).toEqual({ state: 'coming' });
    s = confirmNoFrames(noFrames, 'a.ts', s.suspicion, 1000 + CONFIRM_MS - 1);
    expect(s.verdict).toEqual({ state: 'coming' });
    s = confirmNoFrames(noFrames, 'a.ts', s.suspicion, 1000 + CONFIRM_MS);
    expect(s.verdict).toEqual(noFrames);
  });

  it('starts again after a picture, or for another file', () => {
    let s = confirmNoFrames(noFrames, 'a.ts', null, 0);
    s = confirmNoFrames({ state: 'shown' }, 'a.ts', s.suspicion, 1000);
    expect(s.suspicion).toBeNull();
    s = confirmNoFrames(noFrames, 'a.ts', s.suspicion, 2000);
    expect(confirmNoFrames(noFrames, 'a.ts', s.suspicion, 2000 + CONFIRM_MS - 1).verdict).toEqual({
      state: 'coming',
    });
    s = confirmNoFrames(noFrames, 'a.ts', null, 0);
    expect(confirmNoFrames(noFrames, 'b.ts', s.suspicion, CONFIRM_MS).verdict).toEqual({
      state: 'coming',
    });
  });

  it('passes what is certain at once: no decoder, no video track', () => {
    expect(confirmNoFrames(noDecoder, 'a.ts', null, 0).verdict).toEqual(noDecoder);
    const none = { state: 'none', gap: null } as const;
    expect(confirmNoFrames(none, 'a.ts', null, 0).verdict).toEqual(none);
  });
});
