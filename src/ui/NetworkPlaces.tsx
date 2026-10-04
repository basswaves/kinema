/**
 * The network in Kinema's own folder browser (`FolderBrowser.tsx`), where
 * Kinema opens network shares itself (capability `network_shares`, Android).
 *
 * First the servers: those Kinema keeps a sign-in for, then those that
 * announce themselves on the network (most NAS boxes do), and Type an address
 * for the rest — most Windows PCs never announce themselves; a typed one is
 * checked before anything more is asked. A server with no login asks for a
 * user name and password, kept locked on the device (share_logins.rs). Then the server's shares; a share opens in the browser
 * as a drive does, folder by folder.
 *
 * The browser owns where it is (`NetStep`) and Back; this draws each step and
 * puts the remote's ring on its first control.
 */
import { useEffect, useMemo, useState } from 'react';
import { getCurrentFocusKey, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import { userError } from './errors';
import { carryKeyboard } from './typing';
import {
  checkServer,
  findServers,
  listShares,
  saveShareLogin,
  shareLogins,
  type Place,
  type Server,
} from '../library/folders';

export type NetStep =
  | { step: 'servers' }
  | { step: 'address' }
  | { step: 'sign-in'; server: Server }
  | { step: 'shares'; server: Server };

const netKey = (i: number) => `net-item-${i}`;
const TYPE_KEY = 'net-type';

interface Props {
  step: NetStep;
  onStep: (next: NetStep) => void;
  onOpen: (place: Place) => void;
}

export default function NetworkPlaces({ step, onStep, onOpen }: Props) {
  switch (step.step) {
    case 'servers':
      return <Servers onStep={onStep} />;
    case 'address':
      return <Address onStep={onStep} />;
    case 'sign-in':
      return <SignIn server={step.server} onStep={onStep} />;
    case 'shares':
      return <Shares server={step.server} onStep={onStep} onOpen={onOpen} />;
  }
}

function Servers({ onStep }: { onStep: (next: NetStep) => void }) {
  const [kept, setKept] = useState<string[] | null>(null);
  const [found, setFound] = useState<Server[] | null>(null);

  useEffect(() => {
    let live = true;
    shareLogins()
      .then((l) => live && setKept(l.map((x) => x.server)))
      .catch(() => live && setKept([]));
    findServers()
      .then((s) => live && setFound(s))
      .catch(() => live && setFound([]));
    return () => {
      live = false;
    };
  }, []);

  // Signed in to first — they open at once — then the ones that announced
  // themselves, each server once.
  const servers = useMemo<Server[]>(
    () => [
      ...(kept ?? []).map((host) => ({ host, name: found?.find((f) => f.host === host)?.name ?? host })),
      ...(found ?? []).filter((f) => !kept?.includes(f.host)),
    ],
    [kept, found]
  );

  // The ring once the kept ones are known. Servers found later appear above
  // it; if it is still waiting on Type an address, it moves to the first of
  // them — never away from anything the person moved to.
  const ready = kept !== null;
  useEffect(() => {
    if (ready) void setFocus(servers.length > 0 ? netKey(0) : TYPE_KEY);
    // Only on arriving: `servers` grows while the network answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  const anyFound = (found?.length ?? 0) > 0;
  useEffect(() => {
    if (ready && anyFound && getCurrentFocusKey() === TYPE_KEY) void setFocus(netKey(0));
  }, [ready, anyFound]);

  return (
    <>
      <ul className="folder-list">
        {servers.map((server, i) => {
          const signedIn = kept?.includes(server.host);
          return (
            <li key={server.host}>
              <FocusButton
                focusKey={netKey(i)}
                keepInView="nearest"
                className="folder-item"
                onSelect={() => onStep({ step: signedIn ? 'shares' : 'sign-in', server })}
              >
                <span className="folder-name">{server.name}</span>
                <span className="muted">
                  {signedIn ? 'Signed in' : server.name !== server.host ? server.host : ''}
                </span>
              </FocusButton>
            </li>
          );
        })}
        <li>
          <FocusButton
            focusKey={TYPE_KEY}
            keepInView="nearest"
            className="folder-item"
            onSelect={() => onStep({ step: 'address' })}
          >
            <span className="folder-name">Type an address</span>
            <span className="muted">A computer or a NAS not listed</span>
          </FocusButton>
        </li>
      </ul>
      {found === null ? (
        <p className="muted folder-note">Looking for network drives…</p>
      ) : (
        found.length === 0 && (
          <p className="muted folder-note">
            None announced itself. Type its address instead: the NAS’s own app, or your router’s
            list of devices, shows it — such as 192.168.1.20.
          </p>
        )
      )}
    </>
  );
}

function Address({ onStep }: { onStep: (next: NetStep) => void }) {
  const [address, setAddress] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void setFocus('net-address'), []);
  // Forgiving of the forms people copy: smb://nas/films, \\nas\films.
  const host = address
    .trim()
    .replace(/^smb:/i, '')
    .replace(/^[/\\]+/, '')
    .split(/[/\\]/)[0];
  // Whether anything answers there, before a user name and password are
  // typed for it on a remote (owner, 2026-10-04).
  const next = async () => {
    if (!host || checking) return;
    setChecking(true);
    setError(null);
    try {
      await checkServer(host);
      onStep({ step: 'sign-in', server: { host, name: host } });
    } catch (e) {
      setError(userError(e));
      setChecking(false);
    }
  };
  return (
    <div className="folder-note">
      <label className="settings-field">
        <span>The computer’s or the NAS’s address, or its name</span>
        <FocusInput
          focusKey="net-address"
          className="settings-input"
          value={address}
          onChange={setAddress}
          placeholder="192.168.1.20"
          onEnter={() => void setFocus('net-next')}
        />
      </label>
      {error && <p className="leave-error">{error}</p>}
      <FocusButton focusKey="net-next" className="btn-primary" onSelect={() => void next()}>
        {checking ? 'Checking…' : 'Next'}
      </FocusButton>
    </div>
  );
}

function SignIn({ server, onStep }: { server: Server; onStep: (next: NetStep) => void }) {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void setFocus('net-user'), []);

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveShareLogin(server.host, user, password);
      onStep({ step: 'shares', server });
    } catch (e) {
      setError(userError(e));
      setBusy(false);
    }
  };

  // The fields first, then the button, then the words: the system's
  // keyboard covers the lower half of the screen while one is typed in.
  // The keyboard's Enter moves on — from the password to Connect, which it
  // leaves for the person to press once they have looked (owner, 2026-10-04).
  return (
    <div className="folder-note">
      <label className="settings-field">
        <span>User name</span>
        <FocusInput
          focusKey="net-user"
          className="settings-input"
          value={user}
          onChange={setUser}
          onEnter={() => {
            carryKeyboard();
            void setFocus('net-password');
          }}
        />
      </label>
      <div className="settings-field">
        <span>Password</span>
        <div className="folder-password">
          <FocusInput
            focusKey="net-password"
            className="settings-input"
            type={shown ? 'text' : 'password'}
            value={password}
            onChange={setPassword}
            onEnter={() => void setFocus('net-connect')}
          />
          <FocusButton className="btn-secondary" onSelect={() => setShown((s) => !s)}>
            {shown ? 'Hide' : 'Show'}
          </FocusButton>
        </div>
      </div>
      {error && <p className="leave-error">{error}</p>}
      <FocusButton focusKey="net-connect" className="btn-primary" onSelect={() => void connect()}>
        {busy ? 'Connecting…' : 'Connect'}
      </FocusButton>
      <p className="muted">
        The user name and password you use for {server.name}. Kinema keeps them locked on this
        device, and only reads from the drive.
      </p>
    </div>
  );
}

