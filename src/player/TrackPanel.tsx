/**
 * The audio and subtitle panel in the player.
 */
import { FocusContext, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from '../ui/FocusButton';
import type { Track } from './engine';
import { describeTrack } from './tracks';
import { languageName } from './language';
import { describeOffer, type Offer } from './onlineSubtitles';

/**
 * "Find subtitles online" — present only when this copy of Kinema has an
 * OpenSubtitles key and the file is in the library. The player does the
 * work; this only shows it.
 */
export interface OnlineSubtitles {
  /** The language to search in, two letters. */
  language: string;
  /** More than one language to choose from: show the switch. */
  canChangeLanguage: boolean;
  onChangeLanguage: () => void;
  onFind: () => void;
  finding: boolean;
  /** What happened last, in a sentence. */
  message: string | null;
  /** The rest of what was found, for "Choose another". */
  offers: Offer[];
  onOffer: (offer: Offer) => void;
}

/** How many of the others to list; a remote scrolls a short list. */
const MAX_OFFERS = 8;

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
  online,
}: {
  audioTracks: Track[];
  subTracks: Track[];
  aid: number | null;
  sid: number | null;
  subVisible: boolean;
  onChoose: (kind: 'audio' | 'sub', track: Track | null) => void;
  onClose: () => void;
  online?: OnlineSubtitles | null;
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
            onSelect={() => onChoose('audio', track)}
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
          onSelect={() => onChoose('sub', null)}
        >
          Off
        </FocusButton>
        {subTracks.map((track) => (
          <FocusButton
            key={track.id}
            className={`track-option ${subVisible && sid === track.id ? 'active' : ''}`}
            keepInView="nearest"
            onSelect={() => onChoose('sub', track)}
          >
            {describeTrack(track)}
          </FocusButton>
        ))}
        {online && (
          <>
            <FocusButton
              className="track-option track-online"
              keepInView="nearest"
              disabled={online.finding}
              onSelect={online.onFind}
            >
              {online.finding
                ? 'Looking on OpenSubtitles…'
                : `Find ${languageName(online.language) ?? online.language} subtitles online`}
            </FocusButton>
            {online.canChangeLanguage && !online.finding && (
              <FocusButton
                className="track-option"
                keepInView="nearest"
                onSelect={online.onChangeLanguage}
              >
                Another language ›
              </FocusButton>
            )}
            {online.message && <p className="track-note">{online.message}</p>}
            {online.offers.length > 0 && (
              <>
                <div className="track-panel-head">
                  <span>Choose another</span>
                </div>
                {online.offers.slice(0, MAX_OFFERS).map((offer) => (
                  <FocusButton
                    key={offer.file_id}
                    className="track-option track-offer"
                    keepInView="nearest"
                    disabled={online.finding}
                    onSelect={() => online.onOffer(offer)}
                  >
                    {describeOffer(offer)}
                  </FocusButton>
                ))}
              </>
            )}
          </>
        )}
        <p className="track-note">Remembered for this show.</p>
      </aside>
    </FocusContext.Provider>
  );
}
