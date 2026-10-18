/**
 * Playlists (LOCAL-MEDIA.md phase 5, `playlists.rs`): films, episodes, videos
 * and loose files in an order of the person's own.
 *
 * An entry comes back from the library as what it is *now* — a film, an
 * episode, a video, a library file with no title yet, or a loose file — and
 * [`playlistTarget`] turns it into what the player plays, carrying the
 * playlist with it, so the player's steps and Up next follow the playlist
 * (`playlist_step`) rather than the show or the folder.
 */
import { invoke } from '@tauri-apps/api/core';
import { episodeLabel, type EpisodeRef, type PlaybackTarget } from '../player/api';
import { nameOf } from './opened';
import { videoName } from './videos';

export type EntryKind = 'film' | 'episode' | 'video' | 'file' | 'loose';

export interface PlaylistEntry {
  item_id: number;
  path: string;
  file_id: number | null;
  kind: EntryKind;
  title_id: number | null;
  title: string | null;
  season: number | null;
  episode: number | null;
  episode_name: string | null;
  position_secs: number;
  duration_secs: number | null;
  completed: boolean;
  image_url: string | null;
  image_path: string | null;
  /** A library file the last scan did not find: listed, never played to. */
  missing: boolean;
}

export interface PlaylistSummary {
  id: number;
  name: string;
  count: number;
  current_item: number | null;
  image_url: string | null;
  image_path: string | null;
  updated_at: number;
}

/** What is added: a path, and its library file where it has one. */
export interface NewItem {
  path: string;
  file_id: number | null;
}

export interface Added {
  added: number;
  /** Already in the playlist, so not added twice. */
  already: number;
}

export interface Imported {
  id: number;
  name: string;
  library: number;
  loose: number;
  skipped: number;
}

export const listPlaylists = () => invoke<PlaylistSummary[]>('list_playlists');
export const playlistEntries = (playlistId: number) =>
  invoke<PlaylistEntry[]>('playlist_entries', { playlistId });
export const createPlaylist = (name: string) => invoke<number>('create_playlist', { name });
export const renamePlaylist = (playlistId: number, name: string) =>
  invoke<void>('rename_playlist', { playlistId, name });
export const deletePlaylist = (playlistId: number) => invoke<void>('delete_playlist', { playlistId });
export const addToPlaylist = (playlistId: number, items: NewItem[]) =>
  invoke<Added>('add_to_playlist', { playlistId, items });
export const removePlaylistItem = (itemId: number) => invoke<void>('remove_playlist_item', { itemId });
export const movePlaylistItem = (itemId: number, up: boolean) =>
  invoke<void>('move_playlist_item', { itemId, up });
export const setPlaylistCurrent = (playlistId: number, itemId: number) =>
  invoke<void>('set_playlist_current', { playlistId, itemId });
export const playlistStep = (playlistId: number, itemId: number, forward: boolean) =>
  invoke<PlaylistEntry | null>('playlist_step', { playlistId, itemId, forward });
export const exportPlaylist = (playlistId: number, path: string) =>
  invoke<number>('export_playlist', { playlistId, path });
export const importPlaylist = (path: string) => invoke<Imported>('import_playlist', { path });

/** What an entry is called: as the player's top line names it. */
export function entryLabel(entry: PlaylistEntry): string {
  switch (entry.kind) {
    case 'film':
      return entry.title ?? nameOf(entry.path);
    case 'episode':
      return entry.title ? episodeLabel(entry.title, entry.season, entry.episode) : nameOf(entry.path);
    case 'video':
      return videoName(nameOf(entry.path));
    default:
      return nameOf(entry.path);
  }
}

/** The entry as the player takes it, still inside its playlist. */
export function playlistTarget(entry: PlaylistEntry, playlistId: number): PlaybackTarget {
  const playlist = { id: playlistId, item: entry.item_id };
  const label = entryLabel(entry);
  switch (entry.kind) {
    case 'film':
    case 'file':
      return { path: entry.path, label, fileId: entry.file_id, titleId: entry.title_id, playlist };
    case 'episode':
      return {
        path: entry.path,
        label,
        fileId: entry.file_id,
        titleId: entry.title_id,
        episodeName: entry.episode_name,
        playlist,
      };
    case 'video':
      return { path: entry.path, label, fileId: entry.file_id, titleId: null, video: true, playlist };
    case 'loose':
      return { path: entry.path, label, fileId: null, titleId: null, resumeByPath: true, playlist };
  }
}

/**
 * The entry shaped as the player's neighbouring episode, so previous/next and
 * Up next take it as one; it plays as its own `target`, which also names it.
 */
export function entryRef(entry: PlaylistEntry, playlistId: number): EpisodeRef {
  return {
    // Unused where `target` is set; a loose file has no library id at all.
    file_id: entry.file_id ?? 0,
    path: entry.path,
    season: entry.season ?? 0,
    episode: entry.episode ?? 0,
    name: entry.episode_name,
    title: entry.title ?? '',
    video: entry.kind === 'video',
    target: playlistTarget(entry, playlistId),
  };
}

/**
 * Where the playlist's Play starts: the item last started, unless it was
 * finished — then the one after it — and the first playable item otherwise.
 * Null when nothing in it can be played.
 */
export function startEntry(entries: PlaylistEntry[], current: number | null): PlaylistEntry | null {
  const playable = (e: PlaylistEntry) => !e.missing;
  const here = current === null ? -1 : entries.findIndex((e) => e.item_id === current);
  if (here >= 0) {
    const at = entries[here];
    if (playable(at) && !at.completed) return at;
    const after = entries.slice(here + 1).find(playable);
    if (after) return after;
  }
  return entries.find(playable) ?? null;
}

/** A name for a new playlist made where nothing can be typed. */
export function defaultName(existing: PlaylistSummary[]): string {
  const names = new Set(existing.map((p) => p.name));
  for (let n = existing.length + 1; ; n++) {
    const name = n === 1 ? 'Playlist' : `Playlist ${n}`;
    if (!names.has(name)) return name;
  }
}

/** The sentence after an add: what went in, and what was there already. */
export function addedMessage(name: string, result: Added): string {
  const items = (n: number) => (n === 1 ? '1 item' : `${n} items`);
  if (result.added === 0) return `Already in ${name}`;
  const already = result.already > 0 ? ` (${items(result.already)} already there)` : '';
  return `Added ${items(result.added)} to ${name}${already}`;
}

/** The sentence after an import. */
export function importedMessage(result: Imported): string {
  const parts = [`${result.library + result.loose} added`];
  if (result.loose > 0) parts.push(`${result.loose} not in the library, kept as files`);
  if (result.skipped > 0) parts.push(`${result.skipped} left out (not found, or a web address)`);
  return `${result.name}: ${parts.join(', ')}`;
}
