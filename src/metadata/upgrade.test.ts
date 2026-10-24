/**
 * Titles matched through a fallback (Wikidata, OMDb, TVmaze) moving to TMDB.
 *
 * The Rust commands and the providers are stand-ins: what is checked is which
 * way each title is looked up, that only a confident answer re-keys it, and
 * that everything else stays matched as it was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FallbackTitle } from './api';
import type { Candidate } from './score';

vi.stubEnv('VITE_TMDB_API_KEY', 'builtin-test-key');

const titles: FallbackTitle[] = [];
const adopted: Array<[number, string]> = [];
const marked: number[] = [];
const saved: string[] = [];
const episodesSaved: number[] = [];
const searched: string[] = [];
let refuse = new Set<number>();
let results: Record<string, Candidate[]> = {};

vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
  listFallbackTitles: vi.fn(async () => titles),
  markUpgradeChecked: vi.fn(async (id: number) => void marked.push(id)),
  adoptProvider: vi.fn(async (id: number, _provider: string, providerId: string) => {
    if (refuse.has(id)) return false;
    adopted.push([id, providerId]);
    return true;
  }),
  saveTitle: vi.fn(async (t: { provider_id: string }) => {
    saved.push(t.provider_id);
    return 1;
  }),
  saveEpisodes: vi.fn(async (_id: number, list: unknown[]) => void episodesSaved.push(list.length)),
}));

vi.mock('./providers', async (original) => ({
  ...(await original<typeof import('./providers')>()),
  tmdbFindByImdb: vi.fn(async (_key: string, imdb: string) => (imdb === 'tt1' ? '601' : null)),
  tmdbFindByTvdb: vi.fn(async (_key: string, tvdb: string) => (tvdb === '81189' ? '1396' : null)),
  tvmazeTvdbId: vi.fn(async (show: string) => (show === '169' ? '81189' : null)),
  tmdbSearch: vi.fn(async (_key: string, title: string) => {
    searched.push(title);
    return results[title] ?? [];
  }),
  tmdbGetTitle: vi.fn(async (_key: string, id: string, kind: string) => ({
    kind,
    provider: 'tmdb',
    provider_id: id,
    tmdb_id: id,
    title: 'x',
  })),
  tmdbGetEpisodes: vi.fn(async () => [{ season: 1, episode: 1 }, { season: 1, episode: 2 }]),
}));

vi.mock('../library/playback', () => ({ yieldToPlayback: vi.fn(async () => undefined) }));

const { upgradeFallbackTitles } = await import('./match');

function title(over: Partial<FallbackTitle> & { id: number }): FallbackTitle {
  return {
    kind: 'movie',
    provider: 'wikidata',
    provider_id: `Q${over.id}`,
    tmdb_id: null,
    imdb_id: null,
    title: `Title ${over.id}`,
    year: null,
    by_hand: false,
    ...over,
  };
}

function candidate(providerId: string, name: string, year: number | null): Candidate {
  return {
    providerId,
    title: name,
    year,
    popularity: 10,
    voteCount: 100,
    posterUrl: null,
    overview: null,
  };
}

beforeEach(() => {
  for (const list of [titles, adopted, marked, saved, episodesSaved, searched]) list.length = 0;
  refuse = new Set();
  results = {};
});

describe('upgradeFallbackTitles', () => {
  it('moves each title by the id it carries, without searching', async () => {
    titles.push(
      title({ id: 1, tmdb_id: '550' }),
      title({ id: 2, provider: 'omdb', provider_id: 'tt1', imdb_id: 'tt1' }),
      title({ id: 3, kind: 'series', provider: 'tvmaze', provider_id: '169' })
    );
    const result = await upgradeFallbackTitles();
    expect(adopted).toEqual([
      [1, '550'],
      [2, '601'],
      [3, '1396'],
    ]);
    expect(saved).toEqual(['550', '601', '1396']);
    expect(episodesSaved).toEqual([2]);
    expect(searched).toEqual([]);
    expect(result).toMatchObject({ films: 2, shows: 1, left: 0, errors: [] });
  });

  it('searches TMDB only with no id, and re-keys only on a confident match', async () => {
    titles.push(
      title({ id: 4, title: 'Clear Film', year: 1999 }),
      title({ id: 5, title: 'Twin Film', year: 2001 })
    );
    results = {
      'Clear Film': [candidate('700', 'Clear Film', 1999), candidate('701', 'Something Else', 1980)],
      // Two equal answers, equally popular: a coin-flip, refused.
      'Twin Film': [candidate('800', 'Twin Film', 2001), candidate('801', 'Twin Film', 2001)],
    };
    const result = await upgradeFallbackTitles();
    expect(adopted).toEqual([[4, '700']]);
    expect(marked).toEqual([5]);
    expect(result).toMatchObject({ films: 1, shows: 0, left: 1 });
  });

  it('never searches for a title matched by hand', async () => {
    titles.push(title({ id: 6, title: 'Clear Film', year: 1999, by_hand: true }));
    results = { 'Clear Film': [candidate('700', 'Clear Film', 1999)] };
    const result = await upgradeFallbackTitles();
    expect(searched).toEqual([]);
    expect(adopted).toEqual([]);
    expect(marked).toEqual([6]);
    expect(result.left).toBe(1);
  });

  it('leaves a title whose TMDB entry already has files of its own', async () => {
    titles.push(title({ id: 7, tmdb_id: '900' }));
    refuse = new Set([7]);
    const result = await upgradeFallbackTitles();
    expect(saved).toEqual([]);
    expect(marked).toEqual([7]);
    expect(result).toMatchObject({ films: 0, left: 1 });
  });
});
