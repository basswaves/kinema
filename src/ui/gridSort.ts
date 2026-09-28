/**
 * The order and filter of a full grid (See all, Movies, TV shows).
 *
 * A grid used to be the rail it came from in the rail's order and nothing
 * else — fine for twelve titles, no way to find anything in three hundred.
 */
import type { Title } from './api';

export type GridSort = 'added' | 'az' | 'year' | 'rating';

export const GRID_SORTS: { value: GridSort; label: string }[] = [
  { value: 'added', label: 'Recently added' },
  { value: 'az', label: 'A–Z' },
  { value: 'year', label: 'Year' },
  { value: 'rating', label: 'Rating' },
];

/** "The Matrix" files under M, as on any shelf. */
function sortName(title: string): string {
  return title.replace(/^(the|a|an)\s+/i, '');
}

export function arrangeGrid(titles: Title[], sort: GridSort, unwatchedOnly: boolean): Title[] {
  const list = unwatchedOnly ? titles.filter((t) => !t.watched) : [...titles];
  const byName = (a: Title, b: Title) =>
    sortName(a.title).localeCompare(sortName(b.title), undefined, { sensitivity: 'base' });
  switch (sort) {
    case 'az':
      return list.sort(byName);
    case 'year':
      return list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || byName(a, b));
    case 'rating':
      return list.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || byName(a, b));
    default:
      return list.sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0) || byName(a, b));
  }
}

/** Settings key the choice is remembered under, per grid. */
export const gridSettingKey = (heading: string) => `grid_view:${heading}`;

export function parseGridSetting(raw: string | null): { sort: GridSort; unwatched: boolean } {
  const [sort, unwatched] = (raw ?? '').split(':');
  const known = GRID_SORTS.some((s) => s.value === sort);
  return { sort: known ? (sort as GridSort) : 'added', unwatched: unwatched === 'unwatched' };
}
