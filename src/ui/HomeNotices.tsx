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
  upgrades: Upgrade[];
  onApply: () => void;
  onDismiss: () => void;
}

export default function HomeNotices({ reviewCount, onReview, upgrades, onApply, onDismiss }: Props) {
  const { ref, focusKey } = useFocusable({ trackChildren: true, saveLastFocusedChild: true });
  if (reviewCount === 0 && upgrades.length === 0) return null;

  return (
    <FocusContext.Provider value={focusKey}>
      <section className="home-notices" ref={ref}>
        {reviewCount > 0 && (
          <div className="home-notice">
            <span className="home-notice-icon" aria-hidden="true">
              ?
            </span>
            <div className="home-notice-text">
              <strong>
                {count(reviewCount, 'video')} could not be identified for certain
              </strong>
              <span className="muted">
                {' '}
                — so {reviewCount === 1 ? 'it is' : 'they are'} not on Home yet. Picking the right
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
              <strong>Your equipment can do better than it is set to</strong>
              <ul>
                {upgrades.map((u) => (
                  <li key={u.id}>{u.text}</li>
                ))}
              </ul>
              <span className="muted">
                Turning it on changes only what is listed; every switch is also in Settings.
              </span>
            </div>
            <div className="home-notice-actions">
              <FocusButton
                focusKey="notice-apply"
                className="btn-primary"
                keepInView="nearest"
                onSelect={onApply}
              >
                Turn on
              </FocusButton>
              <FocusButton
                focusKey="notice-dismiss"
                className="btn-secondary"
                keepInView="nearest"
                onSelect={onDismiss}
              >
                OK
              </FocusButton>
            </div>
          </div>
        )}
      </section>
    </FocusContext.Provider>
  );
}
