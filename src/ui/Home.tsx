/**
 * Home: a hero for the most recent addition, then rails.
 *
 * Rails are derived from what the library actually contains rather than a fixed
 * list — an empty genre produces no rail at all, so a small library looks
 * deliberate instead of full of empty shelves.
 */
import { useMemo, useState } from 'react';
import Art from './Art';
import { drawnStyle } from './drawnColour';
import Rail from './Rail';
import ContinueRail from './ContinueRail';
import { PlaylistsRail } from './PlaylistsPages';
import FocusButton from './FocusButton';
import FirstRun from './FirstRun';
import SetupPages from './SetupPages';
import HomeNotices from './HomeNotices';
import type { ScanTrouble } from './scanTrouble';
import type { Upgrade } from './qualityNotice';
import { FocusScreen } from './focusEngine';
import { useLanding } from './focusStore';
import FocusGroup, { FocusProvider } from './FocusGroup';
import { useFocusGroup, useNavGroup } from './focusGroups';
import { count } from './format';
import type { ContinueItem } from '../player/api';
import { parseGenres, type Title } from './api';
import { pickHero } from './hero';
import { useScanStatus } from '../library/pipeline';
import { scanWords } from '../library/scanWords';
import { useMyList } from '../library/myList';
import {
  fits,
  readyMadeRails,
  ruleName,
  useSavedCollections,
  useTitleTraits,
} from '../library/collections';

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
  /** Play something, from the whole library (somethingPick.ts). */
  onPlaySomething: () => void;
  /** Start the first scan, from the first-run panel. */
  onFirstScan: () => void;
  /** A Videos folder with something in it: a library, if not of titles. */
  hasVideos?: boolean;
  /** The folders added, and the files the scans found in them (all kinds). */
  folders?: { count: number; files: number };
  /** Settings → Library, on its Add movies folder. */
  onAddFolder?: () => void;
  /** A playlist's tile on its rail (PlaylistsPages.tsx). */
  onOpenPlaylist: (id: number) => void;
  /** A kept smart collection's page (CollectionPage.tsx). */
  onOpenCollection: (id: string) => void;
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
  const { folders = { count: 0, files: 0 }, reviewCount, onReview, onAddFolder } = props;
  const scan = useScanStatus();

  // Until finished or left, however soon the first scan fills the library
  // behind them: titles arriving must not take the questions away mid-answer.
  if (setupOpen) {
    return (
      <FocusScreen key="setup">
        <SetupPages onClose={onSetupClosed} />
      </FocusScreen>
    );
  }

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
    // Folders added and scanned, and nothing in them named: what was found and
    // the two ways on. Welcome again here was a loop — setup, a scan that
    // names nothing, Welcome, setup again (INBOX #10) — until a folder that
    // matched by itself was added.
    if (folders.count > 0) {
      return (
        <FocusScreen key="nothing-named">
          <NothingNamed
            files={folders.files}
            reviewCount={reviewCount}
            onReview={onReview}
            onAddFolder={onAddFolder}
          />
        </FocusScreen>
      );
    }
    return (
      <FocusScreen key="first-run">
        <FirstRun onScan={onFirstScan} />
      </FocusScreen>
    );
  }

  // Home itself and the pages that stand in for it above are on Kinema's own
  // engine (focusEngine.tsx, round 7).
  return (
    <FocusScreen key="home">
      <HomeRows {...props} />
    </FocusScreen>
  );
}

const NOTHING_NAMED_FOCUS_KEY = 'nothing-named';
const NOTHING_NAMED_REVIEW_KEY = 'nothing-named:review';

