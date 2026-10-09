/**
 * "Stats for nerds": what the pipeline is actually doing, as the engine says
 * it (mpv's properties, or Media3's own facts).
 */
import { useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect } from 'react';
import FocusButton from '../ui/FocusButton';
import type { StatGroup } from './stats';

/** Its close button, where the ring goes when a remote opened it (usePanels.ts). */
export const STATS_CLOSE_KEY = 'player-stats-close';

export default function StatsPanel({
  stats,
  onClose,
}: {
  stats: StatGroup[];
  onClose: () => void;
}) {
  return (
    <aside className="stats-panel">
      <div className="stats-head">
        <span>Stats for nerds</span>
        <FocusButton focusKey={STATS_CLOSE_KEY} onSelect={onClose}>
          close
        </FocusButton>
      </div>
      {stats.length === 0 && <div className="stats-empty">reading…</div>}
      {stats.map((group) => (
        <Group key={group.heading} group={group} />
      ))}
    </aside>
  );
}

/**
 * One group, a stop for a remote's ring. The panel is taller than a TV's
 * screen leaves it (the old box showed it cut off after Frames, 2026-10-05),
 * and with only the close button to land on a remote could not scroll to the
 * rest — so Down goes group by group, each brought into view. Nothing happens
 * on OK: it is there to be read. A mouse scrolls the panel as before.
 */
function Group({ group }: { group: StatGroup }) {
  const { ref, focused } = useFocusable<object, HTMLElement>();
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focused, ref]);
  return (
    <section
      ref={ref}
      className={`stats-group ${group.wideLabels ? 'wide-labels' : ''} ${focused ? 'focused' : ''}`}
    >
      <h3>{group.heading}</h3>
      {group.rows.map((row) => (
        <div key={row.label} className={`stats-row ${row.warn ? 'warn' : ''}`}>
          <span className="stats-label">{row.label}</span>
          <span className="stats-value">
            {row.value}
            {row.note && <em className="stats-note">{row.note}</em>}
          </span>
        </div>
      ))}
    </section>
  );
}
