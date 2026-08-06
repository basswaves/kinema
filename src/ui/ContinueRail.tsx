/**
 * Continue Watching.
 *
 * Uses wide cards rather than posters: these represent a *moment in a file*,
 * not a title, so the episode still and a progress bar carry the useful
 * information. Poster cards would make a half-watched episode look like a
 * fresh show.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, useRef } from 'react';
import Art from './Art';
import type { ContinueItem } from '../player/api';

interface Props {
  items: ContinueItem[];
  onResume: (item: ContinueItem) => void;
}

function remainingLabel(item: ContinueItem): string {
  if (!item.duration_secs) return '';
  const left = Math.max(0, item.duration_secs - item.position_secs);
  const mins = Math.round(left / 60);
  return mins > 0 ? `${mins} min left` : 'nearly done';
}

export default function ContinueRail({ items, onResume }: Props) {
  const { ref, focusKey } = useFocusable({ trackChildren: true, saveLastFocusedChild: true });

  if (items.length === 0) return null;

  return (
    <FocusContext.Provider value={focusKey}>
      <section className="rail" ref={ref}>
        <h2 className="rail-heading">Continue watching</h2>
        <div className="rail-track">
          {items.map((item) => (
            <ContinueCard key={item.file_id} item={item} onResume={onResume} />
          ))}
        </div>
      </section>
    </FocusContext.Provider>
  );
}

function ContinueCard({ item, onResume }: { item: ContinueItem; onResume: (i: ContinueItem) => void }) {
  const { ref, focused } = useFocusable({ onEnterPress: () => onResume(item) });
  const element = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focused) {
      element.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [focused]);

  const percent = item.duration_secs
    ? Math.min(100, (item.position_secs / item.duration_secs) * 100)
    : 0;

  const subtitle =
    item.season !== null && item.episode !== null
      ? `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}${
          item.episode_name ? ` · ${item.episode_name}` : ''
        }`
      : (remainingLabel(item) ?? '');

  return (
    <div
      ref={(node) => {
        ref.current = node;
        element.current = node;
      }}
      className={`continue-card ${focused ? 'focused' : ''}`}
      onClick={() => onResume(item)}
      role="button"
      tabIndex={0}
    >
      <div className="continue-art">
        <Art
          local={item.image_path}
          remote={item.image_url}
          lazy
          fallback={<div className="continue-art-empty" />}
        />
        <div className="continue-play">▶</div>
        <div className="continue-progress">
          <div className="continue-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <div className="continue-title">{item.title}</div>
      <div className="continue-meta">{subtitle}</div>
      <div className="continue-remaining">{remainingLabel(item)}</div>
    </div>
  );
}
