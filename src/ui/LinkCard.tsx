/**
 * A web address the system could not open, shown instead (`links.ts`): the
 * address in words and as a QR code, to open on a phone. Close, Back or Esc
 * puts it away and the ring back where it was.
 */
import { useCallback, useEffect } from 'react';
import FocusButton from './FocusButton';
import { FocusProvider } from './FocusGroup';
import { ALL_ARROWS, useNavGroup } from './focusGroups';
import { closeLink, type ShownLink } from './links';

const CLOSE_KEY = 'link-card-close';

export default function LinkCard({ link }: { link: ShownLink }) {
  // A dialog: the ring on Close (the card covers the button it came from),
  // and back where it was on the way out (focusStore.ts).
  const { ref, focusKey } = useNavGroup({ kind: 'column', current: CLOSE_KEY, hold: ALL_ARROWS, modal: true });

  const close = useCallback(() => closeLink(), []);

  // Capture phase, like the key list: the page behind must never see Back.
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
      <div className="shortcuts-backdrop" onClick={close}>
        <div
          className="shortcuts link-card"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="A web page to open elsewhere"
        >
          <h2>Open this on your phone</h2>
          <p className="muted">
            Nothing on this device can open web pages. Scan the code with your phone&rsquo;s
            camera, or type the address on a phone or computer.
          </p>
          <div className="link-card-body">
            {link.qr && <img className="simkl-qr" src={link.qr} alt="QR code for the address" />}
            <p className="link-card-url">{link.url}</p>
          </div>
          <FocusButton focusKey={CLOSE_KEY} className="btn-primary" onSelect={close}>
            Close
          </FocusButton>
        </div>
      </div>
    </FocusProvider>
  );
}
