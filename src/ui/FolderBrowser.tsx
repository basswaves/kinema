/**
 * Kinema's own folder browser, where the system has no folder picker
 * (`library/folders.ts`): on Android, a USB drive or the device's own storage,
 * then the folders inside, chosen with a remote, a mouse or a keyboard.
 *
 * It starts with the drives. OK goes into a folder; Use this folder, at the
 * top, chooses the one shown; Back — or Up a folder, for a mouse — goes up a
 * level, and from the drives closes without choosing, as Cancel does. Each folder says how many videos sit directly in
 * it, which is what tells a library folder from the rest at a glance.
 *
 * Where Kinema opens network shares itself (capability `network_shares`),
 * Network drives, after the drives, leads to the servers and their shares
 * (`NetworkPlaces.tsx`); a share then opens folder by folder as a drive does,
 * and Back from its top goes back to the server's shares.
 *
 * Reading the drives needs Android's permission. It is asked for when the
 * browser opens, in Android's own words; refused, the browser says where it
 * is granted instead. Subtitle and .nfo files beside the films need All files
 * access on Android 11 and later — offered here, never required: the films
 * play without it (owner, 2026-10-04).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FocusContext,
  getCurrentFocusKey,
  setFocus,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation';
import FocusButton from './FocusButton';
import NetworkPlaces, { type NetStep } from './NetworkPlaces';
import { userError } from './errors';
import { useCapabilities } from '../capabilities';
import {
  allowAllFiles,
  listFolders,
  requestStorageAccess,
  storageAccess,
  storagePlaces,
  type Access,
  type FolderRequest,
  type Listing,
  type Place,
} from '../library/folders';

const USE_KEY = 'folder-use';
const RETRY_KEY = 'folder-retry';
const itemKey = (i: number) => `folder-item-${i}`;

/** Where the browser is: a drive, and the folders below it. */
interface Spot {
  place: Place;
  /** Folder names below the drive's own folder, outermost first. */
  trail: string[];
}

const join = (spot: Spot) => [spot.place.path, ...spot.trail].join('/');

const videos = (n: number) => (n === 1 ? '1 video' : `${n} videos`);

