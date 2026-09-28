/**
 * Which title fills the top of Home.
 *
 * It was always the newest addition, so the same picture sat there for weeks
 * and the same show then appeared again right below it in Continue watching.
 * Now:
 *
 *  - Something added in the last few days and not yet watched still gets the
 *    spotlight — that is what new arrivals are for.
 *  - Otherwise a different title each day, from what you have not finished,
 *    never the one already first in Continue watching.
 *  - Only titles with a backdrop, while any have one: the hero is a picture.
 *
 * "Each day" is by the calendar, not by launch, so reopening the app does not
 * reshuffle it. Pure, with the clock passed in, so it is testable.
 */
import type { Title } from './api';

const NEW_FOR_DAYS = 3;
const DAY_MS = 86_400_000;

/** Days since the epoch in local time, so the pick changes at midnight here. */
function localDay(now: number): number {
  const d = new Date(now);
  return Math.floor((now - d.getTimezoneOffset() * 60_000) / DAY_MS);
}

export function pickHero(titles: Title[], continueFirst: number | null, now: number): Title | null {
  const withBackdrop = titles.filter((t) => t.backdrop_url || t.backdrop_path);
  const pictures = withBackdrop.length > 0 ? withBackdrop : titles;
  if (pictures.length === 0) return null;

  const candidates = pictures.filter((t) => !t.watched && t.id !== continueFirst);
  const pool = candidates.length > 0 ? candidates : pictures;

  // added_at is in seconds.
  const since = now / 1000 - NEW_FOR_DAYS * 86_400;
  const fresh = pool
    .filter((t) => (t.added_at ?? 0) >= since)
    .sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0));
  if (fresh.length > 0) return fresh[0];

  const stable = [...pool].sort((a, b) => a.id - b.id);
  return stable[localDay(now) % stable.length];
}
