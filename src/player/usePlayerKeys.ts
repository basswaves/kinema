/**
 * The player's keys: a keyboard, a remote's buttons, and keys pressed on
 * mpv's own window (passed on by usePlaybackEngine). Arrows seek until Up or
 * Down hands them to the controls; Back steps out one layer at a time; OK
 * takes whatever is on offer. The spatial system has its own handler, and
 * exactly one of the two acts on any press (docs/GOTCHAS.md).
 */
import { useEffect } from 'react';
import type { EpisodeRef } from './api';
import { setPaused } from './engine';
import type { ActiveSkip } from './skip';
import { VOLUME_STEP } from './volume';

/**
 * How far a remote's fast-forward and rewind keys jump. Longer than the
 * arrows' 10 s: those are the fine control, these are for getting somewhere.
 */
const TRANSPORT_SKIP_SECS = 30;

export function usePlayerKeys({
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
  releaseScrub,
  volumeKey,
  toggleMute,
  changeVolume,
  resumedFrom,
  startOver,
  playNow,
}: {
  /** Space, OK with nothing on offer, and the remote's play/pause. */
  togglePauseByKey: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
  /** The last rung of the Back ladder (useScreen). */
  backOut: () => Promise<void>;
  exit: () => Promise<void>;
  seekRelative: (delta: number) => Promise<void>;
  showOsd: () => void;
  /** The Skip button showing, which OK takes. */
  skipPrompt: ActiveSkip | null;
  performSkip: () => Promise<void>;
  /** The Up next card showing, which OK plays. */
  upNext: EpisodeRef | null;
  neighbours: { prev: EpisodeRef | null; next: EpisodeRef | null };
  playNeighbour: (episode: EpisodeRef) => void;
  /** The controls hold the arrows: then they, and OK, belong to the spatial system. */
  osdFocus: boolean;
  enterOsdFocus: () => void;
  leaveOsdFocus: () => void;
  showTracks: boolean;
  showStats: boolean;
  closeTracks: () => void;
  closeStats: () => void;
  openStats: () => void;
  scrubBy: (dir: 1 | -1, repeat: boolean) => void;
  releaseScrub: () => void;
  volumeKey: (act: () => void) => void;
  toggleMute: () => void;
  changeVolume: (delta: number) => void;
  /** The "Resumed from" notice is showing: OK starts over. */
  resumedFrom: number | null;
  startOver: () => void;
  playNow: () => void;
}) {
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
          if (resumedFrom !== null) {
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
    resumedFrom,
    startOver,
    playNow,
  ]);

  /**
   * Letting go of Left/Right after holding it is what sends the seek (after
   * taps, the pause after the last one does: useScrub). Only in watching
   * mode: on the controls, the seek bar's own release handler does it.
   */
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (!osdFocus && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) releaseScrub();
    };
    window.addEventListener('keyup', onKeyUp);
    return () => window.removeEventListener('keyup', onKeyUp);
  }, [osdFocus, releaseScrub]);
}
