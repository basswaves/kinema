/**
 * A poster card. Focusable via the spatial navigation system so the same
 * component serves mouse and D-pad without a separate TV variant — building
 * two card components would guarantee they drift apart.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, useRef } from 'react';
import Art from './Art';
import type { Title } from './api';
import { posterState } from './poster';
import { keepOnScreen } from './focus';

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
}

export default function Card({ title, onSelect, focusKey: key, note }: Props) {
  const { ref, focused, focusKey } = useFocusable({
    focusKey: key,
    onEnterPress: () => onSelect(title),
    extraProps: { titleId: title.id },
  });

  const element = useRef<HTMLDivElement | null>(null);
  const state = posterState(title);

  // Keep the focused card on screen when navigating by remote.
  useEffect(() => {
    if (focused) {
      keepOnScreen(element.current);
    }
  }, [focused]);

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
            remote={title.poster_url}
            lazy
            fallback={<div className="card-art-empty">{title.title}</div>}
          />
          {state.badge && <span className="card-badge">{state.badge}</span>}
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
}
