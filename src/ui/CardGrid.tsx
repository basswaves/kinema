/**
 * The cards of a grid — a shelf from the top bar, a See-all, search results —
 * as one focus area that moves by index (focusModel.ts, `gridStep`): a press
 * costs the same at fifty titles and at a thousand, and nothing is measured
 * but how many cards fit across, read when the grid is resized.
 *
 * An area of its own, not the view's: the view's other controls (Back, the
 * order buttons, the search box) are not cards. A press that runs out of
 * cards (Up from the first row) goes on to the view around it.
 */
import { useEffect, useMemo, useState } from 'react';
import Card from './Card';
import { FocusProvider } from './FocusGroup';
import { useNavGroup } from './focusGroups';
import type { Title } from './api';

interface Props {
  /** Prefixes the cards' focus keys (`grid:7`), so Back can find one again. */
  name: 'grid' | 'search';
  /** `why`: the line under the title saying why it is here (search). */
  entries: { title: Title; why?: string | null }[];
  onSelect: (title: Title) => void;
  /** Arriving from above lands on the first card, not the one last on: the
   *  shelf, under its order buttons (NAV-MAP, agreed 2026-10-11). */
  fromAboveFirst?: boolean;
}

export default function CardGrid({ name, entries, onSelect, fromAboveFirst = false }: Props) {
  const keys = useMemo(() => entries.map(({ title }) => `${name}:${title.id}`), [entries, name]);

  /** How many cards fit across, read when the grid is resized, not per press. */
  const [across, setAcross] = useState(1);

  const { ref, focusKey } = useNavGroup<HTMLDivElement>(
    {
      kind: 'grid',
      columns: across,
      // From above, the first card (NAV-MAP); Back finds its card by key.
      current: keys[0],
      remember: !fromAboveFirst,
      disabled: entries.length === 0,
    },
    // Back from a film's page finds its card by key (`grid:7`), not by
    // remembering, so the shelf can afford to forget.
    { focusKey: `${name}-cards` }
  );

  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const read = () => {
      const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean);
      setAcross(Math.max(1, tracks.length));
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(grid);
    return () => watch.disconnect();
  }, [ref]);

  return (
    <FocusProvider value={focusKey}>
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
    </FocusProvider>
  );
}
