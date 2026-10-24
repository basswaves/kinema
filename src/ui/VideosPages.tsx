/**
 * The Library tab and a Videos folder's page (LOCAL-MEDIA.md phase 2 and
 * decision 1).
 *
 * The Library page holds one tile per Videos folder, then Playlists
 * (PlaylistsPages.tsx) and Folders, so the top bar never grows again. Folders
 * depends on the layout (owner, 2026-10-18): in the TV layout it is Kinema's
 * own browser (FoldersPage.tsx), as a sofa has no Explorer; at a desk it is
 * "Add a folder" — the system's folder window at once, then the same
 * questions (AddFolder.tsx) — as a mouse expects. A Videos folder's
 * page shows its files as they lie on disk: its own files first, then one group
 * per sub-folder, each with Play all, which plays through the group by the same
 * previous/next steps an episode uses (`videos::adjacent`).
 *
 * Each tile's picture is a frame from the file (`videos.rs`), asked for one at
 * a time once the page is up; until then, and wherever none can be taken (on
 * Android always), a plain picture.
 */
import { FocusContext, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, useMemo, useState } from 'react';
import AddFolder from './AddFolder';
import FocusButton from './FocusButton';
import Art from './Art';
import MediaBadges from './MediaBadges';
import FocusGroup from './FocusGroup';
import { PlaylistDialog } from './PlaylistPicker';
import type { NewItem } from '../library/playlists';
import { useClaimFocus } from './focus';
import { userError } from './errors';
import { count } from './format';
import { useTvMode } from './tv';
import { chooseFolder } from '../library/folders';
import { runScanPipeline } from '../library/pipeline';
import type { LibraryRoot } from '../library/api';
import type { PlaybackTarget } from '../player/api';
import {
  groupVideos,
  listVideos,
  playAllStart,
  videoDate,
  videoFrame,
  videoName,
  videosRoots,
  videoTarget,
  type VideoItem,
} from '../library/videos';

const LIBRARY_FOCUS_KEY = 'library-page';
const VIDEOS_FOCUS_KEY = 'videos-page';

