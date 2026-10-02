import { describe, expect, it } from 'vitest';
import { episodeRefLabel, type EpisodeRef } from './api';

describe('episodeRefLabel', () => {
  const ref = (over: Partial<EpisodeRef> = {}): EpisodeRef => ({
    file_id: 1,
    path: 'D:\\TV\\Show\\Show.S01E02.mkv',
    title: 'Show',
    season: 1,
    episode: 2,
    name: null,
    ...over,
  });

  it('carries the show and its number into the player', () => {
    expect(episodeRefLabel(ref())).toBe('Show · S01E02');
  });

  it('pads the numbers as every other screen does', () => {
    expect(episodeRefLabel(ref({ season: 12, episode: 104 }))).toBe('Show · S12E104');
  });
});
