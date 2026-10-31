/**
 * The browsing shell: home, search and detail, plus handoff to the player.
 *
 * Search filters the already-loaded titles rather than querying — a personal
 * library is small enough that instant local filtering beats a round trip, and
 * it keeps typing responsive on a TV remote.
 */
import { describeError, userError } from './errors';
import { scanStageWords } from '../library/scanWords';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  init as initSpatial,
  doesFocusableExist,
  getCurrentFocusKey,
  setFocus,
  useFocusable,
  FocusContext,
  type FocusableComponent,
} from '@noriginmedia/norigin-spatial-navigation';
import Home, { HERO_PLAY_FOCUS_KEY } from './Home';
import { SCAN_OK_KEY } from './HomeNotices';
import TitleDetailView from './TitleDetail';
import CardGrid from './CardGrid';
import FocusButton from './FocusButton';
import Settings, { type SettingsTarget } from './Settings';
import { SETUP_PAGES_KEY } from './SetupPages';
import {
  hasPendingReturn,
  installFocusWatchdog,
  installReadOn,
  installScrollPace,
  recoverFocusSoon,
  currentFocusKey,
  returnFocusTo,
} from './focus';
import { back, current, navigate, open, replace, type Entry } from './history';
import { useFocusGroup, useNavGroup } from './focusGroups';
import { FocusScreen, NoriginLayer } from './focusEngine';
import { navFocus, navFocused, noteSpatialClaim, useLanding } from './focusStore';
import FocusGroup, { FocusProvider } from './FocusGroup';
import { setShortcutsOpen } from './shortcutsState';
import Player from '../player/Player';
import {
  continueWatching,
  episodeLabel,
  firstUnwatchedEpisode,
  dismissContinue,
  traktResumeSync,
  type ContinueItem,
  type PlaybackTarget,
} from '../player/api';
import { cacheArtwork, getSetting, setSetting } from '../metadata/api';
import { refreshReviewCount, useReviewCount } from '../metadata/reviewCount';
import { applyUpgrades, dismissUpgrades, readUpgrades, type Upgrade } from './qualityNotice';
import { dismissFfmpegNotice, readFfmpegNotice } from './ffmpegNotice';
import { ffmpegInstalled, useFfmpegInstall } from './ffmpegInstallState';
import { needsOwnTmdbKey } from '../metadata/builtinKey';
import { availableUpdate } from './updates';
import { scanTrouble as describeScanTrouble, type ScanTrouble } from './scanTrouble';
import { runScanPipeline, useScanStatus } from '../library/pipeline';
import { setPlaybackActive } from '../library/playback';
import { getTitleDetail, listTitles, powerAction, type Title } from './api';
import { listLibraryRoots, type LibraryRoot } from '../library/api';
import {
  dismissContinueVideo,
  listAllVideos,
  searchVideos,
  videoName,
  videoTarget,
  type VideoItem,
} from '../library/videos';
import { LibraryPage, VideosPage, VideoTile } from './VideosPages';
import { PlaylistPage, PlaylistsPage } from './PlaylistsPages';
import FoldersPage, { type FolderSpot } from './FoldersPage';
import { launchRequest, listenForVideos, targetFor, type OpenRequest } from '../library/opened';
import { keepSame } from './keepSame';
import { searchTitles, type SearchHit } from './search';
import {
  arrangeGrid,
  formatGridSetting,
  GRID_SORTS,
  gridSettingKey,
  parseGridSetting,
  type GridArrangement,
} from './gridSort';
import OnScreenKeyboard from './OnScreenKeyboard';
import { useTypingFocus } from './typing';
import { isTvMode, useTvMode } from './tv';
import LeaveDialog from './LeaveDialog';
import CardMenuHost from './CardMenu';
import CollectionPage from './CollectionPage';
import PersonPage from './PersonPage';
import PlaySomething from './PlaySomething';
import { isPlaySomethingKey, type Pool } from './somethingPick';
import { registerSelfTestPlay, runSelfTest, selfTestPlan } from '../selftest';
import { startEngine } from '../player/engine';
import './ui.css';

// Enable native-like arrow-key navigation. `useGetBoundingClientRect` makes
// hit-testing accurate when rails scroll horizontally.
//
// `throttle` is not about speed. The library re-measures the focused control on
// every press but reuses its neighbours' positions for 16 ms, and those
// positions are viewport-relative — so under key repeat, while a scroll is
// moving the page, one press compared fresh and stale positions and focus
// jumped backwards or sideways. Presses at least 25 ms apart always find every
// position stale, so all of them are measured at the same instant. A held key
// on Windows repeats at most every ~33 ms, so nothing a person does is dropped.
// `throttleKeypresses` because without it every key-up resets the throttle, and
// a remote that repeats as separate presses rather than a held key is exactly
// the case this is for. See GOTCHAS, "A scroll between two presses…".
initSpatial({
  debug: false,
  visualDebug: false,
  useGetBoundingClientRect: true,
  throttle: 25,
  throttleKeypresses: true,
});
installFocusWatchdog();
// Before read-on, which scrolls on the strength of what this has noted.
installScrollPace();
installReadOn();

/** The nav entries, in order. Detail and player are reached, not navigated to. */
type NavTarget = 'home' | 'movies' | 'tv' | 'library' | 'search' | 'settings';

/** The top bar, in order. Movies and TV shows open the whole shelf as a grid. */
const NAV_ITEMS: [NavTarget, string][] = [
  ['home', 'Home'],
  ['movies', 'Movies'],
  ['tv', 'TV shows'],
  // Everything else — Videos folders, and later Folders and Playlists — is a
  // tile on this page, so the bar never grows again (LOCAL-MEDIA.md, decision 1).
  ['library', 'Library'],
  ['search', 'Search'],
  ['settings', 'Settings'],
];

