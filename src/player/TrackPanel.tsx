/**
 * The audio and subtitle panel in the player.
 */
import { useState } from 'react';
import { PlaylistChoices } from '../ui/PlaylistPicker';
import type { NewItem } from '../library/playlists';
import { useFocusGroup } from '../ui/focusGroups';
import FocusButton from '../ui/FocusButton';
import FocusGroup, { FocusProvider } from '../ui/FocusGroup';
import { navFocus } from '../ui/focusStore';
import type { Track } from './engine';
import { describeTracks, isPictureSubtitle, secondChoices, trackLanguage } from './tracks';
import { languageBadge, languageName } from './language';
import { describeOffer, type Offer } from './onlineSubtitles';
import { DELAY_STEP_MS, delayLabel } from './audioDelay';
import { LEVELLINGS, type NotApplied, type SoundLevel } from './soundLevel';
import { SUB_BIG_STEP_MS, SUB_STEP_MS, subDelayLabel } from './subDelay';
import { nextSize, sizeLabel, type SubStyle } from './subtitleStyle';

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
  const badge = languageBadge(trackLanguage(track));
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

/** The panel: a dialog on the focus engine, so the ring goes in as it opens. */
export const TRACK_PANEL_KEY = 'player-track-panel';
const ADD_KEY = 'player-track-panel:playlist';
const SECOND_KEY = 'player-track-panel:second';

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
const levelKey = (id: string) => `player-track-panel:level:${id}`;

/**
 * Levelling in four steps and the dialogue lift, for this title. Not offered
 * for a track that goes to the receiver untouched, and said why: Kinema
 * never alters the film's own bitstream.
 */
