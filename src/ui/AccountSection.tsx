/**
 * Settings → Accounts: connecting SIMKL or Trakt, so what is finished in
 * Kinema is added to the account.
 *
 * Both sign in the same way — a code and a QR code here, approval on a phone —
 * so one panel serves both, told apart by `SERVICES`. Every control is a
 * `FocusButton`, because connecting from the sofa is the point, and when the
 * buttons change under the focus ring (Connect becomes Cancel, Cancel becomes
 * Disconnect), focus is claimed for the new one rather than left on a control
 * that is gone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import ConfirmButton from './ConfirmButton';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import { getSetting, setSetting } from '../metadata/api';
import { useClaimFocus } from './focus';
import { userError } from './errors';
import {
  accountApi,
  countdown,
  POLL_EVERY_MS,
  qrSource,
  SIMKL_CLIENT_ID_KEY,
  TRAKT_CLIENT_ID_KEY,
  TRAKT_CLIENT_SECRET_KEY,
  type AccountStatus,
  type DeviceCode,
  type Service,
} from '../metadata/tracking';

interface ServiceText {
  name: string;
  /**
   * The service's own mark, unmodified, from public/ (see NOTICE.md). Trakt's
   * is its full logo, which carries the name; SIMKL's is the "S" alone, so the
   * name is written beside it.
   */
  logo: { src: string; withName: boolean };
  /** Where its developer apps are made, for the Developer tools fields. */
  developerPage: string;
  /** Anything extra worth saying before connecting. */
  beforeConnecting?: string;
  /** Why the service might stop accepting Kinema's sign-in. */
  whyReconnect: string;
}

const SERVICES: Record<Service, ServiceText> = {
  simkl: {
    name: 'SIMKL',
    logo: { src: '/simkl.svg', withName: true },
    developerPage: 'simkl.com/settings/developer',
    whyReconnect: 'it was ended on SIMKL, or Kinema went unused for six months',
  },
  trakt: {
    name: 'Trakt',
    logo: { src: '/trakt.svg', withName: false },
    developerPage: 'app.trakt.tv/settings/apps',
    beforeConnecting:
      'A free Trakt account can be connected to only one app besides Trakt’s own. If yours is already connected to another (Kodi, Plex, a phone app), disconnect it on Trakt first, or Trakt will refuse.',
    whyReconnect: 'it was ended on Trakt, or Kinema went unused for a long time',
  },
};

const day = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

