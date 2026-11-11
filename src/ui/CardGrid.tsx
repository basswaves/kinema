/**
 * The cards of a grid — a shelf from the top bar, a See-all, search results —
 * as one focus area that moves by index (focusModel.ts, `gridStep`): a press
 * costs the same at fifty titles and at a thousand, and nothing is measured
 * but how many cards fit across, read when the grid is resized.
 *
 * An area of its own, not the view's: the view's other controls (Back, the
 * order buttons, the search box) are not cards. A press that runs out of
 * cards (Up from the first row) goes on to the view around it.
 *
 * A big grid draws only the rows on screen and a few around them (round 8,
 * part I): a thousand cards are six thousand elements and a thousand
 * pictures, which a weak computer pays for on every press (measured on a
 * 2-core PC: 100 ms a frame against 17 ms) and with memory the pictures
 * keep. Empty space stands in for the rows left out, so the page is as tall
 * and scrolls the same. The ring always has rows ahead of it, so the
 * engine's steps by index never meet the end of what is drawn.
 */
import { startTransition, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import Card from './Card';
import { FocusProvider } from './FocusGroup';
import { useNavGroup } from './focusGroups';
import { pageOf } from './focusScroll';
import { navFocused, navWanted, navWatch } from './focusStore';
import type { Title } from './api';

/** Fewer cards than this are drawn whole. */
const WINDOW_FROM = 120;
/** Rows drawn above and below what is on screen (and around the ring). */
const OVERSCAN_ROWS = 3;
/** The drawn rows move in steps of this many, so a slow scroll changes them seldom. */
const STEP_ROWS = 4;
/** Rows drawn before the first measurement of a row's height. */
const FIRST_ROWS = 8;

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
  const indexOf = useMemo(() => new Map(keys.map((key, i) => [key, i])), [keys]);

  /** How many cards fit across, read when the grid is resized, not per press. */
  const [across, setAcross] = useState(1);
  /** The distance from one row's top to the next, 0 until measured. */
  const [pitch, setPitch] = useState(0);
  /** The space between two rows, for the empty space between two drawn parts. */
  const [rowGap, setRowGap] = useState(0);
  /**
   * The rows drawn: from, up to (not including); then the ring's own rows when
   * they are far from those (from, up to; equal when there are none).
   */
  const [rows, setRows] = useState<[number, number, number, number]>([0, FIRST_ROWS, 0, 0]);

  // Rows of different heights (a note under a card) cannot be left out by
  // arithmetic: those grids are small (search) and drawn whole.
  const windowed = entries.length > WINDOW_FROM && !entries.some((entry) => entry.why);
  const rowCount = Math.ceil(entries.length / across);

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
      const style = getComputedStyle(grid);
      setAcross(Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length));
      setRowGap(parseFloat(style.rowGap) || 0);
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(grid);
    return () => watch.disconnect();
  }, [ref]);

  // A row's height, from two rows that are drawn (offsets, so the focused
  // card's scaling does not count). Read again after every change of width.
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!windowed || !grid || grid.children.length <= across) return;
    const next = (grid.children[across] as HTMLElement).offsetTop - (grid.children[0] as HTMLElement).offsetTop;
    if (next > 0 && Math.abs(next - pitch) > 0.5) setPitch(next);
    // `rows` too: the measure is taken again whenever the window moves.
  }, [ref, windowed, across, pitch, rows]);

  // Which rows to draw: the ones on screen, and the ones around the ring.
  // Where Back is returning to, only that place: the page is put there
  // next, and the card must be drawn when it is.
  useEffect(() => {
    const grid = ref.current;
    if (!windowed || !grid || pitch <= 0) return;
    const page = pageOf(grid);
    let frame = 0;
    const rowOf = (key: string | null) => {
      const at = key === null ? undefined : indexOf.get(key);
      return at === undefined ? -1 : Math.floor(at / across);
    };
    const update = (urgent = true) => {
      frame = 0;
      let from: number;
      let to: number;
      // The ring's rows, kept drawn apart from the rest when the page has
      // scrolled away from them (a wheel, the scroll bar). Left out, the card
      // holding the ring would go, and the focus engine would put the ring on
      // another card and scroll the page back to it: a wheel turned fast lost
      // most of its distance (round 8, part I2).
      let island: [number, number] = [0, 0];
      const wanted = rowOf(navWanted());
      if (wanted >= 0) {
        from = wanted - OVERSCAN_ROWS;
        to = wanted + OVERSCAN_ROWS + 1;
      } else {
        const top = page ? page.getBoundingClientRect().top : 0;
        const offset = grid.getBoundingClientRect().top - top + (page?.scrollTop ?? 0);
        const seen = page ? page.clientHeight : window.innerHeight;
        from = Math.floor(((page?.scrollTop ?? 0) - offset) / pitch) - OVERSCAN_ROWS;
        to = Math.floor(((page?.scrollTop ?? 0) + seen - offset) / pitch) + OVERSCAN_ROWS + 1;
        // The ring's row too, when it is near: a press steps to the next
        // row at once, before the page has scrolled and drawn more.
        const ring = rowOf(navFocused());
        if (ring >= 0 && ring + OVERSCAN_ROWS >= from - 2 && ring - OVERSCAN_ROWS <= to + 2) {
          from = Math.min(from, ring - OVERSCAN_ROWS);
          to = Math.max(to, ring + OVERSCAN_ROWS + 1);
        } else if (ring >= 0) {
          island = [Math.max(0, ring - OVERSCAN_ROWS), Math.min(rowCount, ring + OVERSCAN_ROWS + 1)];
        }
      }
      from = Math.max(0, Math.floor(from / STEP_ROWS) * STEP_ROWS);
      to = Math.max(from + 1, Math.min(rowCount, Math.ceil(to / STEP_ROWS) * STEP_ROWS));
      const [a, b] = island;
      const set = () =>
        setRows((now) =>
          now[0] === from && now[1] === to && now[2] === a && now[3] === b ? now : [from, to, a, b]
        );
      // A scroll can wait for a quiet moment between frames (the rows ahead are
      // already drawn); the ring cannot: its next press needs its rows now.
      if (urgent) set();
      else startTransition(set);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => update(false));
    };
    update(true);
    page?.addEventListener('scroll', schedule, { passive: true });
    const unwatch = navWatch(focusKey, () => update(true));
    const resize = new ResizeObserver(schedule);
    if (page) resize.observe(page);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      page?.removeEventListener('scroll', schedule);
      unwatch();
      resize.disconnect();
    };
  }, [ref, windowed, pitch, across, rowCount, indexOf, focusKey]);

  // The drawn parts, in order, with empty space for the rows between them: one
  // element across the grid, as tall as those rows less the gap the grid adds
  // after it, so every card stays where it would be in the whole grid.
  const card = ({ title, why }: Props['entries'][number]) => (
    <Card key={title.id} title={title} note={why} onSelect={onSelect} focusKey={`${name}:${title.id}`} />
  );
  let content: ReactNode = entries.map(card);
  let style: { paddingTop: number; paddingBottom: number } | undefined;
  if (windowed) {
    const clamp = (r: number) => Math.max(0, Math.min(rowCount, r));
    const parts =
      pitch > 0
        ? [
            [clamp(Math.min(rows[0], rowCount - 1)), clamp(rows[1])],
            [clamp(rows[2]), clamp(rows[3])],
          ]
            .filter(([a, b]) => b > a)
            .sort((p, q) => p[0] - q[0])
            .reduce<number[][]>((out, [a, b]) => {
              const last = out[out.length - 1];
              if (last && a <= last[1]) last[1] = Math.max(last[1], b);
              else out.push([a, b]);
              return out;
            }, [])
        : [[0, Math.min(rowCount, FIRST_ROWS)]];
    content = parts.flatMap(([a, b], i) => [
      ...(i > 0
        ? [
            <div
              key={`gap-${a}`}
              className="search-grid-gap"
              aria-hidden="true"
              style={{ height: Math.max(0, (a - parts[i - 1][1]) * pitch - rowGap) }}
            />,
          ]
        : []),
      ...entries.slice(a * across, b * across).map(card),
    ]);
    if (pitch > 0) {
      style = { paddingTop: parts[0][0] * pitch, paddingBottom: (rowCount - parts[parts.length - 1][1]) * pitch };
    }
  }

  return (
    <FocusProvider value={focusKey}>
      <div className="search-grid" ref={ref} style={style}>
        {content}
      </div>
    </FocusProvider>
  );
}
