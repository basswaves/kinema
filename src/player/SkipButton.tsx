/**
 * Skip intro, Skip recap, the scene after the credits, or on to the next
 * episode — whichever `skipPromptFor` says is on offer (skip.ts).
 */
import FocusButton from '../ui/FocusButton';
import { skipLabel, type ActiveSkip } from './skip';

export default function SkipButton({
  prompt,
  onSkip,
}: {
  prompt: ActiveSkip;
  onSkip: () => void;
}) {
  return (
    <FocusButton className="skip-button" onSelect={onSkip}>
      {skipLabel(prompt)}
    </FocusButton>
  );
}
