/**
 * Leaving Kinema from the sofa.
 *
 * In TV mode the app fills the screen, so there is no title bar and no close
 * button, and a remote has nothing else to reach for. Back on Home (with
 * nowhere further back to go) opens this instead: close Kinema, put the PC to
 * sleep, or shut it down. Back again, or Cancel, closes it and leaves Home as
 * it was, with the ring where it had been.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FocusContext,
  getCurrentFocusKey,
  setFocus,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from './FocusButton';
import { powerAction, type PowerAction } from './api';
import { userError } from './errors';

const FIRST_KEY = 'leave-close';

interface Props {
  onClose: () => void;
}

export default function LeaveDialog({ onClose }: Props) {
  // A boundary, so the arrows cannot wander onto Home behind the dialog.
  const { ref, focusKey } = useFocusable({ isFocusBoundary: true, trackChildren: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Where the ring was on Home, to put it back on Cancel. Taken before the
  // dialog claims focus, so it is Home's control and not one of these.
  const returnTo = useRef<string | null>(null);
  useEffect(() => {
    returnTo.current = getCurrentFocusKey();
    void setFocus(FIRST_KEY);
  }, []);

  // Focus moves back first, while the dialog still exists: unmounting with
  // the ring inside lets the spatial library restore it somewhere of its own
  // choosing 300 ms later (docs/GOTCHAS.md).
  const cancel = useCallback(() => {
    if (returnTo.current) void setFocus(returnTo.current);
    onClose();
  }, [onClose]);

  // Capture phase, like the key list in App.tsx: Browse's own Back handler
  // must never see the press that closes this.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [cancel]);

  // The choices stay on screen while one runs, so a refusal leaves the ring
  // on the choice that was refused. Replacing them with the progress line
  // sent it back to Close Kinema, one OK away from closing instead of trying
  // again.
  const run = (action: PowerAction, doing: string) => {
    if (busy) return;
    setError(null);
    setBusy(doing);
    powerAction(action)
      .then(() => {
        // Sleep returns once the PC is awake again; Kinema is where it was.
        if (action === 'sleep') cancel();
      })
      .catch((e: unknown) => {
        setBusy(null);
        setError(userError(e));
      });
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="leave-backdrop" onClick={cancel}>
        <div
          className="leave"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Leave Kinema"
        >
          <h2>Leave Kinema</h2>
          <div className="leave-choices">
            <FocusButton
              focusKey={FIRST_KEY}
              className="leave-choice"
              onSelect={() => run('close', 'Closing Kinema…')}
            >
              Close Kinema
            </FocusButton>
            <FocusButton className="leave-choice" onSelect={() => run('sleep', 'Going to sleep…')}>
              Put the PC to sleep
            </FocusButton>
            <FocusButton
              className="leave-choice"
              onSelect={() => run('shutdown', 'Shutting down…')}
            >
              Shut down the PC
            </FocusButton>
            <FocusButton className="leave-choice leave-cancel" onSelect={cancel}>
              Cancel
            </FocusButton>
          </div>
          {busy && <p className="leave-busy">{busy}</p>}
          {error && <p className="leave-error">{error}</p>}
          <p className="muted">Press Back to return to Kinema.</p>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
