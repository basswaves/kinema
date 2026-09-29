/**
 * A button that asks first.
 *
 * For the two controls here that change something outside the app's own data:
 * removing a library folder, and overwriting NFO files across the user's media
 * shares. Both were a single press, both were styled exactly like the safe
 * button beside them, and the second sits directly under a paragraph explaining
 * that overwriting would throw away someone else's work.
 *
 * Deliberately **not** a native confirm dialog. This screen has to be operable
 * from a sofa, and a native dialog leaves the app's focus model entirely — the
 * spatial system does not know it exists, so a remote lands nowhere. Arming in
 * place keeps every press inside the same focus tree.
 *
 * The armed state expires. A confirmation left sitting on screen is a trap for
 * the next person who walks past and presses OK on the remote.
 */
import { useEffect, useState } from 'react';
import FocusButton, { type KeepInView } from './FocusButton';

/** How long the confirmation stays live before giving up. */
const ARMED_MS = 6000;

interface Props {
  children: React.ReactNode;
  /** What the button says once armed. Phrase it as the consequence. */
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
  /** Passed to each of the buttons this renders. */
  keepInView?: KeepInView;
  /**
   * A key for directing focus here. It stays on whichever button comes first,
   * armed or not: React keeps that one button through the change, and the
   * spatial library registers a key only once, when a button first appears —
   * a key that changed afterwards would leave it acting on the old press.
   */
  focusKey?: string;
}

export default function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  className = '',
  disabled = false,
  keepInView,
  focusKey,
}: Props) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), ARMED_MS);
    return () => window.clearTimeout(id);
  }, [armed]);

  if (!armed) {
    return (
      <FocusButton
        className={className}
        disabled={disabled}
        keepInView={keepInView}
        focusKey={focusKey}
        onSelect={() => setArmed(true)}
      >
        {children}
      </FocusButton>
    );
  }

  return (
    <>
      <FocusButton
        className="btn-danger"
        disabled={disabled}
        keepInView={keepInView}
        focusKey={focusKey}
        onSelect={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </FocusButton>
      <FocusButton
        className="btn-secondary"
        keepInView={keepInView}
        onSelect={() => setArmed(false)}
      >
        Cancel
      </FocusButton>
    </>
  );
}