export default function AccountSection({ service }: { service: Service }) {
  const text = SERVICES[service];
  const api = useMemo(() => accountApi(service), [service]);
  const connectKey = `${service}-connect`;
  const cancelKey = `${service}-cancel`;
  const disconnectKey = `${service}-disconnect`;

  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** When the code runs out, by the clock — polling stops there whatever the service says. */
  const deadline = useRef(0);

  const refresh = useCallback(() => {
    api
      .status()
      .then(setStatus)
      .catch((e: unknown) => setError(userError(e)));
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Leaving Settings mid-sign-in ends it: nothing should keep asking about a
  // code nobody is looking at.
  useEffect(() => {
    return () => {
      void api.cancelConnect().catch(() => undefined);
    };
  }, [api]);

  // Waiting for approval: ask every couple of seconds until an answer, or
  // until the code runs out. SIMKL never says "declined" — a refusal looks
  // exactly like waiting — so the clock is what ends it there.
  useEffect(() => {
    if (!code) return;
    let live = true;
    const ranOut = 'The code ran out before it was approved. Connect again for a new one.';
    const tick = window.setInterval(() => {
      const left = (deadline.current - Date.now()) / 1000;
      setSecondsLeft(left);
      if (left <= 0) {
        setCode(null);
        setNote(ranOut);
      }
    }, 1000);
    const poll = window.setInterval(() => {
      api
        .pollConnect()
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
              setNote(ranOut);
              break;
            case 'denied':
              setCode(null);
              setNote(`Kinema was declined on ${text.name}. Connect again if that was a mistake.`);
              break;
            case 'refused':
              setCode(null);
              setError(
                `${text.name} does not recognise this copy of Kinema. The log has the details.`
              );
              break;
            case 'failed':
              setNote(`${text.name} could not be reached just now. Still trying.`);
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
  }, [code, refresh, api, text.name]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const shown = await api.startConnect();
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
    void api.cancelConnect().catch((e: unknown) => setError(userError(e)));
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnect();
      refresh();
    } catch (e) {
      setError(userError(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected ?? false;
  useClaimFocus(cancelKey, code !== null);
  useClaimFocus(disconnectKey, connected && code === null);
  useClaimFocus(connectKey, status !== null && !connected && code === null);

  if (!status) return null;
  const qr = qrSource(code?.qr_svg ?? null);

  return (
    <section className="settings-section">
      <h2 className="account-heading">
        {text.logo.withName ? (
          <>
            <img src={text.logo.src} alt="" className="account-mark" />
            {text.name}
          </>
        ) : (
          <img src={text.logo.src} alt={text.name} className="account-logo" />
        )}
      </h2>
      <p className="settings-intro">
        Adds what you finish watching in Kinema to your {text.name} account, including anything you
        mark as watched. It only ever adds: nothing comes back from {text.name}, and marking
        something as not watched here leaves {text.name} as it is.
      </p>
      {error && <p className="settings-warn">{error}</p>}

      {!status.available && (
        <p className="settings-hint">
          This copy of Kinema was built without a {text.name} app, so it cannot connect. Released
          copies have one; a build from source can use its own, under Advanced → Developer tools.
        </p>
      )}

      {status.available && code && (
        <div className="simkl-code">
          {qr && (
            <img
              className="simkl-qr"
              src={qr}
              alt={`QR code for the ${text.name} sign-in page`}
            />
          )}
          <div>
            <p className="settings-intro">
              Scan the code with your phone, or go to <strong>{code.verification_uri}</strong> and
              enter:
            </p>
            <p className="simkl-user-code">{code.user_code}</p>
            <p className="settings-hint">
              Then approve Kinema on {text.name}. This code works for {countdown(secondsLeft)}{' '}
              more.
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
                focusKey={cancelKey}
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
              ? `${status.waiting} watched ${status.waiting === 1 ? 'item is' : 'items are'} waiting to be sent; they go as soon as ${text.name} can be reached.`
              : status.last_sent_at
                ? `Everything is sent; last on ${day(status.last_sent_at)}.`
                : 'Everything is sent.'}
          </p>
          <div className="settings-row">
            <ConfirmButton
              keepInView="nearest"
              className="btn-secondary"
              confirmLabel={`Disconnect ${text.name}`}
              onConfirm={() => void disconnect()}
              disabled={busy}
              focusKey={disconnectKey}
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
              {text.name} no longer accepts Kinema&rsquo;s sign-in — {text.whyReconnect}. Connect
              again; what you watched meanwhile is kept and sent.
            </p>
          )}
          {note && <p className="settings-hint">{note}</p>}
          <div className="settings-row">
            <FocusButton
              keepInView="nearest"
              className="btn-primary"
              focusKey={connectKey}
              onSelect={() => void connect()}
              disabled={busy}
            >
              {status.needs_reconnect ? `Connect ${text.name} again` : `Connect ${text.name}`}
            </FocusButton>
          </div>
          <p className="settings-hint">
            You approve on {text.name}&rsquo;s own page, on your phone or here; Kinema never sees
            your password. Everything you have already watched in Kinema is sent once when you
            connect
            {service === 'trakt' ? ', leaving out what Trakt already has' : ''}.
          </p>
          {text.beforeConnecting && <p className="settings-hint">{text.beforeConnecting}</p>}
        </>
      )}
    </section>
  );
}

/**
 * Developer tools: one text field saved as it is typed, like the keys in
 * Library. For the apps of one's own that a build from source needs.
 */
function SettingField({
  settingKey,
  label,
  placeholder,
  secret = false,
}: {
  settingKey: string;
  label: string;
  placeholder: string;
  secret?: boolean;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSetting(settingKey)
      .then((v) => setValue(v ?? ''))
      .catch((e: unknown) => setError(userError(e)));
  }, [settingKey]);

  useEffect(() => {
    if (value === null) return;
    const id = window.setTimeout(() => {
      void setSetting(settingKey, value.trim()).catch((e: unknown) => setError(userError(e)));
    }, 600);
    return () => window.clearTimeout(id);
  }, [value, settingKey]);

  if (value === null) return null;
  return (
    <label className="settings-field">
      <span>
        {label} <span className="muted">(only for a build without one)</span>
      </span>
      <FocusInput
        className="settings-input"
        value={value}
        onChange={setValue}
        placeholder={placeholder}
        type={secret ? 'password' : undefined}
      />
      {error && <span className="settings-warn">{error}</span>}
    </label>
  );
}

/** Developer tools: the SIMKL and Trakt apps of one's own. */
export function AccountAppFields() {
  return (
    <>
      <SettingField
        settingKey={SIMKL_CLIENT_ID_KEY}
        label="SIMKL app ID"
        placeholder={`From ${SERVICES.simkl.developerPage}`}
      />
      <SettingField
        settingKey={TRAKT_CLIENT_ID_KEY}
        label="Trakt client ID"
        placeholder={`From ${SERVICES.trakt.developerPage}`}
      />
      <SettingField
        settingKey={TRAKT_CLIENT_SECRET_KEY}
        label="Trakt client secret"
        placeholder="Used with the client ID above"
        secret
      />
    </>
  );
}
