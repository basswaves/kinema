/**
 * The Library tab and a Videos folder's page (LOCAL-MEDIA.md phase 2 and
 * decision 1).
 *
 * The Library page holds one tile per Videos folder — and, as they are built,
 * Folders and Playlists — so the top bar never grows again. A Videos folder's
 * page shows its files as they lie on disk: its own files first, then one group
 * per sub-folder, each with Play all, which plays through the group by the same
 * previous/next steps an episode uses (`videos::adjacent`).
 *
 * Each tile's picture is a frame from the file (`videos.rs`), asked for one at
 * a time once the page is up; until then, and wherever none can be taken (on
 * Android always), a plain picture.
 */
import { FocusContext, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, useMemo, useState } from 'react';
import FocusButton from './FocusButton';
import Art from './Art';
import { useClaimFocus } from './focus';
import { count } from './format';
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
  onSettings,
}: {
  roots: LibraryRoot[];
  onOpen: (root: LibraryRoot) => void;
  onSettings: () => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: LIBRARY_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  const folders = videosRoots(roots);
  useClaimFocus(folders[0] ? `library:${folders[0].id}` : 'library:settings', true, true);

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
        </div>
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
        {videos !== null && videos.length === 0 && (
          <p className="muted">No videos here yet. Kinema scans this folder every time it starts.</p>
        )}
        {groups.map((group) => (
          <section key={group.dir} className="videos-group">
            {(group.name || groups.length > 1) && (
              <div className="videos-group-head">
                <h3>{group.name || 'In this folder'}</h3>
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
              </div>
            )}
            <div className="videos-tiles">
              {group.items.map((video) => (
                <VideoTile key={video.id} video={video} onPlay={onPlay} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </FocusContext.Provider>
  );
}

export function VideoTile({ video, onPlay }: { video: VideoItem; onPlay: (t: PlaybackTarget) => void }) {
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
