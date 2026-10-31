/**
 * Library → Playlists, and one playlist (LOCAL-MEDIA.md phase 5,
 * `playlists.rs`).
 *
 * The Playlists page holds a tile per playlist, the newest-touched first, a
 * New playlist, and — where the system has a file picker (desktops) — an
 * `.m3u` to import. A playlist's page plays it (carrying on at the item last
 * started), renames, exports and deletes it, and lists its items, each with
 * Play, Up, Down and Remove. Played from here, previous/next and Up next
 * follow the playlist (useNeighbours.ts).
 */
import { FocusContext, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useState } from 'react';
import Art from './Art';
import ConfirmButton from './ConfirmButton';
import FocusButton from './FocusButton';
import FocusGroup, { FocusProvider } from './FocusGroup';
import { useNavGroup } from './focusGroups';
import FocusInput from './FocusInput';
import { useClaimFocus } from './focus';
import { count } from './format';
import { userError } from './errors';
import RailTrack from './RailTrack';
import { useCapabilities } from '../capabilities';
import type { PlaybackTarget } from '../player/api';
import {
  createPlaylist,
  deletePlaylist,
  entryLabel,
  exportPlaylist,
  importedMessage,
  importPlaylist,
  listPlaylists,
  movePlaylistItem,
  playlistEntries,
  playlistStep,
  playlistTarget,
  removePlaylistItem,
  renamePlaylist,
  setPlaylistMode,
  startEntry,
  type PlaylistEntry,
  type PlaylistSummary,
} from '../library/playlists';

const PLAYLISTS_FOCUS_KEY = 'playlists-page';
const PLAYLIST_FOCUS_KEY = 'playlist-page';
const playlistTileKey = (id: number) => `playlist:${id}`;
const NEW_KEY = 'playlists:new';
const NEW_NAME_KEY = 'playlists:new-name';
const PLAY_KEY = 'playlist:play';
const RENAME_KEY = 'playlist:rename';
const RENAME_INPUT_KEY = 'playlist:rename-input';
const M3U = [{ name: 'Playlist', extensions: ['m3u', 'm3u8'] }];

/** A playlist's tile, here and on Home's rail. */
export function PlaylistTile({
  list,
  focusKey,
  onSelect,
}: {
  list: PlaylistSummary;
  focusKey?: string;
  onSelect: () => void;
}) {
  return (
    <FocusButton focusKey={focusKey} label={list.name} className="video-tile playlist-tile" onSelect={onSelect}>
      <span className="video-tile-art">
        <Art
          local={list.image_path}
          remote={list.image_url}
          lazy
          fallback={<span className="video-tile-plain">≡</span>}
        />
      </span>
      <span className="video-tile-name">{list.name}</span>
      <span className="video-tile-date">{count(list.count, 'item')}</span>
    </FocusButton>
  );
}

