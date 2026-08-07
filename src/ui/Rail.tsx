/**
 * A horizontally scrolling row of cards, as a focusable group so left/right
 * moves within the rail and up/down moves between rails.
 *
 * Rails are **capped**. Every card is a DOM subtree and a registered focusable,
 * and spatial navigation is configured to measure elements live at navigation
 * time — so an uncapped "Movies" rail on a large library puts hundreds of them
 * on the page, several times over once the genre rails repeat the same titles.
 * Nobody scrolls a rail of five hundred anyway; that is what the grid is for.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import Card from './Card';
import FocusButton from './FocusButton';
import type { Title } from './api';

/** How many cards a rail shows before deferring to "See all". */
export const RAIL_LIMIT = 30;

interface Props {
  heading: string;
  /** The full list. The cap is applied here so it is applied once. */
  titles: Title[];
  onSelect: (title: Title) => void;
  /** Omitted for rails that cannot meaningfully be expanded. */
  onSeeAll?: (heading: string, titles: Title[]) => void;
}

export default function Rail({ heading, titles, onSelect, onSeeAll }: Props) {
  const { ref, focusKey } = useFocusable({ trackChildren: true, saveLastFocusedChild: true });

  if (titles.length === 0) return null;

  const shown = titles.slice(0, RAIL_LIMIT);
  const hasMore = Boolean(onSeeAll) && titles.length > shown.length;

  return (
    <FocusContext.Provider value={focusKey}>
      <section className="rail" ref={ref}>
        <h2 className="rail-heading">
          {heading}
          {hasMore && <span className="rail-count">{titles.length}</span>}
        </h2>
        <div className="rail-track">
          {shown.map((title) => (
            <Card key={title.id} title={title} onSelect={onSelect} />
          ))}
          {/* At the end of the row rather than beside the heading: that is
              where you arrive having scrolled to the end, and it keeps the
              rail one straight line for a D-pad. Next to the heading it would
              sit above the cards and compete with moving to the rail above. */}
          {hasMore && (
            <FocusButton
              className="see-all-card"
              keepInView="nearest"
              onSelect={() => onSeeAll?.(heading, titles)}
            >
              <span className="see-all-arrow">→</span>
              <span className="see-all-label">See all {titles.length}</span>
            </FocusButton>
          )}
        </div>
      </section>
    </FocusContext.Provider>
  );
}
