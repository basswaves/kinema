/**
 * Home: a hero for the most recent addition, then rails.
 *
 * Rails are derived from what the library actually contains rather than a fixed
 * list — an empty genre produces no rail at all, so a small library looks
 * deliberate instead of full of empty shelves.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useMemo, useState } from 'react';
import Art from './Art';
import Rail from './Rail';
import ContinueRail from './ContinueRail';
import FocusButton from './FocusButton';
import FirstRun from './FirstRun';
import HomeNotices from './HomeNotices';
import type { Upgrade } from './qualityNotice';
import { useClaimFocus } from './focus';
import type { ContinueItem } from '../player/api';
import { parseGenres, type Title } from './api';
import { pickHero } from './hero';

interface Props {
  titles: Title[];
  /** False until the library has been read once — see `loaded` in Browse. */
  loaded: boolean;
  resumable: ContinueItem[];
  onSelect: (title: Title) => void;
  onPlay: (title: Title) => void;
  onResume: (item: ContinueItem) => void;
  onRemoveResumable: (item: ContinueItem) => void;
  /** Open a rail's full contents as a grid. */
  onSeeAll: (heading: string, titles: Title[]) => void;
  /** Re-read the library, after the first-run panel has changed it. */
  onLibraryChanged: () => void;
  reviewCount: number;
  onReview: () => void;
  keyRejected: boolean;
  onAddKey: () => void;
  upgrades: Upgrade[];
  onApplyUpgrades: () => void;
  onChooseUpgrades: () => void;
  onDismissUpgrades: () => void;
  ffmpegMissing: boolean;
  onFfmpeg: () => void;
  onDismissFfmpeg: () => void;
}

/**
 * Genre rails only where they add something. On a small library every genre
 * rail repeated titles already on screen three times over — the same poster
 * in Recently added, Movies and Drama — so they wait for a library big enough
 * to browse by genre, and a genre has to hold enough to be a shelf.
 */
const GENRE_MIN_LIBRARY = 12;
const MIN_PER_GENRE = 4;

/**
 * Where focus starts. A remote has no way to bootstrap focus the way a mouse
 * does by hovering, so without an explicit landing spot the first arrow press
 * from the couch does nothing at all and the app looks dead.
 */
export const HERO_PLAY_FOCUS_KEY = 'hero-play';

export default function Home({
  titles,
  loaded,
  resumable,
  onSelect,
  onPlay,
  onResume,
  onRemoveResumable,
  onSeeAll,
  onLibraryChanged,
  reviewCount,
  onReview,
  keyRejected,
  onAddKey,
  upgrades,
  onApplyUpgrades,
  onChooseUpgrades,
  onDismissUpgrades,
  ffmpegMissing,
  onFfmpeg,
  onDismissFfmpeg,
}: Props) {
  const { ref, focusKey } = useFocusable({ trackChildren: true, saveLastFocusedChild: true });

  // The moment Home opened, fixed for its life: the hero is the day's pick,
  // not something that changes under the remote while you browse.
  const [openedAt] = useState(() => Date.now());
  const hero = useMemo(
    () => pickHero(titles, resumable[0]?.title_id ?? null, openedAt),
    [titles, resumable, openedAt]
  );

  // Not sliced here: `Rail` applies the cap, so there is one number governing
  // how long a rail gets rather than one per rail.
  const recentlyAdded = useMemo(
    () => [...titles].sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0)),
    [titles]
  );

  const series = useMemo(() => titles.filter((t) => t.kind === 'series'), [titles]);
  const movies = useMemo(() => titles.filter((t) => t.kind === 'movie'), [titles]);

  const genreRails = useMemo(() => {
    if (titles.length < GENRE_MIN_LIBRARY) return [];
    const byGenre = new Map<string, Title[]>();
    for (const title of titles) {
      for (const genre of parseGenres(title.genres)) {
        const list = byGenre.get(genre) ?? [];
        list.push(title);
        byGenre.set(genre, list);
      }
    }
    return [...byGenre.entries()]
      // A genre that is the whole library is just the library again.
      .filter(([, list]) => list.length >= MIN_PER_GENRE && list.length < titles.length)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8);
  }, [titles]);

  useClaimFocus(HERO_PLAY_FOCUS_KEY, Boolean(hero));

  // An empty library is a first run far more often than it is a mistake, so it
  // gets the setup panel rather than a sentence pointing at Settings. It also
  // covers the other way to arrive here — every root removed — where the same
  // two controls are exactly what is needed.
  if (titles.length === 0) {
    // Nothing rather than the setup panel while the first read is in flight:
    // the view behind is already opaque, and a blank moment is better than a
    // panel that flashes up at every launch and takes focus with it.
    return loaded ? <FirstRun onDone={onLibraryChanged} /> : null;
  }

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="home" ref={ref}>
        {hero && <Hero title={hero} onPlay={onPlay} onSelect={onSelect} />}

        <HomeNotices
          reviewCount={reviewCount}
          onReview={onReview}
          keyRejected={keyRejected}
          onAddKey={onAddKey}
          upgrades={upgrades}
          onApply={onApplyUpgrades}
          onChoose={onChooseUpgrades}
          onDismiss={onDismissUpgrades}
          ffmpegMissing={ffmpegMissing}
          onFfmpeg={onFfmpeg}
          onDismissFfmpeg={onDismissFfmpeg}
        />

        {/* First rail, as on any streaming service: the thing you were most
            recently in the middle of is what you probably want. */}
        <ContinueRail items={resumable} onResume={onResume} onRemove={onRemoveResumable} />

        <Rail
          heading="Recently added"
          titles={recentlyAdded}
          onSelect={onSelect}
          onSeeAll={onSeeAll}
        />
        {/* Only when the library holds both: with one kind, either rail is
            Recently added again in another order. */}
        {series.length > 0 && movies.length > 0 && (
          <>
            <Rail heading="TV shows" titles={series} onSelect={onSelect} onSeeAll={onSeeAll} />
            <Rail heading="Movies" titles={movies} onSelect={onSelect} onSeeAll={onSeeAll} />
          </>
        )}
        {genreRails.map(([genre, list]) => (
          <Rail
            key={genre}
            heading={genre}
            titles={list}
            onSelect={onSelect}
            onSeeAll={onSeeAll}
          />
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
          {/* The title as designed, where every streaming service puts it. The
              heading is the fallback rather than something hidden alongside:
              `Art` renders it when there is no logo *and* when one exists but
              fails to load, so a broken image can never leave the hero
              nameless. `alt` carries the name for anything not looking at it. */}
          <Art
            className="hero-logo"
            local={title.logo_path}
            remote={title.logo_url}
            alt={title.title}
            fallback={<h1 className="hero-title">{title.title}</h1>}
          />
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
              focusKey="hero-info"
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
