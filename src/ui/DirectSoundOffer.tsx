/**
 * The one-time offer to send sound straight to the receiver, shown before a
 * film starts rather than inside the player: the browsing views have ordinary
 * spatial navigation, where the player's arrows seek until its controls are
 * opened (see PLAN.md → Native output for why it is offered at all, and once).
 *
 * A focus boundary, and it takes focus itself on arrival — Play still holds
 * it, so `useClaimFocus`, which only fills a dead focus, would leave the remote
 * on a button behind the dialog.
 */
import { useEffect } from 'react';
import { FocusContext, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from './FocusButton';
import type { DirectSoundOffer as Offer } from '../player/audioOutput';

export const DIRECT_SOUND_OFFER_KEY = 'direct-sound-offer';
const ACCEPT_KEY = 'direct-sound-offer-accept';

export default function DirectSoundOffer({
  offer,
  onAccept,
  onDecline,
}: {
  offer: Offer;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: DIRECT_SOUND_OFFER_KEY,
    isFocusBoundary: true,
    trackChildren: true,
  });

  useEffect(() => {
    void setFocus(ACCEPT_KEY);
  }, []);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="offer-backdrop">
        <div className="offer-card" ref={ref} role="dialog" aria-labelledby="offer-title">
          <h2 id="offer-title">Send the film&rsquo;s own sound to {offer.device}?</h2>
          <p>
            It takes {offer.formats.join(' and ')} untouched — Dolby Atmos and DTS:X included.
            Through Windows, those are decoded to plain surround and the height sound is lost.
          </p>
          <p className="muted">
            With this on, Kinema holds the sound device only while a film plays; other sounds from
            this PC are silent until it stops. Windows&rsquo; own settings, spatial sound included,
            are left as they are. You can change it any time in Settings → Sound. This is only
            asked once.
          </p>
          <div className="offer-actions">
            <FocusButton focusKey={ACCEPT_KEY} className="btn-primary" onSelect={onAccept}>
              Yes, turn it on
            </FocusButton>
            <FocusButton className="btn-secondary" onSelect={onDecline}>
              Not now
            </FocusButton>
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
