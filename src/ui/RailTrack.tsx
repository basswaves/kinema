/**
 * A rail's row of cards, with arrows at its edges for a mouse.
 *
 * The row scrolls sideways and hides its scrollbar, and a vertical wheel
 * scrolls the page, so with a mouse alone the cards past the edge — and the
 * See all card at the end — could not be reached (GitHub #12). The arrows show
 * while the pointer is over the rail and only on a side that has more.
 *
 * Mouse only on purpose: left and right already move along the rail from a
 * keyboard or remote, and the ring scrolls it. An arrow in the focus tree would
 * be one more stop between the rail and the next. The wheel is left alone:
 * rails fill most of Home, and a wheel turned sideways over them would leave
 * the page with almost nowhere to scroll down from.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { isLightLook } from './lightLook';

interface Edges {
  left: boolean;
  right: boolean;
}

export default function RailTrack({ children }: { children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ left: false, right: false });

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);

  // Cards come and go (My list, a scan) and the window changes size: measured
  // after every render and on resize. Cheap — three reads, and state only moves
  // when an edge does.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  const page = (direction: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    // Most of a screen, so the card cut off at the edge is whole on the next.
    el.scrollBy({
      left: direction * Math.max(el.clientWidth * 0.8, 200),
      behavior: isLightLook() ? 'auto' : 'smooth',
    });
  };

  return (
    <div className="rail-scroller">
      <div className="rail-track" ref={track} onScroll={measure}>
        {children}
      </div>
      {edges.left && (
        <button
          type="button"
          tabIndex={-1}
          className="rail-edge rail-edge-left"
          aria-label="Scroll left"
          onClick={() => page(-1)}
        >
          ‹
        </button>
      )}
      {edges.right && (
        <button
          type="button"
          tabIndex={-1}
          className="rail-edge rail-edge-right"
          aria-label="Scroll right"
          onClick={() => page(1)}
        >
          ›
        </button>
      )}
    </div>
  );
}
