/**
 * The seek bar, as something a remote can land on.
 *
 * It was a bare range input — absent from the focus tree, so a remote could
 * only ever move in ten-second steps. On the bar, Left/Right steer the same
 * accelerating seek as in watching mode: the focus engine hands them to the
 * bar (`onArrow`) and moves no ring, so exactly one handler acts on each
 * press. Up and Down still leave the bar — Down onto Play/Pause, the button
 * row's own landing (PlayerControls).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useNavLeaf } from '../ui/focusStore';
import { PLAYER_SEEK_KEY } from './focusKeys';

export default function SeekBar({
  progress,
  onScrub,
  onRelease,
  onEnter,
  children,
}: {
  progress: number;
  onScrub: (dir: 1 | -1, repeat: boolean) => void;
  onRelease: () => void;
  onEnter: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { focused, props } = useNavLeaf(PLAYER_SEEK_KEY, ref, {
    on: true,
    onSelect: onEnter,
    onArrow: (arrow, event) => {
      if (arrow !== 'left' && arrow !== 'right') return false;
      onScrub(arrow === 'left' ? -1 : 1, event.repeat);
      return true;
    },
  });
  // Letting go of the key sends the seek after a hold (useScrub).
  useEffect(() => {
    if (!focused) return;
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') onRelease();
    };
    window.addEventListener('keyup', onKeyUp);
    return () => window.removeEventListener('keyup', onKeyUp);
  }, [focused, onRelease]);

  return (
    <div
      ref={ref}
      {...props}
      className={`player-seek-wrap ${focused ? 'focused' : ''}`}
      role="slider"
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress)}
    >
      {children}
    </div>
  );
}
