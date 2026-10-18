import { describe, expect, it } from 'vitest';
import {
  addedMessage,
  defaultName,
  entryLabel,
  entryRef,
  importedMessage,
  playlistTarget,
  startEntry,
  type PlaylistEntry,
  type PlaylistSummary,
} from './playlists';
import { episodeRefLabel } from '../player/api';

function entry(item_id: number, over: Partial<PlaylistEntry> = {}): PlaylistEntry {
  return {
    item_id,
    path: `C:/m/file ${item_id}.mkv`,
    file_id: item_id,
    kind: 'film',
    title_id: 7,
    title: 'A Film',
    season: null,
    episode: null,
    episode_name: null,
    position_secs: 0,
    duration_secs: null,
    completed: false,
    image_url: null,
    image_path: null,
    missing: false,
    ...over,
  };
}

describe('playlists', () => {
  it('names each kind as the player would', () => {
    expect(entryLabel(entry(1))).toBe('A Film');
    expect(entryLabel(entry(2, { kind: 'episode', title: 'A Show', season: 1, episode: 2 }))).toBe(
      'A Show · S01E02'
    );
    expect(entryLabel(entry(3, { kind: 'video', path: 'D:/v/Garden_party.mov' }))).toBe('Garden party');
    expect(entryLabel(entry(4, { kind: 'loose', path: 'E:/x/clip.mp4', file_id: null }))).toBe('clip');
  });

  it('plays an entry inside its playlist, as what it is', () => {
    const loose = playlistTarget(entry(4, { kind: 'loose', file_id: null, title_id: null }), 9);
    expect(loose).toMatchObject({ fileId: null, resumeByPath: true, playlist: { id: 9, item: 4 } });
    const video = playlistTarget(entry(5, { kind: 'video', title_id: null }), 9);
    expect(video).toMatchObject({ fileId: 5, video: true, titleId: null });
    const episode = playlistTarget(entry(6, { kind: 'episode', episode_name: 'Pilot' }), 9);
    expect(episode).toMatchObject({ fileId: 6, titleId: 7, episodeName: 'Pilot' });
  });

  it('gives Up next the entry under its own name', () => {
    const ref = entryRef(entry(1), 9);
    expect(ref.target?.playlist).toEqual({ id: 9, item: 1 });
    expect(episodeRefLabel(ref)).toBe('A Film');
  });

  it('carries on at the last item, past it once finished, else from the first playable', () => {
    const items = [entry(1, { missing: true }), entry(2), entry(3)];
    expect(startEntry(items, null)?.item_id).toBe(2);
    expect(startEntry(items, 3)?.item_id).toBe(3);
    const done = [entry(1), entry(2, { completed: true }), entry(3)];
    expect(startEntry(done, 2)?.item_id).toBe(3);
    expect(startEntry([entry(1), entry(2, { completed: true })], 2)?.item_id).toBe(1);
    expect(startEntry([entry(1, { missing: true })], null)).toBeNull();
  });

  it('names a new playlist that has no name yet', () => {
    const lists = (names: string[]) => names.map((name, id) => ({ id, name }) as PlaylistSummary);
    expect(defaultName([])).toBe('Playlist');
    expect(defaultName(lists(['Evening']))).toBe('Playlist 2');
    expect(defaultName(lists(['Playlist 2', 'x']))).toBe('Playlist 3');
  });

  it('says what an add and an import did', () => {
    expect(addedMessage('Evening', { added: 3, already: 1 })).toBe(
      'Added 3 items to Evening (1 item already there)'
    );
    expect(addedMessage('Evening', { added: 0, already: 1 })).toBe('Already in Evening');
    expect(importedMessage({ id: 1, name: 'Trip', library: 2, loose: 1, skipped: 1 })).toBe(
      'Trip: 3 added, 1 not in the library, kept as files, 1 left out (not found, or a web address)'
    );
  });
});
