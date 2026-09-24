/**
 * The audio and subtitle panel in the player.
 */
import { FocusContext, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from '../ui/FocusButton';
import { describeTrack, type MpvTrack } from './tracks';

/** Focus is aimed at the panel the moment it opens — see Player. */
export const TRACK_PANEL_KEY = 'player-track-panel';

/**
 * Audio and subtitle selection.
 *
 * A component of its own because `useFocusable` reads the focus context of the
 * component it is *called in*: declaring this container up in `Player` would
 * read `Player`'s own context — the root — and make the panel a **sibling** of
 * the player shell rather than a child of it. The markup would look nested and
 * the focus tree would be flat, which is the trap in docs/GOTCHAS.md that cost a
 * debugging round in the browsing UI.
 *
 * This is the panel that most justifies the whole focus mode: on a library with
 * mixed audio and subtitle languages it is the control reached most often, and
 * until now a remote could not reach it at all.
 */
export default function TrackPanel({
  audioTracks,
  subTracks,
  aid,
  sid,
  subVisible,
  onChoose,
  onClose,
}: {
  audioTracks: MpvTrack[];
  subTracks: MpvTrack[];
  aid: number | null;
  sid: number | null;
  subVisible: boolean;
  onChoose: (kind: 'sid' | 'aid', track: MpvTrack | null) => void;
  onClose: () => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: TRACK_PANEL_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  return (
    <FocusContext.Provider value={focusKey}>
      <aside className="track-panel" ref={ref}>
        <div className="track-panel-head">
          <span>Audio</span>
          <FocusButton onSelect={onClose}>close</FocusButton>
        </div>
        {audioTracks.length === 0 && <div className="track-empty">no audio tracks</div>}
        {audioTracks.map((track) => (
          <FocusButton
            key={track.id}
            className={`track-option ${aid === track.id ? 'active' : ''}`}
            keepInView="nearest"
            onSelect={() => onChoose('aid', track)}
          >
            {describeTrack(track)}
          </FocusButton>
        ))}

        <div className="track-panel-head">
          <span>Subtitles</span>
        </div>
        <FocusButton
          className={`track-option ${!subVisible ? 'active' : ''}`}
          keepInView="nearest"
          onSelect={() => onChoose('sid', null)}
        >
          Off
        </FocusButton>
        {subTracks.map((track) => (
          <FocusButton
            key={track.id}
            className={`track-option ${subVisible && sid === track.id ? 'active' : ''}`}
            keepInView="nearest"
            onSelect={() => onChoose('sid', track)}
          >
            {describeTrack(track)}
          </FocusButton>
        ))}
        <p className="track-note">Remembered for this show.</p>
      </aside>
    </FocusContext.Provider>
  );
}
