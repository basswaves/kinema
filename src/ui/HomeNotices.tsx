/**
 * The notices between the hero and the rails.
 *
 * Two things Home used to keep quiet about:
 *
 *  - **Videos Kinema could not identify.** They were absent from Home and
 *    listed only halfway down Settings, so a library with twenty refusals
 *    looked like a library missing twenty films. Refusing to guess is only
 *    fair if the refusals are in plain sight.
 *  - **Equipment that could do better** than the current settings let it —
 *    see `qualityNotice.ts`.
 *
 * And one that should never appear: TMDB refusing the key Kinema came with
 * (builtinKey.ts), which leaves new movies to Wikidata — no posters — until an
 * update or a key of the user's own.
 *
 * Quiet on purpose: one line each, in the flow of the page, reached with one
 * press of Down from the hero — never a dialog in front of what you came for.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from './FocusButton';
import { count } from './format';
import type { Upgrade } from './qualityNotice';

interface Props {
  reviewCount: number;
  onReview: () => void;
  keyRejected: boolean;
  onAddKey: () => void;
  upgrades: Upgrade[];
  /** Add each device to its "only these" list. */
  onApply: () => void;
  /** Open Settings → Picture & sound, for questions never answered. */
  onChoose: () => void;
  onDismiss: () => void;
  ffmpegMissing: boolean;
  onFfmpeg: () => void;
  onDismissFfmpeg: () => void;
}

export default function HomeNotices({
  reviewCount,
  onReview,
  keyRejected,
  onAddKey,
  upgrades,
  onApply,
  onChoose,
  onDismiss,
  ffmpegMissing,
  onFfmpeg,
  onDismissFfmpeg,
}: Props) {
  const { ref, focusKey } = useFocusable({ trackChildren: true, saveLastFocusedChild: true });
  if (reviewCount === 0 && upgrades.length === 0 && !keyRejected && !ffmpegMissing) return null;
  // Only additions to an "only these" list can be done here in a press; a
  // question never answered is answered where all three answers are.
  const onlyAdds = upgrades.every((u) => u.action === 'add');

  return (
    <FocusContext.Provider value={focusKey}>
      <section className="home-notices" ref={ref}>
        {keyRejected && (
          <div className="home-notice">
            <span className="home-notice-icon" aria-hidden="true">
              !
            </span>
            <div className="home-notice-text">
              <strong>TMDB no longer accepts the key Kinema came with.</strong>
              <span className="muted">
                {' '}
                New movies are identified through Wikidata instead, without posters, until an
                update brings a new one or you add a free key of your own.
              </span>
            </div>
            <FocusButton
              focusKey="notice-tmdb-key"
              className="btn-primary"
              keepInView="nearest"
              onSelect={onAddKey}
            >
              Add a key
            </FocusButton>
          </div>
        )}

        {reviewCount > 0 && (
          <div className="home-notice">
            <span className="home-notice-icon" aria-hidden="true">
              ?
            </span>
            <div className="home-notice-text">
              <strong>
                {count(reviewCount, 'video')} could not be identified for certain,
              </strong>
              <span className="muted">
                {' '}
                so {reviewCount === 1 ? 'it is' : 'they are'} not on Home yet. Picking the right
                title takes a few seconds each.
              </span>
            </div>
            {/* Stable keys on these, so Back from the review queue lands on
                Review again — docs/GOTCHAS.md, "Back can only return to a
                control with a stable key". */}
            <FocusButton
              focusKey="notice-review"
              className="btn-primary"
              keepInView="nearest"
              onSelect={onReview}
            >
              Review
            </FocusButton>
          </div>
        )}

        {upgrades.length > 0 && (
          <div className="home-notice">
            <span className="home-notice-icon" aria-hidden="true">
              ★
            </span>
            <div className="home-notice-text">
              <strong>
                {onlyAdds
                  ? 'Something connected can do more than Kinema is set to use'
                  : 'Your equipment can do better than it is set to'}
              </strong>
              <ul>
                {upgrades.map((u) => (
                  <li key={u.id}>{u.text}</li>
                ))}
              </ul>
              <span className="muted">
                {onlyAdds
                  ? 'Using it too adds it to the devices you chose; Settings → Picture & sound has the lists.'
                  : 'Choose decides each, for every device that can, only some, or none, in Settings → Picture & sound.'}
              </span>
            </div>
            <div className="home-notice-actions">
              <FocusButton
                focusKey="notice-apply"
                className="btn-primary"
                keepInView="nearest"
                onSelect={onlyAdds ? onApply : onChoose}
              >
                {onlyAdds ? 'Use it too' : 'Choose'}
              </FocusButton>
              <FocusButton
                focusKey="notice-dismiss"
                className="btn-secondary"
                keepInView="nearest"
                onSelect={onDismiss}
              >
                Not now
              </FocusButton>
            </div>
          </div>
        )}

        {ffmpegMissing && (
          <div className="home-notice">
            <span className="home-notice-icon" aria-hidden="true">
              +
            </span>
            <div className="home-notice-text">
              <strong>Two things need ffmpeg, which Kinema cannot find.</strong>
              <span className="muted">
                {' '}
                Without it a title&rsquo;s page has no picture and sound details, and Kinema
                cannot find intros and credits by itself. Everything else works. ffmpeg is a free
                program you install yourself; Kinema never installs anything.
              </span>
            </div>
            <div className="home-notice-actions">
              <FocusButton
                focusKey="notice-ffmpeg"
                className="btn-primary"
                keepInView="nearest"
                onSelect={onFfmpeg}
              >
                How to add it
              </FocusButton>
              <FocusButton
                focusKey="notice-ffmpeg-dismiss"
                className="btn-secondary"
                keepInView="nearest"
                onSelect={onDismissFfmpeg}
              >
                Not now
              </FocusButton>
            </div>
          </div>
        )}
      </section>
    </FocusContext.Provider>
  );
}