export function PlaylistsPage({
  onOpen,
  onBack,
}: {
  onOpen: (id: number) => void;
  onBack: () => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: PLAYLISTS_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  const can = useCapabilities();
  const [lists, setLists] = useState<PlaylistSummary[] | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    listPlaylists()
      .then(setLists)
      .catch((e) => setNote(userError(e)));
  }, []);
  useEffect(load, [load]);

  const first = lists?.[0];
  useClaimFocus(first ? playlistTileKey(first.id) : NEW_KEY, lists !== null, true);
  // Into the field as it opens, not on every letter typed into it.
  const namingOpen = naming !== null;
  useEffect(() => {
    if (namingOpen) void setFocus(NEW_NAME_KEY);
  }, [namingOpen]);

  const make = (name: string) => {
    createPlaylist(name.trim() || 'Playlist')
      .then((id) => {
        setNaming(null);
        onOpen(id);
      })
      .catch((e) => setNote(userError(e)));
  };

  const importList = () => {
    void open({ multiple: false, directory: false, filters: M3U })
      .then((path) => {
        if (typeof path !== 'string') return;
        return importPlaylist(path).then((result) => {
          setNote(importedMessage(result));
          load();
        });
      })
      .catch((e) => setNote(userError(e)));
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="search playlists-page" ref={ref}>
        <div className="grid-head">
          <FocusButton className="back-button" keepInView="page-top" onSelect={onBack}>
            ← Back
          </FocusButton>
          <h2 className="grid-heading">Playlists</h2>
        </div>
        <div className="videos-tiles">
          {lists?.map((list) => (
            <PlaylistTile
              key={list.id}
              list={list}
              focusKey={playlistTileKey(list.id)}
              onSelect={() => onOpen(list.id)}
            />
          ))}
        </div>
        {lists !== null && lists.length === 0 && (
          <p className="muted library-empty">
            No playlists yet. Make one here, or press + Playlist on a film, a show or a group of
            videos; in the player, Audio &amp; subtitles has Add to a playlist.
          </p>
        )}
        <div className="settings-row">
          {naming === null ? (
            <FocusButton focusKey={NEW_KEY} className="btn-secondary" onSelect={() => setNaming('')}>
              + New playlist
            </FocusButton>
          ) : (
            <>
              <FocusInput
                focusKey={NEW_NAME_KEY}
                className="playlist-name-input"
                value={naming}
                onChange={setNaming}
                onEnter={() => make(naming)}
                placeholder="Name"
              />
              <FocusButton className="btn-primary" onSelect={() => make(naming)}>
                Make it
              </FocusButton>
            </>
          )}
          {can?.folder_picker && (
            <FocusButton className="btn-secondary" onSelect={importList}>
              Import .m3u…
            </FocusButton>
          )}
        </div>
        {note && <p className="muted">{note}</p>}
      </div>
    </FocusContext.Provider>
  );
}

