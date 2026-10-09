/**
 * Wikidata — movies, keyless. The fallback when there is no TMDB key to use.
 *
 * A released Kinema carries a TMDB key of its own (builtinKey.ts), so this is
 * for the two cases where it cannot: TMDB has refused that key, or Kinema was
 * built from source without one. Movies are still identified — title, year,
 * running time, genres, cast, and the opening of the film's Wikipedia article
 * as its description — but without posters or backdrops: Wikipedia's film
 * posters are used there under fair use, which does not carry over to an app.
 *
 * Wikidata's own data is CC0. The descriptions are Wikipedia text, CC BY-SA
 * 4.0, and are credited where they are shown and in Settings.
 *
 * Both are MediaWiki's action API, which has been stable for well over a
 * decade — this adds nothing that needs looking after. Wikimedia asks API
 * clients to say who they are (`Api-User-Agent`, the header a web client may
 * set), to send requests one at a time, and to back off when their servers
 * answer "too many" (HTTP 429 or 503). All three are done here.
 *
 * `maxlag` is not sent. Wikimedia asks it of bots that *edit*, so they pause
 * while the database copies catch up; Kinema only reads. Wikidata also counts
 * the lag of its separate query service in it, which Kinema never uses — and
 * that lag sat above the threshold for long stretches, so every read was
 * answered "busy" while the same read without the flag was answered at once
 * (checked 2026-10-09: 7.65 s lagged, three refusals, three answers).
 */
import type { Candidate } from './score';
import { CAST_LIMIT, fetchPolitely, makeQueue, type TitleMetadata } from './providers';

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';

const HEADERS = { 'Api-User-Agent': 'Kinema (https://github.com/basswaves/kinema)' };

/** One at a time, as Wikimedia asks, with a short breath between. */
const wikidataQueued = makeQueue(100);

/**
 * "Busy, try later": an HTTP 429 or 503. Waited out as Wikimedia asks — the
 * `Retry-After` it sends, at least five seconds — a few times. Still busy
 * after that, the error says so in a form errors.ts puts into words, never
 * the service's own wording. A file left unmatched is tried again by the
 * next scan, never guessed at.
 */
const BUSY_WAIT_MS = 5000;
const BUSY_WAIT_MAX_MS = 30000;
const BUSY_RETRIES = 4;
/** The start of the error for "still busy", matched in errors.ts. */
const WIKIMEDIA_BUSY = 'Wikimedia is busy';

/**
 * What counts as a film. Wikidata types a film by what it is an instance of
 * (P31), and "film" alone misses animated, documentary, television and short
 * films, which are classes of their own.
 */
const FILM_CLASSES = [
  'Q11424', // film
  'Q24869', // feature film
  'Q202866', // animated film
  'Q93204', // documentary film
  'Q506240', // television film
  'Q24862', // short film
];

/** Wikidata's unit items for a running time. */
const MINUTE = 'http://www.wikidata.org/entity/Q7727';
const HOUR = 'http://www.wikidata.org/entity/Q25235';

interface Snak {
  snaktype?: string;
  datavalue?: { value?: unknown };
}

interface Statement {
  mainsnak?: Snak;
  rank?: 'preferred' | 'normal' | 'deprecated';
}

export interface Entity {
  id: string;
  missing?: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, Statement[]>;
  sitelinks?: Record<string, { title: string }>;
}

