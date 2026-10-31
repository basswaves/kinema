import { describe, expect, it } from 'vitest';
import { moveWords } from './moving';

describe('moveWords', () => {
  it('says what came over and asks for a new sign-in', () => {
    const words = moveWords({
      history: 3,
      chosen: 0,
      hand_applied: 1,
      hand_waiting: 2,
      playlists: 1,
      settings: 9,
    });
    expect(words).toContain('3 watched or begun films and episodes');
    expect(words).toContain('1 playlist');
    expect(words).toContain('1 file set aside by hand');
    expect(words).toContain('2 matches made by hand wait for their files');
    expect(words).toContain('Sign in to SIMKL or Trakt again');
  });
});
