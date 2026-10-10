import { describe, expect, it } from 'vitest';
import { BASE_MPV_OPTIONS, cacheOptions, shaderCacheOptions } from './mpvOptions';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe('cacheOptions', () => {
  it('asks for a cache on every file and a 4 MiB read size', () => {
    const o = cacheOptions(16 * GiB);
    expect(o.cache).toBe('yes');
    expect(o['stream-buffer-size']).toBe(String(4 * MiB));
  });

  it('reads ahead a sixteenth of the memory, between 256 MiB and 1 GiB', () => {
    expect(cacheOptions(8 * GiB)['demuxer-max-bytes']).toBe(String(512 * MiB));
    expect(cacheOptions(2 * GiB)['demuxer-max-bytes']).toBe(String(256 * MiB));
    expect(cacheOptions(64 * GiB)['demuxer-max-bytes']).toBe(String(1 * GiB));
  });

  it('keeps at least 256 MiB behind, and half of what it reads ahead', () => {
    expect(cacheOptions(2 * GiB)['demuxer-max-back-bytes']).toBe(String(256 * MiB));
    expect(cacheOptions(64 * GiB)['demuxer-max-back-bytes']).toBe(String(512 * MiB));
  });

  it('assumes the least when the memory is unknown', () => {
    for (const unknown of [0, -1, NaN]) {
      expect(cacheOptions(unknown)['demuxer-max-bytes']).toBe(String(256 * MiB));
    }
  });
});

describe('shaderCacheOptions', () => {
  it('names the folder it is given', () => {
    expect(shaderCacheOptions('/data/shadercache')).toEqual({
      'gpu-shader-cache': 'yes',
      'gpu-shader-cache-dir': '/data/shadercache',
    });
  });

  it('leaves mpv to its default when there is no folder', () => {
    expect(shaderCacheOptions(undefined)).toEqual({});
    expect(shaderCacheOptions('')).toEqual({});
  });
});

describe('the log', () => {
  it('stays first in the init options, so a rejected option is recorded', () => {
    expect(Object.keys(BASE_MPV_OPTIONS).slice(0, 2)).toEqual(['log-file', 'msg-level']);
  });
});
