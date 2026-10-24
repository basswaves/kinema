import { describe, expect, it } from 'vitest';
import { episodeRefLabel, episodeRefName, type EpisodeRef } from './api';

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

describe('episodeRefName', () => {
  const ref = (over: Partial<EpisodeRef> = {}): EpisodeRef => ({
    file_id: 1,
    path: 'D:/TV/Show/Show.S01E02.mkv',
    title: 'Show',
    season: 1,
    episode: 2,
    name: 'Pilot',
    ...over,
  });

  it('names the episode, not the show', () => {
    expect(episodeRefName(ref())).toBe('S01E02 · Pilot');
    expect(episodeRefName(ref({ name: null }))).toBe('S01E02');
  });

  it("names a playlist item's episode too", () => {
    const target = { path: 'x', label: 'Show · S01E03', episodeName: 'Second', fileId: 3, titleId: 7 };
    expect(episodeRefName(ref({ target }))).toBe('Show · S01E03 · Second');
  });
});
