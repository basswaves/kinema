/**
 * Adding to a playlist (LOCAL-MEDIA.md phase 5): the playlists to choose
 * from, and a new one.
 *
 * Two shells round the same choices. On a page — a film's or a show's, a
 * Videos folder's group — a dialog ([`PlaylistDialog`]) in which a new
 * playlist is named as it is made. In the player, a view inside the Audio &
 * subtitles panel (TrackPanel.tsx), where the player's own keys (Backspace,
 * letters) rule out typing: a new playlist there is named "Playlist 2" and
 * renamed on its page.
 */
import { FocusContext, getCurrentFocusKey, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import { useFocusGroup } from './focusGroups';
import { userError } from './errors';
import {
  addedMessage,
  addToPlaylist,
  createPlaylist,
  defaultName,
  listPlaylists,
  type NewItem,
  type PlaylistSummary,
} from '../library/playlists';

export const PICK_NEW_KEY = 'playlist-pick:new';
const NAME_KEY = 'playlist-pick:name';
const pickKey = (id: number) => `playlist-pick:${id}`;

export function PlaylistChoices({
  items,
  typing,
  onDone,
  buttonClass,
}: {
  items: NewItem[];
  /** A new playlist is named here (pages), or named for itself (the player). */
  typing: boolean;
  /** Added: the sentence saying what happened. */
  onDone: (message: string) => void;
  buttonClass: string;
}) {
  const [lists, setLists] = useState<PlaylistSummary[] | null>(null);
  /** The name field is open (pages only), and what is typed in it. */
  const [askName, setAskName] = useState(false);
  const [naming, setNaming] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    listPlaylists()
      .then((found) => live && setLists(found))
      .catch((e) => live && setError(userError(e)));
    return () => {
      live = false;
    };
  }, []);

  // The ring on the playlist used last (the list comes newest first), or on
  // New playlist when there is none.
  const first = lists?.[0];
  useEffect(() => {
    if (lists === null) return;
    void setFocus(first ? pickKey(first.id) : PICK_NEW_KEY);
  }, [lists, first]);

  useEffect(() => {
    if (askName) void setFocus(NAME_KEY);
  }, [askName]);

  const add = (id: number, name: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    addToPlaylist(id, items)
      .then((result) => onDone(addedMessage(name, result)))
      .catch((e) => {
        setBusy(false);
        setError(userError(e));
      });
  };

  const create = (name: string) => {
    if (busy) return;
    const chosen = name.trim() || defaultName(lists ?? []);
    setBusy(true);
    createPlaylist(chosen)
      .then((id) => {
        setBusy(false);
        add(id, chosen);
      })
      .catch((e) => {
        setBusy(false);
        setError(userError(e));
      });
  };

  return (
    <>
      {lists?.map((list) => (
        <FocusButton
          key={list.id}
          focusKey={pickKey(list.id)}
          className={buttonClass}
          keepInView="nearest"
          disabled={busy}
          onSelect={() => add(list.id, list.name)}
        >
          {list.name} <span className="muted">· {list.count}</span>
        </FocusButton>
      ))}
      {!askName ? (
        <FocusButton
          focusKey={PICK_NEW_KEY}
          className={buttonClass}
          keepInView="nearest"
          disabled={busy || lists === null}
          onSelect={() => (typing ? setAskName(true) : create(''))}
        >
          + New playlist
        </FocusButton>
      ) : (
        <>
          <FocusInput
            focusKey={NAME_KEY}
            className="playlist-name-input"
            value={naming}
            onChange={setNaming}
            onEnter={() => create(naming)}
            placeholder={defaultName(lists ?? [])}
          />
          <FocusButton className={buttonClass} keepInView="nearest" disabled={busy} onSelect={() => create(naming)}>
            Make it and add
          </FocusButton>
        </>
      )}
      {error && <p className="leave-error">{error}</p>}
    </>
  );
}

/** The dialog on a page. `onClose` gets the sentence to show, or null on Cancel. */
export function PlaylistDialog({
  items,
  what,
  onClose,
}: {
  items: NewItem[];
  /** What is being added, for the heading: "the film", "season 2". */
  what: string;
  onClose: (message: string | null) => void;
}) {
  const { ref, focusKey } = useFocusGroup('menu');
  const returnTo = useRef<string | null>(getCurrentFocusKey());

  // Focus goes back first, while the dialog is still there (docs/GOTCHAS.md,
  // as LeaveDialog.tsx).
  const close = useCallback(
    (message: string | null) => {
      if (returnTo.current) void setFocus(returnTo.current);
      onClose(message);
    },
    [onClose]
  );

  // Capture phase, so the page's own Back never sees the press; Backspace in
  // the name field is typing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const inField = e.target instanceof HTMLInputElement;
      if (e.key === 'Escape' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !inField)) {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="leave-backdrop" onClick={() => close(null)}>
        <div
          className="leave playlist-dialog"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Add to a playlist"
        >
          <h2>Add {what} to a playlist</h2>
          <div className="leave-choices">
            <PlaylistChoices items={items} typing onDone={close} buttonClass="leave-choice" />
            <FocusButton className="leave-choice leave-cancel" onSelect={() => close(null)}>
              Cancel
            </FocusButton>
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
