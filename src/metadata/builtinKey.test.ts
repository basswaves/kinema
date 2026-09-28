import { describe, expect, it } from 'vitest';
import { chooseTmdbKey } from './builtinKey';

describe('which TMDB key is used', () => {
  it('prefers a key entered in Settings', () => {
    expect(chooseTmdbKey(' mine ', 'built-in')).toEqual({ key: 'mine', source: 'own' });
  });

  it('falls back to the built-in key when Settings has none', () => {
    expect(chooseTmdbKey(null, 'built-in')).toEqual({ key: 'built-in', source: 'builtin' });
    expect(chooseTmdbKey('   ', 'built-in')).toEqual({ key: 'built-in', source: 'builtin' });
  });

  it('has nothing to offer in a build without one', () => {
    expect(chooseTmdbKey('', null)).toBeNull();
  });
});
