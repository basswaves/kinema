/**
 * Playback view.
 *
 * Responsibilities beyond playing a file:
 *  - resume from a stored position, and keep that position current
 *  - remember audio/subtitle language per title and re-apply it per file
 *  - offer the next episode when one finishes
 *
 * The window is transparent and mpv renders behind the webview, so nothing here
 * may paint an opaque background **over a video frame**. The one opaque thing
 * is the cover shown *before* a file's first frame, which exists precisely
 * because a transparent window with no frame up shows the desktop.
 */
import { userError } from '../ui/errors';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  doesFocusableExist,
  FocusContext,
  getCurrentFocusKey,
  pause as pauseSpatial,
  resume as resumeSpatial,
  setFocus,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from '../ui/FocusButton';
import { isTvMode, useTvMode } from '../ui/tv';
import StatsPanel from './StatsPanel';
import TrackPanel, { TRACK_PANEL_KEY } from './TrackPanel';
import UpNextCard from './UpNextCard';
import { startOverlay } from './overlay';
import { capabilitiesNow } from '../capabilities';
import {
  fitWindowForPlayer,
  hasReachedEnd,
  isPaused,
  isPictureFullscreen,
  mpvCommand,
  nowPlaying,
  onPlaybackEvent,
  openFile,
  openPath,
  seekBy,
  seekTo,
  setPaused,
  setPictureFullscreen,
  startEngine,
  stopPlayback,
} from './engine';
import {
  readSubVisibility,
  readTracks,
  selectTrack,
  setSubtitleVisibility,
  type MpvTrack,
} from './tracks';
import {
  episodeRefLabel,
  getProgress,
  getSkipMarkers,
  getTitlePrefs,
  nextEpisode,
  previousEpisode,
  saveProgress,
  setTitlePrefs,
  type EpisodeRef,
  type SkipMarkers,
} from './api';
import {
  activeSkip,
  checkedAgainstFile,
  skipPromptFor,
  withResolvedCredits,
  CREDITS_TAIL_KEY,
  DEFAULT_CREDITS_TAIL_SECS,
} from './skip';
import { readChapters, type Chapter } from './chapters';
import { VIDEO_SYNC_KEY, VIDEO_SYNC_MODES } from './mpvOptions';
import { readPlaybackStats, type StatGroup } from './stats';
import { matchHdrToDisplay } from './displayHdr';
import {
  applyAudioPlan,
  applyFallback,
  fallbackNotice,
  noSoundNotice,
  releaseAudioDevice,
  silencedAudioTrack,
} from './audioOutput';
import { filmNow, mayswitch, restoreScreen, switchForFilm } from './displaySwitch';
import { getSetting } from '../metadata/api';
import { initialSession, loadFailedMessage, reduce, samePath } from './session';
import { COMMIT_IDLE_MS, scrubStep, type Scrub } from './scrub';
import { endsAtLabel } from '../ui/format';
import { resumePoint } from './resume';
import { chooseTracks, forcedTrack, readLanguageDefaults, spokenTrack } from './trackChoice';
import {
  fetchSubtitle,
  findSubtitles,
  forcedSubtitle,
  loadSubtitle,
  searchLanguages,
  subtitleStatus,
  type Offer,
} from './onlineSubtitles';
import { canonicalLang, languageName, systemLanguage } from './language';
import PlayerControls from './PlayerControls';
import ResumeToast from './ResumeToast';
import SkipButton from './SkipButton';
import { PLAYER_PLAY_KEY, PLAYER_SHELL_KEY, PLAYER_TRACKS_KEY } from './focusKeys';
import {
  applyMute,
  applyVolume,
  bitstreaming,
  clampVolume,
  persistVolume,
  savedVolume,
  VOLUME_STEP,
} from './volume';

export interface PlaybackTarget {
  path: string;
  label: string;
  fileId: number | null;
  titleId: number | null;
  /** Shown after the label at the top, where the caller knows it. */
  episodeName?: string | null;
  /** Ignore the stored position: "Play from start". */
  fromStart?: boolean;
}

interface Props {
  target: PlaybackTarget;
  onExit: () => void;
  onPlayTarget: (target: PlaybackTarget) => void;
}

const OSD_HIDE_MS = 3200;
/** With the ring on the controls and nothing pressed, this long hands the arrows back. */
const OSD_FOCUS_IDLE_MS = 6000;
const PROGRESS_SAVE_MS = 5000;
const NEXT_EPISODE_COUNTDOWN = 12;
/** Stats refresh. Fast enough to watch a drop counter, slow enough to be free. */
const STATS_REFRESH_MS = 1000;
/** Setting key: 'auto' skips without asking, anything else shows the button. */
const SKIP_MODE_KEY = 'skip_mode';
/**
 * How long the resolved marker sources must hold still before they are
 * logged. Chapters are read a moment after the file opens and can move the
 * credits source from `tail` to `chapter`; one line with the final answer is
 * worth more than two where the first is already wrong.
 */
const MARKER_LOG_SETTLE_MS = 3000;
/**
 * The longest the black cover may stay up waiting for a first frame. A file
 * with no video, or an mpv event that never comes, must not leave the picture
 * hidden: after this the cover goes regardless.
 */
const COVER_MAX_MS = 8000;
/**
 * How far a remote's fast-forward and rewind keys jump. Longer than the
 * arrows' 10 s: those are the fine control, these are for getting somewhere.
 */
const TRANSPORT_SKIP_SECS = 30;
/** How long after playback starts to check that the sound actually opened. */
const AUDIO_CHECK_MS = 1500;
/** How long a notice about the sound stays on screen. */
const AUDIO_NOTICE_MS = 12000;

/**
 * "Find subtitles online": search, show the best, and say what was shown —
 * or why nothing was. Kept out of the component; see `findOnline`.
 */
async function onlineSearch(
  fileId: number,
  path: string,
  language: string,
  show: (path: string, language: string, release?: string) => Promise<void>
): Promise<{ message: string; offers: Offer[] }> {
  const name = languageName(language) ?? language;
  try {
    const found = await findSubtitles(fileId, path, language);
    if (!found) return { message: `OpenSubtitles has no ${name} subtitles for this.`, offers: [] };
    await show(found.path, language, found.chosen.release);
    return {
      message: found.chosen.matches_file
        ? `Showing ${name} subtitles timed for this file.`
        : `Showing the most used ${name} subtitles. If they are out of step, choose another.`,
      offers: found.offers.filter((x) => x.file_id !== found.chosen.file_id),
    };
  } catch (e) {
    return { message: userError(e), offers: [] };
  }
}

/** "Choose another": fetch and show one, and say so. */
async function onlineChoice(
  fileId: number,
  offer: Offer,
  language: string,
  show: (path: string, language: string, release?: string) => Promise<void>
): Promise<string> {
  try {
    await show(await fetchSubtitle(fileId, offer.file_id, language), language, offer.release);
    return `Showing: ${offer.release || 'the one chosen'}.`;
  } catch (e) {
    return userError(e);
  }
}


