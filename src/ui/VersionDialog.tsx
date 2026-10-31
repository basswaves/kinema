/**
 * The Version list on a title page (versions.ts): each file of the film or
 * episode in Kinema's words, the one Play means marked. Choosing one makes it
 * Play's, remembered for the title.
 *
 * A menu like Play something: the ring starts on the version Play means and
 * never leaves it, Back closes it and the ring goes back to the Version
 * button — a dialog on Kinema's engine does both by itself (focusStore.ts).
 */
import { useEffect } from 'react';
import { useFocusGroup } from './focusGroups';
import { FocusProvider } from './FocusGroup';
import FocusButton from './FocusButton';
import type { Version } from '../library/versions';

const versionKey = (fileId: number) => `version-${fileId}`;

interface Props {
  what: string;
  versions: Version[];
  current: number;
  onChoose: (version: Version) => void;
  onClose: () => void;
}

export default function VersionDialog({ what, versions, current, onChoose, onClose }: Props) {
  const { ref, focusKey } = useFocusGroup('menu', { current: versionKey(current) });
  const close = onClose;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close]);

  return (
    <FocusProvider value={focusKey}>
      <div className="leave-backdrop" onClick={close}>
        <div
          className="leave versions"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Version"
        >
          <h2>Version</h2>
          <p className="muted">{what} is here more than once. Play uses the one you pick, next time too.</p>
          <div className="leave-choices">
            {versions.map((v) => (
              <FocusButton
                key={v.file_id}
                focusKey={versionKey(v.file_id)}
                className={`leave-choice ${v.file_id === current ? 'version-current' : ''}`}
                label={v.file_id === current ? `${v.words}, the one Play uses` : v.words}
                onSelect={() => {
                  onChoose(v);
                  close();
                }}
              >
                {v.file_id === current ? `✓ ${v.words}` : v.words}
              </FocusButton>
            ))}
          </div>
        </div>
      </div>
    </FocusProvider>
  );
}
