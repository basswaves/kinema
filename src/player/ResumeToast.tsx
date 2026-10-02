/**
 * "Resumed from 12:34 — Start over". Resuming is automatic, so this is where
 * starting over is offered — for as long as the notice shows, OK means "from
 * the beginning" (the player's key handler; this button is for the ring).
 */
import FocusButton from '../ui/FocusButton';
import { formatTime } from '../ui/format';

export default function ResumeToast({
  resumedFrom,
  onShown,
  onStartOver,
}: {
  resumedFrom: number;
  /** The notice has faded: OK goes back to meaning pause. */
  onShown: () => void;
  onStartOver: () => void;
}) {
  return (
    <div className="resume-toast" onAnimationEnd={onShown}>
      <span>Resumed from {formatTime(resumedFrom)}</span>
      <FocusButton className="resume-start-over" onSelect={onStartOver}>
        Start over <span className="resume-key">OK</span>
      </FocusButton>
    </div>
  );
}
