/**
 * The browsing shell: home, search and detail, plus handoff to the player.
 *
 * Search filters the already-loaded titles rather than querying — a personal
 * library is small enough that instant local filtering beats a round trip, and
 * it keeps typing responsive on a TV remote.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  init as initSpatial,
  setFocus,
  useFocusable,
  FocusContext,
  type FocusableComponent,
} from '@noriginmedia/norigin-spatial-navigation';
import Home from './Home';
import TitleDetailView from './TitleDetail';
import Card from './Card';
import FocusButton from './FocusButton';
import Settings from './Settings';
import { installFocusWatchdog, useClaimFocus } from './focus';
import { setShortcutsOpen } from './shortcutsState';
import Player, { type PlaybackTarget } from '../player/Player';
import {
  continueWatching,
  episodeLabel,
  firstUnwatchedEpisode,
  forgetProgress,
  type ContinueItem,
} from '../player/api';
import { cacheArtwork } from '../metadata/api';
import { runScanPipeline, useScanStatus } from '../library/pipeline';
import { getTitleDetail, listTitles, type Title } from './api';
import { runSelfTest, selfTestPlan } from '../selftest';
import './ui.css';

// Enable native-like arrow-key navigation. `useGetBoundingClientRect` makes
// hit-testing accurate when rails scroll horizontally.
initSpatial({
  debug: false,
  visualDebug: false,
  useGetBoundingClientRect: true,
});
installFocusWatchdog();

/** The nav entries, in order. Detail and player are reached, not navigated to. */
type NavTarget = 'home' | 'search' | 'settings';

/** The three nav views carry no payload, which is exactly what makes them nav. */
type View =
  | { name: NavTarget }
  | { name: 'detail'; title: Title }
  // Ids rather than the titles themselves, so the grid keeps showing current
  // rows after a reload rather than a snapshot taken when it was opened.
  | { name: 'grid'; heading: string; titleIds: number[] }
  | { name: 'player'; target: PlaybackTarget };


const NAV_FOCUS_KEY = 'top-nav';
const GRID_FOCUS_KEY = 'grid-view';

/**
 * Move focus between the nav bar and the content beneath it.
 *
 * This one hop cannot be done geometrically, and the reason is worth writing
 * down. To go up, the spatial system requires a candidate whose **bottom** edge
 * is above the current element's **top** edge. The nav is an overlay: it is
 * drawn over the content, so its bottom edge is always *below* the content's
 * top edge — and the hero deliberately slides further under it still. There is
 * no arrangement of an overlay nav and the content it overlays that satisfies
 * that test, so no amount of adjusting the markup would have fixed this.
 *
 * `nextFocusResolver` is the library's escape hatch for exactly this: it is
 * consulted only once the geometric search inside the content has come up
 * empty, so pressing up from the third rail still reaches the second rail
 * normally. Only a press that has run out of content arrives here.
 */
function resolveNavHop(
  direction: string,
  fromKey: string,
  siblings: FocusableComponent[]
): FocusableComponent | null {
  const nav = siblings.find((s) => s.focusKey === NAV_FOCUS_KEY);
  const content = siblings.find((s) => s.focusKey !== NAV_FOCUS_KEY);
  if (!nav) return null;

  if (direction === 'up') return fromKey === NAV_FOCUS_KEY ? null : nav;
  if (direction === 'down') return fromKey === NAV_FOCUS_KEY ? (content ?? null) : null;
  return null;
}

