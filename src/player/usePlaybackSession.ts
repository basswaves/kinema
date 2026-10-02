/**
 * The file's life as one state machine (session.ts), with the ref the
 * callbacks that cannot re-render read it through, and `fail`, which puts an
 * error on screen.
 */
import { useCallback, useLayoutEffect, useReducer, useRef } from 'react';
import { userError } from '../ui/errors';
import { initialSession, reduce } from './session';

export function usePlaybackSession(path: string) {
  /**
   * The life of the file mpv has open — loading, open, first frame, position,
   * ended — as one state machine. See `session.ts`, and GOTCHAS for why the
   * separate flags and ref mirrors it replaced kept disagreeing.
   */
  const [session, dispatch] = useReducer(reduce, path, initialSession);
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

  return { session, dispatch, sessionRef, fail };
}
