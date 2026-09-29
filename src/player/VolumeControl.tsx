/**
 * The volume control in the player bar.
 *
 * A remote has no slider to drag, and Left/Right are how it moves along the
 * row — a horizontal slider here would trap it. So it is a button that works
 * vertically, the way TV volume does: with the ring on it, Up and Down change
 * the level (a bar above it shows where it is) and OK mutes. Left and Right
 * still leave. A mouse clicks to mute, scrolls to change the level, or
 * clicks and drags on the bar that opens above it.
 *
 * While the sound goes to a receiver untouched, the level here would do
 * nothing, so it says the receiver has the volume rather than pretending.
 */
import { useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import type { PointerEvent } from 'react';
import { VolumeIcon } from './icons';
import { VOLUME_STEP } from './volume';

export const PLAYER_VOLUME_KEY = 'player-volume';

interface Props {
  level: number;
  muted: boolean;
  /** Sound is bitstreamed to a receiver, whose volume is the one that counts. */
  receiver: boolean;
  onChange: (delta: number) => void;
  /** An absolute level from the mouse on the bar; `save` once it is let go. */
  onSet: (level: number, save: boolean) => void;
  onToggleMute: () => void;
}

/** The level at the pointer's height on the bar, 0 at the bottom to 100 at the top. */
function levelAt(e: PointerEvent<HTMLDivElement>): number {
  const rect = e.currentTarget.getBoundingClientRect();
  return Math.round(((rect.bottom - e.clientY) / rect.height) * 100);
}

export default function VolumeControl({
  level,
  muted,
  receiver,
  onChange,
  onSet,
  onToggleMute,
}: Props) {
  const { ref, focused } = useFocusable<object, HTMLDivElement>({
    focusKey: PLAYER_VOLUME_KEY,
    onEnterPress: () => {
      if (!receiver) onToggleMute();
    },
    onArrowPress: (direction) => {
      if (direction !== 'up' && direction !== 'down') return true;
      if (!receiver) onChange(direction === 'up' ? VOLUME_STEP : -VOLUME_STEP);
      return false;
    },
  });

  const name = receiver
    ? 'Volume is on the receiver'
    : muted
      ? 'Sound off — press to turn it on'
      : `Volume ${level}%`;

  return (
    <div
      ref={ref}
      className={`volume-control ${focused ? 'focused' : ''} ${receiver ? 'receiver' : ''}`}
      role="button"
      aria-label={name}
      title={receiver ? name : `${name} — scroll to change, click to mute (M)`}
      onClick={() => !receiver && onToggleMute()}
      onWheel={(e) => !receiver && onChange(e.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP)}
    >
      <VolumeIcon muted={muted && !receiver} />
      <span className="volume-value">{receiver ? 'Receiver' : muted ? 'Off' : level}</span>
      {/* A click in here is on the bar, not the control: it must not mute. */}
      <div className="volume-pop" aria-hidden="true" onClick={(e) => e.stopPropagation()}>
        {receiver ? (
          <span className="volume-pop-note">Use the receiver’s volume</span>
        ) : (
          <>
            {/* The hit area is wider than the thin track it draws. */}
            <div
              className="volume-hit"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                onSet(levelAt(e), false);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) onSet(levelAt(e), false);
              }}
              onPointerUp={(e) => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                e.currentTarget.releasePointerCapture(e.pointerId);
                onSet(levelAt(e), true);
              }}
            >
              <div className="volume-track">
                <div className="volume-fill" style={{ height: `${muted ? 0 : level}%` }} />
              </div>
            </div>
            <span className="volume-pop-hint">▲▼</span>
          </>
        )}
      </div>
    </div>
  );
}
