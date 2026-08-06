/**
 * The browsing shell: home, search and detail, plus handoff to the player.
 *
 * Search filters the already-loaded titles rather than querying — a personal
 * library is small enough that instant local filtering beats a round trip, and
 * it keeps typing responsive on a TV remote.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { init as initSpatial, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import Home from './Home';
import TitleDetailView from './TitleDetail';
import Card from './Card';
import Player, { type PlaybackTarget } from '../player/Player';
import { continueWatching, type ContinueItem } from '../player/api';
import { cacheArtwork } from '../metadata/api';
import { getTitleDetail, listTitles, type Title } from './api';
import './ui.css';

// Enable native-like arrow-key navigation. `useGetBoundingClientRect` makes
// hit-testing accurate when rails scroll horizontally.
initSpatial({
  debug: false,
  visualDebug: false,
  useGetBoundingClientRect: true,
});

type View =
  | { name: 'home' }
  | { name: 'detail'; title: Title }
  | { name: 'search' }
  | { name: 'player'; target: PlaybackTarget };

interface BrowseProps {
  /** Lets the shell hide chrome while video is playing. */
  onPlaybackChange?: (playing: boolean) => void;
}

export default function Browse({ onPlaybackChange }: BrowseProps) {
  const [titles, setTitles] = useState<Title[]>([]);
  const [resumable, setResumable] = useState<ContinueItem[]>([]);
  const [view, setView] = useState<View>({ name: 'home' });
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, resume] = await Promise.all([listTitles(), continueWatching(20)]);
      // A title with no files left is not watchable — unlinking a wrong match
      // leaves the cached title row behind, and it should not show up as a
      // card that plays nothing.
      setTitles(list.filter((t) => t.file_count > 0));
      setResumable(resume);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Fill in any artwork that is not cached yet, then reload so the local copies
  // are actually used. Titles matched before this existed have no local copy,
  // and a fresh match adds more — so this runs on every mount rather than once.
  useEffect(() => {
    let cancelled = false;
    cacheArtwork()
      .then((result) => {
        if (result.failed > 0) console.warn(`artwork: ${result.failed} download(s) failed`);
        if (!cancelled && result.stored > 0) void load();
      })
      .catch((e) => console.warn('artwork cache:', e));
    return () => {
      cancelled = true;
    };
  }, [load]);

  /**
   * Play the most sensible file for a title without making the user choose:
   * the movie itself, or the first episode we actually hold.
   */
  const playTitle = useCallback(
    async (title: Title) => {
      try {
        // Resume takes priority: pressing Play on a half-watched show should
        // continue it, not restart from episode one.
        const inProgress = resumable.find((item) => item.title_id === title.id);
        if (inProgress) {
          setView({
            name: 'player',
            target: {
              path: inProgress.path,
              label:
                inProgress.season !== null && inProgress.episode !== null
                  ? `${title.title} — S${String(inProgress.season).padStart(2, '0')}E${String(
                      inProgress.episode
                    ).padStart(2, '0')}`
                  : title.title,
              fileId: inProgress.file_id,
              titleId: title.id,
            },
          });
          return;
        }

        const detail = await getTitleDetail(title.id);
        if (detail.movie_path) {
          setView({
            name: 'player',
            target: {
              path: detail.movie_path,
              label: title.title,
              fileId: detail.movie_file_id,
              titleId: title.id,
            },
          });
          return;
        }

        const firstOwned = detail.episodes.find((e) => e.file_path);
        if (firstOwned?.file_path) {
          setView({
            name: 'player',
            target: {
              path: firstOwned.file_path,
              label: `${title.title} — S${String(firstOwned.season).padStart(2, '0')}E${String(
                firstOwned.episode
              ).padStart(2, '0')}`,
              fileId: firstOwned.file_id,
              titleId: title.id,
            },
          });
          return;
        }
        setError(`No playable file for “${title.title}”.`);
      } catch (e) {
        setError(String(e));
      }
    },
    [resumable]
  );

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return titles;
    return titles.filter((t) => t.title.toLowerCase().includes(needle));
  }, [titles, query]);

  // Back navigation, the way a remote expects it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (view.name === 'player') return; // the player owns its own keys
      if (e.key === 'Escape' || e.key === 'Backspace') {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT') return;
        e.preventDefault();
        setView({ name: 'home' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view.name]);

  useEffect(() => {
    if (view.name === 'search') setFocus('search-input');
  }, [view.name]);

  // Report playback state so the shell can hide its chrome, and make sure a
  // switch away from Browse while playing does not leave it hidden forever.
  useEffect(() => {
    onPlaybackChange?.(view.name === 'player');
    return () => onPlaybackChange?.(false);
  }, [view.name, onPlaybackChange]);

  if (view.name === 'player') {
    return (
      <Player
        target={view.target}
        onPlayTarget={(target) => setView({ name: 'player', target })}
        onExit={() => {
          setView({ name: 'home' });
          // Reload so progress and Continue Watching reflect what just played.
          void load();
        }}
      />
    );
  }

  return (
    <div className="browse">
      <nav className="top-nav">
        <span className="brand">Personal Netflix</span>
        <button
          className={view.name === 'home' ? 'active' : ''}
          onClick={() => setView({ name: 'home' })}
        >
          Home
        </button>
        <button
          className={view.name === 'search' ? 'active' : ''}
          onClick={() => setView({ name: 'search' })}
        >
          Search
        </button>
        <span className="nav-count">{titles.length} titles</span>
      </nav>

      {error && (
        <div className="browse-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {view.name === 'home' && (
        <Home
          titles={titles}
          resumable={resumable}
          onSelect={(title) => setView({ name: 'detail', title })}
          onPlay={(title) => void playTitle(title)}
          onResume={(item) =>
            setView({
              name: 'player',
              target: {
                path: item.path,
                label:
                  item.season !== null && item.episode !== null
                    ? `${item.title} — S${String(item.season).padStart(2, '0')}E${String(
                        item.episode
                      ).padStart(2, '0')}`
                    : item.title,
                fileId: item.file_id,
                titleId: item.title_id,
              },
            })
          }
        />
      )}

      {view.name === 'search' && (
        <div className="search">
          <input
            autoFocus
            className="search-input"
            placeholder="Search your library…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="search-grid">
            {results.map((title) => (
              <Card
                key={title.id}
                title={title}
                onSelect={(t) => setView({ name: 'detail', title: t })}
              />
            ))}
          </div>
          {results.length === 0 && <p className="muted center">No matches.</p>}
        </div>
      )}

      {view.name === 'detail' && (
        <TitleDetailView
          title={view.title}
          onBack={() => setView({ name: 'home' })}
          onPlayFile={(path, label, fileId, titleId) =>
            setView({
              name: 'player',
              target: {
                path,
                label,
                fileId,
                // Explicit null means "not on behalf of this title" — a trailer
                // must not adopt or overwrite the show's track preferences.
                titleId: titleId === undefined ? (view as { title: Title }).title.id : titleId,
              },
            })
          }
        />
      )}
    </div>
  );
}
