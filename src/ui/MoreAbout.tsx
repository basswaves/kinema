/**
 * The longer explanation behind a setting, one press away.
 *
 * Settings said everything at full length, all the time — two thousand words
 * down one page, every sentence true and most of them unread. Now each setting
 * has one line saying what it does, and the why, the caveats and the history
 * sit behind this, for whoever wants them.
 */
import { useState, type ReactNode } from 'react';
import FocusButton from './FocusButton';

export default function MoreAbout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="more-about">
      <FocusButton
        className="more-toggle"
        keepInView="nearest"
        onSelect={() => setOpen((o) => !o)}
      >
        {open ? 'Less' : 'More about this'}
      </FocusButton>
      {open && <div className="more-body">{children}</div>}
    </div>
  );
}
