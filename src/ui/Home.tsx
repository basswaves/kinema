/**
 * Home: a hero for the most recent addition, then rails.
 *
 * Rails are derived from what the library actually contains rather than a fixed
 * list — an empty genre produces no rail at all, so a small library looks
 * deliberate instead of full of empty shelves.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useMemo } from 'react';
import Art from './Art';
import Rail from './Rail';
import ContinueRail from './ContinueRail';
import FocusButton from './FocusButton';
import { useClaimFocus } from './focus';
import type { ContinueItem } from '../player/api';
import { parseGenres, type Title } from './api';

interface Props {
  titles: Title[];
  resumable: ContinueItem[];
  onSelect: (title: Title) => void;
  onPlay: (title: Title) => void;
  onResume: (item: ContinueItem) => void;
  onRemoveResumable: (item: ContinueItem) => void;
}

/** Minimum titles before a genre earns its own rail. */
const MIN_PER_GENRE = 2;

/**
 * Where focus starts. A remote has no way to bootstrap focus the way a mouse
 * does by hovering, so without an explicit landing spot the first arrow press
 * from the couch does nothing at all and the app looks dead.
 */
const HERO_PLAY_FOCUS_KEY = 'hero-play';

export default function Home({
  titles,
  resumable,
  onSelect,
  onPlay,
  onResume,
  onRemoveResumable,
}: Props) {
  const { ref, focusKey } = useFocusable({ trackChildren: true, saveLastFocusedChild: true });

  const hero = useMemo(() => {
    const withBackdrop = titles.filter((t) => t.backdrop_url);
    const pool = withBackdrop.length > 0 ? withBackdrop : titles;
    return [...pool].sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0))[0] ?? null;
  }, [titles]);

  const recentlyAdded = useMemo(
    () => [...titles].sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0)).slice(0, 20),
    [titles]
  );

  const series = useMemo(() => titles.filter((t) => t.kind === 'series'), [titles]);
  const movies = useMemo(() => titles.filter((t) => t.kind === 'movie'), [titles]);

  const genreRails = useMemo(() => {
    const byGenre = new Map<string, Title[]>();
    for (const title of titles) {
      for (const genre of parseGenres(title.genres)) {
        const list = byGenre.get(genre) ?? [];
        list.push(title);
        byGenre.set(genre, list);
      }
    }
    return [...byGenre.entries()]
      .filter(([, list]) => list.length >= MIN_PER_GENRE)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8);
  }, [titles]);

  useClaimFocus(HERO_PLAY_FOCUS_KEY, Boolean(hero));

  if (titles.length === 0) {
    return (
      <div className="empty-state">
        <h1>Nothing here yet</h1>
        {/* The scan runs itself, so the only thing being asked for is a
            folder. Naming the stages here would describe the machinery
            rather than the one action that is needed. */}
        <p>Add a folder in Settings — scanning and matching happen on their own.</p>
      </div>
    );
  }

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="home" ref={ref}>
        {hero && <Hero title={hero} onPlay={onPlay} onSelect={onSelect} />}

        {/* First rail, as on any streaming service: the thing you were most
            recently in the middle of is what you probably want. */}
        <ContinueRail items={resumable} onResume={onResume} onRemove={onRemoveResumable} />

        <Rail heading="Recently added" titles={recentlyAdded} onSelect={onSelect} />
        <Rail heading="TV shows" titles={series} onSelect={onSelect} />
        <Rail heading="Movies" titles={movies} onSelect={onSelect} />
        {genreRails.map(([genre, list]) => (
          <Rail key={genre} heading={genre} titles={list} onSelect={onSelect} />
        ))}
      </div>
    </FocusContext.Provider>
  );
}

function Hero({
  title,
  onPlay,
  onSelect,
}: {
  title: Title;
  onPlay: (title: Title) => void;
  onSelect: (title: Title) => void;
}) {
  const { ref, focusKey } = useFocusable({ trackChildren: true });

  return (
    <FocusContext.Provider value={focusKey}>
      <header className="hero" ref={ref}>
        <Art
          className="hero-backdrop"
          local={title.backdrop_path}
          remote={title.backdrop_url}
        />
        <div className="hero-scrim" />
        <div className="hero-content">
          <h1 className="hero-title">{title.title}</h1>
          <div className="hero-meta">
            {title.year ?? ''}
            {title.rating ? ` · ★ ${title.rating.toFixed(1)}` : ''}
            {title.kind === 'series' ? ` · ${title.file_count} episodes` : ''}
            {parseGenres(title.genres).length > 0 ? ` · ${parseGenres(title.genres).join(', ')}` : ''}
          </div>
          {title.overview && <p className="hero-overview">{title.overview}</p>}
          <div className="hero-actions">
            {/* Top row of the page: arriving here from the rails below has to
                put the hero back on screen whole, not merely reveal the
                button. */}
            <FocusButton
              focusKey={HERO_PLAY_FOCUS_KEY}
              className="btn-primary"
              keepInView="page-top"
              onSelect={() => onPlay(title)}
            >
              ▶ Play
            </FocusButton>
            <FocusButton
              className="btn-secondary"
              keepInView="page-top"
              onSelect={() => onSelect(title)}
            >
              More info
            </FocusButton>
          </div>
        </div>
      </header>
    </FocusContext.Provider>
  );
}