export default function FolderBrowser({ request }: { request: FolderRequest }) {
  // A boundary, so the arrows cannot wander onto the page behind.
  const { ref, focusKey } = useFocusable({ isFocusBoundary: true, trackChildren: true });
  const [access, setAccess] = useState<Access | null>(null);
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** In the network part, and where in it; null among the drives. */
  const [net, setNet] = useState<NetStep | null>(null);
  const networkShares = useCapabilities()?.network_shares ?? false;
  /** Where the ring goes once the next level is shown. */
  const landOn = useRef<string | null>(null);

  // Where the ring was before, to put it back on the way out.
  const returnTo = useRef<string | null>(null);
  useEffect(() => {
    returnTo.current = getCurrentFocusKey();
  }, []);

  const finish = useCallback(
    (path: string | null) => {
      if (returnTo.current) void setFocus(returnTo.current);
      request.answer(path);
    },
    [request]
  );

  const loadPlaces = useCallback(async () => {
    setError(null);
    try {
      setPlaces(await storagePlaces());
    } catch (e) {
      setError(userError(e));
      setPlaces([]);
    }
  }, []);

  // Permission first, in Android's own dialog; then the drives.
  const ask = useCallback(async () => {
    setError(null);
    try {
      const now = await requestStorageAccess();
      setAccess(now);
      if (now.read === 'granted') await loadPlaces();
    } catch (e) {
      setError(userError(e));
    }
  }, [loadPlaces]);

  useEffect(() => {
    void (async () => {
      try {
        const now = await storageAccess();
        if (now.read === 'granted') {
          setAccess(now);
          await loadPlaces();
        } else {
          await ask();
        }
      } catch (e) {
        setError(userError(e));
      }
    })();
  }, [ask, loadPlaces]);

  /** Somewhere else: what was shown goes at once, the new contents follow. */
  const go = useCallback((next: Spot | null) => {
    setListing(null);
    setError(null);
    setSpot(next);
  }, []);

  // A folder's contents, whenever the browser moves into one.
  useEffect(() => {
    if (!spot) return;
    let live = true;
    listFolders(join(spot))
      .then((l) => live && setListing(l))
      .catch((e: unknown) => {
        if (!live) return;
        setError(userError(e));
        setListing({ folders: [], videos: 0 });
      });
    return () => {
      live = false;
    };
  }, [spot]);

  // The ring onto the new level once it is drawn: the folder come back out
  // of, else the first entry, else Use this folder or the retry button.
  const items = useMemo(
    () => (spot ? listing?.folders : places?.map((p) => p.name)),
    [spot, listing, places]
  );
  useEffect(() => {
    if (!items) return;
    const target =
      landOn.current && items.includes(landOn.current)
        ? itemKey(items.indexOf(landOn.current))
        : items.length > 0
          ? itemKey(0)
          : spot
            ? USE_KEY
            : RETRY_KEY;
    landOn.current = null;
    void setFocus(target);
  }, [items, spot]);
  // Refused: the ring on Ask again, the one thing to do.
  const refused = access?.read === 'prompt';
  useEffect(() => {
    if (refused) void setFocus(RETRY_KEY);
  }, [refused]);

  // Back from the network to the drives: the ring on Network drives.
  const backFromNet = useRef(false);
  useEffect(() => {
    if (!net && !spot && places && backFromNet.current) {
      backFromNet.current = false;
      void setFocus(itemKey(places.length));
    }
  }, [net, spot, places]);

  const up = useCallback(() => {
    if (!spot) {
      if (net?.step === 'servers') {
        backFromNet.current = true;
        setNet(null);
      } else if (net) {
        setNet({ step: 'servers' });
      } else {
        finish(null);
      }
      return;
    }
    // From the top of a network share, back to that server's shares.
    if (spot.trail.length === 0 && spot.place.server) {
      setNet({ step: 'shares', server: spot.place.server });
      go(null);
      return;
    }
    landOn.current = spot.trail.length > 0 ? spot.trail[spot.trail.length - 1] : spot.place.name;
    go(spot.trail.length > 0 ? { ...spot, trail: spot.trail.slice(0, -1) } : null);
  }, [spot, net, finish, go]);

  // Back goes up a level. Capture phase, like the Leave dialog: the page
  // behind must never see the press. In a text box Backspace deletes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack') {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT') {
          if (e.key === 'Backspace') return;
          target.blur();
        }
        e.preventDefault();
        e.stopPropagation();
        up();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [up]);

  const grantAllFiles = async () => {
    setError(null);
    try {
      const now = await allowAllFiles();
      setAccess(now);
      // The button goes once it is granted; the ring goes to the drives
      // rather than wherever the spatial library would put it.
      if (now.allFiles === 'granted') void setFocus(itemKey(0));
    } catch (e) {
      setError(userError(e));
    }
  };

  // The network's typing steps sit at the top, clear of the system's keyboard.
  const typing = !spot && (net?.step === 'address' || net?.step === 'sign-in' || net?.step === 'shares');

  const where = spot
    ? [spot.place.name, ...spot.trail].join(' › ')
    : net
      ? net.step === 'sign-in' || net.step === 'shares'
        ? `Network drives › ${net.server.name}`
        : 'Network drives'
      : null;

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        className={`leave-backdrop ${typing ? 'typing' : ''}`.trim()}
        onClick={() => finish(null)}
      >
        <div
          className="folder-browser"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label={`Choose your ${request.what} folder`}
        >
          <h2>Choose your {request.what} folder</h2>
          <p className="folder-where">
            {where ??
              (networkShares
                ? 'A USB drive, this device’s own storage, or a network drive'
                : 'A USB drive, or this device’s own storage')}
          </p>

          <div className="folder-actions">
            {spot && (
              <>
                <FocusButton
                  focusKey={USE_KEY}
                  className="btn-primary"
                  onSelect={() => finish(join(spot))}
                >
                  Use this folder
                </FocusButton>
                <FocusButton className="btn-secondary" onSelect={up}>
                  Up a folder
                </FocusButton>
              </>
            )}
            {/* The network's steps go back as Up a folder does, for a mouse. */}
            {!spot && net && (
              <FocusButton className="btn-secondary" onSelect={up}>
                Back
              </FocusButton>
            )}
            <FocusButton className="btn-secondary" onSelect={() => finish(null)}>
              Cancel
            </FocusButton>
            {listing && listing.videos > 0 && (
              <span className="muted">{videos(listing.videos)} here</span>
            )}
          </div>

          {error && <p className="leave-error">{error}</p>}

          {refused && (
            <div className="folder-note">
              <p>
                Kinema needs Android’s permission to read the films on your drives. It only reads
                them: nothing is moved, renamed or written to.
              </p>
              <p className="muted">
                If Android no longer asks, allow it in Android’s settings: Apps → Kinema →
                Permissions.
              </p>
              <FocusButton focusKey={RETRY_KEY} className="btn-primary" onSelect={() => void ask()}>
                Ask again
              </FocusButton>
            </div>
          )}

          {!spot && net && (
            <NetworkPlaces
              step={net}
              onStep={setNet}
              onOpen={(place) => {
                setNet(null);
                go({ place, trail: [] });
              }}
            />
          )}

          {!spot && !net && places && (
            <>
              <ul className="folder-list">
                {places.map((place, i) => (
                  <li key={place.path}>
                    <FocusButton
                      focusKey={itemKey(i)}
                      keepInView="nearest"
                      className="folder-item"
                      onSelect={() => go({ place, trail: [] })}
                    >
                      <span className="folder-name">{place.name}</span>
                      <span className="muted">
                        {place.removable ? 'USB drive or card' : 'This device'}
                      </span>
                    </FocusButton>
                  </li>
                ))}
                {networkShares && (
                  <li>
                    <FocusButton
                      focusKey={itemKey(places.length)}
                      keepInView="nearest"
                      className="folder-item"
                      onSelect={() => setNet({ step: 'servers' })}
                    >
                      <span className="folder-name">Network drives</span>
                      <span className="muted">A NAS, or a folder shared by a computer</span>
                    </FocusButton>
                  </li>
                )}
              </ul>
              {!places.some((p) => p.removable) && (
                <div className="folder-note">
                  <p className="muted">No USB drive found. Plug one in, then look again.</p>
                  <FocusButton
                    focusKey={RETRY_KEY}
                    className="btn-secondary"
                    onSelect={() => void loadPlaces()}
                  >
                    Look again
                  </FocusButton>
                </div>
              )}
              {access?.allFiles === 'off' && (
                <div className="folder-note">
                  <p className="muted">
                    Subtitle files beside your films need one more permission, All files access.
                    Films play without it.
                  </p>
                  <p className="muted">
                    Android opens its own settings, sometimes a list of apps: switch Kinema on
                    there, then press Back. Android calls it managing all files; Kinema only reads
                    them.
                  </p>
                  <FocusButton className="btn-secondary" onSelect={() => void grantAllFiles()}>
                    Allow all files
                  </FocusButton>
                </div>
              )}
              {access?.allFiles === 'unavailable' && (
                <p className="muted folder-note">
                  This device cannot let Kinema read the subtitle files beside your films, only
                  the films themselves.
                </p>
              )}
            </>
          )}

          {spot && listing && (
            <ul className="folder-list">
              {listing.folders.map((name, i) => (
                <li key={name}>
                  <FocusButton
                    focusKey={itemKey(i)}
                    keepInView="nearest"
                    className="folder-item"
                    onSelect={() => go({ ...spot, trail: [...spot.trail, name] })}
                  >
                    <span className="folder-name">{name}</span>
                  </FocusButton>
                </li>
              ))}
              {listing.folders.length === 0 && <li className="muted">No folders inside.</li>}
            </ul>
          )}

          <p className="muted folder-hint">
            {spot
              ? 'Press Back to go up a folder.'
              : net
                ? 'Press Back to go back.'
                : 'Press Back to close without choosing.'}
          </p>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
