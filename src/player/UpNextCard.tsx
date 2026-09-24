/**
 * The Up next card: two states, one card.
 *
 * With a countdown the file has genuinely ended and the next episode is coming
 * either way; without one the credits have merely started and the video is
 * still running underneath, so the card offers rather than announces.
 */
import FocusButton from '../ui/FocusButton';
import type { EpisodeRef } from './api';

export default function UpNextCard({
  episode,
  countdown,
  onPlay,
  onLeave,
  onKeepWatching,
}: {
  episode: EpisodeRef;
  countdown: number | null;
  onPlay: () => void;
  onLeave: () => void;
  onKeepWatching: () => void;
}) {
  return (
    <div className="up-next">
      <div className="up-next-body">
        <div className="up-next-label">Up next</div>
        <div className="up-next-title">
          S{String(episode.season).padStart(2, '0')}E{String(episode.episode).padStart(2, '0')}
          {episode.name ? ` · ${episode.name}` : ''}
        </div>
        <div className="up-next-actions">
          <FocusButton className="btn-primary" onSelect={onPlay}>
            {countdown !== null ? `▶ Play now (${countdown})` : '▶ Play next'}
          </FocusButton>
          {countdown !== null ? (
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