export function PlaylistPage({
  id,
  onPlay,
  onBack,
}: {
  id: number;
  onPlay: (target: PlaybackTarget) => void;
  onBack: () => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: PLAYLIST_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  const can = useCapabilities();
  const [list, setList] = useState<PlaylistSummary | null>(null);
  const [entries, setEntries] = useState<PlaylistEntry[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([listPlaylists(), playlistEntries(id)])
        .then(([lists, items]) => {
          setList(lists.find((l) => l.id === id) ?? null);
          setEntries(items);
        })
        .catch((e) => setNote(userError(e))),
    [id]
  );
  useEffect(() => {
    void load();
  }, [load]);

  const start = entries && list ? startEntry(entries, list.current_item) : null;
  useClaimFocus(start ? PLAY_KEY : 'playlist:back', entries !== null, true);
  const renamingOpen = renaming !== null;
  useEffect(() => {
    if (renamingOpen) void setFocus(RENAME_INPUT_KEY);
  }, [renamingOpen]);

  const saveName = () => {
    if (renaming === null) return;
    renamePlaylist(id, renaming)
      .then(() => {
        void setFocus(RENAME_KEY);
        setRenaming(null);
        void load();
      })
      .catch((e) => setNote(userError(e)));
  };

  // Shuffled, Play carries on with the item started last if it was left part
  // way, and otherwise takes the next one in the shuffled round.
  const play = () => {
    if (!start || !list) return;
    const carryOn = start.item_id === list.current_item;
    const next = list.shuffle && !carryOn ? playlistStep(id, list.current_item ?? 0, true) : null;
    void Promise.resolve(next)
      .catch(() => null)
      .then((entry) => onPlay(playlistTarget(entry ?? start, id)));
  };

  const setMode = (mode: { shuffle: boolean; repeat: boolean }) => {
    setPlaylistMode(id, mode)
      .then(load)
      .catch((e) => setNote(userError(e)));
  };

  const exportList = () => {
    if (!list) return;
    void save({ defaultPath: `${list.name}.m3u`, filters: M3U })
      .then((path) => {
        if (!path) return;
        return exportPlaylist(id, path).then((n) => setNote(`${count(n, 'item')} written to ${path}`));
      })
      .catch((e) => setNote(userError(e)));
  };

  // After Up, Down or Remove the ring stays on the same kind of control, on
  // the row it moved to (or the row that took the removed one's place).
  const change = (action: Promise<void>, landOn: string | null) => {
    action
      .then(load)
      .then(() => {
        if (landOn) void setFocus(landOn);
      })
      .catch((e) => setNote(userError(e)));
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="search playlist-page" ref={ref}>
        <div className="grid-head">
          <FocusButton focusKey="playlist:back" className="back-button" keepInView="page-top" onSelect={onBack}>
            ← Back
          </FocusButton>
          <h2 className="grid-heading">
            {list?.name ?? ''} <span className="muted">{entries?.length ?? ''}</span>
          </h2>
        </div>

        <FocusGroup kind="row" className="detail-actions playlist-actions">
          {renaming !== null ? (
            <>
              <FocusInput
                focusKey={RENAME_INPUT_KEY}
                className="playlist-name-input"
                value={renaming}
                onChange={setRenaming}
                onEnter={saveName}
                placeholder="Name"
              />
              <FocusButton className="btn-primary" onSelect={saveName}>
                Save
              </FocusButton>
              <FocusButton
                className="btn-secondary"
                onSelect={() => {
                  void setFocus(RENAME_KEY);
                  setRenaming(null);
                }}
              >
                Cancel
              </FocusButton>
            </>
          ) : (
            <>
              {start && (
                <FocusButton focusKey={PLAY_KEY} className="btn-primary" onSelect={play}>
                  {start.item_id === list?.current_item ? `▶ Carry on: ${entryLabel(start)}` : '▶ Play'}
                </FocusButton>
              )}
              {list && entries && entries.length > 1 && (
                <FocusButton
                  className={`btn-secondary ${list.shuffle ? 'active' : ''}`}
                  onSelect={() => setMode({ shuffle: !list.shuffle, repeat: list.repeat })}
                >
                  {`Shuffle: ${list.shuffle ? 'On' : 'Off'}`}
                </FocusButton>
              )}
              {list && entries && entries.length > 0 && (
                <FocusButton
                  className={`btn-secondary ${list.repeat ? 'active' : ''}`}
                  onSelect={() => setMode({ shuffle: list.shuffle, repeat: !list.repeat })}
                >
                  {`Repeat: ${list.repeat ? 'On' : 'Off'}`}
                </FocusButton>
              )}
              <FocusButton focusKey={RENAME_KEY} className="btn-secondary" onSelect={() => setRenaming(list?.name ?? '')}>
                Rename
              </FocusButton>
              {can?.folder_picker && entries && entries.length > 0 && (
                <FocusButton className="btn-secondary" onSelect={exportList}>
                  Export .m3u…
                </FocusButton>
              )}
              <ConfirmButton
                className="btn-secondary"
                confirmLabel="Delete the playlist?"
                onConfirm={() => void deletePlaylist(id).then(onBack).catch((e) => setNote(userError(e)))}
              >
                Delete
              </ConfirmButton>
            </>
          )}
        </FocusGroup>
        {note && <p className="muted">{note}</p>}

        {entries !== null && entries.length === 0 && (
          <p className="muted">
            Nothing in it yet. Press + Playlist on a film, a show or a group of videos, or Add to a
            playlist in the player&apos;s Audio &amp; subtitles.
          </p>
        )}
        <div className="playlist-items">
          {entries?.map((entry, index) => (
            <PlaylistRow
              key={entry.item_id}
              entry={entry}
              current={entry.item_id === list?.current_item}
              onPlay={() => onPlay(playlistTarget(entry, id))}
              onMove={(up) => change(movePlaylistItem(entry.item_id, up), rowKey(entry.item_id, up ? 'up' : 'down'))}
              onRemove={() => {
                const after = entries[index + 1] ?? entries[index - 1];
                // The last one: the ring goes to Back first, while the row it
                // is on still exists (docs/GOTCHAS.md).
                if (!after) void setFocus('playlist:back');
                change(removePlaylistItem(entry.item_id), after ? rowKey(after.item_id, 'remove') : null);
              }}
            />
          ))}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

// Up at the top and Down at the bottom do nothing rather than going grey: a
// control that turns disabled under the ring strands it there.
const rowKey = (itemId: number, part: 'play' | 'up' | 'down' | 'remove') => `playlist-item:${itemId}:${part}`;

/** What is said under an item's name. */
function entryNote(entry: PlaylistEntry): string | null {
  if (entry.missing) return 'Not found at the last scan';
  if (entry.kind === 'loose') return 'Not in the library';
  if (entry.kind === 'episode') return entry.episode_name;
  return null;
}

function PlaylistRow({
  entry,
  current,
  onPlay,
  onMove,
  onRemove,
}: {
  entry: PlaylistEntry;
  current: boolean;
  onPlay: () => void;
  onMove: (up: boolean) => void;
  onRemove: () => void;
}) {
  const percent =
    entry.duration_secs && !entry.completed
      ? Math.min(100, (entry.position_secs / entry.duration_secs) * 100)
      : 0;
  const note = entryNote(entry);
  return (
    <FocusGroup kind="row" className={`playlist-row ${entry.missing ? 'missing' : ''}`}>
      <FocusButton
        focusKey={rowKey(entry.item_id, 'play')}
        label={entryLabel(entry)}
        className="playlist-row-play"
        keepInView="nearest"
        disabled={entry.missing}
        onSelect={onPlay}
      >
        <span className="playlist-row-art">
          <Art local={entry.image_path} remote={entry.image_url} lazy fallback={<span className="video-tile-plain">▶</span>} />
          {percent > 0 && (
            <span className="continue-progress">
              <span className="continue-progress-fill" style={{ width: `${percent}%` }} />
            </span>
          )}
        </span>
        <span className="playlist-row-text">
          <span className="playlist-row-name">
            {entryLabel(entry)}
            {entry.completed && <span className="muted"> · ✓</span>}
            {current && <span className="muted"> · last played</span>}
          </span>
          {note && <span className="muted playlist-row-note">{note}</span>}
        </span>
      </FocusButton>
      <FocusButton focusKey={rowKey(entry.item_id, 'up')} className="btn-secondary" keepInView="nearest" onSelect={() => onMove(true)}>
        ↑
      </FocusButton>
      <FocusButton focusKey={rowKey(entry.item_id, 'down')} className="btn-secondary" keepInView="nearest" onSelect={() => onMove(false)}>
        ↓
      </FocusButton>
      <FocusButton focusKey={rowKey(entry.item_id, 'remove')} className="btn-secondary" keepInView="nearest" onSelect={onRemove}>
        Remove
      </FocusButton>
    </FocusGroup>
  );
}

/**
 * Home's Playlists rail: one tile per playlist, the newest-touched first, and
 * nothing at all — not even a focus target — while there are none (as
 * ContinueRail, for the same reason). Selecting a tile opens the playlist;
 * its Play carries on there (owner, 2026-10-18).
 */
export function PlaylistsRail({ onOpen }: { onOpen: (id: number) => void }) {
  const [lists, setLists] = useState<PlaylistSummary[]>([]);
  useEffect(() => {
    let live = true;
    listPlaylists()
      .then((found) => live && setLists(found))
      .catch((e) => console.warn('playlists unavailable', e));
    return () => {
      live = false;
    };
  }, []);
  const { ref, focusKey } = useNavGroup(
    { kind: 'row', remember: true, disabled: lists.length === 0 },
    { trackChildren: true, saveLastFocusedChild: true, focusable: lists.length > 0 }
  );

  // Empty (or still loading), still its element, unseen: as Rail.tsx says.
  if (lists.length === 0) {
    return (
      <FocusProvider value={focusKey}>
        <section className="rail" ref={ref} style={{ display: 'none' }} />
      </FocusProvider>
    );
  }
  return (
    <FocusProvider value={focusKey}>
      <section className="rail" ref={ref} aria-label="Playlists">
        <h2 className="rail-heading">Playlists</h2>
        <RailTrack>
          {lists.map((list) => (
            <PlaylistTile key={list.id} list={list} onSelect={() => onOpen(list.id)} />
          ))}
        </RailTrack>
      </section>
    </FocusProvider>
  );
}
