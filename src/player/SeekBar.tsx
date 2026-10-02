/**
 * The seek bar, as something a remote can land on.
 *
 * It was a bare range input — absent from the focus tree, so a remote could
 * only ever move in ten-second steps. On the bar, Left/Right steer the same
 * accelerating seek as in watching mode, through the spatial library's own
 * arrow callbacks: returning `false` keeps the press from also moving the
 * ring, so exactly one handler acts on it. Up and Down still leave the bar.
 */
import { setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import type { ReactNode } from 'react';
import { PLAYER_PLAY_KEY, PLAYER_SEEK_KEY } from './focusKeys';

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
  const { ref, focused } = useFocusable<object, HTMLDivElement>({
    focusKey: PLAYER_SEEK_KEY,
    onEnterPress: onEnter,
    onArrowPress: (direction, _props, details) => {
      // Down lands on Play/Pause, the control under the middle of the bar.
      // Left to the spatial library it went to whatever sat nearest the bar's
      // left end, which was the key list.
      if (direction === 'down') {
        void setFocus(PLAYER_PLAY_KEY);
        return false;
      }
      if (direction !== 'left' && direction !== 'right') return true;
      onScrub(direction === 'left' ? -1 : 1, (details.pressedKeys[direction] ?? 1) > 1);
      return false;
    },
    onArrowRelease: (direction) => {
      if (direction === 'left' || direction === 'right') onRelease();
    },
  });

  return (
    <div
      ref={ref}
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
