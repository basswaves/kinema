/**
 * "That folder holds library folders you already added: merge them?"
 *
 * Adding a folder that contains an existing one used to be refused with a
 * message to remove the others first, which loses their watch history. This
 * offers the merge instead (`merge_library_roots`): the files move over as
 * they are. Inline rather than a dialog, so the remote stays inside the page's
 * focus tree, and the focus starts on the button that does it.
 */
import { useLayoutEffect } from 'react';
import { focusTo } from './focus';
import FocusButton from './FocusButton';
import FocusGroup from './FocusGroup';
import { count } from './format';
import type { LibraryKind, LibraryRoot } from '../library/api';

export interface MergeOfferState {
  path: string;
  kind: LibraryKind;
  inside: LibraryRoot[];
  /** A Videos folder's typed name, kept through the merge. */
  name?: string;
}

interface Props {
  offer: MergeOfferState;
  onMerge: () => void;
  onCancel: () => void;
}

export default function MergeOffer({ offer, onMerge, onCancel }: Props) {
  // The ring is on the button that opened the folder browser when this appears,
  // so it is moved here, to the button that merges.
  useLayoutEffect(() => {
    focusTo('merge-offer-yes');
  }, []);
  return (
    <div className="settings-update merge-offer" role="group" aria-label="Merge library folders">
      <p>
        <strong>{offer.path}</strong> holds {count(offer.inside.length, 'library folder')} you
        already added:
      </p>
      <ul className="merge-offer-list">
        {offer.inside.map((root) => (
          <li key={root.id}>
            <span className="root-path">{root.path}</span>
          </li>
        ))}
      </ul>
      <p>Merge them into it? Their films and shows, matches and what you have watched are kept.</p>
      <FocusGroup kind="row" className="settings-row">
        <FocusButton
          focusKey="merge-offer-yes"
          className="btn-primary"
          onSelect={onMerge}
        >
          Merge them
        </FocusButton>
        <FocusButton className="btn-secondary" onSelect={onCancel}>
          Not now
        </FocusButton>
      </FocusGroup>
    </div>
  );
}
