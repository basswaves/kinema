/**
 * The screen and the way out: matching the screen to the film, F for full
 * screen, Back out of full screen, and leaving the player.
 */
import { useCallback, type RefObject } from 'react';
import { capabilitiesNow } from '../capabilities';
import { isTvMode } from '../ui/tv';
import { matchHdrToDisplay } from './displayHdr';
import { filmNow, mayswitch, restoreScreen, switchForFilm } from './displaySwitch';
import { isPictureFullscreen, setPaused, setPictureFullscreen } from './engine';
import type { Session } from './session';

export function useScreen({
  onExit,
  sessionRef,
  setNotice,
}: {
  /** Back to the screen the player was opened from (Browse.tsx). */
  onExit: () => void;
  sessionRef: RefObject<Session>;
  /** A word on screen while the screen is being switched. */
  setNotice: (notice: string | null) => void;
}) {
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
  }, [setNotice]);

  /**
   * The only way out of the player, and the only place that gives the desktop
   * back. Nothing in the browsing views can leave fullscreen, so landing on a
   * fullscreen Home is a state with no way out of it except starting another
   * video — which is why every exit path goes through here, including the ones
   * nobody pressed a key for.
   */
  const exit = useCallback(async () => {
    // TV mode keeps the whole app fullscreen; the library goes on filling the
    // screen after the film, as a TV app would. Where the picture is mpv's own
    // window it closes with the film, so it is left full screen: the screen
    // goes back under a window that simply follows it (leaveFullscreen).
    if (!isTvMode() && !pictureHasOwnWindow() && (await isPictureFullscreen())) {
      await setPictureFullscreen(false);
    }
    await restoreScreen();
    onExit();
  }, [onExit]);

  const toggleFullscreen = useCallback(async () => {
    // In TV mode the window is always fullscreen and has no other state to
    // toggle to — see tv.ts.
    if (isTvMode()) return;
    const entering = !(await isPictureFullscreen());
    if (!entering) {
      await leaveFullscreen();
      return;
    }
    await setPictureFullscreen(true);
    // Going fullscreen mid-film: pause, switch, and carry on as it was.
    if (!(await mayswitch().catch(() => false))) return;
    const wasPaused = sessionRef.current.paused;
    await setPaused(true);
    await matchScreen();
    if (!wasPaused) await setPaused(false);
  }, [matchScreen, sessionRef]);

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
      await leaveFullscreen();
      return;
    }
    // Through exit, not straight out: in TV mode the film may have switched
    // the screen's mode while fullscreen, and exit is what puts it back.
    await exit();
  }, [exit]);

  return { matchScreen, exit, toggleFullscreen, backOut };
}

/** Where the picture is mpv's own window (Linux) rather than in Kinema's. */
function pictureHasOwnWindow(): boolean {
  return capabilitiesNow()?.mpv_video.own_window === true;
}

/**
 * Out of full screen, with the screen put back as it was before the film.
 *
 * Where the picture is mpv's own window, the screen goes back first, while
 * that window is still full screen and simply follows the screen's new size.
 * The other way round, the desktop is asked to change the screen under a
 * window that is just leaving full screen, and nested GNOME answered that
 * with a window of 1×1 pixels. mpv then redraws a paused film's frame into
 * it, and shrinking a whole frame to one pixel is a scaling filter thousands
 * of samples wide: its shader took close to a minute to build, and mpv
 * answered nothing else meanwhile — not even the next film (2026-10-03).
 * Kinema's own window (Windows) leaves full screen first, as it always has.
 */
async function leaveFullscreen(): Promise<void> {
  if (pictureHasOwnWindow()) {
    await restoreScreen();
    await setPictureFullscreen(false);
    return;
  }
  await setPictureFullscreen(false);
  await restoreScreen();
}
