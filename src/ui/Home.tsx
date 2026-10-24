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
import { PlaylistsRail } from './PlaylistsPages';
import FocusButton from './FocusButton';
import FirstRun from './FirstRun';
import SetupPages from './SetupPages';
import HomeNotices from './HomeNotices';
import type { ScanTrouble } from './scanTrouble';
import type { Upgrade } from './qualityNotice';
import { useClaimFocus } from './focus';
import { useFocusGroup } from './focusGroups';
import type { ContinueItem } from '../player/api';
import { parseGenres, type Title } from './api';
import { pickHero } from './hero';
import { useScanStatus } from '../library/pipeline';
import { scanWords } from '../library/scanWords';
import { useMyList } from '../library/myList';

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
  /** Start the first scan, from the first-run panel. */
  onFirstScan: () => void;
  /** A Videos folder with something in it: a library, if not of titles. */
  hasVideos?: boolean;
  /** A playlist's tile on its rail (PlaylistsPages.tsx). */
  onOpenPlaylist: (id: number) => void;
  /** The setup pages are up, in front of everything else here. */
  setupOpen: boolean;
  onSetupClosed: () => void;
  reviewCount: number;
  onReview: () => void;
  keyRejected: boolean;
  onAddKey: () => void;
  upgrades: Upgrade[];
  onApplyUpgrades: () => void;
  onChooseUpgrades: () => void;
  onDismissUpgrades: () => void;
  ffmpegMissing: boolean;
  scanTrouble: ScanTrouble | null;
  onDismissScanTrouble: () => void;
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

/**
 * Home, or what stands in for it: the setup pages, the first run, the first
 * scan. Apart from the rows below because a focus container measures its
 * element once, when it mounts: Home's used to mount on an empty library with
 * no element (the console's "Component added without a node reference"), and
 * kept no place on the screen once the titles came.
 */
export default function Home(props: Props) {
  const { titles, loaded, hasVideos = false, setupOpen, onSetupClosed, onFirstScan } = props;
  const scan = useScanStatus();

  // Until finished or left, however soon the first scan fills the library
  // behind them: titles arriving must not take the questions away mid-answer.
  if (setupOpen) return <SetupPages onClose={onSetupClosed} />;

  // An empty library is a first run far more often than it is a mistake, so it
  // gets the setup panel rather than a sentence pointing at Settings. It also
  // covers the other way to arrive here — every root removed — where the same
  // two controls are exactly what is needed.
  // A library of videos alone (videos.ts) is not a first run: Home shows its
  // Continue Watching, and the videos themselves are on the Library page.
  if (titles.length === 0 && !hasVideos) {
    // Nothing rather than the setup panel while the first read is in flight:
    // the view behind is already opaque, and a blank moment is better than a
    // panel that flashes up at every launch and takes focus with it.
    if (!loaded) return null;
    // Setup finished while the first scan is still finding titles: what it is
    // doing, not the Welcome page again, which read as setup starting over.
    if (scan) {
      return (
        <section className="first-run first-scan">
          <h1>Reading your library</h1>
          <p className="muted">{scanWords(scan)}</p>
          <p className="muted">Your films and shows appear here as soon as they are found.</p>
        </section>
      );
    }
    return <FirstRun onScan={onFirstScan} />;
  }

  return <HomeRows {...props} />;
}

function HomeRows({
  titles,
  resumable,
  onSelect,
  onPlay,
  onResume,
  onRemoveResumable,
  onSeeAll,
  onOpenPlaylist,
  setupOpen,
  reviewCount,
  onReview,
  keyRejected,
  onAddKey,
  upgrades,
  onApplyUpgrades,
  onChooseUpgrades,
  onDismissUpgrades,
  ffmpegMissing,
  scanTrouble,
  onDismissScanTrouble,
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

  // In the order they were put there, newest first; a title not in the
  // library just now (its folder offline) is simply not shown.
  const listIds = useMyList();
  const myList = useMemo(() => {
    const byId = new Map(titles.map((t) => [t.id, t]));
    return listIds.flatMap((id) => byId.get(id) ?? []);
  }, [titles, listIds]);

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

  // A page (focus.ts): Play, even from the top bar the library's own restore
  // parked the ring on while the titles loaded.
  useClaimFocus(HERO_PLAY_FOCUS_KEY, Boolean(hero) && !setupOpen, true);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="home" ref={ref}>
        {hero && <Hero title={hero} onPlay={onPlay} onSelect={onSelect} />}

        <HomeNotices
          scanTrouble={scanTrouble}
          onDismissScanTrouble={onDismissScanTrouble}
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
        {/* Hidden while empty, as every rail is (Rail.tsx). */}
        <Rail heading="My list" titles={myList} onSelect={onSelect} onSeeAll={onSeeAll} listRail />
        <PlaylistsRail onOpen={onOpenPlaylist} />

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
  // A row landing on Play (NAV-MAP, agreed 2026-10-11): Up from a notice
  // under it is Play, whichever notice button it came from.
  const { ref, focusKey } = useFocusGroup<HTMLElement>('row', { current: HERO_PLAY_FOCUS_KEY });

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