/** A library with folders and no title in it yet. */
function NothingNamed({
  files,
  reviewCount,
  onReview,
  onAddFolder,
}: {
  files: number;
  reviewCount: number;
  onReview: () => void;
  onAddFolder?: () => void;
}) {
  const { ref, focusKey } = useNavGroup({ kind: 'column' }, { focusKey: NOTHING_NAMED_FOCUS_KEY });
  // The count of files to review comes after Home is up: the ring, already on
  // Add another folder, moves to Review them when it appears, unless a key was
  // pressed meanwhile.
  useLanding(reviewCount > 0 ? NOTHING_NAMED_REVIEW_KEY : NOTHING_NAMED_FOCUS_KEY);
  return (
    <FocusProvider value={focusKey}>
      <section className="first-run first-scan nothing-named" ref={ref}>
        {files > 0 ? (
          <>
            <h1>
              Kinema found {count(files, 'file')} but could not name {files === 1 ? 'it' : 'them'}
            </h1>
            <p className="muted">
              Rather than guess, Kinema leaves a file it is not sure of for you to name. A wrong
              title is worse than none. Look through them and pick the right film or show, or add
              a folder whose files are named after what they are.
            </p>
          </>
        ) : (
          <>
            <h1>Kinema found no videos in your folders</h1>
            <p className="muted">
              The folders added hold no films or shows Kinema can play. Add the folder you keep
              them in.
            </p>
          </>
        )}
        <FocusGroup kind="row" className="settings-row">
          {reviewCount > 0 && (
            <FocusButton
              focusKey={NOTHING_NAMED_REVIEW_KEY}
              className="btn-primary"
              keepInView="nearest"
              onSelect={onReview}
            >
              Review them
            </FocusButton>
          )}
          {onAddFolder && (
            <FocusButton
              className={reviewCount > 0 ? 'btn-secondary' : 'btn-primary'}
              keepInView="nearest"
              onSelect={onAddFolder}
            >
              Add another folder
            </FocusButton>
          )}
        </FocusGroup>
      </section>
    </FocusProvider>
  );
}

function HomeRows({
  titles,
  resumable,
  onSelect,
  onPlay,
  onResume,
  onRemoveResumable,
  onSeeAll,
  onPlaySomething,
  onOpenPlaylist,
  onOpenCollection,
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
  // The page: the hero, the notices and the rails one above the other.
  const { ref, focusKey } = useNavGroup(
    { kind: 'column' },
    { trackChildren: true, saveLastFocusedChild: true }
  );

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

  // Smart collections (library/collections.ts): the user's own, and the
  // ready-made ones the library has titles for.
  const traits = useTitleTraits(titles);
  const savedCollections = useSavedCollections();
  const ownRails = useMemo(
    () =>
      savedCollections.map((c) => ({
        id: c.id,
        name: ruleName(c.rule),
        titles: titles.filter((t) => fits(t, traits, c.rule)),
      })),
    [savedCollections, titles, traits]
  );
  const readyRails = useMemo(() => readyMadeRails(titles, traits), [titles, traits]);

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

  // Where Home lands: Play, until the person does something.
  useLanding(hero && !setupOpen ? HERO_PLAY_FOCUS_KEY : null);

  return (
    <FocusProvider value={focusKey}>
      <div className="home" ref={ref}>
        {hero && (
          <Hero title={hero} onPlay={onPlay} onSelect={onSelect} onPlaySomething={onPlaySomething} />
        )}

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
        {ownRails.map((c) => (
          <Rail
            key={c.id}
            heading={c.name}
            titles={c.titles}
            onSelect={onSelect}
            onSeeAll={() => onOpenCollection(c.id)}
            openLabel="Open collection"
          />
        ))}

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
        {readyRails.map((c) => (
          <Rail
            key={c.name}
            heading={c.name}
            titles={c.titles}
            onSelect={onSelect}
            onSeeAll={onSeeAll}
          />
        ))}
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
    </FocusProvider>
  );
}

function Hero({
  title,
  onPlay,
  onSelect,
  onPlaySomething,
}: {
  title: Title;
  onPlay: (title: Title) => void;
  onSelect: (title: Title) => void;
  onPlaySomething: () => void;
}) {
  // A row landing on Play (NAV-MAP, agreed 2026-10-11): Up from a notice
  // under it is Play, whichever notice button it came from.
  const { ref, focusKey } = useFocusGroup<HTMLElement>('row', { current: HERO_PLAY_FOCUS_KEY });

  return (
    <FocusProvider value={focusKey}>
      <header className="hero" ref={ref}>
        <Art
          className="hero-backdrop"
          local={title.backdrop_path}
          remote={title.backdrop_url}
          fallback={<div className="hero-backdrop drawn-backdrop" style={drawnStyle(title.title, title.year)} />}
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
            {/* The day's pick is one suggestion; this is the next one, for
                when that is not it. In the hero's row, where Home lands. */}
            <FocusButton
              focusKey="hero-something"
              className="btn-secondary"
              keepInView="page-top"
              onSelect={onPlaySomething}
            >
              Play something
            </FocusButton>
          </div>
        </div>
      </header>
    </FocusProvider>
  );
}
