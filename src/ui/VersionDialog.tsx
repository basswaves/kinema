/**
 * The Version list on a title page (versions.ts): each file of the film or
 * episode in Kinema's words, the one Play means marked. Choosing one makes it
 * Play's, remembered for the title.
 *
 * A menu like Play something: focus never leaves it, Back closes it and the
 * ring goes back to the Version button.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  FocusContext,
  getCurrentFocusKey,
  setFocus,
} from '@noriginmedia/norigin-spatial-navigation';
import { useFocusGroup } from './focusGroups';
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
  const { ref, focusKey } = useFocusGroup('menu');

  const returnTo = useRef<string | null>(null);
  useEffect(() => {
    returnTo.current = getCurrentFocusKey();
    void setFocus(versionKey(current));
    // Only on opening: the ring starts on the version Play means.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(() => {
    if (returnTo.current) void setFocus(returnTo.current);
    onClose();
  }, [onClose]);

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
    <FocusContext.Provider value={focusKey}>
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
    </FocusContext.Provider>
  );
}
