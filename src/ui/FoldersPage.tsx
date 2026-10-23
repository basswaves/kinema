/**
 * Library → Folders: browse anything Kinema can read and play any video in
 * it (LOCAL-MEDIA.md phase 4).
 *
 * It starts with the places: the drives (on a desktop from places.rs, on
 * Android from Android's own list, as its folder browser has them), the
 * library's own folders, and the network — on Android Kinema's own network
 * drives (`NetworkPlaces.tsx`); on a desktop a typed address (`\\nas\films`),
 * which the system opens with its own sign-in, plus the shares a desktop has
 * mounted, which are among the drives. OK goes into a folder and plays a
 * video; Back goes up a level, and from the places back to the Library page.
 *
 * A video plays as the library's file when a library folder holds it, else as
 * a video of its own (opened.ts `targetFor`): resumed by path and size, with
 * the folder's other videos as previous and next.
 *
 * "Add this folder to the library" adds the folder shown as Movies, TV shows
 * or Videos, and scans. Where the folder is in the library already it says
 * so instead.
 *
 * Where the browser is lives in the view itself (`at`), so Back from a film
 * comes back to its folder, with the ring on the film.
 */
import {
  FocusContext,
  doesFocusableExist,
  setFocus,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import AddFolder from './AddFolder';
import NetworkPlaces, { type NetStep } from './NetworkPlaces';
import { hasPendingReturn, useClaimFocus } from './focus';
import { userError } from './errors';
import { count, KIND_WORDS } from './format';
import { useCapabilities } from '../capabilities';
import type { LibraryRoot } from '../library/api';
import {
  folderPlaces,
  joinPath,
  listFolders,
  requestStorageAccess,
  rootHolding,
  storageAccess,
  storagePlaces,
  typedAddress,
  type Listing,
  type Place,
} from '../library/folders';
import { runScanPipeline } from '../library/pipeline';
import { lastPart } from '../library/videos';
import { getSetting, setSetting } from '../metadata/api';

const PAGE_KEY = 'folders-page';
const ADDRESS_KEY = 'folders-address';
const ADD_KEY = 'folders-add';
const UP_KEY = 'folders-up';
const RETRY_KEY = 'folders-retry';
/** Network addresses opened before, newest first (desktops). */
const ADDRESSES_SETTING = 'folders_addresses';
const ADDRESSES_KEPT = 6;

/** A place's key names its list too: a drive can also be a library folder. */
const placeKey = (section: string, path: string) => `folders-place:${section}:${path}`;
const dirKey = (name: string) => `folders-dir:${name}`;
const fileKey = (name: string) => `folders-file:${name}`;

/** Where the browser is: a place, and the folders below it. */
export interface FolderSpot {
  place: Place;
  /** The list it was opened from, so Back lands on that entry. */
  section?: string;
  /** Folder names below the place's own folder, outermost first. */
  trail: string[];
}

/** A place in the starting list, with what it says under its name. */
interface Start {
  place: Place;
  note: string;
}

const DESKTOP_NOTES: Record<string, string> = {
  drive: 'Drive',
  removable: 'USB drive',
  disc: 'Disc',
  network: 'Network',
  home: 'Your own folder',
};

/** Names as a person sorts them: `Part 2` before `Part 10`. */
const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export default function FoldersPage({
  at,
  roots,
  onMove,
  onPlay,
  onBack,
  onLibraryChanged,
}: {
  at: FolderSpot | null;
  roots: LibraryRoot[];
  /** The browser moved: kept in the view, so Back from a film returns here. */
  onMove: (spot: FolderSpot | null) => void;
  onPlay: (path: string) => void;
  onBack: () => void;
  onLibraryChanged: () => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: PAGE_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  const caps = useCapabilities();
  /** Android's way: its own drives and permission, and Kinema's network drives. */
  const android = caps?.folder_picker === false;
  const networkShares = caps?.network_shares ?? false;

  const [starts, setStarts] = useState<Start[] | null>(null);
  const [refused, setRefused] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** In Android's network steps, and where; null elsewhere. */
  const [net, setNet] = useState<NetStep | null>(null);
  const [address, setAddress] = useState('');
  const [addresses, setAddresses] = useState<string[]>([]);
  /** Adding the folder shown (AddFolder.tsx). */
  const [adding, setAdding] = useState(false);
  /** What the browser came back out of: the ring goes there, not to the top. */
  const [cameFrom, setCameFrom] = useState<string | null>(null);
  /**
   * Back from a film: the ring is on its way to it (returnFocusTo), and the
   * page claims nothing until the person moves on — its second look would
   * otherwise take the ring to the first file.
   */
  const [returning, setReturning] = useState(hasPendingReturn);

  const spot = at;
  const path = spot ? joinPath(spot.place.path, spot.trail) : null;
  /** The folder on screen now, for answers that arrive later. */
  const shownPath = useRef(path);
  useEffect(() => {
    shownPath.current = path;
  }, [path]);

  const loadStarts = useCallback(async () => {
    setError(null);
    try {
      if (android) {
        let access = await storageAccess();
        if (access.read !== 'granted') access = await requestStorageAccess();
        setRefused(access.read !== 'granted');
        const places = access.read === 'granted' ? await storagePlaces() : [];
        setStarts(
          places.map((place) => ({
            place,
            note: place.removable ? 'USB drive or card' : 'This device',
          }))
        );
      } else {
        const places = await folderPlaces();
        setStarts(
          places.map((p) => ({
            place: { path: p.path, name: p.name, removable: p.kind === 'removable' },
            note: DESKTOP_NOTES[p.kind] ?? '',
          }))
        );
      }
    } catch (e) {
      setError(userError(e));
      setStarts([]);
    }
  }, [android]);

  useEffect(() => {
    if (!caps) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStarts();
  }, [caps, loadStarts]);

  /** The kept addresses have been read, so writing them back loses none. */
  const addressesRead = useRef(false);
  /** What the setting holds, so it is written only when that changes. */
  const addressesStored = useRef('[]');
  useEffect(() => {
    if (android) return;
    void getSetting(ADDRESSES_SETTING)
      .then((raw) => {
        const list: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) return;
        const kept = list.filter((a): a is string => typeof a === 'string');
        addressesStored.current = JSON.stringify(kept);
        setAddresses(kept);
      })
      .catch(() => undefined)
      .finally(() => {
        addressesRead.current = true;
      });
  }, [android]);
  const remember = useCallback((opened: string) => {
    if (!addressesRead.current) return;
    setAddresses((kept) => {
      const next = [opened, ...kept.filter((a) => a !== opened)].slice(0, ADDRESSES_KEPT);
      return next.join('\n') === kept.join('\n') ? kept : next;
    });
  }, []);
  useEffect(() => {
    const value = JSON.stringify(addresses);
    if (addressesRead.current && value !== addressesStored.current) {
      addressesStored.current = value;
      void setSetting(ADDRESSES_SETTING, value).catch(() => undefined);
    }
  }, [addresses]);

  /** Somewhere else: what was shown goes at once, the new contents follow. */
  const go = useCallback(
    (next: FolderSpot | null, from: string | null = null) => {
      setCameFrom(from);
      setReturning(false);
      setListing(null);
      setError(null);
      setNote(null);
      setAdding(false);
      onMove(next);
    },
    [onMove]
  );

  /** A network address typed on a desktop, kept for next time once it opens. */
  const typedTop =
    !android &&
    spot !== null &&
    spot.trail.length === 0 &&
    spot.place.path === spot.place.name &&
    !roots.some((r) => r.path === spot.place.path);

  // A folder's contents, whenever the browser is in one.
  useEffect(() => {
    if (!path) return;
    let live = true;
    listFolders(path)
      .then((l) => {
        if (!live) return;
        setListing({ ...l, folders: [...l.folders].sort(byName), files: [...l.files].sort(byName) });
        if (typedTop) remember(path);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(userError(e));
        setListing({ folders: [], videos: 0, files: [] });
      });
    return () => {
      live = false;
    };
  }, [path, typedTop, remember]);

  const libraryStarts = useMemo<Start[]>(
    () =>
      roots.map((root) => ({
        place: { path: root.path, name: root.name ?? lastPart(root.path), removable: false },
        note: KIND_WORDS[root.kind] ?? '',
      })),
    [roots]
  );
  const addressStarts = useMemo<Start[]>(
    () =>
      addresses.map((a) => ({
        place: { path: a, name: a, removable: false },
        // A `\\nas\films` address is the network; a typed Linux path may be any folder.
        note: a.startsWith('\\\\') ? 'Network' : 'Folder',
      })),
    [addresses]
  );

  // The ring onto a level once it is drawn: what was come back out of, else
  // the first entry — unless it is on its way back to a film just left
  // (useClaimFocus waits for that).
  const inFolder = spot !== null;
  const levelReady = !net && (inFolder ? listing !== null : starts !== null);
  const levelKeys = inFolder
    ? [...(listing?.folders ?? []).map(dirKey), ...(listing?.files ?? []).map(fileKey)]
    : [
        ...(starts ?? []).map((s) => placeKey('drives', s.place.path)),
        ...libraryStarts.map((s) => placeKey('library', s.place.path)),
        ...addressStarts.map((s) => placeKey('opened', s.place.path)),
        ...(android && networkShares ? ['folders-network'] : []),
      ];
  const landing = !levelReady
    ? null
    : cameFrom && levelKeys.includes(cameFrom)
      ? cameFrom
      : (levelKeys[0] ??
        (inFolder ? UP_KEY : refused ? RETRY_KEY : android ? PAGE_KEY : ADDRESS_KEY));
  const level = inFolder ? `folder:${path}` : net ? `net:${net.step}` : 'places';

  const up = useCallback(() => {
    if (adding) {
      setAdding(false);
      void setFocus(doesFocusableExist(ADD_KEY) ? ADD_KEY : UP_KEY);
      return;
    }
    if (!spot) {
      if (net?.step === 'servers') {
        setCameFrom('folders-network');
        setNet(null);
      } else if (net) {
        setNet({ step: 'servers' });
      } else {
        onBack();
      }
      return;
    }
    // From the top of a network share, back to that server's shares.
    if (spot.trail.length === 0 && spot.place.server) {
      setNet({ step: 'shares', server: spot.place.server });
      go(null);
      return;
    }
    if (spot.trail.length > 0) {
      go({ ...spot, trail: spot.trail.slice(0, -1) }, dirKey(spot.trail[spot.trail.length - 1]));
    } else {
      go(null, spot.section ? placeKey(spot.section, spot.place.path) : null);
    }
  }, [adding, spot, net, go, onBack]);

  // Back goes up a level. Capture phase, like the folder browser: Browse
  // must not also take the press back to the Library page. In a text box
  // Backspace deletes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Backspace' && e.key !== 'BrowserBack') return;
      // Taken already: the key list closing over this page.
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      e.stopPropagation();
      if (target.tagName === 'INPUT') {
        // In a text box Backspace deletes, and Back only leaves the box.
        if (e.key === 'Backspace') return;
        e.preventDefault();
        target.blur();
        return;
      }
      e.preventDefault();
      up();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [up]);

  const openAddress = () => {
    const typed = typedAddress(address);
    if (!typed) return;
    go({ place: { path: typed, name: typed, removable: false }, section: 'opened', trail: [] });
  };

  const inLibrary = path ? rootHolding(roots, path) : null;

  const finishAdding = (name: string) => {
    const added = path;
    setAdding(false);
    setNote(`Added ${name} to the library. Scanning it now.`);
    onLibraryChanged();
    void runScanPipeline()
      .then((outcome) => {
        // Said only in the folder that was added; it is in the library anyway.
        if (shownPath.current !== added) return;
        if (outcome.status === 'failed') setError(outcome.error);
        else if (outcome.status === 'skipped')
          setNote(`Added ${name}. A scan is already running; it is picked up by the next one.`);
        else setNote(`Added ${name} to the library and scanned it.`);
      })
      .catch((e: unknown) => shownPath.current === added && setError(userError(e)))
      .finally(onLibraryChanged);
  };

  const where = spot
    ? [spot.place.name, ...spot.trail].join(' › ')
    : net
      ? net.step === 'sign-in' || net.step === 'shares'
        ? `Network drives › ${net.server.name}`
        : 'Network drives'
      : null;

  const startList = (title: string, section: string, list: Start[]) =>
    list.length > 0 && (
      <section className="folders-section">
        <h3 className="folders-heading">{title}</h3>
        <ul className="folder-list">
          {list.map(({ place, note: under }) => (
            <li key={place.path}>
              <FocusButton
                focusKey={placeKey(section, place.path)}
                keepInView="nearest"
                className="folder-item"
                onSelect={() => go({ place, section, trail: [] })}
              >
                <span className="folder-name">{place.name}</span>
                <span className="muted">{under}</span>
              </FocusButton>
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="search folders-page" ref={ref}>
        <Landing key={level} focusKey={landing ?? PAGE_KEY} ready={landing !== null && !returning} />
        <h2 className="grid-heading">Folders</h2>
        <p className="folder-where">
          {where ?? 'Any folder Kinema can read: play a video from it, or add it to the library.'}
        </p>

        {spot && (
          <div className="folder-actions">
            {inLibrary ? (
              <span className="muted">
                In the library: {inLibrary.name ?? lastPart(inLibrary.path)} (
                {KIND_WORDS[inLibrary.kind]})
              </span>
            ) : (
              <FocusButton
                focusKey={ADD_KEY}
                className="btn-secondary"
                onSelect={() => setAdding(true)}
              >
                Add this folder to the library
              </FocusButton>
            )}
            <FocusButton focusKey={UP_KEY} className="btn-secondary" onSelect={up}>
              Up a folder
            </FocusButton>
            {listing && listing.videos > 0 && (
              <span className="muted">{count(listing.videos, 'video')} here</span>
            )}
          </div>
        )}

        {adding && path && spot && (
          <AddFolder
            path={path}
            name={lastPart(path) || spot.place.name}
            onAdded={finishAdding}
            onCancel={up}
          />
        )}

        {note && <p className="settings-note">{note}</p>}
        {error && <p className="leave-error">{error}</p>}

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

        {!spot && !net && (
          <>
            {refused && (
              <div className="folder-note">
                <p>
                  Kinema needs Android’s permission to read the videos on your drives. It only
                  reads them: nothing is moved, renamed or written to.
                </p>
                <FocusButton
                  focusKey={RETRY_KEY}
                  className="btn-primary"
                  onSelect={() => void loadStarts()}
                >
                  Ask again
                </FocusButton>
              </div>
            )}
            {starts && startList('Drives', 'drives', starts)}
            {startList('Library folders', 'library', libraryStarts)}
            <section className="folders-section">
              <h3 className="folders-heading">Network</h3>
              {android ? (
                networkShares && (
                  <ul className="folder-list">
                    <li>
                      <FocusButton
                        focusKey="folders-network"
                        keepInView="nearest"
                        className="folder-item"
                        onSelect={() => setNet({ step: 'servers' })}
                      >
                        <span className="folder-name">Network drives</span>
                        <span className="muted">A NAS, or a folder shared by a computer</span>
                      </FocusButton>
                    </li>
                  </ul>
                )
              ) : (
                <>
                  <div className="settings-row">
                    <FocusInput
                      focusKey={ADDRESS_KEY}
                      className="settings-input"
                      value={address}
                      onChange={setAddress}
                      onEnter={openAddress}
                      placeholder={
                        starts?.some((s) => /^[A-Za-z]:/.test(s.place.path))
                          ? '\\\\server\\share'
                          : '/mnt/films'
                      }
                    />
                    <FocusButton className="btn-secondary" onSelect={openAddress}>
                      Open
                    </FocusButton>
                  </div>
                  {startList('Opened before', 'opened', addressStarts)}
                </>
              )}
            </section>
          </>
        )}

        {spot && listing && (
          <ul className="folder-list">
            {listing.folders.map((name) => (
              <li key={`d:${name}`}>
                <FocusButton
                  focusKey={dirKey(name)}
                  keepInView="nearest"
                  className="folder-item"
                  onSelect={() => go({ ...spot, trail: [...spot.trail, name] })}
                >
                  <span className="folder-name">{name}</span>
                  <span className="muted">Folder</span>
                </FocusButton>
              </li>
            ))}
            {listing.files.map((name) => (
              <li key={`f:${name}`}>
                <FocusButton
                  focusKey={fileKey(name)}
                  keepInView="nearest"
                  className="folder-item folder-file"
                  onSelect={() => onPlay(joinPath(path ?? '', [name]))}
                >
                  <span className="folder-name">{name}</span>
                  <span className="muted">Play</span>
                </FocusButton>
              </li>
            ))}
            {listing.folders.length === 0 && listing.files.length === 0 && !error && (
              <li className="muted">No folders or videos here.</li>
            )}
          </ul>
        )}

        <p className="muted folder-hint">
          {spot
            ? 'Press Back to go up a folder.'
            : net
              ? 'Press Back to go back.'
              : 'Press Back to go back to the Library.'}
        </p>
      </div>
    </FocusContext.Provider>
  );
}

/**
 * The ring onto a level once it is drawn, as a page takes it (useClaimFocus):
 * one per level, so a person who has pressed nothing since entering a folder
 * gets the ring there even after a slow share made them wait, and one who
 * has moved on keeps it where they put it.
 */
function Landing({ focusKey, ready }: { focusKey: string; ready: boolean }) {
  useClaimFocus(focusKey, ready, true);
  return null;
}
