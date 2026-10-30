/**
 * The Up next card: three states, one card.
 *
 * With a countdown the file has genuinely ended and the next episode is coming
 * either way; without one the credits have merely started and the video is
 * still running underneath, so the card offers rather than announces. Asking
 * ("Still watching?", stillWatching.ts), the file has ended after three
 * episodes rolled on untouched, and nothing comes until someone answers.
 */
import FocusButton from '../ui/FocusButton';
import { episodeRefName, type EpisodeRef } from './api';

export default function UpNextCard({
  episode,
  countdown,
  asking = false,
  onPlay,
  onLeave,
  onKeepWatching,
}: {
  episode: EpisodeRef;
  countdown: number | null;
  asking?: boolean;
  onPlay: () => void;
  onLeave: () => void;
  onKeepWatching: () => void;
}) {
  return (
    <div className={`up-next ${asking ? 'still-watching' : ''}`}>
      <div className="up-next-body">
        <div className="up-next-label">{asking ? 'Still watching?' : 'Up next'}</div>
        <div className="up-next-title">{episodeRefName(episode)}</div>
        <div className="up-next-actions">
          <FocusButton className="btn-primary" onSelect={onPlay}>
            {countdown !== null ? `▶ Play now (${countdown})` : '▶ Play next'}
          </FocusButton>
          {countdown !== null || asking ? (
            <FocusButton className="btn-secondary" onSelect={onLeave}>
              Back to library
            </FocusButton>
          ) : (
            <FocusButton className="btn-secondary" onSelect={onKeepWatching}>
              Keep watching
            </FocusButton>
          )}
        </div>
      </div>
    </div>
  );
}
