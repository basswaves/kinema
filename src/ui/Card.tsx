/**
 * A poster card. Focusable via the spatial navigation system so the same
 * component serves mouse and D-pad without a separate TV variant — building
 * two card components would guarantee they drift apart.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, useRef } from 'react';
import type { Title } from './api';

interface Props {
  title: Title;
  onSelect: (title: Title) => void;
}

export default function Card({ title, onSelect }: Props) {
  const { ref, focused, focusKey } = useFocusable({
    onEnterPress: () => onSelect(title),
    extraProps: { titleId: title.id },
  });

  const element = useRef<HTMLDivElement | null>(null);

  // Keep the focused card on screen when navigating by remote.
  useEffect(() => {
    if (focused) {
      element.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
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
          {title.poster_url ? (
            <img src={title.poster_url} alt="" loading="lazy" draggable={false} />
          ) : (
            <div className="card-art-empty">{title.title}</div>
          )}
          {title.file_count > 0 && title.kind === 'series' && (
            <span className="card-badge">{title.file_count} ep</span>
          )}
        </div>
        <div className="card-title">{title.title}</div>
        <div className="card-meta">
          {title.year ?? ''}
          {title.rating ? ` · ★ ${title.rating.toFixed(1)}` : ''}
        </div>
      </div>
    </FocusContext.Provider>
  );
}