export default function Browse() {
  const [titles, setTitles] = useState<Title[]>([]);
  const [resumable, setResumable] = useState<ContinueItem[]>([]);
  const [view, setView] = useState<View>({ name: 'home' });
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** A root that could not be read at startup. Not an error — see below. */
  const [scanTrouble, setScanTrouble] = useState<string | null>(null);

  // The shell owns the nav↔content rule, because it is the only component that
  // is a parent of both. The nav and the search view get their containers in
  // components of their own (below) rather than here — `useFocusable` reads the
  // focus context of the component it is *called in*, so declaring them at this
  // level would parent them to the root alongside the shell instead of beneath
  // it, and the resolver would never see the nav at all.
  const { ref: shellRef, focusKey: shellFocusKey } = useFocusable({
    focusKey: 'browse-shell',
    trackChildren: true,
    saveLastFocusedChild: true,
    nextFocusResolver: resolveNavHop,
  });

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

  /**
   * Re-read whenever Home is shown, not only when the shell mounts.
   *
   * Everything that changes what Home displays happens on some *other* view:
   * finishing an episode in the player, marking one watched on a detail page,
   * fixing a match in Settings. A load that ran once at startup left the rails
   * showing whatever was true when the app opened, and the failure is quiet —
   * Continue Watching goes on offering an episode you have just declared seen.
   *
   * Stating it as "Home reflects the database while Home is visible" is what
   * makes it hold for the next screen that writes something, too. A callback
   * per writer would have to be remembered each time.
   */
  useEffect(() => {
    if (view.name !== 'home') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [view.name, load]);

  // Fill in any artwork that is not cached yet, then reload so the local copies
  // are actually used. Titles matched before this existed have no local copy,
  // and a fresh match adds more — so this runs on every mount rather than once.
  useEffect(() => {
    let cancelled = false;
    // A self-test works on a copy of the library and must not download
    // anything into it or spend time on it — see src/selftest.ts.
    selfTestPlan()
      .then((plan) => (plan ? { stored: 0, failed: 0 } : cacheArtwork()))
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
   * Bring the library up to date once per launch, in the background.
   *
   * Deliberately not awaited and deliberately not blocking: the shelves render
   * from the database immediately, and anything the scan turns up appears when
   * it appears. A first run on an empty library is the one case where the wait
   * is visible, and an empty screen that fills itself is a better answer than a
   * spinner in front of nothing.
   *
   * Problems are reported quietly rather than not at all. They used to be
   * logged and nothing else, on the reasoning that an unreachable share is
   * normal and the scanner skips that root anyway — which is true, and misses
   * what it looks like from the sofa. Every browsing query hides files marked
   * missing, so a share that did not come back reads as a library that has
   * silently lost half its contents, with no way to tell that from real data
   * loss. A quiet line naming the folder is the difference between "this app
   * ate my library" and "the NAS is asleep".
   *
   * Deliberately not the red error banner: nothing is broken, the shelves are
   * browsing perfectly well from cache, and this must not look like a failure.
   */
  useEffect(() => {
    let cancelled = false;
    // Never under a self-test: the scan would end by running Skiptro and
    // ffmpeg over the real media, which is the opposite of a harmless test.
    selfTestPlan()
      .then((plan) => (plan ? null : runScanPipeline()))
      .then((outcome) => {
        if (cancelled || outcome === null) return;
        if (outcome.status === 'failed') {
          console.warn('startup scan failed:', outcome.error);
          setScanTrouble(`Could not check your library folders — ${outcome.error}`);
          return;
        }
        if (outcome.status !== 'done') return;
        const { filesAdded, matched, errors } = outcome.summary;
        if (errors.length > 0) {
          console.warn('startup scan problems:', errors);
          setScanTrouble(
            errors.length === 1
              ? errors[0]
              : `${errors[0]} · and ${errors.length - 1} more`
          );
        }
        if (filesAdded > 0 || matched > 0) void load();
      })
      .catch((e) => console.warn('startup scan:', e));
    return () => {
      cancelled = true;
    };
  }, [load]);

  /**
   * Under a self-test, go straight to the player on the plan's file and let
   * the recorder take it from there. Outside one, this does nothing at all.
   */
  useEffect(() => {
    let cancelled = false;
    void selfTestPlan().then((plan) => {
      if (!plan || cancelled) return;
      setView({
        name: 'player',
        target: {
          path: plan.path,
          label: plan.label ?? 'Self-test',
          fileId: plan.fileId,
          titleId: plan.titleId,
        },
      });
      void runSelfTest(plan).catch((e) => console.error('selftest failed', e));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Play the most sensible file for a title without making the user choose:
   * where you left off, else the earliest episode you have not seen, else the
   * film itself.
   *
   * A series is asked about directly rather than being routed through
   * `getTitleDetail`, whose `movie_path` is the *largest file by size* for a
   * series — so Play used to start whichever episode happened to be biggest,
   * which on a season with a feature-length finale is the ending.
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
              label: episodeLabel(title.title, inProgress.season, inProgress.episode),
              fileId: inProgress.file_id,
              titleId: title.id,
            },
          });
          return;
        }

        if (title.kind === 'series') {
          const next = await firstUnwatchedEpisode(title.id);
          if (next) {
            setView({
              name: 'player',
              target: {
                path: next.path,
                label: episodeLabel(title.title, next.season, next.episode),
                fileId: next.file_id,
                titleId: title.id,
              },
            });
            return;
          }
          setError(`No playable episode for “${title.title}”.`);
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

        setError(`No playable file for “${title.title}”.`);
      } catch (e) {
        setError(String(e));
      }
    },
    [resumable]
  );

  /**
   * Take an item out of Continue Watching.
   *
   * The rail is updated locally *and* reloaded: dropping the card immediately is
   * what makes the press feel like it did something, and the reload is what
   * keeps the list honest if anything else changed underneath.
   */
  const removeResumable = useCallback(
    async (item: ContinueItem) => {
      setResumable((current) => current.filter((i) => i.file_id !== item.file_id));
      try {
        await forgetProgress(item.file_id);
      } catch (e) {
        setError(String(e));
      }
      await load();
    },
    [load]
  );

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return titles;
    return titles.filter((t) => t.title.toLowerCase().includes(needle));
  }, [titles, query]);

  /** Resolve a grid's stored ids, keeping the order the rail had them in. */
  const gridTitles = useMemo(() => {
    if (view.name !== 'grid') return [];
    const byId = new Map(titles.map((t) => [t.id, t]));
    return view.titleIds.map((id) => byId.get(id)).filter((t): t is Title => t !== undefined);
  }, [view, titles]);

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

  if (view.name === 'player') {
    return (
      <Player
        target={view.target}
        onPlayTarget={(target) => setView({ name: 'player', target })}
        // Returning to Home re-reads the library on arrival, so what just
        // played is reflected without a second load here.
        onExit={() => setView({ name: 'home' })}
      />
    );
  }

  return (
    <div className="browse" ref={shellRef}>
      <FocusContext.Provider value={shellFocusKey}>
        <TopNav active={view.name} titleCount={titles.length} onNavigate={setView} />

        {error && (
          <div className="browse-error" onClick={() => setError(null)}>
            {error}
          </div>
        )}

        {scanTrouble && (
          <div className="browse-notice" onClick={() => setScanTrouble(null)}>
            {scanTrouble}
            <span className="muted"> — anything from that folder is hidden until it is back.</span>
          </div>
        )}

        {view.name === 'home' && (
          <Home
            titles={titles}
            resumable={resumable}
            onSelect={(title) => setView({ name: 'detail', title })}
            onPlay={(title) => void playTitle(title)}
            onRemoveResumable={(item) => void removeResumable(item)}
            onLibraryChanged={() => void load()}
            onSeeAll={(heading, list) =>
              setView({ name: 'grid', heading, titleIds: list.map((t) => t.id) })
            }
            onResume={(item) =>
              setView({
                name: 'player',
                target: {
                  path: item.path,
                  label: episodeLabel(item.title, item.season, item.episode),
                  fileId: item.file_id,
                  titleId: item.title_id,
                },
              })
            }
          />
        )}

        {view.name === 'search' && (
          <SearchView
            query={query}
            onQueryChange={setQuery}
            results={results}
            onSelect={(title) => setView({ name: 'detail', title })}
          />
        )}

        {view.name === 'grid' && (
          <GridView
            heading={view.heading}
            titles={gridTitles}
            onSelect={(title) => setView({ name: 'detail', title })}
            onBack={() => setView({ name: 'home' })}
          />
        )}

        {view.name === 'settings' && <Settings />}

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
      </FocusContext.Provider>
    </div>
  );
}

