/**
 * The bar along the bottom of the player: the position and the seek bar, and
 * under them the buttons. It draws and reports; what each control does is the
 * player's (Player.tsx), passed in.
 */
import { memo } from 'react';
import FocusButton from '../ui/FocusButton';
import FocusGroup from '../ui/FocusGroup';
import { formatTime } from '../ui/format';
import { setShortcutsOpen } from '../ui/shortcutsState';
import type { Steps } from './useNeighbours';
import { PLAYER_CHAPTERS_KEY, PLAYER_PLAY_KEY, PLAYER_TRACKS_KEY } from './focusKeys';
import {
  BackTenIcon,
  ChaptersIcon,
  ForwardTenIcon,
  FullscreenIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  SubtitlesIcon,
} from './icons';
import SeekBar from './SeekBar';
import VolumeControl from './VolumeControl';

interface Props {
  /**
   * Whether the bar is showing. While it is not, a change of position is not
   * drawn: the bar has faded out, and the film ticking over would re-render
   * every button under it for nothing.
   */
  visible: boolean;
  timePos: number | null;
  duration: number | null;
  paused: boolean;
  /**
   * The episodes either side, or for a video outside the library the files
   * beside it; a button is drawn only for one that exists.
   */
  steps: Steps;
  showTracks: boolean;
  /** The file has chapters to choose between: the Chapters button shows. */
  hasChapters: boolean;
  showChapters: boolean;
  volume: number;
  muted: boolean;
  /** Sound bitstreamed to a receiver: the volume here would do nothing. */
  receiver: boolean;
  /** TV mode: the window is always full screen, so there is no button for it. */
  tv: boolean;
  /** Left/Right on the seek bar steer the seek; letting go sends it. */
  onScrub: (dir: 1 | -1, repeat: boolean) => void;
  onScrubRelease: () => void;
  /** OK on the seek bar. */
  onSeekBarEnter: () => void;
  /** A mouse dragging the bar: pressed, moved to a time, let go at one. */
  onDragStart: () => void;
  onDrag: (seconds: number) => void;
  onDragEnd: (seconds: number | null) => void;
  onSeekBy: (seconds: number) => void;
  onTogglePause: () => void;
  /** Audio & subtitles: opens the track panel, or closes it. */
  onTracks: () => void;
  /** Chapters: opens the chapter list, or closes it. */
  onChapters: () => void;
  onVolumeChange: (delta: number) => void;
  onVolumeSet: (level: number, save: boolean) => void;
  onToggleMute: () => void;
  onFullscreen: () => void;
}

