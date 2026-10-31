/**
 * The menu on cards (cardMenuStore.ts): one for the whole interface, drawn by
 * Browse over whatever screen the card was on.
 *
 * Per card kind: a film plays or resumes, is marked watched or not, goes on
 * My list or a playlist, opens its page, and on a desktop shows its file in
 * its folder. A show does the same as a whole — Play is the next episode,
 * Mark watched every episode held (as "Mark show watched" on its page), a
 * playlist gets every episode — and has no one file to show.
 *
 * A menu like the Version list: focus never leaves it, Back closes it and the
 * ring goes back to the card.
 */
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import FocusButton from './FocusButton';
import { useFocusGroup } from './focusGroups';
import { FocusProvider } from './FocusGroup';
import { focusInPlace } from './focus';
import { navFocus, useOnKinema } from './focusStore';
import { PlaylistDialog } from './PlaylistPicker';
import { closeCardMenu, useCardMenu, type CardMenuRequest } from './cardMenuStore';
import { getTitleDetail, type Title } from './api';
import { userError } from './errors';
import { useCapabilities } from '../capabilities';
import { isOnMyList, toggleMyList } from '../library/myList';
import { setWatched } from '../player/api';
import type { NewItem } from '../library/playlists';

interface Props {
  onPlay: (title: Title) => void;
  onOpen: (title: Title) => void;
  /** Something about the title changed (watched): the library is read again. */
  onChanged: () => void;
}

const FIRST_KEY = 'card-menu:first';
/** Quiet this long after the last held OK, the menu takes presses. */
const SETTLE_MS = 300;

export default function CardMenuHost(props: Props) {
  const request = useCardMenu();
  const [playlist, setPlaylist] = useState<{ items: NewItem[]; what: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!note) return;
    const id = window.setTimeout(() => setNote(null), 4000);
    return () => window.clearTimeout(id);
  }, [note]);

  return (
    <>
      {/* On whichever engine the screen under it is (round 7, F2): over a
          screen on Kinema's own a menu that holds the ring while open and
          gives it back to the card when it closes (focusStore.ts). */}
      {request && (
        <CardMenu
          key={`${request.title.id}:${request.returnTo ?? ''}`}
          request={request}
          {...props}
          onPlaylist={(items, what) => setPlaylist({ items, what })}
          onNote={setNote}
        />
      )}
      {playlist && (
        <PlaylistDialog
          items={playlist.items}
          what={playlist.what}
          onClose={(message) => {
            setPlaylist(null);
            setNote(message);
          }}
        />
      )}
      {note && (
        <p className="card-menu-note" role="status">
          {note}
        </p>
      )}
    </>
  );
}

function CardMenu({
  request,
  onPlay,
  onOpen,
  onChanged,
  onPlaylist,
  onNote,
}: Props & {
  request: CardMenuRequest;
  onPlaylist: (items: NewItem[], what: string) => void;
  onNote: (note: string) => void;
}) {
  const { title, returnTo, held } = request;
  // Opens on its first item; on Kinema's engine a menu lands there by itself.
  const kinema = useOnKinema();
  const { ref, focusKey } = useFocusGroup('menu', { current: FIRST_KEY });
  const desktop = useCapabilities()?.runs_programs ?? false;
  const series = title.kind === 'series';
  const listed = isOnMyList(title.id);

  useEffect(() => {
    if (!kinema) void setFocus(FIRST_KEY);
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pointer = request.pointer;
  const close = useCallback(() => {
    // Back to the card first, while the menu is still there (docs/GOTCHAS.md,
    // as LeaveDialog.tsx); for a pointer without moving the page under it.
    // On Kinema's engine the page moves only if the card is out of sight, and
    // the card is named: a right-click opens the menu without taking the ring.
    if (returnTo) {
      if (kinema) navFocus(returnTo);
      else if (pointer) focusInPlace(returnTo);
      else void setFocus(returnTo);
    }
    closeCardMenu();
  }, [returnTo, pointer, kinema]);

  // Opened by OK held: that OK is still down, and its repeats (and its
  // release) must not choose the first item. Taken once the key came up, or
  // — a remote that sends no release — at a fresh press after a quiet moment.
  // A repeat is the same hold however late it comes.
  const settled = useRef(!held);
  // Before paint: a repeat arriving between drawing and an ordinary effect
  // would reach the spatial library and choose Play.
  useLayoutEffect(() => {
    let lastAt = performance.now();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!settled.current && e.key === 'Enter') {
        const fresh = !e.repeat && performance.now() - lastAt >= SETTLE_MS;
        lastAt = performance.now();
        if (!fresh) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        settled.current = true;
      }
      if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !settled.current) {
        e.stopPropagation();
        settled.current = true;
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [close]);

  const act = (action: () => Promise<void> | void) => () => {
    close();
    void Promise.resolve()
      .then(action)
      .catch((e: unknown) => onNote(userError(e)));
  };

  /** Every file held: a film's, or each episode's. */
  const files = async () => {
    const detail = await getTitleDetail(title.id);
    return { detail, items: series
      ? detail.episodes.flatMap((e) => (e.file_path ? [{ path: e.file_path, file_id: e.file_id }] : []))
      : detail.movie_path
        ? [{ path: detail.movie_path, file_id: detail.movie_file_id }]
        : [] };
  };

  const markWatched = async () => {
    const { detail } = await files();
    const to = !title.watched;
    if (series) {
      for (const e of detail.episodes) {
        if (e.file_path && e.file_id !== null && e.watched !== to) await setWatched(e.file_id, to);
      }
    } else if (detail.movie_file_id !== null) {
      await setWatched(detail.movie_file_id, to);
    }
    onChanged();
  };

  const items: { label: string; run: () => void }[] = [
    {
      label: title.progress !== null && !series ? 'Resume' : 'Play',
      run: act(() => onPlay(title)),
    },
    {
      label: title.watched
        ? series ? 'Mark show unwatched' : 'Mark unwatched'
        : series ? 'Mark show watched' : 'Mark watched',
      run: act(markWatched),
    },
    {
      label: listed ? 'Take off My list' : 'Add to My list',
      run: act(() => toggleMyList(title.id, !listed)),
    },
    {
      label: 'Add to playlist',
      run: act(async () => {
        const { items } = await files();
        if (items.length === 0) return onNote(`No file of “${title.title}” is here to add.`);
        onPlaylist(items, series ? 'the show' : 'the film');
      }),
    },
    { label: 'Open page', run: act(() => onOpen(title)) },
  ];
  if (desktop && !series) {
    items.push({
      label: 'Show the file in its folder',
      run: act(async () => {
        const { detail } = await files();
        if (detail.movie_path) await revealItemInDir(detail.movie_path);
      }),
    });
  }

  return (
    <FocusProvider value={focusKey}>
      <div className="leave-backdrop" onClick={close} onContextMenu={(e) => e.preventDefault()}>
        <div
          className="leave card-menu"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="menu"
          aria-label={title.title}
        >
          <h2>{title.title}</h2>
          <div className="leave-choices">
            {items.map((item, i) => (
              <FocusButton
                key={item.label}
                focusKey={i === 0 ? FIRST_KEY : `card-menu:${i}`}
                className="leave-choice"
                onSelect={item.run}
              >
                {item.label}
              </FocusButton>
            ))}
          </div>
        </div>
      </div>
    </FocusProvider>
  );
}
