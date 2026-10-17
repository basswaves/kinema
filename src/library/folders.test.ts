import { describe, expect, it } from 'vitest';
import { joinPath, rootHolding, separatorOf, typedAddress } from './folders';

describe('paths in Library → Folders', () => {
  it('keeps the separator the place is written with', () => {
    expect(separatorOf('C:\\')).toBe('\\');
    expect(separatorOf('\\\\nas\\films')).toBe('\\');
    expect(separatorOf('/home/me')).toBe('/');
    expect(separatorOf('smb://nas/films')).toBe('/');
  });

  it('joins names below a drive, a folder and a share', () => {
    expect(joinPath('C:\\', ['Films', 'A film (2001)'])).toBe('C:\\Films\\A film (2001)');
    expect(joinPath('\\\\nas\\films', ['A film.mkv'])).toBe('\\\\nas\\films\\A film.mkv');
    expect(joinPath('/', ['mnt', 'tv'])).toBe('/mnt/tv');
    expect(joinPath('/storage/1A2B-3C4D', [])).toBe('/storage/1A2B-3C4D');
    expect(joinPath('smb://nas/tv', ['Show'])).toBe('smb://nas/tv/Show');
  });

  it('reads a typed network address as Windows does', () => {
    expect(typedAddress('  //nas/films/ ')).toBe('\\\\nas\\films');
    expect(typedAddress('\\\\nas\\films\\')).toBe('\\\\nas\\films');
    expect(typedAddress('/mnt/films')).toBe('/mnt/films');
    expect(typedAddress('   ')).toBe('');
  });

  it('finds the library folder a folder is in, and no other', () => {
    const roots = [
      { path: 'D:/Videos', kind: 'videos' },
      { path: 'C:\\Films', kind: 'movies' },
      { path: '/srv/tv', kind: 'tv' },
    ];
    expect(rootHolding(roots, 'd:\\videos\\Summer')?.kind).toBe('videos');
    expect(rootHolding(roots, 'C:\\Films')?.kind).toBe('movies');
    expect(rootHolding(roots, 'C:\\Films 2')).toBeNull();
    expect(rootHolding(roots, 'C:\\')).toBeNull();
    expect(rootHolding(roots, '/srv/tv/Show')?.kind).toBe('tv');
    // Linux minds the case.
    expect(rootHolding(roots, '/srv/TV/Show')).toBeNull();
  });
});
