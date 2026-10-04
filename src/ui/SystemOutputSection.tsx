/**
 * Settings → Picture & sound where the system does most of it (capabilities
 * `system_output`, Android): one switch, matching the screen to the film,
 * on unless switched off — and what the system does by itself, said plainly:
 * what the TV and the receiver report taking, and what the player did with
 * the last film's sound (`player/systemOutput.ts`). Only what is known.
 *
 * Nothing here is per device and nothing is asked at the first run (owner,
 * 2026-10-04): a TV box is always at its TV.
 */
import { useEffect, useState } from 'react';
import { getSetting, setSetting } from '../metadata/api';
import { systemOutput } from '../player/engine';
import {
  DISPLAY_MATCH_KEY,
  lastSoundNote,
  matchNote,
  matchOn,
  pictureNote,
  soundNote,
  type SystemOutput,
} from '../player/systemOutput';
import ChoiceRow from './ChoiceRow';
import { userError } from './errors';

/** '' until the stored answer has been read. */
type Match = 'on' | 'off' | '';

export default function SystemOutputSection({
  onError,
  system,
}: {
  onError: (message: string) => void;
  system: string;
}) {
  const [match, setMatch] = useState<Match>('');
  const [output, setOutput] = useState<SystemOutput | null>(null);

  useEffect(() => {
    let live = true;
    void getSetting(DISPLAY_MATCH_KEY)
      .then((v) => live && setMatch(matchOn(v) ? 'on' : 'off'))
      .catch((e) => onError(userError(e)));
    void systemOutput()
      .then((o) => {
        // In app.log, so a report from any box says what it said here.
        console.log('picture & sound: the system reports', o);
        if (live) setOutput(o);
      })
      .catch((e) => console.warn('picture & sound: the system did not say what it takes', e));
    return () => {
      live = false;
    };
  }, [onError]);

  const last = lastSoundNote(output);

  const choose = (v: Match) => {
    if (!v) return;
    setMatch(v);
    void setSetting(DISPLAY_MATCH_KEY, v).catch((e) => onError(userError(e)));
  };

  return (
    <section className="settings-section">
      <h2>Picture &amp; sound</h2>
      {/* Above the switch, not under it: with nothing to land on below, a
          remote never scrolled down to them on a TV. */}
      <p className="settings-intro">
        <strong>HDR.</strong> {pictureNote(output, system)}
      </p>
      <p className="settings-intro">
        <strong>Sound.</strong> {soundNote(output, system)}
      </p>
      {last && <p className="settings-intro">{last}</p>}
      <ChoiceRow<Match>
        label="Match the screen to the film"
        choices={[
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
        value={match}
        onChange={choose}
        note="Camera pans glide instead of stuttering: the screen runs at the film’s own frame rate, and at a higher resolution only if the film has more pixels than the screen is set to."
        hint={
          matchNote(output) ??
          'The screen goes black for a second or two as a film starts and after it ends, while the TV catches up.'
        }
      />
    </section>
  );
}