function Shares({
  server,
  onStep,
  onOpen,
}: {
  server: Server;
  onStep: (next: NetStep) => void;
  onOpen: (place: Place) => void;
}) {
  const [shares, setShares] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    let live = true;
    listShares(server.host)
      .then((s) => live && setShares(s))
      .catch((e: unknown) => {
        if (!live) return;
        const message = userError(e);
        // A kept login the server no longer takes asks again.
        if (message.includes('needs a sign-in')) onStep({ step: 'sign-in', server });
        else {
          setError(message);
          setShares([]);
        }
      });
    return () => {
      live = false;
    };
  }, [server, onStep]);

  useEffect(() => {
    if (shares) void setFocus(shares.length > 0 ? netKey(0) : 'net-share');
  }, [shares]);

  const open = (share: string) =>
    onOpen({
      path: `smb://${server.host}/${share}`,
      name: `${share} on ${server.name}`,
      removable: false,
      server,
    });

  if (!shares) return <p className="muted folder-note">Asking {server.name} for its shares…</p>;
  if (shares.length > 0) {
    return (
      <ul className="folder-list">
        {shares.map((share, i) => (
          <li key={share}>
            <FocusButton
              focusKey={netKey(i)}
              keepInView="nearest"
              className="folder-item"
              onSelect={() => open(share)}
            >
              <span className="folder-name">{share}</span>
            </FocusButton>
          </li>
        ))}
      </ul>
    );
  }
  const typedShare = typed.trim().replace(/^[/\\]+|[/\\]+$/g, '');
  return (
    <div className="folder-note">
      <label className="settings-field">
        <span>The shared folder’s name on {server.name}, such as films</span>
        <FocusInput
          focusKey="net-share"
          className="settings-input"
          value={typed}
          onChange={setTyped}
          onEnter={() => void setFocus('net-open')}
        />
      </label>
      {error && <p className="leave-error">{error}</p>}
      <FocusButton
        focusKey="net-open"
        className="btn-primary"
        onSelect={() => typedShare && open(typedShare)}
      >
        Open
      </FocusButton>
    </div>
  );
}