export function LibraryPage({
  roots,
  onOpen,
  onFolders,
  onPlaylists,
  onSettings,
  onLibraryChanged,
}: {
  roots: LibraryRoot[];
  onOpen: (root: LibraryRoot) => void;
  onFolders: () => void;
  onPlaylists: () => void;
  onSettings: () => void;
  onLibraryChanged: () => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: LIBRARY_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  const folders = videosRoots(roots);
  useClaimFocus(folders[0] ? `library:${folders[0].id}` : 'library:folders', true, true);

  const tv = useTvMode();
  /** The folder the system's window gave, while its questions are asked. */
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = () => {
    setNote(null);
    setError(null);
    chooseFolder('the library')
      .then((path) => path && setPicked(path))
      .catch((e: unknown) => setError(userError(e)));
  };

  const cancel = () => {
    setPicked(null);
    void setFocus('library:folders');
  };

  const added = (name: string) => {
    setPicked(null);
    setNote(`Added ${name} to the library. Scanning it now.`);
    void setFocus('library:folders');
    onLibraryChanged();
    void runScanPipeline()
      .then((outcome) => {
        if (outcome.status === 'failed') setError(outcome.error);
        else if (outcome.status === 'skipped')
          setNote(`Added ${name}. A scan is already running; it is picked up by the next one.`);
        else setNote(`Added ${name} to the library and scanned it.`);
      })
      .catch((e: unknown) => setError(userError(e)))
      .finally(onLibraryChanged);
  };

  // Back while the questions are up only puts them away, as on Folders.
  // Capture phase, so Browse does not also leave the page; in a text box
  // Backspace deletes.
  useEffect(() => {
    if (!picked) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Backspace' && e.key !== 'BrowserBack') return;
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      e.stopPropagation();
      if (target.tagName === 'INPUT') {
        if (e.key === 'Backspace') return;
        e.preventDefault();
        target.blur();
        return;
      }
      e.preventDefault();
      setPicked(null);
      void setFocus('library:folders');
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [picked]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="search library-page" ref={ref}>
        <h2 className="grid-heading">Library</h2>
        <div className="library-tiles">
          {folders.map((root) => (
            <FocusButton
              key={root.id}
              focusKey={`library:${root.id}`}
              label={root.name ?? root.path}
              className="library-tile"
              onSelect={() => onOpen(root)}
            >
              <span className="library-tile-name">{root.name ?? root.path}</span>
              <span className="library-tile-meta">{count(root.file_count, 'video')}</span>
            </FocusButton>
          ))}
          <FocusButton
            focusKey="library:playlists"
            label="Playlists"
            className="library-tile library-tile-playlists"
            onSelect={onPlaylists}
          >
            <span className="library-tile-name">Playlists</span>
            <span className="library-tile-meta">Films, episodes and videos in your order</span>
          </FocusButton>
          {tv ? (
            <FocusButton
              focusKey="library:folders"
              label="Folders"
              className="library-tile library-tile-folders"
              onSelect={onFolders}
            >
              <span className="library-tile-name">Folders</span>
              <span className="library-tile-meta">Drives, network, anything to play</span>
            </FocusButton>
          ) : (
            <FocusButton
              focusKey="library:folders"
              label="Add a folder"
              className="library-tile library-tile-folders"
              onSelect={pick}
            >
              <span className="library-tile-name">Add a folder</span>
              <span className="library-tile-meta">Movies, TV shows or videos</span>
            </FocusButton>
          )}
        </div>
        {picked && <AddFolder key={picked} path={picked} onAdded={added} onCancel={cancel} />}
        {note && <p className="settings-note">{note}</p>}
        {error && <p className="leave-error">{error}</p>}
        {folders.length === 0 && (
          <p className="muted library-empty">
            Home videos, concerts, anything that is not a film or a show: add a Videos folder in
            Settings → Library, and it appears here.
          </p>
        )}
        <div className="settings-row">
          <FocusButton focusKey="library:settings" className="btn-secondary" onSelect={onSettings}>
            {folders.length === 0 ? 'Add a Videos folder' : 'Library folders'}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

export function VideosPage({
  root,
  onPlay,
  onBack,
}: {
  root: LibraryRoot;
  onPlay: (target: PlaybackTarget) => void;
  onBack: () => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: VIDEOS_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  const [videos, setVideos] = useState<VideoItem[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** The files that had no frame when the list arrived, in page order. */
  const [missing, setMissing] = useState<number[]>([]);

  useEffect(() => {
    let live = true;
    listVideos(root.id)
      .then((list) => {
        if (!live) return;
        setVideos(list);
        const order = groupVideos(list, root.path).flatMap((g) => g.items);
        setMissing(order.filter((v) => v.frame === null).map((v) => v.id));
      })
      .catch((e) => live && setFailed(String(e)));
    return () => {
      live = false;
    };
  }, [root.id, root.path]);

  // Frames for the tiles that have none, one at a time, in page order. Each
  // arrives as it is taken; leaving the page stops asking.
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const id of missing) {
        if (!live) return;
        const frame = await videoFrame(id).catch(() => null);
        if (live && frame) {
          setVideos((list) => list && list.map((v) => (v.id === id ? { ...v, frame } : v)));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [missing]);

  const groups = useMemo(() => groupVideos(videos ?? [], root.path), [videos, root.path]);
  /** A group being added to a playlist, and the sentence after. */
  const [adding, setAdding] = useState<{ what: string; items: NewItem[] } | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  /** The video in hand — focused or under the pointer — whose badges show. */
  const [shown, setShown] = useState<VideoItem | null>(null);
  const first = groups[0]?.items[0];
  useClaimFocus(first ? `video:${first.id}` : 'videos:back', videos !== null, true);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="search videos-page" ref={ref}>
        <div className="grid-head">
          <FocusButton
            focusKey="videos:back"
            className="back-button"
            keepInView="page-top"
            onSelect={onBack}
          >
            ← Back
          </FocusButton>
          <h2 className="grid-heading">
            {root.name ?? root.path} <span className="muted">{videos?.length ?? ''}</span>
          </h2>
        </div>
        {failed && <p className="muted">{failed}</p>}
        {added && <p className="muted videos-added">{added}</p>}
        {adding && (
          <PlaylistDialog
            items={adding.items}
            what={adding.what}
            onClose={(message) => {
              setAdding(null);
              setAdded(message);
            }}
          />
        )}
        {videos !== null && videos.length === 0 && (
          <p className="muted">No videos here yet. Kinema scans this folder every time it starts.</p>
        )}
        {groups.map((group) => (
          <section key={group.dir} className="videos-group">
            {/* The row is there even with no heading (a folder holding only
                its own videos), or its videos could be added to a playlist
                only from the player. A row that is arrived at on Play all,
                and left by its own box: + Playlist beside it lies between
                two tiles, and the engines disagreed on which was nearer. */}
            <FocusGroup kind="row" current={`video-group:${group.dir}`} className="videos-group-head">
              {(group.name || groups.length > 1) && <h3>{group.name || 'In this folder'}</h3>}
              <FocusButton
                focusKey={`video-group:${group.dir}`}
                className="btn-secondary"
                onSelect={() => {
                  const start = playAllStart(group);
                  if (start) onPlay(videoTarget(start));
                }}
              >
                ▶ Play all
              </FocusButton>
              <FocusButton
                className="btn-secondary"
                onSelect={() =>
                  setAdding({
                    what: group.name
                      ? `“${group.name}”`
                      : group.items.length === 1
                        ? `“${videoName(group.items[0].file_name)}”`
                        : 'these videos',
                    items: group.items.map((v) => ({ path: v.path, file_id: v.id })),
                  })
                }
              >
                + Playlist
              </FocusButton>
            </FocusGroup>
            <FocusGroup
              kind="list"
              current={group.items[0] ? `video:${group.items[0].id}` : undefined}
              className="videos-tiles"
            >
              {group.items.map((video) => (
                <VideoTile
                  key={video.id}
                  video={video}
                  onPlay={onPlay}
                  onHighlight={() => setShown(video)}
                />
              ))}
            </FocusGroup>
          </section>
        ))}
        {shown && (
          // What the file holds, as a film's page shows it; kept in view at
          // the foot of the page, since the tile in hand may be far down.
          <div className="video-facts">
            <div className="video-facts-name">{videoName(shown.file_name)}</div>
            <MediaBadges fileId={shown.id} kind="video" studios={[]} />
          </div>
        )}
      </div>
    </FocusContext.Provider>
  );
}

export function VideoTile({
  video,
  onPlay,
  onHighlight,
}: {
  video: VideoItem;
  onPlay: (t: PlaybackTarget) => void;
  /** The tile is focused or under the pointer. */
  onHighlight?: () => void;
}) {
  const percent =
    video.duration_secs && !video.completed
      ? Math.min(100, (video.position_secs / video.duration_secs) * 100)
      : 0;
  const date = videoDate(video.file_name, video.modified_at);
  return (
    <FocusButton
      focusKey={`video:${video.id}`}
      // Read out by its name; the date is drawn under it.
      label={videoName(video.file_name)}
      className="video-tile"
      onSelect={() => onPlay(videoTarget(video))}
      onHighlight={onHighlight}
    >
      <span className="video-tile-art">
        <Art local={video.frame} remote={null} lazy fallback={<span className="video-tile-plain">▶</span>} />
        {percent > 0 && (
          <span className="continue-progress">
            <span className="continue-progress-fill" style={{ width: `${percent}%` }} />
          </span>
        )}
        {video.completed && <span className="video-tile-watched" aria-label="Watched">✓</span>}
      </span>
      <span className="video-tile-name">{videoName(video.file_name)}</span>
      {date && (
        <span className="video-tile-date">
          {/* As the other dates in Kinema are written (AccountSection). */}
          {date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
      )}
    </FocusButton>
  );
}