function PlayerControls({
  timePos,
  duration,
  paused,
  steps,
  showTracks,
  hasChapters,
  showChapters,
  volume,
  muted,
  receiver,
  tv,
  onScrub,
  onScrubRelease,
  onSeekBarEnter,
  onDragStart,
  onDrag,
  onDragEnd,
  onSeekBy,
  onTogglePause,
  onTracks,
  onChapters,
  onVolumeChange,
  onVolumeSet,
  onToggleMute,
  onFullscreen,
  // Read only by the comparison below.
  visible: _visible,
}: Props) {
  const progress = duration && timePos !== null ? (timePos / duration) * 100 : 0;

  return (
    <div className="player-controls">
      <div className="player-seek-row">
        <span className="player-time">{formatTime(timePos)}</span>
        <SeekBar
          progress={progress}
          onScrub={onScrub}
          onRelease={onScrubRelease}
          onEnter={onSeekBarEnter}
        >
          <input
            className="player-seek"
            type="range"
            min={0}
            max={100}
            step={0.05}
            value={progress}
            tabIndex={-1}
            onMouseDown={onDragStart}
            onChange={(e) => {
              const pct = Number(e.target.value);
              if (duration) onDrag((pct / 100) * duration);
            }}
            onMouseUp={(e) => {
              const input = e.target as HTMLInputElement;
              const pct = Number(input.value);
              onDragEnd(duration ? (pct / 100) * duration : null);
              // Keep the browser's own arrow-key handling off the slider, or
              // the next Left would move it *and* seek.
              input.blur();
            }}
          />
        </SeekBar>
        <span className="player-time">{formatTime(duration)}</span>
      </div>

      {/* Three groups: help at the left, the transport in the middle where the
          eye goes, and the settings of the moment at the right. Icons rather
          than words for the transport, as on every player; each carries its
          name for a screen reader and a tooltip for the mouse. Stats is not
          here any more — it is a diagnostic, on `i` and in the key list, not
          something to walk past on the way to the subtitles. */}
      {/* One row on the focus engine: Left and Right along it, Up to the bar,
          arriving on Play/Pause. */}
      <FocusGroup kind="row" className="player-buttons" current={PLAYER_PLAY_KEY}>
        <div className="player-group player-group-left">
          <FocusButton
            className="icon-button"
            label="Keyboard and remote controls"
            title="Keyboard and remote controls (?)"
            onSelect={() => setShortcutsOpen(true)}
          >
            <span className="help-glyph">?</span>
          </FocusButton>
        </div>
        <div className="player-group player-group-centre">
          {/* Rendered only where there genuinely is a neighbour, so these
              never appear on a film or at the ends of a run or a folder. */}
          {steps.prev && (
            <FocusButton
              className="icon-button"
              label={`Previous ${steps.prev.kind}: ${steps.prev.name}`}
              title={`Previous: ${steps.prev.name} (P)`}
              onSelect={steps.prev.play}
            >
              <PreviousIcon />
            </FocusButton>
          )}
          <FocusButton
            className="icon-button"
            label="Back 10 seconds"
            title="Back 10 seconds (←)"
            onSelect={() => onSeekBy(-10)}
          >
            <BackTenIcon />
          </FocusButton>
          <FocusButton
            focusKey={PLAYER_PLAY_KEY}
            className="icon-button play-button"
            label={paused ? 'Play' : 'Pause'}
            title={paused ? 'Play (OK / Space)' : 'Pause (OK / Space)'}
            onSelect={onTogglePause}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </FocusButton>
          <FocusButton
            className="icon-button"
            label="Forward 10 seconds"
            title="Forward 10 seconds (→)"
            onSelect={() => onSeekBy(10)}
          >
            <ForwardTenIcon />
          </FocusButton>
          {steps.next && (
            <FocusButton
              className="icon-button"
              label={`Next ${steps.next.kind}: ${steps.next.name}`}
              title={`Next: ${steps.next.name} (N)`}
              onSelect={steps.next.play}
            >
              <NextIcon />
            </FocusButton>
          )}
        </div>
        <div className="player-group player-group-right">
          {hasChapters && (
            <FocusButton
              focusKey={PLAYER_CHAPTERS_KEY}
              className={`labelled-button ${showChapters ? 'active' : ''}`}
              onSelect={onChapters}
            >
              <ChaptersIcon />
              <span>Chapters</span>
            </FocusButton>
          )}
          <FocusButton
            focusKey={PLAYER_TRACKS_KEY}
            className={`labelled-button ${showTracks ? 'active' : ''}`}
            onSelect={onTracks}
          >
            <SubtitlesIcon />
            <span>Audio &amp; subtitles</span>
          </FocusButton>
          <VolumeControl
            level={volume}
            muted={muted}
            receiver={receiver}
            onChange={onVolumeChange}
            onSet={onVolumeSet}
            onToggleMute={onToggleMute}
          />
          {!tv && (
            <FocusButton
              className="icon-button"
              label="Fullscreen"
              title="Fullscreen (F)"
              onSelect={onFullscreen}
            >
              <FullscreenIcon />
            </FocusButton>
          )}
        </div>
      </FocusGroup>
    </div>
  );
}

/**
 * Re-drawn when anything but the position changes, and when the position
 * changes while the bar can be seen. Coming back into view changes `visible`,
 * so it is always drawn at the current position before it can be seen.
 */
export default memo(PlayerControls, (prev, next) =>
  (Object.keys(next) as (keyof Props)[]).every(
    (key) => (key === 'timePos' && !next.visible) || Object.is(prev[key], next[key])
  )
);
