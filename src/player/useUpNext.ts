/**
 * Up next: the card offering the next episode — raised as the credits start,
 * as an offer with no countdown, or when the file ends, counting down to it —
 * and moving to an episode either side.
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';
import { episodeRefLabel, nextEpisode, saveProgress, type EpisodeRef } from './api';
import type { PlaybackTarget } from './Player';
import type { Session } from './session';
import type { SkipKind } from './skip';

const NEXT_EPISODE_COUNTDOWN = 12;

export function useUpNext({
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
}: {
  target: PlaybackTarget;
  onPlayTarget: (target: PlaybackTarget) => void;
  /** Leave the player (Player.tsx). */
  exit: () => Promise<void>;
  sessionRef: RefObject<Session>;
  /** The episodes either side: Up next offers the next one. */
  neighbours: { prev: EpisodeRef | null; next: EpisodeRef | null };
  /** From useSkipMarkers: automatic mode, and the segment the position is in. */
  autoSkip: boolean;
  guessedCredits: boolean;
  activeKind: SkipKind | null;
  activeKey: string | null;
  activeToScene: boolean;
  dismissed: string | null;
  dismiss: (key: string) => void;
}) {
  const [upNext, setUpNext] = useState<EpisodeRef | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  // A card offering the *previous* file's next episode has no business
  // surviving into this one. Nothing else clears these: the countdown path
  // clears them when it advances, and every other route out left them set.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setUpNext(null);
    setCountdown(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [target.path, target.fileId, target.fromStart]);

  /**
   * End of file: mark it watched, then offer the next episode or leave. The
   * player calls it once per file, when the session says the file ended —
   * naturally, or because its credits were skipped.
   */
  const handlePlaybackEnded = useCallback(async () => {
    if (target.fileId === null) {
      await exit();
      return;
    }

    // Mark it finished so it leaves Continue Watching rather than sitting
    // there at 99%.
    const total = sessionRef.current.duration;
    if (total) await saveProgress(target.fileId, total, total).catch(() => undefined);

    try {
      const next = await nextEpisode(target.fileId);
      if (next) {
        setUpNext(next);
        setCountdown(NEXT_EPISODE_COUNTDOWN);
      } else {
        await exit();
      }
    } catch {
      await exit();
    }
  }, [target.fileId, exit, sessionRef]);

  /**
   * Offer the next episode as soon as the credits start, without ending the
   * file.
   *
   * The card sits over the still-running video and carries **no countdown**:
   * the marker behind it may be a guess, and a guess is not entitled to make
   * the decision. A natural end still starts the countdown, as it always did.
   */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    // Automatic mode acts on measured credits by itself; a guess still only
    // gets to offer, so it falls through to the card.
    if (autoSkip && !guessedCredits) return;

    // An offer with no countdown is tied to *being in the credits*. When the
    // credits are no longer where we are — the file changed, the user seeked
    // back, or it was raised in error — the offer is stale and comes down.
    //
    // This effect used to only ever raise the card, which made every spurious
    // raise permanent: it sat over the next episode for its whole duration,
    // hiding the Skip intro button behind it. Being able to lower it again is
    // what makes the whole path self-correcting rather than one-way.
    //
    // A countdown means the file has genuinely ended and the next episode is
    // coming regardless, so that card is not an offer and must not be withdrawn.
    if (countdown !== null) return;

    // Credits with a scene after them are not the end of anything yet.
    if (
      activeKind !== 'credits' ||
      activeToScene ||
      !neighbours.next ||
      dismissed === activeKey
    ) {
      if (upNext) setUpNext(null);
      return;
    }
    if (!upNext) setUpNext(neighbours.next);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [
    autoSkip,
    guessedCredits,
    activeKind,
    activeKey,
    activeToScene,
    countdown,
    dismissed,
    neighbours.next,
    upNext,
  ]);

  /** Jump straight to a neighbouring episode, keeping the show's identity. */
  const playNeighbour = useCallback(
    (episode: EpisodeRef) => {
      onPlayTarget({
        path: episode.path,
        label: episodeRefLabel(episode),
        fileId: episode.file_id,
        episodeName: episode.name,
        titleId: target.titleId,
      });
    },
    [onPlayTarget, target.titleId]
  );

  // Countdown to the next episode.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      /* Timer-driven state machine, not state derived from render. */
      /* eslint-disable react-hooks/set-state-in-effect */
      if (upNext) {
        onPlayTarget({
          path: upNext.path,
          label: episodeRefLabel(upNext),
          fileId: upNext.file_id,
          titleId: target.titleId,
        });
      }
      setCountdown(null);
      setUpNext(null);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    const id = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [countdown, upNext, onPlayTarget, target.titleId]);

  /** Up next's Play: now rather than when the countdown ends. */
  const playNow = useCallback(() => setCountdown(0), []);
  /** Up next's Back to library, after a file that ended. */
  const leave = useCallback(() => {
    setCountdown(null);
    setUpNext(null);
    void exit();
  }, [exit]);
  /**
   * Up next's Keep watching. Refuse the offer for the rest of this file.
   * Dismissing by segment rather than by a flag also silences the small
   * credits prompt, which would otherwise take its place.
   */
  const keepWatching = useCallback(() => {
    setUpNext(null);
    if (activeKey) dismiss(activeKey);
  }, [activeKey, dismiss]);

  return { upNext, countdown, playNow, leave, keepWatching, playNeighbour, handlePlaybackEnded };
}
