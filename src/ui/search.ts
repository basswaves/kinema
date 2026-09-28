/**
 * Search, over what the library already holds in memory.
 *
 * It matched titles only, so "the one with Tom Hanks" or "something from
 * 1999" found nothing. Now a query is tried against the title, the year, the
 * genres and the cast, best matches first; a title found through an actor or
 * a genre says so under its poster, or it would look like a wrong result.
 */
import { parseGenres, type Title } from './api';

export interface SearchHit {
  title: Title;
  /** Why it matched, when that is not the title itself: "with …", a genre. */
  why: string | null;
}

/** Case and accents do not matter: "amelie" finds "Amélie". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Starts the text, or starts one of its words. */
function wordStart(haystack: string, needle: string): boolean {
  return haystack.startsWith(needle) || haystack.includes(` ${needle}`);
}

function score(title: Title, needle: string): { rank: number; why: string | null } | null {
  const name = fold(title.title);
  if (name.startsWith(needle)) return { rank: 0, why: null };
  if (wordStart(name, needle)) return { rank: 1, why: null };
  if (/^\d{4}$/.test(needle) && String(title.year ?? '') === needle) return { rank: 2, why: null };
  if (name.includes(needle)) return { rank: 3, why: null };
  // Two letters would match half the cast of every film.
  if (needle.length >= 3) {
    const actor = title.cast.find((person) => wordStart(fold(person), needle));
    if (actor) return { rank: 4, why: `with ${actor}` };
    const genre = parseGenres(title.genres).find((g) => fold(g).startsWith(needle));
    if (genre) return { rank: 5, why: genre };
  }
  return null;
}

export function searchTitles(titles: Title[], query: string): SearchHit[] {
  const needle = fold(query.trim());
  if (!needle) return titles.map((title) => ({ title, why: null }));
  return titles
    .map((title) => ({ title, found: score(title, needle) }))
    .filter((x): x is { title: Title; found: { rank: number; why: string | null } } => x.found !== null)
    .sort((a, b) => a.found.rank - b.found.rank || a.title.title.localeCompare(b.title.title))
    .map(({ title, found }) => ({ title, why: found.why }));
}
