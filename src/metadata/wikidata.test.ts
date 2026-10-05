/**
 * The keyless movie fallback: what Kinema makes of Wikidata's answers.
 *
 * The HTTP plugin is replaced with canned MediaWiki replies, chosen by the
 * request's `action`, so these check the mapping and the manners without a
 * network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requests: Array<{ url: URL; headers: Record<string, string> | undefined }> = [];
let replies: Array<(url: URL) => unknown> = [];

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async (raw: string, init?: { headers?: Record<string, string> }) => {
    const url = new URL(raw);
    requests.push({ url, headers: init?.headers });
    const reply = replies.shift();
    const body = (reply ? reply(url) : {}) as { http?: { status: number; retryAfter?: string } };
    // `{ http: … }` stands for an answer that is only a status, as a 503 is.
    const status = body.http?.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: { get: (name: string) => (name === 'retry-after' ? (body.http?.retryAfter ?? null) : null) },
      json: async () => body,
    };
  }),
}));

const { wikidataSearch, wikidataGetMovie, tidyGenre } = await import('./wikidata');
const { describeError } = await import('../ui/errors');
const { providerForKind } = await import('./match');

const item = (value: unknown) => ({
  mainsnak: { snaktype: 'value', datavalue: { value } },
  rank: 'normal',
});
const date = (time: string) => item({ time });

const FILM = {
  id: 'Q1',
  labels: { en: { value: 'A Silent Film' } },
  descriptions: { en: { value: '1922 film' } },
  sitelinks: { enwiki: { title: 'A Silent Film' }, dewiki: { title: 'Ein Film' } },
  claims: {
    // A festival premiere in 1921, the general release in 1922: the earlier
    // one is the year a filename carries.
    P577: [date('+1922-03-15T00:00:00Z'), date('+1921-12-01T00:00:00Z')],
    P2047: [item({ amount: '+94', unit: 'http://www.wikidata.org/entity/Q7727' })],
    P136: [item({ id: 'Q10' }), item({ id: 'Q11' })],
    P161: [item({ id: 'Q20' }), item({ id: 'Q21' })],
    P345: [item('tt0000001')],
    P4947: [item('653')],
  },
};

const NAMES = {
  entities: {
    Q10: { id: 'Q10', labels: { en: { value: 'horror film' } } },
    Q11: { id: 'Q11', labels: { en: { value: 'silent film' } } },
    Q20: { id: 'Q20', labels: { en: { value: 'First Actor' } } },
    Q21: { id: 'Q21', labels: { en: { value: 'Second Actor' } } },
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  replies = [];
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe('Wikidata as the movie fallback', () => {
  it('is what movies use with no key at all, while TV keeps TVmaze', () => {
    const none = { tmdb: null, tmdbSource: null, omdb: null };
    expect(providerForKind(false, none)).toBe('wikidata');
    expect(providerForKind(true, none)).toBe('tvmaze');
    expect(providerForKind(false, { ...none, omdb: 'k' })).toBe('omdb');
  });

  it('searches films only, and reads year and fame from the items', async () => {
    replies = [
      () => ({ query: { search: [{ title: 'Q1' }, { title: 'Q404' }] } }),
      () => ({ entities: { Q1: FILM, Q404: { id: 'Q404', missing: '' } } }),
    ];
    const candidates = await settle(wikidataSearch('A Silent Film'));

    expect(requests[0].url.searchParams.get('srsearch')).toMatch(
      /^A Silent Film haswbstatement:P31=Q11424\|/
    );
    expect(candidates).toEqual([
      {
        providerId: 'Q1',
        title: 'A Silent Film',
        year: 1921,
        popularity: 2,
        posterUrl: null,
        overview: '1922 film',
      },
    ]);
  });

  it('keeps the TMDB id, so the film can move to TMDB when a key works', async () => {
    replies = [
      () => ({ entities: { Q1: FILM } }),
      () => NAMES,
      () => ({ query: { pages: [{ extract: 'A Silent Film is a 1922 horror film.' }] } }),
    ];
    const film = await settle(wikidataGetMovie('Q1'));

    expect(film).toMatchObject({
      provider: 'wikidata',
      provider_id: 'Q1',
      tmdb_id: '653',
      imdb_id: 'tt0000001',
      year: 1921,
      runtime_mins: 94,
      genres: JSON.stringify(['Horror', 'Silent']),
      overview: 'A Silent Film is a 1922 horror film.',
      poster_url: null,
      trailer_key: null,
    });
    expect(film.cast.map((c) => c.name)).toEqual(['First Actor', 'Second Actor']);
    expect(requests[2].url.hostname).toBe('en.wikipedia.org');
  });

  it('falls back to the one-line description without a Wikipedia article', async () => {
    const noArticle = { ...FILM, sitelinks: {} };
    replies = [() => ({ entities: { Q1: noArticle } }), () => NAMES];
    const film = await settle(wikidataGetMovie('Q1'));
    expect(film.overview).toBe('1922 film');
    expect(requests).toHaveLength(2);
  });

  it('says who it is, and waits when Wikimedia says its servers are busy', async () => {
    replies = [
      () => ({ error: { code: 'maxlag', info: 'Waiting for a database server' } }),
      () => ({ query: { search: [] } }),
    ];
    const candidates = await settle(wikidataSearch('Anything'));

    expect(candidates).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[0].headers?.['Api-User-Agent']).toMatch(/^Kinema /);
    expect(requests[0].url.searchParams.get('maxlag')).toBe('5');
  });

  it('waits as long as a busy server asks, then carries on', async () => {
    replies = [() => ({ http: { status: 503, retryAfter: '12' } }), () => ({ query: { search: [] } })];
    const search = wikidataSearch('Anything');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(requests).toHaveLength(1);
    expect(await settle(search)).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('still busy after a few tries, says so in words rather than in Wikimedia’s', async () => {
    const lagged = () => ({
      error: { code: 'maxlag', info: 'Waiting for wdqs1014: 6.6 seconds lagged.' },
    });
    replies = Array.from({ length: 5 }, () => lagged);
    const search = wikidataSearch('Anything').catch((e: unknown) => e);
    const error = await settle(search);

    expect(requests).toHaveLength(5);
    expect(describeError(error)).toBe(
      'Wikipedia is busy right now. Kinema tries again on the next scan, or try again in a minute.'
    );
  });
});

describe('tidyGenre', () => {
  it('turns a class of film into a genre name', () => {
    expect(tidyGenre('science fiction film')).toBe('Science fiction');
    expect(tidyGenre('drama')).toBe('Drama');
    expect(tidyGenre('film')).toBeNull();
  });
});
