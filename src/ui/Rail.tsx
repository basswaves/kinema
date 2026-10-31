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
import { memo } from 'react';
import Card from './Card';
import FocusButton from './FocusButton';
import { FocusProvider } from './FocusGroup';
import { useNavGroup } from './focusGroups';
import RailTrack from './RailTrack';
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
  /** A kept collection's: its page is always one press away, short or not. */
  openLabel?: string;
}

export default memo(function Rail({ heading, titles, onSelect, onSeeAll, openLabel }: Props) {
  // Not a place to move to while empty — see ContinueRail.tsx. A row that
  // comes back to the card last on (NAV-MAP, agreed 2026-10-11).
  const { ref, focusKey } = useNavGroup(
    { kind: 'row', remember: true, disabled: titles.length === 0 },
    { focusable: titles.length > 0 }
  );

  // Empty, still its element, unseen: the focus area measures it once, at
  // mount ("Component added without a node reference" otherwise). Same shape
  // as below, so React keeps the one element when there is something to show.
  if (titles.length === 0) {
    return (
      <FocusProvider value={focusKey}>
        <section className="rail" ref={ref} style={{ display: 'none' }} />
      </FocusProvider>
    );
  }

  const shown = titles.slice(0, RAIL_LIMIT);
  const hasMore = Boolean(onSeeAll) && (titles.length > shown.length || Boolean(openLabel));

  return (
    <FocusProvider value={focusKey}>
      <section className="rail" ref={ref} aria-label={heading}>
        <h2 className="rail-heading">
          {/* The heading opens the whole shelf, as See all does, for a mouse
              that cannot reach the end of the row (GitHub #12). Out of the
              focus tree: See all is the remote's way there. */}
          {hasMore ? (
            <button
              type="button"
              tabIndex={-1}
              className="rail-heading-link"
              title={openLabel ?? `See all ${titles.length}`}
              onClick={() => onSeeAll?.(heading, titles)}
            >
              {heading}
            </button>
          ) : (
            heading
          )}
          {hasMore && titles.length > shown.length && <span className="rail-count">{titles.length}</span>}
        </h2>
        <RailTrack>
          {shown.map((title) => (
            <Card
              key={title.id}
              title={title}
              onSelect={onSelect}
              focusKey={`rail:${heading}:${title.id}`}
            />
          ))}
          {/* At the end of the row rather than beside the heading: that is
              where you arrive having scrolled to the end, and it keeps the
              rail one straight line for a D-pad. Next to the heading it would
              sit above the cards and compete with moving to the rail above. */}
          {hasMore && (
            <FocusButton
              focusKey={`rail:${heading}:see-all`}
              className="see-all-card"
              onSelect={() => onSeeAll?.(heading, titles)}
            >
              <span className="see-all-arrow">→</span>
              <span className="see-all-label">{openLabel ?? `See all ${titles.length}`}</span>
            </FocusButton>
          )}
        </RailTrack>
      </section>
    </FocusProvider>
  );
});
