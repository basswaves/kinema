/**
 * A web address the system could not open, shown instead (`links.ts`): the
 * address in words and as a QR code, to open on a phone. Close, Back or Esc
 * puts it away and the ring back where it was.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  FocusContext,
  getCurrentFocusKey,
  setFocus,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from './FocusButton';
import { useClaimFocus } from './focus';
import { closeLink, type ShownLink } from './links';

const CLOSE_KEY = 'link-card-close';

export default function LinkCard({ link }: { link: ShownLink }) {
  const { ref, focusKey } = useFocusable({ isFocusBoundary: true, trackChildren: true });

  // Where the ring was before, to put it back on the way out.
  // Then the ring to Close: the card covers the button it came from.
  const returnTo = useRef<string | null>(null);
  useEffect(() => {
    returnTo.current = getCurrentFocusKey();
    void setFocus(CLOSE_KEY);
  }, []);
  useClaimFocus(CLOSE_KEY, true);

  const close = useCallback(() => {
    if (returnTo.current) void setFocus(returnTo.current);
    closeLink();
  }, []);

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
    <FocusContext.Provider value={focusKey}>
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
    </FocusContext.Provider>
  );
}
