/**
 * The setup page for the two extras nobody would otherwise know to add
 * (SetupPages.tsx): ffmpeg, which Kinema uses but does not include, and an
 * OMDb key of one's own, for Rotten Tomatoes scores.
 *
 * What it says about adding ffmpeg later is what the code does: without it,
 * intro analysis (detect.rs), the badges' ffprobe (probe.rs) and the picture
 * measurement (aspect.rs) each stop before storing anything, and each picks
 * its work by what is not stored yet — so the next scan, which runs at every
 * start, does what was skipped.
 *
 * Where Kinema cannot run programs (Android, `runs_programs`), ffmpeg is not
 * offered at all: nobody could install it there, and the page is the OMDb
 * key alone.
 *
 * Both fields save as they change, one write each: a setup page is left with
 * a press, and a debounce still waiting then would lose what was typed.
 */
import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { FFMPEG_PATH_KEY, ffmpegStatus, type FfmpegStatus } from '../library/api';
import { getSetting, setSetting } from '../metadata/api';
import { useCapabilities } from '../capabilities';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import { userError } from './errors';

const FFMPEG_URL = 'https://ffmpeg.org/download.html';
const OMDB_KEY_URL = 'https://www.omdbapi.com/apikey.aspx';
const OMDB_KEY = 'omdb_api_key';
/** How long the ffmpeg field rests before it is checked again. */
const CHECK_AFTER_MS = 600;

export default function ExtrasSetup({ onAnswer }: { onAnswer: () => void }) {
  const programs = Boolean(useCapabilities()?.runs_programs);
  const [loaded, setLoaded] = useState(false);
  const [ffmpegPath, setFfmpegPath] = useState('');
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  /**
   * Whether to show where ffmpeg is: once it was not found, or a path is set.
   * Kept once shown, so a path typed until it is found does not take the
   * field away from under the cursor.
   */
  const [askPath, setAskPath] = useState(false);
  const [omdbKey, setOmdbKey] = useState('');
  const [omdbSaved, setOmdbSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([getSetting(FFMPEG_PATH_KEY), getSetting(OMDB_KEY)])
      .then(([path, key]) => {
        if (!live) return;
        setFfmpegPath(path ?? '');
        setOmdbKey(key ?? '');
        setOmdbSaved(Boolean(key));
        setLoaded(true);
      })
      .catch((e) => live && setError(userError(e)));
    return () => {
      live = false;
    };
  }, []);

  // Asked at once, then again whenever the field settles: one
  // `ffmpeg -version`. At once, because the page waits for the answer.
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    // Nothing to ask where no program can run.
    if (!loaded || !programs) return;
    let live = true;
    const id = window.setTimeout(() => {
      void ffmpegStatus(ffmpegPath.trim())
        .then((status) => {
          if (!live) return;
          setFfmpeg(status);
          if (!status.available || ffmpegPath.trim()) setAskPath(true);
        })
        .catch(() => live && setFfmpeg(null))
        .finally(() => live && setChecked(true));
    }, checked ? CHECK_AFTER_MS : 0);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
    // `checked` only chooses the first delay; it is not a reason to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, ffmpegPath, programs]);

  const save = (key: string, value: string) => {
    setError(null);
    onAnswer();
    return setSetting(key, value.trim()).catch((e) => {
      setError(userError(e));
      throw e;
    });
  };

  // Nothing until ffmpeg has been asked about (or, with no ffmpeg to ask
  // about, the key read): the page lands on its first control, and that
  // depends on the answer.
  if (!(programs ? checked : loaded) && !error) return null;

  return (
    <>
      <p className="muted">
        {programs
          ? 'Two things Kinema can use but cannot bring along itself. Both are free, both can wait, and both are in Settings at any time.'
          : 'One thing Kinema can use but cannot bring along itself. It is free, it can wait, and it is in Settings at any time.'}
      </p>
      {error && <div className="settings-error">{error}</div>}

      {programs && (
      <div className="choice-row">
        <div className="choice-label">ffmpeg</div>
        <p className="choice-note">
          A free program for reading video and audio. Kinema uses it to find intros and end credits
          by listening to the episodes, and to read each file&rsquo;s picture and sound for a
          title&rsquo;s page. Without it those are skipped, and everything else works.
        </p>
        {ffmpeg && (
          <p className={ffmpeg.available ? 'settings-ok' : 'settings-warn'}>
            {ffmpeg.available
              ? `Found ffmpeg at ${ffmpeg.resolved}.`
              : 'ffmpeg is not installed, or not where Kinema looks.'}
          </p>
        )}
        {ffmpeg && !ffmpeg.available && (
          <>
            <p className="settings-hint">
              Kinema does not include it: install it yourself, now or later. The next scan, which
              runs every time Kinema starts, then does everything that was skipped.
            </p>
            <div className="settings-row">
              <FocusButton
                className="btn-secondary"
                keepInView="nearest"
                onSelect={() => void openUrl(FFMPEG_URL)}
              >
                Open the ffmpeg download page ↗
              </FocusButton>
            </div>
          </>
        )}
        {askPath && (
          <label className="settings-field">
            <span>
              Where ffmpeg is{' '}
              <span className="muted">(leave empty unless Kinema cannot find it)</span>
            </span>
            <FocusInput
              className="settings-input"
              value={ffmpegPath}
              onChange={(v) => {
                setFfmpegPath(v);
                void save(FFMPEG_PATH_KEY, v).catch(() => undefined);
              }}
              placeholder="ffmpeg"
            />
          </label>
        )}
      </div>
      )}

      <div className="choice-row">
        <div className="choice-label">Rotten Tomatoes scores</div>
        <p className="choice-note">
          A free OMDb key of your own adds Rotten Tomatoes scores to a title&rsquo;s page, and helps
          identify movies. A free key allows 1,000 lookups a day and Kinema uses at most 500, so a
          large library fills in over a few days.
        </p>
        <div className="settings-row">
          <FocusButton
            className="btn-secondary"
            keepInView="nearest"
            onSelect={() => void openUrl(OMDB_KEY_URL)}
          >
            Get a free key ↗
          </FocusButton>
        </div>
        <label className="settings-field">
          <span>Paste it here</span>
          <FocusInput
            className="settings-input"
            value={omdbKey}
            onChange={(v) => {
              setOmdbKey(v);
              setOmdbSaved(false);
              void save(OMDB_KEY, v)
                .then(() => setOmdbSaved(Boolean(v.trim())))
                .catch(() => undefined);
            }}
            type="password"
            placeholder="OMDb API key"
          />
        </label>
        {omdbSaved && <p className="settings-hint">Saved.</p>}
      </div>
    </>
  );
}
