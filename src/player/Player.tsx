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
import { useCallback, useEffect, useState } from 'react';
import {
  doesFocusableExist,
  FocusContext,
  getCurrentFocusKey,
  setFocus,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from '../ui/FocusButton';
import { endsAtLabel } from '../ui/format';
import { useTvMode } from '../ui/tv';
import { isPaused, seekBy, seekTo, setPaused } from './engine';
import { PLAYER_PLAY_KEY, PLAYER_SHELL_KEY } from './focusKeys';
import PlayerControls from './PlayerControls';
import ResumeToast from './ResumeToast';
import SkipButton from './SkipButton';
import { skipPromptFor } from './skip';
import StatsPanel from './StatsPanel';
import TrackPanel from './TrackPanel';
import UpNextCard from './UpNextCard';
import { useNeighbours } from './useNeighbours';
import { useOnlineSubtitles } from './useOnlineSubtitles';
import { useOsd, useOsdIdleLeave } from './useOsd';
import { usePanels } from './usePanels';
import { usePlaybackEngine } from './usePlaybackEngine';
import { usePlaybackSession } from './usePlaybackSession';
import { useProgressSave } from './useProgressSave';
import { useScreen } from './useScreen';
import { useScrub } from './useScrub';
import { useSkipMarkers } from './useSkipMarkers';
import { useTracks } from './useTracks';
import { useUpNext } from './useUpNext';
import { useVolume } from './useVolume';
import { VOLUME_STEP } from './volume';

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

/**
 * How far a remote's fast-forward and rewind keys jump. Longer than the
 * arrows' 10 s: those are the fine control, these are for getting somewhere.
 */
const TRANSPORT_SKIP_SECS = 30;
/** How long a notice about the sound stays on screen. */
const AUDIO_NOTICE_MS = 12000;

export default function Player({ target, onExit, onPlayTarget }: Props) {
  const tv = useTvMode();
  const { session, dispatch, sessionRef, fail } = usePlaybackSession(target.path);
  const { timePos, duration, paused, error } = session;
  /**
   * Something the viewer should know that is not an error: the screen being
   * matched to the film, or the sound not opening the way it was asked to (the
   * failure that started this was silent — with a half-configured Windows
   * spatial sound, mpv opened no audio at all and the film played mute).
   */
  const [notice, setNotice] = useState<string | null>(null);
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

  // Every control in the player hangs off this container, so the OSD has one
  // place to aim focus at and one place to remember where it was.
  const { ref: shellRef, focusKey: shellFocusKey } = useFocusable({
    focusKey: PLAYER_SHELL_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey: PLAYER_PLAY_KEY,
  });
  const { osdVisible, osdFocus, osdFocusRef, showOsd, enterOsdFocus, leaveOsdFocus, revealOsd } =
    useOsd({ sessionRef, paused });

  const { showTracks, openTracks, closeTracks, showStats, openStats, closeStats, stats } =
    usePanels({ osdFocus, osdFocusRef });

  const onlinePanel = useOnlineSubtitles({
    target,
    tracks,
    aid,
    wantedSubLang,
    showTracks,
    showFetched,
  });

  const { matchScreen, exit, toggleFullscreen, backOut } = useScreen({
    onExit,
    sessionRef,
    setNotice,
  });

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

  // ---- the file itself ----------------------------------------------------
  useProgressSave({ fileId: target.fileId, sessionRef, countedCreditsStart });
  usePlaybackEngine({
    target,
    session,
    dispatch,
    sessionRef,
    fail,
    matchScreen,
    setNotice,
    revealOsd,
    lastAid,
    applyPrefs,
    setChapters,
    handlePlaybackEnded,
  });

  // A notice about the sound says its piece and goes; the film is playing.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), AUDIO_NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [notice]);

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
  }, [dispatch, fail, showOsd]);

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

  // The controls step back out of the way on their own (useOsd.ts).
  useOsdIdleLeave({
    osdFocus,
    idle: !paused && !showTracks && !showStats && upNext === null,
    leaveOsdFocus,
  });

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
