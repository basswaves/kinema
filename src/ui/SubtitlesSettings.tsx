/**
 * Settings for subtitles found online, and for forced subtitles.
 *
 * - `ForcedSubtitleRows`, in Language & subtitles: whether forced subtitles show with
 *   subtitles off (on by default), and whether Kinema fetches them from
 *   OpenSubtitles for a file with none (off by default) — decided 2026-09-30.
 * - `SubtitleStyleRows`, in Language & subtitles: how big subtitles are drawn
 *   and a dark box behind them, for the screen Kinema is on (subtitleStyle.ts);
 *   the player's subtitle panel has the same two.
 * - `OpenSubtitlesSection`, under them: an optional OpenSubtitles account,
 *   for 20 downloads a day instead of 5. OpenSubtitles has no phone approval,
 *   so this is the one place Kinema asks for a password; it is kept encrypted
 *   to the Windows user (opensubtitles.rs), so Kinema can sign in again when
 *   the day's sign-in runs out.
 */
import { useCallback, useEffect, useState } from 'react';
import ChoiceRow from './ChoiceRow';
import ConfirmButton from './ConfirmButton';
import FocusButton from './FocusButton';
import FocusGroup from './FocusGroup';
import FocusInput from './FocusInput';
import { userError } from './errors';
import { useClaim } from './focusStore';
import { getSetting, setSetting } from '../metadata/api';
import { useCapabilities } from '../capabilities';
import { DESCRIPTION_KEY, FORCED_KEY, SDH_KEY } from '../player/trackChoice';
import { screenHere } from '../player/displaySwitch';
import {
  readSubStyle,
  saveSubStyle,
  SUB_SIZES,
  type SubSize,
  type SubStyle,
} from '../player/subtitleStyle';
import {
  AUTO_FORCED_KEY,
  signInOpenSubtitles,
  signOutOpenSubtitles,
  subtitleStatus,
  type SubtitleStatus,
} from '../player/onlineSubtitles';

/**
 * Subtitle size and the box behind them, for the screen this window is on.
 * Readability — the distance to the screen and the eyes watching — never a
 * look to pick (HISTORY, round 5). Media3 draws Android's captions itself.
 */
export function SubtitleStyleRows({ onError }: { onError: (message: string) => void }) {
  const caps = useCapabilities();
  const [screen, setScreen] = useState<{ id: string | null; name: string | null } | null>(null);
  const [style, setStyle] = useState<SubStyle | null>(null);
  const desktop = caps?.engine !== 'media3';

  useEffect(() => {
    if (!desktop) return;
    void (async () => {
      const here = await screenHere();
      setScreen(here);
      setStyle(await readSubStyle(here.id));
    })();
  }, [desktop]);

  if (!desktop) {
    return (
      <p className="settings-hint">
        Subtitle size and a dark box behind them are on computers only for now.
      </p>
    );
  }
  if (!style || !screen) return null;
  const change = (next: SubStyle) => {
    setStyle(next);
    void saveSubStyle(screen.id, next).catch((e) => onError(userError(e)));
  };
  const where = screen.name ? `on ${screen.name}` : 'on this screen';
  return (
    <>
      <ChoiceRow
        label="Subtitle size"
        choices={SUB_SIZES.map((s) => ({ value: s.id, label: s.label }))}
        value={style.size}
        onChange={(v) => change({ ...style, size: v as SubSize })}
        note={`How big subtitles are drawn ${where} — for the distance you sit from it and the eyes watching. Each screen keeps its own; the player's Audio & subtitles panel changes it too.`}
        hint="Picture subtitles (Blu-ray, DVD) are drawn pictures: they only change size. Subtitles with their own styling keep their look."
      />
      <ChoiceRow
        label="Dark box behind subtitles"
        choices={[
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ]}
        value={style.box ? 'on' : 'off'}
        onChange={(v) => change({ ...style, box: v === 'on' })}
        note="A dark box behind each line, so white text stays readable on a bright picture. Also for forced subtitles and those from OpenSubtitles."
        hint="Text subtitles only: picture subtitles carry their own background, and subtitles with their own styling keep it."
      />
    </>
  );
}

