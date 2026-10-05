/**
 * Playing the file: loading it (the resume point, the HDR hint, the sound's
 * route, the screen), turning what the engine says into session events,
 * checking that the sound opened, the end of the file, the black cover's time
 * limit, and stopping when the player closes. What each event *means* is
 * session.ts's to decide.
 */
import { useEffect, useLayoutEffect, useRef, type Dispatch, type RefObject } from 'react';
import { capabilitiesNow } from '../capabilities';
import { getSetting } from '../metadata/api';
import { getProgress, type PlaybackTarget } from './api';
import {
  applyAudioPlan,
  applyFallback,
  fallbackNotice,
  noSoundNotice,
  releaseAudioDevice,
  silencedAudioTrack,
} from './audioOutput';
import { matchHdrToDisplay } from './displayHdr';
import { mayswitch, restoreScreen } from './displaySwitch';
import {
  fitWindowForPlayer,
  hasMpv,
  hasReachedEnd,
  isPictureFullscreen,
  mpvCommand,
  nowPlaying,
  onPlaybackEvent,
  openFile,
  readChapters,
  setPaused,
  startEngine,
  stopPlayback,
  type Chapter,
} from './engine';
import { VIDEO_SYNC_KEY, VIDEO_SYNC_MODES } from './mpvOptions';
import { startOverlay } from './overlay';
import { handMouseToPage, startPointerFollowingControls } from './pageMouse';
import { resumePoint } from './resume';
import { audioFallbackNotice } from './systemOutput';
import { loadFailedMessage, samePath, type Event, type Session } from './session';

/**
 * The longest the black cover may stay up waiting for a first frame. A file
 * with no video, or an mpv event that never comes, must not leave the picture
 * hidden: after this the cover goes regardless.
 */
const COVER_MAX_MS = 8000;
/** How long after playback starts to check that the sound actually opened. */
const AUDIO_CHECK_MS = 1500;

export function usePlaybackEngine({
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
}: {
  target: PlaybackTarget;
  session: Session;
  dispatch: Dispatch<Event>;
  sessionRef: RefObject<Session>;
  fail: (e: unknown) => void;
  /** Switch the screen for the film (useScreen). */
  matchScreen: () => Promise<void>;
  setNotice: (notice: string | null) => void;
  /** Bring the controls up and keep them there (useOsd). */
  revealOsd: () => void;
  /** The last audio track that played, for the sound fallback (useTracks). */
  lastAid: RefObject<number | null>;
  /** Put the title's languages on a freshly opened file (useTracks). */
  applyPrefs: () => Promise<void>;
  /** The chapters of the open file, for the credits ladder (useSkipMarkers). */
  setChapters: (chapters: Chapter[]) => void;
  /** The file ended: offer the next episode or leave (useUpNext). */
  handlePlaybackEnded: () => Promise<void>;
}) {
  /** How many of FALLBACKS have been tried for the file that is open. */
  const audioFallback = useRef(0);
  /** The resume point handed to mpv with the load, for the toast once it opens. */
  const pendingSeek = useRef<number | null>(null);
  /**
   * Frame-timing mode, in a ref rather than state because it is applied inside
   * the mpv event listener — reading it from a closure would apply whatever the
   * setting was when that listener was registered.
   */
  const videoSync = useRef<string>(VIDEO_SYNC_MODES.audio);

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
     * Runs after the progress-save cleanup — React runs every cleanup before
     * any effect — which has already written the outgoing file's position.
     */
    dispatch({ type: 'load', path: target.path });
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
        // Where the system routes the sound itself (Android), it is not ours.
        if (!capabilitiesNow()?.system_output) {
          await applyAudioPlan().catch((e) => console.warn('audio: plan not applied', e));
        }
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
  }, [target.path, target.fileId, target.fromStart, fail, matchScreen, dispatch, setNotice]);

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
        // mpv's way of failing to open the sound, and its fallbacks. Media3
        // falls back by itself and says so (`audio-fallback`).
        if (hasMpv()) checkAudioSoon();
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
          if (hasMpv()) {
            await mpvCommand('set', ['video-sync', videoSync.current]).catch((e) =>
              console.warn('could not set video-sync', e)
            );
          }

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
          revealOsd();
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
      // The mouse on mpv's own window (Linux): done again on this page, as
      // real mouse input where the picture of the page shows that point.
      if (event.type === 'mouse') handMouseToPage(event.kind, event.x, event.y, event.time);
      // The engine took another way for the sound (Media3): say which.
      if (event.type === 'audio-fallback') {
        const system = capabilitiesNow()?.system ?? 'The system';
        console.warn(`audio: fell back to step ${event.step} (${event.format || 'unknown format'})`);
        setNotice(audioFallbackNotice(event.step, event.format, event.chosen, system));
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
    // Every one of these is the same object for the player's life — refs,
    // dispatch, state setters and callbacks built from nothing that changes —
    // so this is still registered once. Anything that does change belongs in
    // `latestHandlers` instead.
  }, [lastAid, setChapters, dispatch, sessionRef, setNotice, revealOsd]);

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
  }, [sessionRef, dispatch]);

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

  // The cover never outstays its purpose: if no first frame is reported in
  // time — a file with no video, an event that never comes — it goes anyway.
  useEffect(() => {
    if (session.frameShown) return;
    const id = window.setTimeout(() => dispatch({ type: 'cover-timeout' }), COVER_MAX_MS);
    return () => window.clearTimeout(id);
  }, [session.frameShown, session.seq, dispatch]);

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
  // player is open, and mpv's pointer shows only while the controls do
  // (pageMouse.ts).
  useEffect(() => {
    if (!capabilitiesNow()?.mpv_video.own_window) return;
    const stopOverlay = startOverlay();
    const stopPointer = startPointerFollowingControls();
    return () => {
      stopPointer();
      stopOverlay();
    };
  }, []);
}
