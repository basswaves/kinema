/**
 * An actor's page (library/person.ts): their picture and name, a short
 * biography from TMDB, and every title of the library they are in — by
 * TMDB's person id, never by name. On a desktop, a link to their IMDb page;
 * a TV with no window has no browser to open it in.
 */
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, useMemo, useState } from 'react';
import Art from './Art';
import CardGrid from './CardGrid';
import FocusButton from './FocusButton';
import { useClaimFocus } from './focus';
import { openLink } from './links';
import { alwaysTv } from './tv';
import type { Title } from './api';
import { loadPerson, type Person } from '../library/person';

const PERSON_FOCUS_KEY = 'person-page';
const PERSON_BACK_KEY = 'person-back';

interface Props {
  personId: string;
  /** The name as the cast row had it, shown until the person is read. */
  name: string;
  titles: Title[];
  onSelect: (title: Title) => void;
  onBack: () => void;
}

export default function PersonPage({ personId, name, titles, onSelect, onBack }: Props) {
  const { ref, focusKey } = useFocusable({
    focusKey: PERSON_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
  });
  const [person, setPerson] = useState<Person | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadPerson(personId, (p) => !cancelled && setPerson(p)).finally(
      () => !cancelled && setAsked(true)
    );
    return () => {
      cancelled = true;
    };
  }, [personId]);

  const entries = useMemo(() => {
    const byId = new Map(titles.map((t) => [t.id, t]));
    return (person?.title_ids ?? []).flatMap((id) => {
      const title = byId.get(id);
      return title ? [{ title }] : [];
    });
  }, [person, titles]);

  // Lands on the first title once they are known, else on Back.
  const first = entries[0] ? `grid:${entries[0].title.id}` : PERSON_BACK_KEY;
  useClaimFocus(first, person !== null || asked, true);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="search person-page" ref={ref}>
        <div className="grid-head">
          <FocusButton
            focusKey={PERSON_BACK_KEY}
            className="back-button"
            keepInView="page-top"
            onSelect={onBack}
          >
            ← Back
          </FocusButton>
        </div>
        <div className="person-head">
          <div className="person-photo">
            <Art
              local={person?.profile_path ?? null}
              remote={person?.profile_url ?? null}
              fallback={<div className="cast-photo-empty">{name.slice(0, 1).toUpperCase()}</div>}
            />
          </div>
          <div className="person-info">
            <h1>{person?.name ?? name}</h1>
            {person?.biography && <p className="person-bio">{person.biography}</p>}
            {person?.imdb_id && !alwaysTv() && (
              <FocusButton
                className="btn-secondary"
                keepInView="page-top"
                onSelect={() => void openLink(`https://www.imdb.com/name/${person.imdb_id as string}/`)}
              >
                IMDb · opens in your browser ↗
              </FocusButton>
            )}
          </div>
        </div>
        <h2 className="grid-heading">
          In your library <span className="muted">{entries.length}</span>
        </h2>
        {asked && entries.length === 0 && (
          <p className="muted">Nothing in the library is known to have them in it.</p>
        )}
        <CardGrid name="grid" entries={entries} onSelect={onSelect} fromAboveFirst />
      </div>
    </FocusContext.Provider>
  );
}
