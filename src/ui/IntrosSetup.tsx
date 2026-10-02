/**
 * The setup page about intros and credits (SetupPages.tsx).
 *
 * Kinema finds them by itself, so there is little to ask: whether to skip
 * them or be offered a button, and whether the two services that know them
 * from other viewers may be asked. That second one is here because a person
 * should hear on day one that playing an episode tells TheIntroDB and IntroDB
 * which episode it is — they are on unless switched off. One answer covers
 * both; Settings → Intro & credits has them apart.
 *
 * Skiptro, a separate program, is brought up only when its database is on
 * this PC: to anyone else it is a name they have never heard, and Settings
 * says where it goes.
 */
import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  INTRODB_APP_ENABLED_KEY,
  INTRODB_ENABLED_KEY,
  SKIPTRO_DB_PATH_KEY,
  SKIPTRO_PATH_KEY,
  skiptroFound,
} from '../library/api';
import { getSetting, setSetting } from '../metadata/api';
import ChoiceRow from './ChoiceRow';
import FocusButton from './FocusButton';
import { userError } from './errors';

/** Read by the player: 'auto' skips, anything else shows a button. */
const SKIP_MODE_KEY = 'skip_mode';

type SkipMode = 'button' | 'auto';
type Lookups = 'on' | 'off' | '';

export default function IntrosSetup({ onAnswer }: { onAnswer: () => void }) {
  const [mode, setMode] = useState<SkipMode>('button');
  const [lookups, setLookups] = useState<Lookups>('on');
  /** Whether Skiptro's database is here; null until asked. */
  const [skiptro, setSkiptro] = useState<boolean | null>(null);
  const [skiptroPath, setSkiptroPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [skip, theIntroDb, introDbApp, dbPath, path] = await Promise.all([
          getSetting(SKIP_MODE_KEY),
          getSetting(INTRODB_ENABLED_KEY),
          getSetting(INTRODB_APP_ENABLED_KEY),
          getSetting(SKIPTRO_DB_PATH_KEY),
          getSetting(SKIPTRO_PATH_KEY),
        ]);
        const found = await skiptroFound(dbPath ?? '');
        if (!live) return;
        setMode(skip === 'auto' ? 'auto' : 'button');
        // Both on unless switched off; set apart in Settings, neither is shown.
        const a = theIntroDb !== 'off';
        const b = introDbApp !== 'off';
        setLookups(a && b ? 'on' : !a && !b ? 'off' : '');
        setSkiptroPath(path ?? '');
        setSkiptro(found);
      } catch (e) {
        if (live) setError(userError(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const save = (pairs: [string, string][]) => {
    setError(null);
    onAnswer();
    void Promise.all(pairs.map(([k, v]) => setSetting(k, v))).catch((e) => setError(userError(e)));
  };

  const chooseSkiptro = async () => {
    try {
      const chosen = await open({
        multiple: false,
        filters: [{ name: 'Skiptro', extensions: ['exe'] }],
      });
      if (typeof chosen !== 'string') return;
      await setSetting(SKIPTRO_PATH_KEY, chosen);
      setSkiptroPath(chosen);
      onAnswer();
    } catch (e) {
      setError(userError(e));
    }
  };

  return (
    <>
      <p className="muted">
        Kinema finds where intros, recaps and end credits are by itself, and new episodes are
        checked after every scan. Two choices about it; both are in Settings at any time.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <ChoiceRow<SkipMode>
        label="Intros and credits"
        choices={[
          { value: 'button', label: 'Show a Skip button' },
          { value: 'auto', label: 'Skip them' },
        ]}
        value={mode}
        onChange={(v) => {
          setMode(v);
          save([[SKIP_MODE_KEY, v]]);
        }}
        note="Show a Skip button lets you choose each time. Skip them jumps straight past intros and end credits."
      />

      <ChoiceRow<Lookups>
        label="Times shared by other viewers"
        choices={[
          { value: 'on', label: 'Look them up' },
          { value: 'off', label: 'Off' },
        ]}
        value={lookups}
        onChange={(v) => {
          if (!v) return;
          setLookups(v);
          save([
            [INTRODB_ENABLED_KEY, v],
            [INTRODB_APP_ENABLED_KEY, v],
          ]);
        }}
        note="TheIntroDB and IntroDB are free collections of intro and credit times shared by viewers. Asked the first time an episode or film plays, they answer at once, and IntroDB knows where a film has a scene after its credits."
        hint="Kinema tells them only which film or episode is playing, keeps each answer for a month and never looks up your whole library. No account or key. Off, Kinema relies on what it finds itself."
      />

      {skiptro === true && (
        <div className="choice-row">
          <div className="choice-label">Skiptro</div>
          <p className="choice-note">
            Skiptro is on this PC, and Kinema already reads the intros it has found.
            {skiptroPath
              ? ' Kinema runs it after every scan that finds new episodes.'
              : ' Choose skiptro.exe (the command-line one, not Skiptro-Desktop.exe) and Kinema also runs it after every scan that finds new episodes.'}
          </p>
          {skiptroPath ? (
            <p className="settings-hint">
              Using <code>{skiptroPath}</code>.
            </p>
          ) : (
            <div className="settings-row">
              <FocusButton
                className="btn-secondary"
                keepInView="nearest"
                onSelect={() => void chooseSkiptro()}
              >
                Choose Skiptro
              </FocusButton>
            </div>
          )}
        </div>
      )}
      {skiptro === false && (
        <p className="muted">
          Already use Skiptro, a separate program that finds intros? Settings → Intro &amp; credits
          is where it goes.
        </p>
      )}
    </>
  );
}
