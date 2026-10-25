import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../ui/badges';
import type { Release } from './release';
import {
  bestFit,
  groupVersions,
  nameVersions,
  pickVersion,
  sizeWords,
  type FileRead,
  type Version,
  type VersionFile,
} from './versions';

const GB = 1e9;

function read(
  id: number,
  width: number,
  height: number,
  opts: { hdr?: boolean; codec?: string; editions?: string[]; size?: number; path?: string } = {}
): FileRead {
  const facts = {
    details: {
      video: {
        width,
        height,
        interlaced: false,
        codec: opts.codec ?? 'hevc',
        transfer: opts.hdr ? 'pq' : 'bt709',
        dolby_vision: null,
        hdr10_plus: false,
      },
    },
  } as unknown as FileFacts;
  const release = { editions: opts.editions ?? [], source: null, disc: false } as unknown as Release;
  return {
    file: { file_id: id, path: opts.path ?? `C:\\f\\${id}.mkv`, size_bytes: opts.size ?? 10 * GB },
    facts,
    release,
  };
}

const uhdHdr = () => read(1, 3840, 2160, { hdr: true, size: 58 * GB });
const fullHd = () => read(2, 1920, 1080, { codec: 'h264', size: 12 * GB });

describe('nameVersions', () => {
  it("names each in Kinema's words with the size", () => {
    const [a, b] = nameVersions([
      uhdHdr(),
      read(2, 1920, 800, { editions: ["Director's Cut"], size: 9.4 * GB }),
    ]);
    expect(a.words).toBe('4K UHD · HDR10 · 58 GB');
    expect(a.key).toBe('4K UHD · HDR10');
    expect(b.words).toBe("1080p · Director's Cut · 9.4 GB");
  });

  it('tells alike ones apart by codec, then by the file name', () => {
    const byCodec = nameVersions([read(1, 1920, 1080), read(2, 1920, 1080, { codec: 'h264' })]);
    expect(byCodec.map((v) => v.key)).toEqual(['1080p · HEVC', '1080p · AVC']);
    const byName = nameVersions([
      read(1, 1920, 1080, { path: 'C:\\f\\A Film 1080p.mkv' }),
      read(2, 1920, 1080, { path: '/f/A Film Final Cut 1080p.mkv' }),
    ]);
    expect(byName.map((v) => v.key)).toEqual([
      '1080p · HEVC · A Film 1080p',
      '1080p · HEVC · A Film Final Cut 1080p',
    ]);
  });
});

describe('bestFit', () => {
  const both = (): Version[] => nameVersions([fullHd(), uhdHdr()]);

  it('takes the biggest picture where the screen is not known', () => {
    expect(bestFit(both(), null)?.file_id).toBe(1);
  });

  it('takes what a 1080p screen can show whole', () => {
    expect(bestFit(both(), { width: 1920, height: 1080, hdr: true })?.file_id).toBe(2);
  });

  it('takes 4K HDR on a 4K HDR screen', () => {
    expect(bestFit(both(), { width: 3840, height: 2160, hdr: true })?.file_id).toBe(1);
  });

  it('keeps HDR off a screen that cannot show it', () => {
    const v = nameVersions([read(1, 3840, 2160, { hdr: true }), read(2, 3840, 2160)]);
    expect(bestFit(v, { width: 3840, height: 2160, hdr: false })?.file_id).toBe(2);
    expect(bestFit(v, { width: 3840, height: 2160, hdr: true })?.file_id).toBe(1);
  });
});

describe('pickVersion', () => {
  const screen = { width: 3840, height: 2160, hdr: true };

  it('uses the file picked last time, then the same words, then the best fit', () => {
    const v = nameVersions([fullHd(), uhdHdr()]);
    expect(pickVersion(v, { path: 'C:\\f\\2.mkv', key: 'x' }, screen)?.file_id).toBe(2);
    expect(pickVersion(v, { path: 'gone.mkv', key: '1080p' }, screen)?.file_id).toBe(2);
    expect(pickVersion(v, { path: 'gone.mkv', key: '720p' }, screen)?.file_id).toBe(1);
    expect(pickVersion(v, null, screen)?.file_id).toBe(1);
  });
});

describe('groupVersions', () => {
  it('keeps only films and episodes here more than once', () => {
    const f = (file_id: number, season: number | null, episode: number | null): VersionFile => ({
      file_id,
      path: `${file_id}`,
      size_bytes: 1,
      season,
      episode,
      episode_last: null,
    });
    const groups = groupVersions([f(1, 1, 1), f(2, 1, 1), f(3, 1, 2)]);
    expect([...groups.keys()]).toEqual(['1:1']);
    expect(groupVersions([f(1, null, null), f(2, null, null)]).get('film')?.length).toBe(2);
  });
});

it('says sizes in GB or MB', () => {
  expect(sizeWords(58e9)).toBe('58 GB');
  expect(sizeWords(9.42e9)).toBe('9.4 GB');
  expect(sizeWords(700e6)).toBe('700 MB');
});
