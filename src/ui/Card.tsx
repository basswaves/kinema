/**
 * A poster card. Focusable via the spatial navigation system so the same
 * component serves mouse and D-pad without a separate TV variant — building
 * two card components would guarantee they drift apart.
 */
import {
  useFocusable,
  FocusContext,
  getCurrentFocusKey,
  navigateByDirection,
} from '@noriginmedia/norigin-spatial-navigation';
import { memo, useEffect, useRef } from 'react';
import Art from './Art';
import type { Title } from './api';
import { posterState, sizedPoster } from './poster';
import { keepOnScreen, recoverFocusSoon } from './focus';
import { isMyListKey, toggleMyList, useOnMyList } from '../library/myList';

interface Props {
  title: Title;
  onSelect: (title: Title) => void;
  /**
   * Stable across remounts, so Back can put focus back on this card. Unique per
   * place the card appears: the same title sits in several rails at once.
   */
  focusKey?: string;
  /** A line under the title saying why it is here — "with …" in search. */
  note?: string | null;
  /** On My list's own rail: taking it off takes the card away too. */
  goesWhenUnlisted?: boolean;
}

/**
 * Memoised: a rail redraws itself every time focus enters or leaves it, and
 * its thirty cards have no reason to follow. Their props are stable — the
 * title rows are the ones already on screen when a reload brought back the
 * same data (keepSame.ts) and `onSelect` is one function for the whole shell.
 */
export default memo(function Card({ title, onSelect, focusKey: key, note, goesWhenUnlisted }: Props) {
  const { ref, focused, focusKey } = useFocusable({
    focusKey: key,
    onEnterPress: () => onSelect(title),
    extraProps: { titleId: title.id },
  });

  const element = useRef<HTMLDivElement | null>(null);
  const state = posterState(title);
  const listed = useOnMyList(title.id);

  // Keep the focused card on screen when navigating by remote.
  useEffect(() => {
    if (focused) {
      keepOnScreen(element.current);
    }
  }, [focused]);

  // L puts the focused card on My list or takes it off. Only the focused
  // card listens, so one press is one card. A remote has no letters: the
  // title's page has the button, and a menu on cards is round 6's.
  useEffect(() => {
    if (!focused) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isMyListKey(e)) return;
      e.preventDefault();
      if (goesWhenUnlisted && listed) {
        // The ring moves on to the card beside it first, while this one is
        // still there to measure from; the last card takes the rail with it.
        const here = getCurrentFocusKey();
        navigateByDirection('right', {});
        if (getCurrentFocusKey() === here) navigateByDirection('left', {});
        if (getCurrentFocusKey() === here) recoverFocusSoon();
      }
      void toggleMyList(title.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focused, title.id, goesWhenUnlisted, listed]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={(node) => {
          ref.current = node;
          element.current = node;
        }}
        className={`card ${focused ? 'focused' : ''}`}
        onClick={() => onSelect(title)}
        role="button"
        tabIndex={0}
      >
        <div className="card-art">
          <Art
            local={title.poster_path}
            remote={sizedPoster(title.poster_url, 'w500')}
            lazy
            fallback={<div className="card-art-empty">{title.title}</div>}
          />
          {state.badge && <span className="card-badge">{state.badge}</span>}
          {listed && <span className="card-listed" aria-label="On My list" title="On My list" />}
          {state.watched && (
            <span className="card-watched" aria-label="Watched">
              ✓
            </span>
          )}
          {state.progress !== null && (
            <span className="card-progress" aria-hidden="true">
              <span style={{ width: `${state.progress * 100}%` }} />
            </span>
          )}
        </div>
        <div className="card-title">{title.title}</div>
        <div className="card-meta">
          {title.year ?? ''}
          {title.rating ? ` · ★ ${title.rating.toFixed(1)}` : ''}
        </div>
        {note && <div className="card-note">{note}</div>}
      </div>
    </FocusContext.Provider>
  );
});
