/**
 * What a brand-new library looks like.
 *
 * This replaces a single sentence that said "Add a folder in Settings" and then
 * left the user to find Settings, find the right section among eight, and work
 * out on their own that a TMDB key exists at all. That sentence named a
 * destination without being one, which on a first run is the difference between
 * an app that works and an app that appears not to.
 *
 * So the two things a new library actually needs are *here*, as controls, in
 * the order they matter: a folder, then a key. Everything else the app decides
 * or discovers by itself, and none of it is worth a step.
 *
 * It is deliberately not a wizard that must be completed. Adding a folder is
 * enough to get a working library, the key can wait, and both are editable
 * afterwards in Settings — so nothing here is a gate, and there is no way to
 * get stuck part-way through.
 *
 * A released build carries Kinema's own TMDB key (builtinKey.ts), and there
 * the key step is gone: a folder is the one thing left to ask. A build from
 * source has no key, and keeps the step, since without it movies stay
 * unidentified.
 *
 * Two more steps since 2026-10-02, both answered in a press: where Kinema
 * will be watched (TV mode — big text and full screen, which screen
 * switching needs), asked first so the rest is already readable from a sofa;
 * and picture and sound (`PictureSoundSetup.tsx`), which can be skipped and
 * then changes nothing.
 */
import { describeError, userError } from './errors';
import { useFocusable, FocusContext, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import ChoiceRow from './ChoiceRow';
import PictureSoundSetup from './PictureSoundSetup';
import { setTvMode, TV_MODE_KEY } from './tv';
import { useClaimFocus } from './focus';
import { addLibraryRoot, listLibraryRoots, type LibraryKind, type LibraryRoot } from '../library/api';
import { runScanPipeline, useScanStatus } from '../library/pipeline';
import { getSetting, setSetting } from '../metadata/api';
import { BUILTIN_TMDB_KEY } from '../metadata/builtinKey';

/** Where TMDB hands out a free key. Linked rather than described. */
const TMDB_KEY_URL = 'https://www.themoviedb.org/settings/api';

const FIRST_RUN_FOCUS_KEY = 'first-run';
const SCAN_FOCUS_KEY = 'first-run-scan';
const ADD_MOVIES_FOCUS_KEY = 'first-run-add-movies';

type Seat = 'tv' | 'desk' | '';

/** Whether to ask for a TMDB key at all: only a build without one of its own. */
const ASK_FOR_KEY = !BUILTIN_TMDB_KEY;

interface Props {
  /** Re-read the library. Called after a scan finishes. */
  onDone: () => void;
}

export default function FirstRun({ onDone }: Props) {
  const { ref, focusKey } = useFocusable({
    focusKey: FIRST_RUN_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  useClaimFocus(FIRST_RUN_FOCUS_KEY, true);

  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [tmdbKey, setTmdbKey] = useState('');
  const [savedKey, setSavedKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seat, setSeat] = useState<Seat>('');
  const [skipped, setSkipped] = useState(false);
  const scan = useScanStatus();

  useEffect(() => {
    void (async () => {
      try {
        const [list, key, tv] = await Promise.all([
          listLibraryRoots(),
          getSetting('tmdb_api_key'),
          getSetting(TV_MODE_KEY),
        ]);
        setRoots(list);
        // Asked, not assumed: an answer only once one has been given.
        setSeat(tv === 'on' ? 'tv' : tv === 'off' ? 'desk' : '');
        if (key) {
          setTmdbKey(key);
          setSavedKey(true);
        }
      } catch (e) {
        setError(userError(e));
      }
    })();
  }, []);

  const pickFolder = useCallback(async (kind: LibraryKind) => {
    setError(null);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected !== 'string') return;
      await addLibraryRoot(selected, kind);
      setRoots(await listLibraryRoots());
    } catch (e) {
      setError(userError(e));
    }
  }, []);

  const saveKey = useCallback(async () => {
    setError(null);
    try {
      await setSetting('tmdb_api_key', tmdbKey.trim());
      setSavedKey(tmdbKey.trim().length > 0);
    } catch (e) {
      setError(userError(e));
    }
  }, [tmdbKey]);

  /**
   * Save the key first, then scan. Typing a key and pressing the scan button
   * without leaving the field is the obvious way to use this panel, and it
   * would otherwise match everything with no key at all.
   */
  const scanNow = useCallback(async () => {
    setError(null);
    if (tmdbKey.trim()) await saveKey();
    const outcome = await runScanPipeline();
    if (outcome.status === 'failed') setError(describeError(outcome.error));
    onDone();
  }, [onDone, saveKey, tmdbKey]);

  const hasRoots = roots.length > 0;

  const chooseSeat = useCallback((next: Seat) => {
    setSeat(next);
    if (next) setTvMode(next === 'tv');
  }, []);

  // Skipping removes the button that was pressed: the ring goes on to what
  // comes next, never to nothing.
  const skip = useCallback(() => {
    setSkipped(true);
    window.setTimeout(() => void setFocus(hasRoots ? SCAN_FOCUS_KEY : ADD_MOVIES_FOCUS_KEY), 0);
  }, [hasRoots]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="first-run" ref={ref}>
        <h1>Welcome to Kinema</h1>
        <p className="first-run-lede">
          A few questions, then Kinema does the rest: posters, descriptions and all. Every answer
          can be changed later in Settings.
        </p>

        {error && (
          <div className="settings-error" onClick={() => setError(null)}>
            {error}
          </div>
        )}

        <section className="first-run-step">
          <h2>
            <span className="first-run-num">1</span> Where will you watch?
          </h2>
          <ChoiceRow<Seat>
            label="This PC is for"
            choices={[
              { value: 'tv', label: 'A TV, from the sofa' },
              { value: 'desk', label: 'A desk' },
            ]}
            value={seat}
            onChange={chooseSeat}
            note="On a TV, Kinema fills the screen with bigger text, made for a remote. At a desk it is a window like any other program."
          />
        </section>

        <section className="first-run-step">
          <h2>
            <span className="first-run-num">2</span> Where are your movies and shows?
          </h2>
          <p className="muted">
            Pick the folder you keep them in. A local drive or a network share both work.
            Nothing is moved, renamed or written to; the files are only read.
          </p>
          <div className="settings-row">
            <FocusButton
              className="btn-primary"
              focusKey={ADD_MOVIES_FOCUS_KEY}
              onSelect={() => void pickFolder('movies')}
            >
              Add movies folder
            </FocusButton>
            <FocusButton className="btn-primary" onSelect={() => void pickFolder('tv')}>
              Add TV folder
            </FocusButton>
          </div>
          {hasRoots && (
            <ul className="first-run-roots">
              {roots.map((root) => (
                <li key={root.id}>
                  <span className={`root-kind ${root.kind}`}>
                    {root.kind === 'tv' ? 'TV' : 'Movies'}
                  </span>
                  <span className="root-path">{root.path}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {ASK_FOR_KEY && (
          <section className="first-run-step">
            <h2>
              <span className="first-run-num">3</span> Posters and descriptions{' '}
              <span className="first-run-optional">optional</span>
            </h2>
            <p className="muted">
              Everything is identified without it, but only a key from TMDB brings posters,
              backdrops and artwork for movies. It is free, and takes about two minutes to get.
            </p>
            <div className="settings-row">
              <FocusButton className="btn-secondary" onSelect={() => void openUrl(TMDB_KEY_URL)}>
                Get a free key ↗
              </FocusButton>
            </div>
            <label className="settings-field">
              <span>Paste it here</span>
              <FocusInput
                className="settings-input"
                value={tmdbKey}
                onChange={(v) => {
                  setTmdbKey(v);
                  setSavedKey(false);
                }}
                onEnter={() => void saveKey()}
                type="password"
                placeholder="TMDB API key"
              />
            </label>
            <div className="settings-row">
              <FocusButton className="btn-secondary" onSelect={() => void saveKey()}>
                Save key
              </FocusButton>
              {savedKey && <span className="muted">Saved.</span>}
            </div>
          </section>
        )}

        {skipped ? (
          <p className="muted first-run-skipped">
            Picture and sound left as they are. It is all in Settings → Picture &amp; sound.
          </p>
        ) : (
          <PictureSoundSetup num={ASK_FOR_KEY ? 4 : 3} onSkip={skip} />
        )}

        <section className="first-run-step">
          <div className="settings-row">
            <FocusButton
              className="btn-primary"
              focusKey={SCAN_FOCUS_KEY}
              disabled={!hasRoots || scan !== null}
              onSelect={() => void scanNow()}
            >
              {scan ? `${scan.stage}…` : 'Scan my library'}
            </FocusButton>
            <span className="muted">
              {hasRoots
                ? 'This can take a few minutes the first time. You can watch it fill in.'
                : 'Add a folder above first.'}
            </span>
          </div>
        </section>
      </div>
    </FocusContext.Provider>
  );
}