async function get<T>(base: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams({ format: 'json', ...params });
  const url = `${base}?${query.toString()}`;
  for (let attempt = 0; ; attempt++) {
    const answer = await wikidataQueued(async () => {
      const response = await fetchPolitely(url, 'Wikidata', HEADERS);
      const header = Number(response.headers.get('retry-after'));
      const after = Number.isFinite(header) && header > 0 ? header * 1000 : 0;
      if (response.status === 429 || response.status === 503) {
        return { busy: `HTTP ${response.status}`, after };
      }
      if (!response.ok) throw new Error(`Wikidata ${params.action} failed: HTTP ${response.status}`);
      const body = (await response.json()) as T & { error?: { code?: string; info?: string } };
      return { body };
    });
    if (answer.busy !== undefined) {
      if (attempt >= BUSY_RETRIES) {
        throw new Error(`${WIKIMEDIA_BUSY}: Wikidata ${params.action}: ${answer.busy}`);
      }
      const wait = Math.min(Math.max(answer.after, BUSY_WAIT_MS), BUSY_WAIT_MAX_MS);
      console.warn(`Wikidata: busy (${answer.busy}), trying again in ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const { body } = answer;
    if (body.error) throw new Error(`Wikidata ${params.action}: ${body.error.info ?? body.error.code}`);
    return body;
  }
}

async function getEntities(ids: string[], props: string): Promise<Record<string, Entity>> {
  if (ids.length === 0) return {};
  const data = await get<{ entities?: Record<string, Entity> }>(WIKIDATA_API, {
    action: 'wbgetentities',
    ids: ids.join('|'),
    props,
    languages: 'en',
    languagefallback: '1',
  });
  return data.entities ?? {};
}

/** A statement's values, deprecated ones left out. */
function values(entity: Entity, property: string): unknown[] {
  return (entity.claims?.[property] ?? [])
    .filter((s) => s.rank !== 'deprecated' && s.mainsnak?.snaktype !== 'novalue')
    .map((s) => s.mainsnak?.datavalue?.value)
    .filter((v) => v !== undefined && v !== null);
}

function firstString(entity: Entity, property: string): string | null {
  const value = values(entity, property).find((v): v is string => typeof v === 'string');
  return value?.trim() || null;
}

function itemIds(entity: Entity, property: string): string[] {
  return values(entity, property)
    .map((v) => (v as { id?: string }).id)
    .filter((id): id is string => typeof id === 'string');
}

function label(entity: Entity): string {
  return entity.labels?.en?.value ?? entity.id;
}

/**
 * The year it first came out. A film often has several publication dates —
 * a festival premiere, then each country's release — and the earliest is the
 * one a filename's year means.
 */
export function releaseYear(entity: Entity): number | null {
  const years = values(entity, 'P577')
    .map((v) => /^[+-]?(\d{4})/.exec((v as { time?: string }).time ?? '')?.[1])
    .filter((y): y is string => Boolean(y))
    .map(Number);
  return years.length ? Math.min(...years) : null;
}

function runtimeMinutes(entity: Entity): number | null {
  for (const v of values(entity, 'P2047')) {
    const { amount, unit } = v as { amount?: string; unit?: string };
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (unit === MINUTE) return Math.round(n);
    if (unit === HOUR) return Math.round(n * 60);
  }
  return null;
}

/** "science fiction film" → "Science fiction": a genre, not a class of item. */
export function tidyGenre(name: string): string | null {
  const bare = name.replace(/\s+film$/i, '').trim();
  if (!bare || /^film$/i.test(bare)) return null;
  return bare[0].toUpperCase() + bare.slice(1);
}

/** Films whose name matches, best known first by how many Wikipedias have them. */
export async function wikidataSearch(title: string): Promise<Candidate[]> {
  const filter = FILM_CLASSES.map((q) => `P31=${q}`).join('|');
  const found = await get<{ query?: { search?: Array<{ title: string }> } }>(WIKIDATA_API, {
    action: 'query',
    list: 'search',
    srsearch: `${title} haswbstatement:${filter}`,
    srnamespace: '0',
    srlimit: '8',
  });
  const ids = (found.query?.search ?? []).map((r) => r.title).filter((id) => /^Q\d+$/.test(id));
  const entities = await getEntities(ids, 'labels|descriptions|claims|sitelinks');

  return ids
    .map((id) => entities[id])
    .filter((e): e is Entity => Boolean(e) && e.missing === undefined)
    .map((e) => ({
      providerId: e.id,
      title: label(e),
      year: releaseYear(e),
      // How many language editions of Wikipedia cover it: the nearest thing
      // Wikidata has to TMDB's popularity, and used the same way — only to
      // break a tie between films of the same name.
      popularity: Object.keys(e.sitelinks ?? {}).length,
      posterUrl: null,
      overview: e.descriptions?.en?.value ?? null,
    }));
}

/** The opening of an English Wikipedia article, as plain text. */
async function wikipediaIntro(article: string): Promise<string | null> {
  const data = await get<{ query?: { pages?: Array<{ extract?: string }> } }>(WIKIPEDIA_API, {
    action: 'query',
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    exsentences: '5',
    redirects: '1',
    titles: article,
    formatversion: '2',
  });
  return data.query?.pages?.[0]?.extract?.trim() || null;
}

/** Everything Kinema stores about a film, from its Wikidata item. */
export async function wikidataGetMovie(id: string): Promise<TitleMetadata> {
  const entity = (await getEntities([id], 'labels|descriptions|claims|sitelinks'))[id];
  if (!entity || entity.missing !== undefined) throw new Error(`Wikidata has no item ${id}`);

  const genreIds = itemIds(entity, 'P136').slice(0, 6);
  const castIds = itemIds(entity, 'P161').slice(0, CAST_LIMIT);
  const named = await getEntities([...new Set([...genreIds, ...castIds])], 'labels');
  const nameOf = (qid: string) => named[qid]?.labels?.en?.value ?? null;

  const genres = [
    ...new Set(genreIds.map(nameOf).map((n) => (n ? tidyGenre(n) : null))),
  ].filter((g): g is string => Boolean(g));

  const article = entity.sitelinks?.enwiki?.title;
  // A description is worth having even if Wikipedia does not answer.
  const intro = article ? await wikipediaIntro(article).catch(() => null) : null;

  return {
    kind: 'movie',
    provider: 'wikidata',
    provider_id: entity.id,
    imdb_id: firstString(entity, 'P345'),
    tmdb_id: firstString(entity, 'P4947'),
    title: label(entity),
    year: releaseYear(entity),
    overview: intro ?? entity.descriptions?.en?.value ?? null,
    genres: genres.length ? JSON.stringify(genres) : null,
    runtime_mins: runtimeMinutes(entity),
    rating: null,
    poster_url: null,
    backdrop_url: null,
    logo_url: null,
    // Wikidata's "YouTube video ID" is as often the whole film as a trailer,
    // and "Trailer" must not start a two-hour upload.
    trailer_key: null,
    trailer_site: null,
    cast: castIds
      .map(nameOf)
      .filter((name): name is string => Boolean(name))
      .map((name) => ({ name, character: null, profile_url: null })),
  };
}

/** The Wikidata item for a film TMDB knows by `tmdbId`, for an NFO's id. */
export async function wikidataFindByTmdb(tmdbId: string): Promise<string | null> {
  return findByStatement('P4947', tmdbId);
}

/** The Wikidata item for a film IMDb knows by `imdbId`, for an NFO's id. */
export async function wikidataFindByImdb(imdbId: string): Promise<string | null> {
  return findByStatement('P345', imdbId);
}

async function findByStatement(property: string, value: string): Promise<string | null> {
  if (!/^[\w-]+$/.test(value)) return null;
  const found = await get<{ query?: { search?: Array<{ title: string }> } }>(WIKIDATA_API, {
    action: 'query',
    list: 'search',
    srsearch: `haswbstatement:${property}=${value}`,
    srnamespace: '0',
    srlimit: '2',
  });
  const hits = found.query?.search ?? [];
  // Two items claiming the same id is Wikidata disagreeing with itself; that
  // is a question for a person, not a match.
  return hits.length === 1 ? hits[0].title : null;
}
