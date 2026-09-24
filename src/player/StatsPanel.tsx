/**
 * "Stats for nerds": what the pipeline is actually doing, read from mpv.
 */
import FocusButton from '../ui/FocusButton';
import type { StatGroup } from './stats';

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
        <FocusButton onSelect={onClose}>close</FocusButton>
      </div>
      {stats.length === 0 && <div className="stats-empty">reading…</div>}
      {stats.map((group) => (
        <section
          key={group.heading}
          className={`stats-group ${group.wideLabels ? 'wide-labels' : ''}`}
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
      ))}
    </aside>
  );
}
