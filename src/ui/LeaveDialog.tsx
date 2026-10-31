/**
 * Leaving Kinema from the sofa.
 *
 * In TV mode the app fills the screen, so there is no title bar and no close
 * button, and a remote has nothing else to reach for. Back on Home (with
 * nowhere further back to go) opens this instead: close Kinema, put the PC to
 * sleep, or shut it down — the last two only where Kinema can do them
 * (`capabilities.ts`). Back again, or Cancel, closes it and leaves Home as it
 * was, with the ring where it had been.
 */
import { useCallback, useEffect, useState } from 'react';
import { FocusProvider } from './FocusGroup';
import { useFocusGroup } from './focusGroups';
import FocusButton from './FocusButton';
import { powerAction, type PowerAction } from './api';
import { userError } from './errors';
import { useCapabilities } from '../capabilities';

const FIRST_KEY = 'leave-close';

interface Props {
  onClose: () => void;
}

export default function LeaveDialog({ onClose }: Props) {
  // A menu (NAV-MAP, agreed 2026-10-11): focus never leaves it, Up on Close
  // Kinema goes round to Cancel and back, and closing it gives the ring
  // back to where it was on Home (focusStore.ts).
  const { ref, focusKey } = useFocusGroup('menu', { current: FIRST_KEY });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const can = useCapabilities();

  const cancel = useCallback(() => onClose(), [onClose]);

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
    <FocusProvider value={focusKey}>
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
            {can?.sleep && (
              <FocusButton
                className="leave-choice"
                onSelect={() => run('sleep', 'Going to sleep…')}
              >
                Put the PC to sleep
              </FocusButton>
            )}
            {can?.shut_down && (
              <FocusButton
                className="leave-choice"
                onSelect={() => run('shutdown', 'Shutting down…')}
              >
                Shut down the PC
              </FocusButton>
            )}
            <FocusButton className="leave-choice leave-cancel" onSelect={cancel}>
              Cancel
            </FocusButton>
          </div>
          {busy && <p className="leave-busy">{busy}</p>}
          {error && <p className="leave-error">{error}</p>}
          <p className="muted">Press Back to return to Kinema.</p>
        </div>
      </div>
    </FocusProvider>
  );
}
