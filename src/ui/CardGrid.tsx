/**
 * The cards of a grid — a shelf from the top bar, a See-all, search results —
 * as one focus group that moves by index.
 *
 * Left to itself the spatial library answers every arrow press by measuring all
 * the cards beside the focused one and sorting them by distance, which is
 * fine for a rail of thirty and slow for a shelf of a thousand on a TV box.
 * Here `nextFocusResolver` takes over (gridMove.ts) and
 * `measureChildrenLayout: false` stops the measuring, so a press costs the
 * same at fifty titles and at a thousand.
 *
 * A group of its own, not the view's: the view's other controls (Back, the
 * order buttons, the search box) are not cards, and a resolver on their
 * container would replace the library's search for them too — see
 * docs/GOTCHAS.md, "Spatial navigation". A press that runs out of cards
 * (Up from the first row) returns null and goes on to the view's own search,
 * which treats the whole grid as one block.
 */
import {
  FocusContext,
  useFocusable,
  type Direction,
  type FocusableComponent,
} from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import Card from './Card';
import { gridMove } from './gridMove';
import type { Title } from './api';

interface Props {
  /** Prefixes the cards' focus keys (`grid:7`), so Back can find one again. */
  name: 'grid' | 'search';
  /** `why`: the line under the title saying why it is here (search). */
  entries: { title: Title; why?: string | null }[];
  onSelect: (title: Title) => void;
}

export default function CardGrid({ name, entries, onSelect }: Props) {
  const keys = useMemo(() => entries.map(({ title }) => `${name}:${title.id}`), [entries, name]);
  const positions = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);

  /** How many cards fit across, read when the grid is resized, not per press. */
  const columns = useRef(1);

  const resolve = useCallback(
    (direction: Direction, from: string, siblings: FocusableComponent[]) => {
      const index = positions.get(from);
      if (index === undefined) return null;
      const to = gridMove(direction, index, keys.length, columns.current);
      return to === null ? null : (siblings.find((s) => s.focusKey === keys[to]) ?? null);
    },
    [positions, keys]
  );

  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: `${name}-cards`,
    saveLastFocusedChild: true,
    // A group with no cards is nowhere to move to — see Rail.tsx.
    focusable: entries.length > 0,
    // When the card last on is gone (a filter), the first one, not a search
    // by position that would measure them all.
    preferredChildFocusKey: keys[0],
    nextFocusResolver: resolve,
    measureChildrenLayout: false,
  });

  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const read = () => {
      const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean);
      columns.current = Math.max(1, tracks.length);
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(grid);
    return () => watch.disconnect();
  }, [ref]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="search-grid" ref={ref}>
        {entries.map(({ title, why }) => (
          <Card
            key={title.id}
            title={title}
            note={why}
            onSelect={onSelect}
            focusKey={`${name}:${title.id}`}
          />
        ))}
      </div>
    </FocusContext.Provider>
  );
}