/**
 * The nav bar, as its own component so that its container is created *inside*
 * the shell's focus context and is therefore parented to the shell. Declaring
 * this `useFocusable` up in `Browse` would read `Browse`'s own context — the
 * root — no matter which providers `Browse` renders, which is a quiet way to
 * end up with a focus tree that does not match the markup.
 */
function TopNav({
  active,
  titleCount,
  onNavigate,
}: {
  active: string;
  titleCount: number;
  onNavigate: (view: { name: NavTarget }) => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: NAV_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  // A scan is the only long-running thing the app does on its own, so it says
  // so where the title count normally sits rather than interrupting anything.
  const scan = useScanStatus();

  return (
    <FocusContext.Provider value={focusKey}>
      <nav className="top-nav" ref={ref}>
        <span className="brand">Kinema</span>
        {(['home', 'search', 'settings'] as const).map((name) => (
          <FocusButton
            key={name}
            className={active === name ? 'active' : ''}
            keepInView="page-top"
            onSelect={() => onNavigate({ name })}
          >
            {name === 'home' ? 'Home' : name === 'search' ? 'Search' : 'Settings'}
          </FocusButton>
        ))}
        {/* The key list needs a control, not just the `?` key that opens it.
            A remote has no `?` to press, and a remote is the input this app is
            shaped around — so the one screen explaining how to drive it would
            otherwise be reachable only from the keyboard it is not about. */}
        <FocusButton
          className="nav-help"
          title="Keyboard and remote controls (?)"
          keepInView="page-top"
          onSelect={() => setShortcutsOpen(true)}
        >
          ?
        </FocusButton>
        <span className="nav-count">
          {scan ? `${scan.stage}…` : `${titleCount} titles`}
        </span>
      </nav>
    </FocusContext.Provider>
  );
}

/**
 * One rail's full contents.
 *
 * A container of its own for the same reason `SearchView` is one — the shell's
 * nav resolver treats its non-nav child as "the content", and cards parented
 * directly to the shell would make it fire on every vertical move inside the
 * grid.
 *
 * It claims focus rather than relying on the shell, because arriving here
 * always follows pressing "See all" on a card that is now unmounted, which is
 * the silent dead end in docs/GOTCHAS.md.
 */
function GridView({
  heading,
  titles,
  onSelect,
  onBack,
}: {
  heading: string;
  titles: Title[];
  onSelect: (title: Title) => void;
  onBack: () => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: GRID_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  useClaimFocus(GRID_FOCUS_KEY, true);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="search" ref={ref}>
        <div className="grid-head">
          <FocusButton className="back-button" keepInView="page-top" onSelect={onBack}>
            ← Back
          </FocusButton>
          <h2 className="grid-heading">
            {heading} <span className="muted">{titles.length}</span>
          </h2>
        </div>
        <div className="search-grid">
          {titles.map((title) => (
            <Card key={title.id} title={title} onSelect={onSelect} />
          ))}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

/**
 * The search view needs a container of its own so the shell has exactly two
 * children. Without it the grid cards become the shell's children directly, and
 * `resolveNavHop` — which cannot tell a card from a view — would fire on every
 * vertical move inside the grid.
 */
function SearchView({
  query,
  onQueryChange,
  results,
  onSelect,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  results: Title[];
  onSelect: (title: Title) => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: 'search-view',
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="search" ref={ref}>
        <SearchInput value={query} onChange={onQueryChange} />
        <div className="search-grid">
          {results.map((title) => (
            <Card key={title.id} title={title} onSelect={onSelect} />
          ))}
        </div>
        {results.length === 0 && <p className="muted center">No matches.</p>}
      </div>
    </FocusContext.Provider>
  );
}

/**
 * The search box, as a focusable.
 *
 * It has to be registered with the spatial system for two reasons. Focus has to
 * be able to *leave* it downwards into the results, which cannot happen if the
 * system does not know it exists — and `setFocus('search-input')` above is
 * addressed to this key, so without it that call has no target and silently
 * does nothing.
 *
 * Spatial focus and DOM focus are separate: the first decides where the remote
 * is, the second decides where the characters go. Both are needed here.
 */
function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { ref, focused } = useFocusable<object, HTMLInputElement>({
    focusKey: 'search-input',
  });

  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused, ref]);

  return (
    <input
      ref={ref}
      className={`search-input ${focused ? 'focused' : ''}`}
      placeholder="Search your library…"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