/** The three nav views carry no payload, which is exactly what makes them nav. */
type View =
  // `section` opens Settings on the review queue, or on the TMDB key field,
  // from the notices on Home.
  | { name: 'home' | 'library' | 'search' | 'settings'; section?: SettingsTarget }
  // One Videos folder, from a tile on the Library page.
  | { name: 'videos'; root: LibraryRoot }
  // Library → Playlists, and one playlist (PlaylistsPages.tsx).
  | { name: 'playlists' }
  | { name: 'playlist'; id: number }
  // Library → Folders, and where in it (FoldersPage.tsx).
  | { name: 'folders'; at: FolderSpot | null }
  | { name: 'detail'; title: Title }
  // Ids rather than the titles themselves, so the grid keeps showing current
  // rows after a reload rather than a snapshot taken when it was opened.
  // `kind` is a whole shelf from the top bar, read live from the library.
  | { name: 'grid'; heading: string; titleIds?: number[]; kind?: 'movie' | 'series' }
  // A smart collection (CollectionPage.tsx): a kept one by id, or a new one.
  | { name: 'collection'; id: string | null; kind?: 'movie' | 'series' }
  // An actor's page (PersonPage.tsx), from a title's cast: TMDB's id.
  | { name: 'person'; id: string; personName: string }
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
  /**
   * Whether the library has been read at least once. Until it has, "no
   * titles" means "not asked yet", not "empty" — and Home must not show the
   * first-run panel for it. It did, for about a second at every launch, and
   * that panel's focus claim was what left the remote dead afterwards.
   */
  const [loaded, setLoaded] = useState(false);
  const [resumable, setResumable] = useState<ContinueItem[]>([]);
  /** The library folders; the Library page's tiles are the Videos ones. */
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  // Started for a video (opened.ts): the player first, Home only beneath it.
  const [stack, setStack] = useState<Entry<View>[]>(() => {
    const home: Entry<View> = { view: { name: 'home' }, returnFocus: null };
    const opened = launchRequest();
    return opened ? [home, { view: { name: 'player', target: opened.target }, returnFocus: null }] : [home];
  });
  const view = current(stack);
  /**
   * Kinema was started to play a file: when it is done — it ends, or Back —
   * Kinema closes rather than showing Home (LOCAL-MEDIA.md, decision 2).
   * Already running when a file came, it goes back to where it was.
   */
  const closeWhenDone = useRef(launchRequest()?.launched ?? false);
  const [closing, setClosing] = useState(false);

  /** Open a view on top of this one; Back returns here, to `from`. */
  const openView = useCallback((next: View, from: string | null = currentFocusKey()) => {
    const scrollTop = document.querySelector('.browse')?.scrollTop;
    setStack((s) => open(s, next, from, scrollTop));
  }, []);

  /**
   * Stable, so the memoised rails and cards (Rail.tsx, Card.tsx) are not drawn
   * again by every render of the shell for a callback that only looks new.
   */
  const openDetail = useCallback((title: Title) => openView({ name: 'detail', title }), [openView]);
  const openGrid = useCallback(
    (heading: string, list: Title[]) =>
      openView({ name: 'grid', heading, titleIds: list.map((t) => t.id) }),
    [openView]
  );

  const goBack = useCallback(() => {
    const next = back(stack);
    if (next === stack) return;
    setStack(next);
    // Home entered from the top bar has nothing remembered; the ring would
    // otherwise stay up on the nav button that was pressed to leave it.
    returnFocusTo(next[next.length - 1].returnFocus ?? HERO_PLAY_FOCUS_KEY, next[next.length - 1].scrollTop);
  }, [stack]);
  /** The Close / Sleep / Shut down dialog, TV mode only (LeaveDialog.tsx). */
  const [leaving, setLeaving] = useState(false);
  /** Play something's answer is up, picking from this. */
  const [something, setSomething] = useState<Pool | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** The startup scan could not run at all. Not an error — see below. */
  const [scanFailed, setScanFailed] = useState<ScanTrouble | null>(null);
  /** The startup scan's problems, put into words as they stand (scanTrouble.ts). */
  const [scanErrors, setScanErrors] = useState<string[]>([]);
  /** Videos Kinema would not guess at, for the notice on Home and the badge. */
  const reviewCount = useReviewCount();
  const scanTrouble = scanFailed ?? describeScanTrouble(scanErrors, reviewCount > 0);
  const dismissScanTrouble = useCallback(() => {
    // OK by remote takes its own notice away: the ring goes to Play first, so
    // the library's own restore does not pick a neighbour by itself. A click
    // with the ring elsewhere leaves it there. The notice goes only once the
    // ring is there: setFocus is asynchronous, and OK unmounting while the
    // library still holds it as focused starts that restore anyway, which
    // then took the ring to the next notice's button.
    const clear = () => {
      setScanFailed(null);
      setScanErrors([]);
    };
    // On Kinema's engine (Home's) the move is made at once, so the notice
    // can go straight after.
    if (navFocused() === SCAN_OK_KEY && navFocus(HERO_PLAY_FOCUS_KEY)) clear();
    else if (getCurrentFocusKey() === SCAN_OK_KEY && doesFocusableExist(HERO_PLAY_FOCUS_KEY)) {
      void setFocus(HERO_PLAY_FOCUS_KEY).finally(clear);
    } else clear();
  }, []);
  /** What the equipment could do that is switched off — see qualityNotice.ts. */
  const [upgrades, setUpgrades] = useState<Upgrade[]>([]);
  const [keyRejected, setKeyRejected] = useState(false);
  /** ffmpeg cannot be found and the notice has not been waved away. */
  const [ffmpegMissing, setFfmpegMissing] = useState(false);
  /** Installed with the notice's own button: the notice goes at once. */
  const ffmpegJustInstalled = ffmpegInstalled(useFfmpegInstall().report);
  /** A newer Kinema, for the dot on Settings. */
  const [hasUpdate, setHasUpdate] = useState(false);
  /** The setup pages are up on Home (SetupPages.tsx). */
  const [setupOpen, setSetupOpen] = useState(false);
  /** Whether a launch has looked for setup pages left unfinished. */
  const setupLooked = useRef(false);

  // Once per launch, and never under a self-test, which must not touch the
  // network for anything it was not asked to.
  useEffect(() => {
    let live = true;
    void selfTestPlan()
      .then((plan) => (plan || closeWhenDone.current ? null : availableUpdate()))
      .then((release) => live && setHasUpdate(release !== null));
    return () => {
      live = false;
    };
  }, []);

  /**
   * Every Play from the browsing views comes through here. It used to hold
   * the first film back for a one-time question about the sound; that is a
   * notice on Home now, and nothing stands between Play and the film.
   */
  const startPlayback = useCallback(
    (target: PlaybackTarget) => openView({ name: 'player', target }),
    [openView]
  );

  /**
   * A video opened while Kinema runs — passed on by a second Kinema started
   * for it, or dropped on the window. It plays on top of whatever is open, and
   * Back returns there; over a film already playing, it takes its place.
   */
  useEffect(
    () =>
      listenForVideos(({ target }: OpenRequest) => {
        const from = getCurrentFocusKey();
        setStack((s) =>
          current(s).name === 'player'
            ? replace(s, { name: 'player', target })
            : open(s, { name: 'player', target }, from)
        );
      }),
    []
  );

  /**
   * The player moving on — Up next, Next, Previous — in place, without a step.
   * Once it has moved on to another episode of a show, Back goes to that
   * show's page rather than to wherever the first episode was started (Home's
   * Continue rail, say): the show is what is being watched now. A playlist or
   * a Videos folder keeps going back to where it was started.
   */
  const playOn = useCallback(
    (target: PlaybackTarget) =>
      setStack((s) => {
        const next = replace<View>(s, { name: 'player', target });
        const show =
          target.titleId !== null && !target.playlist && !target.video
            ? titles.find((t) => t.id === target.titleId && t.kind === 'series')
            : undefined;
        const below = next.length > 1 ? next[next.length - 2].view : null;
        if (!show || (below?.name === 'detail' && below.title.id === show.id)) return next;
        return [
          ...next.slice(0, -1),
          { view: { name: 'detail', title: show }, returnFocus: null },
          next[next.length - 1],
        ];
      }),
    [titles]
  );

  /** Leaving the player: Back, or Kinema closes if it was started for the file. */
  const exitPlayer = useCallback(() => {
    if (closeWhenDone.current) setClosing(true);
    else goBack();
  }, [goBack]);

  // The player has gone by now, and with it the save of where the video was
  // left (useProgressSave's cleanup). A moment for that to be written, then
  // Kinema closes.
  useEffect(() => {
    if (!closing) return;
    const id = window.setTimeout(() => {
      void powerAction('close').catch((e) => console.warn('could not close Kinema', e));
    }, 300);
    return () => window.clearTimeout(id);
  }, [closing]);

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
      // Pages left half-way when the app was closed open again, read with the
      // first list so Home never shows the library for a moment before them.
      const setup = setupLooked.current ? null : getSetting(SETUP_PAGES_KEY).catch(() => null);
      setupLooked.current = true;
      const [list, resume, setupState, folders] = await Promise.all([
        listTitles(),
        continueWatching(20),
        setup,
        listLibraryRoots(),
      ]);
      setRoots((shown) => keepSame(shown, folders, (r) => r.id));
      if (setupState === 'open') setSetupOpen(true);
      // A title with no files left is not watchable — unlinking a wrong match
      // leaves the cached title row behind, and it should not show up as a
      // card that plays nothing.
      // Each keeps the list already shown when the library has not changed
      // (keepSame.ts): Home is read every time it is shown, and drawing a
      // thousand identical cards again is the slowest thing a weak box does.
      const watchable = list.filter((t) => t.file_count > 0);
      setTitles((shown) => keepSame(shown, watchable, (t) => t.id));
      // A video's card has no title (title_id 0): its file tells it apart.
      setResumable((shown) =>
        keepSame(shown, resume, (item) => (item.kind === 'video' ? -item.file_id : item.title_id))
      );
      // Neither is worth an error on screen if it cannot be read: the notices
      // are extras, and Home is complete without them.
      void refreshReviewCount().catch((e) => console.warn('review count:', e));
      void readUpgrades()
        .then((found) => setUpgrades((shown) => keepSame(shown, found)))
        .catch((e) => console.warn('equipment notice:', e));
      void needsOwnTmdbKey()
        .then(setKeyRejected)
        .catch((e) => console.warn('TMDB key notice:', e));
      void readFfmpegNotice()
        .then(setFfmpegMissing)
        .catch((e) => console.warn('ffmpeg notice:', e));
    } catch (e) {
      setError(userError(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  const openSetup = useCallback(() => {
    setSetupOpen(true);
    void setSetting(SETUP_PAGES_KEY, 'open').catch((e) => console.warn('setup pages:', e));
  }, []);

  const closeSetup = useCallback(() => {
    setSetupOpen(false);
    void setSetting(SETUP_PAGES_KEY, 'done').catch((e) => console.warn('setup pages:', e));
  }, []);

  /**
   * The first-run panel's Scan: the setup pages go up at once and the scan
   * runs behind them. A failure is said the way a startup scan's is, since
   * the panel that asked has gone by the time it ends.
   */
  const firstScan = useCallback(() => {
    openSetup();
    void runScanPipeline()
      .then((outcome) => {
        if (outcome.status === 'failed') {
          setScanFailed({
            text: `Could not read your library folders: ${describeError(outcome.error)}`,
            note: null,
          });
        }
      })
      .catch((e) => console.warn('first scan:', e))
      .finally(() => void load());
  }, [load, openSetup]);

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
   *
   * The same holds for the other screens built from the title list, now that
   * posters show what has been watched: a grid or search results reached back
   * from a film would otherwise still show it as unwatched.
   */
  useEffect(() => {
    if (
      view.name !== 'home' &&
      view.name !== 'grid' &&
      view.name !== 'search' &&
      view.name !== 'library'
    )
      return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [view.name, load]);

  // Home's Continue rail: where another device stopped, from Trakt (read at
  // most every two minutes, trakt_resume.rs). Read again only if it changed.
  useEffect(() => {
    if (view.name !== 'home') return;
    let cancelled = false;
    traktResumeSync()
      .then((changed) => {
        if (!cancelled && changed > 0) void load();
      })
      .catch((e) => console.warn('trakt: resume points not read', e));
    return () => {
      cancelled = true;
    };
  }, [view.name, load]);

  // Fill in any artwork that is not cached yet, then reload so the local copies
  // are actually used. Titles matched before this existed have no local copy,
  // and a fresh match adds more — so this runs on every mount rather than once.
  useEffect(() => {
    let cancelled = false;
    // A self-test works on a copy of the library and must not download
    // anything into it or spend time on it — see src/selftest.ts.
    // Nor when started for a video: Kinema closes once it is done.
    selfTestPlan()
      .then((plan) =>
        plan || closeWhenDone.current ? { stored: 0, failed: 0 } : cacheArtwork()
      )
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
   * what it looks like from the sofa. The skipped folder's films stay on the
   * shelves and simply refuse to play, with no way to tell that from a broken
   * app. A quiet line naming the folder is the difference between "this app
   * is broken" and "the NAS is asleep". Other problems (a rejected TMDB key,
   * failed artwork) get the same line, without the word about a folder —
   * scanTrouble.ts.
   *
   * Deliberately not the red error banner: nothing is broken, the shelves are
   * browsing perfectly well from cache, and this must not look like a failure.
   */
  useEffect(() => {
    let cancelled = false;
    // Never under a self-test: the scan would end by running Skiptro and
    // ffmpeg over the real media, which is the opposite of a harmless test.
    // Nor when started for a video: it would read every library folder for
    // a Kinema that closes as soon as the video is done.
    selfTestPlan()
      .then((plan) => (plan || closeWhenDone.current ? null : runScanPipeline()))
      .then((outcome) => {
        if (cancelled || outcome === null) return;
        if (outcome.status === 'failed') {
          console.warn('startup scan failed:', outcome.error);
          setScanFailed({
            text: `Could not check your library folders: ${describeError(outcome.error)}`,
            note: null,
          });
          return;
        }
        if (outcome.status !== 'done') return;
        const { filesAdded, matched, artworkStored, movedToTmdb, errors } = outcome.summary;
        if (errors.length > 0) {
          console.warn('startup scan problems:', errors);
          setScanErrors(errors);
        }
        // Newly cached artwork counts too: without a reload, the shelves go on
        // showing the remote copies they loaded before the cache had them.
        const moved = movedToTmdb.films + movedToTmdb.shows;
        if (filesAdded > 0 || matched > 0 || artworkStored > 0 || moved > 0) void load();
      })
      .catch((e) => console.warn('startup scan:', e));
    return () => {
      cancelled = true;
    };
  }, [load]);

  /**
   * Start mpv now, while Home is on screen, rather than when Play is pressed.
   *
   * Starting it takes most of a second — loading the library, creating the
   * d3d11 device, making its window — and for all of that time the player
   * showed nothing, and a transparent window shows whatever is behind it.
   * Done here, its surface already exists behind this opaque view by the time
   * anything is played. Deferred a tick so it never delays the first paint.
   */
  useEffect(() => {
    const id = window.setTimeout(() => {
      void startEngine().catch((e) => console.warn('mpv: early start failed', e));
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  /**
   * Under a self-test, go straight to the player on the plan's file and let
   * the recorder take it from there. Outside one, this does nothing at all.
   */
  useEffect(() => {
    let cancelled = false;
    void selfTestPlan().then((plan) => {
      if (!plan || cancelled) return;
      // An interactive run (the Kinema MCP) names its own file on each `play`.
      const play = (target?: Partial<PlaybackTarget>) =>
        openView(
          {
            name: 'player',
            target: {
              path: target?.path ?? plan.path,
              label: target?.label ?? plan.label ?? 'Self-test',
              fileId: target?.fileId ?? plan.fileId,
              titleId: target?.titleId ?? plan.titleId,
              playlist: target?.playlist ?? plan.playlist,
            },
          },
          null
        );
      if (plan.interactive) {
        // Nothing opens by itself: the tester drives it.
      } else if (plan.openAfter) window.setTimeout(play, plan.openAfter * 1000);
      else play();
      // The same opening again for a plan's `play` action (leak runs).
      registerSelfTestPlay(play);
      void runSelfTest(plan).catch((e) => console.error('selftest failed', e));
    });
    return () => {
      cancelled = true;
      registerSelfTestPlay(null);
    };
  }, [openView]);

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
          await startPlayback({
            path: inProgress.path,
            label: episodeLabel(title.title, inProgress.season, inProgress.episode),
            fileId: inProgress.file_id,
            episodeName: inProgress.episode_name,
            titleId: title.id,
          });
          return;
        }

        if (title.kind === 'series') {
          const next = await firstUnwatchedEpisode(title.id);
          if (next) {
            await startPlayback({
              path: next.path,
              label: episodeLabel(title.title, next.season, next.episode),
              fileId: next.file_id,
              episodeName: next.name,
              titleId: title.id,
            });
            return;
          }
          setError(`No playable episode for “${title.title}”.`);
          return;
        }

        const detail = await getTitleDetail(title.id);
        if (detail.movie_path) {
          await startPlayback({
            path: detail.movie_path,
            label: title.title,
            fileId: detail.movie_file_id,
            titleId: title.id,
          });
          return;
        }

        setError(`No playable file for “${title.title}”.`);
      } catch (e) {
        setError(userError(e));
      }
    },
    [resumable, startPlayback]
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
      setResumable((current) =>
        current.filter((i) =>
          item.kind === 'video' ? i.file_id !== item.file_id : i.title_id !== item.title_id
        )
      );
      try {
        // A video's card is put away by its folder (videos.rs).
        if (item.kind === 'video') await dismissContinueVideo(item.file_id);
        else await dismissContinue(item.title_id);
      } catch (e) {
        setError(userError(e));
      }
      await load();
      // The Remove button that was pressed has just gone with its card.
      recoverFocusSoon();
    },
    [load]
  );

  const results = useMemo(() => searchTitles(titles, query), [titles, query]);
  // Videos are not titles: Search reads them when it opens (videos.ts).
  const [allVideos, setAllVideos] = useState<VideoItem[]>([]);
  useEffect(() => {
    if (view.name !== 'search') return;
    let live = true;
    void listAllVideos()
      .then((list) => live && setAllVideos(list))
      .catch((e) => console.warn('search: videos unavailable', e));
    return () => {
      live = false;
    };
  }, [view.name]);
  const videoResults = useMemo(() => searchVideos(allVideos, query), [allVideos, query]);

  /** Resolve a grid's stored ids, keeping the order the rail had them in. */
  const gridTitles = useMemo(() => {
    if (view.name !== 'grid') return [];
    if (view.kind) return titles.filter((t) => t.kind === view.kind);
    if (!view.titleIds) return [];
    const byId = new Map(titles.map((t) => [t.id, t]));
    return view.titleIds.map((id) => byId.get(id)).filter((t): t is Title => t !== undefined);
  }, [view, titles]);

  // Play something: on Home from the whole library, on a grid from what it
  // shows. S does the same as the button.
  const somethingPool = useMemo<Pool | null>(() => {
    if (view.name === 'home') return titles.length > 0 ? { titles, from: null } : null;
    if (view.name === 'grid') return { titles: gridTitles, from: view.heading };
    return null;
  }, [view, titles, gridTitles]);
  useEffect(() => {
    if (!somethingPool || something || leaving || setupOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isPlaySomethingKey(e)) return;
      e.preventDefault();
      setSomething(somethingPool);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [somethingPool, something, leaving, setupOpen]);

  // Back navigation, the way a remote expects it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (view.name === 'player') return; // the player owns its own keys
      if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack') {
        // In a text box Backspace deletes, as it should — but Escape and a
        // remote's Back leave, or the search box was a place Back could not
        // get out of.
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT') {
          if (e.key === 'Backspace') return;
          target.blur();
        }
        e.preventDefault();
        // Home with nowhere further back: in TV mode, the way out of the app.
        // At a desk the window's own close button is there, and Back here
        // does nothing, as before.
        if (view.name === 'home' && stack.length === 1 && isTvMode()) setLeaving(true);
        else goBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view.name, goBack, stack.length]);

  useEffect(() => {
    // Arriving from the top bar puts you in the box; coming Back from a result
    // puts you on that result instead, which returnFocusTo is already doing.
    if (view.name === 'search' && !hasPendingReturn()) {
      // A page's own landing: the top bar's ring is not handed back over it.
      noteSpatialClaim();
      setFocus('search-input');
    }
  }, [view.name]);

  // The library's background work gives way while a film is open (playback.ts).
  const inPlayer = view.name === 'player';
  useEffect(() => {
    setPlaybackActive(inPlayer);
    return () => setPlaybackActive(false);
  }, [inPlayer]);

  // Black, as the player's own cover is, for the moment before Kinema closes.
  if (closing) return <div className="player-cover" />;

  if (view.name === 'player') {
    return (
      <Player
        target={view.target}
        onPlayTarget={playOn}
        // Back to the page Play was pressed on. Home re-reads the library
        // whenever it is shown, so what just played is reflected there too.
        // Started for the file, Kinema closes instead.
        onExit={exitPlayer}
      />
    );
  }

  // Where Home shows its notices: titles there, and no setup pages over them.
  const scanTroubleOnHome = view.name === 'home' && titles.length > 0 && !setupOpen;

  return (
    <div className="browse" ref={shellRef}>
      <FocusContext.Provider value={shellFocusKey}>
        <TopNav
          active={
            view.name === 'grid' && view.kind
              ? view.kind === 'movie'
                ? 'movies'
                : 'tv'
              : ['videos', 'folders', 'playlists', 'playlist'].includes(view.name)
                ? 'library'
                : view.name
          }
          reviewCount={reviewCount}
          hasUpdate={hasUpdate}
          onNavigate={(target) => {
            const next: View =
              target === 'movies'
                ? { name: 'grid', heading: 'Movies', kind: 'movie' }
                : target === 'tv'
                  ? { name: 'grid', heading: 'TV shows', kind: 'series' }
                  : { name: target };
            setStack(navigate<View>({ name: 'home' }, next, target === 'home'));
          }}
        />

        {error && (
          <div className="browse-error" onClick={() => setError(null)}>
            {error}
          </div>
        )}

        {/* On Home with titles it is one of Home's notices, with an OK a
            remote can reach; elsewhere a line a click puts away. */}
        {scanTrouble && !scanTroubleOnHome && (
          <div
            className="browse-notice"
            onClick={dismissScanTrouble}
          >
            {scanTrouble.text}
            {scanTrouble.note && <span className="muted">. {scanTrouble.note}</span>}
          </div>
        )}

        {view.name === 'home' && (
          <Home
            titles={titles}
            loaded={loaded}
            resumable={resumable}
            onSelect={openDetail}
            onPlay={(title) => void playTitle(title)}
            onRemoveResumable={(item) => void removeResumable(item)}
            onFirstScan={firstScan}
            hasVideos={roots.some((r) => r.kind === 'videos' && r.file_count > 0)}
            folders={{
              count: roots.length,
              files: roots.reduce((sum, r) => sum + r.file_count, 0),
            }}
            onAddFolder={() => openView({ name: 'settings', section: 'folders' })}
            onOpenPlaylist={(id) => openView({ name: 'playlist', id })}
            onOpenCollection={(id) => openView({ name: 'collection', id })}
            setupOpen={setupOpen}
            onSetupClosed={closeSetup}
            reviewCount={reviewCount}
            onReview={() => openView({ name: 'settings', section: 'review' })}
            keyRejected={keyRejected}
            onAddKey={() => openView({ name: 'settings', section: 'tmdb-key' })}
            upgrades={upgrades}
            onApplyUpgrades={() =>
              void applyUpgrades(upgrades)
                .then(() => setUpgrades([]))
                .catch((e) => setError(userError(e)))
            }
            onChooseUpgrades={() => openView({ name: 'settings', section: 'picture' })}
            onDismissUpgrades={() =>
              void dismissUpgrades(upgrades)
                .then(() => setUpgrades([]))
                .catch((e) => setError(userError(e)))
            }
            ffmpegMissing={ffmpegMissing && !ffmpegJustInstalled}
            scanTrouble={scanTrouble}
            onDismissScanTrouble={dismissScanTrouble}
            onFfmpeg={() => openView({ name: 'settings', section: 'ffmpeg' })}
            onDismissFfmpeg={() =>
              void dismissFfmpegNotice()
                .then(() => setFfmpegMissing(false))
                .catch((e) => setError(userError(e)))
            }
            onSeeAll={openGrid}
            onPlaySomething={() => somethingPool && setSomething(somethingPool)}
            onResume={(item) =>
              void startPlayback(
                item.kind === 'video'
                  ? {
                      path: item.path,
                      label: videoName(item.episode_name ?? item.path),
                      fileId: item.file_id,
                      titleId: null,
                      video: true,
                    }
                  : {
                      path: item.path,
                      label: episodeLabel(item.title, item.season, item.episode),
                      fileId: item.file_id,
                      episodeName: item.episode_name,
                      titleId: item.title_id,
                    }
              )
            }
          />
        )}

        {view.name === 'library' && (
          <LibraryPage
            roots={roots}
            onOpen={(root) => openView({ name: 'videos', root })}
            onFolders={() => openView({ name: 'folders', at: null })}
            onPlaylists={() => openView({ name: 'playlists' })}
            onSettings={() => openView({ name: 'settings', section: 'videos' })}
            onLibraryChanged={() => void load()}
          />
        )}

        {view.name === 'folders' && (
          <FoldersPage
            at={view.at}
            roots={roots}
            onMove={(at) => setStack((s) => replace(s, { name: 'folders', at }))}
            onPlay={(path) => {
              const from = getCurrentFocusKey();
              // Only if still on Folders when the library has answered.
              void targetFor(path).then((target) =>
                setStack((s) =>
                  current(s).name === 'folders' ? open(s, { name: 'player', target }, from) : s
                )
              );
            }}
            onBack={goBack}
            onLibraryChanged={() => void load()}
          />
        )}

        {view.name === 'playlists' && (
          <PlaylistsPage onOpen={(id) => openView({ name: 'playlist', id })} onBack={goBack} />
        )}

        {view.name === 'playlist' && (
          <PlaylistPage id={view.id} onPlay={(target) => void startPlayback(target)} onBack={goBack} />
        )}

        {view.name === 'videos' && (
          <VideosPage root={view.root} onPlay={(target) => void startPlayback(target)} onBack={goBack} />
        )}

        {view.name === 'search' && (
          <SearchView
            query={query}
            onQueryChange={setQuery}
            results={results}
            videos={videoResults}
            onSelect={openDetail}
            onPlayVideo={(video) => void startPlayback(videoTarget(video))}
          />
        )}

        {view.name === 'grid' && (
          // On Kinema's own engine (focusEngine.tsx, round 7). Each shelf a
          // screen of its own: from Movies to TV shows lands again.
          <FocusScreen key={view.heading}>
          <GridView
            heading={view.heading}
            titles={gridTitles}
            // A whole shelf from the top bar has the bar for getting away;
            // a See-all grid was reached from a rail and goes back to it.
            showBack={!view.kind}
            onSelect={openDetail}
            onBack={goBack}
            onPlaySomething={() => somethingPool && setSomething(somethingPool)}
            onNewCollection={
              view.kind ? () => openView({ name: 'collection', id: null, kind: view.kind }) : undefined
            }
          />
          </FocusScreen>
        )}

        {view.name === 'collection' && (
          <CollectionPage
            key={view.id ?? 'new'}
            titles={titles}
            id={view.id}
            kind={view.kind}
            onSelect={openDetail}
            onBack={goBack}
            onSaved={(id) => setStack((s) => replace(s, { name: 'collection', id }))}
          />
        )}

        {view.name === 'settings' && (
          <Settings
            openSection={view.section}
            onRunSetup={() => {
              openSetup();
              setStack(navigate<View>({ name: 'home' }, { name: 'home' }, true));
            }}
          />
        )}

        {view.name === 'person' && (
          <PersonPage
            key={view.id}
            personId={view.id}
            name={view.personName}
            titles={titles}
            onSelect={openDetail}
            onBack={goBack}
          />
        )}

        {view.name === 'detail' && (
          <TitleDetailView
            key={view.title.id}
            title={view.title}
            onBack={goBack}
            onOpenTitle={openDetail}
            onOpenPerson={(id, personName) => openView({ name: 'person', id, personName })}
            onPosterChosen={() => void load()}
            onFindMatch={() =>
              setStack((s) => replace(s, { name: 'settings', section: 'review' }))
            }
            onRelinked={(id) =>
              // The page it was on is the wrong title's: the right one's in its
              // place, or, unlinked, the queue where the files now wait.
              void listTitles()
                .then((list) => {
                  const right = id === null ? undefined : list.find((t) => t.id === id);
                  setStack((s) =>
                    replace(
                      s,
                      right ? { name: 'detail', title: right } : { name: 'settings', section: 'review' }
                    )
                  );
                })
                .catch((e: unknown) => setError(userError(e)))
                .finally(() => void load())
            }
            onPlayFile={(request) =>
              void startPlayback({
                ...request,
                // Explicit null means "not on behalf of this title" — a trailer
                // must not adopt or overwrite the show's track preferences.
                titleId:
                  request.titleId === undefined
                    ? (view as { title: Title }).title.id
                    : request.titleId,
              })
            }
          />
        )}

        {/* Dialogs still on the spatial library: they take the keys from
            Kinema's own engine while open (focusEngine.tsx). */}
        {leaving && (
          <NoriginLayer>
            <LeaveDialog onClose={() => setLeaving(false)} />
          </NoriginLayer>
        )}
        {/* The menu on cards (cardMenuStore.ts), over whichever screen the card is on. */}
        <CardMenuHost
          onPlay={(title) => void playTitle(title)}
          onOpen={openDetail}
          onChanged={() => void load()}
        />

        {something && (
          <NoriginLayer>
            <PlaySomething
              pool={something}
              resumable={resumable}
              onPlay={(title) => void playTitle(title)}
              onClose={() => setSomething(null)}
            />
          </NoriginLayer>
        )}
      </FocusContext.Provider>
    </div>
  );
}

const navKey = (name: string) => `nav:${name}`;

/**
 * The nav bar, as its own component so that its container is created *inside*
 * the shell's focus context and is therefore parented to the shell. Declaring
 * this `useFocusable` up in `Browse` would read `Browse`'s own context — the
 * root — no matter which providers `Browse` renders, which is a quiet way to
 * end up with a focus tree that does not match the markup.
 */
function TopNav({
  active,
  reviewCount,
  hasUpdate,
  onNavigate,
}: {
  active: string;
  reviewCount: number;
  hasUpdate: boolean;
  onNavigate: (target: NavTarget) => void;
}) {
  // A row landing on the open section (NAV-MAP, agreed 2026-10-11): Up from
  // Home's Play, from Settings' list or a section's first row is the section
  // you are in, not the button last used or the one nearest.
  const { ref, focusKey } = useFocusGroup<HTMLElement>('row', {
    focusKey: NAV_FOCUS_KEY,
    current: navKey(active),
    // The top of the page: the ring here brings the page back to it.
    pageTop: true,
  });

  // A scan is the only long-running thing the app does on its own, so it says
  // so at the end of the bar rather than interrupting anything. Otherwise that
  // spot is empty: a running title count told nobody anything they acted on.
  const scan = useScanStatus();

  return (
    <FocusProvider value={focusKey}>
      {/* `data-sticky-top`: what the one scroll rule keeps clear (focusScroll.ts). */}
      <nav className="top-nav" ref={ref} data-sticky-top="">
        <span className="brand">Kinema</span>
        {NAV_ITEMS.map(([name, label]) => (
          <FocusButton
            key={name}
            focusKey={navKey(name)}
            className={active === name ? 'active' : ''}
            keepInView="page-top"
            onSelect={() => onNavigate(name)}
          >
            {label}
            {name === 'settings' && reviewCount > 0 && (
              <span className="nav-badge" aria-label={`${reviewCount} to review`}>
                {reviewCount}
              </span>
            )}
            {/* Beside a count too: a library with titles to review hid it for
                good, which read as "Android has no update notice" (owner,
                2026-10-24). */}
            {name === 'settings' && hasUpdate && (
              <span className="nav-dot" aria-label="A new version is available" />
            )}
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
        {scan && <span className="nav-count">{scanStageWords(scan.stage)}</span>}
      </nav>
    </FocusProvider>
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
  showBack,
  onSelect,
  onBack,
  onPlaySomething,
  onNewCollection,
}: {
  heading: string;
  titles: Title[];
  showBack: boolean;
  onSelect: (title: Title) => void;
  onBack: () => void;
  onPlaySomething: () => void;
  /** A whole shelf's: a smart collection made from it (CollectionPage.tsx). */
  onNewCollection?: () => void;
}) {
  // The page: its heading row, the order row and the cards, one above the other.
  const { ref, focusKey } = useNavGroup(
    { kind: 'column' },
    { focusKey: GRID_FOCUS_KEY, trackChildren: true, saveLastFocusedChild: true }
  );

  const [arrangement, setArrangement] = useState<GridArrangement>({
    sort: 'added',
    unwatched: false,
    reversed: false,
  });
  useEffect(() => {
    let live = true;
    void getSetting(gridSettingKey(heading))
      .then((raw) => live && setArrangement(parseGridSetting(raw)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [heading]);
  const arrange = (next: GridArrangement) => {
    setArrangement(next);
    void setSetting(gridSettingKey(heading), formatGridSetting(next)).catch((e) => console.warn('grid: could not remember the order', e));
  };
  const shown = useMemo(
    () => arrangeGrid(titles, arrangement.sort, arrangement.unwatched, arrangement.reversed),
    [titles, arrangement]
  );
  const entries = useMemo(() => shown.map((title) => ({ title })), [shown]);

  // Land on the first title, not on Back or the sort buttons above it.
  const first = shown[0] ? `grid:${shown[0].id}` : GRID_FOCUS_KEY;
  useLanding(titles.length > 0 || shown.length === 0 ? first : null);

  return (
    <FocusProvider value={focusKey}>
      <div className="search" ref={ref}>
        <FocusGroup kind="row" className="grid-head">
          {showBack && (
            <FocusButton className="back-button" keepInView="page-top" onSelect={onBack}>
              ← Back
            </FocusButton>
          )}
          <h2 className="grid-heading">
            {heading} <span className="muted">{shown.length}</span>
          </h2>
          {/* Within what this page shows: a genre, a collection, a shelf. */}
          {titles.length > 0 && (
            <FocusButton
              focusKey="grid-play-something"
              className="btn-secondary grid-something"
              keepInView="page-top"
              onSelect={onPlaySomething}
            >
              Play something
            </FocusButton>
          )}
          {onNewCollection && titles.length > 0 && (
            <FocusButton
              focusKey="grid-new-collection"
              className="btn-secondary"
              keepInView="page-top"
              onSelect={onNewCollection}
            >
              New collection
            </FocusButton>
          )}
        </FocusGroup>
        {/* A row landing on the order in use (NAV-MAP, agreed 2026-10-11):
            Up from the first row of films is the order you chose. */}
        <FocusGroup
          kind="row"
          current={`grid-sort:${arrangement.sort}`}
          className="grid-controls choice-options"
          role="group"
          aria-label="Order"
        >
          {GRID_SORTS.map((s) => (
            <FocusButton
              key={s.value}
              focusKey={`grid-sort:${s.value}`}
              className={`choice ${arrangement.sort === s.value ? 'chosen' : ''}`}
              keepInView="page-top"
              title={arrangement.sort === s.value ? 'Press again to flip the order' : undefined}
              onSelect={() =>
                arrange({
                  ...arrangement,
                  sort: s.value,
                  reversed: arrangement.sort === s.value ? !arrangement.reversed : false,
                })
              }
            >
              {s.label}
              {arrangement.sort === s.value && (arrangement.reversed ? ' ↑' : ' ↓')}
            </FocusButton>
          ))}
          <FocusButton
            focusKey="grid-unwatched"
            className={`choice grid-filter ${arrangement.unwatched ? 'chosen' : ''}`}
            keepInView="page-top"
            onSelect={() => arrange({ ...arrangement, unwatched: !arrangement.unwatched })}
          >
            {arrangement.unwatched ? '✓ ' : ''}Unwatched only
          </FocusButton>
        </FocusGroup>
        {titles.length === 0 && <p className="muted">Nothing here yet.</p>}
        {titles.length > 0 && shown.length === 0 && (
          <p className="muted">Everything here has been watched. Switch off “Unwatched only” to see it all.</p>
        )}
        <CardGrid name="grid" entries={entries} onSelect={onSelect} fromAboveFirst />
      </div>
    </FocusProvider>
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
  videos,
  onSelect,
  onPlayVideo,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  results: SearchHit[];
  videos: VideoItem[];
  onSelect: (title: Title) => void;
  onPlayVideo: (video: VideoItem) => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: 'search-view',
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  const tv = useTvMode();

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="search" ref={ref}>
        <SearchInput value={query} onChange={onQueryChange} />
        {/* The TV layout gets letters a remote can reach; a desk has a keyboard. */}
        {tv && <OnScreenKeyboard value={query} onChange={onQueryChange} />}
        <p className="muted search-hint">Titles, actors, genres or a year.</p>
        <CardGrid name="search" entries={results} onSelect={onSelect} />
        {videos.length > 0 && (
          <>
            <h3 className="search-videos-heading">Videos</h3>
            <div className="videos-tiles">
              {videos.map((video) => (
                <VideoTile key={video.id} video={video} onPlay={() => onPlayVideo(video)} />
              ))}
            </div>
          </>
        )}
        {results.length === 0 && videos.length === 0 && (
          <p className="muted center">No matches.</p>
        )}
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

  // And let go when the remote moves on: a box that kept the caret after the
  // ring had gone down to the keyboard showed two things selected at once.
  // Where the system has a keyboard of its own, OK here opens it (typing.ts).
  const enterKey = useTypingFocus(ref, focused);

  return (
    <input
      ref={ref}
      className={`search-input ${focused ? 'focused' : ''}`}
      placeholder="Search your library…"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') enterKey(e);
      }}
    />
  );
}
