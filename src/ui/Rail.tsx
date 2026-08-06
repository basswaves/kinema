/**
 * A horizontally scrolling row of cards, as a focusable group so left/right
 * moves within the rail and up/down moves between rails.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import Card from './Card';
import type { Title } from './api';

interface Props {
  heading: string;
  titles: Title[];
  onSelect: (title: Title) => void;
}

export default function Rail({ heading, titles, onSelect }: Props) {
  const { ref, focusKey } = useFocusable({ trackChildren: true, saveLastFocusedChild: true });

  if (titles.length === 0) return null;

  return (
    <FocusContext.Provider value={focusKey}>
      <section className="rail" ref={ref}>
        <h2 className="rail-heading">{heading}</h2>
        <div className="rail-track">
          {titles.map((title) => (
            <Card key={title.id} title={title} onSelect={onSelect} />
          ))}
        </div>
      </section>
    </FocusContext.Provider>
  );
}