function LevelRows({
  level,
  notApplied,
  canLift,
  changeLevel,
}: {
  level: SoundLevel;
  notApplied: NotApplied;
  canLift: boolean;
  changeLevel: (next: SoundLevel) => void;
}) {
  if (notApplied === 'passthrough') {
    return (
      <p className="track-note track-level-off">
        Levelling and the dialogue lift are off for this track: it goes to the receiver untouched,
        and they work only on sound Kinema decodes.
      </p>
    );
  }
  return (
    <>
      <FocusGroup kind="row" className="track-delay track-level" current={levelKey(level.levelling)}>
        <span className="track-delay-label">Levelling</span>
        {LEVELLINGS.map((l) => (
          <FocusButton
            key={l.id}
            focusKey={levelKey(l.id)}
            className={`track-option ${level.levelling === l.id ? 'active' : ''}`}
            label={`Levelling: ${l.label}`}
            onSelect={() => changeLevel({ ...level, levelling: l.id })}
          >
            {l.label}
          </FocusButton>
        ))}
      </FocusGroup>
      {canLift && (
        <div className="track-delay track-level">
          <span className="track-delay-label">Dialogue</span>
          <FocusButton
            className={`track-option ${level.dialogue ? 'active' : ''}`}
            label={level.dialogue ? 'Dialogue lift: on' : 'Dialogue lift: off'}
            onSelect={() => changeLevel({ ...level, dialogue: !level.dialogue })}
          >
            {level.dialogue ? 'Lifted' : 'As mixed'}
          </FocusButton>
        </div>
      )}
      <p className="track-note">
        Levelling brings quiet scenes up and loud ones down
        {canLift ? '; the dialogue lift raises the centre channel, where the speech is' : ''}.
        Kept for this title.
      </p>
    </>
  );
}

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
  subStyle,
  onSubStyle,
  delay,
  level,
  timing,
  sid2,
  onSecond,
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
  /**
   * How big the subtitles are drawn on this screen, and the box behind them
   * (subtitleStyle.ts). None where Media3 draws them (Android).
   */
  subStyle?: SubStyle | null;
  onSubStyle?: (style: SubStyle) => void;
  /**
   * The sound delay kept for the device the sound goes to (audioDelay.ts),
   * and a step of it. None where Media3 plays the sound (Android).
   */
  delay?: { ms: number; onChange: (delta: number, reset?: boolean) => void } | null;
  /**
   * Levelling and the dialogue lift kept for this title (soundLevel.ts);
   * `notApplied` when the track goes to the receiver untouched.
   */
  level?: {
    level: SoundLevel;
    notApplied: NotApplied;
    canLift: boolean;
    changeLevel: (next: SoundLevel) => void;
  } | null;
  /**
   * The subtitle timing kept for this file (subDelay.ts), and a step of it.
   * None where Media3 plays: it has no subtitle offset.
   */
  timing?: { ms: number; onChange: (delta: number, reset?: boolean) => void } | null;
  /**
   * The second subtitles, drawn at the top (mpv's `secondary-sid`), and
   * choosing them. None where Media3 plays: it shows one text track.
   */
  sid2?: number | null;
  onSecond?: ((track: Track | null) => void) | null;
}) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [secondOpen, setSecondOpen] = useState(false);

  // A closed menu (NAV-MAP N1, agreed 2026-10-11): focus never walks out to
  // the controls behind it; Up on the top goes round to the bottom and back;
  // Back closes it (Player.tsx).
  const { ref, focusKey } = useFocusGroup<HTMLElement>('menu', { focusKey: TRACK_PANEL_KEY });
  const audioLines = describeTracks(audioTracks);
  const subLines = describeTracks(subTracks);
  const seconds = onSecond ? secondChoices(subTracks, subVisible ? sid : null) : [];
  const secondNow = subTracks.find((t) => t.id === sid2) ?? null;
  // Picture subtitles are drawn as they were made: no box goes behind them
  // (round 5, T27: the switch read "On" with nothing drawn, and the general
  // hint below it was missed).
  const shown = subVisible ? subTracks.find((t) => t.id === sid) : undefined;
  const pictureShown = shown !== undefined && isPictureSubtitle(shown);
  // A choice closes the list and gives the ring back to its button, as Add to
  // a playlist does: left open, a stray OK picked again (round 5, D).
  const pickSecond = (track: Track | null) => {
    navFocus(SECOND_KEY);
    setSecondOpen(false);
    onSecond?.(track);
  };

  return (
    <FocusProvider value={focusKey}>
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
            onSelect={() => onChoose('audio', track)}
          >
            <TrackText track={track} line={audioLines.get(track.id)} />
          </FocusButton>
        ))}
        {delay && (
          <>
            <FocusGroup kind="row" className="track-delay">
              <span className="track-delay-label">Sound delay: {delayLabel(delay.ms)}</span>
              <FocusButton
                className="track-option"
                label={`Sound ${DELAY_STEP_MS} ms earlier`}
                onSelect={() => delay.onChange(-DELAY_STEP_MS)}
              >
                −{DELAY_STEP_MS}
              </FocusButton>
              <FocusButton
                className="track-option"
                label={`Sound ${DELAY_STEP_MS} ms later`}
                onSelect={() => delay.onChange(DELAY_STEP_MS)}
              >
                +{DELAY_STEP_MS}
              </FocusButton>
              <FocusButton
                className="track-option"
                label="No sound delay"
                onSelect={() => delay.onChange(0, true)}
              >
                0
              </FocusButton>
            </FocusGroup>
            <p className="track-note">
              For this sound device: later if the sound comes before the lips, earlier if after.
            </p>
          </>
        )}
        {level && <LevelRows {...level} />}

        <div className="track-panel-head">
          <span>Subtitles</span>
        </div>
        <FocusButton
          className={`track-option ${!subVisible ? 'active' : ''}`}
          onSelect={() => onChoose('sub', null)}
        >
          Off
        </FocusButton>
        {subTracks.map((track) => (
          <FocusButton
            key={track.id}
            className={`track-option ${subVisible && sid === track.id ? 'active' : ''}`}
            onSelect={() => onChoose('sub', track)}
          >
            <TrackText track={track} line={subLines.get(track.id)} />
          </FocusButton>
        ))}
        {online && (
          <>
            <FocusButton
              className="track-option track-online"
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
        {seconds.length > 0 && onSecond && (
          <>
            <FocusButton
              focusKey={SECOND_KEY}
              className="track-option"
              onSelect={() => setSecondOpen((open) => !open)}
            >
              {`Second subtitles, at the top: ${
                secondNow ? (languageName(secondNow.lang) ?? subLines.get(secondNow.id)) : 'None'
              } ${secondOpen ? '⌄' : '›'}`}
            </FocusButton>
            {secondOpen && (
              <>
                <FocusButton
                  className={`track-option track-second ${sid2 == null ? 'active' : ''}`}
                  onSelect={() => pickSecond(null)}
                >
                  None
                </FocusButton>
                {seconds.map((track) => (
                  <FocusButton
                    key={track.id}
                    className={`track-option track-second ${sid2 === track.id ? 'active' : ''}`}
                    onSelect={() => pickSecond(track)}
                  >
                    <TrackText track={track} line={subLines.get(track.id)} />
                  </FocusButton>
                ))}
                <p className="track-note">Text subtitles only.</p>
              </>
            )}
          </>
        )}
        <p className="track-note">Remembered for this show.</p>
        {timing && subTracks.length > 0 && (
          <>
            <FocusGroup kind="row" className="track-delay">
              <span className="track-delay-label">Timing: {subDelayLabel(timing.ms)}</span>
              {[-SUB_BIG_STEP_MS, -SUB_STEP_MS, SUB_STEP_MS, SUB_BIG_STEP_MS].map((step) => (
                <FocusButton
                  key={step}
                  className="track-option"
                  label={`Subtitles ${Math.abs(step) / 1000} s ${step < 0 ? 'earlier' : 'later'}`}
                  onSelect={() => timing.onChange(step)}
                >
                  {step < 0 ? '−' : '+'}
                  {Math.abs(step) / 1000}
                </FocusButton>
              ))}
              <FocusButton
                className="track-option"
                label="Subtitles at their own timing"
                onSelect={() => timing.onChange(0, true)}
              >
                0
              </FocusButton>
            </FocusGroup>
            <p className="track-note">
              For this file: earlier if the words come after they are said, later if before.
            </p>
          </>
        )}
        {subStyle && onSubStyle && (
          <>
            <div className="track-panel-head">
              <span>Reading them</span>
            </div>
            <FocusButton
              className="track-option"
              onSelect={() => onSubStyle({ ...subStyle, size: nextSize(subStyle.size) })}
            >
              Size: {sizeLabel(subStyle.size)}
            </FocusButton>
            <FocusButton
              className={`track-option ${subStyle.box ? 'active' : ''}`}
              onSelect={() => onSubStyle({ ...subStyle, box: !subStyle.box })}
            >
              Dark box behind: {subStyle.box ? 'On' : 'Off'}
            </FocusButton>
            <p className="track-note">
              {pictureShown
                ? 'No box on picture subtitles: they are drawn as made, and only change size.'
                : 'For this screen. Picture subtitles (Blu-ray, DVD) only change size.'}
            </p>
          </>
        )}
        <FocusButton className="track-option" onSelect={onDetails}>
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
              navFocus(ADD_KEY);
              setAdding(false);
              setAdded(message);
            }}
          />
        )}
        {added && <p className="track-note">{added}</p>}
      </aside>
    </FocusProvider>
  );
}
