/**
 * Settings for subtitles found online, and for forced subtitles.
 *
 * - `ForcedSubtitleRows`, in Playback: whether forced subtitles show with
 *   subtitles off (on by default), and whether Kinema fetches them from
 *   OpenSubtitles for a file with none (off by default) — decided 2026-09-30.
 * - `OpenSubtitlesSection`, in Accounts: an optional OpenSubtitles account,
 *   for 20 downloads a day instead of 5. OpenSubtitles has no phone approval,
 *   so this is the one place Kinema asks for a password; it is kept encrypted
 *   to the Windows user (opensubtitles.rs), so Kinema can sign in again when
 *   the day's sign-in runs out.
 */
import { useCallback, useEffect, useState } from 'react';
import ChoiceRow from './ChoiceRow';
import ConfirmButton from './ConfirmButton';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import { userError } from './errors';
import { useClaimFocus } from './focus';
import { getSetting, setSetting } from '../metadata/api';
import { FORCED_KEY } from '../player/trackChoice';
import {
  AUTO_FORCED_KEY,
  signInOpenSubtitles,
  signOutOpenSubtitles,
  subtitleStatus,
  type SubtitleStatus,
} from '../player/onlineSubtitles';

export function ForcedSubtitleRows({ onError }: { onError: (message: string) => void }) {
  const [show, setShow] = useState<boolean | null>(null);
  const [fetch, setFetch] = useState(false);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    void (async () => {
      setShow((await getSetting(FORCED_KEY).catch(() => null)) !== 'off');
      setFetch((await getSetting(AUTO_FORCED_KEY).catch(() => null)) === 'on');
      setAvailable((await subtitleStatus().catch(() => null))?.available ?? false);
    })();
  }, []);

  if (show === null) return null;
  return (
    <>
      <ChoiceRow
        label="Forced subtitles"
        choices={[
          { value: 'on', label: 'Show them' },
          { value: 'off', label: 'Off' },
        ]}
        value={show ? 'on' : 'off'}
        onChange={(v) => {
          setShow(v === 'on');
          void setSetting(FORCED_KEY, v).catch((e) => onError(userError(e)));
        }}
        note="Forced subtitles are the few lines for what is said in another language — an alien, a phone call abroad. They show in the language being spoken, even with subtitles off, as on a disc."
        hint="When the file has a forced track. Full subtitles, when they are on, cover those lines anyway."
      />
      {available && (
        <ChoiceRow
          label="When a file has no forced subtitles, find them online"
          choices={[
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' },
          ]}
          value={fetch ? 'on' : 'off'}
          onChange={(v) => {
            setFetch(v === 'on');
            void setSetting(AUTO_FORCED_KEY, v).catch((e) => onError(userError(e)));
          }}
          note="Kinema asks OpenSubtitles for forced subtitles as a film or episode starts, if the file has none, and shows them. A file is asked about once; what is found is kept."
          hint="Each one found uses one of the day's OpenSubtitles downloads (5 without an account, 20 with one — see Accounts). Most films have no forced parts, and those cost nothing."
        />
      )}
    </>
  );
}

const SIGN_OUT_KEY = 'opensubtitles-sign-out';
const SIGN_IN_KEY = 'opensubtitles-sign-in';

export function OpenSubtitlesSection() {
  const [status, setStatus] = useState<SubtitleStatus | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    subtitleStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(userError(e)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInOpenSubtitles(username, password);
      setPassword('');
      refresh();
    } catch (e) {
      setError(userError(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await signOutOpenSubtitles();
      refresh();
    } catch (e) {
      setError(userError(e));
    } finally {
      setBusy(false);
    }
  };

  // The form and the Sign out button replace each other under the focus
  // ring; focus follows to whichever is there now.
  const signedIn = Boolean(status?.available && status.user);
  useClaimFocus(SIGN_OUT_KEY, signedIn);
  useClaimFocus(SIGN_IN_KEY, Boolean(status?.available) && !signedIn);

  if (!status) return null;
  const allowance =
    status.remaining !== null
      ? `${status.remaining} download${status.remaining === 1 ? '' : 's'} left today.`
      : null;

  return (
    <section className="settings-section">
      <h2>OpenSubtitles</h2>
      <p className="settings-intro">
        Where &ldquo;Find subtitles online&rdquo; in the player looks, and forced subtitles come
        from when Kinema is set to find them. It works without an account — 5 downloads a day —
        and with a free OpenSubtitles account, 20.
      </p>
      {error && <p className="settings-warn">{error}</p>}

      {!status.available && (
        <p className="settings-hint">
          This copy of Kinema was built without an OpenSubtitles app key, so it cannot search.
        </p>
      )}

      {status.available && status.user && (
        <>
          <p className="settings-hint">
            Signed in as <strong>{status.user}</strong>. {allowance}
          </p>
          <div className="settings-row">
            <ConfirmButton
              keepInView="nearest"
              className="btn-secondary"
              confirmLabel="Sign out of OpenSubtitles"
              onConfirm={() => void signOut()}
              disabled={busy}
              focusKey={SIGN_OUT_KEY}
            >
              Sign out
            </ConfirmButton>
          </div>
        </>
      )}

      {status.available && !status.user && (
        <>
          {allowance && <p className="settings-hint">Without an account: {allowance}</p>}
          <label className="settings-field">
            <span>OpenSubtitles username</span>
            <FocusInput
              className="settings-input"
              value={username}
              onChange={setUsername}
              placeholder="The username, not the email address"
            />
          </label>
          <label className="settings-field">
            <span>Password</span>
            {/* Masked: this screen is often on a TV in a room with people. */}
            <FocusInput
              className="settings-input"
              value={password}
              onChange={setPassword}
              type="password"
              placeholder="Your OpenSubtitles password"
            />
          </label>
          <div className="settings-row">
            <FocusButton
              keepInView="nearest"
              className="btn-primary"
              focusKey={SIGN_IN_KEY}
              onSelect={() => void signIn()}
              disabled={busy || !username.trim() || !password}
            >
              Sign in
            </FocusButton>
          </div>
          <p className="settings-hint">
            OpenSubtitles has no way to approve Kinema from a phone, so the password is typed
            here. Kinema keeps it encrypted to your Windows user, and sends it only to
            OpenSubtitles, to sign in again each day.
          </p>
        </>
      )}
      {/* Attribution they ask for. */}
      <p className="settings-hint">Subtitles from OpenSubtitles.com.</p>
    </section>
  );
}
