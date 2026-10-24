/**
 * Play something: one press for the evening nobody can choose (PLAN phase 2).
 *
 * What it may pick: a film not yet watched, or a show you are in the middle
 * of (some episodes watched, or one stopped part-way), whose next episode is
 * what plays. Only when there is none of either, any title not yet watched —
 * a show not started begins at its first episode. Within a genre or a
 * collection the same, among its titles only.
 *
 * What it never picks: titles are matched (or kept without a match) by the
 * time they are titles, so nothing in Needs attention is one, and a Videos
 * clip is never a title (videos.rs).
 *
 * Random, but not the last few picks again: "Another" has to mean another.
 */
import type { Title } from './api';

/** How many recent picks are kept out while there is anything else. */
export const RECENT_PICKS = 5;

/** The ids picked lately in this run of the app, newest first. */
const recent: number[] = [];

export interface Pool {
  titles: Title[];
  /** Why a pick is from where it is: "Drama", "Movies" — or none on Home. */
  from: string | null;
}

/** Started and not finished: the title has a resume point, or part of a show is watched. */
function inTheMiddle(title: Title, resuming: ReadonlySet<number>): boolean {
  if (title.watched) return false;
  if (resuming.has(title.id) || title.progress !== null) return true;
  return title.kind === 'series' && title.episodes_watched > 0;
}

/** What may be picked from these titles. */
export function candidates(titles: Title[], resuming: ReadonlySet<number>): Title[] {
  const first = titles.filter(
    (t) =>
      (t.kind === 'movie' && !t.watched) || (t.kind === 'series' && inTheMiddle(t, resuming))
  );
  if (first.length > 0) return first;
  return titles.filter((t) => !t.watched && (t.kind === 'movie' || t.kind === 'series'));
}

/**
 * One of `from`, not one of the last few picks unless nothing else is left —
 * then the one picked longest ago. `random` is for tests.
 */
export function pick(
  from: Title[],
  recentIds: readonly number[] = recent,
  random: () => number = Math.random
): Title | null {
  if (from.length === 0) return null;
  const blocked = new Set(recentIds.slice(0, Math.min(RECENT_PICKS, from.length - 1)));
  const open = from.filter((t) => !blocked.has(t.id));
  const pool = open.length > 0 ? open : from;
  return pool[Math.floor(random() * pool.length)] ?? pool[0];
}

/** Remember a pick, so the next few presses choose something else. */
export function remember(title: Title, into: number[] = recent): void {
  const at = into.indexOf(title.id);
  if (at >= 0) into.splice(at, 1);
  into.unshift(title.id);
  into.length = Math.min(into.length, RECENT_PICKS * 2);
}

/** The one line under the pick saying why it was picked. */
export function whyLine(
  title: Title,
  resuming: boolean,
  next: string | null,
  from: string | null
): string {
  const line = (rest: string) =>
    from ? `From ${from}: ${rest}` : rest.charAt(0).toUpperCase() + rest.slice(1);
  if (title.kind === 'series') {
    if (title.episodes_watched === 0 && !resuming) {
      return line(`a show you have not started${next ? ` · ${next}` : ''}`);
    }
    const held = `${title.episodes_watched} of ${title.episodes_owned} episodes watched`;
    return line(`you are in the middle of it · ${held}${next ? ` · next ${next}` : ''}`);
  }
  if (resuming) return line('a film you stopped part-way through');
  const length = title.runtime_mins ? ` · ${formatRuntime(title.runtime_mins)}` : '';
  return line(`a film you have not seen${length}`);
}

function formatRuntime(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** The Play something key, on Home and on a genre or collection page. */
export const PLAY_SOMETHING_KEY = 's';

export function isPlaySomethingKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.key.toLowerCase() !== PLAY_SOMETHING_KEY) return false;
  const target = e.target as HTMLElement | null;
  return !(target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable);
}
