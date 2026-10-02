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
import TrackPanel from './TrackPanel';
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
  seekBy,
  seekTo,
  setPaused,
  setPictureFullscreen,
  startEngine,
  stopPlayback,
} from './engine';
import { getProgress, saveProgress } from './api';
import { skipPromptFor } from './skip';
import { readChapters } from './chapters';
import { VIDEO_SYNC_KEY, VIDEO_SYNC_MODES } from './mpvOptions';
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
import { endsAtLabel } from '../ui/format';
import { resumePoint } from './resume';
import PlayerControls from './PlayerControls';
import ResumeToast from './ResumeToast';
import SkipButton from './SkipButton';
import { PLAYER_PLAY_KEY, PLAYER_SHELL_KEY } from './focusKeys';
import { VOLUME_STEP } from './volume';
import { useOnlineSubtitles } from './useOnlineSubtitles';
import { useNeighbours } from './useNeighbours';
import { usePanels } from './usePanels';
import { useScrub } from './useScrub';
import { useSkipMarkers } from './useSkipMarkers';
import { useTracks } from './useTracks';
import { useUpNext } from './useUpNext';
import { useVolume } from './useVolume';

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
  const {
    tracks,
    aid,
    sid,
    subVisible,
    wantedSubLang,
    lastAid,
    applyPrefs,
    showFetched,
    chooseTrack,
    refreshTracks,
  } = useTracks({ target, fail });
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

  const { showTracks, openTracks, closeTracks, showStats, openStats, closeStats, stats } =
    usePanels({ osdFocus, osdFocusRef });

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNotice(null);
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

  const onlinePanel = useOnlineSubtitles({
    target,
    tracks,
    aid,
    wantedSubLang,
    showTracks,
    showFetched,
  });

  /**
   * The only way out of the player, and the only place that gives the desktop
   * back. Nothing in the browsing views can leave fullscreen, so landing on a
   * fullscreen Home is a state with no way out of it except starting another
   * video — which is why every exit path goes through here, including the ones
   * nobody pressed a key for.
   *
   * Declared up here because Up next, below, needs it — and, like the end-of-
   * file handling, defining it below only worked by accident of effect ordering.
   */
  const exit = useCallback(async () => {
    // TV mode keeps the whole app fullscreen; the library goes on filling the
    // screen after the film, as a TV app would.
    if (!isTvMode() && (await isPictureFullscreen())) await setPictureFullscreen(false);
    await restoreScreen();
    onExit();
  }, [onExit]);

  // ---- the episodes either side, skipping, and Up next ---------------------
  const neighbours = useNeighbours(target.fileId);
  const {
    active,
    activeKey,
    activeKind,
    activeToScene,
    guessedCredits,
    autoSkip,
    dismissed,
    dismiss,
    performSkip,
    setChapters,
    countedCreditsStart,
  } = useSkipMarkers({ target, session, neighbours, showOsd, fail, dispatch });
  const { upNext, countdown, playNow, leave, keepWatching, playNeighbour, handlePlaybackEnded } =
    useUpNext({
      target,
      onPlayTarget,
      exit,
      sessionRef,
      neighbours,
      autoSkip,
      guessedCredits,
      activeKind,
      activeKey,
      activeToScene,
      dismissed,
      dismiss,
    });

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
    // `lastAid` is a ref and `setChapters` a state setter: the same objects
    // for the player's life, so this is still registered once.
  }, [lastAid, setChapters]);

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

  // Frame timing, read at playback time rather than held in the shell, so
  // changing the setting takes effect on the next episode without a restart.
  useEffect(() => {
    void getSetting(VIDEO_SYNC_KEY)
      .then((mode) => {
        videoSync.current =
          mode === 'display' ? VIDEO_SYNC_MODES.display : VIDEO_SYNC_MODES.audio;
      })
      .catch((e) => console.warn('could not read video sync mode', e));
  }, []);

  // ---- persist progress ---------------------------------------------------
  useEffect(() => {
    if (target.fileId === null) return;
    const fileId = target.fileId;

    // Only a file that is open has a position of its own worth saving.
    const current = () => {
      const { open, timePos: position, duration: total } = sessionRef.current;
      return {
        position: open ? (position ?? 0) : 0,
        total,
        creditsStart: countedCreditsStart.current,
      };
    };

    const id = window.setInterval(() => {
      const { position, total, creditsStart } = current();
      if (position > 0) {
        void saveProgress(fileId, position, total, creditsStart).catch(() => undefined);
      }
    }, PROGRESS_SAVE_MS);

    return () => {
      window.clearInterval(id);
      // Reading the ref's *latest* value at cleanup is the point here: the
      // session has not been reset for the next file yet, so this is still the
      // outgoing file's position. Copying it into the effect would be stale.
      const { position, total, creditsStart } = current();
      if (position > 0) {
        void saveProgress(fileId, position, total, creditsStart).catch(() => undefined);
      }
    };
  }, [target.fileId, countedCreditsStart]);

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
  const { scrubBy, commitScrub } = useScrub({ sessionRef, dispatch, fail, showOsd });

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
  const { volume, muted, receiver, setVolumeLevel, changeVolume, toggleMute, volumeKey } =
    useVolume({ fail, showOsd, osdVisible, path: target.path, frameShown: session.frameShown });

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
          else openStats();
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
            playNow();
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
    openStats,
    scrubBy,
    volumeKey,
    toggleMute,
    changeVolume,
    session.resumedFrom,
    startOver,
    playNow,
  ]);

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
          onPlay={playNow}
          onLeave={leave}
          onKeepWatching={keepWatching}
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
          online={onlinePanel}
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
          openTracks();
          void refreshTracks();
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
