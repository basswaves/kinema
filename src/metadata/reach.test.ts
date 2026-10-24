/**
 * What is said when a service gives no answer: never "the internet" unless the
 * comparison host failed too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const answers = new Map<string, { reached: boolean; status: number | null; cause: string }>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: { host: string }) => {
    if (command !== 'check_reach') return null;
    return answers.get(args.host) ?? { reached: false, status: null, cause: 'other' };
  }),
}));

const { explainUnreachable } = await import('./reach');
const { Unreachable, TMDB_HOSTS } = await import('./providers');

const tmdb = () => new Unreachable('TMDB', TMDB_HOSTS);

beforeEach(() => answers.clear());

describe('explainUnreachable', () => {
  it('says the internet works when Wikidata answers and TMDB does not', async () => {
    answers.set('api.themoviedb.org', { reached: false, status: null, cause: 'dns' });
    answers.set('www.wikidata.org', { reached: true, status: 200, cause: '' });
    const said = await explainUnreachable(tmdb());
    expect(said).toMatch(/^The internet works, but TMDB \(api\.themoviedb\.org or api\.tmdb\.org\)/);
    expect(said).toMatch(/its name could not be looked up/);
  });

  it('only suggests the connection when nothing answers', async () => {
    answers.set('api.themoviedb.org', { reached: false, status: null, cause: 'timeout' });
    const said = await explainUnreachable(tmdb());
    expect(said).toMatch(/did not answer in time, and neither could Wikidata/);
    expect(said).toMatch(/Check the internet connection/);
  });

  it('says so when TMDB answers on the second look', async () => {
    answers.set('api.tmdb.org', { reached: true, status: 404, cause: '' });
    expect(await explainUnreachable(tmdb())).toMatch(/answers now/);
  });
});