/**
 * Audio description and subtitles for the deaf and hard of hearing: needs of
 * the person watching, applied to every title as the languages are
 * (trackChoice.ts). Off by default — the plain track, as before.
 */
export function AccessibleTrackRows({ onError }: { onError: (message: string) => void }) {
  const [description, setDescription] = useState<boolean | null>(null);
  const [sdh, setSdh] = useState(false);

  useEffect(() => {
    void (async () => {
      setSdh((await getSetting(SDH_KEY).catch(() => null)) === 'on');
      setDescription((await getSetting(DESCRIPTION_KEY).catch(() => null)) === 'on');
    })();
  }, []);

  if (description === null) return null;
  const save = (key: string, on: boolean) =>
    void setSetting(key, on ? 'on' : 'off').catch((e) => onError(userError(e)));
  return (
    <>
      <ChoiceRow
        label="Audio description"
        choices={[
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'When the file has it' },
        ]}
        value={description ? 'on' : 'off'}
        onChange={(v) => {
          setDescription(v === 'on');
          save(DESCRIPTION_KEY, v === 'on');
        }}
        note="A narrator saying what happens on screen, for people who cannot see it. Chosen in the audio language you watch in, where the file has such a track — marked as one, or named Audio Description."
        hint="Off leaves it out even where a file opens with it. A choice made in the player is kept for that title."
      />
      <ChoiceRow
        label="Subtitles for the deaf and hard of hearing"
        choices={[
          { value: 'off', label: 'Plain ones first' },
          { value: 'on', label: 'These first' },
        ]}
        value={sdh ? 'on' : 'off'}
        onChange={(v) => {
          setSdh(v === 'on');
          save(SDH_KEY, v === 'on');
        }}
        note="Subtitles that also say who is speaking and what can be heard — [door slams], music. Where a file has both kinds in your language, these are chosen first."
        hint="Marked SDH or CC by the file or in its name."
      />
    </>
  );
}

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
          hint="Each one found uses one of the day's OpenSubtitles downloads (5 without an account, 20 with one — see below). Most films have no forced parts, and those cost nothing."
        />
      )}
    </>
  );
}

const SIGN_OUT_KEY = 'opensubtitles-sign-out';
const SIGN_IN_KEY = 'opensubtitles-sign-in';

export function OpenSubtitlesSection() {
  const can = useCapabilities();
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
  useClaim(SIGN_OUT_KEY, signedIn);
  useClaim(SIGN_IN_KEY, Boolean(status?.available) && !signedIn);

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
          <FocusGroup kind="row" className="settings-row">
            <ConfirmButton
             
              className="btn-secondary"
              confirmLabel="Sign out of OpenSubtitles"
              onConfirm={() => void signOut()}
              disabled={busy}
              focusKey={SIGN_OUT_KEY}
            >
              Sign out
            </ConfirmButton>
          </FocusGroup>
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
          <FocusGroup kind="row" className="settings-row">
            <FocusButton
             
              className="btn-primary"
              focusKey={SIGN_IN_KEY}
              onSelect={() => void signIn()}
              disabled={busy || !username.trim() || !password}
            >
              Sign in
            </FocusButton>
          </FocusGroup>
          <p className="settings-hint">
            OpenSubtitles has no way to approve Kinema from a phone, so the password is typed
            here.{' '}
            {/* Windows encrypts it to the user (DPAPI); elsewhere it sits in Kinema's
                data folder, which only the user's account can open (util.rs →
                keep_private). Said as it is (CLAUDE.md → OpenSubtitles). */}
            {can?.system === 'Windows' || !can
              ? 'Kinema keeps it encrypted to your Windows user'
              : 'Kinema keeps it in its own data folder, which only your account can open,'}{' '}
            and sends it only to OpenSubtitles, to sign in again each day.
          </p>
        </>
      )}
      {/* Attribution they ask for. */}
      <p className="settings-hint">Subtitles from OpenSubtitles.com.</p>
    </section>
  );
}
