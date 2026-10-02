/**
 * The player's two panels: Audio & subtitles (the track panel) and the stats
 * panel on `i`, with the focus ring following each in and back out.
 */
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useState, type RefObject } from 'react';
import { PLAYER_PLAY_KEY, PLAYER_TRACKS_KEY } from './focusKeys';
import { readPlaybackStats, type StatGroup } from './stats';
import { TRACK_PANEL_KEY } from './TrackPanel';

/** Stats refresh. Fast enough to watch a drop counter, slow enough to be free. */
const STATS_REFRESH_MS = 1000;

export function usePanels({
  osdFocus,
  osdFocusRef,
}: {
  /** Whether the controls hold the arrow keys (useOsd). */
  osdFocus: boolean;
  /** The same, for callbacks that must not be rebuilt on it. */
  osdFocusRef: RefObject<boolean>;
}) {
  const [showTracks, setShowTracks] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<StatGroup[]>([]);

  const openTracks = useCallback(() => setShowTracks(true), []);
  const openStats = useCallback(() => setShowStats(true), []);

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
  }, [osdFocusRef]);
  // The stats panel has no button on the bar any more (it opens on `i`), so
  // closing it hands the ring to Play rather than to a button that is gone.
  const closeStats = useCallback(() => {
    if (osdFocusRef.current) void setFocus(PLAYER_PLAY_KEY);
    setShowStats(false);
  }, [osdFocusRef]);

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

  return { showTracks, openTracks, closeTracks, showStats, openStats, closeStats, stats };
}
