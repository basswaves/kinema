/**
 * Actor pages (people.rs): a person from the library's cast, and their
 * details and credits from TMDB — asked for once when their page opens,
 * kept a month, never fetched ahead for everyone (DECISIONS: no bulk
 * prefetch). Without a working key or a connection the page still shows what
 * the stored cast knows.
 */
import { invoke } from '@tauri-apps/api/core';
import { loadProviderKeys } from '../metadata/match';
import { tmdbGetPerson } from '../metadata/providers';

export interface Person {
  person_id: string;
  name: string;
  biography: string | null;
  profile_url: string | null;
  profile_path: string | null;
  imdb_id: string | null;
  /** TMDB was asked this month (people.rs); otherwise the page asks. */
  fresh: boolean;
  /** Library titles with this person, newest first. */
  title_ids: number[];
}

export interface PersonInput {
  person_id: string;
  name: string;
  biography: string | null;
  profile_url: string | null;
  imdb_id: string | null;
  /** `movie:603`, `tv:1399`. */
  credits: string[];
}

export const getPerson = (personId: string) => invoke<Person | null>('get_person', { personId });
export const savePerson = (person: PersonInput) => invoke<void>('save_person', { person });

/**
 * What is stored at once, then — if TMDB was not asked this month — TMDB's
 * answer once it is in. `show` is called once or twice.
 */
export async function loadPerson(personId: string, show: (person: Person) => void): Promise<void> {
  const stored = await getPerson(personId).catch(() => null);
  if (stored) show(stored);
  if (stored?.fresh) return;
  try {
    const keys = await loadProviderKeys();
    if (!keys.tmdb) return;
    await savePerson(await tmdbGetPerson(keys.tmdb, personId));
    const fresh = await getPerson(personId);
    if (fresh) show(fresh);
  } catch (e) {
    console.warn('person: TMDB not asked', e instanceof Error ? e.message : String(e));
  }
}
