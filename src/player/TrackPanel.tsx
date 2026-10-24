/**
 * The audio and subtitle panel in the player.
 */
import { FocusContext, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { useState } from 'react';
import { PlaylistChoices } from '../ui/PlaylistPicker';
import type { NewItem } from '../library/playlists';
import { useFocusGroup } from '../ui/focusGroups';
import FocusButton from '../ui/FocusButton';
import type { Track } from './engine';
import { describeTracks } from './tracks';
import { languageBadge, languageName } from './language';
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

/** A track's row: its language's short code, then the line describing it. */
function TrackText({ track, line }: { track: Track; line: string | undefined }) {
  const badge = languageBadge(track.lang);
  return (
    <>
      {badge && (
        <span className="track-lang" aria-hidden="true">
          {badge}
        </span>
      )}
      {line}
    </>
  );
}

/** How many of the others to list; a remote scrolls a short list. */
const MAX_OFFERS = 8;

/** Focus is aimed at the panel the moment it opens — see Player. */
export const TRACK_PANEL_KEY = 'player-track-panel';
const ADD_KEY = 'player-track-panel:playlist';

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
  onDetails,
  online,
  playlistItem,
}: {
  audioTracks: Track[];
  subTracks: Track[];
  aid: number | null;
  sid: number | null;
  subVisible: boolean;
  onChoose: (kind: 'audio' | 'sub', track: Track | null) => void;
  onClose: () => void;
  /**
   * The details panel ("Stats for nerds"): here, off the bar (owner, UX
   * pass), so a remote, a mouse or a finger reaches it without a keyboard's `i`.
   */
  onDetails: () => void;
  online?: OnlineSubtitles | null;
  /**
   * What is playing, to add to a playlist (LOCAL-MEDIA.md phase 5): here, as
   * Playback details is, so the bar does not grow. None for a trailer.
   */
  playlistItem?: NewItem | null;
}) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  // A closed menu (NAV-MAP N1, agreed 2026-10-11): focus never walks out to
  // the controls behind it; Up on the top goes round to the bottom and back;
  // Back closes it (Player.tsx).
  const { ref, focusKey } = useFocusGroup<HTMLElement>('menu', { focusKey: TRACK_PANEL_KEY });
  const audioLines = describeTracks(audioTracks);
  const subLines = describeTracks(subTracks);

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
            <TrackText track={track} line={audioLines.get(track.id)} />
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
            <TrackText track={track} line={subLines.get(track.id)} />
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
        <FocusButton className="track-option" keepInView="nearest" onSelect={onDetails}>
          Playback details ›
        </FocusButton>
        {/* The playlists open under the button rather than in place of the
            panel, so the ring is moved back onto it before they go
            (docs/GOTCHAS.md, focus parked on an unmounted component). A new
            playlist made here is named for itself: the player's keys rule
            out typing. */}
        {playlistItem && (
          <FocusButton
            focusKey={ADD_KEY}
            className="track-option"
            keepInView="nearest"
            onSelect={() => setAdding((open) => !open)}
          >
            {adding ? 'Add to a playlist ⌄' : 'Add to a playlist ›'}
          </FocusButton>
        )}
        {adding && playlistItem && (
          <PlaylistChoices
            items={[playlistItem]}
            typing={false}
            buttonClass="track-option track-playlist"
            onDone={(message) => {
              void setFocus(ADD_KEY);
              setAdding(false);
              setAdded(message);
            }}
          />
        )}
        {added && <p className="track-note">{added}</p>}
      </aside>
    </FocusContext.Provider>
  );
}
