/**
 * Skip intro, Skip recap, the scene after the credits, or on to the next
 * episode — whichever `skipPromptFor` says is on offer (skip.ts).
 *
 * After a few seconds it shrinks to a small mark, so a prompt that stays up
 * (an intro offered from 0:00, credits) stops covering the picture. It is the
 * same button: its key and the ring work as before, and any mouse move, press
 * or touch makes it full size again. The words stay in the page (the CSS only
 * hides them), so a screen reader and the tests still read the label.
 */
import { useEffect, useState } from 'react';
import FocusButton from '../ui/FocusButton';
import { skipLabel, type ActiveSkip } from './skip';

/** How long the button stays full size before it shrinks. */
export const SKIP_SHRINK_MS = 10_000;

/** Every way a person says "I am here": pointer, keyboard, remote, touch. */
const WAKE_EVENTS = ['mousemove', 'pointerdown', 'keydown', 'touchstart'] as const;

export default function SkipButton({
  prompt,
  nextIsEpisode,
  onSkip,
}: {
  prompt: ActiveSkip;
  /** False for a playlist's next item or the next video (skip.ts). */
  nextIsEpisode: boolean;
  onSkip: () => void;
}) {
  const [compact, setCompact] = useState(false);
  const key = prompt.key;

  // A new segment is a new button: full size, and the ten seconds start again.
  useEffect(() => {
    setCompact(false);
  }, [key]);

  // Full size runs out after ten seconds; any input starts them again.
  useEffect(() => {
    if (compact) {
      const wake = () => setCompact(false);
      for (const name of WAKE_EVENTS) window.addEventListener(name, wake, true);
      return () => {
        for (const name of WAKE_EVENTS) window.removeEventListener(name, wake, true);
      };
    }
    const timer = window.setTimeout(() => setCompact(true), SKIP_SHRINK_MS);
    return () => window.clearTimeout(timer);
  }, [compact, key]);

  const label = skipLabel(prompt, nextIsEpisode);
  return (
    <FocusButton
      className={compact ? 'skip-button compact' : 'skip-button'}
      label={label}
      title={label}
      onSelect={onSkip}
    >
      {label}
    </FocusButton>
  );
}
