/**
 * "Stats for nerds": what the pipeline is actually doing, as the engine says
 * it (mpv's properties, or Media3's own facts).
 */
import FocusButton from '../ui/FocusButton';
import { FocusProvider } from '../ui/FocusGroup';
import { ALL_ARROWS, useFocusGroup, useFocusLeaf } from '../ui/focusGroups';
import type { StatGroup } from './stats';

/** Its close button, where the ring lands when it opens from Audio & subtitles. */
export const STATS_CLOSE_KEY = 'player-stats-close';

export default function StatsPanel({
  stats,
  dialog,
  onClose,
}: {
  stats: StatGroup[];
  /** Opened from Audio & subtitles: the ring goes in. On `i` it stays where it was. */
  dialog: boolean;
  onClose: () => void;
}) {
  // A closed menu, like Audio & subtitles: Down from a group reaches the next
  // group, never the player's controls. Left open to them, the next group and
  // Pause were both "below", and while the panel was still scrolling the last
  // group into view Pause could be the nearer one (CI's WebKit, 2026-10-16).
  // On `i` it is beside the film, not a dialog, and arrows from the
  // controls pass it by.
  const { ref, focusKey } = useFocusGroup<HTMLElement>('menu', {
    current: STATS_CLOSE_KEY,
    modal: dialog,
    passOver: dialog ? undefined : ALL_ARROWS,
  });
  return (
    <FocusProvider value={focusKey}>
      <aside className="stats-panel" ref={ref}>
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
    </FocusProvider>
  );
}

/**
 * One group, a stop for a remote's ring. The panel is taller than a TV's
 * screen leaves it (the old box showed it cut off after Frames, 2026-10-05),
 * and with only the close button to land on a remote could not scroll to the
 * rest — so Down goes group by group, each brought into view (the player's
 * `nearest` scroll, focusScroll.ts). Nothing happens on OK: it is there to be
 * read. A mouse scrolls the panel as before.
 */
function Group({ group }: { group: StatGroup }) {
  const { ref, focused, navProps } = useFocusLeaf<HTMLElement>({});
  return (
    <section
      ref={ref}
      {...navProps}
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
