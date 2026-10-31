/**
 * A smart collection (library/collections.ts): its choices on top, the titles
 * that fit underneath, live. A new one is kept with Save; a kept one keeps
 * every change as it is made, and can be deleted.
 *
 * Only choices the library has are offered — no Dolby Vision button in a
 * library without it, no 1950s without a film from then — so every press
 * shows something, and nothing here can promise what no file holds.
 */
import { useMemo, useState } from 'react';
import CardGrid from './CardGrid';
import ConfirmButton from './ConfirmButton';
import FocusButton from './FocusButton';
import FocusGroup, { FocusProvider } from './FocusGroup';
import { useNavGroup } from './focusGroups';
import { useLanding } from './focusStore';
import { parseGenres, type Title } from './api';
import {
  deleteCollection,
  fits,
  ruleIsEmpty,
  ruleName,
  saveCollection,
  traitLabel,
  updateCollection,
  useSavedCollections,
  useTitleTraits,
  type CollectionRule,
} from '../library/collections';

const COLLECTION_FOCUS_KEY = 'collection-page';
/** Picture first, then sound: the order of the badges on a title's page. */
const TRAIT_ORDER = ['4k', 'hdr', 'dv', 'hdr10plus', 'atmos', 'dtsx'];
const RATINGS = [6, 7, 8];

interface Props {
  titles: Title[];
  /** A kept collection, or `null` for a new one. */
  id: string | null;
  /** A new one's starting choice: the shelf it was made from. */
  kind?: 'movie' | 'series';
  onSelect: (title: Title) => void;
  onBack: () => void;
  /** A new one was kept: the page becomes that collection's. */
  onSaved: (id: string) => void;
}

export default function CollectionPage({ titles, id, kind, onSelect, onBack, onSaved }: Props) {
  // A column on Kinema's own engine (round 7): the heading row, the rows
  // of choices, then the titles.
  const { ref, focusKey } = useNavGroup({ kind: 'column' }, { focusKey: COLLECTION_FOCUS_KEY });
  const traits = useTitleTraits(titles);
  const saved = useSavedCollections();
  const kept = id ? saved.find((c) => c.id === id) : undefined;
  const [draft, setDraft] = useState<CollectionRule>({ traits: [], kind });
  const rule = kept?.rule ?? draft;
  const change = (next: CollectionRule) => (id ? updateCollection(id, next) : setDraft(next));

  const shown = useMemo(() => titles.filter((t) => fits(t, traits, rule)), [titles, traits, rule]);
  const entries = useMemo(() => shown.map((title) => ({ title })), [shown]);

  // What the library has to choose from.
  const present = useMemo(() => {
    const has = new Set<string>();
    for (const set of traits.values()) for (const t of set) has.add(t);
    const profiles = [...has].filter((t) => t.startsWith('dv:')).sort();
    const order = TRAIT_ORDER.flatMap((t) => (t === 'dv' ? ['dv', ...profiles] : [t]));
    const genres = new Set<string>();
    const decades = new Set<number>();
    for (const t of titles) {
      for (const g of parseGenres(t.genres)) genres.add(g);
      if (t.year) decades.add(Math.floor(t.year / 10) * 10);
    }
    return {
      traits: order.filter((t) => has.has(t)),
      genres: [...genres].sort(),
      decades: [...decades].sort((a, b) => a - b),
      kinds: new Set(titles.map((t) => t.kind)).size > 1,
    };
  }, [traits, titles]);

  const toggleTrait = (t: string) =>
    change({
      ...rule,
      traits: rule.traits.includes(t) ? rule.traits.filter((x) => x !== t) : [...rule.traits, t],
    });

  // Land on the first choice: a page opened to be chosen in.
  const first = present.traits[0] ? `collection-trait:${present.traits[0]}` : 'collection-unwatched';
  useLanding(first);

  // A kept collection deleted from another place, or not read yet.
  if (id && !kept) {
    return (
      <div className="search collection-page" ref={ref}>
        <p className="muted">This collection is not here any more.</p>
      </div>
    );
  }

  const chip = (key: string, label: string, chosen: boolean, onSelect: () => void) => (
    <FocusButton
      key={key}
      focusKey={key}
      className={`choice ${chosen ? 'chosen' : ''}`}
      onSelect={onSelect}
    >
      {chosen ? '✓ ' : ''}
      {label}
    </FocusButton>
  );

  return (
    <FocusProvider value={focusKey}>
      <div className="search collection-page" ref={ref}>
        <FocusGroup kind="row" className="grid-head">
          <FocusButton className="back-button" onSelect={onBack}>
            ← Back
          </FocusButton>
          <h2 className="grid-heading">
            {id ? ruleName(rule) : 'New collection'} <span className="muted">{shown.length}</span>
          </h2>
          {!id && (
            <FocusButton
              focusKey="collection-save"
              className="btn-primary"
              disabled={ruleIsEmpty(rule)}
              onSelect={() => onSaved(saveCollection(rule))}
            >
              Save collection
            </FocusButton>
          )}
          {id && (
            <ConfirmButton
              focusKey="collection-delete"
              className="btn-secondary"
              confirmLabel="Delete this collection"
              onConfirm={() => {
                deleteCollection(id);
                onBack();
              }}
            >
              Delete
            </ConfirmButton>
          )}
        </FocusGroup>
        {!id && (
          <p className="muted collection-hint">
            {ruleIsEmpty(rule) ? 'Choose what the titles have in common.' : ruleName(rule)}
            {' — picture and sound as Kinema read them from the files.'}
          </p>
        )}
        {present.traits.length > 0 && (
          <FocusGroup kind="row" className="choice-options collection-row" aria-label="Picture and sound">
            {present.traits.map((t) =>
              chip(`collection-trait:${t}`, traitLabel(t), rule.traits.includes(t), () => toggleTrait(t))
            )}
          </FocusGroup>
        )}
        <FocusGroup kind="row" className="choice-options collection-row" aria-label="Kind and watched">
          {present.kinds &&
            (['movie', 'series'] as const).map((k) =>
              chip(`collection-kind:${k}`, k === 'movie' ? 'Films' : 'TV shows', rule.kind === k, () =>
                change({ ...rule, kind: rule.kind === k ? undefined : k })
              )
            )}
          {chip('collection-unwatched', 'Unwatched', Boolean(rule.unwatched), () =>
            change({ ...rule, unwatched: !rule.unwatched })
          )}
          {RATINGS.map((r) =>
            chip(`collection-rating:${r}`, `★ ${r}+`, rule.minRating === r, () =>
              change({ ...rule, minRating: rule.minRating === r ? undefined : r })
            )
          )}
        </FocusGroup>
        {present.decades.length > 1 && (
          <FocusGroup kind="row" className="choice-options collection-row" aria-label="Decade">
            {present.decades.map((d) =>
              chip(`collection-decade:${d}`, `${d}s`, rule.decade === d, () =>
                change({ ...rule, decade: rule.decade === d ? undefined : d })
              )
            )}
          </FocusGroup>
        )}
        {present.genres.length > 0 && (
          <FocusGroup kind="row" className="choice-options collection-row" aria-label="Genre">
            {present.genres.map((g) =>
              chip(`collection-genre:${g}`, g, rule.genre === g, () =>
                change({ ...rule, genre: rule.genre === g ? undefined : g })
              )
            )}
          </FocusGroup>
        )}
        {shown.length === 0 && <p className="muted">Nothing in the library fits all of these.</p>}
        <CardGrid name="grid" entries={entries} onSelect={onSelect} fromAboveFirst />
      </div>
    </FocusProvider>
  );
}
