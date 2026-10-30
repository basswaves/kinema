/**
 * Smart collections (PLAN phase 2): saved filters over the library, built
 * only from what Kinema knows about each title — what its files were measured
 * to hold (collections.rs: 4K, HDR, Dolby Vision and its profile, HDR10+,
 * Atmos, DTS:X), its genre, decade and rating, and whether it was watched.
 *
 * The badges rule (DECISIONS.md) holds here too: a trait comes from the file
 * itself, never its name, so a collection never says a film has something
 * its file does not. 3D and IMAX are not offered — nothing measures them.
 *
 * A collection is its rule, not a list of titles: a film added tomorrow that
 * fits is in it. The ready-made ones show on Home only when the library has
 * titles for them; the user's own are kept in the settings table as JSON.
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getSetting, setSetting } from '../metadata/api';
import { parseGenres, type Title } from '../ui/api';

/** What collections.rs measures; `dv:<profile>` too. */
export type Trait = string;

export const TRAIT_LABELS: Record<string, string> = {
  '4k': '4K',
  hdr: 'HDR',
  dv: 'Dolby Vision',
  hdr10plus: 'HDR10+',
  atmos: 'Dolby Atmos',
  dtsx: 'DTS:X',
};

export function traitLabel(trait: Trait): string {
  if (trait.startsWith('dv:')) return `Dolby Vision profile ${trait.slice(3)}`;
  return TRAIT_LABELS[trait] ?? trait;
}

export interface CollectionRule {
  /** Every one of these, as measured. */
  traits: Trait[];
  kind?: 'movie' | 'series';
  genre?: string;
  /** The decade's first year: 1990 for the 1990s. */
  decade?: number;
  /** TMDB's rating, this or more. */
  minRating?: number;
  unwatched?: boolean;
}

export interface SavedCollection {
  id: string;
  rule: CollectionRule;
}

export type TraitMap = Map<number, Set<Trait>>;

export function fits(title: Title, traits: TraitMap, rule: CollectionRule): boolean {
  if (rule.kind && title.kind !== rule.kind) return false;
  if (rule.unwatched && title.watched) return false;
  if (rule.genre && !parseGenres(title.genres).includes(rule.genre)) return false;
  if (rule.decade !== undefined) {
    if (title.year === null || title.year < rule.decade || title.year >= rule.decade + 10) return false;
  }
  if (rule.minRating !== undefined && (title.rating ?? 0) < rule.minRating) return false;
  const has = traits.get(title.id);
  return rule.traits.every((t) => has?.has(t) ?? false);
}

/** Whether a rule chooses anything at all; an empty one is the whole library. */
export const ruleIsEmpty = (rule: CollectionRule) =>
  rule.traits.length === 0 &&
  !rule.kind &&
  !rule.genre &&
  rule.decade === undefined &&
  rule.minRating === undefined &&
  !rule.unwatched;

/** A collection's name, from its rule: "4K · Dolby Atmos · Films · 1990s". */
export function ruleName(rule: CollectionRule): string {
  const parts = rule.traits.map(traitLabel);
  if (rule.kind) parts.push(rule.kind === 'movie' ? 'Films' : 'TV shows');
  if (rule.genre) parts.push(rule.genre);
  if (rule.decade !== undefined) parts.push(`${rule.decade}s`);
  if (rule.minRating !== undefined) parts.push(`★ ${rule.minRating}+`);
  if (rule.unwatched) parts.push('Unwatched');
  return parts.length > 0 ? parts.join(' · ') : 'Everything';
}

/** Home's own, each shown only when the library has titles for it. */
export const READY_MADE: { name: string; rule: CollectionRule }[] = [
  { name: 'Dolby Vision', rule: { traits: ['dv'] } },
  { name: 'Dolby Atmos', rule: { traits: ['atmos'] } },
  { name: 'DTS:X', rule: { traits: ['dtsx'] } },
  { name: 'HDR10+', rule: { traits: ['hdr10plus'] } },
  { name: '4K', rule: { traits: ['4k'] } },
];

/**
 * A ready-made rail needs two titles: one is a card, not a shelf. One that is
 * the whole library is Recently added again, as with the genre rails.
 */
export function readyMadeRails(titles: Title[], traits: TraitMap) {
  return READY_MADE.map(({ name, rule }) => ({
    name,
    titles: titles.filter((t) => fits(t, traits, rule)),
  })).filter((c) => c.titles.length >= 2 && c.titles.length < titles.length);
}

// ---- measured traits -------------------------------------------------------

/**
 * Every title's measured traits, read again whenever the titles are (a scan
 * that read new files brings new titles rows with it).
 */
export function useTitleTraits(titles: Title[]): TraitMap {
  const [map, setMap] = useState<TraitMap>(() => new Map());
  useEffect(() => {
    let live = true;
    void invoke<{ title_id: number; traits: Trait[] }[]>('title_traits')
      .then((rows) => {
        if (live) setMap(new Map(rows.map((r) => [r.title_id, new Set(r.traits)])));
      })
      .catch((e: unknown) => console.warn('collections: traits unavailable', e));
    return () => {
      live = false;
    };
  }, [titles]);
  return map;
}

// ---- the user's own --------------------------------------------------------

const SETTING = 'collections';

let saved: SavedCollection[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: SavedCollection[]) {
  saved = next;
  for (const listener of listeners) listener();
}

function parseSaved(raw: string | null): SavedCollection[] {
  try {
    const list: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(list)
      ? list.filter(
          (c): c is SavedCollection =>
            typeof c?.id === 'string' && Array.isArray(c?.rule?.traits)
        )
      : [];
  } catch {
    return [];
  }
}

function reloadSaved(): Promise<void> {
  return getSetting(SETTING)
    .then((raw) => {
      loaded = true;
      publish(parseSaved(raw));
    })
    .catch((e: unknown) => console.warn('collections: could not be read', e));
}

function write(next: SavedCollection[]) {
  publish(next);
  void setSetting(SETTING, JSON.stringify(next)).catch((e: unknown) => {
    console.warn('collections: could not be kept', e);
    void reloadSaved();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The user's collections, in the order they were made. */
export function useSavedCollections(): SavedCollection[] {
  useEffect(() => {
    if (!loaded) void reloadSaved();
  }, []);
  return useSyncExternalStore(subscribe, () => saved);
}

/** Keep a new collection; returns its id. */
export function saveCollection(rule: CollectionRule): string {
  // The same choices twice would be two rails of one name: the first is kept.
  const same = saved.find((c) => ruleName(c.rule) === ruleName(rule));
  if (same) return same.id;
  const id = `c${Date.now().toString(36)}`;
  write([...saved, { id, rule }]);
  return id;
}

export function updateCollection(id: string, rule: CollectionRule) {
  write(saved.map((c) => (c.id === id ? { id, rule } : c)));
}

export function deleteCollection(id: string) {
  write(saved.filter((c) => c.id !== id));
}
