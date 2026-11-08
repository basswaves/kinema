/**
 * "It moved…": a library folder that is not found, told where it went
 * (GitHub #14, review 2026-11 finding 5).
 *
 * A drive back under another letter, or a disk mounted under a new name, left
 * the old folder unreachable for good, and adding the new place gave every
 * file a second, empty row (`following::move_root`). Two ways in: the folder's
 * own `It moved…` in Settings, and adding a folder where a missing one's files
 * are (`adding`), which asks before it adds. Inline, as MergeOffer, so the
 * remote stays in the page's focus tree; the ring starts on the button that
 * does it, or on the way out when nothing is there.
 */
import { useLayoutEffect } from 'react';
import { focusTo } from './focus';
import FocusButton from './FocusButton';
import FocusGroup from './FocusGroup';
import { count } from './format';
import type { LibraryRoot } from '../library/api';

export interface MovedOfferState {
  root: LibraryRoot;
  /** The new place. */
  path: string;
  found: number;
  total: number;
  /** Picked as a folder to add: "Move it, or add as new?" */
  adding?: boolean;
}

interface Props {
  offer: MovedOfferState;
  onMove: () => void;
  onAddAsNew: () => void;
  onCancel: () => void;
}

export const MOVED_YES = 'moved-offer-yes';
export const MOVED_NO = 'moved-offer-no';

export default function MovedOffer({ offer, onMove, onAddAsNew, onCancel }: Props) {
  const none = offer.found === 0;
  useLayoutEffect(() => {
    focusTo(none ? MOVED_NO : MOVED_YES);
  }, [none]);
  const found = none
    ? `None of its ${count(offer.total, 'file')} are there.`
    : `${offer.found} of ${count(offer.total, 'file')} found there.`;
  return (
    <div className="settings-update moved-offer" role="group" aria-label="A library folder that moved">
      {offer.adding ? (
        <p>
          This looks like <strong>{offer.root.path}</strong>, moved here: {found} Move it, or add
          as new?
        </p>
      ) : (
        <p>
          <strong>{offer.root.path}</strong> is now at <strong>{offer.path}</strong>? {found}
        </p>
      )}
      {!none && (
        <p className="muted">
          The same films and shows, with what you watched and decided. Nothing on the disk is
          changed.
        </p>
      )}
      <FocusGroup kind="row" className="settings-row">
        {!none && (
          <FocusButton focusKey={MOVED_YES} className="btn-primary" onSelect={onMove}>
            {offer.adding ? 'Move it' : 'Move'}
          </FocusButton>
        )}
        {offer.adding ? (
          <FocusButton focusKey={MOVED_NO} className="btn-secondary" onSelect={onAddAsNew}>
            Add as new
          </FocusButton>
        ) : (
          <FocusButton focusKey={MOVED_NO} className="btn-secondary" onSelect={onCancel}>
            Cancel
          </FocusButton>
        )}
      </FocusGroup>
    </div>
  );
}
