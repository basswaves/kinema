/**
 * Settings → Accounts → SIMKL: connecting a SIMKL account, so what is finished
 * in Kinema is added to it.
 *
 * Signing in is SIMKL's device flow, made for exactly this screen: a code and
 * a QR code here, approval on a phone. So every control is a `FocusButton` —
 * connecting from the sofa is the point — and when the buttons change under
 * the focus ring (Connect becomes Cancel, Cancel becomes Disconnect), focus is
 * claimed for the new one rather than left on a control that is gone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import ConfirmButton from './ConfirmButton';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import { getSetting, setSetting } from '../metadata/api';
import { useClaimFocus } from './focus';
import { userError } from './errors';
import {
  countdown,
  POLL_EVERY_MS,
  qrSource,
  simklCancelConnect,
  simklDisconnect,
  simklPollConnect,
  simklStartConnect,
  simklStatus,
  SIMKL_CLIENT_ID_KEY,
  type DeviceCode,
  type SimklStatus,
} from '../metadata/simkl';

const CONNECT_KEY = 'simkl-connect';
const CANCEL_KEY = 'simkl-cancel';
const DISCONNECT_KEY = 'simkl-disconnect';

const day = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

export default function SimklSection() {
  const [status, setStatus] = useState<SimklStatus | null>(null);
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** When the code runs out, by the clock — polling stops there whatever SIMKL says. */
  const deadline = useRef(0);

  const refresh = useCallback(() => {
    simklStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(userError(e)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Leaving Settings mid-sign-in ends it: nothing should keep asking SIMKL
  // about a code nobody is looking at.
  useEffect(() => {
    return () => {
      void simklCancelConnect().catch(() => undefined);
    };
  }, []);

  // Waiting for approval: ask every couple of seconds until an answer, or
  // until the code runs out. SIMKL never says "declined" — a refusal looks
  // exactly like waiting — so the clock is what ends it.
  useEffect(() => {
    if (!code) return;
    let live = true;
    const tick = window.setInterval(() => {
      const left = (deadline.current - Date.now()) / 1000;
      setSecondsLeft(left);
      if (left <= 0) {
        setCode(null);
        setNote('The code ran out before it was approved. Connect again for a new one.');
      }
    }, 1000);
    const poll = window.setInterval(() => {
      simklPollConnect()
        .then((outcome) => {
          if (!live) return;
          switch (outcome) {
            case 'connected':
              setCode(null);
              setNote(null);
              refresh();
              break;
            case 'expired':
              setCode(null);
              setNote('The code ran out before it was approved. Connect again for a new one.');
              break;
            case 'refused':
              setCode(null);
              setError('SIMKL does not recognise this copy of Kinema. The log has the details.');
              break;
            case 'failed':
              setNote('SIMKL could not be reached just now. Still trying.');
              break;
            case 'waiting':
              break;
          }
        })
        .catch((e: unknown) => live && setError(userError(e)));
    }, POLL_EVERY_MS);
    return () => {
      live = false;
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [code, refresh]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const shown = await simklStartConnect();
      deadline.current = Date.now() + shown.expires_in * 1000;
      setSecondsLeft(shown.expires_in);
      setCode(shown);
    } catch (e) {
      setError(userError(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setCode(null);
    setNote(null);
    void simklCancelConnect().catch((e: unknown) => setError(userError(e)));
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await simklDisconnect();
      refresh();
    } catch (e) {
      setError(userError(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected ?? false;
  useClaimFocus(CANCEL_KEY, code !== null);
  useClaimFocus(DISCONNECT_KEY, connected && code === null);
  useClaimFocus(CONNECT_KEY, status !== null && !connected && code === null);

  if (!status) return null;
  const qr = qrSource(code?.qr_svg ?? null);

  return (
    <section className="settings-section">
      <h2>SIMKL</h2>
      <p className="settings-intro">
        Adds what you finish watching in Kinema to your SIMKL account, including anything you mark
        as watched. It only ever adds: nothing comes back from SIMKL, and marking something as not
        watched here leaves SIMKL as it is.
      </p>
      {error && <p className="settings-warn">{error}</p>}

      {!status.available && (
        <p className="settings-hint">
          This copy of Kinema was built without a SIMKL app ID, so it cannot connect. Released
          copies have one; a build from source can use its own, under Advanced → Developer tools.
        </p>
      )}

      {status.available && code && (
        <div className="simkl-code">
          {qr && <img className="simkl-qr" src={qr} alt="QR code for the SIMKL sign-in page" />}
          <div>
            <p className="settings-intro">
              Scan the code with your phone, or go to <strong>{code.verification_uri}</strong> and
              enter:
            </p>
            <p className="simkl-user-code">{code.user_code}</p>
            <p className="settings-hint">
              Then approve Kinema on SIMKL. This code works for {countdown(secondsLeft)} more.
            </p>
            {note && <p className="settings-hint">{note}</p>}
            <div className="settings-row">
              <FocusButton
                keepInView="nearest"
                className="btn-secondary"
                onSelect={() =>
                  void openUrl(code.verification_uri_complete).catch((e: unknown) =>
                    setError(userError(e))
                  )
                }
              >
                Open in the browser ↗
              </FocusButton>
              <FocusButton
                keepInView="nearest"
                className="btn-secondary"
                focusKey={CANCEL_KEY}
                onSelect={cancel}
              >
                Cancel
              </FocusButton>
            </div>
          </div>
        </div>
      )}

      {status.available && !code && connected && (
        <>
          <p className="settings-hint">
            {status.user ? (
              <>
                Connected as <strong>{status.user}</strong>.
              </>
            ) : (
              'Connected.'
            )}{' '}
            {status.waiting > 0
              ? `${status.waiting} watched ${status.waiting === 1 ? 'item is' : 'items are'} waiting to be sent; they go as soon as SIMKL can be reached.`
              : status.last_sent_at
                ? `Everything is sent; last on ${day(status.last_sent_at)}.`
                : 'Everything is sent.'}
          </p>
          <div className="settings-row">
            <ConfirmButton
              keepInView="nearest"
              className="btn-secondary"
              confirmLabel="Disconnect SIMKL"
              onConfirm={() => void disconnect()}
              disabled={busy}
              focusKey={DISCONNECT_KEY}
            >
              Disconnect
            </ConfirmButton>
          </div>
        </>
      )}

      {status.available && !code && !connected && (
        <>
          {status.needs_reconnect && (
            <p className="settings-warn">
              SIMKL no longer accepts Kinema's sign-in — it was ended on SIMKL, or Kinema went
              unused for six months. Connect again; what you watched meanwhile is kept and sent.
            </p>
          )}
          {note && <p className="settings-hint">{note}</p>}
          <div className="settings-row">
            <FocusButton
              keepInView="nearest"
              className="btn-primary"
              focusKey={CONNECT_KEY}
              onSelect={() => void connect()}
              disabled={busy}
            >
              {status.needs_reconnect ? 'Connect SIMKL again' : 'Connect SIMKL'}
            </FocusButton>
          </div>
          <p className="settings-hint">
            You approve on SIMKL&rsquo;s own page, on your phone or here; Kinema never sees your
            password. Everything you have already watched in Kinema is sent once when you
            connect.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Developer tools: a SIMKL app ID of one's own, for a build from source that
 * has none built in. A release never needs it. Saved as it is typed, like the
 * keys in Library.
 */
export function SimklAppIdField() {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSetting(SIMKL_CLIENT_ID_KEY)
      .then((v) => setValue(v ?? ''))
      .catch((e: unknown) => setError(userError(e)));
  }, []);

  useEffect(() => {
    if (value === null) return;
    const id = window.setTimeout(() => {
      void setSetting(SIMKL_CLIENT_ID_KEY, value.trim()).catch((e: unknown) =>
        setError(userError(e))
      );
    }, 600);
    return () => window.clearTimeout(id);
  }, [value]);

  if (value === null) return null;
  return (
    <label className="settings-field">
      <span>
        SIMKL app ID <span className="muted">(only for a build without one)</span>
      </span>
      <FocusInput
        className="settings-input"
        value={value}
        onChange={setValue}
        placeholder="From simkl.com/settings/developer"
      />
      {error && <span className="settings-warn">{error}</span>}
    </label>
  );
}
