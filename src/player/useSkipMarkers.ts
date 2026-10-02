/**
 * Skipping the intro, a recap and the credits: the file's markers (ranked in
 * skip.rs), the credits ladder that continues past them (skip.ts), which
 * segment the position is in, what the Skip button does, and automatic mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { getSetting } from '../metadata/api';
import { getSkipMarkers, type EpisodeRef, type SkipMarkers } from './api';
import type { Chapter } from './chapters';
import { seekTo } from './engine';
import type { PlaybackTarget } from './Player';
import type { Event, Session } from './session';
import {
  activeSkip,
  checkedAgainstFile,
  withResolvedCredits,
  CREDITS_TAIL_KEY,
  DEFAULT_CREDITS_TAIL_SECS,
} from './skip';

/** Setting key: 'auto' skips without asking, anything else shows the button. */
const SKIP_MODE_KEY = 'skip_mode';
/**
 * How long the resolved marker sources must hold still before they are
 * logged. Chapters are read a moment after the file opens and can move the
 * credits source from `tail` to `chapter`; one line with the final answer is
 * worth more than two where the first is already wrong.
 */
const MARKER_LOG_SETTLE_MS = 3000;

export function useSkipMarkers({
  target,
  session,
  neighbours,
  showOsd,
  fail,
  dispatch,
}: {
  target: PlaybackTarget;
  session: Session;
  /** The episodes either side; credits are only skipped towards a next one. */
  neighbours: { prev: EpisodeRef | null; next: EpisodeRef | null };
  showOsd: () => void;
  fail: (e: unknown) => void;
  dispatch: Dispatch<Event>;
}) {
  const { timePos, duration } = session;
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
  /** Prompt occurrences the user (or the timer) has already dismissed. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  /** Segments already acted on automatically, so each is skipped once only. */
  const autoHandled = useRef(new Set<string>());

  // A new file: its markers are not known yet. (Cleared whenever the file is
  // loaded, as before; the fetch below fills them in.)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMarkers(null);
  }, [target.path, target.fileId, target.fromStart]);

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
  }, [active, showOsd, fail, dispatch]);

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

  return {
    active,
    activeKey,
    activeKind,
    activeToScene,
    guessedCredits,
    autoSkip,
    dismissed,
    dismiss: setDismissed,
    performSkip,
    setChapters,
    countedCreditsStart,
  };
}
