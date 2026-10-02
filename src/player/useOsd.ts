/**
 * The on-screen controls: whether they are showing, and whether they hold the
 * arrow keys ("OSD focus") — the switch between the arrows seeking and the
 * arrows moving the focus ring (docs/GOTCHAS.md, "Two live key handlers
 * cannot share the arrow keys").
 */
import {
  pause as pauseSpatial,
  resume as resumeSpatial,
  setFocus,
} from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { PLAYER_PLAY_KEY } from './focusKeys';
import type { Session } from './session';

const OSD_HIDE_MS = 3200;
/** With the ring on the controls and nothing pressed, this long hands the arrows back. */
const OSD_FOCUS_IDLE_MS = 6000;

export function useOsd({
  sessionRef,
  paused,
}: {
  sessionRef: RefObject<Session>;
  paused: boolean;
}) {
  const [osdVisible, setOsdVisible] = useState(true);
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

  const showOsd = useCallback(() => {
    setOsdVisible(true);
    window.clearTimeout(hideTimer.current);
    // Never time out while focus is inside the OSD. Hiding the thing the focus
    // ring is on leaves a remote pressing arrows at an invisible control, which
    // is indistinguishable from a hang — the same silent dead end as focus
    // parked on an unmounted component (docs/GOTCHAS.md).
    if (osdFocusRef.current || sessionRef.current.paused) return;
    hideTimer.current = window.setTimeout(() => setOsdVisible(false), OSD_HIDE_MS);
  }, [sessionRef]);

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

  /** Give them back to seeking, and let the OSD start timing out again. */
  const leaveOsdFocus = useCallback(() => {
    osdFocusRef.current = false;
    setOsdFocus(false);
    pauseSpatial();
    showOsd();
  }, [showOsd]);

  /**
   * Reveal the controls and leave them up, as for a file that would not open:
   * nothing is playing, so there is nothing for them to cover.
   */
  const revealOsd = useCallback(() => setOsdVisible(true), []);

  /**
   * Arrows mean "seek" until asked otherwise, so the spatial system starts
   * paused — and is resumed on the way out, or the browsing UI underneath would
   * be left unable to navigate after the player closes.
   */
  useEffect(() => {
    pauseSpatial();
    return () => resumeSpatial();
  }, []);

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

  return {
    osdVisible,
    osdFocus,
    osdFocusRef,
    showOsd,
    enterOsdFocus,
    leaveOsdFocus,
    revealOsd,
  };
}

/**
 * The controls step back out of the way on their own, as they do on any
 * streaming app — the ring used to stay on them until Back was pressed,
 * with the arrows still moving it instead of seeking. Not while paused, and
 * not while a panel or the Up next card is open: those are waiting for you.
 */
export function useOsdIdleLeave({
  osdFocus,
  idle,
  leaveOsdFocus,
}: {
  osdFocus: boolean;
  /** Nothing is waiting for the viewer: playing, with no panel or card open. */
  idle: boolean;
  leaveOsdFocus: () => void;
}) {
  useEffect(() => {
    if (!osdFocus || !idle) return;
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
  }, [osdFocus, idle, leaveOsdFocus]);
}