export default function Player({ target, onExit, onPlayTarget }: Props) {
  const tv = useTvMode();
  /**
   * The life of the file mpv has open — loading, open, first frame, position,
   * ended — as one state machine. See `session.ts`, and GOTCHAS for why the
   * separate flags and ref mirrors it replaced kept disagreeing.
   */
  const [session, dispatch] = useReducer(reduce, target.path, initialSession);
  const { timePos, duration, paused, error } = session;
  /**
   * The latest session, for the few places that cannot re-render to read it:
   * the unmount save, the save interval, and the mpv listener's async work.
   * Written in a layout effect, so it is current before any passive effect or
   * cleanup reads it.
   */
  const sessionRef = useRef(session);
  useLayoutEffect(() => {
    sessionRef.current = session;
  });
  const fail = useCallback(
    (e: unknown) =>
      dispatch({ type: 'error', message: userError(e) }),
    []
  );
  const [osdVisible, setOsdVisible] = useState(true);
  const [tracks, setTracks] = useState<MpvTrack[]>([]);
  const [showTracks, setShowTracks] = useState(false);
  /**
   * "Find subtitles online" in the track panel (onlineSubtitles.ts): whether
   * this copy can, which of the offered languages is picked, and what the
   * last search found.
   */
  const [online, setOnline] = useState<{
    available: boolean;
    langIndex: number;
    finding: boolean;
    message: string | null;
    offers: Offer[];
  }>({ available: false, langIndex: 0, finding: false, message: null, offers: [] });
  /** The subtitle language from Settings, or Windows' when subtitles are off. */
  const [wantedSubLang, setWantedSubLang] = useState<string | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<StatGroup[]>([]);
  const [sid, setSid] = useState<number | null>(null);
  const [aid, setAid] = useState<number | null>(null);
  const [subVisible, setSubVisible] = useState(true);
  const [upNext, setUpNext] = useState<EpisodeRef | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  /**
   * Something the viewer should know that is not an error: the screen being
   * matched to the film, or the sound not opening the way it was asked to (the
   * failure that started this was silent — with a half-configured Windows
   * spatial sound, mpv opened no audio at all and the film played mute).
   */
  const [notice, setNotice] = useState<string | null>(null);
  /** How many of FALLBACKS have been tried for the file that is open. */
  const audioFallback = useRef(0);
  /**
   * The last audio track that was playing. mpv deselects the track when its
   * output fails to open, so this is what the fallback puts back.
   */
  const lastAid = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (aid !== null) lastAid.current = aid;
  }, [aid]);

  /**
   * Switch the screen for the file that is open, if the settings call for it,
   * with a word on screen while it happens. Never throws: a screen that will not
   * switch is a film that plays in the mode it is in.
   */
  const matchScreen = useCallback(async () => {
    const film = await filmNow().catch(() => null);
    if (!film) {
      // Said, because the film then plays in whatever mode the screen is in.
      console.warn('display: the first frame did not arrive in time; the screen is left as it is');
      return;
    }
    setNotice('Matching the screen to the video…');
    try {
      if (await switchForFilm(film)) await matchHdrToDisplay();
    } catch (e) {
      console.warn('display: switch failed', e);
    }
    setNotice(null);
  }, []);
  const [markers, setMarkers] = useState<SkipMarkers | null>(null);
  /**
   * The path the current `markers` were fetched for, once the fetch has
   * finished — including when it found nothing or failed. Until it equals
   * `target.path`, `markers` describe the previous file (or nothing yet).
   */
  const [markersFor, setMarkersFor] = useState<string | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [autoSkip, setAutoSkip] = useState(false);
  const [creditsTailSecs, setCreditsTailSecs] = useState(DEFAULT_CREDITS_TAIL_SECS);
  /** The episodes either side of this file, or null where there is none. */
  const [neighbours, setNeighbours] = useState<{
    prev: EpisodeRef | null;
    next: EpisodeRef | null;
  }>({ prev: null, next: null });
  /** Prompt occurrences the user (or the timer) has already dismissed. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  /**
   * Whether the OSD holds focus.
   *
   * This is the switch that decides which of the two live keyboard handlers
   * owns the arrow keys. Off (the default) the spatial system is paused and
   * arrows seek, exactly as a desktop player behaves. On, the spatial system is
   * resumed and arrows move between controls. Exactly one is ever active, which
   * is the whole point: `preventDefault` cannot stop the other listener, so
   * overlapping them would fire both.
   */
  const [osdFocus, setOsdFocus] = useState(false);

  const hideTimer = useRef<number | undefined>(undefined);
  /** Mirror of `osdFocus` for the callbacks that must not be rebuilt on it. */
  const osdFocusRef = useRef(false);

  // Every control in the player hangs off this container, so the OSD has one
  // place to aim focus at and one place to remember where it was.
  const { ref: shellRef, focusKey: shellFocusKey } = useFocusable({
    focusKey: PLAYER_SHELL_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey: PLAYER_PLAY_KEY,
  });
  /** The resume point handed to mpv with the load, for the toast once it opens. */
  const pendingSeek = useRef<number | null>(null);
  /** Segments already acted on automatically, so each is skipped once only. */
  const autoHandled = useRef(new Set<string>());
  /**
   * Frame-timing mode, in a ref rather than state because it is applied inside
   * the mpv event listener — reading it from a closure would apply whatever the
   * setting was when that listener was registered.
   */
  const videoSync = useRef<string>(VIDEO_SYNC_MODES.audio);

  const showOsd = useCallback(() => {
    setOsdVisible(true);
    window.clearTimeout(hideTimer.current);
    // Never time out while focus is inside the OSD. Hiding the thing the focus
    // ring is on leaves a remote pressing arrows at an invisible control, which
    // is indistinguishable from a hang — the same silent dead end as focus
    // parked on an unmounted component (docs/GOTCHAS.md).
    if (osdFocusRef.current || sessionRef.current.paused) return;
    hideTimer.current = window.setTimeout(() => setOsdVisible(false), OSD_HIDE_MS);
  }, []);

  /**
   * Hand the arrow keys to the OSD.
   *
   * `resume()` before `setFocus`: the spatial system ignores navigation while
   * paused, and aiming focus at a control it is not currently listening for
   * would leave the ring nowhere.
   */
  const enterOsdFocus = useCallback(() => {
    osdFocusRef.current = true;
    setOsdFocus(true);
    resumeSpatial();
    setOsdVisible(true);
    window.clearTimeout(hideTimer.current);
    void setFocus(PLAYER_PLAY_KEY);
  }, []);

  /**
   * Close a panel with the focus ring landing on the button that opened it.
   *
   * Focus moves **first**, while the panel is still there. Closing it with the
   * ring inside lets the spatial library restore focus by itself 300 ms after
   * the unmount — to the shell's preferred child, Pause — which overrode
   * anything set in the meantime (docs/GOTCHAS.md, "focus parked on an
   * unmounted component"). With the ring already outside, there is nothing to
   * restore.
   */
  const closeTracks = useCallback(() => {
    if (osdFocusRef.current) void setFocus(PLAYER_TRACKS_KEY);
    setShowTracks(false);
  }, []);
  // The stats panel has no button on the bar any more (it opens on `i`), so
  // closing it hands the ring to Play rather than to a button that is gone.
  const closeStats = useCallback(() => {
    if (osdFocusRef.current) void setFocus(PLAYER_PLAY_KEY);
    setShowStats(false);
  }, []);

  /** Give them back to seeking, and let the OSD start timing out again. */
  const leaveOsdFocus = useCallback(() => {
    osdFocusRef.current = false;
    setOsdFocus(false);
    pauseSpatial();
    showOsd();
  }, [showOsd]);

  /**
   * Arrows mean "seek" until asked otherwise, so the spatial system starts
   * paused — and is resumed on the way out, or the browsing UI underneath would
   * be left unable to navigate after the player closes.
   */
  useEffect(() => {
    pauseSpatial();
    return () => resumeSpatial();
  }, []);

  // ---- load, resume, and apply remembered tracks --------------------------
  useEffect(() => {
    let cancelled = false;

    /*
     * A new session: forget everything about the previous file. Until this
     * file is `open` (see session.ts), the position mpv keeps pushing is the
     * outgoing file's and is ignored — that, not the reset, is what stops the
     * credits logic concluding that an episode which has not started yet is
     * finishing.
     *
     * Runs after the progress-save cleanup, which is declared later and has
     * already written the outgoing file's position by this point.
     */
    dispatch({ type: 'load', path: target.path });
    /* eslint-disable react-hooks/set-state-in-effect */
    setMarkers(null);
    // A card offering the *previous* file's next episode has no business
    // surviving into this one. Nothing else clears these: the countdown path
    // clears them when it advances, and every other route out left them set.
    setUpNext(null);
    setCountdown(null);
    setNotice(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    audioFallback.current = 0;

    (async () => {
      try {
        await startEngine();
        if (cancelled) return;

        pendingSeek.current = null;

        // Decide the resume point *before* loading, and hand it to mpv as part
        // of the load. It used to be applied as a seek once `file-loaded`
        // arrived — seeking straight after loadfile fails, since nothing is
        // open yet — which meant every resumed episode first played its
        // opening frame and sound, then jumped. `mpv.log` showed each one
        // restarting at 0.000 and again at the resume point.
        //
        // "Play from start" skips it; the stored position is overwritten as
        // soon as this playback saves its own.
        if (target.fileId !== null && !target.fromStart) {
          pendingSeek.current = resumePoint(await getProgress(target.fileId));
        }

        // Before the file, so its first frame is already rendered for the
        // screen as it is now — see displayHdr.ts. A failure here must not
        // stop playback; the hint just stays as it was.
        await matchHdrToDisplay().catch((e) => console.warn('display: hint not applied', e));
        if (cancelled) return;
        // Likewise the sound: through Windows, or straight to the receiver
        // with whatever it takes passed through untouched. See audioOutput.ts.
        await applyAudioPlan().catch((e) => console.warn('audio: plan not applied', e));
        if (cancelled) return;

        // On a tiling desktop Kinema's window would be squeezed beside the
        // film's, and the controls drawn from it with it (displaySwitch.ts).
        if (await isPictureFullscreen().catch(() => false)) await fitWindowForPlayer('float');
        if (cancelled) return;

        // Opened at the resume point, not opened and then seeked.
        const start = pendingSeek.current;
        // With display switching on and the window fullscreen, the film opens
        // paused and waits for the screen — see displaySwitch.ts.
        const hold = await mayswitch().catch(() => false);
        if (hold) await setPaused(true);
        await openFile(target.path, start);
        if (hold) {
          await matchScreen();
          if (cancelled) return;
        }
        await setPaused(false);
      } catch (e) {
        if (!cancelled) fail(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [target.path, target.fileId, target.fromStart, fail, matchScreen]);

  /** Apply this title's remembered languages to the freshly loaded file. */
  const applyPrefs = useCallback(async () => {
    const list = await readTracks();
    setTracks(list);

    // This title's own choice if there is one, else the defaults in Settings
    // — see trackChoice.ts. A trailer (no title) takes the defaults too.
    let showForced = true;
    try {
      const [prefs, defaults] = await Promise.all([
        target.titleId !== null ? getTitlePrefs(target.titleId) : Promise.resolve(null),
        readLanguageDefaults(),
      ]);
      showForced = defaults.forced;
      const [mode, lang] = defaults.subs.split(':');
      setWantedSubLang(mode !== 'off' && lang ? lang : systemLanguage());
      const choice = chooseTracks(list, prefs, defaults);
      if (choice.aid !== null) await selectTrack('aid', choice.aid);
      if (choice.sid !== null) await selectTrack('sid', choice.sid);
      if (choice.subVisible !== null) await setSubtitleVisibility(choice.subVisible);
    } catch (e) {
      console.warn('could not apply track preferences', e);
    }

    // Selected track ids come from the track list's own `selected` flags.
    // Reading `sid`/`aid` directly fails with "unsupported format": they are
    // choice properties ("auto" / "no" / an integer), not plain integers.
    const updated = await readTracks();
    setTracks(updated);
    setAid(updated.find((t) => t.type === 'audio' && t.selected)?.id ?? null);
    setSid(updated.find((t) => t.type === 'sub' && t.selected)?.id ?? null);

    const visible = await readSubVisibility();
    setSubVisible(visible);

    // Forced subtitles from OpenSubtitles, for a file with none of its own —
    // only when switched on (Rust checks), never over full subtitles, and in
    // the language being spoken. After the film has started: nothing waits
    // for it.
    const fileId = target.fileId;
    const spoken = canonicalLang(spokenTrack(updated, null)?.lang);
    const selectedSub = updated.find((t) => t.type === 'sub' && t.selected);
    const fullSubsShowing = visible && selectedSub !== undefined && !selectedSub.forced;
    if (fileId !== null && spoken && showForced && !fullSubsShowing && !forcedTrack(updated, spoken)) {
      void (async () => {
        try {
          const path = await forcedSubtitle(fileId, target.path, spoken);
          if (!path) return;
          // The same file still playing, or the subtitle would land on the next.
          const playing = await openPath();
          if (!playing || !samePath(playing, target.path)) return;
          await loadSubtitle(path, spoken, true);
          const now = await readTracks();
          setTracks(now);
          setSid(now.find((t) => t.type === 'sub' && t.selected)?.id ?? null);
          setSubVisible(true);
          console.log(`forced ${spoken} subtitles from OpenSubtitles for ${target.path}`);
        } catch (e) {
          // Never fatal: the film plays on without them.
          console.warn('forced subtitles unavailable', e);
        }
      })();
    }
  }, [target.titleId, target.fileId, target.path]);

  /** The languages "Find subtitles online" can search in, first choice first. */
  const onlineLanguages = useMemo(
    () =>
      searchLanguages(
        wantedSubLang,
        spokenTrack(
          tracks,
          tracks.find((t) => t.type === 'audio' && t.id === aid) ?? null
        )?.lang ?? null
      ),
    [wantedSubLang, tracks, aid]
  );
  const onlineLanguage = onlineLanguages[online.langIndex % Math.max(1, onlineLanguages.length)];

  // Whether this copy can search at all: asked when the panel opens, since a
  // key can be entered in Settings while Kinema runs.
  useEffect(() => {
    if (!showTracks) return;
    let live = true;
    subtitleStatus()
      .then((s) => live && setOnline((o) => ({ ...o, available: s.available })))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [showTracks]);

  /** Put a fetched subtitle on screen and bring the track list up to date. */
  const showFetched = useCallback(
    async (path: string, language: string, release?: string) => {
      await loadSubtitle(path, language, false, release);
      const now = await readTracks();
      setTracks(now);
      setSid(now.find((t) => t.type === 'sub' && t.selected)?.id ?? null);
      setSubVisible(true);
    },
    []
  );

  // No try/catch here: the React Compiler behind the react-hooks rules cannot
  // follow a condition (?:, ||, ??) inside a try block, and gives up on the
  // whole component without a word — every other rule in this file went
  // quiet (GOTCHAS). The work is in `onlineSearch` / `onlineChoice` below
  // the component, which return what to show.
  const findOnline = useCallback(async () => {
    const fileId = target.fileId;
    const language = onlineLanguage;
    if (fileId === null || !language) return;
    setOnline((o) => ({ ...o, finding: true, message: null, offers: [] }));
    const shown = await onlineSearch(fileId, target.path, language, showFetched);
    setOnline((o) => ({ ...o, finding: false, ...shown }));
  }, [target.fileId, target.path, onlineLanguage, showFetched]);

  const chooseOffer = useCallback(
    async (offer: Offer) => {
      const fileId = target.fileId;
      const language = onlineLanguage;
      if (fileId === null || !language) return;
      setOnline((o) => ({ ...o, finding: true, message: null }));
      const message = await onlineChoice(fileId, offer, language, showFetched);
      setOnline((o) => ({
        ...o,
        finding: false,
        message,
        offers: o.offers.filter((x) => x.file_id !== offer.file_id),
      }));
    },
    [target.fileId, onlineLanguage, showFetched]
  );

  /**
   * The only way out of the player, and the only place that gives the desktop
   * back. Nothing in the browsing views can leave fullscreen, so landing on a
   * fullscreen Home is a state with no way out of it except starting another
   * video — which is why every exit path goes through here, including the ones
   * nobody pressed a key for.
   *
   * Declared up here with `handlePlaybackEnded` for the same reason that one is:
   * it is called from below, and defining it below only worked by accident of
   * effect ordering.
   */
  const exit = useCallback(async () => {
    // TV mode keeps the whole app fullscreen; the library goes on filling the
    // screen after the film, as a TV app would.
    if (!isTvMode() && (await isPictureFullscreen())) await setPictureFullscreen(false);
    await restoreScreen();
    onExit();
  }, [onExit]);


  /**
   * End of file. Declared above the listener that calls it — defining it below
   * only worked by accident of effect ordering.
   */
  const handlePlaybackEnded = useCallback(async () => {
    if (target.fileId === null) {
      await exit();
      return;
    }

    // Mark it finished so it leaves Continue Watching rather than sitting
    // there at 99%.
    const total = sessionRef.current.duration;
    if (total) await saveProgress(target.fileId, total, total).catch(() => undefined);

    try {
      const next = await nextEpisode(target.fileId);
      if (next) {
        setUpNext(next);
        setCountdown(NEXT_EPISODE_COUNTDOWN);
      } else {
        await exit();
      }
    } catch {
      await exit();
    }
  }, [target.fileId, exit]);

  /**
   * The newest versions of the callbacks the mpv listeners call.
   *
   * The listeners are registered **once per player**, and read these through
   * a ref. They used to list the callbacks as dependencies, so they were torn
   * down and re-registered whenever those changed — which was whenever the
   * screen behind the player re-rendered, since `onExit` arrives as a fresh
   * inline function each time. Re-registering is an IPC round trip, and an
   * event arriving in that gap is lost: a lost `file-loaded` left the episode
   * with no Skip button, no Up next and a frozen clock. `app.log`'s "Couldn't
   * find callback id" warnings were the same churn, seen from Tauri's side.
   */
  const latestHandlers = useRef({ applyPrefs, handlePlaybackEnded });
  useLayoutEffect(() => {
    latestHandlers.current = { applyPrefs, handlePlaybackEnded };
  });

  // ---- react to the engine ------------------------------------------------
  //
  // One subscription to the engine's events and one poll — each registered
  // once per player, each doing nothing but turning what the engine said into
  // a session event. What that event *means* is decided in `session.ts`, which
  // is where the rules about the outgoing file live.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    // A moment after playback (re)starts, make sure the sound opened; if it
    // did not, step through the fallbacks, checking again after each.
    const checkAudioSoon = () =>
      window.setTimeout(() => {
        void (async () => {
          if (disposed) return;
          const track = await silencedAudioTrack(lastAid.current);
          if (track === null) return;
          const step = audioFallback.current++;
          const system = capabilitiesNow()?.system ?? 'The system';
          if (await applyFallback(step, track).catch(() => false)) {
            setNotice(fallbackNotice(step, system));
            checkAudioSoon();
          } else {
            console.error('audio: no output could be opened for this file');
            setNotice(noSoundNotice(system));
          }
        })();
      }, AUDIO_CHECK_MS);

    onPlaybackEvent((event) => {
      if (event.type === 'restarted') {
        dispatch({ type: 'playback-restart' });
        checkAudioSoon();
      }

      if (event.type === 'loaded') {
        dispatch({ type: 'file-loaded' });
        void (async () => {
          const wanted = sessionRef.current.path;
          /*
           * Take the position and duration from mpv **by asking**, rather than
           * waiting to be told: pushes keep arriving while this runs, and
           * `duration` may only be pushed once per file. And ask which file
           * is open — a `file-loaded` from the outgoing episode can land just
           * after the new one's reset, and taking its position as the new
           * episode's is the bug GOTCHAS describes at length.
           */
          let open: string | null = null;
          let pos: number | null = null;
          let len: number | null = null;
          try {
            ({ path: open, position: pos, duration: len } = await nowPlaying());
          } catch (e) {
            console.warn('could not read position after load', e);
          }
          if (!samePath(open, wanted)) {
            console.warn(`file-loaded for ${open}, not ${wanted}: left alone`);
            return;
          }
          // The resume point went to mpv with the load; say so on screen.
          const resumed = pendingSeek.current;
          pendingSeek.current = null;
          // Open *before* the rest, not after. Everything below is per-file
          // polish — track languages, frame timing, chapters — and any one of
          // them throwing must not leave the file unable to offer a Skip button.
          dispatch({ type: 'opened', path: open, timePos: pos, duration: len, resumedFrom: resumed });

          await latestHandlers.current.applyPrefs();

          // Applied per file rather than once at init, so changing it in
          // Settings takes effect on the next thing you play instead of on the
          // next launch. mpv is definitely up by the time a file has loaded.
          // mpv's own setting, so mpv's own words: another engine times
          // frames its own way.
          await mpvCommand('set', ['video-sync', videoSync.current]).catch((e) =>
            console.warn('could not set video-sync', e)
          );

          // Chapters only exist once a file is open, and they are one of the
          // sources a credits marker can come from.
          setChapters(await readChapters());
        })();
      }

      // Still handled for completeness: this fires when keep-open is off, or
      // when a file ends for another reason. `other` is us tearing down or the
      // user leaving, which must not roll on to the next episode.
      if (event.type === 'ended') {
        if (event.reason === 'eof') dispatch({ type: 'eof' });
        // `openFile` resolves as soon as the engine *accepts* the file, so a
        // file that has been deleted, renamed or sits on a share that went
        // away fails here and nowhere else — without this, a black screen
        // reading `--:-- / --:--`, indistinguishable from a hang.
        if (event.reason === 'error') {
          dispatch({ type: 'error', message: loadFailedMessage(event.detail) });
          // Reveal the controls and leave them up: nothing is playing, so there
          // is nothing for them to cover, and Back is the way out.
          setOsdVisible(true);
        }
      }

      if (event.type === 'paused') dispatch({ type: 'pause', value: event.value });
      if (event.type === 'position') dispatch({ type: 'time-pos', value: event.value });
      if (event.type === 'duration') dispatch({ type: 'duration', value: event.value });
      // The real end-of-playback signal while keep-open holds the last frame.
      if (event.type === 'reached-end') dispatch({ type: 'eof' });
      // A key pressed on mpv's own window (Linux): pressed on this page the
      // way the self-test presses one, so every handler here takes it as is.
      if (event.type === 'key') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, bubbles: true }));
      }
    }).then((fn) => {
      // Torn down before registration finished: remove it now, or it leaks
      // and keeps receiving every event with a stale closure.
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * End-of-file detection by polling as well.
   *
   * `eof-reached` is also observed, but observed properties are registered when
   * mpv initialises — which happens once per window. Adding one later has no
   * effect until the app restarts, and that silent dependency already cost a
   * debugging round. Polling works regardless of when this code loads; the
   * session ignores the repeats.
   */
  useEffect(() => {
    const id = window.setInterval(async () => {
      if (sessionRef.current.ended) return;
      if (await hasReachedEnd()) dispatch({ type: 'eof' });
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  /**
   * The file ended — once per session, whichever of the three signals said so
   * first, or because its credits were skipped.
   */
  useEffect(() => {
    if (session.ended) void latestHandlers.current.handlePlaybackEnded();
  }, [session.ended, session.seq]);

  // ---- intro / credits skip ------------------------------------------------

  /**
   * Read the sidecar once per file. Deliberately not polled: it sits on the
   * same share as the video, and markers do not change mid-episode.
   */
  useEffect(() => {
    let cancelled = false;

    // A new file means the previous file's prompts are meaningless. Two
    // episodes commonly share an intro start, so these must be cleared by file
    // rather than left to the segment keys to distinguish.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setDismissed(null);
    // Chapters belong to the file that is open. Carrying the previous file's
    // over would place a credits marker at a time that means nothing here.
    setChapters([]);
    autoHandled.current.clear();
    // What was found online belongs to the file it was found for.
    setOnline((o) => ({ ...o, langIndex: 0, finding: false, message: null, offers: [] }));

    void (async () => {
      try {
        const found = await getSkipMarkers(target.path, target.fileId);
        if (!cancelled) setMarkers(found);
      } catch (e) {
        // Never fatal — no markers simply means no skip button.
        console.warn('skip markers unavailable', e);
      } finally {
        if (!cancelled) setMarkersFor(target.path);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [target.path, target.fileId]);

  /**
   * What is either side of this episode.
   *
   * Fetched once per file rather than on demand, because it decides whether the
   * previous/next buttons are drawn at all — a button that appears and then
   * turns out to lead nowhere is worse than one that was never offered.
   */
  useEffect(() => {
    const fileId = target.fileId;

    // Cleared first: until the answer for *this* file arrives, the previous
    // file's neighbours are wrong, and a button that jumps somewhere unrelated
    // is worse than one that appears a moment late.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setNeighbours({ prev: null, next: null });
    if (fileId === null) return;

    let cancelled = false;
    void Promise.all([previousEpisode(fileId), nextEpisode(fileId)])
      .then(([prev, next]) => {
        if (!cancelled) setNeighbours({ prev, next });
      })
      .catch((e) => console.warn('neighbouring episodes unavailable', e));

    return () => {
      cancelled = true;
    };
  }, [target.fileId]);

  // Read at playback time rather than held in the shell, so changing the
  // setting takes effect on the next episode without a restart.
  useEffect(() => {
    void getSetting(SKIP_MODE_KEY)
      .then((mode) => setAutoSkip(mode === 'auto'))
      .catch((e) => console.warn('could not read skip mode', e));

    void getSetting(CREDITS_TAIL_KEY)
      .then((raw) => {
        const secs = raw === null ? NaN : Number(raw);
        // An unset or unparsable value keeps the default; 0 is a real value
        // meaning "never guess", so it must not be treated as absent.
        if (Number.isFinite(secs) && secs >= 0) setCreditsTailSecs(secs);
      })
      .catch((e) => console.warn('could not read credits tail', e));

    void getSetting(VIDEO_SYNC_KEY)
      .then((mode) => {
        videoSync.current =
          mode === 'display' ? VIDEO_SYNC_MODES.display : VIDEO_SYNC_MODES.audio;
      })
      .catch((e) => console.warn('could not read video sync mode', e));
  }, []);

  /**
   * The markers actually acted on: whatever `skip.rs` ranked highest, with a
   * credits segment folded in from a chapter or from the tail guess when no
   * source supplied one.
   *
   * The guess is gated on there being a next episode. Without one, "skip the
   * credits" can only mean ending the film early, which is not a skip.
   *
   * Then a community-timed recap, or scene after the credits, that does not
   * fit this file's length is dropped here, where the length is known.
   */
  const resolved = useMemo(() => {
    const withCredits = withResolvedCredits(markers, {
      chapters,
      duration,
      tailSecs: creditsTailSecs,
      allowTailGuess: neighbours.next !== null,
    });
    return { ...withCredits, markers: checkedAgainstFile(withCredits.markers, duration) };
  }, [markers, chapters, duration, creditsTailSecs, neighbours.next]);

  /**
   * Where the credits start, for deciding what counts as watched — or null
   * when that is only the tail guess. A ref, because the progress save runs on
   * an interval and in an unmount cleanup, neither of which should be rebuilt
   * every time the markers settle.
   */
  const countedCreditsStart = useRef<number | null>(null);
  useEffect(() => {
    countedCreditsStart.current =
      resolved.creditsSource && resolved.creditsSource !== 'tail'
        ? (resolved.markers?.credits?.start ?? null)
        : null;
  }, [resolved]);

  /*
   * One line per file in app.log saying which source won each segment — the
   * first thing worth knowing when a skip fires somewhere surprising.
   *
   * Written only once this file is open *and* its own markers have arrived,
   * and only after the answer has held still for a moment. It used to log on
   * every change, keyed on the path: on an episode change the path moved
   * first, so the outgoing episode's markers were logged under the incoming
   * episode's name, followed by a `tail` line from the instant before the real
   * markers landed. The log then contradicted the database, which is the one
   * thing a diagnostic must never do.
   */
  const introSource = resolved.markers?.intro_source ?? null;
  const recapSource = resolved.markers?.recap_source ?? null;
  const creditsSource = resolved.creditsSource;
  const sceneSource = resolved.markers?.post_credits_source ?? null;
  useEffect(() => {
    if (!session.open || markersFor !== target.path) return;
    const id = window.setTimeout(() => {
      console.log(
        `markers for ${target.path}: intro from ${introSource ?? 'none'}, ` +
          `recap from ${recapSource ?? 'none'}, ` +
          `credits from ${creditsSource ?? 'none'}` +
          (sceneSource ? `, scene after the credits from ${sceneSource}` : '')
      );
    }, MARKER_LOG_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [session.open, markersFor, target.path, introSource, recapSource, creditsSource, sceneSource]);

  // Gated on the file being open, which is the whole defence against acting on
  // the outgoing file's position. One check here covers everything downstream:
  // the Skip button, automatic mode, and the Up next offer all derive from
  // `active`.
  const active = useMemo(
    () => (session.open ? activeSkip(resolved.markers, timePos) : null),
    [session.open, resolved.markers, timePos]
  );
  const activeKey = active?.key ?? null;
  /** The credits segment is the tail guess, not a marker or a chapter. */
  const guessedCredits = resolved.creditsSource === 'tail';
  const activeKind = active?.kind ?? null;
  /** The credits skip lands on a scene after them rather than ending the file. */
  const activeToScene = active?.toScene ?? false;

  const performSkip = useCallback(async () => {
    if (!active) return;
    if (active.kind !== 'credits' || active.toScene) {
      // Not dismissed: the seek itself takes the position past the segment,
      // so the button goes by itself — and seeking back into it brings it
      // back, which is what a remembered dismissal used to prevent. A scene
      // after the credits is a seek too: the film goes on to it.
      await seekTo(active.seekTo).catch(fail);
      showOsd();
    } else {
      setDismissed(active.key);
      // Credits: end the episode early rather than seeking. That routes into
      // the same up-next flow as a natural end, so there is one path to the
      // next episode instead of two that can disagree.
      dispatch({ type: 'end-early' });
    }
  }, [active, showOsd, fail]);

  // Automatic mode. The guard set makes this idempotent, which matters because
  // `active` is a fresh object on every position tick.
  useEffect(() => {
    if (!autoSkip || !active) return;
    // A scene after a film's credits is offered, never jumped to by itself:
    // see `ActiveSkip.toScene`.
    if (active.toScene) return;
    // Taking a credits segment *ends the file*. With nothing to move on to that
    // is not a skip, it is quitting a film a minute before the end. The prompt
    // path has always refused this; automatic mode did not, and the two new
    // credits sources make it reachable in a way a measured sidecar never was.
    if (active.kind === 'credits' && !neighbours.next) return;
    // A guessed credits start (`duration − N`) may offer, never decide — in
    // automatic mode too. It raises the Up next card below instead of ending
    // the file, so a wrong guess costs a card, not the end of the episode.
    if (active.kind === 'credits' && guessedCredits) return;
    // The intro is offered from 0:00, through any cold open. Pressing the
    // button there skips the cold open too, which is a person's choice to
    // make; automatic mode waits until the intro itself has begun.
    if (!active.inSegment) return;
    if (autoHandled.current.has(active.key)) return;
    autoHandled.current.add(active.key);
    void performSkip();
  }, [autoSkip, active, performSkip, neighbours.next, guessedCredits]);

  /**
   * Offer the next episode as soon as the credits start, without ending the
   * file.
   *
   * The card sits over the still-running video and carries **no countdown**:
   * the marker behind it may be a guess, and a guess is not entitled to make
   * the decision. A natural end still starts the countdown, as it always did.
   */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    // Automatic mode acts on measured credits by itself; a guess still only
    // gets to offer, so it falls through to the card.
    if (autoSkip && !guessedCredits) return;

    // An offer with no countdown is tied to *being in the credits*. When the
    // credits are no longer where we are — the file changed, the user seeked
    // back, or it was raised in error — the offer is stale and comes down.
    //
    // This effect used to only ever raise the card, which made every spurious
    // raise permanent: it sat over the next episode for its whole duration,
    // hiding the Skip intro button behind it. Being able to lower it again is
    // what makes the whole path self-correcting rather than one-way.
    //
    // A countdown means the file has genuinely ended and the next episode is
    // coming regardless, so that card is not an offer and must not be withdrawn.
    if (countdown !== null) return;

    // Credits with a scene after them are not the end of anything yet.
    if (
      activeKind !== 'credits' ||
      activeToScene ||
      !neighbours.next ||
      dismissed === activeKey
    ) {
      if (upNext) setUpNext(null);
      return;
    }
    if (!upNext) setUpNext(neighbours.next);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [
    autoSkip,
    guessedCredits,
    activeKind,
    activeKey,
    activeToScene,
    countdown,
    dismissed,
    neighbours.next,
    upNext,
  ]);

  // There is deliberately no timer taking the Skip intro button away. It used
  // to leave after ten seconds, which on an intro offered from 0:00 would
  // remove it before the intro had even begun; it now stays until the intro is
  // over, and the seek that skipping performs is what removes it.

  const skipPrompt = skipPromptFor(active, {
    autoSkip,
    upNextShown: upNext !== null,
    dismissed,
    hasNext: neighbours.next !== null,
  });

  /** Jump straight to a neighbouring episode, keeping the show's identity. */
  const playNeighbour = useCallback(
    (episode: EpisodeRef) => {
      onPlayTarget({
        path: episode.path,
        label: episodeRefLabel(episode),
        fileId: episode.file_id,
        episodeName: episode.name,
        titleId: target.titleId,
      });
    },
    [onPlayTarget, target.titleId]
  );

  // ---- persist progress ---------------------------------------------------
  useEffect(() => {
    if (target.fileId === null) return;
    const fileId = target.fileId;

    // Only a file that is open has a position of its own worth saving.
    const current = () => {
      const { open, timePos: position, duration: total } = sessionRef.current;
      return { position: open ? (position ?? 0) : 0, total };
    };

    const id = window.setInterval(() => {
      const { position, total } = current();
      if (position > 0) {
        void saveProgress(fileId, position, total, countedCreditsStart.current).catch(
          () => undefined
        );
      }
    }, PROGRESS_SAVE_MS);

    return () => {
      window.clearInterval(id);
      // Reading the ref's *latest* value at cleanup is the point here: the
      // session has not been reset for the next file yet, so this is still the
      // outgoing file's position. Copying it into the effect would be stale.
      const { position, total } = current();
      if (position > 0) {
        void saveProgress(fileId, position, total, countedCreditsStart.current).catch(
          () => undefined
        );
      }
    };
  }, [target.fileId]);

  // The cover never outstays its purpose: if no first frame is reported in
  // time — a file with no video, an event that never comes — it goes anyway.
  useEffect(() => {
    if (session.frameShown) return;
    const id = window.setTimeout(() => dispatch({ type: 'cover-timeout' }), COVER_MAX_MS);
    return () => window.clearTimeout(id);
  }, [session.frameShown, session.seq]);

  // A notice about the sound says its piece and goes; the film is playing.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), AUDIO_NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Stop playback when leaving, so audio does not continue behind the UI, and
  // give the screen its own mode back however the player was left.
  useEffect(() => {
    return () => {
      // Stopped first, so mpv has let go of the receiver's card before the
      // sound server is given it back (audioOutput.ts → holdDevice).
      void stopPlayback()
        .catch(() => undefined)
        .then(() => releaseAudioDevice());
      void restoreScreen();
      void fitWindowForPlayer('close');
    };
  }, []);

  // Where mpv has a window of its own, this page reaches the screen only as
  // a picture mpv draws over the video (overlay.ts), for as long as the
  // player is open.
  useEffect(() => {
    if (!capabilitiesNow()?.mpv_video.own_window) return;
    return startOverlay();
  }, []);

  // Countdown to the next episode.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      /* Timer-driven state machine, not state derived from render. */
      /* eslint-disable react-hooks/set-state-in-effect */
      if (upNext) {
        onPlayTarget({
          path: upNext.path,
          label: episodeRefLabel(upNext),
          fileId: upNext.file_id,
          titleId: target.titleId,
        });
      }
      setCountdown(null);
      setUpNext(null);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    const id = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [countdown, upNext, onPlayTarget, target.titleId]);

  /**
   * Poll the pipeline while the stats panel is open, and only then.
   *
   * Polling rather than observing, for the reason in GOTCHAS: observed
   * properties are registered when mpv initialises, which happens once per
   * window — a panel that added its own would show nothing until the whole app
   * restarted, and would look exactly like a panel that was simply wrong.
   */
  useEffect(() => {
    if (!showStats) return;

    let cancelled = false;
    const read = () => {
      void readPlaybackStats()
        .then((groups) => {
          if (!cancelled) setStats(groups);
        })
        .catch((e) => console.warn('stats read failed', e));
    };

    read();
    const id = window.setInterval(read, STATS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [showStats]);

  // ---- controls -----------------------------------------------------------
  /** Resolves to whether it is paused now, or null if mpv did not answer. */
  const togglePause = useCallback(async (): Promise<boolean | null> => {
    try {
      const current = await isPaused();
      await setPaused(!current);
      showOsd();
      return !current;
    } catch (e) {
      fail(e);
      return null;
    }
  }, [showOsd, fail]);

  /**
   * Pause or play from a key or the remote. Pausing puts the ring on
   * Play/Pause, so the next OK plays again and the arrows are already on the
   * controls — a paused film is when you want them. A mouse click on the
   * picture uses `togglePause` and moves nothing.
   */
  const togglePauseByKey = useCallback(async () => {
    if (await togglePause()) enterOsdFocus();
  }, [togglePause, enterOsdFocus]);

  const seekRelative = useCallback(
    async (delta: number) => {
      await seekBy(delta).catch(fail);
      showOsd();
    },
    [showOsd, fail]
  );

  /** Back to 0:00, from the "Resumed from" notice. */
  const startOver = useCallback(() => {
    dispatch({ type: 'resume-shown' });
    void seekTo(0).catch(fail);
    showOsd();
  }, [fail, showOsd]);

  // ---- seeking with Left/Right --------------------------------------------
  /** The seek being steered right now, shown on the bar until committed. */
  const scrubRef = useRef<Scrub | null>(null);
  /** The last committed one, so quick taps keep accelerating across commits. */
  const lastScrub = useRef<Scrub | null>(null);
  const scrubTimer = useRef<number | undefined>(undefined);

  /** Send the seek to mpv. Called on key release, or when presses stop. */
  const commitScrub = useCallback(() => {
    window.clearTimeout(scrubTimer.current);
    const s = scrubRef.current;
    if (!s) return;
    scrubRef.current = null;
    lastScrub.current = s;
    dispatch({ type: 'scrub-end' });
    void seekTo(s.target).catch(fail);
    showOsd();
  }, [fail, showOsd]);

  const scrubBy = useCallback(
    (dir: 1 | -1, repeat: boolean) => {
      const { timePos: position, duration: length } = sessionRef.current;
      if (!scrubRef.current) dispatch({ type: 'scrub-start' });
      const next = scrubStep(
        scrubRef.current ?? lastScrub.current,
        performance.now(),
        dir,
        repeat,
        position ?? 0,
        length
      );
      scrubRef.current = next;
      dispatch({ type: 'scrub', timePos: next.target });
      showOsd();
      // A remote that never sends a key release still gets its seek.
      window.clearTimeout(scrubTimer.current);
      scrubTimer.current = window.setTimeout(commitScrub, COMMIT_IDLE_MS);
    },
    [commitScrub, showOsd]
  );

  useEffect(() => () => window.clearTimeout(scrubTimer.current), []);

  /**
   * The clock, for "Ends at". Ticked rather than read during render, which
   * would make the render impure; every 15 s is plenty for a minute display,
   * and the position changing re-renders it in between anyway.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(id);
  }, []);

  // ---- volume -------------------------------------------------------------
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  /** Sound bitstreamed to a receiver: this volume would do nothing. */
  const [receiver, setReceiver] = useState(false);

  // The remembered level, applied once per player; mpv keeps it across files.
  useEffect(() => {
    let live = true;
    void savedVolume().then((level) => {
      if (!live) return;
      setVolume(level);
      void applyVolume(level).catch((e) => console.warn('volume: could not apply', e));
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Set the level outright. `save` is false while a mouse drags the bar, so a
   * drag is one saved setting when it is let go, not one per pixel.
   */
  const setVolumeLevel = useCallback(
    (value: number, save = true) => {
      const level = clampVolume(value);
      setVolume(level);
      void applyVolume(level).catch(fail);
      if (save) void persistVolume(level).catch((e) => console.warn('volume: could not save', e));
      // Turning it up is a clear enough request to hear something.
      if (muted && level > volume) {
        setMuted(false);
        void applyMute(false).catch(fail);
      }
      showOsd();
    },
    [volume, muted, fail, showOsd]
  );

  const changeVolume = useCallback(
    (delta: number) => setVolumeLevel(volume + delta),
    [volume, setVolumeLevel]
  );

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    void applyMute(next).catch(fail);
    showOsd();
  }, [muted, fail, showOsd]);

  /**
   * A volume key, asked of the sound path at the moment it is pressed rather
   * than of the last answer: a fallback part-way through a file can change it,
   * and a key that silently did nothing because of a stale answer is the kind
   * of failure nobody can report.
   */
  const volumeKey = useCallback(
    (act: () => void) => {
      void bitstreaming().then((yes) => {
        setReceiver(yes);
        if (yes) showOsd();
        else act();
      });
    },
    [showOsd]
  );

  const toggleFullscreen = useCallback(async () => {
    // In TV mode the window is always fullscreen and has no other state to
    // toggle to — see tv.ts.
    if (isTvMode()) return;
    const entering = !(await isPictureFullscreen());
    await setPictureFullscreen(entering);
    if (!entering) {
      await restoreScreen();
      return;
    }
    // Going fullscreen mid-film: pause, switch, and carry on as it was.
    if (!(await mayswitch().catch(() => false))) return;
    const wasPaused = sessionRef.current.paused;
    await setPaused(true);
    await matchScreen();
    if (!wasPaused) await setPaused(false);
  }, [matchScreen]);

  /**
   * The last rung of the Back ladder. Fullscreen is a layer in exactly the way
   * the panels are — something a key press put you into — so Back has to undo
   * it before it is allowed to mean anything else. Leaving the player from
   * fullscreen is then two presses, which is what every other video player on
   * this machine does.
   *
   * The window is asked rather than a `useState` mirror because fullscreen can
   * also change from outside this component — the title bar, Windows itself —
   * and a mirror would quietly disagree the first time it did.
   */
  const backOut = useCallback(async () => {
    if (!isTvMode() && (await isPictureFullscreen())) {
      await setPictureFullscreen(false);
      await restoreScreen();
      return;
    }
    // Through exit, not straight out: in TV mode the film may have switched
    // the screen's mode while fullscreen, and exit is what puts it back.
    await exit();
  }, [exit]);

  /** Changing a track also records the language for this whole title. */
  const chooseTrack = useCallback(
    async (kind: 'sid' | 'aid', track: MpvTrack | null) => {
      try {
        if (kind === 'sid' && track === null) {
          await setSubtitleVisibility(false);
          setSubVisible(false);
        } else if (track) {
          await selectTrack(kind, track.id);
          if (kind === 'sid') {
            await setSubtitleVisibility(true);
            setSubVisible(true);
            setSid(track.id);
          } else {
            setAid(track.id);
          }
        }

        if (target.titleId !== null) {
          const current = await getTitlePrefs(target.titleId);
          await setTitlePrefs(target.titleId, {
            audio_lang: kind === 'aid' ? (track?.lang ?? null) : current.audio_lang,
            sub_lang: kind === 'sid' ? (track?.lang ?? null) : current.sub_lang,
            sub_enabled: kind === 'sid' ? track !== null : current.sub_enabled,
          });
        }
      } catch (e) {
        fail(e);
      }
    },
    [target.titleId, fail]
  );

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case ' ':
          e.preventDefault();
          void togglePauseByKey();
          break;
        case 'f':
          void toggleFullscreen();
          break;
        // Back, one layer at a time: close whichever panel is open, then drop
        // out of OSD focus, then leave fullscreen, then leave the player.
        // Anything else would make the only way out of a panel a mouse click.
        //
        // Backspace is deliberately still the same key as Escape here: it is
        // what a remote's Back button sends, and two Back keys that stop at
        // different layers is the sort of split nobody remembers later.
        //
        // `BrowserBack` is what many remotes' Back button sends instead.
        case 'Escape':
        case 'Backspace':
        case 'BrowserBack':
          e.preventDefault();
          if (showTracks) {
            closeTracks();
          } else if (showStats) {
            closeStats();
          } else if (osdFocus) {
            leaveOsdFocus();
          } else {
            void backOut();
          }
          break;
        // Up or Down brings up the controls with the ring on them, as on any
        // streaming app. Once the OSD has the arrows, every one belongs to the
        // spatial system and this handler must not touch them —
        // `preventDefault` cannot stop the other listener, so acting on one
        // here would seek *and* move the focus ring on the same press.
        case 'ArrowUp':
        case 'ArrowDown':
          if (!osdFocus) {
            e.preventDefault();
            enterOsdFocus();
          }
          break;
        // Seek, faster the longer it is held — see scrub.ts.
        case 'ArrowLeft':
        case 'ArrowRight':
          if (osdFocus) break;
          e.preventDefault();
          scrubBy(e.key === 'ArrowLeft' ? -1 : 1, e.repeat);
          break;
        // Episode stepping. `n`/`p` for a keyboard; the media-key names are
        // what the transport buttons on a TV remote actually send, and a remote
        // has no letters to press instead.
        case 'n':
        case 'MediaTrackNext':
          if (neighbours.next) {
            e.preventDefault();
            playNeighbour(neighbours.next);
          }
          break;
        case 'p':
        case 'MediaTrackPrevious':
          if (neighbours.prev) {
            e.preventDefault();
            playNeighbour(neighbours.prev);
          }
          break;
        // The transport keys on a remote or a keyboard's media row. Handled in
        // both modes: they never move focus, so they cannot collide with the
        // spatial system the way the arrows would.
        case 'MediaPlayPause':
          e.preventDefault();
          void togglePauseByKey();
          break;
        case 'MediaPlay':
          e.preventDefault();
          void setPaused(false).then(showOsd);
          break;
        case 'MediaPause':
          e.preventDefault();
          void setPaused(true).then(enterOsdFocus);
          break;
        // Stop means leave the player, the same way out as Back takes from
        // the top of its ladder — including out of fullscreen.
        case 'MediaStop':
          e.preventDefault();
          void exit();
          break;
        case 'MediaFastForward':
          e.preventDefault();
          void seekRelative(TRANSPORT_SKIP_SECS);
          break;
        case 'MediaRewind':
          e.preventDefault();
          void seekRelative(-TRANSPORT_SKIP_SECS);
          break;
        // Volume, on mpv's keys and the obvious ones. While the receiver has
        // the volume they do nothing but bring up the bar that says so.
        case 'm':
          volumeKey(toggleMute);
          break;
        case '-':
        case '9':
          volumeKey(() => changeVolume(-VOLUME_STEP));
          break;
        case '+':
        case '=':
        case '0':
          volumeKey(() => changeVolume(VOLUME_STEP));
          break;
        // mpv's own key for its stats overlay, so the reflex transfers.
        case 'i':
          e.preventDefault();
          if (showStats) closeStats();
          else setShowStats(true);
          break;
        // OK on a remote. While the OSD holds focus this belongs entirely to
        // the spatial system, which activates whichever control the ring is on
        // — including the Skip and Up next buttons, which are focusable too.
        // Acting here as well would fire both handlers on one press.
        //
        // Otherwise it takes whichever prompt is showing, and with none it
        // pauses and resumes, which is what OK does on every streaming app.
        // It used to only reveal the controls, so pausing took Up, OK, Back.
        case 'Enter':
          if (osdFocus) break;
          e.preventDefault();
          if (session.resumedFrom !== null) {
            startOver();
          } else if (skipPrompt) {
            void performSkip();
          } else if (upNext) {
            setCountdown(0);
          } else {
            void togglePauseByKey();
          }
          break;
        default:
          showOsd();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    togglePauseByKey,
    toggleFullscreen,
    backOut,
    exit,
    seekRelative,
    showOsd,
    skipPrompt,
    performSkip,
    upNext,
    neighbours,
    playNeighbour,
    osdFocus,
    enterOsdFocus,
    leaveOsdFocus,
    showTracks,
    showStats,
    closeTracks,
    closeStats,
    scrubBy,
    volumeKey,
    toggleMute,
    changeVolume,
    session.resumedFrom,
    startOver,
  ]);

  /**
   * Whether the receiver has the volume, asked whenever the controls come up
   * — the only time the answer is on screen, and a cheap scalar read — and
   * again at the first frame: the controls are often already up while a file
   * opens, before its sound output exists, and the answer asked then was "no".
   */
  useEffect(() => {
    if (!osdVisible) return;
    let live = true;
    void bitstreaming().then((yes) => live && setReceiver(yes));
    return () => {
      live = false;
    };
  }, [osdVisible, target.path, session.frameShown]);

  /**
   * Letting go of Left/Right is what sends the seek. Only in watching mode:
   * on the controls, the seek bar's own release handler does it.
   */
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (!osdFocus && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) commitScrub();
    };
    window.addEventListener('keyup', onKeyUp);
    return () => window.removeEventListener('keyup', onKeyUp);
  }, [osdFocus, commitScrub]);

  /**
   * The controls step back out of the way on their own, as they do on any
   * streaming app — the ring used to stay on them until Back was pressed,
   * with the arrows still moving it instead of seeking. Not while paused, and
   * not while a panel or the Up next card is open: those are waiting for you.
   */
  const idleLeave = !paused && !showTracks && !showStats && upNext === null;
  useEffect(() => {
    if (!osdFocus || !idleLeave) return;
    let timer = window.setTimeout(leaveOsdFocus, OSD_FOCUS_IDLE_MS);
    const onKey = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(leaveOsdFocus, OSD_FOCUS_IDLE_MS);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [osdFocus, idleLeave, leaveOsdFocus]);

  /**
   * Paused, the controls stay up — the position and the way back to playing
   * are what you want to see. Playing again, they start timing out.
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    showOsd();
  }, [paused, showOsd]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    showOsd();
    return () => window.clearTimeout(hideTimer.current);
  }, [showOsd]);

  /**
   * Follow the track panel with the focus ring when it opens.
   *
   * Opening a panel and leaving focus on the button that opened it means the
   * first thing a remote has to do is work out which direction the new panel is
   * in. Only once the OSD holds focus — with a mouse, nothing should move on
   * its own. Closing is `closeTracks`, which has to act *before* the panel goes.
   */
  useEffect(() => {
    if (osdFocus && showTracks) void setFocus(TRACK_PANEL_KEY);
  }, [showTracks, osdFocus]);

  /**
   * Catch the ring when a control disappears from under it.
   *
   * Several of these controls come and go on their own: the Skip prompt goes
   * when the intro ends or is skipped, Up next is dismissed, the previous/next buttons are
   * absent at the ends of a run and are cleared on every file change. Focus left
   * on any of them points at a component that no longer exists — no ring
   * anywhere and no arrow press doing anything, which is indistinguishable from
   * a hang (docs/GOTCHAS.md).
   *
   * Keyed on whether each thing is present rather than on the values, because
   * `skipPrompt` is rebuilt on every position tick and would fire this once a
   * second. The liveness test is the same one the browsing views use.
   */
  const hasSkipPrompt = skipPrompt !== null;
  const hasUpNext = upNext !== null;
  useEffect(() => {
    if (!osdFocus) return;
    if (doesFocusableExist(getCurrentFocusKey())) return;
    void setFocus(PLAYER_SHELL_KEY);
  }, [
    osdFocus,
    hasSkipPrompt,
    hasUpNext,
    showStats,
    showTracks,
    neighbours.prev,
    neighbours.next,
  ]);

  const endsAt = endsAtLabel(timePos, duration, now);
  const subTracks = tracks.filter((t) => t.type === 'sub');
  const audioTracks = tracks.filter((t) => t.type === 'audio');

  return (
    <FocusContext.Provider value={shellFocusKey}>
    <div
      ref={shellRef}
      className={`player ${osdFocus ? 'osd-focused' : ''} ${
        osdVisible || showTracks || osdFocus ? '' : 'osd-hidden'
      }`}
      onMouseMove={showOsd}
      onClick={(e) => {
        if (
          (e.target as HTMLElement).closest(
            'button, input, .volume-control, .track-panel, .up-next, .stats-panel'
          )
        )
          return;
        void togglePause();
      }}
      onDoubleClick={(e) => {
        if (
          (e.target as HTMLElement).closest(
            'button, input, .volume-control, .track-panel, .up-next, .stats-panel'
          )
        )
          return;
        void toggleFullscreen();
      }}
    >
      {!session.frameShown && <div className="player-cover" aria-hidden="true" />}

      {error && <div className="player-error">{error}</div>}
      {notice && <div className="player-notice">{notice}</div>}

      {/* Resuming is automatic, so this is where starting over is offered —
          for as long as the notice shows, OK means "from the beginning". */}
      {session.resumedFrom !== null && (
        <ResumeToast
          resumedFrom={session.resumedFrom}
          onShown={() => dispatch({ type: 'resume-shown' })}
          onStartOver={startOver}
        />
      )}

      <div className="player-top">
        <FocusButton className="back-button" onSelect={() => void exit()}>
          ← Back
        </FocusButton>
        <span className="player-label">
          {target.label}
          {target.episodeName && <span className="player-episode"> · {target.episodeName}</span>}
        </span>
        {endsAt && <span className="player-ends">Ends at {endsAt}</span>}
      </div>

      {upNext && (
        <UpNextCard
          episode={upNext}
          countdown={countdown}
          onPlay={() => setCountdown(0)}
          onLeave={() => {
            setCountdown(null);
            setUpNext(null);
            void exit();
          }}
          onKeepWatching={() => {
            // Refuse the offer for the rest of this file. Dismissing by
            // segment rather than by a flag also silences the small credits
            // prompt, which would otherwise take its place.
            setUpNext(null);
            if (activeKey) setDismissed(activeKey);
          }}
        />
      )}

      {skipPrompt && <SkipButton prompt={skipPrompt} onSkip={() => void performSkip()} />}

      {/* Deliberately outside the OSD: the panel is for watching numbers move
          while the video plays, so hiding it with the idle timer would defeat
          the one thing it is for. */}
      {showStats && <StatsPanel stats={stats} onClose={closeStats} />}

      {showTracks && (
        <TrackPanel
          audioTracks={audioTracks}
          subTracks={subTracks}
          aid={aid}
          sid={sid}
          subVisible={subVisible}
          onChoose={(kind, track) => void chooseTrack(kind, track)}
          online={
            online.available && target.fileId !== null && onlineLanguage
              ? {
                  language: onlineLanguage,
                  canChangeLanguage: onlineLanguages.length > 1,
                  onChangeLanguage: () =>
                    setOnline((o) => ({
                      ...o,
                      langIndex: (o.langIndex + 1) % onlineLanguages.length,
                      message: null,
                      offers: [],
                    })),
                  onFind: () => void findOnline(),
                  finding: online.finding,
                  message: online.message,
                  offers: online.offers,
                  onOffer: (offer) => void chooseOffer(offer),
                }
              : null
          }
          onClose={closeTracks}
        />
      )}

      <PlayerControls
        timePos={timePos}
        duration={duration}
        paused={paused}
        neighbours={neighbours}
        showTracks={showTracks}
        volume={volume}
        muted={muted}
        receiver={receiver}
        tv={tv}
        onScrub={scrubBy}
        onScrubRelease={commitScrub}
        onSeekBarEnter={() => void togglePauseByKey()}
        onDragStart={() => dispatch({ type: 'scrub-start' })}
        onDrag={(seconds) => dispatch({ type: 'scrub', timePos: seconds })}
        onDragEnd={(seconds) => {
          dispatch({ type: 'scrub-end' });
          if (seconds !== null) void seekTo(seconds);
        }}
        onSeekBy={(seconds) => void seekRelative(seconds)}
        onTogglePause={() => void togglePause()}
        onPlayNeighbour={playNeighbour}
        onTracks={() => {
          if (showTracks) {
            closeTracks();
            return;
          }
          setShowTracks(true);
          void readTracks().then(setTracks);
        }}
        onVolumeChange={changeVolume}
        onVolumeSet={setVolumeLevel}
        onToggleMute={toggleMute}
        onFullscreen={() => void toggleFullscreen()}
      />
    </div>
    </FocusContext.Provider>
  );
}
