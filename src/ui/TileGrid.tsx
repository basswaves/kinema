/**
 * Tiles that wrap (playlists, Videos folders, a folder's videos) as a grid on
 * Kinema's own engine (focusModel.ts): moved by index, so a window narrower or
 * a tile wider changes how many fit across and nothing else. The count across
 * is read from the tiles when the box is resized, never per press.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { FocusProvider } from './FocusGroup';
import { useNavGroup } from './focusGroups';

/** How many tiles sit on the first line: those level with the first one. */
function across(box: HTMLElement): number {
  const tiles = Array.from(box.children) as HTMLElement[];
  if (tiles.length === 0) return 1;
  const top = tiles[0].offsetTop;
  let n = 0;
  while (n < tiles.length && tiles[n].offsetTop === top) n++;
  return Math.max(1, n);
}

export default function TileGrid({
  className,
  focusKey,
  count,
  children,
}: {
  className: string;
  focusKey?: string;
  /** The tiles drawn: a change re-reads how many fit across. */
  count: number;
  children: ReactNode;
}) {
  const [columns, setColumns] = useState(1);
  const { ref, focusKey: key } = useNavGroup<HTMLDivElement>(
    { kind: 'grid', columns, remember: true, disabled: count === 0 },
    { focusKey, focusable: count > 0 }
  );
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const read = () => setColumns(across(box));
    read();
    const watch = new ResizeObserver(read);
    watch.observe(box);
    return () => watch.disconnect();
  }, [ref, count]);
  return (
    <FocusProvider value={key}>
      <div className={className} ref={ref}>
        {children}
      </div>
    </FocusProvider>
  );
}
