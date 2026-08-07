/**
 * Continue Watching.
 *
 * Uses wide cards rather than posters: these represent a *moment in a file*,
 * not a title, so the episode still and a progress bar carry the useful
 * information. Poster cards would make a half-watched episode look like a
 * fresh show.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect } from 'react';
import Art from './Art';
import FocusButton from './FocusButton';
import type { ContinueItem } from '../player/api';

interface Props {
  items: ContinueItem[];
  onResume: (item: ContinueItem) => void;
  onRemove: (item: ContinueItem) => void;
}

function remainingLabel(item: ContinueItem): string {
  // A next-up episode has never been played, so there is no "remaining" to
  // report — its duration is unknown and its position is zero. Saying "45 min
  // left" about something not started would be a guess dressed as a measurement.
  if (item.is_next_up || !item.duration_secs) return '';
  const left = Math.max(0, item.duration_secs - item.position_secs);
  const mins = Math.round(left / 60);
  return mins > 0 ? `${mins} min left` : 'nearly done';
}

export default function ContinueRail({ items, onResume, onRemove }: Props) {
  const { ref, focusKey } = useFocusable({ trackChildren: true, saveLastFocusedChild: true });

  if (items.length === 0) return null;

  return (
    <FocusContext.Provider value={focusKey}>
      <section className="rail" ref={ref}>
        <h2 className="rail-heading">Continue watching</h2>
        <div className="rail-track">
          {items.map((item) => (
            <ContinueCard
              key={item.file_id}
              item={item}
              onResume={onResume}
              onRemove={onRemove}
            />
          ))}
        </div>
      </section>
    </FocusContext.Provider>
  );
}

/**
 * One card: the artwork and text, plus a Remove control beneath it.
 *
 * The card is a focus container with two children rather than one focusable,
 * for the reason in GOTCHAS.md — a focusable drawn *inside* another focusable
 * cannot be reached by D-pad at all.
 *
 * Remove sits **below** the card rather than overlaid on the corner, and that
 * is a navigation decision, not a visual one. Spatial movement is geometric: an
 * overlaid button lies inside the card's own rectangle, so no direction can ever
 * reach it. Below the card, Down reaches it and Left/Right still steps one card
 * at a time — putting it beside the card would have doubled the presses needed
 * to travel the rail.
 */
function ContinueCard({
  item,
  onResume,
  onRemove,
}: {
  item: ContinueItem;
  onResume: (i: ContinueItem) => void;
  onRemove: (i: ContinueItem) => void;
}) {
  const { ref, focusKey, hasFocusedChild } = useFocusable({
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  return (
    <FocusContext.Provider value={focusKey}>
      <div className={`continue-card ${hasFocusedChild ? 'card-active' : ''}`} ref={ref}>
        <ContinueCardBody item={item} onResume={onResume} />
        <FocusButton className="continue-remove" onSelect={() => onRemove(item)}>
          ✕ Remove
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}

function ContinueCardBody({
  item,
  onResume,
}: {
  item: ContinueItem;
  onResume: (i: ContinueItem) => void;
}) {
  const { ref, focused } = useFocusable<object, HTMLDivElement>({
    onEnterPress: () => onResume(item),
  });

  useEffect(() => {
    if (focused) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [focused, ref]);

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
      ref={ref}
      className={`continue-body ${focused ? 'focused' : ''}`}
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
        {/* Drawn only where there is progress to draw. An empty bar under a
            next-up card looks like a card that failed to load its position. */}
        {!item.is_next_up && (
          <div className="continue-progress">
            <div className="continue-progress-fill" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      <div className="continue-title">{item.title}</div>
      <div className="continue-meta">{subtitle}</div>
      <div className="continue-remaining">
        {item.is_next_up ? 'Next episode' : remainingLabel(item)}
      </div>
    </div>
  );
}
