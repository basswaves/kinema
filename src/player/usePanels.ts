/**
 * The player's panels: Audio & subtitles (the track panel), the stats panel
 * (on `i`, a remote's Info key, or from Audio & subtitles) and the chapter
 * list. Each is a dialog on the focus engine (focusStore.ts): the ring goes
 * in as it opens and back to the button that opened it as it closes, in the
 * same press — no setFocus to wait on, no restore 300 ms later to race. The
 * stats panel on `i` is the exception: it is for watching numbers move beside
 * the film, so it takes no ring; opened from Audio & subtitles, it does.
 */
import { useCallback, useEffect, useState } from 'react';
import { hasMpv } from './engine';
import { readPlaybackStats, type StatGroup } from './stats';
import { readMedia3Stats } from './statsMedia3';

/** Stats refresh. Fast enough to watch a drop counter, slow enough to be free. */
const STATS_REFRESH_MS = 1000;

export function usePanels() {
  const [showTracks, setShowTracks] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showChapters, setShowChapters] = useState(false);
  const [stats, setStats] = useState<StatGroup[]>([]);
  /** Opened from Audio & subtitles: a dialog, with the ring in it until it closes. */
  const [statsFromTracks, setStatsFromTracks] = useState(false);

  const openTracks = useCallback(() => {
    setShowChapters(false);
    setShowTracks(true);
  }, []);
  const closeTracks = useCallback(() => setShowTracks(false), []);
  /** The chapter list (ChapterPanel), one panel at a time with the tracks. */
  const openChapters = useCallback(() => {
    setShowTracks(false);
    setShowChapters(true);
  }, []);
  const closeChapters = useCallback(() => setShowChapters(false), []);
  const openStats = useCallback(() => {
    setStatsFromTracks(false);
    setShowStats(true);
  }, []);
  const closeStats = useCallback(() => setShowStats(false), []);
  // The way in without a keyboard's `i`: the ring goes into the panel, and
  // back to Audio & subtitles after (the closed panel's own button).
  const openStatsFromTracks = useCallback(() => {
    setShowTracks(false);
    setStatsFromTracks(true);
    setShowStats(true);
  }, []);

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
    // Each engine's own facts: mpv's properties, or what Media3 says.
    const readStats = hasMpv() ? readPlaybackStats : readMedia3Stats;
    const read = () => {
      void readStats()
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

  return {
    showTracks,
    openTracks,
    closeTracks,
    showStats,
    statsFromTracks,
    openStats,
    openStatsFromTracks,
    closeStats,
    stats,
    showChapters,
    openChapters,
    closeChapters,
  };
}
